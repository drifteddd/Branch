use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{hash_password_async, verify_password_async};
use crate::error::{ApiResult, AppError, FieldErrors};
use crate::routes::forum::{name_problem, poster_for, valid_key, Poster};
use crate::state::AppState;
use crate::util::{sha256_hex, Visitor};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/account/me", post(me))
        .route("/api/account/signup", post(signup))
        .route("/api/account/login", post(login))
        .route("/api/account/logout", post(logout))
        .route("/api/account/password", post(change_password))
        .route("/api/account/avatar", post(set_avatar))
}

pub(crate) fn username_problem(name: &str) -> Option<&'static str> {
    if !(3..=20).contains(&name.len()) || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Some("usernames are 3 to 20 letters, numbers or _");
    }
    name_problem(name)
}

pub(crate) fn password_problem(password: &str, username: &str) -> Option<&'static str> {
    let length = password.chars().count();
    if length < 8 {
        return Some("use at least 8 characters");
    }
    if length > 200 {
        return Some("keep it under 200 characters");
    }
    if !username.is_empty() && password.to_lowercase().contains(&username.to_lowercase()) {
        return Some("don't put your username in your password");
    }
    None
}

pub(crate) async fn username_of(state: &AppState, poster_id: Uuid) -> ApiResult<Option<String>> {
    Ok(sqlx::query_scalar("select username from creator_accounts where poster_id = $1").bind(poster_id).fetch_optional(&state.db).await?)
}

pub(crate) async fn account_poster(state: &AppState, key: &str, visitor: &Visitor) -> ApiResult<(Poster, String)> {
    let poster = poster_for(state, key, visitor, true).await?;
    match username_of(state, poster.id).await? {
        Some(username) => Ok((poster, username)),
        None => Err(AppError::forbidden("account_required", "make a free creator account (just a username and password) to do this.")),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct KeyInput {
    key: String,
}

async fn me(State(state): State<AppState>, visitor: Visitor, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let Ok(poster) = poster_for(&state, &input.key, &visitor, false).await else {
        return Ok(Json(json!({ "account": null, "mods": [] })));
    };
    let account: Option<(String, DateTime<Utc>, Option<Value>)> = sqlx::query_as("select username, created_at, avatar from creator_accounts where poster_id = $1")
        .bind(poster.id)
        .fetch_optional(&state.db)
        .await?;
    let Some((username, created_at, avatar)) = account else {
        return Ok(Json(json!({ "account": null, "mods": [] })));
    };
    let mods: Vec<String> = sqlx::query_scalar("select slug from mods where uploader_poster = $1 and status in ('published', 'unpublished') order by created_at desc limit 500")
        .bind(poster.id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "account": { "username": username, "created_at": created_at, "avatar": avatar }, "mods": mods })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Credentials {
    key: String,
    username: String,
    password: String,
}

async fn signup(State(state): State<AppState>, visitor: Visitor, Json(input): Json<Credentials>) -> ApiResult<Json<Value>> {
    let username = input.username.trim().to_string();
    let mut errors = FieldErrors::default();
    if let Some(problem) = username_problem(&username) {
        errors.add("username", problem);
    }
    if let Some(problem) = password_problem(&input.password, &username) {
        errors.add("password", problem);
    }
    errors.finish()?;
    if !state.limiter.check(&format!("signup:{}", visitor.id), 5, Duration::from_secs(24 * 3600)) {
        return Err(AppError::too_many("too many new accounts from this connection today. try again tomorrow."));
    }
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    if poster.banned {
        return Err(AppError::forbidden("forum_banned", "you can't make an account right now."));
    }
    if username_of(&state, poster.id).await?.is_some() {
        return Err(AppError::forbidden("already_signed_in", "this computer is already logged in to a creator account. log out first."));
    }
    let taken: bool = sqlx::query_scalar("select exists(select 1 from creator_accounts where username_lower = $1)")
        .bind(username.to_lowercase())
        .fetch_one(&state.db)
        .await?;
    if taken {
        return Err(AppError::field("username", "that username is taken"));
    }
    let hash = hash_password_async(input.password.clone()).await?;
    let saved = sqlx::query("insert into creator_accounts (poster_id, username, username_lower, password_hash, last_login_at) values ($1, $2, $3, $4, now())")
        .bind(poster.id)
        .bind(&username)
        .bind(username.to_lowercase())
        .bind(&hash)
        .execute(&state.db)
        .await;
    if let Err(err) = saved {
        if matches!(&err, sqlx::Error::Database(db) if db.is_unique_violation()) {
            return Err(AppError::field("username", "that username is taken"));
        }
        return Err(err.into());
    }
    tracing::info!("new creator account");
    Ok(Json(json!({ "ok": true, "username": username })))
}

async fn login(State(state): State<AppState>, visitor: Visitor, Json(input): Json<Credentials>) -> ApiResult<Json<Value>> {
    if !valid_key(&input.key) {
        return Err(AppError::bad_request("the community key on this computer is broken. clear it in settings and try again."));
    }
    let username = input.username.trim().to_lowercase();
    if !state.limiter.check(&format!("account-login:{}", visitor.id), 10, Duration::from_secs(15 * 60))
        || !state.limiter.check(&format!("account-login-user:{username}"), 10, Duration::from_secs(15 * 60))
    {
        return Err(AppError::too_many("too many tries. wait 15 minutes and try again."));
    }
    let account: Option<(Uuid, String, String, bool)> = sqlx::query_as(
        "select a.poster_id, a.username, a.password_hash, p.banned from creator_accounts a join forum_posters p on p.id = a.poster_id where a.username_lower = $1",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?;
    let Some((account_id, display, hash, banned)) = account else {
        return Err(AppError::field("password", "wrong username or password"));
    };
    if input.password.is_empty() || !verify_password_async(input.password.clone(), hash).await {
        return Err(AppError::field("password", "wrong username or password"));
    }
    if banned {
        return Err(AppError::forbidden("forum_banned", "this account can't be used right now."));
    }
    let key_hash = sha256_hex(input.key.as_bytes());
    let own: Option<Uuid> = sqlx::query_scalar(
        "select p.id from forum_posters p where p.key_hash = $1 and not exists(select 1 from creator_accounts a where a.poster_id = p.id)",
    )
    .bind(&key_hash)
    .fetch_optional(&state.db)
    .await?;
    let mut tx = state.db.begin().await?;
    if let Some(own) = own.filter(|id| *id != account_id) {
        sqlx::query("update mods set uploader_poster = $1 where uploader_poster = $2").bind(account_id).bind(own).execute(&mut *tx).await?;
    }
    sqlx::query("insert into creator_logins (key_hash, poster_id) values ($1, $2) on conflict (key_hash) do update set poster_id = excluded.poster_id, created_at = now()")
        .bind(&key_hash)
        .bind(account_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("update creator_accounts set last_login_at = now() where poster_id = $1").bind(account_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "username": display })))
}

async fn logout(State(state): State<AppState>, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    if valid_key(&input.key) {
        sqlx::query("delete from creator_logins where key_hash = $1").bind(sha256_hex(input.key.as_bytes())).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub(crate) fn valid_avatar(color: &str, icon: &str) -> bool {
    let color_ok = color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    let icon_ok = (2..=20).contains(&icon.len()) && icon.chars().all(|c| c.is_ascii_alphanumeric());
    color_ok && icon_ok
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct AvatarInput {
    key: String,
    color: String,
    icon: String,
}

async fn set_avatar(State(state): State<AppState>, visitor: Visitor, Json(input): Json<AvatarInput>) -> ApiResult<Json<Value>> {
    let (poster, _) = account_poster(&state, &input.key, &visitor).await?;
    if !valid_avatar(&input.color, &input.icon) {
        return Err(AppError::bad_request("that profile picture isn't valid"));
    }
    sqlx::query("update creator_accounts set avatar = $1 where poster_id = $2")
        .bind(json!({ "color": input.color.to_lowercase(), "icon": input.icon }))
        .bind(poster.id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PasswordInput {
    key: String,
    current: String,
    password: String,
}

async fn change_password(State(state): State<AppState>, visitor: Visitor, Json(input): Json<PasswordInput>) -> ApiResult<Json<Value>> {
    let (poster, username) = account_poster(&state, &input.key, &visitor).await?;
    if !state.limiter.check(&format!("account-password:{}", poster.id), 10, Duration::from_secs(15 * 60)) {
        return Err(AppError::too_many("too many tries. wait 15 minutes and try again."));
    }
    let hash: String = sqlx::query_scalar("select password_hash from creator_accounts where poster_id = $1").bind(poster.id).fetch_one(&state.db).await?;
    if !verify_password_async(input.current.clone(), hash).await {
        return Err(AppError::field("current", "that's not your current password"));
    }
    if let Some(problem) = password_problem(&input.password, &username) {
        return Err(AppError::field("password", problem));
    }
    let new_hash = hash_password_async(input.password.clone()).await?;
    sqlx::query("update creator_accounts set password_hash = $1 where poster_id = $2").bind(&new_hash).bind(poster.id).execute(&state.db).await?;
    sqlx::query("delete from creator_logins where poster_id = $1 and key_hash <> $2")
        .bind(poster.id)
        .bind(sha256_hex(input.key.as_bytes()))
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::{password_problem, username_problem};

    #[test]
    fn usernames_are_checked() {
        assert!(username_problem("Hat_Maker").is_none());
        assert!(username_problem("ab").is_some());
        assert!(username_problem("has space").is_some());
        assert!(username_problem("BranchAdmin").is_some());
    }

    #[test]
    fn avatars_are_checked() {
        assert!(super::valid_avatar("#1fa889", "sprout"));
        assert!(!super::valid_avatar("red", "sprout"));
        assert!(!super::valid_avatar("#1fa889", "<script>"));
    }

    #[test]
    fn passwords_are_checked() {
        assert!(password_problem("correct horse", "monkey").is_none());
        assert!(password_problem("short", "monkey").is_some());
        assert!(password_problem("iammonkey123", "Monkey").is_some());
    }
}
