use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{audit, Admin};
use crate::error::{ApiResult, AppError, FieldErrors};
use crate::state::AppState;
use crate::util::{too_long, Visitor};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/polls", get(list))
        .route("/api/polls/{id}/vote", post(vote))
        .route("/api/admin/polls", get(admin_list).post(create))
        .route("/api/admin/polls/{id}", post(admin_update).delete(remove))
}

#[derive(FromRow)]
struct PollRow {
    id: Uuid,
    question: String,
    closed: bool,
    closes_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct OptionRow {
    id: Uuid,
    poll_id: Uuid,
    label: String,
    votes: i64,
}

#[derive(Serialize)]
struct PollOut {
    id: Uuid,
    question: String,
    open: bool,
    closes_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    total: i64,
    my_vote: Option<Uuid>,
    options: Vec<Value>,
}

async fn load(state: &AppState, voter: Option<&str>, limit: i64) -> ApiResult<Vec<PollOut>> {
    let polls: Vec<PollRow> = sqlx::query_as("select id, question, closed, closes_at, created_at from polls order by created_at desc limit $1")
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    let ids: Vec<Uuid> = polls.iter().map(|p| p.id).collect();
    let options: Vec<OptionRow> = sqlx::query_as(
        "select o.id, o.poll_id, o.label, count(v.voter) as votes
         from poll_options o left join poll_votes v on v.option_id = o.id
         where o.poll_id = any($1) group by o.id order by o.sort_order",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let mine: Vec<(Uuid, Uuid)> = match voter {
        Some(v) => sqlx::query_as("select poll_id, option_id from poll_votes where voter = $1 and poll_id = any($2)").bind(v).bind(&ids).fetch_all(&state.db).await?,
        None => Vec::new(),
    };
    let now = Utc::now();
    Ok(polls
        .into_iter()
        .map(|p| {
            let opts: Vec<&OptionRow> = options.iter().filter(|o| o.poll_id == p.id).collect();
            PollOut {
                open: !p.closed && p.closes_at.is_none_or(|c| c > now),
                total: opts.iter().map(|o| o.votes).sum(),
                my_vote: mine.iter().find(|(pid, _)| *pid == p.id).map(|(_, o)| *o),
                options: opts.iter().map(|o| json!({ "id": o.id, "label": o.label, "votes": o.votes })).collect(),
                id: p.id,
                question: p.question,
                closes_at: p.closes_at,
                created_at: p.created_at,
            }
        })
        .collect())
}

async fn list(State(state): State<AppState>, visitor: Visitor) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "polls": load(&state, Some(&visitor.id), 20).await? })))
}

#[derive(Deserialize)]
struct VoteInput {
    option_id: Uuid,
}

async fn vote(State(state): State<AppState>, visitor: Visitor, Path(id): Path<Uuid>, Json(input): Json<VoteInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("poll-vote:{}", visitor.id), 60, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little and try again in a few minutes."));
    }
    let poll: Option<(bool, Option<DateTime<Utc>>)> = sqlx::query_as("select closed, closes_at from polls where id = $1").bind(id).fetch_optional(&state.db).await?;
    let Some((closed, closes_at)) = poll else { return Err(AppError::not_found("that poll doesn't exist")) };
    if closed || closes_at.is_some_and(|c| c <= Utc::now()) {
        return Err(AppError::bad_request("this poll has closed"));
    }
    let valid: bool = sqlx::query_scalar("select exists(select 1 from poll_options where id = $1 and poll_id = $2)").bind(input.option_id).bind(id).fetch_one(&state.db).await?;
    if !valid {
        return Err(AppError::bad_request("that option isn't part of this poll"));
    }
    sqlx::query(
        "insert into poll_votes (poll_id, voter, option_id) values ($1, $2, $3)
         on conflict (poll_id, voter) do update set option_id = excluded.option_id, created_at = now()",
    )
    .bind(id)
    .bind(&visitor.id)
    .bind(input.option_id)
    .execute(&state.db)
    .await?;
    let polls = load(&state, Some(&visitor.id), 50).await?;
    let poll = polls.into_iter().find(|p| p.id == id);
    Ok(Json(json!({ "poll": poll })))
}

async fn admin_list(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "polls": load(&state, None, 200).await? })))
}

#[derive(Deserialize)]
struct NewPoll {
    question: String,
    options: Vec<String>,
    #[serde(default)]
    days: Option<i64>,
}

async fn create(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<NewPoll>) -> ApiResult<Json<Value>> {
    let question = input.question.trim();
    let options: Vec<String> = input.options.iter().map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect();
    let mut errors = FieldErrors::default();
    errors.check(question.chars().count() >= 3, "question", "write a question");
    errors.check(!too_long(question, 200), "question", "keep the question under 200 characters");
    errors.check(options.len() >= 2, "options", "add at least 2 options");
    errors.check(options.len() <= 8, "options", "use 8 options or fewer");
    errors.check(options.iter().all(|o| !too_long(o, 80)), "options", "keep each option under 80 characters");
    errors.check(input.days.is_none_or(|d| (1..=90).contains(&d)), "days", "pick between 1 and 90 days");
    errors.finish()?;
    let id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    sqlx::query("insert into polls (id, question, closes_at, created_by) values ($1, $2, case when $3::bigint is null then null else now() + make_interval(days => $3::int) end, $4)")
        .bind(id)
        .bind(question)
        .bind(input.days)
        .bind(admin.id)
        .execute(&mut *tx)
        .await?;
    for (i, label) in options.iter().enumerate() {
        sqlx::query("insert into poll_options (id, poll_id, label, sort_order) values ($1, $2, $3, $4)")
            .bind(Uuid::new_v4())
            .bind(id)
            .bind(label)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    audit(&state.db, &admin, "create_poll", question, &options.join(" / ")).await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

#[derive(Deserialize)]
struct PollUpdate {
    closed: bool,
}

async fn admin_update(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<PollUpdate>) -> ApiResult<Json<Value>> {
    let question: Option<String> = sqlx::query_scalar("update polls set closed = $1, closes_at = case when $1 then closes_at else null end where id = $2 returning question")
        .bind(input.closed)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let question = question.ok_or_else(|| AppError::not_found("that poll doesn't exist"))?;
    audit(&state.db, &admin, if input.closed { "close_poll" } else { "reopen_poll" }, &question, "").await;
    Ok(Json(json!({ "ok": true })))
}

async fn remove(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let question: Option<String> = sqlx::query_scalar("delete from polls where id = $1 returning question").bind(id).fetch_optional(&state.db).await?;
    let question = question.ok_or_else(|| AppError::not_found("that poll doesn't exist"))?;
    audit(&state.db, &admin, "delete_poll", &question, "").await;
    Ok(Json(json!({ "ok": true })))
}
