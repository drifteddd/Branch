use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::state::AppState;

pub const BLOCK_HOURS: i64 = 24;
pub const BLOCKED_MESSAGE: &str = "Branch isn't available on your connection right now. we noticed unusual activity from your network, so access is paused while we review it. if you think this is a mistake, email drifted1000@outlook.com.";

const FLOOD_PER_MINUTE: u32 = 1500;
const REJECTIONS_PER_10_MIN: u32 = 40;

static BLOCKED: LazyLock<RwLock<HashMap<String, DateTime<Utc>>>> = LazyLock::new(|| RwLock::new(HashMap::new()));

pub async fn load(db: &PgPool) -> Result<(), sqlx::Error> {
    let rows: Vec<(String, DateTime<Utc>)> = sqlx::query_as("select visitor, expires_at from blocked_visitors where expires_at > now()").fetch_all(db).await?;
    if let Ok(mut map) = BLOCKED.write() {
        map.clear();
        map.extend(rows);
    }
    Ok(())
}

pub fn is_blocked(visitor: &str) -> bool {
    let Ok(map) = BLOCKED.read() else { return false };
    map.get(visitor).is_some_and(|until| *until > Utc::now())
}

pub fn unblock_local(visitor: &str) {
    if let Ok(mut map) = BLOCKED.write() {
        map.remove(visitor);
    }
}

pub async fn block(state: &AppState, visitor: &str, reason: &str) {
    if is_blocked(visitor) {
        return;
    }
    let until = Utc::now() + chrono::Duration::hours(BLOCK_HOURS);
    if let Ok(mut map) = BLOCKED.write() {
        map.insert(visitor.to_string(), until);
    }
    tracing::warn!(reason, "blocked a connection that looked like a flood");
    let saved = sqlx::query(
        "insert into blocked_visitors (visitor, reason, expires_at) values ($1, $2, $3)
         on conflict (visitor) do update set reason = excluded.reason, blocked_at = now(), expires_at = excluded.expires_at",
    )
    .bind(visitor)
    .bind(reason)
    .bind(until)
    .execute(&state.db)
    .await;
    if let Err(err) = saved {
        tracing::warn!(error = %err, "couldn't save a block");
    }
}

pub fn too_many_requests(state: &AppState, visitor: &str) -> bool {
    !state.limiter.check(&format!("flood:{visitor}"), FLOOD_PER_MINUTE, Duration::from_secs(60))
}

pub fn too_many_rejections(state: &AppState, visitor: &str) -> bool {
    !state.limiter.check(&format!("rejected:{visitor}"), REJECTIONS_PER_10_MIN, Duration::from_secs(600))
}

pub fn exempt(path: &str) -> bool {
    path == "/health" || path == "/admin" || path.starts_with("/admin/") || path.starts_with("/api/admin")
}
