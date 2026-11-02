use std::sync::Mutex;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{audit, Admin};
use crate::error::{ApiResult, AppError};
use crate::github::{download_asset, latest_release, parse_repo, pick_asset, repo_info, repo_key, repo_of};
use crate::routes::public::{bump_usage, first_sentence, name_from_file, upload_insights, usage_today, AI_CALLS_KEY};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/import/github", get(status).post(start))
        .route("/api/admin/import/owner", axum::routing::post(link_owner))
}

#[derive(Clone, Serialize)]
struct Item {
    repo: String,
    status: &'static str,
    message: String,
    slug: Option<String>,
}

#[derive(Clone, Serialize, Default)]
struct Job {
    running: bool,
    publish: bool,
    items: Vec<Item>,
}

static JOB: Mutex<Option<Job>> = Mutex::new(None);

fn update(i: usize, status: &'static str, message: impl Into<String>, slug: Option<String>) {
    if let Ok(mut guard) = JOB.lock() {
        if let Some(item) = guard.as_mut().and_then(|j| j.items.get_mut(i)) {
            item.status = status;
            item.message = message.into();
            item.slug = slug;
        }
    }
}

async fn status(Admin(_): Admin) -> ApiResult<Json<Value>> {
    let job = JOB.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    Ok(Json(json!(job)))
}

#[derive(Deserialize)]
struct StartInput {
    repos: String,
    #[serde(default)]
    publish: bool,
}

async fn start(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<StartInput>) -> ApiResult<Json<Value>> {
    let mut seen = std::collections::HashSet::new();
    let repos: Vec<(String, String)> = input
        .repos
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter_map(parse_repo)
        .filter(|(o, r)| seen.insert(repo_key(o, r)))
        .take(200)
        .collect();
    if repos.is_empty() {
        return Err(AppError::field("repos", "paste at least one github link, one per line"));
    }
    {
        let mut guard = JOB.lock().map_err(AppError::internal)?;
        if guard.as_ref().is_some_and(|j| j.running) {
            return Err(AppError::bad_request("an import is already running. wait for it to finish."));
        }
        *guard = Some(Job {
            running: true,
            publish: input.publish,
            items: repos.iter().map(|(o, r)| Item { repo: format!("{o}/{r}"), status: "waiting", message: String::new(), slug: None }).collect(),
        });
    }
    audit(&state.db, &admin, "github_import", &format!("{} repos", repos.len()), if input.publish { "publish" } else { "drafts" }).await;
    let publish = input.publish;
    tokio::spawn(async move {
        for (i, (owner, repo)) in repos.iter().enumerate() {
            update(i, "working", "checking github", None);
            match import_one(&state, owner, repo, publish, None).await {
                Ok((slug, message)) => update(i, "done", message, Some(slug)),
                Err(Skip(message)) => update(i, "skipped", message, None),
            }
        }
        if let Ok(mut guard) = JOB.lock() {
            if let Some(job) = guard.as_mut() {
                job.running = false;
            }
        }
    });
    Ok(Json(json!({ "ok": true })))
}

struct Skip(String);

impl From<sqlx::Error> for Skip {
    fn from(err: sqlx::Error) -> Self {
        Skip(format!("database error: {err}"))
    }
}

impl From<AppError> for Skip {
    fn from(err: AppError) -> Self {
        Skip(err.message)
    }
}

const OPEN_LICENSES: &[&str] = &[
    "MIT", "Apache-2.0", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "AGPL-3.0", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC", "Unlicense", "CC0-1.0", "0BSD", "Zlib", "WTFPL",
];

async fn already_listed(state: &AppState, owner: &str, repo: &str) -> Result<Option<String>, Skip> {
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select slug, source_url, project_url from mods where status <> 'archived' and (source_url ilike '%github.com/%' or project_url ilike '%github.com/%')",
    )
    .fetch_all(&state.db)
    .await?;
    let key = repo_key(owner, repo);
    Ok(rows.into_iter().find(|(_, s, p)| repo_of(s.as_deref(), p.as_deref()).is_some_and(|(o, r)| repo_key(&o, &r) == key)).map(|(slug, _, _)| slug))
}

async fn import_one(state: &AppState, owner: &str, repo: &str, publish: bool, listing: Option<&SeedMod>) -> Result<(String, String), Skip> {
    if let Some(slug) = already_listed(state, owner, repo).await? {
        return Err(Skip(format!("already on Branch as {slug}")));
    }
    let info = repo_info(state, owner, repo).await.map_err(Skip)?.ok_or_else(|| Skip("github couldn't find this repo".into()))?;
    let release = latest_release(state, &info.owner, &info.name).await.map_err(Skip)?.ok_or_else(|| Skip("no releases on github".into()))?;
    let asset = pick_asset(&release.assets).cloned().ok_or_else(|| Skip("the newest release has no .dll or .zip file".into()))?;
    let data = download_asset(&info.owner, &info.name, &asset.url).await.map_err(Skip)?;
    let file_name = asset.name.clone();
    let (checked, report, data) = tokio::task::spawn_blocking(move || {
        let checked = crate::uploads::check_mod_file(&file_name, &data)?;
        let report = crate::scan::scan(&file_name, &data)?;
        Ok::<_, String>((checked, report, data))
    })
    .await
    .map_err(|e| Skip(e.to_string()))?
    .map_err(Skip)?;
    let exact: Option<String> = sqlx::query_scalar("select m.name from releases r join mods m on m.id = r.mod_id where r.file_sha256 = $1 and m.status <> 'archived' limit 1")
        .bind(&checked.sha256)
        .fetch_optional(&state.db)
        .await?;
    if let Some(name) = exact {
        return Err(Skip(format!("the same file is already on Branch as {name}")));
    }

    let mut score = report.basic_score();
    let mut verdict: Option<crate::ai::AiVerdict> = None;
    if listing.is_none() && state.config.ai_api_key.is_some() && usage_today(state, AI_CALLS_KEY).await? < state.config.ai_daily_global {
        bump_usage(state, AI_CALLS_KEY).await?;
        let existing_tags: Vec<String> = sqlx::query_scalar("select name from tags order by name limit 200").fetch_all(&state.db).await?;
        let categories: Vec<String> = sqlx::query_scalar("select slug from categories order by sort_order, name").fetch_all(&state.db).await?;
        let claim = crate::ai::Claim { name: &info.name, description: &info.description, existing_tags: &existing_tags, categories: &categories, write_listing: true };
        match crate::ai::ask(&state.http, &state.config, &report, Some(&claim)).await {
            Ok(v) => {
                score = report.final_score(v.score);
                verdict = Some(v);
            }
            Err(err) => tracing::warn!(error = %err, repo = %info.full_name, "ai failed during a github import, using the basic scan"),
        }
    }
    if score >= 85 && report.has_strong_signals() {
        return Err(Skip(format!("the safety check flagged this file ({score}/100)")));
    }

    let insights = verdict.as_ref().and_then(|v| v.insights.clone());
    let name: String = listing
        .map(|l| l.name.clone())
        .or_else(|| insights.as_ref().map(|i| i.suggested_name.trim().to_string()))
        .filter(|n| n.chars().count() >= 2)
        .unwrap_or_else(|| name_from_file(&info.name))
        .chars()
        .take(80)
        .collect();
    let mut description = listing.map(|l| l.description.clone()).filter(|d| d.chars().count() >= 30).or_else(|| insights.as_ref().map(|i| i.suggested_description.trim().to_string()).filter(|d| d.chars().count() >= 30)).unwrap_or_default();
    if description.is_empty() {
        description = if info.description.trim().chars().count() >= 10 { info.description.trim().to_string() } else { format!("{name}, a Gorilla Tag mod by {}.", info.owner) };
    }
    if listing.is_some_and(|l| l.category == "menus") {
        description.push_str(MENU_NOTE);
    }
    description.push_str(&format!("\n\n*made by [{}](https://github.com/{}). the original is on [github]({}).*", info.owner, info.owner, info.url));
    let tags = listing.map(|l| l.tags.clone()).or_else(|| insights.as_ref().map(|i| i.tags.clone())).unwrap_or_default();
    let category_id: Option<Uuid> = match listing.map(|l| l.category.as_str()).or_else(|| insights.as_ref().and_then(|i| i.category.as_deref())) {
        Some(slug) => {
            let fallback = category_fallback(slug);
            sqlx::query_scalar("select id from categories where slug = $1 or slug = $2 order by (slug = $1) desc limit 1").bind(slug).bind(fallback).fetch_optional(&state.db).await?
        }
        None => None,
    };
    let mut ai_insights = upload_insights(&report, score, verdict.as_ref(), listing.is_none() && !tags.is_empty(), listing.is_none() && category_id.is_some());
    ai_insights["listing_by_ai"] = json!(verdict.is_some());
    ai_insights["uploaded_via"] = json!("github-import");

    let license = info.license.clone().filter(|l| OPEN_LICENSES.iter().any(|o| o.eq_ignore_ascii_case(l)));
    let hosted = true;
    let version: String = if release.version.is_empty() { release.tag.clone() } else { release.version.clone() }.chars().take(40).collect();
    let changelog: String = release.notes.chars().take(4000).collect();

    let mod_id = crate::routes::admin::insert_draft(&state.db, &name, &info.owner, Some(info.url.clone()), None).await?;
    let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
    if hosted {
        if let Err(err) = crate::storage::put(state.store.as_ref(), &key, data).await {
            let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
            return Err(Skip(format!("couldn't store the file: {err}")));
        }
    }
    let import_info = json!({
        "file_name": checked.name,
        "scan_score": score,
        "ai_used": verdict.is_some(),
        "via": "github-import",
        "signals": report.indicators.iter().map(|i| i.label).collect::<Vec<_>>(),
        "mod_markers": report.mod_markers,
    });
    let saved: Result<String, sqlx::Error> = async {
        let slug: String = sqlx::query_scalar(
            "update mods set summary = $1, description = $2, category_id = $3,
                status = case when $4 then 'published' else 'draft' end, published_at = case when $4 then now() else null end,
                author_url = $5, license_name = $6, license_url = $7, redistribution = $8, redistribution_note = $9,
                imported_at = now(), import_info = $10, code_fingerprint = $11, unique_status = 'unique', ai_insights = $12,
                github_tag = $13, github_checked_at = now(), video_id = $15
             where id = $14 returning slug",
        )
        .bind(first_sentence(&description))
        .bind(&description)
        .bind(category_id)
        .bind(publish)
        .bind(format!("https://github.com/{}", info.owner))
        .bind(license.clone().unwrap_or_default())
        .bind(license.as_ref().map(|l| format!("https://spdx.org/licenses/{l}.html")))
        .bind(if hosted { "allowed" } else { "unknown" })
        .bind(match &license {
            Some(l) => format!("open source under the {l} license, which allows sharing it."),
            None => HOSTED_NOTE.to_string(),
        })
        .bind(&import_info)
        .bind(report.fingerprint())
        .bind(&ai_insights)
        .bind(&release.tag)
        .bind(mod_id)
        .bind(listing.and_then(|l| l.video.clone()))
        .fetch_one(&state.db)
        .await?;
        if !tags.is_empty() {
            let mut conn = state.db.acquire().await?;
            crate::routes::admin::set_tags(&mut conn, mod_id, &tags).await?;
        }
        if hosted {
            sqlx::query(
                "insert into releases (id, mod_id, version, released_on, changelog, download_kind, file_key, file_name, file_size, file_sha256, file_type, from_github)
                 values ($1, $2, $3, current_date, $4, 'hosted', $5, $6, $7, $8, $9, true)",
            )
            .bind(Uuid::new_v4())
            .bind(mod_id)
            .bind(&version)
            .bind(&changelog)
            .bind(&key)
            .bind(&checked.name)
            .bind(checked.size)
            .bind(&checked.sha256)
            .bind(checked.kind)
            .execute(&state.db)
            .await?;
        } else {
            sqlx::query(
                "insert into releases (id, mod_id, version, released_on, changelog, download_kind, external_url, file_sha256, from_github)
                 values ($1, $2, $3, current_date, $4, 'external', $5, $6, true)",
            )
            .bind(Uuid::new_v4())
            .bind(mod_id)
            .bind(&version)
            .bind(&changelog)
            .bind(&release.url)
            .bind(&checked.sha256)
            .execute(&state.db)
            .await?;
        }
        Ok(slug)
    }
    .await;
    match saved {
        Ok(_) => Ok((mod_id.to_string(), format!("{name} {version} · {} · safety {score}/100", if hosted { "hosted on Branch" } else { "links to github" }))),
        Err(err) => {
            if hosted {
                crate::storage::delete_quietly(state.store.as_ref(), &key).await;
            }
            let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
            Err(err.into())
        }
    }
}

#[derive(Deserialize)]
pub struct SeedMod {
    repo: String,
    #[serde(default)]
    video: Option<String>,
    name: String,
    category: String,
    tags: Vec<String>,
    description: String,
}

const SEED: &str = include_str!("../seed_mods.json");
const SEED_2: &str = include_str!("../seed_mods_2.json");
pub const HOSTED_NOTE: &str = "hosted by Branch with credit to the author. the original is on github. creators can ask for it to be removed at any time at drifted1000@outlook.com.";
const MENU_NOTE: &str = "\n\n**heads up:** mod menus change how the game plays for you and sometimes for others. only use them in private or modded lobbies; using them in public lobbies can get your account banned.";

fn category_fallback(slug: &str) -> &str {
    match slug {
        "maps" | "menus" => "gameplay",
        "libraries" => "utilities",
        other => other,
    }
}

fn seed_list() -> Result<Vec<SeedMod>, serde_json::Error> {
    let mut mods: Vec<SeedMod> = serde_json::from_str(SEED)?;
    mods.extend(serde_json::from_str::<Vec<SeedMod>>(SEED_2)?);
    Ok(mods)
}
const SEED_KEY: &str = "github_seed_done";

pub fn spawn_seed(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        if let Err(err) = run_seed(&state).await {
            tracing::warn!(error = %err.0, "the github seed import failed");
        }
        if let Err(err) = rehost_external(&state).await {
            tracing::warn!(error = %err.0, "moving github links to hosted downloads failed");
        }
    });
}

async fn run_seed(state: &AppState) -> Result<(), Skip> {
    let mods = seed_list().map_err(|e| Skip(e.to_string()))?;
    let done_value: Option<Value> = sqlx::query_scalar("select value from app_settings where key = $1").bind(SEED_KEY).fetch_optional(&state.db).await?;
    let mut done: Vec<String> = done_value.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let todo: Vec<&SeedMod> = mods.iter().filter(|m| !done.contains(&m.repo.to_ascii_lowercase())).collect();
    if todo.is_empty() {
        return Ok(());
    }
    loop {
        let busy = JOB.lock().map(|g| g.as_ref().is_some_and(|j| j.running)).unwrap_or(false);
        if !busy {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
    {
        let mut guard = JOB.lock().map_err(|e| Skip(e.to_string()))?;
        *guard = Some(Job { running: true, publish: true, items: todo.iter().map(|m| Item { repo: m.repo.clone(), status: "waiting", message: String::new(), slug: None }).collect() });
    }
    tracing::info!(count = todo.len(), "importing the built-in list of github mods");
    for (i, m) in todo.iter().enumerate() {
        let Some((owner, repo)) = parse_repo(&m.repo) else { continue };
        update(i, "working", "checking github", None);
        let result = match rewrite_imported(state, &owner, &repo, m).await? {
            Some(id) => Ok((id, format!("{} · listing rewritten", m.name))),
            None => import_one(state, &owner, &repo, true, Some(m)).await,
        };
        let finished = match result {
            Ok((id, message)) => {
                update(i, "done", message, Some(id));
                true
            }
            Err(Skip(message)) => {
                let retry = ["couldn't reach", "busy", "answered with an error", "couldn't download", "stopped", "database error", "couldn't store"].iter().any(|t| message.contains(t));
                update(i, "skipped", if retry { format!("{message} (will try again after the next restart)") } else { message }, None);
                !retry
            }
        };
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if !finished {
            continue;
        }
        done.push(m.repo.to_ascii_lowercase());
        sqlx::query("insert into app_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value")
            .bind(SEED_KEY)
            .bind(json!(done))
            .execute(&state.db)
            .await?;
    }
    if let Ok(mut guard) = JOB.lock() {
        if let Some(job) = guard.as_mut() {
            job.running = false;
        }
    }
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OwnerInput {
    username: String,
}

async fn link_owner(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<OwnerInput>) -> ApiResult<Json<Value>> {
    let poster: Option<Uuid> = sqlx::query_scalar("select poster_id from creator_accounts where username_lower = $1")
        .bind(input.username.trim().to_lowercase())
        .fetch_optional(&state.db)
        .await?;
    let Some(poster) = poster else {
        return Err(AppError::field("username", "there's no creator account with that username. make it in the app first (Creator hub)."));
    };
    let linked = sqlx::query("update mods set uploader_poster = $1 where import_info->>'via' = 'github-import' and status <> 'archived' and uploader_poster is distinct from $1")
        .bind(poster)
        .execute(&state.db)
        .await?
        .rows_affected();
    audit(&state.db, &admin, "link_imported_mods", input.username.trim(), &format!("{linked} mods")).await;
    Ok(Json(json!({ "ok": true, "linked": linked })))
}

#[derive(sqlx::FromRow)]
struct ExternalRow {
    release_id: Uuid,
    mod_id: Uuid,
    version: String,
    source_url: Option<String>,
    project_url: Option<String>,
}

async fn rehost_external(state: &AppState) -> Result<(), Skip> {
    let rows: Vec<ExternalRow> = sqlx::query_as(
        "select r.id as release_id, m.id as mod_id, r.version, m.source_url, m.project_url
         from mods m
         join lateral (select id, version, download_kind, from_github from releases x where x.mod_id = m.id order by released_on desc, created_at desc limit 1) r on true
         where m.status <> 'archived' and m.import_info->>'via' = 'github-import' and r.download_kind = 'external' and r.from_github",
    )
    .fetch_all(&state.db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    tracing::info!(count = rows.len(), "turning github links into hosted downloads");
    let mut moved = 0;
    for row in rows {
        let Some((owner, repo)) = repo_of(row.source_url.as_deref(), row.project_url.as_deref()) else { continue };
        let result: Result<(), String> = async {
            let release = latest_release(state, &owner, &repo).await?.ok_or("no releases on github")?;
            if crate::github::normalize_version(&release.version) != crate::github::normalize_version(&row.version) && crate::github::normalize_version(&release.tag) != crate::github::normalize_version(&row.version) {
                return Err("a newer github release exists; the github sync will add it".into());
            }
            let asset = pick_asset(&release.assets).cloned().ok_or("no .dll or .zip file in the release")?;
            let data = download_asset(&owner, &repo, &asset.url).await?;
            let name = asset.name.clone();
            let (checked, report, data) = tokio::task::spawn_blocking(move || {
                let checked = crate::uploads::check_mod_file(&name, &data)?;
                let report = crate::scan::scan(&name, &data)?;
                Ok::<_, String>((checked, report, data))
            })
            .await
            .map_err(|e| e.to_string())??;
            if report.basic_score() >= 85 && report.has_strong_signals() {
                return Err("the safety check flagged the file".into());
            }
            let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
            crate::storage::put(state.store.as_ref(), &key, data).await.map_err(|e| e.to_string())?;
            let saved = sqlx::query(
                "update releases set download_kind = 'hosted', external_url = null, file_key = $1, file_name = $2, file_size = $3, file_sha256 = $4, file_type = $5 where id = $6",
            )
            .bind(&key)
            .bind(&checked.name)
            .bind(checked.size)
            .bind(&checked.sha256)
            .bind(checked.kind)
            .bind(row.release_id)
            .execute(&state.db)
            .await;
            if let Err(err) = saved {
                crate::storage::delete_quietly(state.store.as_ref(), &key).await;
                return Err(err.to_string());
            }
            sqlx::query("update mods set redistribution = 'allowed', updated_at = now() where id = $1").bind(row.mod_id).execute(&state.db).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => moved += 1,
            Err(reason) => tracing::info!(mod_id = %row.mod_id, reason = %reason, "kept the github link"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    tracing::info!(moved, "github links turned into hosted downloads");
    Ok(())
}

async fn rewrite_imported(state: &AppState, owner: &str, repo: &str, m: &SeedMod) -> Result<Option<String>, Skip> {
    let rows: Vec<(Uuid, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, source_url, project_url, import_info->>'via' from mods where status <> 'archived' and source_url ilike '%github.com/%'",
    )
    .fetch_all(&state.db)
    .await?;
    let key = repo_key(owner, repo);
    let Some((id, source_url, _, _)) = rows
        .into_iter()
        .find(|(_, s, p, via)| via.as_deref() == Some("github-import") && repo_of(s.as_deref(), p.as_deref()).is_some_and(|(o, r)| repo_key(&o, &r) == key))
    else {
        return Ok(None);
    };
    let author = repo_of(source_url.as_deref(), None).map(|(o, _)| o).unwrap_or_else(|| owner.to_string());
    let url = source_url.unwrap_or_else(|| format!("https://github.com/{owner}/{repo}"));
    let note = if m.category == "menus" { MENU_NOTE } else { "" };
    let description = format!("{}{note}

*made by [{author}](https://github.com/{author}). the original is on [github]({url}).*", m.description);
    let fallback = category_fallback(&m.category);
    let category_id: Option<Uuid> = sqlx::query_scalar("select id from categories where slug = $1 or slug = $2 order by (slug = $1) desc limit 1").bind(&m.category).bind(fallback).fetch_optional(&state.db).await?;
    sqlx::query(
        "update mods set name = $1, summary = $2, description = $3, category_id = coalesce($4, category_id), updated_at = now(), video_id = coalesce(video_id, $6),
            ai_insights = case when ai_insights is null then null else jsonb_set(jsonb_set(ai_insights, '{listing_by_ai}', 'false'), '{tags_by_ai}', 'false') end
         where id = $5",
    )
    .bind(&m.name)
    .bind(first_sentence(&m.description))
    .bind(&description)
    .bind(category_id)
    .bind(id)
    .bind(&m.video)
    .execute(&state.db)
    .await?;
    let mut conn = state.db.acquire().await?;
    crate::routes::admin::set_tags(&mut conn, id, &m.tags).await?;
    Ok(Some(id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_list_is_valid() {
        let mods = seed_list().unwrap();
        assert!(mods.len() >= 50);
        let mut seen = std::collections::HashSet::new();
        for m in &mods {
            assert!(seen.insert(m.repo.to_ascii_lowercase()), "listed twice: {}", m.repo);
            if let Some(v) = &m.video {
                assert!(crate::util::youtube_id(v).as_deref() == Some(v.as_str()), "bad video id for {}", m.repo);
            }
        }
        for m in &mods {
            assert!(parse_repo(&m.repo).is_some(), "{}", m.repo);
            assert!(matches!(m.category.as_str(), "cosmetics" | "gameplay" | "utilities" | "maps" | "libraries" | "menus"), "{}", m.repo);
            assert!(m.description.chars().count() >= 30 && m.name.chars().count() >= 2, "{}", m.repo);
        }
    }
}
