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
    pub dummy_hash: Arc<String>,
    pub http: reqwest::Client,
}
