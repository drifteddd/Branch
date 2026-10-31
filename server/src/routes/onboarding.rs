use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::auth::Admin;
use crate::error::{ApiResult, AppError};
use crate::models::file_url;
use crate::routes::public::{bump_usage, usage_today, AI_CALLS_KEY};
use crate::state::AppState;
use crate::util::Visitor;

pub const HEARD_FROM: [&str; 7] = ["drifted", "friend", "discord", "video", "search", "forum", "other"];
pub const USES: [&str; 7] = ["find", "upload", "tracker", "community", "checker", "rewards", "assistant"];
pub const INTERESTS: [(&str, &[&str]); 16] = [
    ("cosmetics", &["cosmetic", "hat", "skin", "outfit", "badge", "accessory"]),
    ("movement", &["movement", "fly", "speed", "jump", "climb", "arm", "walk"]),
    ("menus", &["menu", "mod menu", "gui", "toggle"]),
    ("maps", &["map", "world", "level", "forest", "cave", "room"]),
    ("visuals", &["visual", "light", "trail", "color", "particle", "effect", "glow"]),
    ("sounds", &["sound", "audio", "music", "voice"]),
    ("utilities", &["utility", "tool", "info", "ping", "fps", "timer"]),
    ("quality", &["quality", "settings", "fix", "tweak", "comfort"]),
    ("fun", &["fun", "silly", "funny", "meme", "party"]),
    ("competitive", &["competitive", "tag", "practice", "speedrun", "race"]),
    ("camera", &["camera", "spectator", "record", "recording", "stream"]),
    ("performance", &["performance", "fps", "lag", "optimize", "boost"]),
    ("libraries", &["library", "libraries", "api", "framework", "utilla", "bepinex"]),
    ("hands", &["hand", "glove", "finger", "trail"]),
    ("hud", &["hud", "ui", "interface", "overlay", "watch"]),
    ("social", &["social", "friend", "lobby", "room", "chat"]),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/onboarding", post(save_answers))
        .route("/api/onboarding/picks", post(picks))
        .route("/api/admin/onboarding", get(admin_stats))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Answers {
    heard_from: String,
    heard_other: String,
    uses: Vec<String>,
}

async fn bump(state: &AppState, kind: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query("insert into onboarding_stats (kind, value, count) values ($1, $2, 1) on conflict (kind, value) do update set count = onboarding_stats.count + 1")
        .bind(kind)
        .bind(value)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn save_answers(State(state): State<AppState>, visitor: Visitor, Json(input): Json<Answers>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("onboarding:{}", visitor.id), 3, Duration::from_secs(24 * 3600)) {
        return Ok(Json(json!({ "ok": true })));
    }
    if HEARD_FROM.iter().any(|h| *h == input.heard_from) {
        bump(&state, "heard_from", &input.heard_from).await?;
        let other: String = input.heard_other.trim().to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == ' ').take(40).collect();
        if input.heard_from == "other" && other.trim().chars().count() >= 2 {
            bump(&state, "heard_other", other.trim()).await?;
        }
    }
    let mut seen = Vec::new();
    for u in input.uses.iter().take(10) {
        if USES.iter().any(|x| x == u) && !seen.contains(u) {
            bump(&state, "uses", u).await?;
            seen.push(u.clone());
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PicksInput {
    interests: Vec<String>,
    uses: Vec<String>,
}

#[derive(FromRow)]
struct CatalogRow {
    slug: String,
    name: String,
    summary: String,
    category: Option<String>,
    tags: Option<String>,
    thumbnail_key: Option<String>,
    download_count: i64,
    rating_sum: i32,
    rating_count: i32,
    ban_risk: Option<String>,
}

fn fallback_score(m: &CatalogRow, interests: &[String]) -> f64 {
    let text = format!("{} {} {} {}", m.name, m.summary, m.category.clone().unwrap_or_default(), m.tags.clone().unwrap_or_default()).to_lowercase();
    let mut score = 0.0;
    for interest in interests {
        if let Some((_, words)) = INTERESTS.iter().find(|(key, _)| *key == interest.as_str()) {
            if words.iter().any(|w| text.contains(w)) {
                score += 10.0;
            }
        }
    }
    let rating = if m.rating_count > 0 { m.rating_sum as f64 / m.rating_count as f64 } else { 3.0 };
    score + rating + (m.download_count as f64 + 1.0).ln() * 0.5
}

async fn picks(State(state): State<AppState>, visitor: Visitor, Json(input): Json<PicksInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("picks:{}", visitor.id), 6, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little. try again in a few minutes."));
    }
    let interests: Vec<String> = input.interests.iter().filter(|i| INTERESTS.iter().any(|(k, _)| *k == i.as_str())).take(16).cloned().collect();
    let uses: Vec<String> = input.uses.iter().filter(|u| USES.iter().any(|x| x == *u)).take(10).cloned().collect();
    let catalog: Vec<CatalogRow> = sqlx::query_as(
        "select m.slug, m.name, m.summary, c.name as category,
                (select string_agg(t.name, ', ' order by t.name) from mod_tags mt join tags t on t.id = mt.tag_id where mt.mod_id = m.id) as tags,
                m.thumbnail_key, m.download_count, m.rating_sum, m.rating_count, m.ai_insights->>'ban_risk' as ban_risk
         from mods m left join categories c on c.id = m.category_id
         where m.status = 'published'
         order by m.download_count desc, m.rating_count desc
         limit 300",
    )
    .fetch_all(&state.db)
    .await?;
    if catalog.is_empty() {
        return Ok(Json(json!({ "picks": [], "source": "none" })));
    }

    let mut chosen: Vec<(String, String)> = Vec::new();
    let mut source = "basic";
    if state.config.ai_api_key.is_some() && usage_today(&state, AI_CALLS_KEY).await? < state.config.ai_daily_global {
        bump_usage(&state, AI_CALLS_KEY).await?;
        let payload = json!({
            "interests": interests,
            "wants_to_use_branch_for": uses,
            "catalog": catalog.iter().map(|m| json!({
                "slug": m.slug,
                "name": m.name,
                "category": m.category,
                "tags": m.tags,
                "summary": m.summary.chars().take(160).collect::<String>(),
                "rating": if m.rating_count > 0 { Some(((m.rating_sum as f64 / m.rating_count as f64) * 10.0).round() / 10.0) } else { None },
                "ratings": m.rating_count,
                "downloads": m.download_count,
                "ban_risk": m.ban_risk,
            })).collect::<Vec<_>>(),
        });
        match crate::ai::pick_mods(&state.http, &state.config, &payload).await {
            Ok(list) => {
                chosen = list.into_iter().filter(|(slug, _)| catalog.iter().any(|m| &m.slug == slug)).collect();
                chosen.dedup_by(|a, b| a.0 == b.0);
                if !chosen.is_empty() {
                    source = "ai";
                }
            }
            Err(err) => tracing::warn!(error = %err, "onboarding picks failed, using the basic matcher"),
        }
    }
    if chosen.is_empty() {
        let mut scored: Vec<(f64, &CatalogRow)> = catalog.iter().map(|m| (fallback_score(m, &interests), m)).collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        chosen = scored
            .into_iter()
            .take(6)
            .map(|(_, m)| (m.slug.clone(), match &m.category { Some(c) => format!("a popular pick in {}", c.to_lowercase()), None => "a popular pick on Branch".to_string() }))
            .collect();
    }

    let picks: Vec<Value> = chosen
        .iter()
        .filter_map(|(slug, reason)| {
            let m = catalog.iter().find(|m| &m.slug == slug)?;
            Some(json!({
                "slug": m.slug,
                "name": m.name,
                "summary": m.summary,
                "category": m.category,
                "thumbnail_url": m.thumbnail_key.as_deref().map(file_url),
                "rating": { "average": if m.rating_count > 0 { Some(((m.rating_sum as f64 / m.rating_count as f64) * 10.0).round() / 10.0) } else { None }, "count": m.rating_count },
                "reason": reason,
            }))
        })
        .collect();
    Ok(Json(json!({ "picks": picks, "source": source })))
}

async fn admin_stats(State(state): State<AppState>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as("select kind, value, count from onboarding_stats order by kind, count desc").fetch_all(&state.db).await?;
    let pick = |kind: &str| -> Vec<Value> { rows.iter().filter(|(k, _, _)| k == kind).map(|(_, v, c)| json!({ "value": v, "count": c })).collect() };
    Ok(Json(json!({ "heard_from": pick("heard_from"), "heard_other": pick("heard_other"), "uses": pick("uses") })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, tags: &str, downloads: i64) -> CatalogRow {
        CatalogRow { slug: name.into(), name: name.into(), summary: String::new(), category: None, tags: Some(tags.into()), thumbnail_key: None, download_count: downloads, rating_sum: 0, rating_count: 0, ban_risk: None }
    }

    #[test]
    fn basic_matcher_prefers_interests() {
        let hats = row("Tiny Hats", "hats, cosmetics", 1);
        let camera = row("Smooth Cam", "camera", 500);
        let interests = vec!["cosmetics".to_string()];
        assert!(fallback_score(&hats, &interests) > fallback_score(&camera, &interests));
    }
}
