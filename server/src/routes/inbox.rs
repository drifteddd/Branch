use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{audit, Admin};
use crate::error::{ApiResult, AppError, FieldErrors};
use crate::state::AppState;
use crate::util::{too_long, Visitor};

const RELEASES_URL: &str = "https://api.github.com/repos/drifteddd/Branch/releases?per_page=10";
const RELEASES_FEED: &str = "https://github.com/drifteddd/Branch/releases.atom";

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else { break };
        let tag = rest[start + 1..start + end].trim().to_lowercase();
        if tag == "li" {
            out.push_str("\n- ");
        } else if tag == "/p" || tag == "br" || tag == "br/" || tag == "/ul" {
            out.push('\n');
        } else if tag == "strong" || tag == "/strong" || tag == "b" || tag == "/b" {
            out.push_str("**");
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    unescape(&out).lines().map(str::trim_end).filter(|l| !l.contains("Download **")).collect::<Vec<_>>().join("\n").trim().to_string()
}

pub(crate) fn parse_feed(feed: &str) -> Vec<Value> {
    feed.split("<entry>")
        .skip(1)
        .take(10)
        .filter_map(|entry| {
            let title = unescape(between(entry, "<title>", "</title>")?.trim());
            let updated = between(entry, "<updated>", "</updated>")?.trim().to_string();
            let link = between(entry, "href=\"", "\"").unwrap_or("").to_string();
            let version = link.rsplit('/').next().unwrap_or("").trim_start_matches('v').to_string();
            let notes = between(entry, "<content type=\"html\">", "</content>").map(|c| html_to_text(&unescape(c))).unwrap_or_default();
            Some(json!({ "id": link, "version": version, "title": title, "notes": notes, "published_at": updated, "url": link }))
        })
        .collect()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/inbox", post(inbox))
        .route("/api/admin/announcements", get(list_announcements).post(create_announcement))
        .route("/api/admin/announcements/{id}", delete(delete_announcement))
}

#[derive(FromRow, Serialize)]
struct Announcement {
    id: Uuid,
    title: String,
    body: String,
    kind: String,
    created_at: DateTime<Utc>,
}

#[derive(FromRow, Serialize)]
struct MyReport {
    id: Uuid,
    mod_name: String,
    mod_slug: Option<String>,
    reason: String,
    status: String,
    reply: String,
    created_at: DateTime<Utc>,
    resolved_at: Option<DateTime<Utc>>,
}

static RELEASES: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
static LAST_TRY: Mutex<Option<Instant>> = Mutex::new(None);

async fn releases(state: &AppState) -> Value {
    if let Ok(cache) = RELEASES.lock() {
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return value.clone();
            }
        }
    }
    if let Ok(mut last) = LAST_TRY.lock() {
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(120)) {
            return RELEASES.lock().ok().and_then(|c| c.as_ref().map(|(_, v)| v.clone())).unwrap_or_else(|| json!([]));
        }
        *last = Some(Instant::now());
    }
    let from_api = async {
        let response = state
            .http
            .get(RELEASES_URL)
            .header("User-Agent", "branch-server")
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let list: Value = response.json().await.ok()?;
        let items: Vec<Value> = list
            .as_array()?
            .iter()
            .filter(|r| r.get("draft").and_then(|d| d.as_bool()) != Some(true))
            .map(|r| {
                json!({
                    "id": r.get("id"),
                    "version": r.get("tag_name").and_then(|t| t.as_str()).unwrap_or("").trim_start_matches('v'),
                    "title": r.get("name"),
                    "notes": r.get("body").and_then(|b| b.as_str()).map(|b| b.split("\n\nDownload **").next().unwrap_or(b).trim().to_string()),
                    "published_at": r.get("published_at"),
                    "url": r.get("html_url"),
                })
            })
            .collect();
        Some(Value::Array(items))
    }
    .await;
    let fetched = match from_api {
        Some(v) => Some(v),
        None => async {
            let response = state.http.get(RELEASES_FEED).header("User-Agent", "branch-server").timeout(Duration::from_secs(10)).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let items = parse_feed(&response.text().await.ok()?);
            (!items.is_empty()).then(|| Value::Array(items))
        }
        .await,
    };
    match fetched {
        Some(value) => {
            if let Ok(mut cache) = RELEASES.lock() {
                *cache = Some((Instant::now(), value.clone()));
            }
            value
        }
        None => RELEASES.lock().ok().and_then(|c| c.as_ref().map(|(_, v)| v.clone())).unwrap_or_else(|| json!([])),
    }
}

#[derive(Deserialize)]
struct InboxInput {
    #[serde(default)]
    key: String,
}

async fn inbox(State(state): State<AppState>, visitor: Visitor, Json(input): Json<InboxInput>) -> ApiResult<Json<Value>> {
    let announcements: Vec<Announcement> =
        sqlx::query_as("select id, title, body, kind, created_at from announcements order by created_at desc limit 50").fetch_all(&state.db).await?;
    let reports: Vec<MyReport> = if input.key.trim().is_empty() {
        Vec::new()
    } else {
        match crate::routes::forum::poster_for(&state, input.key.trim(), &visitor, false).await {
            Ok(poster) => {
                sqlx::query_as(
                    "select r.id, r.mod_name, m.slug as mod_slug, r.reason, r.status, r.reply, r.created_at, r.resolved_at
                     from reports r left join mods m on m.id = r.mod_id
                     where r.poster_id = $1 order by r.created_at desc limit 30",
                )
                .bind(poster.id)
                .fetch_all(&state.db)
                .await?
            }
            Err(_) => Vec::new(),
        }
    };
    Ok(Json(json!({ "announcements": announcements, "reports": reports, "releases": releases(&state).await })))
}

async fn list_announcements(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let items: Vec<Announcement> =
        sqlx::query_as("select id, title, body, kind, created_at from announcements order by created_at desc limit 200").fetch_all(&state.db).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
struct NewAnnouncement {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    kind: String,
}

async fn create_announcement(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<NewAnnouncement>) -> ApiResult<Json<Value>> {
    let title = input.title.trim();
    let body = input.body.trim();
    let kind = if input.kind.is_empty() { "announcement" } else { input.kind.as_str() };
    let mut errors = FieldErrors::default();
    errors.check(title.chars().count() >= 2, "title", "give it a title");
    errors.check(!too_long(title, 120), "title", "keep the title under 120 characters");
    errors.check(!too_long(body, 5000), "body", "keep the message under 5000 characters");
    errors.check(matches!(kind, "announcement" | "update" | "notice"), "kind", "pick a type");
    errors.finish()?;
    let id = Uuid::new_v4();
    sqlx::query("insert into announcements (id, title, body, kind, created_by) values ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(title)
        .bind(body)
        .bind(kind)
        .bind(admin.id)
        .execute(&state.db)
        .await?;
    audit(&state.db, &admin, "create_announcement", title, kind).await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

async fn delete_announcement(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let title: Option<String> = sqlx::query_scalar("delete from announcements where id = $1 returning title").bind(id).fetch_optional(&state.db).await?;
    let title = title.ok_or_else(|| AppError::not_found("that announcement doesn't exist"))?;
    audit(&state.db, &admin, "delete_announcement", &title, "").await;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::parse_feed;

    #[test]
    fn reads_the_release_feed() {
        let feed = r#"<feed><entry><id>tag:github.com,2008:Repository/1/v1.0.21</id><updated>2026-10-31T10:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/drifteddd/Branch/releases/tag/v1.0.21"/><title>Branch 1.0.21</title><content type="html">&lt;ul&gt;&lt;li&gt;New Inbox&lt;/li&gt;&lt;li&gt;Better tree&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Download &lt;strong&gt;Branch_1.0.21_x64-setup.exe&lt;/strong&gt; below.&lt;/p&gt;</content></entry></feed>"#;
        let items = parse_feed(feed);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["version"], "1.0.21");
        assert_eq!(items[0]["title"], "Branch 1.0.21");
        assert_eq!(items[0]["notes"], "- New Inbox\n- Better tree");
    }
}
