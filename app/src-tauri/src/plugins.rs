use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::CmdError;

const DISABLED: &str = ".disabled";
const MAX_READ: u64 = 50 * 1024 * 1024;

#[derive(Default)]
pub struct Plugins {
    game: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
pub struct FolderInfo {
    game_dir: String,
    plugins_dir: String,
    bepinex: bool,
    game_found: bool,
}

#[derive(Serialize)]
pub struct PluginFile {
    id: String,
    name: String,
    file_name: String,
    folder: Option<String>,
    size: u64,
    modified: u64,
    enabled: bool,
    sha256: String,
}

fn game_from(path: &Path) -> PathBuf {
    let lower: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
    let n = lower.len();
    if n >= 2 && lower[n - 1] == "plugins" && lower[n - 2] == "bepinex" {
        return path.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf());
    }
    if n >= 1 && lower[n - 1] == "bepinex" {
        return path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf());
    }
    path.to_path_buf()
}

fn looks_like_game(dir: &Path) -> bool {
    dir.join("Gorilla Tag.exe").is_file() || dir.join("BepInEx").is_dir()
}

fn info(game: &Path) -> FolderInfo {
    FolderInfo {
        game_dir: game.display().to_string(),
        plugins_dir: game.join("BepInEx").join("plugins").display().to_string(),
        bepinex: game.join("BepInEx").is_dir(),
        game_found: game.join("Gorilla Tag.exe").is_file(),
    }
}

fn plugins_dir(state: &Plugins) -> Result<PathBuf, CmdError> {
    let game = state.game.lock().unwrap().clone().ok_or_else(|| CmdError::new("app", "pick your Gorilla Tag folder first"))?;
    Ok(game.join("BepInEx").join("plugins"))
}

fn resolve(state: &Plugins, id: &str) -> Result<PathBuf, CmdError> {
    let rel = Path::new(id);
    if id.is_empty() || rel.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(CmdError::new("app", "that file isn't in your plugins folder"));
    }
    let path = plugins_dir(state)?.join(rel);
    if !path.is_file() {
        return Err(CmdError::new("app", "that file isn't there anymore. press refresh."));
    }
    Ok(path)
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"C:\Program Files\Steam")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for dir in [".steam/steam", ".steam/root", ".local/share/Steam", ".var/app/com.valvesoftware.Steam/.local/share/Steam", "snap/steam/common/.local/share/Steam"] {
            roots.push(home.join(dir));
        }
    }
    roots
}

#[tauri::command]
pub fn plugins_detect() -> Vec<String> {
    let mut libraries = steam_roots();
    for steam in libraries.clone() {
        if let Ok(vdf) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
            for line in vdf.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("\"path\"") {
                    let value = rest.trim().trim_matches('"').replace("\\\\", "\\");
                    if !value.is_empty() {
                        libraries.push(PathBuf::from(value));
                    }
                }
            }
        }
    }
    let mut found: Vec<String> = Vec::new();
    let mut candidates: Vec<PathBuf> = libraries.iter().map(|l| l.join("steamapps").join("common").join("Gorilla Tag")).collect();
    for drive in ["C", "D", "E", "F"] {
        candidates.push(PathBuf::from(format!(r"{drive}:\SteamLibrary\steamapps\common\Gorilla Tag")));
        candidates.push(PathBuf::from(format!(r"{drive}:\Program Files\Oculus\Software\Software\another-axiom-gorilla-tag")));
        candidates.push(PathBuf::from(format!(r"{drive}:\Oculus Apps\Software\another-axiom-gorilla-tag")));
    }
    for c in candidates {
        if c.join("Gorilla Tag.exe").is_file() {
            let s = if cfg!(windows) { c.display().to_string() } else { std::fs::canonicalize(&c).unwrap_or(c).display().to_string() };
            if !found.iter().any(|f| f.eq_ignore_ascii_case(&s)) {
                found.push(s);
            }
        }
    }
    found
}

#[tauri::command]
pub fn plugins_set_folder(state: State<'_, Plugins>, path: String) -> Result<FolderInfo, CmdError> {
    let game = game_from(Path::new(path.trim()));
    if !game.is_dir() || !looks_like_game(&game) {
        return Err(CmdError::new("app", "that doesn't look like a Gorilla Tag folder. pick the folder that has \"Gorilla Tag.exe\" in it."));
    }
    *state.game.lock().unwrap() = Some(game.clone());
    Ok(info(&game))
}

#[tauri::command]
pub async fn plugins_pick_folder(app: AppHandle, state: State<'_, Plugins>) -> Result<Option<FolderInfo>, CmdError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Choose your Gorilla Tag folder").pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| CmdError::new("app", "the folder picker closed unexpectedly"))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|_| CmdError::new("app", "that folder can't be used"))?;
    plugins_set_folder(state, path.display().to_string()).map(Some)
}

fn walk(dir: &Path, base: &Path, depth: usize, out: &mut Vec<PluginFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 4 {
                walk(&path, base, depth + 1, out);
            }
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_ascii_lowercase();
        let enabled = lower.ends_with(".dll");
        if !enabled && !lower.ends_with(".dll.disabled") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let rel = path.strip_prefix(base).unwrap_or(&path);
        let folder = rel.components().next().filter(|_| rel.components().count() > 1).map(|c| c.as_os_str().to_string_lossy().to_string());
        let sha256 = std::fs::read(&path).map(|bytes| hex::encode(Sha256::digest(&bytes))).unwrap_or_default();
        let clean = file_name.strip_suffix(DISABLED).unwrap_or(&file_name);
        out.push(PluginFile {
            id: rel.to_string_lossy().to_string(),
            name: clean.strip_suffix(".dll").or_else(|| clean.strip_suffix(".DLL")).unwrap_or(clean).to_string(),
            file_name: clean.to_string(),
            folder,
            size: meta.len(),
            modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
            enabled,
            sha256,
        });
    }
}

#[tauri::command]
pub async fn plugins_list(state: State<'_, Plugins>) -> Result<Vec<PluginFile>, CmdError> {
    let dir = plugins_dir(&state)?;
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        if dir.is_dir() {
            walk(&dir, &dir, 0, &mut out);
        }
        out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
        out
    })
    .await
    .map_err(|_| CmdError::new("app", "couldn't read your plugins folder"))
}

fn rename_error(e: std::io::Error) -> CmdError {
    if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) {
        CmdError::new("disk", "the file is in use. close Gorilla Tag and try again.")
    } else {
        CmdError::new("disk", format!("couldn't change the file ({e})."))
    }
}

#[tauri::command]
pub fn plugins_set_enabled(state: State<'_, Plugins>, id: String, enabled: bool) -> Result<String, CmdError> {
    let path = resolve(&state, &id)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let is_disabled = name.to_ascii_lowercase().ends_with(DISABLED);
    if enabled != is_disabled {
        return Ok(id);
    }
    let target = if enabled { path.with_file_name(&name[..name.len() - DISABLED.len()]) } else { path.with_file_name(format!("{name}{DISABLED}")) };
    if target.exists() {
        return Err(CmdError::new("disk", "there's already a file with that name in the folder."));
    }
    std::fs::rename(&path, &target).map_err(rename_error)?;
    let base = plugins_dir(&state)?;
    Ok(target.strip_prefix(&base).unwrap_or(&target).to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugins_remove(state: State<'_, Plugins>, id: String) -> Result<String, CmdError> {
    let path = resolve(&state, &id)?;
    let game = state.game.lock().unwrap().clone().ok_or_else(|| CmdError::new("app", "pick your Gorilla Tag folder first"))?;
    let backup = game.join("BepInEx").join("branch-removed");
    std::fs::create_dir_all(&backup).map_err(|e| CmdError::new("disk", format!("couldn't make the backup folder ({e}).")))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "mod.dll".into());
    let mut target = backup.join(&name);
    let mut n = 1;
    while target.exists() {
        target = backup.join(format!("{n}-{name}"));
        n += 1;
    }
    std::fs::rename(&path, &target).map_err(rename_error)?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn plugins_read(state: State<'_, Plugins>, id: String) -> Result<tauri::ipc::Response, CmdError> {
    let path = resolve(&state, &id)?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_READ {
        return Err(CmdError::new("app", "that file is bigger than 50 MB, so it can't be checked."));
    }
    let bytes = std::fs::read(&path).map_err(|e| CmdError::new("disk", format!("couldn't read the file ({e}).")))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn plugins_open(app: AppHandle, state: State<'_, Plugins>, which: String, id: Option<String>) -> Result<(), CmdError> {
    let game = state.game.lock().unwrap().clone().ok_or_else(|| CmdError::new("app", "pick your Gorilla Tag folder first"))?;
    let opener = app.opener();
    let result = match which.as_str() {
        "file" => opener.reveal_item_in_dir(resolve(&state, id.as_deref().unwrap_or(""))?),
        "config" => opener.open_path(game.join("BepInEx").join("config").display().to_string(), None::<&str>),
        "game" => opener.open_path(game.display().to_string(), None::<&str>),
        "removed" => opener.open_path(game.join("BepInEx").join("branch-removed").display().to_string(), None::<&str>),
        _ => {
            let dir = game.join("BepInEx").join("plugins");
            let _ = std::fs::create_dir_all(&dir);
            opener.open_path(dir.display().to_string(), None::<&str>)
        }
    };
    result.map_err(|_| CmdError::new("app", "couldn't open that folder"))
}

pub fn install_target(state: &Plugins, file_name: &str) -> Result<PathBuf, CmdError> {
    let dir = plugins_dir(state)?;
    if !dir.parent().is_some_and(Path::is_dir) {
        return Err(CmdError::new("app", "BepInEx isn't installed in your Gorilla Tag folder yet. install BepInEx first."));
    }
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new("disk", format!("couldn't make the plugins folder ({e}).")))?;
    if !file_name.to_ascii_lowercase().ends_with(".dll") {
        return Err(CmdError::new("app", "only .dll mods can be installed automatically. download the .zip and follow its install steps."));
    }
    Ok(dir.join(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugins_or_bepinex_folders_lead_back_to_the_game() {
        let game = Path::new("Games").join("Gorilla Tag");
        assert_eq!(game_from(&game.join("BepInEx").join("plugins")), game);
        assert_eq!(game_from(&game.join("BepInEx")), game);
        assert_eq!(game_from(&game), game);
    }

    #[test]
    fn paths_outside_plugins_are_refused() {
        let state = Plugins::default();
        *state.game.lock().unwrap() = Some(std::env::temp_dir());
        assert!(resolve(&state, r"..\evil.dll").is_err());
        assert!(resolve(&state, r"C:\Windows\evil.dll").is_err());
        assert!(resolve(&state, "").is_err());
    }
}
