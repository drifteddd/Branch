// everything the desktop app uses. no login needed for any of it.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use object_store::path::Path as StorePath;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, Postgres, QueryBuilder};
use uuid::Uuid;

use crate::error::{ApiResult, AppError, FieldErrors};
use crate::models::{file_url, load_detail, Lookup, ModDetail, COMPATIBILITY, PLATFORMS, REPORT_REASONS};
use crate::state::AppState;
use crate::util::{like_pattern, too_long, valid_slug, Visitor};

pub async fn health(State(state): State<AppState>) -> Response {
    match sqlx::query("select 1").execute(&state.db).await {
        Ok(_) => Json(json!({ "status": "ok" })).into_response(),
        Err(err) => {
            tracing::error!(error = %err, "health check couldn't reach the database");
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "database unavailable" }))).into_response()
        }
    }
}

pub async fn meta(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    #[derive(FromRow, Serialize)]
    struct CategoryCount {
        id: Uuid,
        slug: String,
        name: String,
        description: String,
        mod_count: i64,
    }
    let categories: Vec<CategoryCount> = sqlx::query_as(
        "select c.id, c.slug, c.name, c.description,
                count(m.id) filter (where m.status = 'published') as mod_count
         from categories c left join mods m on m.category_id = c.id
         group by c.id order by c.sort_order, c.name",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({
        "categories": categories,
        "compatibility": COMPATIBILITY.iter().map(|(key, label, description)| json!({ "key": key, "label": label, "description": description })).collect::<Vec<_>>(),
        "platforms": PLATFORMS.iter().map(|(key, label)| json!({ "key": key, "label": label })).collect::<Vec<_>>(),
        "report_reasons": REPORT_REASONS.iter().map(|(key, label)| json!({ "key": key, "label": label })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ListQuery {
    q: Option<String>,
    category: Option<String>,
    compat: Option<String>,
    sort: Option<String>,
    featured: Option<bool>,
    slugs: Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
}

#[derive(FromRow)]
struct ListRow {
    id: Uuid,
    slug: String,
    name: String,
    summary: String,
    author_name: String,
    category_slug: Option<String>,
    category_name: Option<String>,
    thumbnail_key: Option<String>,
    compatibility: String,
    featured: bool,
    download_count: i64,
    latest_version: Option<String>,
    latest_released_on: Option<NaiveDate>,
    updated_at: DateTime<Utc>,
    total_count: i64,
}

#[derive(Serialize)]
struct CategoryLink {
    slug: String,
    name: String,
}

#[derive(Serialize)]
struct ModSummary {
    id: Uuid,
    slug: String,
    name: String,
    summary: String,
    author: String,
    category: Option<CategoryLink>,
    thumbnail_url: Option<String>,
    compatibility: String,
    featured: bool,
    downloads: i64,
    latest_version: Option<String>,
    /// the newest release date, or the last edit if there are no releases yet
    last_updated: NaiveDate,
}

pub async fn list_mods(State(state): State<AppState>, Query(query): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let per_page = query.per_page.unwrap_or(20).clamp(1, 50);
    let page = query.page.unwrap_or(1).clamp(1, 1000);

    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
        "select m.id, m.slug, m.name, m.summary, m.author_name, c.slug as category_slug, c.name as category_name,
                m.thumbnail_key, m.compatibility, m.featured, m.download_count,
                lr.version as latest_version, lr.released_on as latest_released_on, m.updated_at,
                count(*) over () as total_count
         from mods m
         left join categories c on c.id = m.category_id
         left join lateral (
             select version, released_on from releases r
             where r.mod_id = m.id order by released_on desc, created_at desc limit 1
         ) lr on true
         where m.status = 'published'",
    );

    if let Some(q) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let q: String = q.chars().take(100).collect();
        let pattern = like_pattern(&q);
        qb.push(" and (m.name ilike ").push_bind(pattern.clone());
        qb.push(" or m.summary ilike ").push_bind(pattern.clone());
        qb.push(" or m.description ilike ").push_bind(pattern.clone());
        qb.push(" or m.author_name ilike ").push_bind(pattern.clone());
        qb.push(" or exists (select 1 from mod_tags mt join tags t on t.id = mt.tag_id where mt.mod_id = m.id and t.name ilike ")
            .push_bind(pattern);
        qb.push("))");
    }
    if let Some(category) = query.category.as_deref().filter(|c| !c.is_empty()) {
        qb.push(" and c.slug = ").push_bind(category.to_string());
    }
    if let Some(compat) = query.compat.as_deref().filter(|c| !c.is_empty()) {
        if !COMPATIBILITY.iter().any(|(key, _, _)| *key == compat) {
            return Err(AppError::bad_request("unknown compatibility filter"));
        }
        qb.push(" and m.compatibility = ").push_bind(compat.to_string());
    }
    if query.featured == Some(true) {
        qb.push(" and m.featured");
    }
    if let Some(slugs) = query.slugs.as_deref() {
        // used for favorites and recently viewed, which are only stored on the person's computer
        let slugs: Vec<String> = slugs.split(',').map(str::trim).filter(|s| valid_slug(s)).take(200).map(String::from).collect();
        qb.push(" and m.slug = any(").push_bind(slugs).push(")");
    }

    let order = match query.sort.as_deref().unwrap_or("updated") {
        "updated" => " order by coalesce(lr.released_on, m.updated_at::date) desc, m.updated_at desc",
        "newest" => " order by coalesce(m.published_at, m.created_at) desc",
        "name" => " order by lower(m.name) asc",
        "downloads" => " order by m.download_count desc, lower(m.name) asc",
        _ => return Err(AppError::bad_request("unknown sort")),
    };
    qb.push(order);
    qb.push(", m.id limit ").push_bind(per_page).push(" offset ").push_bind((page - 1) * per_page);

    let rows: Vec<ListRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let total = rows.first().map(|r| r.total_count).unwrap_or(0);
    let has_more = page * per_page < total;

    let items: Vec<ModSummary> = rows
        .into_iter()
        .map(|r| ModSummary {
            id: r.id,
            slug: r.slug,
            name: r.name,
            summary: r.summary,
            author: r.author_name,
            category: match (r.category_slug, r.category_name) {
                (Some(slug), Some(name)) => Some(CategoryLink { slug, name }),
                _ => None,
            },
            thumbnail_url: r.thumbnail_key.as_deref().map(file_url),
            compatibility: r.compatibility,
            featured: r.featured,
            downloads: r.download_count,
            latest_version: r.latest_version,
            last_updated: r.latest_released_on.unwrap_or_else(|| r.updated_at.date_naive()),
        })
        .collect();

    // when a page is past the end, the window count is missing, so report what we know
    Ok(Json(json!({ "items": items, "page": page, "per_page": per_page, "total": total, "has_more": has_more })))
}

pub async fn mod_detail(State(state): State<AppState>, Path(slug): Path<String>) -> ApiResult<Json<ModDetail>> {
    if !valid_slug(&slug) {
        return Err(AppError::not_found("that mod isn't listed"));
    }
    let detail = load_detail(&state.db, Lookup::PublishedSlug(&slug))
        .await?
        .ok_or_else(|| AppError::not_found("that mod isn't listed"))?;
    Ok(Json(detail))
}

#[derive(FromRow)]
struct DownloadTarget {
    download_kind: String,
    external_url: Option<String>,
    file_key: Option<String>,
    file_name: Option<String>,
    download_disabled: bool,
    disabled_reason: String,
    mod_status: String,
}

async fn find_release(state: &AppState, id: Uuid) -> ApiResult<DownloadTarget> {
    let target: Option<DownloadTarget> = sqlx::query_as(
        "select r.download_kind, r.external_url, r.file_key, r.file_name, r.download_disabled, r.disabled_reason,
                m.status as mod_status
         from releases r join mods m on m.id = r.mod_id where r.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let target = target.filter(|t| t.mod_status == "published").ok_or_else(|| AppError::not_found("that download doesn't exist"))?;
    if target.download_disabled {
        let message = if target.disabled_reason.is_empty() {
            "this download was turned off by the Branch admin".to_string()
        } else {
            format!("this download was turned off: {}", target.disabled_reason)
        };
        return Err(AppError::new(StatusCode::GONE, "download_disabled", message));
    }
    Ok(target)
}

/// counts each person once per release per day
async fn count_download(state: &AppState, release_id: Uuid, visitor: &str) {
    let inserted = sqlx::query("insert into download_events (release_id, visitor) values ($1, $2) on conflict do nothing")
        .bind(release_id)
        .bind(visitor)
        .execute(&state.db)
        .await;
    if let Ok(result) = inserted {
        if result.rows_affected() == 1 {
            let _ = sqlx::query("update mods set download_count = download_count + 1 where id = (select mod_id from releases where id = $1)")
                .bind(release_id)
                .execute(&state.db)
                .await;
        }
    }
}

pub async fn download(State(state): State<AppState>, visitor: Visitor, Path(id): Path<Uuid>) -> ApiResult<Response> {
    let target = find_release(&state, id).await?;
    let (Some(key), Some(name)) = (target.file_key.filter(|_| target.download_kind == "hosted"), target.file_name) else {
        return Err(AppError::not_found("this release isn't hosted on Branch"));
    };
    if !state.limiter.check(&format!("download:{}", visitor.id), 60, Duration::from_secs(3600)) {
        return Err(AppError::too_many("too many downloads in a short time. wait a bit and try again."));
    }

    let file = state.store.get(&StorePath::from(key.as_str())).await?;
    let size = file.meta.size;
    count_download(&state, id, &visitor.id).await;

    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, size.to_string())
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\""))
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(file.into_stream()))
        .map_err(AppError::internal)
}

/// for releases that live on the author's site: count it, then send the browser there
pub async fn outbound(State(state): State<AppState>, visitor: Visitor, Path(id): Path<Uuid>) -> ApiResult<Response> {
    let target = find_release(&state, id).await?;
    let Some(url) = target.external_url.filter(|_| target.download_kind == "external") else {
        return Err(AppError::not_found("this release doesn't have an outside link"));
    };
    count_download(&state, id, &visitor.id).await;
    Ok(Redirect::to(&url).into_response())
}

/// serves stored images. only keys branch made itself ("images/<uuid>.jpg") are allowed,
/// so this can't be used to read anything else from storage.
pub async fn file(State(state): State<AppState>, Path(key): Path<String>) -> ApiResult<Response> {
    let content_type = image_key_type(&key).ok_or_else(|| AppError::not_found("file not found"))?;
    let bytes = state.store.get(&StorePath::from(key.as_str())).await?.bytes().await?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            // keys never get reused, so images can be cached forever. saves bandwidth.
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

fn image_key_type(key: &str) -> Option<&'static str> {
    let name = key.strip_prefix("images/")?;
    let (stem, ext) = name.split_once('.')?;
    if Uuid::parse_str(stem).is_err() {
        return None;
    }
    match ext {
        "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct ReportInput {
    mod_slug: String,
    reason: String,
    #[serde(default)]
    details: String,
    #[serde(default)]
    contact: String,
    /// the hidden "website" field. people never see it, so only bots fill it in.
    #[serde(default)]
    website: String,
}

pub async fn create_report(State(state): State<AppState>, visitor: Visitor, Json(input): Json<ReportInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !state.limiter.check(&format!("report:{}", visitor.id), 5, Duration::from_secs(3600)) {
        return Err(AppError::too_many("you've sent a lot of reports. wait an hour and try again."));
    }
    // pretend it worked so bots don't learn anything
    if !input.website.trim().is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }

    let details = input.details.trim().to_string();
    let contact = input.contact.trim().to_string();
    let mut errors = FieldErrors::default();
    errors.check(REPORT_REASONS.iter().any(|(key, _)| *key == input.reason), "reason", "pick a reason for the report");
    errors.check(!too_long(&details, 2000), "details", "keep the details under 2000 characters");
    errors.check(!too_long(&contact, 200), "contact", "keep the contact info under 200 characters");
    errors.check(!(input.reason == "other" && details.is_empty()), "details", "tell the admin a little about the problem");
    errors.finish()?;

    let target: Option<(Uuid, String)> = sqlx::query_as("select id, name from mods where slug = $1 and status = 'published'")
        .bind(&input.mod_slug)
        .fetch_optional(&state.db)
        .await?;
    let (mod_id, mod_name) = target.ok_or_else(|| AppError::not_found("that mod isn't listed anymore"))?;

    let recent: i64 = sqlx::query_scalar("select count(*) from reports where visitor = $1 and created_at > now() - interval '1 day'")
        .bind(&visitor.id)
        .fetch_one(&state.db)
        .await?;
    if recent >= 20 {
        return Err(AppError::too_many("you've sent a lot of reports today. try again tomorrow."));
    }

    // the same person reporting the same thing twice in a day only counts once
    let duplicate: bool = sqlx::query_scalar(
        "select exists(select 1 from reports where visitor = $1 and mod_id = $2 and reason = $3 and created_at > now() - interval '1 day')",
    )
    .bind(&visitor.id)
    .bind(mod_id)
    .bind(&input.reason)
    .fetch_one(&state.db)
    .await?;

    if !duplicate {
        sqlx::query("insert into reports (id, mod_id, mod_name, reason, details, contact, visitor) values ($1, $2, $3, $4, $5, $6, $7)")
            .bind(Uuid::new_v4())
            .bind(mod_id)
            .bind(&mod_name)
            .bind(&input.reason)
            .bind(&details)
            .bind(&contact)
            .bind(&visitor.id)
            .execute(&state.db)
            .await?;
        tracing::info!(reason = %input.reason, "new report received");
    }

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

#[cfg(test)]
mod tests {
    use super::image_key_type;

    #[test]
    fn only_branch_image_keys_are_served() {
        assert_eq!(image_key_type("images/2f1b0c1e-6a5e-4d0b-9a57-3f8a3f0c9d11.jpg"), Some("image/jpeg"));
        assert_eq!(image_key_type("files/2f1b0c1e-6a5e-4d0b-9a57-3f8a3f0c9d11/x.dll"), None);
        assert_eq!(image_key_type("images/../files/x.jpg"), None);
        assert_eq!(image_key_type("images/abc.exe"), None);
    }
}
