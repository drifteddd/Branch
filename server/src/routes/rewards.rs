use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{audit, Admin};
use crate::error::{ApiResult, AppError};
use crate::routes::forum::poster_for;
use crate::routes::public::take_ai_budget;
use crate::scan::similarity;
use crate::state::AppState;
use crate::util::Visitor;

pub const PER_MOD: i32 = 10;
pub const DAILY_LIMIT: i32 = 50;
pub const TOTAL_LIMIT: i32 = 500;
pub const THRESHOLD: i64 = 10;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/rewards/me", post(me))
        .route("/api/rewards/apply", post(apply))
        .route("/api/admin/rewards", axum::routing::get(admin_overview))
        .route("/api/admin/rewards/settings", post(admin_settings))
        .route("/api/admin/rewards/members/{id}", post(admin_decide))
        .route("/api/admin/rewards/members/{id}/paid", post(admin_mark_paid))
        .route("/api/admin/rewards/events/{id}", post(admin_event))
}

pub async fn rewards_enabled(state: &AppState) -> ApiResult<bool> {
    let value: Option<Value> = sqlx::query_scalar("select value from app_settings where key = 'rewards_enabled'").fetch_optional(&state.db).await?;
    Ok(value.and_then(|v| v.as_bool()).unwrap_or(false))
}

pub struct UniqueCheck {
    pub unique: bool,
    pub message: String,
}

#[derive(FromRow)]
struct FingerprintRow {
    id: Uuid,
    name: String,
    summary: String,
    code_fingerprint: Vec<String>,
}

pub async fn check_upload_unique(state: &AppState, sha256: &str, name: &str, description: &str, fingerprint: &[String]) -> ApiResult<UniqueCheck> {
    let exact: Option<String> = sqlx::query_scalar(
        "select m.name from releases r join mods m on m.id = r.mod_id where r.file_sha256 = $1 and m.status <> 'archived' limit 1",
    )
    .bind(sha256)
    .fetch_optional(&state.db)
    .await?;
    if let Some(existing) = exact {
        return Ok(UniqueCheck { unique: false, message: format!("this exact file is already on Branch as \"{existing}\". only new, unique mods can be uploaded.") });
    }

    let rows: Vec<FingerprintRow> = sqlx::query_as(
        "select id, name, summary, code_fingerprint from mods where status in ('published', 'unpublished', 'draft') order by created_at desc limit 5000",
    )
    .fetch_all(&state.db)
    .await?;
    let mut candidates: Vec<(f32, &FingerprintRow)> = rows
        .iter()
        .map(|r| (similarity(fingerprint, &r.code_fingerprint), r))
        .filter(|(sim, r)| *sim >= 0.45 || r.name.trim().eq_ignore_ascii_case(name.trim()))
        .collect();
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(3);
    if candidates.is_empty() {
        return Ok(UniqueCheck { unique: true, message: String::new() });
    }

    if take_ai_budget(state).await? {
        let payload = json!({
            "new_mod": { "name": name, "description": description.chars().take(800).collect::<String>(), "fingerprint": fingerprint.iter().take(120).collect::<Vec<_>>() },
            "existing_similar_mods": candidates.iter().map(|(sim, r)| {
                let shared: Vec<&String> = r.code_fingerprint.iter().filter(|x| fingerprint.contains(x)).take(25).collect();
                json!({ "id": r.id, "name": r.name, "summary": r.summary, "code_overlap": (sim * 100.0).round() / 100.0, "shared_names_sample": shared })
            }).collect::<Vec<_>>(),
        });
        match crate::ai::ask_duplicate(&state.http, &state.config, &payload).await {
            Ok(v) if v.duplicate && v.confident => {
                let of = v
                    .duplicate_of
                    .and_then(|id| candidates.iter().find(|(_, r)| r.id.to_string() == id).map(|(_, r)| r.name.clone()))
                    .unwrap_or_else(|| candidates[0].1.name.clone());
                return Ok(UniqueCheck {
                    unique: false,
                    message: format!("this looks like a copy of \"{of}\", which is already on Branch ({}). only new, unique mods can be uploaded.", v.reason.trim_end_matches('.')),
                });
            }
            Ok(_) => return Ok(UniqueCheck { unique: true, message: String::new() }),
            Err(err) => tracing::warn!(error = %err, "duplicate check ai failed, using code overlap only"),
        }
    }
    let (best, row) = candidates[0];
    if best >= 0.85 {
        return Ok(UniqueCheck { unique: false, message: format!("this looks like a copy of \"{}\", which is already on Branch. only new, unique mods can be uploaded.", row.name) });
    }
    Ok(UniqueCheck { unique: true, message: String::new() })
}

pub async fn award_for_upload(state: &AppState, poster_id: Uuid, mod_id: Uuid, mod_name: &str) -> ApiResult<(i32, &'static str)> {
    if !rewards_enabled(state).await? {
        return Ok((0, "the rewards program is paused"));
    }
    let member: Option<Uuid> = sqlx::query_scalar("select id from reward_members where poster_id = $1 and status = 'accepted'")
        .bind(poster_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(member_id) = member else { return Ok((0, "not in the rewards program")) };

    let mut tx = state.db.begin().await?;
    sqlx::query("select id from reward_members where id = $1 for update").bind(member_id).execute(&mut *tx).await?;
    let (today, total): (i64, i64) = sqlx::query_as(
        "select coalesce(sum(amount) filter (where day = current_date), 0), coalesce(sum(amount), 0)
         from reward_events where member_id = $1 and status <> 'void'",
    )
    .bind(member_id)
    .fetch_one(&mut *tx)
    .await?;
    if total >= TOTAL_LIMIT as i64 {
        return Ok((0, "you've reached the 500 R$ limit"));
    }
    if today >= DAILY_LIMIT as i64 {
        return Ok((0, "you've reached today's 50 R$ limit"));
    }
    let amount = (PER_MOD as i64).min(DAILY_LIMIT as i64 - today).min(TOTAL_LIMIT as i64 - total) as i32;
    sqlx::query("insert into reward_events (member_id, mod_id, mod_name, amount) values ($1, $2, $3, $4)")
        .bind(member_id)
        .bind(mod_id)
        .bind(mod_name)
        .bind(amount)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((amount, "earned"))
}

pub async fn unique_upload_count(state: &AppState, poster_id: Uuid) -> ApiResult<i64> {
    Ok(sqlx::query_scalar("select count(*) from mods where uploader_poster = $1 and source = 'community' and status = 'published' and unique_status = 'unique'")
        .bind(poster_id)
        .fetch_one(&state.db)
        .await?)
}

#[derive(FromRow)]
struct MemberRow {
    id: Uuid,
    roblox_username: String,
    payout_item_url: String,
    status: String,
    ai_review: Option<Value>,
    applied_at: DateTime<Utc>,
    decided_at: Option<DateTime<Utc>>,
}

#[derive(FromRow, Serialize)]
struct EventRow {
    id: i64,
    mod_id: Option<Uuid>,
    mod_name: String,
    amount: i32,
    status: String,
    created_at: DateTime<Utc>,
    paid_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct KeyInput {
    key: String,
}

async fn me(State(state): State<AppState>, visitor: Visitor, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    let uploads = unique_upload_count(&state, poster.id).await?;
    let member: Option<MemberRow> = sqlx::query_as(
        "select id, roblox_username, payout_item_url, status, ai_review, applied_at, decided_at from reward_members where poster_id = $1",
    )
    .bind(poster.id)
    .fetch_optional(&state.db)
    .await?;

    let member_json = match member {
        None => Value::Null,
        Some(m) => {
            let events: Vec<EventRow> = sqlx::query_as(
                "select id, mod_id, mod_name, amount, status, created_at, paid_at from reward_events where member_id = $1 order by created_at desc limit 200",
            )
            .bind(m.id)
            .fetch_all(&state.db)
            .await?;
            let sum = |f: &dyn Fn(&EventRow) -> bool| events.iter().filter(|e| f(e)).map(|e| e.amount as i64).sum::<i64>();
            let today = Utc::now().date_naive();
            let review = m.ai_review.as_ref().filter(|_| m.status == "rejected").map(|r| json!({ "summary": r["summary"], "reasons": r["reasons"] }));
            json!({
                "status": m.status,
                "roblox_username": m.roblox_username,
                "payout_item_url": m.payout_item_url,
                "applied_at": m.applied_at,
                "decided_at": m.decided_at,
                "review": review,
                "earned": sum(&|e: &EventRow| e.status != "void"),
                "owed": sum(&|e: &EventRow| e.status == "owed"),
                "paid": sum(&|e: &EventRow| e.status == "paid"),
                "today": sum(&|e: &EventRow| e.status != "void" && e.created_at.date_naive() == today),
                "events": events,
            })
        }
    };

    Ok(Json(json!({
        "enabled": rewards_enabled(&state).await?,
        "uploads": uploads,
        "threshold": THRESHOLD,
        "limits": { "per_mod": PER_MOD, "daily": DAILY_LIMIT, "total": TOTAL_LIMIT },
        "member": member_json,
    })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ApplyInput {
    key: String,
    roblox_username: String,
    payout_item_url: String,
    confirm: bool,
}

fn valid_payout_url(raw: &str) -> Option<String> {
    let url = crate::util::clean_url(raw).ok().flatten()?;
    let parsed = url::Url::parse(&url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    let path = parsed.path().to_lowercase();
    let roblox = host == "roblox.com" || host == "www.roblox.com";
    let item = path.starts_with("/game-pass/") || path.starts_with("/catalog/") || path.starts_with("/bundles/");
    (roblox && item && parsed.scheme() == "https").then_some(url)
}

#[derive(FromRow)]
struct OwnMod {
    id: Uuid,
    name: String,
    description: String,
    code_fingerprint: Vec<String>,
    file_size: Option<i64>,
}

async fn apply(State(state): State<AppState>, visitor: Visitor, Json(input): Json<ApplyInput>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !rewards_enabled(&state).await? {
        return Err(AppError::forbidden("rewards_off", "the rewards program isn't running right now."));
    }
    let poster = poster_for(&state, &input.key, &visitor, true).await?;
    let username = input.roblox_username.trim().to_string();
    let mut errors = crate::error::FieldErrors::default();
    errors.check(
        (3..=20).contains(&username.len()) && username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "roblox_username",
        "enter your exact roblox username (3 to 20 letters, numbers or _)",
    );
    let payout = valid_payout_url(&input.payout_item_url);
    errors.check(payout.is_some(), "payout_item_url", "paste the link to one of your roblox gamepasses or clothing items (https://www.roblox.com/game-pass/… or /catalog/…)");
    errors.check(input.confirm, "confirm", "you have to agree to the rewards program rules");
    errors.finish()?;

    let uploads = unique_upload_count(&state, poster.id).await?;
    if uploads < THRESHOLD {
        return Err(AppError::forbidden("not_enough_uploads", format!("upload {} more unique mods before applying.", THRESHOLD - uploads)));
    }
    let existing: Option<(String, Option<DateTime<Utc>>)> = sqlx::query_as("select status, decided_at from reward_members where poster_id = $1")
        .bind(poster.id)
        .fetch_optional(&state.db)
        .await?;
    match existing {
        Some((status, _)) if status == "pending" => return Err(AppError::forbidden("already_applied", "your application is already being reviewed.")),
        Some((status, _)) if status == "accepted" => return Err(AppError::forbidden("already_member", "you're already in the rewards program.")),
        Some((status, _)) if status == "removed" => return Err(AppError::forbidden("removed", "you can't rejoin the rewards program.")),
        Some((_, Some(when))) if Utc::now() - when < chrono::Duration::hours(24) => {
            return Err(AppError::too_many("you can apply again 24 hours after your last application was reviewed."))
        }
        _ => {}
    }

    let mods: Vec<OwnMod> = sqlx::query_as(
        "select m.id, m.name, m.description, m.code_fingerprint,
                (select r.file_size from releases r where r.mod_id = m.id order by r.created_at desc limit 1) as file_size
         from mods m where m.uploader_poster = $1 and m.source = 'community' and m.status = 'published' order by m.created_at limit 60",
    )
    .bind(poster.id)
    .fetch_all(&state.db)
    .await?;
    let others: Vec<FingerprintRow> = sqlx::query_as(
        "select id, name, summary, code_fingerprint from mods where (uploader_poster is distinct from $1) and status in ('published', 'unpublished') order by created_at desc limit 5000",
    )
    .bind(poster.id)
    .fetch_all(&state.db)
    .await?;
    let listing: Vec<Value> = mods
        .iter()
        .map(|m| {
            let (other_sim, other_name) = others
                .iter()
                .map(|o| (similarity(&m.code_fingerprint, &o.code_fingerprint), o.name.as_str()))
                .fold((0.0f32, ""), |best, x| if x.0 > best.0 { x } else { best });
            let own_sim = mods.iter().filter(|o| o.id != m.id).map(|o| similarity(&m.code_fingerprint, &o.code_fingerprint)).fold(0.0f32, f32::max);
            json!({
                "id": m.id,
                "name": m.name,
                "description": m.description.chars().take(300).collect::<String>(),
                "file_size": m.file_size,
                "fingerprint_size": m.code_fingerprint.len(),
                "max_overlap_with_others": (other_sim * 100.0).round() / 100.0,
                "most_similar_other_mod": if other_sim > 0.0 { Value::String(other_name.to_string()) } else { Value::Null },
                "max_overlap_with_own": (own_sim * 100.0).round() / 100.0,
            })
        })
        .collect();

    let review = if take_ai_budget(&state).await? {
        match crate::ai::ask_rewards_review(&state.http, &state.config, &json!({ "uploads": listing })).await {
            Ok(r) => Some(r),
            Err(err) => {
                tracing::warn!(error = %err, "rewards review ai failed, sending straight to the admin");
                None
            }
        }
    } else {
        None
    };
    let (status, review_json) = match &review {
        Some(r) if !r.approve => ("rejected", json!({ "approve": false, "summary": r.summary, "reasons": r.reasons, "flagged": r.flagged, "by": "ai" })),
        Some(r) => ("pending", json!({ "approve": true, "summary": r.summary, "reasons": r.reasons, "flagged": r.flagged, "by": "ai" })),
        None => ("pending", json!({ "approve": null, "summary": "the ai review wasn't available, so this needs a manual look.", "reasons": [], "flagged": [], "by": "none" })),
    };
    sqlx::query(
        "insert into reward_members (id, poster_id, roblox_username, payout_item_url, status, ai_review, applied_at, decided_at)
         values ($1, $2, $3, $4, $5, $6, now(), case when $5 = 'rejected' then now() else null end)
         on conflict (poster_id) do update set roblox_username = excluded.roblox_username, payout_item_url = excluded.payout_item_url,
             status = excluded.status, ai_review = excluded.ai_review, applied_at = now(), decided_at = excluded.decided_at",
    )
    .bind(Uuid::new_v4())
    .bind(poster.id)
    .bind(&username)
    .bind(payout.unwrap_or_default())
    .bind(status)
    .bind(&review_json)
    .execute(&state.db)
    .await?;

    let reasons = if status == "rejected" { review_json["reasons"].clone() } else { json!([]) };
    Ok((StatusCode::CREATED, Json(json!({ "status": status, "summary": if status == "rejected" { review_json["summary"].clone() } else { Value::Null }, "reasons": reasons }))))
}

#[derive(FromRow, Serialize)]
struct AdminMember {
    id: Uuid,
    poster_name: String,
    roblox_username: String,
    payout_item_url: String,
    status: String,
    ai_review: Option<Value>,
    admin_note: String,
    applied_at: DateTime<Utc>,
    decided_at: Option<DateTime<Utc>>,
    uploads: i64,
    earned: i64,
    owed: i64,
    paid: i64,
    today: i64,
}

#[derive(FromRow, Serialize)]
struct AdminEvent {
    id: i64,
    member_id: Uuid,
    roblox_username: String,
    mod_id: Option<Uuid>,
    mod_name: String,
    amount: i32,
    status: String,
    created_at: DateTime<Utc>,
}

async fn admin_overview(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let members: Vec<AdminMember> = sqlx::query_as(
        "select rm.id, p.name as poster_name, rm.roblox_username, rm.payout_item_url, rm.status, rm.ai_review, rm.admin_note, rm.applied_at, rm.decided_at,
                (select count(*) from mods m where m.uploader_poster = rm.poster_id and m.source = 'community' and m.status = 'published' and m.unique_status = 'unique') as uploads,
                coalesce((select sum(amount) from reward_events e where e.member_id = rm.id and e.status <> 'void'), 0) as earned,
                coalesce((select sum(amount) from reward_events e where e.member_id = rm.id and e.status = 'owed'), 0) as owed,
                coalesce((select sum(amount) from reward_events e where e.member_id = rm.id and e.status = 'paid'), 0) as paid,
                coalesce((select sum(amount) from reward_events e where e.member_id = rm.id and e.status <> 'void' and e.day = current_date), 0) as today
         from reward_members rm join forum_posters p on p.id = rm.poster_id
         order by (rm.status = 'pending') desc, rm.applied_at desc",
    )
    .fetch_all(&state.db)
    .await?;
    let events: Vec<AdminEvent> = sqlx::query_as(
        "select e.id, e.member_id, rm.roblox_username, e.mod_id, e.mod_name, e.amount, e.status, e.created_at
         from reward_events e join reward_members rm on rm.id = e.member_id
         order by e.created_at desc limit 300",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "enabled": rewards_enabled(&state).await?, "members": members, "events": events })))
}

#[derive(Deserialize)]
struct SettingsInput {
    enabled: bool,
}

async fn admin_settings(State(state): State<AppState>, Admin(admin): Admin, Json(input): Json<SettingsInput>) -> ApiResult<Json<Value>> {
    sqlx::query("insert into app_settings (key, value) values ('rewards_enabled', $1) on conflict (key) do update set value = excluded.value")
        .bind(json!(input.enabled))
        .execute(&state.db)
        .await?;
    audit(&state.db, &admin, "rewards_program", "", if input.enabled { "turned on" } else { "turned off" }).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DecideInput {
    status: String,
    #[serde(default)]
    note: String,
}

async fn admin_decide(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>, Json(input): Json<DecideInput>) -> ApiResult<Json<Value>> {
    if !matches!(input.status.as_str(), "accepted" | "rejected" | "removed" | "pending") {
        return Err(AppError::bad_request("unknown status"));
    }
    let name: Option<String> = sqlx::query_scalar(
        "update reward_members set status = $1, admin_note = $2, decided_at = now() where id = $3 returning roblox_username",
    )
    .bind(&input.status)
    .bind(input.note.trim())
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let name = name.ok_or_else(|| AppError::not_found("that member doesn't exist"))?;
    audit(&state.db, &admin, "rewards_member", &name, &input.status).await;
    Ok(Json(json!({ "ok": true })))
}

async fn admin_mark_paid(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let paid: Option<i64> = sqlx::query_scalar(
        "with updated as (update reward_events set status = 'paid', paid_at = now() where member_id = $1 and status = 'owed' returning amount)
         select sum(amount) from updated",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let name: String = sqlx::query_scalar("select roblox_username from reward_members where id = $1").bind(id).fetch_optional(&state.db).await?.unwrap_or_default();
    audit(&state.db, &admin, "rewards_paid", &name, &format!("{} R$", paid.unwrap_or(0))).await;
    Ok(Json(json!({ "ok": true, "paid": paid.unwrap_or(0) })))
}

#[derive(Deserialize)]
struct EventInput {
    status: String,
}

async fn admin_event(State(state): State<AppState>, Admin(admin): Admin, Path(id): Path<i64>, Json(input): Json<EventInput>) -> ApiResult<Json<Value>> {
    if !matches!(input.status.as_str(), "owed" | "paid" | "void") {
        return Err(AppError::bad_request("unknown status"));
    }
    let done = sqlx::query("update reward_events set status = $1, paid_at = case when $1 = 'paid' then now() else null end where id = $2")
        .bind(&input.status)
        .bind(id)
        .execute(&state.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::not_found("that reward doesn't exist"));
    }
    audit(&state.db, &admin, "rewards_event", &id.to_string(), &input.status).await;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::valid_payout_url;

    #[test]
    fn only_roblox_item_links_are_accepted() {
        assert!(valid_payout_url("https://www.roblox.com/game-pass/123456/Support-me").is_some());
        assert!(valid_payout_url("https://www.roblox.com/catalog/987654/Cool-Shirt").is_some());
        assert!(valid_payout_url("https://evil.example/game-pass/1").is_none());
        assert!(valid_payout_url("https://www.roblox.com/users/1/profile").is_none());
        assert!(valid_payout_url("http://www.roblox.com/game-pass/1").is_none());
    }
}
