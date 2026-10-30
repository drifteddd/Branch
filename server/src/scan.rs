use std::collections::BTreeSet;
use std::io::{Cursor, Read};

use serde::Serialize;

use crate::util::{sanitize_filename, sha256_hex};

pub const MAX_CHECK_BYTES: usize = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 2000;
const MAX_ENTRY_BYTES: u64 = 25 * 1024 * 1024;
const MAX_UNZIPPED_TOTAL: u64 = 120 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct Indicator {
    pub category: &'static str,
    pub label: &'static str,
    pub weight: u32,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Capability {
    pub name: &'static str,
    pub level: &'static str,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CodeSummary {
    pub dotnet_dlls: usize,
    pub assemblies: Vec<String>,
    pub references: Vec<String>,
    pub notable_calls: Vec<String>,
    pub windows_calls: Vec<String>,
    pub defined_types: Vec<String>,
    pub defined_methods: Vec<String>,
    pub type_count: usize,
    pub method_count: usize,
    pub obfuscated: bool,
    pub capabilities: Vec<Capability>,
}

struct CapabilityRule {
    name: &'static str,
    level: &'static str,
    weight: u32,
    needles: &'static [&'static str],
}

const CAPABILITY_RULES: &[CapabilityRule] = &[
    CapabilityRule { name: "Injects code into other programs", level: "dangerous", weight: 35, needles: &["!createremotethread", "!writeprocessmemory", "!virtualallocex", "!ntunmapviewofsection", "!queueuserapc", "!setthreadcontext", "!ntwritevirtualmemory"] },
    CapabilityRule { name: "Hooks the keyboard system-wide", level: "dangerous", weight: 25, needles: &["!setwindowshookex"] },
    CapabilityRule { name: "Takes screenshots", level: "dangerous", weight: 20, needles: &["system.drawing.graphics::copyfromscreen", "!bitblt"] },
    CapabilityRule { name: "Reads the clipboard", level: "unusual", weight: 10, needles: &["system.windows.forms.clipboard::", "!getclipboarddata"] },
    CapabilityRule { name: "Starts other programs", level: "unusual", weight: 8, needles: &["system.diagnostics.process::start", "system.diagnostics.processstartinfo::", "!createprocess", "!shellexecute", "!winexec"] },
    CapabilityRule { name: "Reads personal folders or account info", level: "unusual", weight: 8, needles: &["system.environment::getfolderpath", "system.environment::get_username", "system.environment::getenvironmentvariable", "system.environment::get_machinename"] },
    CapabilityRule { name: "Changes the Windows registry", level: "unusual", weight: 8, needles: &["microsoft.win32.registry", "!regsetvalue", "!regcreatekey"] },
    CapabilityRule { name: "Opens raw network connections", level: "unusual", weight: 8, needles: &["system.net.sockets.", "!wsastartup"] },
    CapabilityRule { name: "Loads code while running", level: "unusual", weight: 5, needles: &["system.reflection.assembly::load", "system.reflection.emit.", "system.activator::createinstance", "!loadlibrary", "!virtualprotect"] },
    CapabilityRule { name: "Decodes or decrypts data", level: "unusual", weight: 3, needles: &["system.convert::frombase64string", "system.security.cryptography."] },
    CapabilityRule { name: "Internet access", level: "normal", weight: 0, needles: &["system.net.webclient::", "system.net.http.", "system.net.webrequest::", "system.net.httpwebrequest::", "unityengine.networking.unitywebrequest::", "!internetopen", "!urldownloadtofile", "!winhttpopen"] },
    CapabilityRule { name: "Reads or writes files", level: "normal", weight: 0, needles: &["system.io.file::", "system.io.directory::", "system.io.filestream::"] },
    CapabilityRule { name: "Reads key presses (often hotkeys)", level: "normal", weight: 0, needles: &["!getasynckeystate", "!getkeystate", "unityengine.input::getkey", "unityengine.inputsystem."] },
    CapabilityRule { name: "Patches the game (Harmony)", level: "normal", weight: 0, needles: &["harmonylib.", "monomod."] },
    CapabilityRule { name: "Multiplayer (Photon)", level: "normal", weight: 0, needles: &["photon."] },
    CapabilityRule { name: "Draws its own menu or interface", level: "normal", weight: 0, needles: &["unityengine.gui::", "unityengine.guilayout::", "unityengine.ui."] },
];

const BORING_OWNERS: &[&str] = &[
    "system.object", "system.string", "system.collections", "system.linq", "system.text.stringbuilder", "system.math", "system.runtime.compilerservices",
    "system.diagnostics.debug", "system.int", "system.single", "system.double", "system.boolean", "system.array", "system.enum", "system.type::gettypefromhandle",
    "system.console", "system.char", "system.byte", "system.nullable", "system.func", "system.action", "system.exception", "system.datetime", "system.timespan",
    "unityengine.vector", "unityengine.quaternion", "unityengine.mathf", "unityengine.color", "unityengine.transform", "unityengine.gameobject", "unityengine.component",
    "unityengine.object", "unityengine.monobehaviour", "unityengine.time", "unityengine.debug", "unityengine.rect", "unityengine.material", "unityengine.renderer",
];

fn matches_rule(call: &str, rule: &CapabilityRule) -> bool {
    let lower = call.to_lowercase();
    rule.needles.iter().any(|n| lower.contains(n))
}

fn summarize_code(infos: &[(String, crate::pe::PeInfo)]) -> CodeSummary {
    let mut s = CodeSummary::default();
    let mut refs = BTreeSet::new();
    let mut calls = BTreeSet::new();
    let mut windows = BTreeSet::new();
    for (name, info) in infos {
        if info.is_dotnet {
            s.dotnet_dlls += 1;
        }
        s.assemblies.push(info.assembly_name.clone().unwrap_or_else(|| name.clone()));
        refs.extend(info.assembly_refs.iter().cloned());
        calls.extend(info.api_calls.iter().cloned());
        windows.extend(info.pinvokes.iter().cloned());
        windows.extend(info.native_imports.iter().cloned());
        s.type_count += info.type_count;
        s.method_count += info.method_count;
        s.obfuscated |= info.obfuscated_names;
        for t in &info.defined_types {
            if s.defined_types.len() < 60 {
                s.defined_types.push(t.clone());
            }
        }
        for m in &info.defined_methods {
            if s.defined_methods.len() < 100 {
                s.defined_methods.push(m.clone());
            }
        }
    }

    for rule in CAPABILITY_RULES {
        let evidence: Vec<String> = calls.iter().chain(windows.iter()).filter(|c| matches_rule(c.as_str(), rule)).take(4).cloned().collect();
        if !evidence.is_empty() {
            s.capabilities.push(Capability { name: rule.name, level: rule.level, evidence });
        }
    }

    let risky = |c: &str| CAPABILITY_RULES.iter().any(|r| r.weight > 0 && matches_rule(c, r));
    let mut notable: Vec<String> = calls.iter().filter(|c| risky(c.as_str())).cloned().collect();
    for c in &calls {
        if notable.len() >= 150 {
            break;
        }
        let lower = c.to_lowercase();
        if !risky(c.as_str()) && !BORING_OWNERS.iter().any(|b| lower.starts_with(b)) {
            notable.push(c.clone());
        }
    }
    s.notable_calls = notable;
    s.windows_calls = windows.into_iter().take(80).collect();
    s.references = refs.into_iter().take(60).collect();
    s
}

fn capability_weight(code: &CodeSummary) -> u32 {
    code.capabilities
        .iter()
        .filter_map(|cap| CAPABILITY_RULES.iter().find(|r| r.name == cap.name))
        .map(|r| r.weight)
        .sum()
}

const COMMON_NAMES: &[&str] = &[
    "awake", "start", "update", "fixedupdate", "lateupdate", "onenable", "ondisable", "ondestroy", "ongui", "plugin", "main", "invoke", "dispose",
    "tostring", "equals", "gethashcode", "finalize", "initialize", "init", "load", "unload", "prefix", "postfix", "patch", "patches", "instance",
    "config", "settings", "utils", "helpers", "constants", "pluginfo", "myplugininfo", "resources",
];

pub fn similarity(a: &[String], b: &[String]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let set: std::collections::HashSet<&String> = a.iter().collect();
    let shared = b.iter().filter(|x| set.contains(x)).count();
    let union = a.len() + b.len() - shared;
    if union == 0 { 0.0 } else { shared as f32 / union as f32 }
}

impl ScanReport {
    pub fn fingerprint(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for t in &self.code.defined_types {
            let short = t.rsplit('.').next().unwrap_or(t).to_lowercase();
            if short.len() >= 3 && !COMMON_NAMES.contains(&short.as_str()) {
                set.insert(format!("t:{short}"));
            }
        }
        for m in &self.code.defined_methods {
            let lower = m.to_lowercase();
            if lower.len() >= 4 && !COMMON_NAMES.contains(&lower.as_str()) {
                set.insert(format!("m:{lower}"));
            }
        }
        set.into_iter().take(400).collect()
    }

    pub fn has_strong_signals(&self) -> bool {
        self.indicators.iter().any(|i| i.weight >= 20) || self.code.capabilities.iter().any(|c| c.level == "dangerous")
    }

    pub fn final_score(&self, ai_score: u8) -> u8 {
        let floor = (self.heuristic_score as f32 * 0.6).round() as u8;
        let score = ai_score.max(floor);
        if self.has_strong_signals() { score } else { score.min(40) }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct ZipEntry {
    pub name: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ScanReport {
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub kind: &'static str,
    pub dotnet: bool,
    pub entry_count: usize,
    pub entries: Vec<ZipEntry>,
    pub indicators: Vec<Indicator>,
    pub urls: Vec<String>,
    pub mod_markers: Vec<&'static str>,
    pub encoded_blobs: usize,
    pub heuristic_score: u8,
    pub code: CodeSummary,
}

struct Rule {
    category: &'static str,
    label: &'static str,
    weight: u32,
    needles: &'static [&'static str],
}

const RULES: &[Rule] = &[
    Rule { category: "stealing", label: "has a discord webhook (often used to send stolen data)", weight: 30, needles: &["discord.com/api/webhooks", "discordapp.com/api/webhooks"] },
    Rule { category: "stealing", label: "talks to the telegram bot api (often used to send stolen data)", weight: 25, needles: &["api.telegram.org/bot"] },
    Rule { category: "stealing", label: "reads browser or discord login storage", weight: 30, needles: &["local storage\\leveldb", "local storage/leveldb", "\\login data", "\\network\\cookies", "logins.json", "key4.db", "discord\\local storage"] },
    Rule { category: "stealing", label: "looks for crypto wallets", weight: 25, needles: &["wallet.dat", "\\exodus\\", "metamask", "electrum\\wallets"] },
    Rule { category: "stealing", label: "reads steam login files", weight: 25, needles: &["loginusers.vdf", "\\steam\\config\\config.vdf", "\\ssfn"] },
    Rule { category: "remote control", label: "injects code into other programs", weight: 35, needles: &["createremotethread", "writeprocessmemory", "virtualallocex", "ntunmapviewofsection", "queueuserapc", "setthreadcontext"] },
    Rule { category: "spying", label: "hooks the keyboard system-wide", weight: 25, needles: &["setwindowshookex", "wh_keyboard_ll"] },
    Rule { category: "spying", label: "reads key presses directly (keyloggers do this, but some mods use it for hotkeys)", weight: 8, needles: &["getasynckeystate", "getkeyboardstate"] },
    Rule { category: "spying", label: "takes screenshots or uses the webcam", weight: 20, needles: &["copyfromscreen", "avicap32", "capcreatecapturewindow"] },
    Rule { category: "remote control", label: "runs hidden commands or scripts", weight: 25, needles: &["cmd.exe /c", "cmd /c ", "powershell", "-encodedcommand", "-windowstyle hidden", "mshta", "rundll32", "regsvr32", "wscript", "cscript"] },
    Rule { category: "remote control", label: "opens raw network connections or tunnels", weight: 12, needles: &["system.net.sockets.tcpclient", "tcplistener", "reverse shell", "ngrok", "duckdns.org", "portmap.io"] },
    Rule { category: "download and run", label: "downloads files", weight: 12, needles: &["downloadfile", "downloaddata", "downloadfileasync"] },
    Rule { category: "download and run", label: "starts other programs", weight: 8, needles: &["processstartinfo", "shellexecute", "winexec", "createprocess"] },
    Rule { category: "download and run", label: "fetches text from paste sites", weight: 20, needles: &["pastebin.com/raw", "hastebin", "paste.ee/r", "rentry.co/"] },
    Rule { category: "staying hidden", label: "sets itself to start with windows", weight: 25, needles: &["currentversion\\run", "schtasks", "start menu\\programs\\startup", "\\winlogon"] },
    Rule { category: "staying hidden", label: "tries to avoid antivirus or analysis tools", weight: 25, needles: &["add-mppreference", "exclusionpath", "disableantispyware", "vboxservice", "vmwaretray", "sbiedll", "processhacker"] },
    Rule { category: "staying hidden", label: "checks if a debugger is attached (common in normal programs too)", weight: 5, needles: &["checkremotedebuggerpresent", "isdebuggerpresent"] },
    Rule { category: "hiding code", label: "was run through an obfuscator", weight: 10, needles: &["confuserex", "confused by", ".net reactor", "babelobfuscator", "smartassembly", "eazfuscator"] },
    Rule { category: "hiding code", label: "loads extra code while running (common in .net, mods use it too)", weight: 4, needles: &["assembly.load", "loadfrom", "virtualprotect", "reflection.emit", "invokemember"] },
    Rule { category: "mining", label: "has crypto miner settings", weight: 35, needles: &["stratum+tcp", "xmrig", "nicehash", "cryptonight", "--donate-level"] },
];

const MOD_MARKERS: &[(&str, &str)] = &[
    ("bepinex", "BepInEx"),
    ("harmonylib", "Harmony"),
    ("0harmony", "Harmony"),
    ("photon", "Photon (multiplayer)"),
    ("gorillalocomotion", "GorillaLocomotion"),
    ("gorillatag", "Gorilla Tag"),
    ("utilla", "Utilla"),
    ("unityengine", "UnityEngine"),
    ("monomod", "MonoMod"),
];

const RISKY_EXTENSIONS: &[&str] = &[".exe", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".lnk", ".msi", ".com", ".pif", ".jar"];
const ARCHIVE_EXTENSIONS: &[&str] = &[".zip", ".rar", ".7z", ".tar", ".gz"];

fn extract_strings(data: &[u8], out: &mut Vec<String>) {
    const MIN: usize = 5;
    const MAX_STRINGS: usize = 200_000;

    let mut current = String::new();
    for &b in data {
        if (0x20..0x7f).contains(&b) {
            current.push(b as char);
        } else {
            if current.len() >= MIN {
                out.push(std::mem::take(&mut current));
            }
            current.clear();
        }
        if out.len() >= MAX_STRINGS {
            return;
        }
    }
    if current.len() >= MIN {
        out.push(std::mem::take(&mut current));
    }

    current.clear();
    for pair in data.chunks_exact(2) {
        if pair[1] == 0 && (0x20..0x7f).contains(&pair[0]) {
            current.push(pair[0] as char);
        } else {
            if current.len() >= MIN {
                out.push(std::mem::take(&mut current));
            }
            current.clear();
        }
        if out.len() >= MAX_STRINGS {
            return;
        }
    }
    if current.len() >= MIN {
        out.push(current);
    }
}

fn looks_base64(s: &str) -> bool {
    s.len() >= 200 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

fn find_urls(strings: &[String]) -> Vec<String> {
    let mut urls = BTreeSet::new();
    for s in strings {
        for start in ["https://", "http://"] {
            let mut rest = s.as_str();
            while let Some(i) = rest.find(start) {
                let tail = &rest[i..];
                let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`')).unwrap_or(tail.len());
                if end > start.len() + 3 {
                    urls.insert(truncate(&tail[..end], 150));
                }
                rest = &tail[end.max(1)..];
                if urls.len() >= 40 {
                    return urls.into_iter().collect();
                }
            }
        }
    }
    urls.into_iter().collect()
}

pub fn scan(original_name: &str, data: &[u8]) -> Result<ScanReport, String> {
    if data.is_empty() {
        return Err("the file is empty".into());
    }
    if data.len() > MAX_CHECK_BYTES {
        return Err("files can be up to 50 MB".into());
    }
    let file_name = sanitize_filename(original_name).unwrap_or_else(|| "upload".into());
    let mut strings = Vec::new();
    let mut entries = Vec::new();
    let mut entry_count = 0;
    let mut risky_entries = Vec::new();
    let mut nested_archives = Vec::new();
    let mut dlls: Vec<(String, crate::pe::PeInfo)> = Vec::new();

    let kind = if data.starts_with(b"MZ") {
        extract_strings(data, &mut strings);
        if let Some(info) = crate::pe::inspect(data) {
            dlls.push((file_name.clone(), info));
        }
        "dll"
    } else if data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06") {
        let mut archive = zip::ZipArchive::new(Cursor::new(data)).map_err(|_| "this zip file is broken".to_string())?;
        entry_count = archive.len();
        let mut unzipped: u64 = 0;
        for i in 0..archive.len().min(MAX_ZIP_ENTRIES) {
            let Ok(mut entry) = archive.by_index(i) else { continue };
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let lower = name.to_lowercase();
            if entries.len() < 300 {
                entries.push(ZipEntry { name: truncate(&name, 160), size: entry.size() });
            }
            if RISKY_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
                risky_entries.push(truncate(&name, 120));
            }
            if ARCHIVE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
                nested_archives.push(truncate(&name, 120));
            }
            if unzipped >= MAX_UNZIPPED_TOTAL {
                continue;
            }
            let budget = MAX_ENTRY_BYTES.min(MAX_UNZIPPED_TOTAL - unzipped);
            let mut buf = Vec::new();
            if (&mut entry).take(budget).read_to_end(&mut buf).is_ok() {
                unzipped += buf.len() as u64;
                extract_strings(&buf, &mut strings);
                if dlls.len() < 8 && lower.ends_with(".dll") {
                    if let Some(info) = crate::pe::inspect(&buf) {
                        dlls.push((name.clone(), info));
                    }
                }
            }
        }
        "zip"
    } else {
        return Err("only .dll and .zip files can be checked".into());
    };

    let lowered: Vec<String> = strings.iter().map(|s| s.to_lowercase()).collect();
    let dotnet = data.windows(4).any(|w| w == b"BSJB") || lowered.iter().any(|s| s == "mscorlib" || s == "netstandard");

    let mut indicators = Vec::new();
    for rule in RULES {
        let mut evidence = Vec::new();
        for (i, s) in lowered.iter().enumerate() {
            if rule.needles.iter().any(|n| s.contains(n)) {
                evidence.push(truncate(&strings[i], 120));
                if evidence.len() >= 3 {
                    break;
                }
            }
        }
        if !evidence.is_empty() {
            indicators.push(Indicator { category: rule.category, label: rule.label, weight: rule.weight, evidence });
        }
    }
    if !risky_entries.is_empty() {
        risky_entries.truncate(5);
        indicators.push(Indicator { category: "download and run", label: "the zip has programs or scripts that can run on their own", weight: 30, evidence: risky_entries });
    }
    if !nested_archives.is_empty() {
        nested_archives.truncate(5);
        indicators.push(Indicator { category: "hiding code", label: "the zip has more archives inside it", weight: 5, evidence: nested_archives });
    }
    let encoded_blobs = strings.iter().filter(|s| looks_base64(s)).count();
    if encoded_blobs > 0 {
        indicators.push(Indicator {
            category: "hiding code",
            label: "has large encoded blobs of data (often just images or settings)",
            weight: 4,
            evidence: vec![format!("{encoded_blobs} long base64 string(s)")],
        });
    }

    let mod_markers: Vec<&'static str> = {
        let mut found: Vec<&'static str> = Vec::new();
        for (needle, label) in MOD_MARKERS {
            if !found.contains(label) && lowered.iter().any(|s| s.contains(needle)) {
                found.push(label);
            }
        }
        found
    };

    let code = summarize_code(&dlls);
    let text_weight: u32 = indicators.iter().map(|i| i.weight).sum();
    let call_weight = capability_weight(&code);
    let combined = text_weight.max(call_weight) + text_weight.min(call_weight) / 3;
    let heuristic_score = combined.min(100) as u8;
    let dotnet = dotnet || code.dotnet_dlls > 0;

    Ok(ScanReport {
        file_name,
        size: data.len() as u64,
        sha256: sha256_hex(data),
        kind,
        dotnet,
        entry_count,
        entries,
        indicators,
        urls: find_urls(&strings),
        mod_markers,
        encoded_blobs,
        heuristic_score,
        code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fake_dll(text: &str) -> Vec<u8> {
        let mut data = b"MZ\x90\x00\x03\x00".to_vec();
        data.extend_from_slice(b"\x00\x00");
        data.extend_from_slice(text.as_bytes());
        data.extend_from_slice(b"\x00\x00");
        for c in "BepInEx.BaseUnityPlugin".chars() {
            data.push(c as u8);
            data.push(0);
        }
        data
    }

    #[test]
    fn a_normal_mod_scores_low() {
        let report = scan("cool.dll", &fake_dll("HarmonyLib\0UnityEngine\0GorillaLocomotion.Player\0https://github.com/someone/mod")).unwrap();
        assert!(report.heuristic_score < 20, "{:?}", report.indicators);
        assert!(report.mod_markers.contains(&"BepInEx"));
        assert!(report.urls.iter().any(|u| u.contains("github.com")));
    }

    #[test]
    fn a_stealer_scores_high() {
        let text = "https://discord.com/api/webhooks/123/abc\0\\Local Storage\\leveldb\0CreateRemoteThread\0Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        let report = scan("totally-safe.dll", &fake_dll(text)).unwrap();
        assert!(report.heuristic_score >= 80, "{}", report.heuristic_score);
        assert!(report.indicators.iter().any(|i| i.category == "stealing"));
    }

    #[test]
    fn zips_are_unpacked_and_scripts_flagged() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("plugins/mod.dll", opts).unwrap();
            zip.write_all(&fake_dll("xmrig --donate-level 1")).unwrap();
            zip.start_file("install.bat", opts).unwrap();
            zip.write_all(b"@echo off").unwrap();
            zip.finish().unwrap();
        }
        let report = scan("pack.zip", buf.get_ref()).unwrap();
        assert_eq!(report.kind, "zip");
        assert_eq!(report.entry_count, 2);
        assert!(report.indicators.iter().any(|i| i.category == "mining"));
        assert!(report.indicators.iter().any(|i| i.evidence.iter().any(|e| e.contains("install.bat"))));
    }

    #[test]
    fn the_ai_needs_real_evidence_for_a_high_score() {
        let clean = scan("library.dll", &fake_dll("HarmonyLib\0UnityEngine\0System.Reflection.Emit")).unwrap();
        assert!(!clean.has_strong_signals());
        assert_eq!(clean.final_score(90), 40, "no concrete sign means at most 'a few odd things'");
        assert_eq!(clean.final_score(10), 10);
        let stealer = scan("x.dll", &fake_dll("https://discord.com/api/webhooks/1/x\0\\Local Storage\\leveldb")).unwrap();
        assert!(stealer.has_strong_signals());
        assert_eq!(stealer.final_score(90), 90);
        assert!(stealer.final_score(0) >= 30, "strong signs can't be waved away");
    }

    #[test]
    fn other_files_are_refused() {
        assert!(scan("x.txt", b"hello there").is_err());
        assert!(scan("x.dll", b"").is_err());
    }
}
