// asks a small, cheap model on siliconflow to judge the basic scan's findings.
// the file itself is never sent, only the text clues the scan pulled out of it.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::Config;
use crate::scan::ScanReport;

pub const SYSTEM_PROMPT: &str = r#"You are the malware checker inside Branch, a free app for finding Gorilla Tag mods (Unity game, PC VR). People upload a mod file (a .NET .dll or a .zip) and you decide how likely it is to be MALWARE. You never see the file itself. Branch's scanner reads the text hidden inside the file (type and method names, Windows API names, links, file names in the zip) and gives you a JSON summary.

YOUR ONLY JOB: estimate how likely the file is to harm the person's computer, accounts or privacy. That means things like:
- remote access tools / RATs and backdoors (hidden remote control, reverse shells, tunnels like ngrok)
- stealers (Discord tokens, browser passwords and cookies, Steam login files, crypto wallets), especially when combined with a way to send data out (Discord webhooks, Telegram bot API, unknown servers)
- droppers / loaders (downloading and running other programs, hidden PowerShell or cmd, executables or scripts packed inside a zip, decoding big encoded blobs and loading them as code)
- keyloggers and spyware (system-wide keyboard hooks, screenshots, webcam)
- persistence and evasion (starting with Windows, scheduled tasks, Defender exclusions, anti-debugging or anti-VM checks)
- crypto miners

DO NOT treat any of these as suspicious. They are normal for Gorilla Tag mods or are outside your job:
- cheats, "mod menus", fly/speed/long-arm hacks, ghost mode, tag aura, anti-cheat or anti-report bypasses, unlocking cosmetics, anything that breaks the game's rules or could get the player banned. Rule-breaking or game-changing is NOT malware. Do not raise the score for it and do not mention it as a danger.
- BepInEx, Harmony / HarmonyLib, MonoMod, Utilla, UnityEngine, GorillaLocomotion, Photon networking (multiplayer), reflection for patching the game, reading the game's own files, config files, loading asset bundles
- opening a web page in the browser, checking GitHub for updates, links to GitHub, Discord invite links (discord.gg), YouTube, or the author's own site
- reading a few keys for hotkeys (GetAsyncKeyState alone), using System.IO for the mod's own files
- light obfuscation by itself (some authors obfuscate to protect their work). It only matters when it appears together with real malware signs.

HOW TO JUDGE:
- Weigh combinations, not single words. A stealer needs something to steal AND a way to send it. A dropper needs a download AND a way to run it. One weak signal on its own is usually nothing.
- Strong single signs: process injection APIs (CreateRemoteThread, WriteProcessMemory, VirtualAllocEx), Discord webhook URLs in a game mod, crypto miner settings, executables or batch/PowerShell scripts inside a mod zip, Defender exclusions.
- If the file has normal mod markers and no real warning signs, the score must be low even if the mod is a cheat.
- Only use the facts given. Never invent findings. If the evidence is thin or unclear, say so and stay in the low-to-middle range rather than guessing high.

SCORE GUIDE (0-100):
- 0-20: no real signs of malware
- 21-45: a few unusual things, probably fine
- 46-70: suspicious, the person should be careful
- 71-100: very likely malware

REPLY WITH ONLY ONE JSON OBJECT, no markdown, no extra text:
{"score": <integer 0-100>, "summary": "<one or two short sentences>", "reasons": ["<short reason>", "..."]}

Writing style for summary and reasons: plain, simple and calm, mostly lowercase, like explaining to a teenager. Give at most 5 reasons, each under 25 words, each pointing at a specific finding. If nothing looks wrong, say what you checked and that nothing stood out."#;

#[derive(Serialize, Clone, Debug)]
pub struct AiVerdict {
    pub score: u8,
    pub summary: String,
    pub reasons: Vec<String>,
}

/// the trimmed-down facts the model sees. kept small so every check costs a fraction of a cent.
fn user_message(report: &ScanReport) -> String {
    let indicators: Vec<Value> = report
        .indicators
        .iter()
        .map(|i| json!({ "category": i.category, "finding": i.label, "evidence": i.evidence }))
        .collect();
    let entries: Vec<&str> = report.entries.iter().take(60).map(|e| e.name.as_str()).collect();
    let facts = json!({
        "file_name": report.file_name,
        "file_type": report.kind,
        "size_bytes": report.size,
        "is_dotnet": report.dotnet,
        "normal_mod_markers_found": report.mod_markers,
        "warning_signs_found": indicators,
        "links_found": report.urls.iter().take(25).collect::<Vec<_>>(),
        "zip_file_count": report.entry_count,
        "zip_files": entries,
        "large_encoded_blobs": report.encoded_blobs,
        "basic_scan_score": report.heuristic_score,
    });
    let mut text = facts.to_string();
    if text.len() > 9000 {
        let mut end = 9000;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    format!("Here is what Branch's scanner found in the uploaded file. Judge it using your rules.\n\n{text}")
}

/// pulls the json object out of the reply, even if the model wrapped it in ``` fences
pub fn parse_reply(content: &str) -> Option<AiVerdict> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    let value: Value = serde_json::from_str(content.get(start..=end)?).ok()?;
    let score = value.get("score")?.as_f64()?.round().clamp(0.0, 100.0) as u8;
    let clean = |s: &str, max: usize| -> String {
        let s: String = s.chars().filter(|c| !c.is_control()).collect();
        s.chars().take(max).collect()
    };
    let summary = clean(value.get("summary").and_then(|v| v.as_str()).unwrap_or(""), 400);
    let reasons = value
        .get("reasons")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(|r| r.as_str()).take(5).map(|r| clean(r, 220)).collect())
        .unwrap_or_default();
    Some(AiVerdict { score, summary, reasons })
}

pub async fn ask(http: &reqwest::Client, config: &Config, report: &ScanReport) -> Result<AiVerdict, String> {
    let key = config.ai_api_key.as_deref().ok_or("the ai key isn't set")?;
    let body = json!({
        "model": config.ai_model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_message(report) },
        ],
        "temperature": 0.1,
        "max_tokens": 400,
        "stream": false,
    });
    let response = http
        .post(format!("{}/chat/completions", config.ai_base_url))
        .bearer_auth(key)
        .json(&body)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| format!("couldn't reach the ai: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("the ai sent something unreadable: {e}"))?;
    if !status.is_success() {
        // the provider's message, never our key
        let message = value.pointer("/message").or_else(|| value.pointer("/error/message")).and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(format!("the ai answered {status}: {message}"));
    }
    let content = value.pointer("/choices/0/message/content").and_then(|v| v.as_str()).ok_or("the ai sent an empty answer")?;
    parse_reply(content).ok_or_else(|| "the ai's answer wasn't in the expected format".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_json() {
        let v = parse_reply("```json\n{\"score\": 87.4, \"summary\": \"bad\", \"reasons\": [\"webhook\", \"injection\"]}\n```").unwrap();
        assert_eq!(v.score, 87);
        assert_eq!(v.reasons.len(), 2);
    }

    #[test]
    fn clamps_and_rejects_garbage() {
        assert_eq!(parse_reply("{\"score\": 400}").unwrap().score, 100);
        assert!(parse_reply("no json here").is_none());
    }
}
