use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use bytes::Bytes;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::PgArguments;
use sqlx::query::Query as SqlQuery;
use sqlx::{FromRow, PgConnection, PgPool, Postgres};
use uuid::Uuid;

use crate::auth::{
    audit, clear_session_cookie, hash_password_async, new_session_token, password_problem, require_admin_header,
    session_cookie, verify_password_async, Admin, AdminUser, AnyAdmin, SESSION_HOURS,
};
use crate::error::{ApiResult, AppError, FieldErrors};
use crate::models::{
    load_detail, Lookup, ModDetail, ReleaseOut, ReleaseRow, COMPATIBILITY, MOD_STATUSES, PLATFORMS, RELEASE_SELECT,
    REDISTRIBUTION, REPORT_REASONS,
};
use crate::state::AppState;
use crate::storage;
use crate::uploads::{check_mod_file, process_image, ImageKind, MAX_IMAGE_BYTES, MAX_MOD_FILE_BYTES};
use crate::util::{clean_url, slugify, too_long, valid_slug, Visitor};

const MAX_SCREENSHOTS: i64 = 12;
const MAX_IMPORT_BYTES: usize = 150 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    let image_limit = DefaultBodyLimit::max(MAX_IMAGE_BYTES + 64 * 1024);
    let file_limit = DefaultBodyLimit::max(MAX_MOD_FILE_BYTES + 64 * 1024);

    Router::new()
        .route("/api/admin/login", post(login))
        .route("/api/admin/logout", post(logout))
        .route("/api/admin/me", get(me))
        .route("/api/admin/password", post(change_password))
        .route("/api/admin/overview", get(overview))
        .route("/api/admin/mods", get(list_mods).post(create_mod))
        .route("/api/admin/mods/{id}", get(get_mod).put(update_mod).delete(delete_mod))
        .route("/api/admin/mods/{id}/status", post(set_status))
        .route("/api/admin/mods/{id}/featured", post(set_featured))
        .route("/api/admin/mods/{id}/thumbnail", post(upload_thumbnail).delete(remove_thumbnail).layer(image_limit.clone()))
        .route("/api/admin/mods/{id}/screenshots", post(add_screenshot).layer(image_limit))
        .route("/api/admin/screenshots/{id}", put(update_screenshot).delete(delete_screenshot))
        .route("/api/admin/mods/{id}/releases", post(create_release))
        .route("/api/admin/releases/{id}", put(update_release).delete(delete_release))
        .route("/api/admin/releases/{id}/file", post(upload_release_file).delete(remove_release_file).layer(file_limit))
        .route("/api/admin/releases/{id}/availability", post(set_release_availability))
        .route("/api/admin/categories", get(list_categories).post(create_category))
        .route("/api/admin/categories/{id}", put(update_category).delete(delete_category))
        .route("/api/admin/tags", get(list_tags))
        .route("/api/admin/tags/{id}", put(rename_tag).delete(delete_tag))
        .route("/api/admin/reports", get(list_reports))
        .route("/api/admin/reports/{id}", put(update_report).delete(delete_report))
        .route("/api/admin/audit", get(list_audit))
        .route("/api/admin/requests", get(list_requests))
        .route("/api/admin/requests/{id}", put(update_request).delete(delete_request))
        .route("/api/admin/requests/{id}/draft", post(request_to_draft))
        .route("/api/admin/import", post(import_mods).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES + 64 * 1024)))
}

fn ok() -> Json<Value> {
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct LoginInput {
    username: String,
    password: String,
}

fn wrong_login() -> AppError {
    AppError::new(StatusCode::UNAUTHORIZED, "wrong_login", "wrong username or password")
}

async fn login(State(state): State<AppState>, visitor: Visitor, headers: HeaderMap, Json(input): Json<LoginInput>) -> ApiResult<Response> {
    require_admin_header(&headers)?;
    if !state.limiter.check(&format!("login:{}", visitor.id), 10, Duration::from_secs(15 * 60)) {
        return Err(AppError::too_many("too many login attempts. wait 15 minutes and try again."));
    }
    let username = input.username.trim().to_lowercase();
    if username.is_empty() || username.len() > 64 || input.password.is_empty() || input.password.len() > 256 {
        return Err(wrong_login());
    }

    let row: Option<(Uuid, String, String, bool, Option<DateTime<Utc>>)> =
        sqlx::query_as("select id, username, password_hash, must_change_password, locked_until from admins where username = $1")
            .bind(&username)
            .fetch_optional(&state.db)
            .await?;

    let Some((id, username, hash, must_change, locked_until)) = row else {
        let _ = verify_password_async(input.password, state.dummy_hash.to_string()).await;
        return Err(wrong_login());
    };

    if locked_until.is_some_and(|t| t > Utc::now()) {
        return Err(AppError::too_many("this account is locked for a few minutes because of failed logins"));
    }

    if !verify_password_async(input.password, hash).await {
        sqlx::query(
            "update admins set
                failed_logins = case when failed_logins + 1 >= 8 then 0 else failed_logins + 1 end,
                locked_until = case when failed_logins + 1 >= 8 then now() + interval '15 minutes' else locked_until end
             where id = $1",
        )
        .bind(id)
        .execute(&state.db)
        .await?;
        tracing::warn!(username = %username, "failed admin login");
        return Err(wrong_login());
    }

    sqlx::query("update admins set failed_logins = 0, locked_until = null where id = $1").bind(id).execute(&state.db).await?;
    sqlx::query("delete from admin_sessions where admin_id = $1 and expires_at < now()").bind(id).execute(&state.db).await?;

    let (token, token_hash) = new_session_token();
    sqlx::query("insert into admin_sessions (token_hash, admin_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))")
        .bind(&token_hash)
        .bind(id)
        .bind(SESSION_HOURS as i32)
        .execute(&state.db)
        .await?;

    let user = AdminUser { id, username: username.clone(), must_change_password: must_change, token_hash };
    audit(&state.db, &user, "login", "", "").await;

    Ok((
        [(header::SET_COOKIE, session_cookie(&token, state.config.cookie_secure))],
        Json(json!({ "username": username, "must_change_password": must_change })),
    )
        .into_response())
}

async fn logout(State(state): State<AppState>, AnyAdmin(user): AnyAdmin) -> ApiResult<Response> {
    sqlx::query("delete from admin_sessions where token_hash = $1").bind(&user.token_hash).execute(&state.db).await?;
    audit(&state.db, &user, "logout", "", "").await;
    Ok(([(header::SET_COOKIE, clear_session_cookie(state.config.cookie_secure))], ok()).into_response())
}

async fn me(AnyAdmin(user): AnyAdmin) -> Json<Value> {
    Json(json!({ "username": user.username, "must_change_password": user.must_change_password }))
}

#[derive(Deserialize)]
struct PasswordInput {
    current_password: String,
    new_password: String,
}

async fn change_password(State(state): State<AppState>, AnyAdmin(user): AnyAdmin, Json(input): Json<PasswordInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("password:{}", user.id), 10, Duration::from_secs(15 * 60)) {
        return Err(AppError::too_many("too many attempts. wait a few minutes."));
    }
    let hash: String = sqlx::query_scalar("select password_hash from admins where id = $1").bind(user.id).fetch_one(&state.db).await?;
    if !verify_password_async(input.current_password.clone(), hash).await {
        return Err(AppError::field("current_password", "that isn't your current password"));
    }
    if let Some(problem) = password_problem(&input.new_password, &user.username) {
        return Err(AppError::field("new_password", problem));
    }
    if input.new_password == input.current_password {
        return Err(AppError::field("new_password", "pick a password that's different from the current one"));
    }
    let new_hash = hash_password_async(input.new_password).await?;
    sqlx::query("update admins set password_hash = $1, must_change_password = false, password_changed_at = now() where id = $2")
        .bind(new_hash)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    sqlx::query("delete from admin_sessions where admin_id = $1 and token_hash <> $2")
        .bind(user.id)
        .bind(&user.token_hash)
        .execute(&state.db)
        .await?;
    audit(&state.db, &user, "change_password", "", "").await;
    Ok(ok())
}

async fn overview(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let (published, drafts, hidden): (i64, i64, i64) = sqlx::query_as(
        "select count(*) filter (where status = 'published'),
                count(*) filter (where status = 'draft'),
                count(*) filter (where status in ('unpublished', 'archived'))
         from mods",
    )
    .fetch_one(&state.db)
    .await?;
    let open_reports: i64 = sqlx::query_scalar("select count(*) from reports where status = 'open'").fetch_one(&state.db).await?;
    let open_requests: i64 = sqlx::query_scalar("select count(*) from mod_requests where status = 'open'").fetch_one(&state.db).await?;
    let open_forum_reports: i64 = sqlx::query_scalar("select count(*) from forum_reports where status = 'open'").fetch_one(&state.db).await?;
    let pending_rewards: i64 = sqlx::query_scalar("select count(*) from reward_members where status = 'pending'").fetch_one(&state.db).await?;
    Ok(Json(json!({
        "open_requests": open_requests,
        "open_forum_reports": open_forum_reports,
        "pending_rewards": pending_rewards,
        "published": published,
        "drafts": drafts,
        "hidden": hidden,
        "open_reports": open_reports,
        "compatibility": COMPATIBILITY.iter().map(|(k, l, d)| json!({ "key": k, "label": l, "description": d })).collect::<Vec<_>>(),
        "platforms": PLATFORMS.iter().map(|(k, l)| json!({ "key": k, "label": l })).collect::<Vec<_>>(),
        "report_reasons": REPORT_REASONS.iter().map(|(k, l)| json!({ "key": k, "label": l })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct AdminListQuery {
    q: Option<String>,
    status: Option<String>,
    imported: Option<bool>,
    source: Option<String>,
}

#[derive(FromRow, Serialize)]
struct AdminModRow {
    id: Uuid,
    slug: String,
    name: String,
    author_name: String,
    status: String,
    featured: bool,
    compatibility: String,
    category_name: Option<String>,
    release_count: i64,
    open_reports: i64,
    updated_at: DateTime<Utc>,
    imported_at: Option<DateTime<Utc>>,
    import_info: Option<Value>,
    source: String,
}

async fn list_mods(State(state): State<AppState>, Admin(_): Admin, Query(query): Query<AdminListQuery>) -> ApiResult<Json<Value>> {
    let q = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(crate::util::like_pattern);
    let status = query.status.filter(|s| MOD_STATUSES.contains(&s.as_str()));
    let rows: Vec<AdminModRow> = sqlx::query_as(
        "select m.id, m.slug, m.name, m.author_name, m.status, m.featured, m.compatibility, c.name as category_name,
                (select count(*) from releases r where r.mod_id = m.id) as release_count,
                (select count(*) from reports p where p.mod_id = m.id and p.status = 'open') as open_reports,
                m.updated_at, m.imported_at, m.import_info, m.source
         from mods m left join categories c on c.id = m.category_id
         where ($1::text is null or m.name ilike $1 or m.author_name ilike $1 or m.slug ilike $1)
           and ($2::text is null or m.status = $2)
           and ($3::bool is null or (m.imported_at is not null) = $3)
           and ($4::text is null or m.source = $4)
         order by m.updated_at desc
         limit 500",
    )
    .bind(q)
    .bind(status)
    .bind(query.imported)
    .bind(query.source.filter(|s| s == "admin" || s == "community"))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DependencyInput {
    name: String,
    url: String,
    required: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ModInput {
    name: String,
    slug: String,
    summary: String,
    description: String,
    author_name: String,
    author_url: String,
    category_id: Option<Uuid>,
    tags: Vec<String>,
    compatibility: String,
    compatibility_note: String,
    compatibility_checked_on: Option<NaiveDate>,
    game_versions: String,
    platforms: Vec<String>,
    mod_loader: String,
    dependencies: Vec<DependencyInput>,
    install_instructions: String,
    known_issues: String,
    source_url: String,
    project_url: String,
    license_name: String,
    license_url: String,
    redistribution: String,
    redistribution_note: String,
}

struct CleanMod {
    slug: String,
    name: String,
    summary: String,
    description: String,
    author_name: String,
    author_url: Option<String>,
    category_id: Option<Uuid>,
    tags: Vec<String>,
    compatibility: String,
    compatibility_note: String,
    compatibility_checked_on: Option<NaiveDate>,
    game_versions: String,
    platforms: Vec<String>,
    mod_loader: String,
    dependencies: Value,
    install_instructions: String,
    known_issues: String,
    source_url: Option<String>,
    project_url: Option<String>,
    license_name: String,
    license_url: Option<String>,
    redistribution: String,
    redistribution_note: String,
}

fn url_field(errors: &mut FieldErrors, field: &str, raw: &str) -> Option<String> {
    match clean_url(raw) {
        Ok(url) => url,
        Err(message) => {
            errors.add(field, message);
            None
        }
    }
}

fn text_field(errors: &mut FieldErrors, field: &str, raw: &str, max: usize) -> String {
    let value = raw.trim().to_string();
    if too_long(&value, max) {
        errors.add(field, &format!("keep this under {max} characters"));
    }
    value
}

fn clean_mod(input: ModInput) -> ApiResult<CleanMod> {
    let mut e = FieldErrors::default();

    let name = text_field(&mut e, "name", &input.name, 80);
    e.check(!name.is_empty(), "name", "give the mod a name");

    let slug = if input.slug.trim().is_empty() { slugify(&name) } else { input.slug.trim().to_lowercase() };
    e.check(valid_slug(&slug), "slug", "use lowercase letters, numbers and dashes only");

    let summary = text_field(&mut e, "summary", &input.summary, 200);
    let description = text_field(&mut e, "description", &input.description, 20_000);
    let author_name = text_field(&mut e, "author_name", &input.author_name, 80);
    let author_url = url_field(&mut e, "author_url", &input.author_url);

    let mut tags: Vec<String> = Vec::new();
    for tag in &input.tags {
        let tag = tag.trim();
        if tag.is_empty() || tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            continue;
        }
        if too_long(tag, 32) || slugify(tag).is_empty() {
            e.add("tags", "tags have to be short words (up to 32 characters)");
            continue;
        }
        tags.push(tag.to_string());
    }
    e.check(tags.len() <= 15, "tags", "use 15 tags or fewer");

    let compatibility = if input.compatibility.is_empty() { "unconfirmed".to_string() } else { input.compatibility.clone() };
    e.check(COMPATIBILITY.iter().any(|(k, _, _)| *k == compatibility), "compatibility", "pick a compatibility status");
    let compatibility_note = text_field(&mut e, "compatibility_note", &input.compatibility_note, 500);
    let game_versions = text_field(&mut e, "game_versions", &input.game_versions, 120);

    let mut platforms = Vec::new();
    for p in &input.platforms {
        if PLATFORMS.iter().any(|(k, _)| k == p) {
            if !platforms.contains(p) {
                platforms.push(p.clone());
            }
        } else {
            e.add("platforms", "unknown platform");
        }
    }

    let mod_loader = text_field(&mut e, "mod_loader", &input.mod_loader, 80);

    let mut dependencies = Vec::new();
    for dep in &input.dependencies {
        let name = dep.name.trim();
        if name.is_empty() && dep.url.trim().is_empty() {
            continue;
        }
        if name.is_empty() || too_long(name, 80) {
            e.add("dependencies", "each requirement needs a name (up to 80 characters)");
            continue;
        }
        let url = url_field(&mut e, "dependencies", &dep.url);
        dependencies.push(json!({ "name": name, "url": url, "required": dep.required }));
    }
    e.check(dependencies.len() <= 20, "dependencies", "use 20 requirements or fewer");

    let install_instructions = text_field(&mut e, "install_instructions", &input.install_instructions, 10_000);
    let known_issues = text_field(&mut e, "known_issues", &input.known_issues, 10_000);
    let source_url = url_field(&mut e, "source_url", &input.source_url);
    let project_url = url_field(&mut e, "project_url", &input.project_url);
    let license_name = text_field(&mut e, "license_name", &input.license_name, 80);
    let license_url = url_field(&mut e, "license_url", &input.license_url);

    let redistribution = if input.redistribution.is_empty() { "unknown".to_string() } else { input.redistribution.clone() };
    e.check(REDISTRIBUTION.contains(&redistribution.as_str()), "redistribution", "pick a redistribution option");
    let redistribution_note = text_field(&mut e, "redistribution_note", &input.redistribution_note, 500);

    e.finish()?;

    Ok(CleanMod {
        slug,
        name,
        summary,
        description,
        author_name,
        author_url,
        category_id: input.category_id,
        tags,
        compatibility,
        compatibility_note,
        compatibility_checked_on: input.compatibility_checked_on,
        game_versions,
        platforms,
        mod_loader,
        dependencies: Value::Array(dependencies),
        install_instructions,
        known_issues,
        source_url,
        project_url,
        license_name,
        license_url,
        redistribution,
        redistribution_note,
    })
}

const MOD_COLUMNS: &str = "slug, name, summary, description, author_name, author_url, category_id, compatibility,
    compatibility_note, compatibility_checked_on, game_versions, platforms, mod_loader, dependencies,
    install_instructions, known_issues, source_url, project_url, license_name, license_url, redistribution,
    redistribution_note";

fn bind_mod<'q>(query: SqlQuery<'q, Postgres, PgArguments>, m: &CleanMod) -> SqlQuery<'q, Postgres, PgArguments> {
    query
        .bind(m.slug.clone())
        .bind(m.name.clone())
        .bind(m.summary.clone())
        .bind(m.description.clone())
        .bind(m.author_name.clone())
        .bind(m.author_url.clone())
        .bind(m.category_id)
        .bind(m.compatibility.clone())
        .bind(m.compatibility_note.clone())
        .bind(m.compatibility_checked_on)
        .bind(m.game_versions.clone())
        .bind(m.platforms.clone())
        .bind(m.mod_loader.clone())
        .bind(m.dependencies.clone())
        .bind(m.install_instructions.clone())
        .bind(m.known_issues.clone())
        .bind(m.source_url.clone())
        .bind(m.project_url.clone())
        .bind(m.license_name.clone())
        .bind(m.license_url.clone())
        .bind(m.redistribution.clone())
        .bind(m.redistribution_note.clone())
}

fn placeholders(from: usize, count: usize) -> String {
    (from..from + count).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ")
}

fn slug_taken(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.is_unique_violation())
}

pub(crate) async fn set_tags(conn: &mut PgConnection, mod_id: Uuid, tags: &[String]) -> Result<(), sqlx::Error> {
    sqlx::query("delete from mod_tags where mod_id = $1").bind(mod_id).execute(&mut *conn).await?;
    for tag in tags {
        let slug = slugify(tag);
        let tag_id: Uuid = sqlx::query_scalar(
            "insert into tags (id, slug, name) values ($1, $2, $3)
             on conflict (slug) do update set slug = excluded.slug
             returning id",
        )
        .bind(Uuid::new_v4())
        .bind(&slug)
        .bind(tag)
        .fetch_one(&mut *conn)
        .await?;
        sqlx::query("insert into mod_tags (mod_id, tag_id) values ($1, $2) on conflict do nothing")
            .bind(mod_id)
            .bind(tag_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

async fn ensure_category(db: &PgPool, id: Option<Uuid>) -> ApiResult<()> {
    if let Some(id) = id {
        let exists: bool = sqlx::query_scalar("select exists(select 1 from categories where id = $1)").bind(id).fetch_one(db).await?;
        if !exists {
            return Err(AppError::field("category_id", "that category doesn't exist anymore"));
        }
    }
    Ok(())
}

async fn admin_detail(db: &PgPool, id: Uuid) -> ApiResult<ModDetail> {
    load_detail(db, Lookup::Id(id)).await?.ok_or_else(|| AppError::not_found("that mod doesn't exist"))
}

async fn get_mod(State(state): State<AppState>, Admin(_): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let detail = admin_detail(&state.db, id).await?;
    let open_reports: i64 = sqlx::query_scalar("select count(*) from reports where mod_id = $1 and status = 'open'")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let import: (Option<DateTime<Utc>>, Option<Value>) = sqlx::query_as("select imported_at, import_info from mods where id = $1").bind(id).fetch_one(&state.db).await?;
    let mut value = serde_json::to_value(detail).map_err(AppError::internal)?;
    value["open_reports"] = json!(open_reports);
    value["imported_at"] = json!(import.0);
    value["import_info"] = import.1.unwrap_or(Value::Null);
    Ok(Json(value))
}

async fn create_mod(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<ModInput>) -> ApiResult<(StatusCode, Json<ModDetail>)> {
    let m = clean_mod(input)?;
    ensure_category(&state.db, m.category_id).await?;
    let id = Uuid::new_v4();

    let mut tx = state.db.begin().await?;
    let sql = format!("insert into mods (id, {MOD_COLUMNS}) values ($1, {})", placeholders(2, 22));
    let result = bind_mod(sqlx::query(&sql).bind(id), &m).execute(&mut *tx).await;
    if let Err(err) = result {
        return Err(if slug_taken(&err) { AppError::field("slug", "another mod already uses this link name") } else { err.into() });
    }
    set_tags(&mut tx, id, &m.tags).await?;
    tx.commit().await?;

    audit(&state.db, &admin, "create_mod", &m.name, "").await;
    Ok((StatusCode::CREATED, Json(admin_detail(&state.db, id).await?)))
}

async fn update_mod(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<ModInput>) -> ApiResult<Json<ModDetail>> {
    let m = clean_mod(input)?;
    ensure_category(&state.db, m.category_id).await?;

    let status: Option<String> = sqlx::query_scalar("select status from mods where id = $1").bind(id).fetch_optional(&state.db).await?;
    let Some(status) = status else { return Err(AppError::not_found("that mod doesn't exist")) };

    let mut tx = state.db.begin().await?;
    let sql = format!("update mods set ({MOD_COLUMNS}) = ({}), updated_at = now() where id = $1", placeholders(2, 22));
    let result = bind_mod(sqlx::query(&sql).bind(id), &m).execute(&mut *tx).await;
    if let Err(err) = result {
        return Err(if slug_taken(&err) { AppError::field("slug", "another mod already uses this link name") } else { err.into() });
    }
    set_tags(&mut tx, id, &m.tags).await?;

    if status == "published" {
        if let Err(err) = check_publishable(&mut tx, id).await {
            tx.rollback().await?;
            return Err(err);
        }
    }
    tx.commit().await?;

    audit(&state.db, &admin, "update_mod", &m.name, "").await;
    Ok(Json(admin_detail(&state.db, id).await?))
}

async fn check_publishable(conn: &mut PgConnection, id: Uuid) -> ApiResult<()> {
    let row: Option<(String, String, Option<Uuid>, String, String)> =
        sqlx::query_as("select summary, author_name, category_id, license_name, redistribution from mods where id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((summary, author, category, license, redistribution)) = row else { return Err(AppError::not_found("that mod doesn't exist")) };
    let (working, hosted_files, unknown_versions): (i64, i64, i64) = sqlx::query_as(
        "select
            count(*) filter (where not download_disabled and (
                (download_kind = 'hosted' and file_key is not null and $2 = 'allowed')
                or (download_kind = 'external' and external_url is not null))),
            count(*) filter (where download_kind = 'hosted' and file_key is not null),
            count(*) filter (where lower(version) = 'unknown')
         from releases where mod_id = $1",
    )
    .bind(id)
    .bind(&redistribution)
    .fetch_one(&mut *conn)
    .await?;

    let mut e = FieldErrors::default();
    e.check(!summary.is_empty(), "summary", "add a short summary before publishing");
    e.check(!author.is_empty(), "author_name", "add the author's name before publishing");
    e.check(category.is_some(), "category_id", "pick a category before publishing");
    e.check(!license.is_empty(), "license_name", "add the license (or write \"unknown\") before publishing");
    e.check(
        hosted_files == 0 || redistribution == "allowed",
        "redistribution",
        "this mod has a file hosted on Branch, so sharing has to be marked \"allowed\" first (only if the license or author allows it). otherwise remove the file and link to the author's release.",
    );
    e.check(unknown_versions == 0, "releases", "set the version number of every release (imported ones start as \"unknown\")");
    e.check(working > 0, "releases", "add at least one release with a working download before publishing");
    e.finish()
}

#[derive(Deserialize)]
struct StatusInput {
    status: String,
}

async fn set_status(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<StatusInput>) -> ApiResult<Json<ModDetail>> {
    if !MOD_STATUSES.contains(&input.status.as_str()) {
        return Err(AppError::bad_request("unknown status"));
    }
    let mut conn = state.db.acquire().await?;
    if input.status == "published" {
        check_publishable(&mut conn, id).await?;
    }
    let result = sqlx::query(
        "update mods set status = $1, updated_at = now(),
            published_at = case when $1 = 'published' then coalesce(published_at, now()) else published_at end
         where id = $2",
    )
    .bind(&input.status)
    .bind(id)
    .execute(&mut *conn)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found("that mod doesn't exist"));
    }
    drop(conn);
    let detail = admin_detail(&state.db, id).await?;
    audit(&state.db, &admin, "set_status", &detail.name, &input.status).await;
    Ok(Json(detail))
}

#[derive(Deserialize)]
struct FeaturedInput {
    featured: bool,
}

async fn set_featured(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<FeaturedInput>) -> ApiResult<Json<ModDetail>> {
    let name: Option<String> = sqlx::query_scalar("update mods set featured = $1 where id = $2 returning name")
        .bind(input.featured)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let name = name.ok_or_else(|| AppError::not_found("that mod doesn't exist"))?;
    audit(&state.db, &admin, if input.featured { "feature_mod" } else { "unfeature_mod" }, &name, "").await;
    Ok(Json(admin_detail(&state.db, id).await?))
}

async fn delete_mod(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let name: Option<String> = sqlx::query_scalar("select name from mods where id = $1").bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that mod doesn't exist"))?;

    let mut keys: Vec<String> = sqlx::query_scalar(
        "select thumbnail_key from mods where id = $1 and thumbnail_key is not null
         union all select image_key from screenshots where mod_id = $1
         union all select file_key from releases where mod_id = $1 and file_key is not null",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    keys.dedup();

    sqlx::query("delete from mods where id = $1").bind(id).execute(&state.db).await?;
    for key in keys {
        storage::delete_quietly(state.store.as_ref(), &key).await;
    }
    audit(&state.db, &admin, "delete_mod", &name, "").await;
    Ok(ok())
}

struct Upload {
    file_name: String,
    data: Bytes,
    fields: HashMap<String, String>,
}

async fn read_upload(mut multipart: Multipart, max: usize) -> ApiResult<Upload> {
    let mut file: Option<(String, Bytes)> = None;
    let mut fields = HashMap::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(AppError::bad_request("the upload was cut off or is too big")),
        };
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let file_name = field.file_name().unwrap_or("upload").to_string();
            let data = field.bytes().await.map_err(|_| AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the file is too big or the upload was cut off"))?;
            if data.len() > max {
                return Err(AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the file is too big"));
            }
            file = Some((file_name, data));
        } else if !name.is_empty() {
            let text = field.text().await.map_err(|_| AppError::bad_request("couldn't read the form"))?;
            if text.len() <= 2000 {
                fields.insert(name, text);
            }
        }
    }
    let (file_name, data) = file.ok_or_else(|| AppError::bad_request("no file was attached"))?;
    Ok(Upload { file_name, data, fields })
}

async fn store_image(state: &AppState, data: Bytes, kind: ImageKind) -> ApiResult<String> {
    let processed = tokio::task::spawn_blocking(move || process_image(&data, kind))
        .await
        .map_err(AppError::internal)?
        .map_err(|message| AppError::field("file", &message))?;
    let key = format!("images/{}.{}", Uuid::new_v4(), processed.ext);
    storage::put(state.store.as_ref(), &key, processed.bytes).await?;
    Ok(key)
}

async fn upload_thumbnail(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, multipart: Multipart) -> ApiResult<Json<ModDetail>> {
    let name: Option<String> = sqlx::query_scalar("select name from mods where id = $1").bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that mod doesn't exist"))?;
    let upload = read_upload(multipart, MAX_IMAGE_BYTES).await?;
    let key = store_image(&state, upload.data, ImageKind::Thumbnail).await?;

    let old: Option<Option<String>> = sqlx::query_scalar(
        "update mods m set thumbnail_key = $1, updated_at = now()
         from (select thumbnail_key from mods where id = $2) old
         where m.id = $2 returning old.thumbnail_key",
    )
    .bind(&key)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(Some(old)) = old {
        storage::delete_quietly(state.store.as_ref(), &old).await;
    }
    audit(&state.db, &admin, "upload_thumbnail", &name, "").await;
    Ok(Json(admin_detail(&state.db, id).await?))
}

async fn remove_thumbnail(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<ModDetail>> {
    let row: Option<(String, Option<String>)> = sqlx::query_as("select name, thumbnail_key from mods where id = $1").bind(id).fetch_optional(&state.db).await?;
    let (name, key) = row.ok_or_else(|| AppError::not_found("that mod doesn't exist"))?;
    sqlx::query("update mods set thumbnail_key = null, updated_at = now() where id = $1").bind(id).execute(&state.db).await?;
    if let Some(key) = key {
        storage::delete_quietly(state.store.as_ref(), &key).await;
    }
    audit(&state.db, &admin, "remove_thumbnail", &name, "").await;
    Ok(Json(admin_detail(&state.db, id).await?))
}

async fn add_screenshot(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, multipart: Multipart) -> ApiResult<Json<ModDetail>> {
    let name: Option<String> = sqlx::query_scalar("select name from mods where id = $1").bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that mod doesn't exist"))?;
    let count: i64 = sqlx::query_scalar("select count(*) from screenshots where mod_id = $1").bind(id).fetch_one(&state.db).await?;
    if count >= MAX_SCREENSHOTS {
        return Err(AppError::field("file", "a mod can have up to 12 screenshots"));
    }
    let upload = read_upload(multipart, MAX_IMAGE_BYTES).await?;
    let caption = upload.fields.get("caption").map(|c| c.trim().to_string()).unwrap_or_default();
    if too_long(&caption, 200) {
        return Err(AppError::field("caption", "keep the caption under 200 characters"));
    }
    let key = store_image(&state, upload.data, ImageKind::Screenshot).await?;
    sqlx::query("insert into screenshots (id, mod_id, image_key, caption, sort_order) values ($1, $2, $3, $4, $5)")
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(&key)
        .bind(&caption)
        .bind(count as i32)
        .execute(&state.db)
        .await?;
    audit(&state.db, &admin, "add_screenshot", &name, "").await;
    Ok(Json(admin_detail(&state.db, id).await?))
}

#[derive(Deserialize)]
struct ScreenshotInput {
    caption: String,
    sort_order: i32,
}

async fn update_screenshot(State(state): State<AppState>, Admin(_): Admin, Path(id): Path<Uuid>, Json(input): Json<ScreenshotInput>) -> ApiResult<Json<ModDetail>> {
    let caption = input.caption.trim();
    if too_long(caption, 200) {
        return Err(AppError::field("caption", "keep the caption under 200 characters"));
    }
    let mod_id: Option<Uuid> = sqlx::query_scalar("update screenshots set caption = $1, sort_order = $2 where id = $3 returning mod_id")
        .bind(caption)
        .bind(input.sort_order.clamp(0, 1000))
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let mod_id = mod_id.ok_or_else(|| AppError::not_found("that screenshot doesn't exist"))?;
    Ok(Json(admin_detail(&state.db, mod_id).await?))
}

async fn delete_screenshot(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<ModDetail>> {
    let row: Option<(Uuid, String)> = sqlx::query_as("delete from screenshots where id = $1 returning mod_id, image_key").bind(id).fetch_optional(&state.db).await?;
    let (mod_id, key) = row.ok_or_else(|| AppError::not_found("that screenshot doesn't exist"))?;
    storage::delete_quietly(state.store.as_ref(), &key).await;
    audit(&state.db, &admin, "delete_screenshot", &mod_id.to_string(), "").await;
    Ok(Json(admin_detail(&state.db, mod_id).await?))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ReleaseInput {
    version: String,
    released_on: Option<NaiveDate>,
    changelog: String,
    game_version: String,
    download_kind: String,
    external_url: String,
}

struct CleanRelease {
    version: String,
    released_on: NaiveDate,
    changelog: String,
    game_version: String,
    download_kind: String,
    external_url: Option<String>,
}

fn clean_release(input: ReleaseInput, redistribution: &str) -> ApiResult<CleanRelease> {
    let mut e = FieldErrors::default();
    let version = text_field(&mut e, "version", &input.version, 40);
    e.check(!version.is_empty(), "version", "add a version number, like 1.2.0");
    e.check(input.released_on.is_some(), "released_on", "pick the release date");
    let changelog = text_field(&mut e, "changelog", &input.changelog, 10_000);
    let game_version = text_field(&mut e, "game_version", &input.game_version, 60);
    let kind = input.download_kind.as_str();
    e.check(kind == "hosted" || kind == "external", "download_kind", "pick how people get this release");
    let external_url = if kind == "external" {
        let url = url_field(&mut e, "external_url", &input.external_url);
        e.check(url.is_some() || !input.external_url.trim().is_empty(), "external_url", "add the link to the author's release page");
        url
    } else {
        None
    };
    e.check(
        kind != "hosted" || redistribution == "allowed",
        "download_kind",
        "Branch can only host a copy when redistribution is marked \"allowed\". link to the author's release instead.",
    );
    e.finish()?;
    Ok(CleanRelease {
        version,
        released_on: input.released_on.unwrap_or_default(),
        changelog,
        game_version,
        download_kind: kind.to_string(),
        external_url,
    })
}

async fn find_release_row(db: &PgPool, id: Uuid) -> ApiResult<ReleaseRow> {
    let row: Option<ReleaseRow> = sqlx::query_as(&format!("{RELEASE_SELECT} where id = $1")).bind(id).fetch_optional(db).await?;
    row.ok_or_else(|| AppError::not_found("that release doesn't exist"))
}

async fn mod_redistribution(db: &PgPool, mod_id: Uuid) -> ApiResult<(String, String)> {
    let row: Option<(String, String)> = sqlx::query_as("select name, redistribution from mods where id = $1").bind(mod_id).fetch_optional(db).await?;
    row.ok_or_else(|| AppError::not_found("that mod doesn't exist"))
}

async fn touch_mod(db: &PgPool, mod_id: Uuid) -> ApiResult<()> {
    sqlx::query("update mods set updated_at = now() where id = $1").bind(mod_id).execute(db).await?;
    Ok(())
}

async fn create_release(State(state): State<AppState>, Admin(admin): Admin, Path(mod_id): Path<Uuid>, Json(input): Json<ReleaseInput>) -> ApiResult<(StatusCode, Json<ReleaseOut>)> {
    let (mod_name, redistribution) = mod_redistribution(&state.db, mod_id).await?;
    let r = clean_release(input, &redistribution)?;
    let id = Uuid::new_v4();
    sqlx::query(
        "insert into releases (id, mod_id, version, released_on, changelog, game_version, download_kind, external_url)
         values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(mod_id)
    .bind(&r.version)
    .bind(r.released_on)
    .bind(&r.changelog)
    .bind(&r.game_version)
    .bind(&r.download_kind)
    .bind(&r.external_url)
    .execute(&state.db)
    .await?;
    touch_mod(&state.db, mod_id).await?;
    audit(&state.db, &admin, "create_release", &mod_name, &r.version).await;
    let row = find_release_row(&state.db, id).await?;
    Ok((StatusCode::CREATED, Json(ReleaseOut::from(&row))))
}

async fn update_release(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<ReleaseInput>) -> ApiResult<Json<ReleaseOut>> {
    let existing = find_release_row(&state.db, id).await?;
    let (mod_name, redistribution) = mod_redistribution(&state.db, existing.mod_id).await?;
    let switching_to_hosted = input.download_kind == "hosted" && existing.download_kind != "hosted";
    let check_against = if switching_to_hosted { redistribution.as_str() } else { "allowed" };
    let r = clean_release(input, check_against)?;

    sqlx::query(
        "update releases set version = $1, released_on = $2, changelog = $3, game_version = $4, download_kind = $5,
            external_url = $6
         where id = $7",
    )
    .bind(&r.version)
    .bind(r.released_on)
    .bind(&r.changelog)
    .bind(&r.game_version)
    .bind(&r.download_kind)
    .bind(&r.external_url)
    .bind(id)
    .execute(&state.db)
    .await?;

    if r.download_kind == "external" {
        if let Some(key) = &existing.file_key {
            sqlx::query("update releases set file_key = null, file_name = null, file_size = null, file_sha256 = null, file_type = null where id = $1")
                .bind(id)
                .execute(&state.db)
                .await?;
            storage::delete_quietly(state.store.as_ref(), key).await;
        }
    }
    touch_mod(&state.db, existing.mod_id).await?;
    audit(&state.db, &admin, "update_release", &mod_name, &r.version).await;
    Ok(Json(ReleaseOut::from(&find_release_row(&state.db, id).await?)))
}

async fn delete_release(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let existing = find_release_row(&state.db, id).await?;
    sqlx::query("delete from releases where id = $1").bind(id).execute(&state.db).await?;
    if let Some(key) = &existing.file_key {
        storage::delete_quietly(state.store.as_ref(), key).await;
    }
    touch_mod(&state.db, existing.mod_id).await?;
    audit(&state.db, &admin, "delete_release", &existing.mod_id.to_string(), &existing.version).await;
    Ok(ok())
}

async fn upload_release_file(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, multipart: Multipart) -> ApiResult<Json<ReleaseOut>> {
    let existing = find_release_row(&state.db, id).await?;
    let (mod_name, redistribution) = mod_redistribution(&state.db, existing.mod_id).await?;
    if existing.download_kind != "hosted" {
        return Err(AppError::field("file", "this release links to the author's site. switch it to \"hosted on Branch\" first."));
    }
    if redistribution != "allowed" {
        return Err(AppError::field("file", "Branch can only host a copy when redistribution is marked \"allowed\"."));
    }
    let upload = read_upload(multipart, MAX_MOD_FILE_BYTES).await?;
    let file_name = upload.file_name;
    let data = upload.data;
    let (checked, data) = tokio::task::spawn_blocking(move || check_mod_file(&file_name, &data).map(|c| (c, data)))
        .await
        .map_err(AppError::internal)?
        .map_err(|message| AppError::field("file", &message))?;

    let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
    storage::put(state.store.as_ref(), &key, data.to_vec()).await?;
    sqlx::query("update releases set file_key = $1, file_name = $2, file_size = $3, file_sha256 = $4, file_type = $5 where id = $6")
        .bind(&key)
        .bind(&checked.name)
        .bind(checked.size)
        .bind(&checked.sha256)
        .bind(checked.kind)
        .bind(id)
        .execute(&state.db)
        .await?;
    if let Some(old) = &existing.file_key {
        storage::delete_quietly(state.store.as_ref(), old).await;
    }
    touch_mod(&state.db, existing.mod_id).await?;
    audit(&state.db, &admin, "upload_file", &mod_name, &format!("{} ({} bytes, sha256 {})", checked.name, checked.size, checked.sha256)).await;
    Ok(Json(ReleaseOut::from(&find_release_row(&state.db, id).await?)))
}

async fn remove_release_file(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<ReleaseOut>> {
    let existing = find_release_row(&state.db, id).await?;
    sqlx::query("update releases set file_key = null, file_name = null, file_size = null, file_sha256 = null, file_type = null where id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if let Some(key) = &existing.file_key {
        storage::delete_quietly(state.store.as_ref(), key).await;
    }
    audit(&state.db, &admin, "remove_file", &existing.mod_id.to_string(), &existing.version).await;
    Ok(Json(ReleaseOut::from(&find_release_row(&state.db, id).await?)))
}

#[derive(Deserialize)]
struct AvailabilityInput {
    disabled: bool,
    #[serde(default)]
    reason: String,
}

async fn set_release_availability(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<AvailabilityInput>) -> ApiResult<Json<ReleaseOut>> {
    let existing = find_release_row(&state.db, id).await?;
    let reason = input.reason.trim();
    if input.disabled && reason.is_empty() {
        return Err(AppError::field("reason", "say why the download is turned off. people will see this."));
    }
    if too_long(reason, 300) {
        return Err(AppError::field("reason", "keep the reason under 300 characters"));
    }
    sqlx::query("update releases set download_disabled = $1, disabled_reason = $2 where id = $3")
        .bind(input.disabled)
        .bind(if input.disabled { reason } else { "" })
        .bind(id)
        .execute(&state.db)
        .await?;
    audit(&state.db, &admin, if input.disabled { "disable_download" } else { "enable_download" }, &existing.mod_id.to_string(), &format!("{}: {reason}", existing.version)).await;
    Ok(Json(ReleaseOut::from(&find_release_row(&state.db, id).await?)))
}

#[derive(FromRow, Serialize)]
struct CategoryRow {
    id: Uuid,
    slug: String,
    name: String,
    description: String,
    sort_order: i32,
    mod_count: i64,
}

async fn list_categories(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows: Vec<CategoryRow> = sqlx::query_as(
        "select c.id, c.slug, c.name, c.description, c.sort_order, count(m.id) as mod_count
         from categories c left join mods m on m.category_id = c.id
         group by c.id order by c.sort_order, c.name",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CategoryInput {
    name: String,
    slug: String,
    description: String,
    sort_order: i32,
}

fn clean_category(input: &CategoryInput) -> ApiResult<(String, String, String)> {
    let mut e = FieldErrors::default();
    let name = text_field(&mut e, "name", &input.name, 40);
    e.check(!name.is_empty(), "name", "give the category a name");
    let slug = if input.slug.trim().is_empty() { slugify(&name) } else { input.slug.trim().to_lowercase() };
    e.check(valid_slug(&slug), "slug", "use lowercase letters, numbers and dashes only");
    let description = text_field(&mut e, "description", &input.description, 300);
    e.finish()?;
    Ok((name, slug, description))
}

async fn create_category(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<CategoryInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (name, slug, description) = clean_category(&input)?;
    let result = sqlx::query("insert into categories (id, slug, name, description, sort_order) values ($1, $2, $3, $4, $5)")
        .bind(Uuid::new_v4())
        .bind(&slug)
        .bind(&name)
        .bind(&description)
        .bind(input.sort_order)
        .execute(&state.db)
        .await;
    if let Err(err) = result {
        return Err(if slug_taken(&err) { AppError::field("slug", "another category already uses this link name") } else { err.into() });
    }
    audit(&state.db, &admin, "create_category", &name, "").await;
    Ok((StatusCode::CREATED, ok()))
}

async fn update_category(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<CategoryInput>) -> ApiResult<Json<Value>> {
    let (name, slug, description) = clean_category(&input)?;
    let result = sqlx::query("update categories set slug = $1, name = $2, description = $3, sort_order = $4 where id = $5")
        .bind(&slug)
        .bind(&name)
        .bind(&description)
        .bind(input.sort_order)
        .bind(id)
        .execute(&state.db)
        .await;
    match result {
        Ok(r) if r.rows_affected() == 0 => return Err(AppError::not_found("that category doesn't exist")),
        Ok(_) => {}
        Err(err) => return Err(if slug_taken(&err) { AppError::field("slug", "another category already uses this link name") } else { err.into() }),
    }
    audit(&state.db, &admin, "update_category", &name, "").await;
    Ok(ok())
}

async fn delete_category(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let published: i64 = sqlx::query_scalar("select count(*) from mods where category_id = $1 and status = 'published'").bind(id).fetch_one(&state.db).await?;
    if published > 0 {
        return Err(AppError::new(StatusCode::CONFLICT, "in_use", format!("{published} published mod(s) still use this category. move them first.")));
    }
    let name: Option<String> = sqlx::query_scalar("delete from categories where id = $1 returning name").bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that category doesn't exist"))?;
    audit(&state.db, &admin, "delete_category", &name, "").await;
    Ok(ok())
}

#[derive(FromRow, Serialize)]
struct TagRow {
    id: Uuid,
    slug: String,
    name: String,
    mod_count: i64,
}

async fn list_tags(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows: Vec<TagRow> = sqlx::query_as(
        "select t.id, t.slug, t.name, count(mt.mod_id) as mod_count
         from tags t left join mod_tags mt on mt.tag_id = t.id
         group by t.id order by lower(t.name)",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

#[derive(Deserialize)]
struct TagInput {
    name: String,
}

async fn rename_tag(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<TagInput>) -> ApiResult<Json<Value>> {
    let name = input.name.trim();
    let slug = slugify(name);
    if name.is_empty() || too_long(name, 32) || slug.is_empty() {
        return Err(AppError::field("name", "tags have to be short words (up to 32 characters)"));
    }
    let result = sqlx::query("update tags set name = $1, slug = $2 where id = $3").bind(name).bind(&slug).bind(id).execute(&state.db).await;
    match result {
        Ok(r) if r.rows_affected() == 0 => return Err(AppError::not_found("that tag doesn't exist")),
        Ok(_) => {}
        Err(err) => return Err(if slug_taken(&err) { AppError::field("name", "another tag already has this name") } else { err.into() }),
    }
    audit(&state.db, &admin, "rename_tag", name, "").await;
    Ok(ok())
}

async fn delete_tag(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let name: Option<String> = sqlx::query_scalar("delete from tags where id = $1 returning name").bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that tag doesn't exist"))?;
    audit(&state.db, &admin, "delete_tag", &name, "").await;
    Ok(ok())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ReportQuery {
    status: Option<String>,
}

#[derive(FromRow, Serialize)]
struct ReportRow {
    id: Uuid,
    mod_id: Option<Uuid>,
    mod_slug: Option<String>,
    mod_name: String,
    reason: String,
    details: String,
    contact: String,
    status: String,
    admin_note: String,
    created_at: DateTime<Utc>,
    resolved_at: Option<DateTime<Utc>>,
    resolved_by: Option<String>,
}

async fn list_reports(State(state): State<AppState>, Admin(_): Admin, Query(query): Query<ReportQuery>) -> ApiResult<Json<Value>> {
    let status = query.status.filter(|s| matches!(s.as_str(), "open" | "resolved" | "dismissed"));
    let rows: Vec<ReportRow> = sqlx::query_as(
        "select r.id, r.mod_id, m.slug as mod_slug, r.mod_name, r.reason, r.details, r.contact, r.status, r.admin_note,
                r.created_at, r.resolved_at, a.username as resolved_by
         from reports r
         left join mods m on m.id = r.mod_id
         left join admins a on a.id = r.resolved_by
         where ($1::text is null or r.status = $1)
         order by (r.status = 'open') desc, r.created_at desc
         limit 500",
    )
    .bind(status)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

#[derive(Deserialize)]
struct ReportUpdate {
    status: String,
    #[serde(default)]
    admin_note: String,
}

async fn update_report(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<ReportUpdate>) -> ApiResult<Json<Value>> {
    if !matches!(input.status.as_str(), "open" | "resolved" | "dismissed") {
        return Err(AppError::bad_request("unknown report status"));
    }
    let note = input.admin_note.trim();
    if too_long(note, 2000) {
        return Err(AppError::field("admin_note", "keep the note under 2000 characters"));
    }
    let mod_name: Option<String> = sqlx::query_scalar(
        "update reports set status = $1, admin_note = $2,
            resolved_at = case when $1 = 'open' then null else now() end,
            resolved_by = case when $1 = 'open' then null else $3 end
         where id = $4 returning mod_name",
    )
    .bind(&input.status)
    .bind(note)
    .bind(admin.id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let mod_name = mod_name.ok_or_else(|| AppError::not_found("that report doesn't exist"))?;
    audit(&state.db, &admin, "update_report", &mod_name, &input.status).await;
    Ok(ok())
}

async fn delete_report(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let mod_name: Option<String> = sqlx::query_scalar("delete from reports where id = $1 returning mod_name").bind(id).fetch_optional(&state.db).await?;
    let mod_name = mod_name.ok_or_else(|| AppError::not_found("that report doesn't exist"))?;
    audit(&state.db, &admin, "delete_report", &mod_name, "").await;
    Ok(ok())
}

#[derive(FromRow, Serialize)]
struct AuditRow {
    id: i64,
    admin_username: String,
    action: String,
    target: String,
    details: String,
    created_at: DateTime<Utc>,
}

async fn list_audit(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows: Vec<AuditRow> = sqlx::query_as(
        "select id, admin_username, action, target, details, created_at from audit_log order by created_at desc, id desc limit 300",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

#[derive(FromRow, Serialize)]
struct RequestRow {
    id: Uuid,
    mod_name: String,
    url: String,
    author: String,
    details: String,
    contact: String,
    status: String,
    admin_note: String,
    created_mod_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    decided_at: Option<DateTime<Utc>>,
    decided_by: Option<String>,
}

async fn list_requests(State(state): State<AppState>, Admin(_): Admin, Query(query): Query<ReportQuery>) -> ApiResult<Json<Value>> {
    let status = query.status.filter(|s| matches!(s.as_str(), "open" | "accepted" | "denied"));
    let rows: Vec<RequestRow> = sqlx::query_as(
        "select r.id, r.mod_name, r.url, r.author, r.details, r.contact, r.status, r.admin_note, r.created_mod_id,
                r.created_at, r.decided_at, a.username as decided_by
         from mod_requests r left join admins a on a.id = r.decided_by
         where ($1::text is null or r.status = $1)
         order by (r.status = 'open') desc, r.created_at desc
         limit 500",
    )
    .bind(status)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

#[derive(Deserialize)]
struct RequestUpdate {
    status: String,
    #[serde(default)]
    admin_note: String,
}

async fn update_request(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<RequestUpdate>) -> ApiResult<Json<Value>> {
    if !matches!(input.status.as_str(), "open" | "accepted" | "denied") {
        return Err(AppError::bad_request("unknown request status"));
    }
    let note = input.admin_note.trim();
    if too_long(note, 2000) {
        return Err(AppError::field("admin_note", "keep the note under 2000 characters"));
    }
    let name: Option<String> = sqlx::query_scalar(
        "update mod_requests set status = $1, admin_note = $2,
            decided_at = case when $1 = 'open' then null else now() end,
            decided_by = case when $1 = 'open' then null else $3 end
         where id = $4 returning mod_name",
    )
    .bind(&input.status)
    .bind(note)
    .bind(admin.id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let name = name.ok_or_else(|| AppError::not_found("that request doesn't exist"))?;
    audit(&state.db, &admin, "update_request", &name, &input.status).await;
    Ok(ok())
}

async fn delete_request(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let name: Option<String> = sqlx::query_scalar("delete from mod_requests where id = $1 returning mod_name").bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that request doesn't exist"))?;
    audit(&state.db, &admin, "delete_request", &name, "").await;
    Ok(ok())
}

async fn request_to_draft(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, String, Option<Uuid>)> =
        sqlx::query_as("select mod_name, url, author, created_mod_id from mod_requests where id = $1").bind(id).fetch_optional(&state.db).await?;
    let (name, url, author, existing) = row.ok_or_else(|| AppError::not_found("that request doesn't exist"))?;
    if let Some(mod_id) = existing {
        return Ok(Json(json!({ "mod_id": mod_id })));
    }

    let is_github = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(|h| h == "github.com" || h == "www.github.com")).unwrap_or(false);
    let mod_id = insert_draft(&state.db, &name, &author, if is_github { Some(url.clone()) } else { None }, Some(url.clone())).await?;

    sqlx::query("update mod_requests set status = 'accepted', created_mod_id = $1, decided_at = now(), decided_by = $2 where id = $3")
        .bind(mod_id)
        .bind(admin.id)
        .bind(id)
        .execute(&state.db)
        .await?;
    audit(&state.db, &admin, "accept_request", &name, "created a draft").await;
    Ok(Json(json!({ "mod_id": mod_id })))
}
pub(crate) async fn insert_draft(db: &PgPool, name: &str, author: &str, source_url: Option<String>, project_url: Option<String>) -> ApiResult<Uuid> {
    let name: String = name.chars().take(80).collect();
    let base = {
        let s = slugify(&name);
        if s.is_empty() { "new-mod".to_string() } else { s }
    };
    let mod_id = Uuid::new_v4();
    for n in 1..=50 {
        let slug = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        let result = sqlx::query("insert into mods (id, slug, name, author_name, source_url, project_url) values ($1, $2, $3, $4, $5, $6)")
            .bind(mod_id)
            .bind(&slug)
            .bind(&name)
            .bind(author.chars().take(80).collect::<String>())
            .bind(&source_url)
            .bind(&project_url)
            .execute(db)
            .await;
        match result {
            Ok(_) => return Ok(mod_id),
            Err(err) if slug_taken(&err) => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(AppError::new(StatusCode::CONFLICT, "slug_taken", "couldn't find a free link name for this mod. create it by hand instead."))
}

fn name_from_file(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(file_name);
    let stem = match version_from_file(stem) {
        Some(v) => stem.replace(&v, "").replace("_v", " ").replace("-v", " "),
        None => stem.to_string(),
    };
    let mut out = String::new();
    let mut prev: Option<char> = None;
    for c in stem.chars() {
        let c = if matches!(c, '_' | '-' | '.' | '+') { ' ' } else { c };
        if let Some(p) = prev {
            if c.is_uppercase() && p.is_lowercase() {
                out.push(' ');
            }
        }
        out.push(c);
        prev = Some(c);
    }
    let words: Vec<&str> = out.split_whitespace().filter(|w| !w.eq_ignore_ascii_case("v")).collect();
    let name = words.join(" ");
    if name.is_empty() { "Imported mod".to_string() } else { name.chars().take(80).collect() }
}

pub(crate) fn version_from_file(name: &str) -> Option<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() && (i == 0 || !chars[i - 1].is_ascii_alphanumeric() || chars[i - 1] == 'v' || chars[i - 1] == 'V') {
            let start = i;
            let mut dots = 0;
            while i < chars.len() && (chars[i].is_ascii_digit() || (chars[i] == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit())) {
                if chars[i] == '.' {
                    dots += 1;
                }
                i += 1;
            }
            if dots >= 1 {
                return Some(chars[start..i].iter().collect());
            }
        }
        i += 1;
    }
    None
}

fn split_upload(file_name: &str, data: Vec<u8>, split: bool) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let is_zip = data.starts_with(b"PK\x03\x04");
    if !(split && is_zip) {
        return vec![(file_name.to_string(), data)];
    }
    let units = {
        let mut units: Vec<(String, Vec<u8>)> = Vec::new();
        if let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(data.as_slice())) {
            let mut total: u64 = 0;
            for i in 0..archive.len().min(2000) {
                let Ok(entry) = archive.by_index(i) else { continue };
                let path = entry.name().to_string();
                let lower = path.to_lowercase();
                if entry.is_dir() || lower.starts_with("__macosx") || !(lower.ends_with(".dll") || lower.ends_with(".zip")) {
                    continue;
                }
                if entry.size() > crate::uploads::MAX_MOD_FILE_BYTES as u64 || total > 400 * 1024 * 1024 || units.len() >= 200 {
                    continue;
                }
                let mut buf = Vec::new();
                if entry.take(crate::uploads::MAX_MOD_FILE_BYTES as u64 + 1).read_to_end(&mut buf).is_ok() {
                    total += buf.len() as u64;
                    let base = path.rsplit('/').next().unwrap_or(&path).to_string();
                    units.push((base, buf));
                }
            }
        }
        units
    };
    if units.is_empty() {
        vec![(file_name.to_string(), data)]
    } else {
        units
    }
}
async fn import_one(state: &AppState, admin: &AdminUser, file_name: String, data: Vec<u8>) -> Result<Value, String> {
    let (checked, report, data) = tokio::task::spawn_blocking(move || {
        let checked = check_mod_file(&file_name, &data)?;
        let report = crate::scan::scan(&file_name, &data)?;
        Ok::<_, String>((checked, report, data))
    })
    .await
    .map_err(|_| "the import crashed".to_string())??;

    let name = name_from_file(&checked.name);
    let version = version_from_file(&checked.name).unwrap_or_else(|| "unknown".into());
    let mod_id = insert_draft(&state.db, &name, "", None, None).await.map_err(|e| e.message)?;

    let info = json!({
        "file_name": checked.name,
        "scan_score": report.heuristic_score,
        "signals": report.indicators.iter().map(|i| i.label).collect::<Vec<_>>(),
        "mod_markers": report.mod_markers,
    });
    let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
    storage::put(state.store.as_ref(), &key, data).await.map_err(|_| "couldn't store the file".to_string())?;

    let db_result: Result<(), sqlx::Error> = async {
        sqlx::query("update mods set imported_at = now(), import_info = $1, code_fingerprint = $3 where id = $2")
            .bind(&info)
            .bind(mod_id)
            .bind(report.fingerprint())
            .execute(&state.db)
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
        Ok(())
    }
    .await;
    if let Err(err) = db_result {
        tracing::error!(error = %err, "import failed");
        storage::delete_quietly(state.store.as_ref(), &key).await;
        let _ = sqlx::query("delete from mods where id = $1").bind(mod_id).execute(&state.db).await;
        return Err("couldn't save this mod".into());
    }

    audit(&state.db, admin, "import_mod", &name, &checked.name).await;
    Ok(json!({ "mod_id": mod_id, "name": name, "file_name": checked.name, "version": version, "scan_score": report.heuristic_score }))
}

async fn import_mods(State(state): State<AppState>, Admin(admin): Admin, multipart: Multipart) -> ApiResult<Json<Value>> {
    let upload = read_upload(multipart, MAX_IMPORT_BYTES).await?;
    let split = upload.fields.get("split").map(|v| v == "true").unwrap_or(true);
    let file_name = upload.file_name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("upload").to_string();
    let data = upload.data.to_vec();
    let units = tokio::task::spawn_blocking(move || split_upload(&file_name, data, split)).await.map_err(AppError::internal)?;

    let mut imported = Vec::new();
    let mut failed = Vec::new();
    for (name, bytes) in units {
        match import_one(&state, &admin, name.clone(), bytes).await {
            Ok(item) => imported.push(item),
            Err(error) => failed.push(json!({ "file_name": name, "error": error })),
        }
    }
    Ok(Json(json!({ "imported": imported, "failed": failed })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_versions_come_from_file_names() {
        assert_eq!(name_from_file("GorillaFlyMenu_v1.2.dll"), "Gorilla Fly Menu");
        assert_eq!(version_from_file("GorillaFlyMenu_v1.2.dll").as_deref(), Some("1.2"));
        assert_eq!(name_from_file("cool-hats.zip"), "cool hats");
        assert_eq!(version_from_file("cool-hats.zip"), None);
        assert_eq!(version_from_file("Utilla-2.0.1.zip").as_deref(), Some("2.0.1"));
        assert_eq!(name_from_file("Utilla-2.0.1.zip"), "Utilla");
    }
}