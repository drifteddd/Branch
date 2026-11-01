use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::error::{ApiResult, AppError};
use crate::github::{parse_repo, repo_of};
use crate::models::file_url;
use crate::routes::forum::poster_for;
use crate::routes::public::{rating, Rating, TOP_RATED_SQL};
use crate::state::AppState;
use crate::util::Visitor;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/creator/me", post(me))
        .route("/api/creator/mods/{slug}/github", post(set_github))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct KeyInput {
    key: String,
}

#[derive(FromRow)]
struct MyModRow {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    thumbnail_key: Option<String>,
    download_count: i64,
    rating_sum: i32,
    rating_count: i32,
    featured: bool,
    latest_version: Option<String>,
    created_at: DateTime<Utc>,
    source_url: Option<String>,
    project_url: Option<String>,
    github_sync: bool,
    github_tag: Option<String>,
    github_checked_at: Option<DateTime<Utc>>,
    scan_score: Option<i32>,
    from_github: i64,
}

#[derive(Serialize)]
struct MyMod {
    slug: String,
    name: String,
    status: String,
    thumbnail_url: Option<String>,
    downloads: i64,
    week_downloads: i64,
    rating: Rating,
    featured: bool,
    latest_version: Option<String>,
    created_at: DateTime<Utc>,
    scan_score: Option<i32>,
    github: Option<Value>,
}

async fn me(State(state): State<AppState>, visitor: Visitor, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    let rows: Vec<MyModRow> = sqlx::query_as(&format!(
        "with top as ({TOP_RATED_SQL})
         select m.id, m.slug, m.name, m.status, m.thumbnail_key, m.download_count, m.rating_sum, m.rating_count,
                (m.id in (select id from top)) as featured, lr.version as latest_version, m.created_at,
                m.source_url, m.project_url, m.github_sync, m.github_tag, m.github_checked_at,
                round((m.import_info->>'scan_score')::numeric)::int as scan_score,
                (select count(*) from releases g where g.mod_id = m.id and g.from_github) as from_github
         from mods m
         left join lateral (
             select version from releases r where r.mod_id = m.id order by released_on desc, created_at desc limit 1
         ) lr on true
         where m.uploader_poster = $1 and m.status in ('published', 'unpublished')
         order by m.created_at desc limit 200"
    ))
    .bind(poster.id)
    .fetch_all(&state.db)
    .await?;

    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let daily_rows: Vec<(Uuid, i32, i64)> = sqlx::query_as(
        "select r.mod_id, (current_date - de.day)::int as ago, count(*)
         from download_events de join releases r on r.id = de.release_id
         where r.mod_id = any($1) and de.day > current_date - 14
         group by 1, 2",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let mut daily = [0i64; 14];
    for (_, ago, count) in &daily_rows {
        if (0..14).contains(ago) {
            daily[13 - *ago as usize] += count;
        }
    }

    let (rank, creators): (Option<i64>, i64) = sqlx::query_as(
        "with t as (
             select uploader_poster as p, sum(download_count)::bigint as d from mods
             where status = 'published' and uploader_poster is not null group by 1
         )
         select case when exists(select 1 from t where p = $1)
                     then (select count(*) from t where d > (select d from t where p = $1)) + 1 end,
                (select count(*) from t)",
    )
    .bind(poster.id)
    .fetch_one(&state.db)
    .await?;

    let published: Vec<&MyModRow> = rows.iter().filter(|r| r.status == "published").collect();
    let downloads: i64 = published.iter().map(|r| r.download_count).sum();
    let rating_sum: i64 = published.iter().map(|r| r.rating_sum as i64).sum();
    let ratings: i64 = published.iter().map(|r| r.rating_count as i64).sum();
    let week: i64 = daily[7..].iter().sum();

    let mods: Vec<MyMod> = rows
        .iter()
        .map(|r| {
            let week_downloads = daily_rows.iter().filter(|(id, ago, _)| *id == r.id && *ago < 7).map(|(_, _, c)| c).sum();
            let github = repo_of(r.source_url.as_deref(), r.project_url.as_deref()).map(|(owner, repo)| {
                json!({
                    "repo": format!("{owner}/{repo}"),
                    "url": format!("https://github.com/{owner}/{repo}"),
                    "sync": r.github_sync,
                    "tag": r.github_tag,
                    "checked_at": r.github_checked_at,
                    "updates": r.from_github,
                })
            });
            MyMod {
                slug: r.slug.clone(),
                name: r.name.clone(),
                status: r.status.clone(),
                thumbnail_url: r.thumbnail_key.as_deref().map(file_url),
                downloads: r.download_count,
                week_downloads,
                rating: rating(r.rating_sum, r.rating_count),
                featured: r.featured,
                latest_version: r.latest_version.clone(),
                created_at: r.created_at,
                scan_score: r.scan_score,
                github,
            }
        })
        .collect();

    Ok(Json(json!({
        "name": poster.name,
        "mods": mods,
        "totals": {
            "uploads": published.len(),
            "downloads": downloads,
            "week_downloads": week,
            "ratings": ratings,
            "average": if ratings > 0 { Some(((rating_sum as f64 / ratings as f64) * 10.0).round() / 10.0) } else { None },
            "featured": published.iter().filter(|r| r.featured).count(),
            "five_star": published.iter().filter(|r| r.rating_count >= 3 && r.rating_sum as f64 / r.rating_count as f64 >= 4.5).count(),
            "github_linked": published.iter().filter(|r| repo_of(r.source_url.as_deref(), r.project_url.as_deref()).is_some() && r.github_sync).count(),
            "clean": !published.is_empty() && published.iter().all(|r| r.scan_score.is_none_or(|s| s <= 40)),
        },
        "daily": daily,
        "rank": rank,
        "creators": creators,
    })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct GithubInput {
    key: String,
    url: Option<String>,
    sync: Option<bool>,
}

async fn set_github(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>, Json(input): Json<GithubInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("creator-github:{}", visitor.id), 30, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little and try again in a few minutes."));
    }
    let poster = poster_for(&state, &input.key, &visitor, false).await?;
    let owned: Option<(Uuid, String)> = sqlx::query_as("select id, name from mods where slug = $1 and uploader_poster = $2 and status in ('published', 'unpublished')")
        .bind(&slug)
        .bind(poster.id)
        .fetch_optional(&state.db)
        .await?;
    let Some((mod_id, _)) = owned else {
        return Err(AppError::not_found("you can only change mods you uploaded"));
    };
    if let Some(url) = input.url.as_deref().map(str::trim) {
        if url.is_empty() {
            sqlx::query("update mods set source_url = null, github_tag = null where id = $1").bind(mod_id).execute(&state.db).await?;
        } else {
            let Some((owner, repo)) = parse_repo(url) else {
                return Err(AppError::field("url", "paste a github link, like https://github.com/you/your-mod"));
            };
            let info = crate::github::repo_info(&state, &owner, &repo).await.map_err(|m| AppError::field("url", &m))?;
            let Some(info) = info else {
                return Err(AppError::field("url", "github couldn't find that repo. it might be private or deleted."));
            };
            sqlx::query("update mods set source_url = $1, github_tag = null, github_checked_at = null, github_sync = true where id = $2")
                .bind(&info.url)
                .bind(mod_id)
                .execute(&state.db)
                .await?;
        }
    }
    if let Some(sync) = input.sync {
        sqlx::query("update mods set github_sync = $1 where id = $2").bind(sync).bind(mod_id).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}
