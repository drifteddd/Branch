pub mod admin;
pub mod public;

use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::admin_ui;
use crate::error::AppError;
use crate::state::AppState;
use crate::util::Visitor;

pub fn router(state: AppState) -> Router {
    let public = Router::new()
        .route("/api/meta", get(public::meta))
        .route("/api/mods", get(public::list_mods))
        .route("/api/mods/{slug}", get(public::mod_detail))
        .route("/api/releases/{id}/download", get(public::download))
        .route("/api/releases/{id}/out", get(public::outbound))
        .route("/api/reports", post(public::create_report))
        .route("/files/{*key}", get(public::file));

    Router::new()
        .route("/health", get(public::health))
        .merge(public)
        .merge(admin::router())
        .merge(admin_ui::router())
        .layer(middleware::from_fn_with_state(state.clone(), rate_limit))
        // small json bodies everywhere. the upload routes raise this for themselves.
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .with_state(state)
}

/// a general limit so one visitor can't flood the server
async fn rate_limit(State(state): State<AppState>, visitor: Visitor, request: Request, next: Next) -> Response {
    if request.uri().path() != "/health" && !state.limiter.check(&format!("all:{}", visitor.id), 600, Duration::from_secs(60)) {
        return AppError::too_many("too many requests. slow down a little and try again.").into_response();
    }
    next.run(request).await
}
