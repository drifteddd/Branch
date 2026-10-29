// the admin panel is a small web page built into the server binary.
// it shares the design tokens and markdown renderer with the desktop app.

use axum::http::{header, HeaderName};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::state::AppState;

const INDEX_HTML: &str = include_str!("../admin/index.html");
const ADMIN_JS: &str = include_str!("../admin/admin.js");
const ADMIN_CSS: &str = include_str!("../admin/admin.css");
const TOKENS_CSS: &str = include_str!("../../app/ui/shared/tokens.css");
const MARKDOWN_JS: &str = include_str!("../../app/ui/shared/markdown.js");
const SOURCE_VIEWER_JS: &str = include_str!("../../app/ui/shared/source-viewer.js");
const MARK_SVG: &str = include_str!("../../app/ui/shared/branch-mark.svg");

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://api.github.com; \
                   frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";

fn asset(body: &'static str, content_type: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
            (HeaderName::from_static("content-security-policy"), CSP),
        ],
        body,
    )
        .into_response()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(|| async { asset("Branch API. the Branch app is a Windows program, this server only feeds it.", "text/plain; charset=utf-8") }))
        .route("/admin", get(|| async { asset(INDEX_HTML, "text/html; charset=utf-8") }))
        .route("/admin/", get(|| async { asset(INDEX_HTML, "text/html; charset=utf-8") }))
        .route("/admin/admin.js", get(|| async { asset(ADMIN_JS, "text/javascript; charset=utf-8") }))
        .route("/admin/admin.css", get(|| async { asset(ADMIN_CSS, "text/css; charset=utf-8") }))
        .route("/shared/tokens.css", get(|| async { asset(TOKENS_CSS, "text/css; charset=utf-8") }))
        .route("/shared/markdown.js", get(|| async { asset(MARKDOWN_JS, "text/javascript; charset=utf-8") }))
        .route("/shared/source-viewer.js", get(|| async { asset(SOURCE_VIEWER_JS, "text/javascript; charset=utf-8") }))
        .route("/shared/branch-mark.svg", get(|| async { asset(MARK_SVG, "image/svg+xml") }))
}
