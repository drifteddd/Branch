use std::time::Duration;

use serde_json::{json, Value};

use crate::routes::public::{parse_tags, publish_upload, uploads_today, verdict_label, NewUpload};
use crate::state::AppState;

const DEFAULT_CHANNEL: &str = "1565943886097027212";
const API: &str = "https://discord.com/api/v10";
const USER_AGENT: &str = "DiscordBot (https://github.com/drifteddd/Branch, 1.0)";
const LAST_KEY: &str = "discord_upload_last_id";
const PER_DAY: i64 = 10;
const MAX_BYTES: u64 = 50 * 1024 * 1024;
const GREEN: u32 = 0x2f9e6b;
const RED: u32 = 0xd1495b;

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

struct Bot {
    state: AppState,
    token: String,
    channel: String,
}

#[derive(Default, Debug, PartialEq)]
pub struct MessageInfo {
    pub name: String,
    pub author: String,
    pub version: String,
    pub tags: String,
    pub description: String,
}

pub fn read_message(content: &str) -> MessageInfo {
    let mut info = MessageInfo::default();
    let mut rest = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        let value = |prefix: &str| trimmed[prefix.len()..].trim().trim_start_matches(':').trim().to_string();
        if lower.starts_with("name:") {
            info.name = value("name");
        } else if lower.starts_with("author:") {
            info.author = value("author");
        } else if lower.starts_with("version:") {
            info.version = value("version");
        } else if lower.starts_with("tags:") {
            info.tags = value("tags");
        } else {
            rest.push(line);
        }
    }
    let description = rest.join("\n").trim().to_string();
    if description.chars().count() >= 30 {
        info.description = description.chars().take(5000).collect();
    }
    info.name = info.name.chars().take(80).collect();
    info.author = info.author.chars().take(80).collect();
    info.version = info.version.chars().take(40).collect();
    info
}

fn short(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { format!("{}…", text.chars().take(max).collect::<String>().trim_end()) }
}

impl Bot {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.state
            .http
            .request(method, format!("{API}{path}"))
            .header("Authorization", format!("Bot {}", self.token))
            .header("User-Agent", USER_AGENT)
            .timeout(Duration::from_secs(20))
    }

    async fn last_id(&self) -> Option<u64> {
        let value: Option<Value> = sqlx::query_scalar("select value from app_settings where key = $1").bind(LAST_KEY).fetch_optional(&self.state.db).await.ok().flatten();
        value.and_then(|v| v.as_str().and_then(|s| s.parse().ok()))
    }

    async fn save_last(&self, id: u64) {
        let _ = sqlx::query("insert into app_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value")
            .bind(LAST_KEY)
            .bind(json!(id.to_string()))
            .execute(&self.state.db)
            .await;
    }

    async fn fetch(&self, after: Option<u64>) -> Result<Vec<Value>, (String, Option<Duration>)> {
        let path = match after {
            Some(id) => format!("/channels/{}/messages?limit=25&after={id}", self.channel),
            None => format!("/channels/{}/messages?limit=1", self.channel),
        };
        let response = self.request(reqwest::Method::GET, &path).send().await.map_err(|e| (format!("couldn't reach discord: {e}"), None))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = body.get("retry_after").and_then(|r| r.as_f64()).unwrap_or(10.0);
            return Err(("rate limited".into(), Some(Duration::from_secs_f64(wait.clamp(1.0, 300.0)))));
        }
        if !status.is_success() {
            let message = body.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
            return Err((format!("discord answered {status}: {message}"), None));
        }
        let mut list: Vec<Value> = body.as_array().cloned().unwrap_or_default();
        list.sort_by_key(|m| m.get("id").and_then(|i| i.as_str()).and_then(|i| i.parse::<u64>().ok()).unwrap_or(0));
        Ok(list)
    }

    async fn reply(&self, message_id: &str, embed: Value) {
        let body = json!({
            "embeds": [embed],
            "message_reference": { "message_id": message_id, "fail_if_not_exists": false },
            "allowed_mentions": { "parse": [] },
        });
        if let Err(err) = self.request(reqwest::Method::POST, &format!("/channels/{}/messages", self.channel)).json(&body).send().await {
            tracing::warn!(error = %err, "couldn't reply in the upload channel");
        }
    }

    async fn download(&self, url: &str) -> Result<Vec<u8>, String> {
        let response = self.state.http.get(url).timeout(Duration::from_secs(120)).send().await.map_err(|_| "couldn't download the file from discord".to_string())?;
        if !response.status().is_success() {
            return Err("couldn't download the file from discord".into());
        }
        let bytes = response.bytes().await.map_err(|_| "the download from discord stopped".to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("mod files can be up to 50 MB".into());
        }
        Ok(bytes.to_vec())
    }

    async fn handle(&self, message: &Value) {
        if message.pointer("/author/bot").and_then(|b| b.as_bool()) == Some(true) {
            return;
        }
        let Some(message_id) = message.get("id").and_then(|i| i.as_str()) else { return };
        let author_id = message.pointer("/author/id").and_then(|i| i.as_str()).unwrap_or("unknown");
        let files: Vec<&Value> = message
            .get("attachments")
            .and_then(|a| a.as_array())
            .map(|list| {
                list.iter()
                    .filter(|a| {
                        let name = a.get("filename").and_then(|f| f.as_str()).unwrap_or("").to_lowercase();
                        name.ends_with(".dll") || name.ends_with(".zip")
                    })
                    .take(3)
                    .collect()
            })
            .unwrap_or_default();
        if files.is_empty() {
            return;
        }
        let info = read_message(message.get("content").and_then(|c| c.as_str()).unwrap_or(""));
        let uploader = format!("discord:{}", &crate::util::sha256_hex(format!("{}:discord:{author_id}", self.state.config.server_secret).as_bytes())[..32]);
        for file in files {
            let file_name = file.get("filename").and_then(|f| f.as_str()).unwrap_or("mod.dll").to_string();
            let outcome = self.upload(file, &file_name, &uploader, &info).await;
            let embed = match outcome {
                Ok(p) => json!({
                    "title": short(&format!("Added to Branch: {}", p.name), 250),
                    "description": short(&p.description, 380),
                    "color": GREEN,
                    "fields": [
                        { "name": "Safety check", "value": format!("{}/100 · {}", p.score, verdict_label(p.score)), "inline": true },
                        { "name": "Category", "value": p.category.clone().unwrap_or_else(|| "none".into()), "inline": true },
                        { "name": "Tags", "value": if p.tags.is_empty() { "none".to_string() } else { p.tags.join(", ") }, "inline": true },
                    ],
                    "footer": { "text": if p.written_by_ai { "the name and description were written by Branch's AI · open Branch and search for it" } else { "open Branch and search for it" } },
                }),
                Err(reason) => json!({
                    "title": short(&format!("Couldn't add {file_name}"), 250),
                    "description": short(&reason, 900),
                    "color": RED,
                }),
            };
            self.reply(message_id, embed).await;
        }
    }

    async fn upload(&self, file: &Value, file_name: &str, uploader: &str, info: &MessageInfo) -> Result<crate::routes::public::Published, String> {
        if uploads_today(&self.state, uploader).await.map_err(|_| "something went wrong on the server. try again in a moment.".to_string())? >= PER_DAY {
            return Err(format!("you can upload up to {PER_DAY} mods a day. try again tomorrow."));
        }
        let size = file.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
        if size > MAX_BYTES {
            return Err("mod files can be up to 50 MB".into());
        }
        let url = file.get("url").and_then(|u| u.as_str()).ok_or("discord didn't send a download link for this file")?;
        let data = self.download(url).await?;
        let tags = parse_tags(&info.tags).unwrap_or_default();
        publish_upload(
            &self.state,
            NewUpload {
                uploader: uploader.to_string(),
                file_name: file_name.to_string(),
                data,
                name: info.name.clone(),
                description: info.description.clone(),
                author: info.author.clone(),
                version: info.version.clone(),
                category_id: None,
                tags,
                source_url: None,
                thumbnail: None,
                poster_id: None,
                via: "discord",
            },
        )
        .await
        .map_err(|e| e.message)
    }
}

pub fn spawn(state: AppState) {
    let Some(token) = env("DISCORD_BOT_TOKEN") else { return };
    let channel = env("DISCORD_UPLOAD_CHANNEL_ID").unwrap_or_else(|| DEFAULT_CHANNEL.into());
    let bot = Bot { state, token, channel };
    tokio::spawn(async move {
        let mut failures = 0u32;
        loop {
            let after = bot.last_id().await;
            let wait = match bot.fetch(after).await {
                Ok(messages) => {
                    failures = 0;
                    for message in &messages {
                        let id = message.get("id").and_then(|i| i.as_str()).and_then(|i| i.parse::<u64>().ok()).unwrap_or(0);
                        if after.is_some() {
                            bot.handle(message).await;
                        }
                        if id > 0 {
                            bot.save_last(id).await;
                        }
                    }
                    if after.is_none() && messages.is_empty() {
                        bot.save_last(1).await;
                    }
                    Duration::from_secs(10)
                }
                Err((_, Some(wait))) => wait,
                Err((message, None)) => {
                    failures += 1;
                    if failures == 1 || failures % 30 == 0 {
                        tracing::warn!(%message, "discord upload channel couldn't be read");
                    }
                    Duration::from_secs(60)
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_optional_details_from_the_message() {
        let info = read_message("name: Long Arms\nAuthor: Drifted\ntags: movement, fun\nthis mod makes your arms longer so you can climb higher and faster.");
        assert_eq!(info.name, "Long Arms");
        assert_eq!(info.author, "Drifted");
        assert_eq!(info.tags, "movement, fun");
        assert!(info.description.starts_with("this mod makes"));
        let empty = read_message("here you go");
        assert_eq!(empty, MessageInfo::default(), "short messages leave everything to the ai");
    }
}
