// the beta player tracker. a discord bot posts "room sync" cards to a channel. branch
// reads them with its own bot, keeps only the room, region and each player's name, id
// and color (no cosmetics or platform), and serves the newest 50 cards to the app.

use std::sync::Mutex;
use std::time::Duration;

use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::error::ApiResult;
use crate::state::AppState;

const DEFAULT_CHANNEL: &str = "1540889169642000505";
const DEFAULT_SOURCE: &str = "1540889201636151397";
/// how many cards are kept and shown
pub const KEEP: i64 = 50;
const POLL_EVERY: Duration = Duration::from_secs(8);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Player {
    pub name: String,
    pub id: String,
    pub color: [u8; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub message_id: String,
    pub room: String,
    pub region: String,
    pub player_count: i32,
    pub players: Vec<Player>,
    pub posted_at: DateTime<Utc>,
}

struct Status {
    state: &'static str,
    checked_at: Option<DateTime<Utc>>,
}

static STATUS: Mutex<Status> = Mutex::new(Status { state: "not_set_up", checked_at: None });

fn set_status(state: &'static str) {
    if let Ok(mut s) = STATUS.lock() {
        s.state = state;
        s.checked_at = Some(Utc::now());
    }
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// "**Username:** REM" -> ("username", "REM")
fn key_value(line: &str) -> Option<(String, String)> {
    let line = line.replace('*', "");
    let (key, value) = line.split_once(':')?;
    Some((key.trim().to_lowercase(), value.trim().to_string()))
}

fn clean_code(text: &str, max: usize) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric()).take(max).collect::<String>().to_uppercase()
}

fn parse_player(text: &str) -> Option<Player> {
    let mut name = String::new();
    let mut id = String::new();
    let mut color = [0u8; 3];
    for line in text.lines() {
        let Some((key, value)) = key_value(line) else { continue };
        match key.as_str() {
            "username" | "name" => name = value.chars().filter(|c| !c.is_control()).take(24).collect::<String>().trim().to_string(),
            "id" => id = clean_code(&value, 32),
            "color" | "colour" => {
                let parts: Vec<u8> = value.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse::<u16>().ok()).map(|n| n.min(255) as u8).collect();
                if parts.len() == 3 {
                    color = [parts[0], parts[1], parts[2]];
                }
            }
            // cosmetics and platform are left out on purpose
            _ => {}
        }
    }
    (!name.is_empty() && !id.is_empty()).then_some(Player { name, id, color })
}

/// turns one discord message into a card, or None if it isn't a room sync card
pub fn parse_message(message: &Value) -> Option<Card> {
    let embeds = message.get("embeds")?.as_array()?;
    let embed = embeds
        .iter()
        .find(|e| e.get("title").and_then(|t| t.as_str()).is_some_and(|t| t.to_lowercase().contains("room sync")))
        .or_else(|| embeds.iter().find(|e| e.get("fields").and_then(|f| f.as_array()).is_some_and(|f| !f.is_empty())))?;

    let mut room = String::new();
    let mut region = String::new();
    let mut count: Option<i32> = None;
    let mut players = Vec::new();
    for field in embed.get("fields").and_then(|f| f.as_array()).into_iter().flatten() {
        let name = field.get("name").and_then(|n| n.as_str()).unwrap_or("").replace('*', "").trim().to_lowercase();
        let value = field.get("value").and_then(|v| v.as_str()).unwrap_or("");
        match name.as_str() {
            "directory" | "room" | "code" | "room code" => room = clean_code(value, 12),
            "region" => region = clean_code(value, 8),
            "players" => count = value.trim().parse().ok(),
            n if n.starts_with("player") => {
                if let Some(p) = parse_player(value) {
                    players.push(p);
                }
            }
            _ => {}
        }
    }
    // some bots put the players in the description instead of fields
    if players.is_empty() {
        if let Some(desc) = embed.get("description").and_then(|d| d.as_str()) {
            let mut block = String::new();
            for line in desc.lines().chain(std::iter::once("Player end")) {
                if line.replace('*', "").trim().to_lowercase().starts_with("player") && !line.contains(':') {
                    if let Some(p) = parse_player(&block) {
                        players.push(p);
                    }
                    block.clear();
                } else {
                    block.push_str(line);
                    block.push('\n');
                }
            }
        }
    }
    if room.is_empty() || players.is_empty() {
        return None;
    }
    let posted_at = message
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    Some(Card {
        message_id: message.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_string(),
        room,
        region,
        player_count: count.unwrap_or(players.len() as i32).clamp(0, 100),
        players,
        posted_at,
    })
}

/// saves new cards and drops everything older than the newest 50
pub async fn save_cards(db: &PgPool, cards: &[Card]) -> Result<(), sqlx::Error> {
    for card in cards {
        sqlx::query(
            "insert into tracker_cards (message_id, room, region, player_count, players, posted_at)
             values ($1, $2, $3, $4, $5, $6) on conflict (message_id) do nothing",
        )
        .bind(&card.message_id)
        .bind(&card.room)
        .bind(&card.region)
        .bind(card.player_count)
        .bind(json!(card.players))
        .bind(card.posted_at)
        .execute(db)
        .await?;
    }
    sqlx::query("delete from tracker_cards where message_id not in (select message_id from tracker_cards order by posted_at desc limit $1)")
        .bind(KEEP)
        .execute(db)
        .await?;
    Ok(())
}

enum PollError {
    RateLimited(Duration),
    Failed(String),
}

async fn poll(state: &AppState, token: &str, channel: &str, source: &str) -> Result<(), PollError> {
    let response = state
        .http
        .get(format!("https://discord.com/api/v10/channels/{channel}/messages?limit={KEEP}"))
        .header("Authorization", format!("Bot {token}"))
        .header("User-Agent", "DiscordBot (https://github.com/drifteddd/Branch, 1.0)")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| PollError::Failed(format!("couldn't reach discord: {e}")))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let secs = body.get("retry_after").and_then(|r| r.as_f64()).unwrap_or(10.0);
        return Err(PollError::RateLimited(Duration::from_secs_f64(secs.clamp(1.0, 300.0))));
    }
    if !status.is_success() {
        // never the token, only what discord said
        let message = body.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(PollError::Failed(format!("discord answered {status}: {message}")));
    }
    let cards: Vec<Card> = body
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            let from = |key: &str| m.pointer(key).and_then(|v| v.as_str()) == Some(source);
            from("/author/id") || from("/webhook_id")
        })
        .filter_map(parse_message)
        .collect();
    save_cards(&state.db, &cards).await.map_err(|e| PollError::Failed(format!("couldn't save cards: {e}")))
}

/// keeps reading the channel in the background. does nothing without a bot token.
pub fn spawn(state: AppState) {
    let Some(token) = env("DISCORD_BOT_TOKEN") else {
        tracing::info!("DISCORD_BOT_TOKEN isn't set, the player tracker is off");
        return;
    };
    let channel = env("TRACKER_CHANNEL_ID").unwrap_or_else(|| DEFAULT_CHANNEL.into());
    let source = env("TRACKER_SOURCE_ID").unwrap_or_else(|| DEFAULT_SOURCE.into());
    set_status("starting");
    tokio::spawn(async move {
        let mut failures = 0u32;
        loop {
            let wait = match poll(&state, &token, &channel, &source).await {
                Ok(()) => {
                    failures = 0;
                    set_status("live");
                    POLL_EVERY
                }
                Err(PollError::RateLimited(wait)) => wait,
                Err(PollError::Failed(message)) => {
                    failures += 1;
                    if failures == 1 || failures % 20 == 0 {
                        tracing::warn!(%message, "player tracker couldn't read the channel");
                    }
                    set_status("offline");
                    Duration::from_secs(30)
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

/// the newest cards for the app, newest first
pub async fn feed(State(state): State<AppState>) -> ApiResult<Response> {
    let rows: Vec<(String, String, String, i32, Value, DateTime<Utc>)> =
        sqlx::query_as("select message_id, room, region, player_count, players, posted_at from tracker_cards order by posted_at desc limit $1")
            .bind(KEEP)
            .fetch_all(&state.db)
            .await?;
    let cards: Vec<Value> = rows
        .into_iter()
        .map(|(id, room, region, count, players, at)| json!({ "id": id, "room": room, "region": region, "player_count": count, "players": players, "seen_at": at }))
        .collect();
    let (status, checked_at) = STATUS.lock().map(|s| (s.state, s.checked_at)).unwrap_or(("offline", None));
    Ok(([(header::CACHE_CONTROL, "public, max-age=3")], Json(json!({ "status": status, "checked_at": checked_at, "cards": cards }))).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "id": "1565847513024434329",
            "timestamp": "2026-10-30T21:58:59.145000+00:00",
            "webhook_id": "1540889201636151397",
            "embeds": [{
                "title": "Room Sync Data",
                "fields": [
                    { "name": "Directory", "value": "17WT", "inline": true },
                    { "name": "Region", "value": "EU", "inline": true },
                    { "name": "Players", "value": "9", "inline": true },
                    { "name": "Player 1", "value": "**Username:** REM\n**ID:** 10745A7BD9CD0772\n**Color:** 0 0 0\n**Platform:** PC\n**Cosmetics:** LSAAD., LHAAY." },
                    { "name": "Player 2", "value": "**Username:** GORILLA4418\n**ID:** 54F13BB042F31C82\n**Color:** 142 255 255\n**Platform:** PC\n**Cosmetics:** LBAJB." },
                    { "name": "Player 3", "value": "**Username:** \n**ID:** \n**Color:** 1 2" }
                ]
            }]
        })
    }

    #[test]
    fn reads_a_room_sync_card() {
        let card = parse_message(&sample()).unwrap();
        assert_eq!(card.room, "17WT");
        assert_eq!(card.region, "EU");
        assert_eq!(card.player_count, 9);
        assert_eq!(card.players.len(), 2, "players without a name or id are skipped");
        assert_eq!(card.players[1], Player { name: "GORILLA4418".into(), id: "54F13BB042F31C82".into(), color: [142, 255, 255] });
        let saved = serde_json::to_string(&card.players).unwrap();
        assert!(!saved.contains("LSAAD") && !saved.contains("PC"), "cosmetics and platform are never kept");
    }

    #[test]
    fn ignores_other_messages() {
        assert!(parse_message(&json!({ "id": "1", "content": "hello", "embeds": [] })).is_none());
        assert!(parse_message(&json!({ "id": "1", "embeds": [{ "title": "Room Sync Data", "fields": [{ "name": "Directory", "value": "ABC" }] }] })).is_none());
    }
}
