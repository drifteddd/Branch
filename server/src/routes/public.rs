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
    rating_sum: i32,
    rating_count: i32,
    total_count: i64,
}

pub(crate) const RATING_SCORE_SQL: &str = "((m.rating_sum + 15.0) / (m.rating_count + 5))";
pub(crate) const TOP_RATED_SQL: &str = "select m.id from mods m where m.status = 'published' and m.rating_count > 0
     order by ((m.rating_sum + 15.0) / (m.rating_count + 5)) desc, m.rating_count desc, m.download_count desc limit 10";

#[derive(Serialize)]
pub(crate) struct Rating {
    pub average: Option<f64>,
    pub count: i32,
}

pub(crate) fn rating(sum: i32, count: i32) -> Rating {
    Rating { average: (count > 0).then(|| ((sum as f64 / count as f64) * 10.0).round() / 10.0), count }
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
    last_updated: NaiveDate,
    rating: Rating,
}

pub async fn list_mods(State(state): State<AppState>, Query(query): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let per_page = query.per_page.unwrap_or(20).clamp(1, 50);
    let page = query.page.unwrap_or(1).clamp(1, 1000);

    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(format!(
        "with top as ({TOP_RATED_SQL})
         select m.id, m.slug, m.name, m.summary, m.author_name, c.slug as category_slug, c.name as category_name,
                m.thumbnail_key, m.compatibility, (m.id in (select id from top)) as featured, m.download_count,
                lr.version as latest_version, lr.released_on as latest_released_on, m.updated_at, m.source,
                m.rating_sum, m.rating_count,
                count(*) over () as total_count
         from mods m"
    ));
    qb.push(
        " left join categories c on c.id = m.category_id
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
        qb.push(" and m.id in (select id from top)");
    }
    if let Some(slugs) = query.slugs.as_deref() {
        let slugs: Vec<String> = slugs.split(',').map(str::trim).filter(|s| valid_slug(s)).take(200).map(String::from).collect();
        qb.push(" and m.slug = any(").push_bind(slugs).push(")");
    }

    let top_order = format!(" order by {RATING_SCORE_SQL} desc, m.rating_count desc, m.download_count desc, coalesce(m.published_at, m.created_at) desc");
    let order = match query.sort.as_deref().unwrap_or("top") {
        "top" => top_order.as_str(),
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
            rating: rating(r.rating_sum, r.rating_count),
        })
        .collect();

    Ok(Json(json!({ "items": items, "page": page, "per_page": per_page, "total": total, "has_more": has_more })))
}

#[derive(FromRow, Serialize)]
struct TreeNode {
    slug: String,
    name: String,
    category_slug: Option<String>,
    category_name: Option<String>,
    downloads: i64,
    community: bool,
    added: DateTime<Utc>,
    rating_sum: i32,
    rating_count: i32,
    featured: bool,
}

pub async fn tree(State(state): State<AppState>) -> ApiResult<Response> {
    let nodes: Vec<TreeNode> = sqlx::query_as(&format!(
        "with top as ({TOP_RATED_SQL})
         select m.slug, m.name, c.slug as category_slug, c.name as category_name, m.download_count as downloads,
                (m.source = 'community') as community, coalesce(m.published_at, m.created_at) as added,
                m.rating_sum, m.rating_count, (m.id in (select id from top)) as featured
         from mods m left join categories c on c.id = m.category_id
         where m.status = 'published'
         order by coalesce(m.published_at, m.created_at), m.id
         limit 20000"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(([(header::CACHE_CONTROL, "public, max-age=15")], Json(json!({ "mods": nodes }))).into_response())
}

pub async fn mod_detail(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>) -> ApiResult<Json<ModDetail>> {
    if !valid_slug(&slug) {
        return Err(AppError::not_found("that mod isn't listed"));
    }
    let mut detail = load_detail(&state.db, Lookup::PublishedSlug(&slug))
        .await?
        .ok_or_else(|| AppError::not_found("that mod isn't listed"))?;
    detail.featured = sqlx::query_scalar(&format!("select exists(select 1 from ({TOP_RATED_SQL}) top where top.id = $1)"))
        .bind(detail.id)
        .fetch_one(&state.db)
        .await?;
    detail.my_rating = sqlx::query_scalar("select stars from mod_ratings where mod_id = $1 and rater = $2")
        .bind(detail.id)
        .bind(&visitor.id)
        .fetch_optional(&state.db)
        .await?;
    Ok(Json(detail))
}

#[derive(Deserialize)]
pub struct RateInput {
    stars: i16,
}

pub async fn rate_mod(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>, Json(input): Json<RateInput>) -> ApiResult<Json<Value>> {
    if !valid_slug(&slug) {
        return Err(AppError::not_found("that mod isn't listed"));
    }
    if !(1..=5).contains(&input.stars) {
        return Err(AppError::bad_request("pick between 1 and 5 stars"));
    }
    if !state.limiter.check(&format!("rate:{}", visitor.id), 60, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little. try again in a few minutes."));
    }
    let mod_id: Option<Uuid> = sqlx::query_scalar("select id from mods where slug = $1 and status = 'published'").bind(&slug).fetch_optional(&state.db).await?;
    let mod_id = mod_id.ok_or_else(|| AppError::not_found("that mod isn't listed"))?;
    sqlx::query(
        "insert into mod_ratings (mod_id, rater, stars) values ($1, $2, $3)
         on conflict (mod_id, rater) do update set stars = excluded.stars, updated_at = now()",
    )
    .bind(mod_id)
    .bind(&visitor.id)
    .bind(input.stars)
    .execute(&state.db)
    .await?;
    let (sum, count): (i32, i32) = sqlx::query_as(
        "update mods set rating_sum = coalesce((select sum(stars) from mod_ratings where mod_id = $1), 0)::int,
                         rating_count = (select count(*) from mod_ratings where mod_id = $1)::int
         where id = $1 returning rating_sum, rating_count",
    )
    .bind(mod_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(json!({ "rating": rating(sum, count), "my_rating": input.stars })))
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

pub async fn outbound(State(state): State<AppState>, visitor: Visitor, Path(id): Path<Uuid>) -> ApiResult<Response> {
    let target = find_release(&state, id).await?;
    let Some(url) = target.external_url.filter(|_| target.download_kind == "external") else {
        return Err(AppError::not_found("this release doesn't have an outside link"));
    };
    count_download(&state, id, &visitor.id).await;
    Ok(Redirect::to(&url).into_response())
}

pub async fn file(State(state): State<AppState>, Path(key): Path<String>) -> ApiResult<Response> {
    let content_type = image_key_type(&key).ok_or_else(|| AppError::not_found("file not found"))?;
    let bytes = state.store.get(&StorePath::from(key.as_str())).await?.bytes().await?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
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
    #[serde(default)]
    website: String,
    #[serde(default)]
    key: String,
}

pub async fn create_report(State(state): State<AppState>, visitor: Visitor, Json(input): Json<ReportInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !state.limiter.check(&format!("report:{}", visitor.id), 5, Duration::from_secs(3600)) {
        return Err(AppError::too_many("you've sent a lot of reports. wait an hour and try again."));
    }
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

    let duplicate: bool = sqlx::query_scalar(
        "select exists(select 1 from reports where visitor = $1 and mod_id = $2 and reason = $3 and created_at > now() - interval '1 day')",
    )
    .bind(&visitor.id)
    .bind(mod_id)
    .bind(&input.reason)
    .fetch_one(&state.db)
    .await?;

    let poster_id = if input.key.trim().is_empty() {
        None
    } else {
        crate::routes::forum::poster_for(&state, input.key.trim(), &visitor, true).await.ok().map(|p| p.id)
    };
    if !duplicate {
        sqlx::query("insert into reports (id, mod_id, mod_name, reason, details, contact, visitor, poster_id) values ($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(Uuid::new_v4())
            .bind(mod_id)
            .bind(&mod_name)
            .bind(&input.reason)
            .bind(&details)
            .bind(&contact)
            .bind(&visitor.id)
            .bind(poster_id)
            .execute(&state.db)
            .await?;
        tracing::info!(reason = %input.reason, "new report received");
    }

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

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

pub(crate) const AI_CALLS_KEY: &str = "__ai_calls__";
const CACHE_VERSION: &str = "v4";

pub(crate) async fn usage_today(state: &AppState, visitor: &str) -> Result<i32, sqlx::Error> {
    let used: Option<i32> = sqlx::query_scalar("select count from ai_usage where visitor = $1 and day = current_date")
        .bind(visitor)
        .fetch_optional(&state.db)
        .await?;
    Ok(used.unwrap_or(0))
}

pub(crate) async fn bump_usage(state: &AppState, visitor: &str) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "insert into ai_usage (visitor, day, count) values ($1, current_date, 1)
         on conflict (visitor, day) do update set count = ai_usage.count + 1
         returning count",
    )
    .bind(visitor)
    .fetch_one(&state.db)
    .await
}

pub(crate) async fn take_ai_budget(state: &AppState) -> ApiResult<bool> {
    if state.config.ai_api_key.is_none() || usage_today(state, AI_CALLS_KEY).await? >= state.config.ai_daily_global {
        return Ok(false);
    }
    bump_usage(state, AI_CALLS_KEY).await?;
    Ok(true)
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

pub async fn check_mod(State(state): State<AppState>, visitor: Visitor, headers: axum::http::HeaderMap, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    let allow_ai = !crate::util::ai_opted_out(&headers);
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

    let report = tokio::task::spawn_blocking(move || crate::scan::scan(&name, &data))
        .await
        .map_err(AppError::internal)?
        .map_err(|message| AppError::field("file", &message))?;

    let used = bump_usage(&state, &visitor.id).await?;

    let cache_key = format!("{CACHE_VERSION}:{}", report.sha256);
    let cached: Option<Value> = if allow_ai {
        sqlx::query_scalar("select result from ai_results where sha256 = $1 and created_at > now() - interval '30 days'")
            .bind(&cache_key)
            .fetch_optional(&state.db)
            .await?
    } else {
        None
    };

    let (verdict, from_cache) = match cached {
        Some(value) => (value, true),
        None => {
            let ai_allowed = allow_ai && state.config.ai_api_key.is_some() && usage_today(&state, AI_CALLS_KEY).await? < state.config.ai_daily_global;
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
                    let score = report.final_score(v.score);
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
                        "score": report.basic_score(),
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

const UPLOADS_PER_DAY: i64 = 10;

fn first_sentence(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let end = line.find(". ").map(|i| i + 1).unwrap_or(line.len());
    let sentence: String = line[..end].chars().take(200).collect();
    sentence.trim().to_string()
}

pub(crate) fn parse_tags(raw: &str) -> Result<Vec<String>, &'static str> {
    let mut tags: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let tag: String = part.trim().to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
        let tag = tag.split_whitespace().collect::<Vec<_>>().join(" ");
        if tag.is_empty() || tags.contains(&tag) {
            continue;
        }
        if tag.chars().count() < 2 || tag.chars().count() > 24 {
            return Err("each tag should be 2 to 24 characters");
        }
        tags.push(tag);
    }
    if tags.len() > 5 {
        return Err("add up to 5 tags");
    }
    Ok(tags)
}

fn upload_insights(report: &crate::scan::ScanReport, score: u8, verdict: Option<&crate::ai::AiVerdict>, tags_by_ai: bool, category_by_ai: bool) -> Value {
    let insights = verdict.and_then(|v| v.insights.as_ref());
    let requirements: Vec<String> = match insights {
        Some(i) if !i.requirements.is_empty() => i.requirements.clone(),
        _ => report.mod_markers.iter().map(|m| m.to_string()).collect(),
    };
    json!({
        "overview": insights.map(|i| i.overview.clone()).filter(|o| !o.is_empty()),
        "highlights": insights.map(|i| i.highlights.clone()).unwrap_or_default(),
        "requirements": requirements,
        "ban_risk": insights.map(|i| i.ban_risk.clone()),
        "ban_risk_reason": insights.map(|i| i.ban_risk_reason.clone()).filter(|r| !r.is_empty()),
        "description_match": insights.map(|i| i.description_match.clone()),
        "tags_by_ai": tags_by_ai,
        "category_by_ai": category_by_ai,
        "risk": {
            "score": score,
            "label": verdict_label(score),
            "summary": verdict.map(|v| v.summary.clone()).filter(|s| !s.is_empty()),
            "what_it_does": verdict.map(|v| v.what_it_does.clone()).filter(|s| !s.is_empty()),
            "confidence": verdict.map(|v| v.confidence.clone()),
            "capabilities": verdict.map(|v| v.capabilities.clone()).unwrap_or_default(),
            "source": if verdict.is_some() { "ai" } else { "basic" },
        },
        "checked_at": Utc::now(),
    })
}

pub(crate) struct NewUpload {
    pub uploader: String,
    pub file_name: String,
    pub data: Vec<u8>,
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub category_id: Option<Uuid>,
    pub tags: Vec<String>,
    pub source_url: Option<String>,
    pub thumbnail: Option<crate::uploads::ProcessedImage>,
    pub poster_id: Option<Uuid>,
    pub via: &'static str,
    pub allow_ai: bool,
}

pub(crate) struct Published {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub score: u8,
    pub tags: Vec<String>,
    pub tags_by_ai: bool,
    pub category: Option<String>,
    pub written_by_ai: bool,
    pub overview: Value,
    pub reward: (i32, &'static str, i64),
}

pub(crate) async fn uploads_today(state: &AppState, uploader: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("select count(*) from mods where uploader = $1 and created_at > now() - interval '1 day'")
        .bind(uploader)
        .fetch_one(&state.db)
        .await
}

fn fallback_description(insights: &crate::ai::UploadInsights) -> String {
    let mut text = insights.overview.clone();
    if !insights.highlights.is_empty() {
        text.push_str("\n\n**Features**\n");
        for h in &insights.highlights {
            text.push_str(&format!("- {h}\n"));
        }
    }
    text.trim().to_string()
}

fn name_from_file(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(file_name);
    let stem = stem
        .split(|c: char| c == '_' || c == '-' || c == ' ')
        .filter(|p| !p.is_empty())
        .take_while(|p| !p.trim_start_matches(|c: char| c == 'v' || c == 'V').starts_with(|c: char| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::new();
    let chars: Vec<char> = stem.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
            out.push(' ');
        }
        out.push(*c);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect()
}

pub(crate) async fn publish_upload(state: &AppState, upload: NewUpload) -> ApiResult<Published> {
    let NewUpload { uploader, file_name, data, mut name, mut description, author, version, category_id, tags: user_tags, source_url, thumbnail, poster_id, via, allow_ai } = upload;
    let (checked, report, data) = tokio::task::spawn_blocking(move || {
        let checked = crate::uploads::check_mod_file(&file_name, &data)?;
        let report = crate::scan::scan(&file_name, &data)?;
        Ok::<_, String>((checked, report, data))
    })
    .await
    .map_err(AppError::internal)?
    .map_err(|message| AppError::field("file", &message))?;

    let write_listing = name.trim().is_empty() || description.trim().chars().count() < 30;
    if write_listing && !allow_ai {
        return Err(AppError::field("file", "you turned off Branch AI in Settings, so it can't write the name and description for you. use the advanced upload and write them yourself."));
    }
    let mut score = report.basic_score();
    let mut ai_used = false;
    let mut verdict: Option<crate::ai::AiVerdict> = None;
    if allow_ai && state.config.ai_api_key.is_some() && usage_today(state, AI_CALLS_KEY).await? < state.config.ai_daily_global {
        bump_usage(state, AI_CALLS_KEY).await?;
        let existing_tags: Vec<String> = sqlx::query_scalar("select name from tags order by name limit 200").fetch_all(&state.db).await?;
        let categories: Vec<String> = sqlx::query_scalar("select slug from categories order by sort_order, name").fetch_all(&state.db).await?;
        let claim = crate::ai::Claim { name: &name, description: &description, existing_tags: &existing_tags, categories: &categories, write_listing };
        match crate::ai::ask(&state.http, &state.config, &report, Some(&claim)).await {
            Ok(v) => {
                score = report.final_score(v.score);
                ai_used = true;
                verdict = Some(v);
            }
            Err(err) => tracing::warn!(error = %err, "ai check failed during an upload, using the basic scan"),
        }
    }
    if score >= 85 && report.has_strong_signals() {
        tracing::warn!(score, via, "community upload refused by the safety check");
        return Err(AppError::field(
            "file",
            "Branch's automatic safety check flagged this file as likely harmful, so it wasn't published. if you think this is a mistake, email drifted1000@outlook.com.",
        ));
    }

    let insights = verdict.as_ref().and_then(|v| v.insights.clone());
    let mut written_by_ai = false;
    if write_listing {
        let Some(found) = insights.as_ref() else {
            return Err(AppError::field(
                "file",
                "Branch's AI isn't available right now, so it can't write the name and description for you. try again later, or use the advanced upload and write them yourself.",
            ));
        };
        if name.trim().is_empty() {
            name = if found.suggested_name.chars().count() >= 2 { found.suggested_name.clone() } else { name_from_file(&checked.name) };
            written_by_ai = true;
        }
        if description.trim().chars().count() < 30 {
            let written = if found.suggested_description.chars().count() >= 30 { found.suggested_description.clone() } else { fallback_description(found) };
            if written.chars().count() < 30 {
                return Err(AppError::field("file", "Branch's AI couldn't tell enough about this file to describe it. use the advanced upload and write the description yourself."));
            }
            description = written;
            written_by_ai = true;
        }
    }
    let name: String = name.trim().chars().take(80).collect();
    if name.chars().count() < 2 {
        return Err(AppError::field("name", "give your mod a name"));
    }

    let fingerprint = report.fingerprint();
    let uniqueness = crate::routes::rewards::check_upload_unique(state, &checked.sha256, &name, &description, &fingerprint, allow_ai).await?;
    if !uniqueness.unique {
        return Err(AppError::field("file", &uniqueness.message));
    }

    let display_author = if author.trim().is_empty() { "Anonymous".to_string() } else { author.trim().to_string() };
    let version = if !version.is_empty() {
        version
    } else {
        crate::routes::admin::version_from_file(&checked.name).unwrap_or_else(|| "unversioned".into())
    };
    let mut category_by_ai: Option<String> = None;
    let category_id = match (category_id, insights.as_ref().and_then(|i| i.category.as_deref())) {
        (Some(id), _) => Some(id),
        (None, Some(slug)) => {
            let found: Option<(Uuid, String)> = sqlx::query_as("select id, name from categories where slug = $1").bind(slug).fetch_optional(&state.db).await?;
            found.map(|(id, cat_name)| {
                category_by_ai = Some(cat_name);
                id
            })
        }
        (None, None) => None,
    };
    let category_name: Option<String> = match (&category_by_ai, category_id) {
        (Some(n), _) => Some(n.clone()),
        (None, Some(id)) => sqlx::query_scalar("select name from categories where id = $1").bind(id).fetch_optional(&state.db).await?,
        _ => None,
    };
    let tags_by_ai = user_tags.is_empty() && insights.as_ref().is_some_and(|i| !i.tags.is_empty());
    let tags = if user_tags.is_empty() { insights.as_ref().map(|i| i.tags.clone()).unwrap_or_default() } else { user_tags };
    let mut ai_insights = upload_insights(&report, score, verdict.as_ref(), tags_by_ai, category_by_ai.is_some());
    ai_insights["listing_by_ai"] = json!(written_by_ai);
    ai_insights["uploaded_via"] = json!(via);

    let mod_id = crate::routes::admin::insert_draft(&state.db, &name, &display_author, source_url, None).await?;
    let info = json!({
        "file_name": checked.name,
        "scan_score": score,
        "ai_used": ai_used,
        "via": via,
        "signals": report.indicators.iter().map(|i| i.label).collect::<Vec<_>>(),
        "mod_markers": report.mod_markers,
    });
    let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
    if let Err(err) = crate::storage::put(state.store.as_ref(), &key, data).await {
        let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
        return Err(err.into());
    }
    let thumbnail_key = match thumbnail {
        Some(image) => {
            let image_key = format!("images/{}.{}", Uuid::new_v4(), image.ext);
            if let Err(err) = crate::storage::put(state.store.as_ref(), &image_key, image.bytes).await {
                crate::storage::delete_quietly(state.store.as_ref(), &key).await;
                let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
                return Err(err.into());
            }
            Some(image_key)
        }
        None => None,
    };

    let saved: Result<String, sqlx::Error> = async {
        let slug: String = sqlx::query_scalar(
            "update mods set summary = $1, description = $2, category_id = $3, status = 'published', published_at = now(),
                source = 'community', uploader = $4, redistribution = 'allowed',
                redistribution_note = 'the uploader confirmed that they made this mod or have permission to share it.',
                import_info = $5, code_fingerprint = $7, unique_status = 'unique', uploader_poster = $8, thumbnail_key = $9,
                ai_insights = $10
             where id = $6 returning slug",
        )
        .bind(first_sentence(&description))
        .bind(&description)
        .bind(category_id)
        .bind(&uploader)
        .bind(&info)
        .bind(mod_id)
        .bind(&fingerprint)
        .bind(poster_id)
        .bind(&thumbnail_key)
        .bind(&ai_insights)
        .fetch_one(&state.db)
        .await?;
        if !tags.is_empty() {
            let mut conn = state.db.acquire().await?;
            crate::routes::admin::set_tags(&mut conn, mod_id, &tags).await?;
        }
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
            tracing::info!(via, "new community upload");
            let reward = match poster_id {
                Some(pid) => {
                    let (earned, reason) = crate::routes::rewards::award_for_upload(state, pid, mod_id, &name).await.unwrap_or((0, "couldn't add the reward"));
                    let uploads = crate::routes::rewards::unique_upload_count(state, pid).await.unwrap_or(0);
                    (earned, reason, uploads)
                }
                None => (0, "no community identity", 0),
            };
            Ok(Published {
                slug,
                name,
                description,
                score,
                tags,
                tags_by_ai,
                category: category_name,
                written_by_ai,
                overview: ai_insights["overview"].clone(),
                reward,
            })
        }
        Err(err) => {
            crate::storage::delete_quietly(state.store.as_ref(), &key).await;
            if let Some(image_key) = &thumbnail_key {
                crate::storage::delete_quietly(state.store.as_ref(), image_key).await;
            }
            let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
            Err(err.into())
        }
    }
}

pub async fn create_submission(State(state): State<AppState>, visitor: Visitor, headers: axum::http::HeaderMap, mut multipart: Multipart) -> ApiResult<(StatusCode, Json<Value>)> {
    let allow_ai = !crate::util::ai_opted_out(&headers);
    if !state.limiter.check(&format!("submit:{}", visitor.id), 20, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little. try again in a few minutes."));
    }
    if uploads_today(&state, &visitor.id).await? >= UPLOADS_PER_DAY {
        return Err(AppError::too_many(format!("you can upload up to {UPLOADS_PER_DAY} mods a day. try again tomorrow.")));
    }

    let mut file: Option<(String, bytes::Bytes)> = None;
    let mut thumbnail: Option<bytes::Bytes> = None;
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is bigger than 50 MB")),
        };
        let name = field.name().unwrap_or("").to_string();
        if name == "thumbnail" {
            let data = field.bytes().await.map_err(|_| AppError::field("thumbnail", "the thumbnail is too big or the upload was cut off"))?;
            if data.len() > crate::uploads::MAX_IMAGE_BYTES {
                return Err(AppError::field("thumbnail", "thumbnails can be up to 8 MB"));
            }
            if !data.is_empty() {
                thumbnail = Some(data);
            }
        } else if name == "file" {
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

    if !get("website").is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }

    let easy = get("mode") == "easy";
    let name = get("name");
    let description = get("description");
    let anonymous = get("anonymous") == "true";
    let author = if anonymous { String::new() } else { get("author") };
    let version = get("version");
    let category = get("category");
    let user_tags = parse_tags(&get("tags"));

    let mut errors = FieldErrors::default();
    errors.check(user_tags.is_ok(), "tags", user_tags.as_ref().err().copied().unwrap_or(""));
    let user_tags = user_tags.unwrap_or_default();
    if !easy {
        errors.check(name.chars().count() >= 2, "name", "give your mod a name");
        errors.check(description.chars().count() >= 30, "description", "describe what your mod does (at least 30 characters)");
    }
    errors.check(!too_long(&name, 80), "name", "keep the name under 80 characters");
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

    let thumbnail = match thumbnail {
        Some(data) => Some(
            tokio::task::spawn_blocking(move || crate::uploads::process_image(&data, crate::uploads::ImageKind::Thumbnail))
                .await
                .map_err(AppError::internal)?
                .map_err(|message| AppError::field("thumbnail", &message))?,
        ),
        None => None,
    };
    let community_key = get("key");
    let poster_id = if community_key.is_empty() {
        None
    } else {
        crate::routes::forum::poster_for(&state, &community_key, &visitor, true).await.ok().map(|p| p.id)
    };
    let (file_name, data) = file.expect("checked above");
    let published = publish_upload(
        &state,
        NewUpload {
            uploader: visitor.id.clone(),
            file_name,
            data: data.to_vec(),
            name,
            description,
            author,
            version,
            category_id,
            tags: user_tags,
            source_url,
            thumbnail,
            poster_id,
            via: if easy { "app-easy" } else { "app" },
            allow_ai,
        },
    )
    .await?;
    let (earned, reason, uploads) = published.reward;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "slug": published.slug,
            "name": published.name,
            "reward": { "earned": earned, "reason": reason, "uploads": uploads, "threshold": crate::routes::rewards::THRESHOLD },
            "ai": {
                "overview": published.overview,
                "tags": if published.tags_by_ai { json!(published.tags) } else { json!([]) },
                "category": published.category,
                "risk_score": published.score,
                "wrote_listing": published.written_by_ai,
                "description": if published.written_by_ai { json!(published.description) } else { Value::Null },
            },
        })),
    ))
}
#[cfg(test)]
mod tests {
    use super::{image_key_type, name_from_file, parse_tags};

    #[test]
    fn names_come_from_file_names() {
        assert_eq!(name_from_file("LongArms_v1.2.dll"), "Long Arms");
        assert_eq!(name_from_file("gorilla-hats-2.0.zip"), "gorilla hats");
        assert_eq!(name_from_file("SpeedReadout.dll"), "Speed Readout");
    }

    #[test]
    fn tags_are_cleaned_and_limited() {
        assert_eq!(parse_tags(" Hats, cosmetics ,hats,, Fun!  Stuff ").unwrap(), vec!["hats", "cosmetics", "fun stuff"]);
        assert!(parse_tags("").unwrap().is_empty());
        assert!(parse_tags("a").is_err());
        assert!(parse_tags("one, two, three, four, five, six").is_err());
    }

    #[test]
    fn only_branch_image_keys_are_served() {
        assert_eq!(image_key_type("images/2f1b0c1e-6a5e-4d0b-9a57-3f8a3f0c9d11.jpg"), Some("image/jpeg"));
        assert_eq!(image_key_type("files/2f1b0c1e-6a5e-4d0b-9a57-3f8a3f0c9d11/x.dll"), None);
        assert_eq!(image_key_type("images/../files/x.jpg"), None);
        assert_eq!(image_key_type("images/abc.exe"), None);
    }
}
