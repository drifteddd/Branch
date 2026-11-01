use std::collections::HashMap;
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::error::{ApiResult, AppError};
use crate::github::{latest_release, normalize_version, parse_repo, repo_info, repo_key, repo_of};
use crate::models::file_url;
use crate::state::AppState;
use crate::util::Visitor;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/github/lookup", post(lookup))
        .route("/api/github/latest", post(latest))
}

#[derive(FromRow)]
struct LinkedRow {
    slug: String,
    name: String,
    summary: String,
    thumbnail_key: Option<String>,
    source_url: Option<String>,
    project_url: Option<String>,
    latest_version: Option<String>,
    hosted: bool,
}

#[derive(Serialize, Clone)]
struct BranchMod {
    slug: String,
    name: String,
    summary: String,
    thumbnail_url: Option<String>,
    latest_version: Option<String>,
    hosted: bool,
}

async fn branch_mods(state: &AppState) -> ApiResult<HashMap<String, BranchMod>> {
    let rows: Vec<LinkedRow> = sqlx::query_as(
        "select m.slug, m.name, m.summary, m.thumbnail_key, m.source_url, m.project_url, lr.version as latest_version,
                coalesce(lr.download_kind = 'hosted' and m.redistribution = 'allowed', false) as hosted
         from mods m
         left join lateral (
             select version, download_kind from releases r where r.mod_id = m.id order by released_on desc, created_at desc limit 1
         ) lr on true
         where m.status = 'published' and (m.source_url ilike '%github.com/%' or m.project_url ilike '%github.com/%')
         order by m.download_count desc limit 3000",
    )
    .fetch_all(&state.db)
    .await?;
    let mut out = HashMap::new();
    for r in rows {
        if let Some((owner, repo)) = repo_of(r.source_url.as_deref(), r.project_url.as_deref()) {
            out.entry(repo_key(&owner, &repo)).or_insert(BranchMod {
                slug: r.slug,
                name: r.name,
                summary: r.summary,
                thumbnail_url: r.thumbnail_key.as_deref().map(file_url),
                latest_version: r.latest_version,
                hosted: r.hosted,
            });
        }
    }
    Ok(out)
}

fn branch_json(branch: Option<&BranchMod>, release: Option<&crate::github::Release>) -> Value {
    match branch {
        None => Value::Null,
        Some(b) => {
            let up_to_date = match (release, b.latest_version.as_deref()) {
                (Some(r), Some(v)) => normalize_version(v) == normalize_version(&r.version),
                (None, _) => true,
                _ => false,
            };
            let mut v = json!(b);
            v["up_to_date"] = json!(up_to_date);
            v
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LookupInput {
    url: String,
}

async fn lookup(State(state): State<AppState>, visitor: Visitor, Json(input): Json<LookupInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("github-lookup:{}", visitor.id), 40, Duration::from_secs(600)) {
        return Err(AppError::too_many("too many lookups in a short time. wait a few minutes and try again."));
    }
    let Some((owner, repo)) = parse_repo(&input.url) else {
        return Err(AppError::field("url", "paste a github link, like https://github.com/someone/their-mod"));
    };
    let info = repo_info(&state, &owner, &repo).await.map_err(|m| AppError::field("url", &m))?;
    let Some(info) = info else {
        return Err(AppError::field("url", "github couldn't find that repo. it might be private, renamed or deleted."));
    };
    let release = latest_release(&state, &info.owner, &info.name).await.map_err(|m| AppError::field("url", &m))?;
    let branch = branch_mods(&state).await?;
    let found = branch.get(&repo_key(&info.owner, &info.name)).or_else(|| branch.get(&repo_key(&owner, &repo)));
    let pick = release.as_ref().and_then(|r| crate::github::pick_asset(&r.assets)).map(|a| a.name.clone());
    Ok(Json(json!({
        "repo": info,
        "latest": release,
        "recommended": pick,
        "branch": branch_json(found, release.as_ref()),
    })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LatestInput {
    repos: Vec<String>,
}

async fn latest(State(state): State<AppState>, visitor: Visitor, Json(input): Json<LatestInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("github-latest:{}", visitor.id), 30, Duration::from_secs(600)) {
        return Err(AppError::too_many("checking for updates too often. try again in a few minutes."));
    }
    let mut repos: Vec<(String, String)> = input.repos.iter().filter_map(|r| parse_repo(r)).collect();
    repos.sort_by_key(|r| repo_key(&r.0, &r.1));
    repos.dedup_by(|a, b| repo_key(&a.0, &a.1) == repo_key(&b.0, &b.1));
    repos.truncate(40);

    let mut tasks = tokio::task::JoinSet::new();
    for (owner, repo) in repos {
        let state = state.clone();
        tasks.spawn(async move {
            let release = latest_release(&state, &owner, &repo).await;
            (owner, repo, release)
        });
    }
    let branch = branch_mods(&state).await?;
    let mut results = serde_json::Map::new();
    while let Some(done) = tasks.join_next().await {
        let Ok((owner, repo, release)) = done else { continue };
        let key = repo_key(&owner, &repo);
        let value = match release {
            Ok(r) => json!({
                "latest": r,
                "recommended": r.as_ref().and_then(|r| crate::github::pick_asset(&r.assets)).map(|a| a.name.clone()),
                "branch": branch_json(branch.get(&key), r.as_ref()),
            }),
            Err(message) => json!({ "error": message }),
        };
        results.insert(key, value);
    }
    Ok(Json(json!({ "results": results })))
}
