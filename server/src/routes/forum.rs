// the community forum: boards, threads and replies, without accounts.
// a poster is identified by a random secret key that lives on their computer.
// the server only ever sees and stores a hash of it.

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{audit, Admin};
use crate::error::{ApiResult, AppError, FieldErrors};
use crate::state::AppState;
use crate::util::{sha256_hex, too_long, Visitor};

pub const BOARDS: &[(&str, &str)] = &[("general", "General"), ("help", "Help"), ("showcase", "Showcase"), ("ideas", "Mod ideas")];
const PAGE_SIZE: i64 = 30;

const ADJECTIVES: &[&str] = &[
    "Mossy", "Swift", "Sneaky", "Lucky", "Fuzzy", "Bouncy", "Jumpy", "Leafy", "Misty", "Rapid", "Sunny", "Cosmic", "Quiet", "Brave", "Clever", "Dusty",
    "Frosty", "Mellow", "Nimble", "Wild", "Zippy", "Shady", "Breezy", "Rusty",
];
const NOUNS: &[&str] = &[
    "Gorilla", "Monkey", "Branch", "Canopy", "Vine", "Climber", "Lemur", "Tagger", "Banana", "Treetop", "Ape", "Jungle", "Leaf", "Glider", "Bark", "Acorn",
];

/// "MossyGorilla482"
pub fn random_name() -> String {
    let mut rng = rand::thread_rng();
    format!(
        "{}{}{}",
        ADJECTIVES.choose(&mut rng).unwrap_or(&"Swift"),
        NOUNS.choose(&mut rng).unwrap_or(&"Gorilla"),
        rng.gen_range(10..1000)
    )
}

/// the short tag shown after a name, so two people with the same name can be told apart
fn tag_for(key_hash: &str) -> String {
    key_hash.chars().take(4).collect()
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// names people can't use, so nobody can pretend to be staff
fn name_problem(name: &str) -> Option<&'static str> {
    let len = name.chars().count();
    if !(3..=24).contains(&len) {
        return Some("names are 3 to 24 characters");
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ' ') || name.starts_with(' ') || name.ends_with(' ') || name.contains("  ") {
        return Some("use letters, numbers, spaces, dashes and underscores only");
    }
    let lower: String = name.to_lowercase().chars().filter(|c| !matches!(c, ' ' | '_' | '-')).collect();
    if ["admin", "moderator", "drifted", "branchstaff", "branchteam", "official", "system"].iter().any(|bad| lower.contains(bad)) {
        return Some("that name could be confused with Branch staff. pick another one");
    }
    None
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/forum/me", post(identity).put(rename))
        .route("/api/forum/me/random", post(random_rename))
        .route("/api/forum/threads", get(list_threads).post(create_thread))
        .route("/api/forum/threads/{id}", get(get_thread))
        .route("/api/forum/threads/{id}/replies", post(create_reply))
        .route("/api/forum/report", post(report))
        .route("/api/admin/forum", get(admin_overview))
        .route("/api/admin/forum/threads/{id}", post(admin_thread))
        .route("/api/admin/forum/replies/{id}", post(admin_reply))
        .route("/api/admin/forum/posters/{id}", post(admin_poster))
        .route("/api/admin/forum/reports/{id}", post(admin_close_report))
        .route("/api/chat", get(chat_messages).post(send_chat))
        .route("/api/admin/chat/{id}", post(admin_chat))
}

#[derive(FromRow)]
struct Poster {
    id: Uuid,
    key_hash: String,
    name: String,
    banned: bool,
}

/// finds (or creates) the poster for a key. banned posters, and anyone on a banned
/// person's connection, can still read but not post.
async fn poster_for(state: &AppState, key: &str, visitor: &Visitor, create: bool) -> ApiResult<Poster> {
    if !valid_key(key) {
        return Err(AppError::bad_request("the community key on this computer is broken. clear it in settings and try again."));
    }
    let key_hash = sha256_hex(key.as_bytes());
    let existing: Option<Poster> = sqlx::query_as("select id, key_hash, name, banned from forum_posters where key_hash = $1")
        .bind(&key_hash)
        .fetch_optional(&state.db)
        .await?;
    let poster = match existing {
        Some(p) => {
            sqlx::query("update forum_posters set last_seen_at = now() where id = $1").bind(p.id).execute(&state.db).await?;
            p
        }
        None if create => {
            if !state.limiter.check(&format!("forum-new:{}", visitor.id), 10, Duration::from_secs(24 * 3600)) {
                return Err(AppError::too_many("too many new community names from this connection today."));
            }
            let p = Poster { id: Uuid::new_v4(), key_hash: key_hash.clone(), name: random_name(), banned: false };
            sqlx::query("insert into forum_posters (id, key_hash, name, visitor) values ($1, $2, $3, $4) on conflict (key_hash) do nothing")
                .bind(p.id)
                .bind(&p.key_hash)
                .bind(&p.name)
                .bind(&visitor.id)
                .execute(&state.db)
                .await?;
            sqlx::query_as("select id, key_hash, name, banned from forum_posters where key_hash = $1").bind(&key_hash).fetch_one(&state.db).await?
        }
        None => return Err(AppError::bad_request("open the community page first so Branch can make your name.")),
    };
    Ok(poster)
}

async fn ensure_can_post(state: &AppState, poster: &Poster, visitor: &Visitor) -> ApiResult<()> {
    let banned_connection: bool = sqlx::query_scalar("select exists(select 1 from forum_posters where visitor = $1 and banned)")
        .bind(&visitor.id)
        .fetch_one(&state.db)
        .await?;
    if poster.banned || banned_connection {
        return Err(AppError::forbidden("forum_banned", "you can't post in the community right now."));
    }
    Ok(())
}

fn me_json(p: &Poster) -> Json<Value> {
    Json(json!({ "name": p.name, "tag": tag_for(&p.key_hash), "banned": p.banned }))
}

#[derive(Deserialize)]
struct KeyInput {
    key: String,
}

async fn identity(State(state): State<AppState>, visitor: Visitor, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    Ok(me_json(&poster))
}

#[derive(Deserialize)]
struct RenameInput {
    key: String,
    name: String,
}

async fn rename(State(state): State<AppState>, visitor: Visitor, Json(input): Json<RenameInput>) -> ApiResult<Json<Value>> {
    let mut poster = poster_for(&state, &input.key, &visitor, true).await?;
    let name = input.name.trim().to_string();
    if let Some(problem) = name_problem(&name) {
        return Err(AppError::field("name", problem));
    }
    if !state.limiter.check(&format!("forum-rename:{}", poster.id), 10, Duration::from_secs(24 * 3600)) {
        return Err(AppError::too_many("you've changed your name a lot today. try again tomorrow."));
    }
    sqlx::query("update forum_posters set name = $1 where id = $2").bind(&name).bind(poster.id).execute(&state.db).await?;
    poster.name = name;
    Ok(me_json(&poster))
}

async fn random_rename(State(state): State<AppState>, visitor: Visitor, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let mut poster = poster_for(&state, &input.key, &visitor, true).await?;
    if !state.limiter.check(&format!("forum-rename:{}", poster.id), 10, Duration::from_secs(24 * 3600)) {
        return Err(AppError::too_many("you've changed your name a lot today. try again tomorrow."));
    }
    poster.name = random_name();
    sqlx::query("update forum_posters set name = $1 where id = $2").bind(&poster.name).bind(poster.id).execute(&state.db).await?;
    Ok(me_json(&poster))
}

#[derive(Serialize)]
struct Author {
    name: String,
    tag: String,
}

#[derive(FromRow)]
struct ThreadRow {
    id: Uuid,
    board: String,
    title: String,
    body: String,
    pinned: bool,
    locked: bool,
    removed: bool,
    reply_count: i32,
    created_at: DateTime<Utc>,
    last_post_at: DateTime<Utc>,
    poster_name: String,
    poster_key_hash: String,
}

const THREAD_SELECT: &str = "select t.id, t.board, t.title, t.body, t.pinned, t.locked, t.removed, t.reply_count, t.created_at, t.last_post_at,
    p.name as poster_name, p.key_hash as poster_key_hash
    from forum_threads t join forum_posters p on p.id = t.poster_id";

const REMOVED: &str = "[removed by a moderator]";

fn thread_json(t: &ThreadRow, full: bool) -> Value {
    let body = if t.removed { REMOVED.to_string() } else { t.body.clone() };
    let excerpt: String = body.chars().take(180).collect();
    json!({
        "id": t.id,
        "board": t.board,
        "title": if t.removed { REMOVED.to_string() } else { t.title.clone() },
        "body": if full { Value::String(body) } else { Value::Null },
        "excerpt": excerpt,
        "author": Author { name: t.poster_name.clone(), tag: tag_for(&t.poster_key_hash) },
        "pinned": t.pinned,
        "locked": t.locked,
        "removed": t.removed,
        "reply_count": t.reply_count,
        "created_at": t.created_at,
        "last_post_at": t.last_post_at,
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ListQuery {
    board: Option<String>,
    page: Option<i64>,
}

async fn list_threads(State(state): State<AppState>, Query(query): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let board = query.board.filter(|b| BOARDS.iter().any(|(k, _)| k == b));
    let page = query.page.unwrap_or(1).clamp(1, 500);
    let rows: Vec<ThreadRow> = sqlx::query_as(&format!(
        "{THREAD_SELECT} where not t.removed and ($1::text is null or t.board = $1)
         order by t.pinned desc, t.last_post_at desc limit $2 offset $3"
    ))
    .bind(&board)
    .bind(PAGE_SIZE + 1)
    .bind((page - 1) * PAGE_SIZE)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > PAGE_SIZE;
    let items: Vec<Value> = rows.iter().take(PAGE_SIZE as usize).map(|t| thread_json(t, false)).collect();
    Ok(Json(json!({
        "items": items,
        "page": page,
        "has_more": has_more,
        "boards": BOARDS.iter().map(|(k, l)| json!({ "key": k, "label": l })).collect::<Vec<_>>(),
    })))
}

#[derive(FromRow)]
struct ReplyRow {
    id: Uuid,
    body: String,
    removed: bool,
    created_at: DateTime<Utc>,
    poster_name: String,
    poster_key_hash: String,
}

async fn get_thread(State(state): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let thread: Option<ThreadRow> = sqlx::query_as(&format!("{THREAD_SELECT} where t.id = $1")).bind(id).fetch_optional(&state.db).await?;
    let thread = thread.filter(|t| !t.removed).ok_or_else(|| AppError::not_found("that post isn't there anymore"))?;
    let replies: Vec<ReplyRow> = sqlx::query_as(
        "select r.id, r.body, r.removed, r.created_at, p.name as poster_name, p.key_hash as poster_key_hash
         from forum_replies r join forum_posters p on p.id = r.poster_id
         where r.thread_id = $1 order by r.created_at limit 1000",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let replies: Vec<Value> = replies
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "body": if r.removed { REMOVED.to_string() } else { r.body.clone() },
                "removed": r.removed,
                "author": Author { name: r.poster_name.clone(), tag: tag_for(&r.poster_key_hash) },
                "created_at": r.created_at,
            })
        })
        .collect();
    Ok(Json(json!({ "thread": thread_json(&thread, true), "replies": replies })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ThreadInput {
    key: String,
    board: String,
    title: String,
    body: String,
    website: String,
}

async fn create_thread(State(state): State<AppState>, visitor: Visitor, Json(input): Json<ThreadInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !input.website.trim().is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    ensure_can_post(&state, &poster, &visitor).await?;

    let title = input.title.trim().to_string();
    let body = input.body.trim().to_string();
    let mut e = FieldErrors::default();
    e.check(BOARDS.iter().any(|(k, _)| *k == input.board), "board", "pick a board");
    e.check(title.chars().count() >= 3, "title", "give your post a title (at least 3 characters)");
    e.check(!too_long(&title, 120), "title", "keep the title under 120 characters");
    e.check(body.chars().count() >= 10, "body", "write a little more (at least 10 characters)");
    e.check(!too_long(&body, 5000), "body", "keep it under 5000 characters");
    e.finish()?;

    if !state.limiter.check(&format!("forum-thread:{}", visitor.id), 3, Duration::from_secs(600)) {
        return Err(AppError::too_many("you're posting fast. wait a few minutes before starting another thread."));
    }
    let today: i64 = sqlx::query_scalar(
        "select count(*) from forum_threads t join forum_posters p on p.id = t.poster_id where p.visitor = $1 and t.created_at > now() - interval '1 day'",
    )
    .bind(&visitor.id)
    .fetch_one(&state.db)
    .await?;
    if today >= 15 {
        return Err(AppError::too_many("you've started a lot of threads today. try again tomorrow."));
    }

    let id = Uuid::new_v4();
    sqlx::query("insert into forum_threads (id, board, poster_id, title, body) values ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(&input.board)
        .bind(poster.id)
        .bind(&title)
        .bind(&body)
        .execute(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "id": id }))))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ReplyInput {
    key: String,
    body: String,
    website: String,
}

async fn create_reply(State(state): State<AppState>, visitor: Visitor, Path(id): Path<Uuid>, Json(input): Json<ReplyInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !input.website.trim().is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    ensure_can_post(&state, &poster, &visitor).await?;

    let body = input.body.trim().to_string();
    let mut e = FieldErrors::default();
    e.check(!body.is_empty(), "body", "write something first");
    e.check(!too_long(&body, 3000), "body", "keep replies under 3000 characters");
    e.finish()?;

    let thread: Option<(bool, bool)> = sqlx::query_as("select locked, removed from forum_threads where id = $1").bind(id).fetch_optional(&state.db).await?;
    match thread {
        None | Some((_, true)) => return Err(AppError::not_found("that post isn't there anymore")),
        Some((true, _)) => return Err(AppError::forbidden("locked", "this thread is locked, so no new replies.")),
        _ => {}
    }
    if !state.limiter.check(&format!("forum-reply:{}", visitor.id), 20, Duration::from_secs(600)) {
        return Err(AppError::too_many("you're replying fast. wait a few minutes."));
    }
    // the same message twice in a row is almost always a double click or spam
    let repeat: bool = sqlx::query_scalar("select exists(select 1 from forum_replies where poster_id = $1 and body = $2 and created_at > now() - interval '10 minutes')")
        .bind(poster.id)
        .bind(&body)
        .fetch_one(&state.db)
        .await?;
    if repeat {
        return Err(AppError::field("body", "you just posted that."));
    }

    let reply_id = Uuid::new_v4();
    sqlx::query("insert into forum_replies (id, thread_id, poster_id, body) values ($1, $2, $3, $4)")
        .bind(reply_id)
        .bind(id)
        .bind(poster.id)
        .bind(&body)
        .execute(&state.db)
        .await?;
    sqlx::query("update forum_threads set reply_count = reply_count + 1, last_post_at = now() where id = $1").bind(id).execute(&state.db).await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "id": reply_id }))))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ReportInput {
    thread_id: Option<Uuid>,
    reply_id: Option<Uuid>,
    chat_id: Option<i64>,
    reason: String,
}

async fn report(State(state): State<AppState>, visitor: Visitor, Json(input): Json<ReportInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !state.limiter.check(&format!("forum-report:{}", visitor.id), 10, Duration::from_secs(3600)) {
        return Err(AppError::too_many("you've sent a lot of reports. wait a bit."));
    }
    let reason = input.reason.trim();
    if reason.is_empty() || too_long(reason, 500) {
        return Err(AppError::field("reason", "say briefly what's wrong (up to 500 characters)"));
    }
    let targets = [input.thread_id.is_some(), input.reply_id.is_some(), input.chat_id.is_some()].iter().filter(|t| **t).count();
    if targets != 1 {
        return Err(AppError::bad_request("report one post at a time"));
    }
    sqlx::query("insert into forum_reports (id, thread_id, reply_id, chat_id, reason, visitor) values ($1, $2, $3, $4, $5, $6)")
        .bind(Uuid::new_v4())
        .bind(input.thread_id)
        .bind(input.reply_id)
        .bind(input.chat_id)
        .bind(reason)
        .bind(&visitor.id)
        .execute(&state.db)
        .await
        .map_err(|_| AppError::not_found("that post isn't there anymore"))?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

// ---------- moderation (admin only) ----------

#[derive(FromRow, Serialize)]
struct AdminPost {
    kind: String,
    id: Uuid,
    thread_id: Uuid,
    thread_title: String,
    body: String,
    removed: bool,
    pinned: bool,
    locked: bool,
    created_at: DateTime<Utc>,
    poster_id: Uuid,
    poster_name: String,
    poster_banned: bool,
}

#[derive(FromRow, Serialize)]
struct AdminReport {
    id: Uuid,
    reason: String,
    created_at: DateTime<Utc>,
    kind: String,
    post_id: Uuid,
    thread_id: Uuid,
    thread_title: String,
    body: String,
    removed: bool,
    poster_id: Uuid,
    poster_name: String,
    poster_banned: bool,
}

async fn admin_overview(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let reports: Vec<AdminReport> = sqlx::query_as(
        "select fr.id, fr.reason, fr.created_at,
                case when fr.reply_id is null then 'thread' else 'reply' end as kind,
                coalesce(fr.reply_id, fr.thread_id) as post_id,
                t.id as thread_id, t.title as thread_title,
                coalesce(r.body, t.body) as body,
                coalesce(r.removed, t.removed) as removed,
                p.id as poster_id, p.name as poster_name, p.banned as poster_banned
         from forum_reports fr
         left join forum_replies r on r.id = fr.reply_id
         join forum_threads t on t.id = coalesce(r.thread_id, fr.thread_id)
         join forum_posters p on p.id = coalesce(r.poster_id, t.poster_id)
         where fr.status = 'open' and fr.chat_id is null
         order by fr.created_at desc limit 200",
    )
    .fetch_all(&state.db)
    .await?;
    let chat: Vec<AdminChat> = sqlx::query_as(
        "select m.id, m.body, m.removed, m.created_at, p.id as poster_id, p.name as poster_name, p.banned as poster_banned,
                (select count(*) from forum_reports fr where fr.chat_id = m.id and fr.status = 'open') as open_reports,
                (select string_agg(fr.reason, ' | ') from forum_reports fr where fr.chat_id = m.id and fr.status = 'open') as report_reasons
         from chat_messages m join forum_posters p on p.id = m.poster_id
         order by (select count(*) from forum_reports fr where fr.chat_id = m.id and fr.status = 'open') > 0 desc, m.created_at desc
         limit 200",
    )
    .fetch_all(&state.db)
    .await?;
    let posts: Vec<AdminPost> = sqlx::query_as(
        "select * from (
            select 'thread' as kind, t.id, t.id as thread_id, t.title as thread_title, t.body, t.removed, t.pinned, t.locked, t.created_at,
                   p.id as poster_id, p.name as poster_name, p.banned as poster_banned
            from forum_threads t join forum_posters p on p.id = t.poster_id
            union all
            select 'reply' as kind, r.id, t.id as thread_id, t.title as thread_title, r.body, r.removed, false as pinned, false as locked, r.created_at,
                   p.id as poster_id, p.name as poster_name, p.banned as poster_banned
            from forum_replies r join forum_threads t on t.id = r.thread_id join forum_posters p on p.id = r.poster_id
         ) posts order by created_at desc limit 200",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "reports": reports, "posts": posts, "chat": chat })))
}

#[derive(FromRow, Serialize)]
struct AdminChat {
    id: i64,
    body: String,
    removed: bool,
    created_at: DateTime<Utc>,
    poster_id: Uuid,
    poster_name: String,
    poster_banned: bool,
    open_reports: i64,
    report_reasons: Option<String>,
}

async fn admin_chat(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<i64>, Json(input): Json<RemovedInput>) -> ApiResult<Json<Value>> {
    let done = sqlx::query("update chat_messages set removed = $1, removed_at = case when $1 then now() else null end where id = $2")
        .bind(input.removed)
        .bind(id)
        .execute(&state.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::not_found("that message doesn't exist"));
    }
    sqlx::query("update forum_reports set status = 'closed', closed_at = now() where chat_id = $1 and status = 'open'").bind(id).execute(&state.db).await?;
    audit(&state.db, &admin, "chat_message", &id.to_string(), if input.removed { "removed" } else { "restored" }).await;
    Ok(Json(json!({ "ok": true })))
}

// ---------- the main chat room ----------

#[derive(FromRow)]
struct ChatRow {
    id: i64,
    body: String,
    removed: bool,
    created_at: DateTime<Utc>,
    poster_name: String,
    poster_key_hash: String,
}

const CHAT_SELECT: &str = "select m.id, m.body, m.removed, m.created_at, p.name as poster_name, p.key_hash as poster_key_hash
    from chat_messages m join forum_posters p on p.id = m.poster_id";

fn chat_json(m: &ChatRow) -> Value {
    json!({
        "id": m.id,
        "body": if m.removed { REMOVED.to_string() } else { m.body.clone() },
        "removed": m.removed,
        "author": Author { name: m.poster_name.clone(), tag: tag_for(&m.poster_key_hash) },
        "created_at": m.created_at,
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ChatQuery {
    after: Option<i64>,
}

/// the app asks every few seconds for anything newer than the last message it has
async fn chat_messages(State(state): State<AppState>, Query(query): Query<ChatQuery>) -> ApiResult<Json<Value>> {
    let rows: Vec<ChatRow> = match query.after {
        Some(after) => {
            sqlx::query_as(&format!("{CHAT_SELECT} where m.id > $1 order by m.id limit 200")).bind(after).fetch_all(&state.db).await?
        }
        None => {
            let mut latest: Vec<ChatRow> = sqlx::query_as(&format!("{CHAT_SELECT} order by m.id desc limit 80")).fetch_all(&state.db).await?;
            latest.reverse();
            latest
        }
    };
    // messages a moderator removed recently, so open chats can hide them too
    let removed: Vec<i64> = sqlx::query_scalar("select id from chat_messages where removed and removed_at > now() - interval '15 minutes'")
        .fetch_all(&state.db)
        .await?;
    let latest_id = rows.last().map(|m| m.id).or(query.after).unwrap_or(0);
    Ok(Json(json!({ "messages": rows.iter().map(chat_json).collect::<Vec<_>>(), "latest_id": latest_id, "removed": removed })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ChatInput {
    key: String,
    body: String,
    website: String,
}

async fn send_chat(State(state): State<AppState>, visitor: Visitor, Json(input): Json<ChatInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !input.website.trim().is_empty() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))));
    }
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    ensure_can_post(&state, &poster, &visitor).await?;
    let body = input.body.trim().to_string();
    if body.is_empty() {
        return Err(AppError::field("body", "type a message first"));
    }
    if too_long(&body, 500) {
        return Err(AppError::field("body", "keep chat messages under 500 characters"));
    }
    if !state.limiter.check(&format!("chat-burst:{}", visitor.id), 6, Duration::from_secs(15))
        || !state.limiter.check(&format!("chat-minute:{}", visitor.id), 40, Duration::from_secs(600))
    {
        return Err(AppError::too_many("slow down a little."));
    }
    let repeat: bool = sqlx::query_scalar("select exists(select 1 from chat_messages where poster_id = $1 and body = $2 and created_at > now() - interval '1 minute')")
        .bind(poster.id)
        .bind(&body)
        .fetch_one(&state.db)
        .await?;
    if repeat {
        return Err(AppError::field("body", "you just said that."));
    }
    let id: i64 = sqlx::query_scalar("insert into chat_messages (poster_id, body) values ($1, $2) returning id")
        .bind(poster.id)
        .bind(&body)
        .fetch_one(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "id": id }))))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ThreadModeration {
    pinned: Option<bool>,
    locked: Option<bool>,
    removed: Option<bool>,
}

async fn admin_thread(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<ThreadModeration>) -> ApiResult<Json<Value>> {
    let title: Option<String> = sqlx::query_scalar(
        "update forum_threads set pinned = coalesce($1, pinned), locked = coalesce($2, locked), removed = coalesce($3, removed)
         where id = $4 returning title",
    )
    .bind(input.pinned)
    .bind(input.locked)
    .bind(input.removed)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let title = title.ok_or_else(|| AppError::not_found("that thread doesn't exist"))?;
    let what = [("pin", input.pinned), ("lock", input.locked), ("remove", input.removed)]
        .iter()
        .filter_map(|(k, v)| v.map(|v| format!("{k}={v}")))
        .collect::<Vec<_>>()
        .join(" ");
    audit(&state.db, &admin, "forum_thread", &title, &what).await;
    if input.removed == Some(true) {
        sqlx::query("update forum_reports set status = 'closed', closed_at = now() where thread_id = $1 and status = 'open'").bind(id).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RemovedInput {
    removed: bool,
}

async fn admin_reply(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<RemovedInput>) -> ApiResult<Json<Value>> {
    let done = sqlx::query("update forum_replies set removed = $1 where id = $2").bind(input.removed).bind(id).execute(&state.db).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::not_found("that reply doesn't exist"));
    }
    if input.removed {
        sqlx::query("update forum_reports set status = 'closed', closed_at = now() where reply_id = $1 and status = 'open'").bind(id).execute(&state.db).await?;
    }
    audit(&state.db, &admin, "forum_reply", &id.to_string(), if input.removed { "removed" } else { "restored" }).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct BanInput {
    banned: bool,
}

async fn admin_poster(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<BanInput>) -> ApiResult<Json<Value>> {
    let name: Option<String> = sqlx::query_scalar("update forum_posters set banned = $1 where id = $2 returning name").bind(input.banned).bind(id).fetch_optional(&state.db).await?;
    let name = name.ok_or_else(|| AppError::not_found("that person doesn't exist"))?;
    audit(&state.db, &admin, if input.banned { "forum_ban" } else { "forum_unban" }, &name, "").await;
    Ok(Json(json!({ "ok": true })))
}

async fn admin_close_report(State(state): State<AppState>, Admin(_): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    sqlx::query("update forum_reports set status = 'closed', closed_at = now() where id = $1").bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_names_are_valid() {
        for _ in 0..50 {
            let name = random_name();
            assert!(name_problem(&name).is_none(), "{name}");
        }
    }

    #[test]
    fn staff_names_are_blocked() {
        assert!(name_problem("Branch Admin").is_some());
        assert!(name_problem("drifted_real").is_some());
        assert!(name_problem("x").is_some());
        assert!(name_problem("<script>").is_some());
        assert!(name_problem("Cool Climber").is_none());
    }
}
