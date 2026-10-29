use std::sync::Arc;

use object_store::ObjectStore;
use sqlx::PgPool;

use crate::config::Config;
use crate::ratelimit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub store: Arc<dyn ObjectStore>,
    pub config: Arc<Config>,
    pub limiter: Arc<RateLimiter>,
    /// a real argon2 hash of a random password. logins for unknown usernames still
    /// check against it, so response times don't reveal which usernames exist.
    pub dummy_hash: Arc<String>,
    /// for calling the ai provider. it only ever talks to the fixed siliconflow address.
    pub http: reqwest::Client,
}
