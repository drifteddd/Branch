// the basic scan behind the mod checker. it never runs the file. it reads the
// text hidden inside it (names, links, windows functions) and looks for things
// malware needs, like sending data to a discord webhook or injecting into other
// programs. cheats and game changes are deliberately not on this list.

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
}

struct Rule {
    category: &'static str,
    label: &'static str,
    weight: u32,
    needles: &'static [&'static str],
}

// all needles are lowercase. weights add up into the basic score (capped at 100).
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
    Rule { category: "staying hidden", label: "tries to avoid antivirus or analysis tools", weight: 25, needles: &["isdebuggerpresent", "checkremotedebuggerpresent", "add-mppreference", "exclusionpath", "disableantispyware", "vboxservice", "vmwaretray", "sbiedll", "processhacker"] },
    Rule { category: "hiding code", label: "was run through an obfuscator", weight: 10, needles: &["confuserex", "confused by", ".net reactor", "babelobfuscator", "smartassembly", "eazfuscator"] },
    Rule { category: "hiding code", label: "loads extra code while running", weight: 8, needles: &["assembly.load", "loadfrom", "virtualprotect", "reflection.emit", "invokemember"] },
    Rule { category: "mining", label: "has crypto miner settings", weight: 35, needles: &["stratum+tcp", "xmrig", "nicehash", "cryptonight", "--donate-level"] },
];

// normal gorilla tag mod stuff. shown to the ai so it knows what's expected.
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

/// collects readable text from binary data: plain ascii and the utf-16 text .net uses
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

    let kind = if data.starts_with(b"MZ") {
        extract_strings(data, &mut strings);
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
            // read each file with a cap, so a "zip bomb" can't blow up memory
            if unzipped >= MAX_UNZIPPED_TOTAL {
                continue;
            }
            let budget = MAX_ENTRY_BYTES.min(MAX_UNZIPPED_TOTAL - unzipped);
            let mut buf = Vec::new();
            if (&mut entry).take(budget).read_to_end(&mut buf).is_ok() {
                unzipped += buf.len() as u64;
                extract_strings(&buf, &mut strings);
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
            label: "has large encoded blobs of data",
            weight: 10,
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

    let heuristic_score = indicators.iter().map(|i| i.weight).sum::<u32>().min(100) as u8;

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
        // the same text as utf-16, like .net stores user strings
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
    fn other_files_are_refused() {
        assert!(scan("x.txt", b"hello there").is_err());
        assert!(scan("x.dll", b"").is_err());
    }
}
