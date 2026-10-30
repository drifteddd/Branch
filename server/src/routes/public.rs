// everything the desktop app uses. no login needed for any of it.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
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
    source: String,
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
    community: bool,
    /// the newest release date, or the last edit if there are no releases yet
    last_updated: NaiveDate,
}

pub async fn list_mods(State(state): State<AppState>, Query(query): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let per_page = query.per_page.unwrap_or(20).clamp(1, 50);
    let page = query.page.unwrap_or(1).clamp(1, 1000);

    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
        "select m.id, m.slug, m.name, m.summary, m.author_name, c.slug as category_slug, c.name as category_name,
                m.thumbnail_key, m.compatibility, m.featured, m.download_count,
                lr.version as latest_version, lr.released_on as latest_released_on, m.updated_at, m.source,
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
            community: r.source == "community",
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
    redistribution: String,
}

async fn find_release(state: &AppState, id: Uuid) -> ApiResult<DownloadTarget> {
    let target: Option<DownloadTarget> = sqlx::query_as(
        "select r.download_kind, r.external_url, r.file_key, r.file_name, r.download_disabled, r.disabled_reason,
                m.status as mod_status, m.redistribution
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
    // a hosted copy is only ever handed out when sharing is allowed
    let hosted_ok = target.download_kind == "hosted" && target.redistribution == "allowed";
    let (Some(key), Some(name)) = (target.file_key.filter(|_| hosted_ok), target.file_name) else {
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

// ---------- mod requests ----------

#[derive(Deserialize)]
pub struct RequestInput {
    #[serde(default)]
    mod_name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    details: String,
    #[serde(default)]
    contact: String,
    #[serde(default)]
    website: String,
}

pub async fn create_request(State(state): State<AppState>, visitor: Visitor, Json(input): Json<RequestInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !state.limiter.check(&format!("request:{}", visitor.id), 5, Duration::from_secs(3600)) {
        return Err(AppError::too_many("you've sent a lot of requests. wait an hour and try again."));
    }
    if !input.website.trim().is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }

    let mod_name = input.mod_name.trim().to_string();
    let author = input.author.trim().to_string();
    let details = input.details.trim().to_string();
    let contact = input.contact.trim().to_string();
    let mut errors = FieldErrors::default();
    errors.check(!mod_name.is_empty(), "mod_name", "what's the mod called?");
    errors.check(!too_long(&mod_name, 80), "mod_name", "keep the name under 80 characters");
    let url = match crate::util::clean_url(&input.url) {
        Ok(Some(url)) => Some(url),
        Ok(None) => {
            errors.add("url", "add a link to the mod, like its github page");
            None
        }
        Err(message) => {
            errors.add("url", message);
            None
        }
    };
    errors.check(!too_long(&author, 80), "author", "keep the author under 80 characters");
    errors.check(!too_long(&details, 1000), "details", "keep this under 1000 characters");
    errors.check(!too_long(&contact, 200), "contact", "keep the contact info under 200 characters");
    errors.finish()?;
    let url = url.unwrap_or_default();

    let today: i64 = sqlx::query_scalar("select count(*) from mod_requests where visitor = $1 and created_at > now() - interval '1 day'")
        .bind(&visitor.id)
        .fetch_one(&state.db)
        .await?;
    if today >= 15 {
        return Err(AppError::too_many("you've sent a lot of requests today. try again tomorrow."));
    }
    let duplicate: bool = sqlx::query_scalar("select exists(select 1 from mod_requests where visitor = $1 and url = $2 and created_at > now() - interval '7 days')")
        .bind(&visitor.id)
        .bind(&url)
        .fetch_one(&state.db)
        .await?;
    if !duplicate {
        sqlx::query("insert into mod_requests (id, mod_name, url, author, details, contact, visitor) values ($1, $2, $3, $4, $5, $6, $7)")
            .bind(Uuid::new_v4())
            .bind(&mod_name)
            .bind(&url)
            .bind(&author)
            .bind(&details)
            .bind(&contact)
            .bind(&visitor.id)
            .execute(&state.db)
            .await?;
        tracing::info!("new mod request received");
    }
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

// ---------- mod checker ----------

const AI_CALLS_KEY: &str = "__ai_calls__";
/// bump when the model or prompt changes, so old cached answers aren't shown
const CACHE_VERSION: &str = "v2";

async fn usage_today(state: &AppState, visitor: &str) -> Result<i32, sqlx::Error> {
    let used: Option<i32> = sqlx::query_scalar("select count from ai_usage where visitor = $1 and day = current_date")
        .bind(visitor)
        .fetch_optional(&state.db)
        .await?;
    Ok(used.unwrap_or(0))
}

async fn bump_usage(state: &AppState, visitor: &str) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "insert into ai_usage (visitor, day, count) values ($1, current_date, 1)
         on conflict (visitor, day) do update set count = ai_usage.count + 1
         returning count",
    )
    .bind(visitor)
    .fetch_one(&state.db)
    .await
}

pub async fn check_usage(State(state): State<AppState>, visitor: Visitor) -> ApiResult<Json<Value>> {
    let used = usage_today(&state, &visitor.id).await?;
    let limit = state.config.ai_daily_per_visitor;
    Ok(Json(json!({ "used": used, "limit": limit, "remaining": (limit - used).max(0) })))
}

pub fn verdict_label(score: u8) -> &'static str {
    match score {
        0..=20 => "Looks clean",
        21..=45 => "A few odd things",
        46..=70 => "Suspicious",
        _ => "Likely malicious",
    }
}

pub async fn check_mod(State(state): State<AppState>, visitor: Visitor, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("check:{}", visitor.id), 30, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little. try again in a few minutes."));
    }
    let limit = state.config.ai_daily_per_visitor;
    if usage_today(&state, &visitor.id).await? >= limit {
        return Err(AppError::too_many(format!("you've used all {limit} checks for today. they reset at midnight (UTC).")));
    }

    let mut upload: Option<(String, bytes::Bytes)> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is bigger than 50 MB")),
        };
        if field.name() == Some("file") {
            let name = field.file_name().unwrap_or("upload").to_string();
            let data = field
                .bytes()
                .await
                .map_err(|_| AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is bigger than 50 MB"))?;
            upload = Some((name, data));
        }
    }
    let (name, data) = upload.ok_or_else(|| AppError::bad_request("no file was attached"))?;

    // the file only lives in memory for this request. it's never written anywhere.
    let report = tokio::task::spawn_blocking(move || crate::scan::scan(&name, &data))
        .await
        .map_err(AppError::internal)?
        .map_err(|message| AppError::field("file", &message))?;

    let used = bump_usage(&state, &visitor.id).await?;

    // the cache key includes a version, so results from an older model or prompt aren't reused
    let cache_key = format!("{CACHE_VERSION}:{}", report.sha256);
    let cached: Option<Value> = sqlx::query_scalar("select result from ai_results where sha256 = $1 and created_at > now() - interval '30 days'")
        .bind(&cache_key)
        .fetch_optional(&state.db)
        .await?;

    let (verdict, from_cache) = match cached {
        Some(value) => (value, true),
        None => {
            let ai_allowed = state.config.ai_api_key.is_some() && usage_today(&state, AI_CALLS_KEY).await? < state.config.ai_daily_global;
            let ai = if ai_allowed {
                bump_usage(&state, AI_CALLS_KEY).await?;
                match crate::ai::ask(&state.http, &state.config, &report, None).await {
                    Ok(v) => Some(v),
                    Err(err) => {
                        tracing::warn!(error = %err, "ai check failed, using the basic scan");
                        None
                    }
                }
            } else {
                None
            };
            let value = match ai {
                Some(v) => {
                    // the model has the final say, but it can't wave away strong warning signs completely
                    let score = v.score.max((report.heuristic_score as f32 * 0.6).round() as u8);
                    json!({
                        "score": score,
                        "confidence": v.confidence,
                        "what_it_does": v.what_it_does,
                        "summary": v.summary,
                        "reasons": v.reasons,
                        "capabilities": v.capabilities,
                        "source": "ai",
                    })
                }
                None => {
                    let dangerous = report.code.capabilities.iter().filter(|c| c.level != "normal").count();
                    let (summary, reasons): (String, Vec<String>) = if report.indicators.is_empty() && dangerous == 0 {
                        ("Branch's basic scan didn't find any of the usual malware signs.".into(), vec!["no webhooks, code injection, hidden commands, miners or packed programs were found.".into()])
                    } else {
                        (
                            "the AI check isn't available right now, so this score comes from Branch's basic scan only.".into(),
                            report.indicators.iter().map(|i| i.label.to_string()).chain(report.code.capabilities.iter().filter(|c| c.level != "normal").map(|c| c.name.to_string())).collect(),
                        )
                    };
                    let capabilities: Vec<Value> = report.code.capabilities.iter().map(|c| json!({ "name": c.name, "level": c.level, "detail": c.evidence.first().cloned().unwrap_or_default() })).collect();
                    json!({
                        "score": report.heuristic_score,
                        "confidence": if report.code.dotnet_dlls > 0 { "medium" } else { "low" },
                        "what_it_does": "",
                        "summary": summary,
                        "reasons": reasons,
                        "capabilities": capabilities,
                        "source": "basic",
                    })
                }
            };
            if value["source"] == "ai" {
                sqlx::query("insert into ai_results (sha256, result) values ($1, $2) on conflict (sha256) do update set result = excluded.result, created_at = now()")
                    .bind(&cache_key)
                    .bind(&value)
                    .execute(&state.db)
                    .await?;
            }
            (value, false)
        }
    };

    let score = verdict["score"].as_u64().unwrap_or(0).min(100) as u8;
    Ok(Json(json!({
        "file": { "name": report.file_name, "size": report.size, "sha256": report.sha256, "kind": report.kind },
        "score": score,
        "verdict": verdict_label(score),
        "summary": verdict["summary"],
        "reasons": verdict["reasons"],
        "confidence": verdict["confidence"],
        "what_it_does": verdict["what_it_does"],
        "capabilities": verdict["capabilities"],
        "source": verdict["source"],
        "cached": from_cache,
        "indicators": report.indicators,
        "mod_markers": report.mod_markers,
        "code": {
            "dotnet": report.code.dotnet_dlls > 0,
            "types": report.code.type_count,
            "methods": report.code.method_count,
            "obfuscated": report.code.obfuscated,
        },
        "used": used,
        "limit": limit,
        "remaining": (limit - used).max(0),
    })))
}
// ---------- community uploads ----------

const UPLOADS_PER_DAY: i64 = 10;

/// the start of a description, used as the short summary in the list
fn first_sentence(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let end = line.find(". ").map(|i| i + 1).unwrap_or(line.len());
    let sentence: String = line[..end].chars().take(200).collect();
    sentence.trim().to_string()
}

/// anyone can upload their own mod. it needs a real mod file, a name and a description.
/// every file goes through the automatic safety check, and likely-harmful files are refused.
pub async fn create_submission(State(state): State<AppState>, visitor: Visitor, mut multipart: Multipart) -> ApiResult<(StatusCode, Json<Value>)> {
    if !state.limiter.check(&format!("submit:{}", visitor.id), 20, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little. try again in a few minutes."));
    }
    let today: i64 = sqlx::query_scalar("select count(*) from mods where uploader = $1 and created_at > now() - interval '1 day'")
        .bind(&visitor.id)
        .fetch_one(&state.db)
        .await?;
    if today >= UPLOADS_PER_DAY {
        return Err(AppError::too_many(format!("you can upload up to {UPLOADS_PER_DAY} mods a day. try again tomorrow.")));
    }

    let mut file: Option<(String, bytes::Bytes)> = None;
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is bigger than 50 MB")),
        };
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let file_name = field.file_name().unwrap_or("mod.dll").to_string();
            let data = field
                .bytes()
                .await
                .map_err(|_| AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is bigger than 50 MB"))?;
            file = Some((file_name, data));
        } else if !name.is_empty() {
            let text = field.text().await.map_err(|_| AppError::bad_request("couldn't read the form"))?;
            fields.insert(name, text.chars().take(6000).collect());
        }
    }
    let get = |key: &str| fields.get(key).map(|v| v.trim().to_string()).unwrap_or_default();

    // bots fill in the hidden field. pretend it worked.
    if !get("website").is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }

    let name = get("name");
    let description = get("description");
    let anonymous = get("anonymous") == "true";
    let author = if anonymous { String::new() } else { get("author") };
    let version = get("version");
    let category = get("category");

    let mut errors = FieldErrors::default();
    errors.check(name.chars().count() >= 2, "name", "give your mod a name");
    errors.check(!too_long(&name, 80), "name", "keep the name under 80 characters");
    errors.check(description.chars().count() >= 30, "description", "describe what your mod does (at least 30 characters)");
    errors.check(!too_long(&description, 5000), "description", "keep the description under 5000 characters");
    errors.check(!too_long(&author, 80), "author", "keep the author name under 80 characters");
    errors.check(!too_long(&version, 40), "version", "keep the version under 40 characters");
    errors.check(get("confirm") == "true", "confirm", "you have to confirm that you have the right to share this mod");
    errors.check(file.is_some(), "file", "attach your mod file (.dll or .zip)");
    let source_url = match crate::util::clean_url(&get("source_url")) {
        Ok(url) => url,
        Err(message) => {
            errors.add("source_url", message);
            None
        }
    };
    let category_id: Option<Uuid> = if category.is_empty() {
        None
    } else {
        let id = sqlx::query_scalar("select id from categories where slug = $1").bind(&category).fetch_optional(&state.db).await?;
        errors.check(id.is_some(), "category", "that category doesn't exist");
        id
    };
    errors.finish()?;

    let (original_name, data) = file.expect("checked above");
    let data = data.to_vec();
    let (checked, report, data) = tokio::task::spawn_blocking(move || {
        let checked = crate::uploads::check_mod_file(&original_name, &data)?;
        let report = crate::scan::scan(&original_name, &data)?;
        Ok::<_, String>((checked, report, data))
    })
    .await
    .map_err(AppError::internal)?
    .map_err(|message| AppError::field("file", &message))?;

    // the same safety check as the mod checker, with the ai when it's available
    let mut score = report.heuristic_score;
    let mut ai_used = false;
    if state.config.ai_api_key.is_some() && usage_today(&state, AI_CALLS_KEY).await? < state.config.ai_daily_global {
        bump_usage(&state, AI_CALLS_KEY).await?;
        // the ai also sees what the uploader claims, so it can spot a "hat mod" that steals passwords
        let claim = crate::ai::Claim { name: &name, description: &description };
        match crate::ai::ask(&state.http, &state.config, &report, Some(&claim)).await {
            Ok(v) => {
                score = v.score.max((report.heuristic_score as f32 * 0.6).round() as u8);
                ai_used = true;
            }
            Err(err) => tracing::warn!(error = %err, "ai check failed during an upload, using the basic scan"),
        }
    }
    if score >= 71 {
        tracing::warn!(score, "community upload refused by the safety check");
        return Err(AppError::field(
            "file",
            "Branch's automatic safety check flagged this file as likely harmful, so it wasn't published. if you think this is a mistake, email drifted1000@outlook.com.",
        ));
    }

    let display_author = if author.is_empty() { "Anonymous".to_string() } else { author };
    let version = if !version.is_empty() {
        version
    } else {
        crate::routes::admin::version_from_file(&checked.name).unwrap_or_else(|| "unversioned".into())
    };
    let mod_id = crate::routes::admin::insert_draft(&state.db, &name, &display_author, source_url, None).await?;
    let info = json!({
        "file_name": checked.name,
        "scan_score": score,
        "ai_used": ai_used,
        "signals": report.indicators.iter().map(|i| i.label).collect::<Vec<_>>(),
        "mod_markers": report.mod_markers,
    });
    let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
    if let Err(err) = crate::storage::put(state.store.as_ref(), &key, data).await {
        let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
        return Err(err.into());
    }

    let saved: Result<String, sqlx::Error> = async {
        let slug: String = sqlx::query_scalar(
            "update mods set summary = $1, description = $2, category_id = $3, status = 'published', published_at = now(),
                source = 'community', uploader = $4, redistribution = 'allowed',
                redistribution_note = 'the uploader confirmed that they made this mod or have permission to share it.',
                import_info = $5
             where id = $6 returning slug",
        )
        .bind(first_sentence(&description))
        .bind(&description)
        .bind(category_id)
        .bind(&visitor.id)
        .bind(&info)
        .bind(mod_id)
        .fetch_one(&state.db)
        .await?;
        sqlx::query(
            "insert into releases (id, mod_id, version, released_on, download_kind, file_key, file_name, file_size, file_sha256, file_type)
             values ($1, $2, $3, current_date, 'hosted', $4, $5, $6, $7, $8)",
        )
        .bind(Uuid::new_v4())
        .bind(mod_id)
        .bind(&version)
        .bind(&key)
        .bind(&checked.name)
        .bind(checked.size)
        .bind(&checked.sha256)
        .bind(checked.kind)
        .execute(&state.db)
        .await?;
        Ok(slug)
    }
    .await;

    match saved {
        Ok(slug) => {
            tracing::info!("new community upload");
            Ok((StatusCode::CREATED, Json(json!({ "ok": true, "slug": slug }))))
        }
        Err(err) => {
            crate::storage::delete_quietly(state.store.as_ref(), &key).await;
            let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
            Err(err.into())
        }
    }
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
