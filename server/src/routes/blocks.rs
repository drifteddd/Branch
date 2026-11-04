use axum::extract::{Path, State};
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::auth::{audit, Admin};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/blocks", get(list))
        .route("/api/admin/blocks/{visitor}", delete(unblock))
}

async fn list(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, DateTime<Utc>, DateTime<Utc>)> =
        sqlx::query_as("select visitor, reason, blocked_at, expires_at from blocked_visitors where expires_at > now() order by blocked_at desc limit 500")
            .fetch_all(&state.db)
            .await?;
    let blocks: Vec<Value> = rows
        .into_iter()
        .map(|(visitor, reason, blocked_at, expires_at)| json!({ "visitor": visitor, "short": visitor.chars().take(10).collect::<String>(), "reason": reason, "blocked_at": blocked_at, "expires_at": expires_at }))
        .collect();
    Ok(Json(json!({ "blocks": blocks, "hours": crate::shield::BLOCK_HOURS })))
}

async fn unblock(State(state): State<AppState>, Admin(admin): Admin, Path(visitor): Path<String>) -> ApiResult<Json<Value>> {
    let removed = sqlx::query("delete from blocked_visitors where visitor = $1").bind(&visitor).execute(&state.db).await?.rows_affected();
    if removed == 0 {
        return Err(AppError::not_found("that connection isn't blocked"));
    }
    crate::shield::unblock_local(&visitor);
    state.limiter.reset(&format!("rejected:{visitor}"));
    state.limiter.reset(&format!("flood:{visitor}"));
    audit(&state.db, &admin, "unblock_connection", &visitor.chars().take(10).collect::<String>(), "").await;
    Ok(Json(json!({ "ok": true })))
}
