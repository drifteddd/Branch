// asks a model on siliconflow to judge what branch's scanner found in a mod.
// the file itself is never sent, only the evidence the scanner pulled out of it:
// the methods the code really calls, the windows functions it imports, the classes
// and methods it defines, links, and suspicious text.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::Config;
use crate::scan::ScanReport;

pub const SYSTEM_PROMPT: &str = r#"You are the security analyst inside Branch, a free app where people find and share Gorilla Tag mods. Gorilla Tag is a Unity (C#/.NET) VR game. Its mods are almost always .NET class libraries (.dll) loaded by BepInEx, often using Harmony to patch game methods, sometimes packed in a .zip.

You never see the file. Branch's scanner reads the DLL's structure without running it and gives you evidence as JSON:
- "code.notable_calls": methods the code actually references, written "Namespace.Type::Method". This is the strongest evidence of what the mod can do.
- "code.windows_calls": native Windows functions it imports or calls through P/Invoke, written "dll!Function".
- "code.defined_types" and "code.defined_methods": names of the classes and methods the mod itself contains. These tell you what the mod is for (e.g. "FlyMod.Plugin", "OnGUI", "ToggleNoclip").
- "code.capabilities": the scanner's grouping of calls into capabilities, each "normal", "unusual" or "dangerous".
- "text_signals": suspicious strings found anywhere in the file (webhook URLs, browser login paths, startup registry keys, miner settings).
- "links_found", "zip_files", "normal_mod_markers_found", "obfuscated_names", "basic_scan_score".
- "claimed_name" and "claimed_description": what the uploader says the mod does, when provided.

YOUR JOB: estimate how likely this file is to harm the user's computer, accounts, money or privacy. Malware here means:
1. Stealers: reading Discord tokens (Local Storage\leveldb), browser passwords/cookies (Login Data, Cookies, key4.db), Steam files (loginusers.vdf, ssfn), crypto wallets, AND sending data out (Discord webhooks, Telegram bot API, raw sockets, unknown servers). Reading personal folders (Environment.GetFolderPath for AppData/LocalAppData) plus network upload is a classic stealer pattern.
2. RATs and backdoors: remote command execution, reverse shells, tunnels (ngrok, duckdns), running cmd/PowerShell, screen capture, keylogging (SetWindowsHookEx), clipboard theft.
3. Droppers and loaders: downloading files and executing them (WebClient.DownloadFile/DownloadData + Process.Start, Assembly.Load of downloaded or base64-decoded bytes), executables or scripts (.exe, .bat, .ps1, .vbs) packed inside a mod zip.
4. Injection and evasion: process injection (VirtualAllocEx, WriteProcessMemory, CreateRemoteThread, NtUnmapViewOfSection), disabling Windows Defender or adding exclusions, anti-VM or anti-debugging checks combined with other bad signs.
5. Persistence: Run registry keys, scheduled tasks, copying itself into the Startup folder.
6. Cryptocurrency miners.

NOT YOUR JOB. Never raise the score for these, and never call them dangerous:
- Cheats and rule-breaking: fly, speed, noclip, long arms, ghost/invisibility, tag aura, anti-ban or anti-report, mod menus, unlocking cosmetics, crashing or kicking other players, Photon RPC abuse. These can get the player banned in-game, but they do not harm the computer. You may mention in "what_it_does" that it is a cheat menu, but the score stays about malware only.
- Normal modding: BepInEx, HarmonyLib (Harmony.Patch, PatchAll), MonoMod, Utilla, GorillaLocomotion, Photon (PhotonNetwork, RPCs), UnityEngine (GUI, Input, AssetBundles, Resources), reflection to access private game fields (Type.GetField, FieldInfo.SetValue, AccessTools).
- Ordinary .NET: System.IO for the mod's own config/assets, System.Linq, generics, async/Task, JSON, Convert.FromBase64String for embedded images, IsDebuggerPresent alone, Assembly.GetExecutingAssembly/GetManifestResourceStream for embedded resources.
- Opening a web page with Process.Start("https://...") or Application.OpenURL; checking GitHub for updates; Discord invite links (discord.gg); links to the author's site.
- Light obfuscation by itself.

HOW TO REASON:
- Read "defined_types" and "defined_methods" first to understand what the mod is. Then check whether its calls fit that purpose. A hat or cosmetic mod has no reason to read browser data, start processes, or upload files.
- Judge combinations, not single words: something to steal + a way to send it; a download + a way to run it. One "unusual" capability alone, with normal mod markers, is usually fine.
- Strong signs on their own: process injection APIs, system-wide keyboard hooks, Discord webhook URLs in a game mod, browser/Discord token paths, miner settings, executables or scripts inside the zip, Defender exclusions.
- If a description is provided and the code clearly does something very different and harmful, treat that as a red flag. A harmless mismatch (e.g. the description is vague) is not.
- If code evidence is missing (code.dotnet_dlls is 0 and there are few calls) or names are obfuscated, your confidence is lower. Do not invent findings. Only cite evidence that appears in the JSON.

SCORE (0-100), about malware only:
- 0-15: no malware signs; normal mod behavior
- 16-40: a few unusual things that are probably legitimate
- 41-70: suspicious; the user should be careful
- 71-100: very likely malware

Respond with ONE JSON object and nothing else:
{
  "score": <integer 0-100>,
  "confidence": "low" | "medium" | "high",
  "what_it_does": "<1-2 plain sentences describing what this mod appears to do in the game, based on its names and calls>",
  "summary": "<one sentence verdict about safety>",
  "reasons": ["<up to 5 short reasons, each pointing at specific evidence>"],
  "capabilities": [{"name": "<short name>", "level": "normal" | "unusual" | "dangerous", "detail": "<under 15 words>"}]
}
Give at most 6 capabilities, most important first. Write summary, reasons and details in plain, calm, simple English (mostly lowercase), like explaining to a teenager. If nothing looks wrong, say what you checked and that nothing stood out."#;

#[derive(Serialize, Clone, Debug)]
pub struct AiCapability {
    pub name: String,
    pub level: String,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct AiVerdict {
    pub score: u8,
    pub confidence: String,
    pub what_it_does: String,
    pub summary: String,
    pub reasons: Vec<String>,
    pub capabilities: Vec<AiCapability>,
}

/// what the uploader says the mod is, for community uploads
pub struct Claim<'a> {
    pub name: &'a str,
    pub description: &'a str,
}

fn truncate_json(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// the facts the model sees. kept to roughly 4,000 tokens so each check stays cheap.
fn user_message(report: &ScanReport, claim: Option<&Claim>) -> String {
    let text_signals: Vec<Value> = report
        .indicators
        .iter()
        .map(|i| json!({ "category": i.category, "finding": i.label, "evidence": i.evidence }))
        .collect();
    let code = &report.code;
    let capabilities: Vec<Value> = code
        .capabilities
        .iter()
        .map(|c| json!({ "name": c.name, "level": c.level, "evidence": c.evidence }))
        .collect();
    let mut facts = json!({
        "file_name": report.file_name,
        "file_type": report.kind,
        "size_bytes": report.size,
        "normal_mod_markers_found": report.mod_markers,
        "code": {
            "dotnet_dlls": code.dotnet_dlls,
            "assemblies": code.assemblies,
            "references": code.references.iter().take(40).collect::<Vec<_>>(),
            "type_count": code.type_count,
            "method_count": code.method_count,
            "obfuscated_names": code.obfuscated,
            "capabilities": capabilities,
            "defined_types": code.defined_types.iter().take(40).collect::<Vec<_>>(),
            "defined_methods": code.defined_methods.iter().take(70).collect::<Vec<_>>(),
            "notable_calls": code.notable_calls.iter().take(110).collect::<Vec<_>>(),
            "windows_calls": code.windows_calls.iter().take(50).collect::<Vec<_>>(),
        },
        "text_signals": text_signals,
        "links_found": report.urls.iter().take(20).collect::<Vec<_>>(),
        "zip_file_count": report.entry_count,
        "zip_files": report.entries.iter().take(50).map(|e| e.name.as_str()).collect::<Vec<_>>(),
        "large_encoded_blobs": report.encoded_blobs,
        "basic_scan_score": report.heuristic_score,
    });
    if let Some(claim) = claim {
        facts["claimed_name"] = json!(claim.name.chars().take(80).collect::<String>());
        facts["claimed_description"] = json!(claim.description.chars().take(1200).collect::<String>());
    }
    let text = truncate_json(facts.to_string(), 15_000);
    format!("Evidence from Branch's scanner for the uploaded file:\n\n{text}")
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// pulls the json object out of the reply, even if the model wrapped it in ``` fences
pub fn parse_reply(content: &str) -> Option<AiVerdict> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    let value: Value = serde_json::from_str(content.get(start..=end)?).ok()?;
    let score = value.get("score")?.as_f64()?.round().clamp(0.0, 100.0) as u8;
    let text = |key: &str, max: usize| clean(value.get(key).and_then(|v| v.as_str()).unwrap_or(""), max);
    let confidence = match text("confidence", 10).to_lowercase().as_str() {
        "high" => "high",
        "low" => "low",
        _ => "medium",
    }
    .to_string();
    let reasons = value
        .get("reasons")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(|r| r.as_str()).take(5).map(|r| clean(r, 220)).filter(|r| !r.is_empty()).collect())
        .unwrap_or_default();
    let capabilities = value
        .get("capabilities")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .take(6)
                .filter_map(|c| {
                    let name = clean(c.get("name")?.as_str()?, 60);
                    let level = match c.get("level").and_then(|l| l.as_str()).unwrap_or("normal") {
                        "dangerous" => "dangerous",
                        "unusual" => "unusual",
                        _ => "normal",
                    };
                    let detail = clean(c.get("detail").and_then(|d| d.as_str()).unwrap_or(""), 140);
                    (!name.is_empty()).then(|| AiCapability { name, level: level.to_string(), detail })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(AiVerdict {
        score,
        confidence,
        what_it_does: text("what_it_does", 400),
        summary: text("summary", 400),
        reasons,
        capabilities,
    })
}

async fn call(http: &reqwest::Client, config: &Config, key: &str, body: &Value) -> Result<(reqwest::StatusCode, Value), String> {
    let response = http
        .post(format!("{}/chat/completions", config.ai_base_url))
        .bearer_auth(key)
        .json(body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("couldn't reach the ai: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("the ai sent something unreadable: {e}"))?;
    Ok((status, value))
}

pub async fn ask(http: &reqwest::Client, config: &Config, report: &ScanReport, claim: Option<&Claim<'_>>) -> Result<AiVerdict, String> {
    let key = config.ai_api_key.as_deref().ok_or("the ai key isn't set")?;
    let mut body = json!({
        "model": config.ai_model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_message(report, claim) },
        ],
        "temperature": 0.1,
        "max_tokens": 700,
        "stream": false,
        // asks for strict json. if a model doesn't support it, we retry without it below.
        "response_format": { "type": "json_object" },
    });
    let (mut status, mut value) = call(http, config, key, &body).await?;
    if status == reqwest::StatusCode::BAD_REQUEST {
        if let Some(map) = body.as_object_mut() {
            map.remove("response_format");
        }
        (status, value) = call(http, config, key, &body).await?;
    }
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
    fn parses_a_full_reply() {
        let v = parse_reply(
            r#"```json
{"score": 87.4, "confidence": "HIGH", "what_it_does": "a hat mod", "summary": "bad", "reasons": ["webhook", "injection"],
 "capabilities": [{"name": "Sends data out", "level": "dangerous", "detail": "discord webhook"}, {"name": "x", "level": "weird"}]}
```"#,
        )
        .unwrap();
        assert_eq!(v.score, 87);
        assert_eq!(v.confidence, "high");
        assert_eq!(v.reasons.len(), 2);
        assert_eq!(v.capabilities.len(), 2);
        assert_eq!(v.capabilities[1].level, "normal", "unknown levels fall back to normal");
    }

    #[test]
    fn clamps_and_rejects_garbage() {
        let v = parse_reply("{\"score\": 400}").unwrap();
        assert_eq!(v.score, 100);
        assert_eq!(v.confidence, "medium");
        assert!(parse_reply("no json here").is_none());
    }
}
