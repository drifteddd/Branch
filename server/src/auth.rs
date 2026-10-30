use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use rand::RngCore;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::util::sha256_hex;

pub const SESSION_COOKIE: &str = "branch_session";
pub const SESSION_HOURS: i64 = 12;
pub const IDLE_MINUTES: i32 = 120;
pub const ADMIN_HEADER: &str = "x-branch-admin";

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("couldn't hash password: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

pub async fn hash_password_async(password: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(AppError::internal)?
        .map_err(AppError::internal)
}

pub async fn verify_password_async(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || verify_password(&password, &hash)).await.unwrap_or(false)
}

pub fn password_problem(password: &str, username: &str) -> Option<&'static str> {
    let length = password.chars().count();
    if length < 12 {
        return Some("use at least 12 characters");
    }
    if length > 200 {
        return Some("that's too long. keep it under 200 characters");
    }
    if password.to_lowercase().contains(&username.to_lowercase()) {
        return Some("don't put your username in your password");
    }
    None
}

pub fn new_session_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let hash = sha256_hex(token.as_bytes());
    (token, hash)
}

pub fn session_cookie(token: &str, secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
        SESSION_HOURS * 3600,
        if secure { "; Secure" } else { "" }
    )
}

pub fn clear_session_cookie(secure: bool) -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}", if secure { "; Secure" } else { "" })
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

pub fn require_admin_header(headers: &HeaderMap) -> ApiResult<()> {
    if headers.get(ADMIN_HEADER).and_then(|v| v.to_str().ok()) == Some("1") {
        Ok(())
    } else {
        Err(AppError::forbidden("missing_header", "this request has to come from the admin panel"))
    }
}

#[derive(Clone, Debug)]
pub struct AdminUser {
    pub id: Uuid,
    pub username: String,
    pub must_change_password: bool,
    pub token_hash: String,
}

pub struct AnyAdmin(pub AdminUser);

pub struct Admin(pub AdminUser);

async fn load_admin(parts: &Parts, state: &AppState) -> ApiResult<AdminUser> {
    require_admin_header(&parts.headers)?;
    let token = cookie_value(&parts.headers, SESSION_COOKIE).ok_or_else(AppError::unauthorized)?;
    let token_hash = sha256_hex(token.as_bytes());

    let row: Option<(Uuid, String, bool, DateTime<Utc>)> = sqlx::query_as(
        "select a.id, a.username, a.must_change_password, s.last_seen_at
         from admin_sessions s join admins a on a.id = s.admin_id
         where s.token_hash = $1
           and s.expires_at > now()
           and s.last_seen_at > now() - make_interval(mins => $2)",
    )
    .bind(&token_hash)
    .bind(IDLE_MINUTES)
    .fetch_optional(&state.db)
    .await?;

    let Some((id, username, must_change_password, last_seen)) = row else {
        return Err(AppError::unauthorized());
    };

    if Utc::now() - last_seen > chrono::Duration::minutes(5) {
        sqlx::query("update admin_sessions set last_seen_at = now() where token_hash = $1")
            .bind(&token_hash)
            .execute(&state.db)
            .await?;
    }

    Ok(AdminUser { id, username, must_change_password, token_hash })
}

impl FromRequestParts<AppState> for AnyAdmin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(AnyAdmin(load_admin(parts, state).await?))
    }
}

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let user = load_admin(parts, state).await?;
        if user.must_change_password {
            return Err(AppError::forbidden("password_change_required", "change the starting password before doing anything else"));
        }
        Ok(Admin(user))
    }
}

pub async fn audit(db: &PgPool, admin: &AdminUser, action: &str, target: &str, details: impl Into<String>) {
    let details: String = details.into();
    let result = sqlx::query("insert into audit_log (admin_id, admin_username, action, target, details) values ($1, $2, $3, $4, $5)")
        .bind(admin.id)
        .bind(&admin.username)
        .bind(action)
        .bind(target)
        .bind(details)
        .execute(db)
        .await;
    if let Err(err) = result {
        tracing::error!(error = %err, action, "couldn't write to the audit log");
    }
}

pub async fn bootstrap_admin(db: &PgPool, config: &Config) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("select count(*) from admins").fetch_one(db).await?;

    match (&config.bootstrap_username, &config.bootstrap_password) {
        (Some(username), Some(password)) if count == 0 => {
            let username = username.trim().to_lowercase();
            if username.len() < 3 || username.len() > 64 || !username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
                anyhow::bail!("ADMIN_BOOTSTRAP_USERNAME can only use letters, numbers, dots, dashes and underscores (3-64 characters)");
            }
            if password.chars().count() < 8 {
                anyhow::bail!("ADMIN_BOOTSTRAP_PASSWORD has to be at least 8 characters");
            }
            let hash = hash_password(password)?;
            sqlx::query("insert into admins (id, username, password_hash, must_change_password) values ($1, $2, $3, true)")
                .bind(Uuid::new_v4())
                .bind(&username)
                .bind(hash)
                .execute(db)
                .await?;
            tracing::warn!("first account created");
        }
        (None, Some(_)) if count == 0 => {
            tracing::warn!("first account not created: username missing");
        }
        (_, Some(_)) => {
            tracing::warn!("first-account settings ignored: an account already exists");
        }
        _ if count == 0 => {
            tracing::warn!("no accounts exist yet");
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_round_trip() {
        let hash = hash_password("correct horse battery").unwrap();
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(!verify_password("x", "not a hash"));
    }

    #[test]
    fn cookies_are_parsed() {
        let mut headers = HeaderMap::new();
        headers.insert("cookie", "a=1; branch_session=abc; b=2".parse().unwrap());
        assert_eq!(cookie_value(&headers, SESSION_COOKIE).as_deref(), Some("abc"));
    }

    #[test]
    fn password_rules() {
        assert!(password_problem("short", "meganight32").is_some());
        assert!(password_problem("meganight32-is-great", "meganight32").is_some());
        assert!(password_problem("a long enough passphrase", "meganight32").is_none());
    }
}
