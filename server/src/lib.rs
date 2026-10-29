pub mod admin_ui;
pub mod auth;
pub mod config;
pub mod error;
pub mod models;
pub mod ratelimit;
pub mod routes;
pub mod state;
pub mod storage;
pub mod uploads;
pub mod util;

use std::net::{Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use rand::RngCore;
use sqlx::postgres::PgPoolOptions;

use crate::config::Config;
use crate::ratelimit::RateLimiter;
use crate::state::AppState;

/// connects to everything, runs migrations and makes sure the first admin exists.
/// tests use this too, so they run against the exact same setup.
pub async fn build_state(config: Config) -> anyhow::Result<AppState> {
    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
        .context("couldn't connect to the database. check DATABASE_URL")?;

    sqlx::migrate!("./migrations").run(&db).await.context("the database migration failed")?;
    auth::bootstrap_admin(&db, &config).await?;
    let store = storage::build(&config)?;

    let mut random = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let dummy_hash = auth::hash_password(&hex::encode(random))?;

    Ok(AppState {
        db,
        store,
        config: Arc::new(config),
        limiter: Arc::new(RateLimiter::new()),
        dummy_hash: Arc::new(dummy_hash),
    })
}

pub async fn run(config: Config) -> anyhow::Result<()> {
    let port = config.port;
    let state = build_state(config).await?;
    spawn_cleanup(state.clone());

    let app = routes::router(state);
    // listening on [::] accepts ipv4 and ipv6, which railway's private network needs
    let addr = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("couldn't listen on port {port}"))?;
    tracing::info!("branch server is listening on port {port}");

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// hourly housekeeping. this is what keeps the privacy notice true:
/// download records go after 30 days, closed reports after 180.
fn spawn_cleanup(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let jobs = [
                "delete from admin_sessions where expires_at < now() or last_seen_at < now() - interval '1 day'",
                "delete from download_events where day < current_date - 30",
                "delete from reports where status <> 'open' and resolved_at < now() - interval '180 days'",
            ];
            for sql in jobs {
                if let Err(err) = sqlx::query(sql).execute(&state.db).await {
                    tracing::warn!(error = %err, "cleanup job failed");
                }
            }
            state.limiter.prune(Duration::from_secs(2 * 3600));
        }
    });
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
