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
- Not being a Gorilla Tag mod is NOT a malware sign. If the file looks like an ordinary library or framework (for example a Microsoft, Unity or open-source library), say so in "what_it_does" and keep the score low. Never list "no mod markers" or "deprecated framework" as a reason.
- Large libraries and frameworks normally use Reflection.Emit, dynamic code generation, embedded base64 resources, system event handlers, file access and HTTP. Treat runtime code loading as suspicious ONLY when it is combined with downloading or decoding a payload and running it, or with other malware signs.

CALIBRATION (follow strictly):
- If there is no evidence of stealing data, sending data out to webhooks/bots/unknown servers, downloading-and-running files, process injection, keylogging or screen capture, persistence, Defender tampering, crypto mining, or executables/scripts packed in the zip, the score MUST be 25 or lower, no matter how many "unusual" capabilities there are.
- Use 41 or higher only when you can name at least one concrete malware behavior from the evidence.

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

pub const UPLOAD_EXTRA_PROMPT: &str = r#"

THIS FILE IS BEING UPLOADED TO BRANCH'S PUBLIC MOD LIST. Besides the safety fields above, also fill in these fields to help players, using the same evidence plus "claimed_name" and "claimed_description":
  "overview": "<2-4 sentences: an independent, neutral overview of what the mod does and how it works, based mainly on the code evidence. Do not copy or just reword the uploader's description. Do not praise the mod. If the evidence is thin, say what you can tell and keep it short.>",
  "highlights": ["<up to 4 short feature bullets, under 10 words each, only things the evidence supports>"],
  "tags": ["<3 to 5 short lowercase tags, 1-2 words each. Prefer tags from \"existing_tags\" when they fit; only invent a new tag if none fit. Never use tags like 'mod', 'gorilla tag', 'dll' or 'safe'.>"],
  "category": "<the best slug from \"categories\", or null if none fits>",
  "requirements": ["<other mods or loaders it needs to run, e.g. 'BepInEx', 'Utilla', 'Newtilla', 'ComputerInterface'. Only list what appears in the evidence (references, mod markers). Empty if unsure.>"],
  "ban_risk": "none" | "low" | "high",
  "ban_risk_reason": "<one short sentence. 'high' for cheats, mod menus, anti-ban, abusing other players or the network; 'low' for things that only change your own view or are allowed in modded lobbies; 'none' for libraries and purely visual client-side mods. This is about getting banned in Gorilla Tag, not about malware.>",
  "description_match": "matches" | "partly" | "mismatch"
"description_match" says whether the uploader's description fits what the code does: "matches" if it fits, "partly" if it's vague or only covers part of it, "mismatch" if it describes something clearly different. Add all of these keys to the same JSON object."#;

pub const WRITE_LISTING_PROMPT: &str = r#"

THE UPLOADER DIDN'T WRITE A NAME OR DESCRIPTION, so you write them too. Add these keys to the same JSON object:
  "suggested_name": "<a short, clear mod name, 2-5 words in Title Case. Base it on the file name, assembly name and main class names (e.g. a 'LongArms.dll' with a 'LongArmsPlugin' class becomes 'Long Arms'). Don't add words like 'Mod', 'Gorilla Tag' or a version number.>",
  "suggested_description": "<a helpful description for the mod page in Markdown, 60-200 words: one short intro sentence about what it does, then a '**Features**' bullet list of only what the evidence supports, then '**How to use**' with short steps if you can tell how it's used (for example a menu, a button or a key). Say it needs BepInEx or other mods if the evidence shows that. Plain, friendly wording. Never invent features.>"
If "claimed_name" or "claimed_description" is provided, keep it and only fill in what's missing."#;

#[derive(Serialize, Clone, Debug, Default)]
pub struct UploadInsights {
    pub suggested_name: String,
    pub suggested_description: String,
    pub overview: String,
    pub highlights: Vec<String>,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub requirements: Vec<String>,
    pub ban_risk: String,
    pub ban_risk_reason: String,
    pub description_match: String,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insights: Option<UploadInsights>,
}

pub struct Claim<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub existing_tags: &'a [String],
    pub categories: &'a [String],
    pub write_listing: bool,
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
        facts["existing_tags"] = json!(claim.existing_tags.iter().take(80).collect::<Vec<_>>());
        facts["categories"] = json!(claim.categories);
    }
    let text = truncate_json(facts.to_string(), 15_000);
    format!("Evidence from Branch's scanner for the uploaded file:\n\n{text}")
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

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
        insights: parse_insights(&value),
    })
}

fn parse_insights(value: &Value) -> Option<UploadInsights> {
    let overview = clean(value.get("overview")?.as_str()?, 900);
    let list = |key: &str, max: usize, len: usize| -> Vec<String> {
        value
            .get(key)
            .and_then(|v| v.as_array())
            .map(|l| l.iter().filter_map(|x| x.as_str()).map(|x| clean(x, len)).filter(|x| !x.is_empty()).take(max).collect())
            .unwrap_or_default()
    };
    let pick = |key: &str, allowed: &[&str], fallback: &str| -> String {
        let v = value.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
        if allowed.contains(&v.as_str()) { v } else { fallback.to_string() }
    };
    let mut tags: Vec<String> = Vec::new();
    for tag in list("tags", 8, 24) {
        let tag = tag.to_lowercase();
        let banned = ["mod", "mods", "gorilla tag", "gorillatag", "dll", "safe", "bepinex mod"];
        if tag.chars().count() >= 2 && !banned.contains(&tag.as_str()) && !tags.contains(&tag) && tags.len() < 5 {
            tags.push(tag);
        }
    }
    let category = value.get("category").and_then(|c| c.as_str()).map(|c| c.trim().to_lowercase()).filter(|c| !c.is_empty() && c != "null");
    Some(UploadInsights {
        suggested_name: clean(value.get("suggested_name").and_then(|v| v.as_str()).unwrap_or(""), 80),
        suggested_description: value
            .get("suggested_description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(3000)
            .collect::<String>()
            .trim()
            .to_string(),
        overview,
        highlights: list("highlights", 4, 90),
        tags,
        category,
        requirements: list("requirements", 6, 40),
        ban_risk: pick("ban_risk", &["none", "low", "high"], "low"),
        ban_risk_reason: clean(value.get("ban_risk_reason").and_then(|v| v.as_str()).unwrap_or(""), 220),
        description_match: pick("description_match", &["matches", "partly", "mismatch"], "partly"),
    })
}

async fn call(http: &reqwest::Client, config: &Config, key: &str, body: &Value) -> Result<(reqwest::StatusCode, Value), String> {
    call_with_timeout(http, config, key, body, Duration::from_secs(60)).await
}

async fn call_with_timeout(http: &reqwest::Client, config: &Config, key: &str, body: &Value, timeout: Duration) -> Result<(reqwest::StatusCode, Value), String> {
    let response = http
        .post(format!("{}/chat/completions", config.ai_base_url))
        .bearer_auth(key)
        .json(body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("couldn't reach the ai: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("the ai sent something unreadable: {e}"))?;
    Ok((status, value))
}

pub async fn ask(http: &reqwest::Client, config: &Config, report: &ScanReport, claim: Option<&Claim<'_>>) -> Result<AiVerdict, String> {
    let key = config.ai_api_key.as_deref().ok_or("the ai key isn't set")?;
    let (system, max_tokens) = match claim {
        Some(c) if c.write_listing => (format!("{SYSTEM_PROMPT}{UPLOAD_EXTRA_PROMPT}{WRITE_LISTING_PROMPT}"), 1700),
        Some(_) => (format!("{SYSTEM_PROMPT}{UPLOAD_EXTRA_PROMPT}"), 1200),
        None => (SYSTEM_PROMPT.to_string(), 700),
    };
    let mut body = json!({
        "model": config.ai_model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user_message(report, claim) },
        ],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stream": false,
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
        let message = value.pointer("/message").or_else(|| value.pointer("/error/message")).and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(format!("the ai answered {status}: {message}"));
    }
    let content = value.pointer("/choices/0/message/content").and_then(|v| v.as_str()).ok_or("the ai sent an empty answer")?;
    parse_reply(content).ok_or_else(|| "the ai's answer wasn't in the expected format".to_string())
}

const DUPLICATE_PROMPT: &str = r#"You check uploads to Branch, a Gorilla Tag mod library. Decide whether a NEW upload is the same mod as one already listed (a re-upload, a copy, a renamed or slightly edited version), or a genuinely different mod.

You get the new mod's name, description and code fingerprint (its own class and method names), and a few existing mods that look similar, each with how much of their code names overlap with the new one (0.0 to 1.0) and a sample of the shared names.

Rules:
- Same mod: most of the distinctive class/method names match (overlap above about 0.6), or the purpose and code names are essentially identical even if the name, author or description changed. A newer version of a mod that is already listed also counts as the same mod.
- Different mod: a different purpose, even if both use common frameworks (BepInEx, Harmony, Utilla, UnityEngine) or share a few generic names (Plugin, Menu, Toggle, Settings).
- Matching names alone (e.g. two different mods both called "Fly") are not enough. Judge the code overlap and descriptions.
- If unsure, say not a duplicate with low confidence.

Respond with one JSON object only:
{"duplicate": true | false, "duplicate_of_id": "<id of the matching existing mod or null>", "confidence": "low" | "medium" | "high", "reason": "<one short plain sentence>"}"#;

const REWARDS_PROMPT: &str = r#"You review applications to Branch's rewards program. Branch is a Gorilla Tag mod library; people who upload genuine, unique mods can earn small Roblox rewards. Before an application reaches the human admin, you check the applicant's uploads.

You get a list of every mod the applicant uploaded: name, description, file size, how many distinctive code names it has ("fingerprint_size"), the highest code overlap with any OTHER mod on Branch ("max_overlap_with_others", 0.0-1.0) and which mod that was, and the highest overlap with the applicant's OWN other uploads ("max_overlap_with_own").

Approve when the uploads look like genuine, distinct mods. Do NOT approve when:
- several uploads are copies of each other (own overlap above about 0.6) or copies of other people's mods (overlap with others above about 0.6),
- uploads look like junk or filler to reach the count: tiny files with almost no code (fingerprint_size near 0), meaningless or repeated names, copy-pasted or nonsense descriptions,
- descriptions are clearly misleading compared with the rest of the evidence.
One weak, borderline item is not a reason to reject if the rest is clearly fine; mention it instead.

Respond with one JSON object only:
{"approve": true | false, "summary": "<one or two plain sentences for the admin>", "reasons": ["<up to 5 short reasons>"], "flagged_mod_ids": ["<ids of problem uploads>"]}"#;

async fn ask_json(http: &reqwest::Client, config: &Config, system: &str, payload: &Value, max_tokens: u32) -> Result<Value, String> {
    let key = config.ai_api_key.as_deref().ok_or("the ai key isn't set")?;
    let user = truncate_json(payload.to_string(), 15_000);
    let mut body = json!({
        "model": config.ai_model,
        "messages": [ { "role": "system", "content": system }, { "role": "user", "content": user } ],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stream": false,
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
        let message = value.pointer("/message").or_else(|| value.pointer("/error/message")).and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(format!("the ai answered {status}: {message}"));
    }
    let content = value.pointer("/choices/0/message/content").and_then(|v| v.as_str()).ok_or("the ai sent an empty answer")?;
    let start = content.find('{').ok_or("no json in the answer")?;
    let end = content.rfind('}').ok_or("no json in the answer")?;
    serde_json::from_str(&content[start..=end]).map_err(|_| "the ai's answer wasn't valid json".to_string())
}

pub async fn chat(http: &reqwest::Client, config: &Config, system: &str, messages: &[Value], max_tokens: u32) -> Result<String, String> {
    let key = config.ai_api_key.as_deref().ok_or("the ai key isn't set")?;
    let mut all = vec![json!({ "role": "system", "content": system })];
    all.extend(messages.iter().cloned());
    let body = json!({
        "model": config.ai_model,
        "messages": all,
        "temperature": 0.4,
        "top_p": 0.9,
        "max_tokens": max_tokens,
        "stream": false,
    });
    let (status, value) = call_with_timeout(http, config, key, &body, Duration::from_secs(150)).await?;
    if !status.is_success() {
        let message = value.pointer("/message").or_else(|| value.pointer("/error/message")).and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(format!("the ai answered {status}: {message}"));
    }
    let content = value.pointer("/choices/0/message/content").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err("the ai sent an empty answer".into());
    }
    Ok(content)
}

const PICKS_PROMPT: &str = r#"You welcome new users to Branch, a free Gorilla Tag mod app, by recommending a few mods to start with.

You get the user's interests, what they want to use Branch for, and Branch's catalog of mods (slug, name, category, tags, summary, average rating, downloads, ban risk).

Rules:
- Pick up to 6 mods from the catalog that fit the user's interests best. Only use slugs that appear in the catalog.
- Prefer well-rated and popular mods, and mods with low or no ban risk, unless the user's interests are clearly about menus, competitive play or cheats.
- Mix it up a little: don't pick six nearly identical mods if other good matches exist.
- If nothing fits well, pick the most popular, well-rated mods instead.
- For each pick, write one short, friendly reason (under 18 words) that connects the mod to what the user said. Plain wording, mostly lowercase.

Respond with one JSON object only:
{"picks": [{"slug": "<slug from the catalog>", "reason": "<short reason>"}]}"#;

pub async fn pick_mods(http: &reqwest::Client, config: &Config, payload: &Value) -> Result<Vec<(String, String)>, String> {
    let v = ask_json(http, config, PICKS_PROMPT, payload, 600).await?;
    Ok(v.get("picks")
        .and_then(|p| p.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|p| Some((p.get("slug")?.as_str()?.trim().to_string(), clean(p.get("reason").and_then(|r| r.as_str()).unwrap_or(""), 160))))
                .take(6)
                .collect()
        })
        .unwrap_or_default())
}

pub struct DuplicateVerdict {
    pub duplicate: bool,
    pub duplicate_of: Option<String>,
    pub confident: bool,
    pub reason: String,
}

pub async fn ask_duplicate(http: &reqwest::Client, config: &Config, payload: &Value) -> Result<DuplicateVerdict, String> {
    let v = ask_json(http, config, DUPLICATE_PROMPT, payload, 200).await?;
    Ok(DuplicateVerdict {
        duplicate: v.get("duplicate").and_then(|d| d.as_bool()).unwrap_or(false),
        duplicate_of: v.get("duplicate_of_id").and_then(|d| d.as_str()).map(str::to_owned),
        confident: v.get("confidence").and_then(|c| c.as_str()).map(|c| c != "low").unwrap_or(false),
        reason: clean(v.get("reason").and_then(|r| r.as_str()).unwrap_or(""), 240),
    })
}

pub struct RewardsReview {
    pub approve: bool,
    pub summary: String,
    pub reasons: Vec<String>,
    pub flagged: Vec<String>,
}

pub async fn ask_rewards_review(http: &reqwest::Client, config: &Config, payload: &Value) -> Result<RewardsReview, String> {
    let v = ask_json(http, config, REWARDS_PROMPT, payload, 500).await?;
    let list = |key: &str, max: usize| -> Vec<String> {
        v.get(key).and_then(|l| l.as_array()).map(|l| l.iter().filter_map(|x| x.as_str()).take(max).map(|x| clean(x, 220)).collect()).unwrap_or_default()
    };
    Ok(RewardsReview {
        approve: v.get("approve").and_then(|a| a.as_bool()).unwrap_or(false),
        summary: clean(v.get("summary").and_then(|s| s.as_str()).unwrap_or(""), 400),
        reasons: list("reasons", 5),
        flagged: list("flagged_mod_ids", 60),
    })
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
    fn parses_upload_insights() {
        let v = parse_reply(
            r#"{"score": 10, "confidence": "high", "what_it_does": "hats", "summary": "fine", "reasons": [], "capabilities": [],
                "overview": "adds a hat menu.", "highlights": ["pick a hat", "", "saves your choice"],
                "tags": ["Hats", "mod", "cosmetics", "hats", "x", "fun", "menu", "extra", "too many"],
                "category": "Cosmetics", "requirements": ["BepInEx", "Utilla"], "ban_risk": "NONE", "description_match": "weird"}"#,
        )
        .unwrap();
        let i = v.insights.expect("upload fields");
        assert_eq!(i.overview, "adds a hat menu.");
        assert_eq!(i.highlights, vec!["pick a hat", "saves your choice"]);
        assert_eq!(i.tags, vec!["hats", "cosmetics", "fun", "menu", "extra"], "lowercased, no duplicates, no banned or 1-letter tags, max 5");
        assert_eq!(i.category.as_deref(), Some("cosmetics"));
        assert_eq!(i.ban_risk, "none");
        assert_eq!(i.description_match, "partly", "unknown values fall back");
        assert!(parse_reply(r#"{"score": 5}"#).unwrap().insights.is_none(), "mod checker replies have no upload fields");
    }

    #[test]
    fn clamps_and_rejects_garbage() {
        let v = parse_reply("{\"score\": 400}").unwrap();
        assert_eq!(v.score, 100);
        assert_eq!(v.confidence, "medium");
        assert!(parse_reply("no json here").is_none());
    }
}
