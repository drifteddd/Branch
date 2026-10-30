use std::collections::BTreeMap;
use std::fmt::Display;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub fields: Option<BTreeMap<String, String>>,
}

pub type ApiResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), fields: None }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "you need to log in again")
    }

    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn too_many(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", message)
    }

    pub fn validation(fields: BTreeMap<String, String>) -> Self {
        let message = fields.values().next().cloned().unwrap_or_else(|| "some fields need fixing".into());
        Self { status: StatusCode::UNPROCESSABLE_ENTITY, code: "validation", message, fields: Some(fields) }
    }

    pub fn field(field: &str, message: &str) -> Self {
        let mut fields = BTreeMap::new();
        fields.insert(field.to_string(), message.to_string());
        Self::validation(fields)
    }

    pub fn internal(err: impl Display) -> Self {
        tracing::error!(error = %err, "internal error");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "something went wrong on the server. try again in a moment.")
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = json!({ "error": self.message, "code": self.code, "fields": self.fields });
        (self.status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::internal(err)
    }
}

impl From<object_store::Error> for AppError {
    fn from(err: object_store::Error) -> Self {
        match err {
            object_store::Error::NotFound { .. } => AppError::not_found("that file is missing from storage"),
            other => AppError::internal(other),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::internal(err)
    }
}

#[derive(Default)]
pub struct FieldErrors(BTreeMap<String, String>);

impl FieldErrors {
    pub fn add(&mut self, field: &str, message: &str) {
        self.0.entry(field.to_string()).or_insert_with(|| message.to_string());
    }

    pub fn check(&mut self, ok: bool, field: &str, message: &str) {
        if !ok {
            self.add(field, message);
        }
    }

    pub fn finish(self) -> ApiResult<()> {
        if self.0.is_empty() { Ok(()) } else { Err(AppError::validation(self.0)) }
    }
}
