use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::io::AsyncWriteExt;

fn base_url() -> &'static str {
    match option_env!("BRANCH_API_URL") {
        Some(url) if !url.trim().is_empty() => url.trim().trim_end_matches('/'),
        _ => "http://localhost:8080",
    }
}

#[derive(Debug, Serialize)]
struct CmdError {
    kind: &'static str,
    status: Option<u16>,
    message: String,
    fields: Option<serde_json::Value>,
}

impl CmdError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, status: None, message: message.into(), fields: None }
    }
}

impl From<reqwest::Error> for CmdError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            CmdError::new("network", "the Branch server took too long to answer. try again.")
        } else {
            CmdError::new("network", "couldn't reach the Branch server. check your internet connection.")
        }
    }
}

struct Http {
    api: reqwest::Client,
    files: reqwest::Client,
}

#[derive(Default)]
struct Downloads {
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    saved: Mutex<HashSet<PathBuf>>,
    last_dir: Mutex<Option<PathBuf>>,
}

struct Material(&'static str);

#[tauri::command]
fn api_base() -> &'static str {
    base_url()
}

#[tauri::command]
fn window_material(material: State<'_, Material>) -> &'static str {
    material.0
}

fn api_url(path: &str) -> Result<String, CmdError> {
    let bad = !path.starts_with("/api/")
        || path.contains("..")
        || path.contains('#')
        || path.chars().any(|c| c.is_whitespace() || c.is_control());
    if bad {
        return Err(CmdError::new("app", "bad request path"));
    }
    Ok(format!("{}{}", base_url(), path))
}

#[tauri::command]
async fn api_request(
    http: State<'_, Http>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, CmdError> {
    let url = api_url(&path)?;
    let request = match method.as_str() {
        "GET" => http.api.get(&url),
        "POST" => http.api.post(&url).json(&body.unwrap_or(serde_json::Value::Null)),
        "PUT" => http.api.put(&url).json(&body.unwrap_or(serde_json::Value::Null)),
        _ => return Err(CmdError::new("app", "unsupported request")),
    };
    read_json(request.send().await?).await
}

async fn read_json(response: reqwest::Response) -> Result<serde_json::Value, CmdError> {
    let status = response.status();
    let data: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        return Ok(data);
    }
    let message = data
        .get("error")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("the server answered with an error ({})", status.as_u16()));
    Err(CmdError { kind: "http", status: Some(status.as_u16()), message, fields: data.get("fields").cloned() })
}

#[tauri::command]
async fn github_api(http: State<'_, Http>, path: String) -> Result<serde_json::Value, CmdError> {
    let bad = !path.starts_with("/repos/")
        || path.contains("..")
        || path.contains('#')
        || path.contains('@')
        || path.chars().any(|c| c.is_whitespace() || c.is_control());
    if bad {
        return Err(CmdError::new("app", "bad github path"));
    }
    let response = http
        .api
        .get(format!("https://api.github.com{path}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    match response.status().as_u16() {
        403 | 429 => Err(CmdError::new("http", "github's free limit (60 requests an hour) was hit. try again a bit later.")),
        404 => Err(CmdError::new("http", "github couldn't find that repo or file. it might be private or deleted.")),
        _ => read_json(response).await,
    }
}

const MAX_UPLOAD_BYTES: usize = 60 * 1024 * 1024;

#[tauri::command]
async fn api_upload(request: tauri::ipc::Request<'_>, http: State<'_, Http>) -> Result<serde_json::Value, CmdError> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let path = header("x-branch-path").unwrap_or_default();
    if path != "/api/check" && path != "/api/submissions" {
        return Err(CmdError::new("app", "bad upload path"));
    }
    let content_type = header("x-branch-content-type").filter(|t| t.starts_with("multipart/form-data; boundary="));
    let Some(content_type) = content_type else {
        return Err(CmdError::new("app", "bad upload"));
    };
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(CmdError::new("app", "no file was attached"));
    };
    if body.is_empty() {
        return Err(CmdError::new("app", "no file was attached"));
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(CmdError::new("app", "files can be up to 50 MB"));
    }
    let response = http
        .files
        .post(format!("{}{}", base_url(), path))
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(body.clone())
        .timeout(Duration::from_secs(180))
        .send()
        .await?;
    read_json(response).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadArgs {
    id: String,
    release_id: String,
    file_name: String,
    sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum DownloadResult {
    Saved { path: String },
    Cancelled,
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    received: u64,
    total: Option<u64>,
}

fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == ' ').to_string();
    if cleaned.is_empty() { "mod-download".to_string() } else { cleaned }
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

#[tauri::command]
async fn download_release(
    app: AppHandle,
    http: State<'_, Http>,
    downloads: State<'_, Downloads>,
    args: DownloadArgs,
) -> Result<DownloadResult, CmdError> {
    let id_ok = !args.release_id.is_empty()
        && args.release_id.len() <= 64
        && args.release_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !id_ok {
        return Err(CmdError::new("app", "bad release id"));
    }
    let file_name = safe_file_name(&args.file_name);

    let start_dir = downloads.last_dir.lock().unwrap().clone().or_else(|| app.path().download_dir().ok());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Save mod file").set_file_name(file_name);
    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| CmdError::new("app", "the save dialog closed unexpectedly"))?;
    let Some(picked) = picked else {
        return Ok(DownloadResult::Cancelled);
    };
    let dest = picked.into_path().map_err(|_| CmdError::new("app", "that save location can't be used"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    downloads.cancel_flags.lock().unwrap().insert(args.id.clone(), cancel.clone());
    let result = stream_to_file(&app, &http.files, &args, &dest, &cancel).await;
    downloads.cancel_flags.lock().unwrap().remove(&args.id);

    match result {
        Ok(true) => {
            if let Some(parent) = dest.parent() {
                *downloads.last_dir.lock().unwrap() = Some(parent.to_path_buf());
            }
            downloads.saved.lock().unwrap().insert(dest.clone());
            Ok(DownloadResult::Saved { path: dest.display().to_string() })
        }
        Ok(false) => Ok(DownloadResult::Cancelled),
        Err(err) => Err(err),
    }
}

async fn stream_to_file(
    app: &AppHandle,
    client: &reqwest::Client,
    args: &DownloadArgs,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<bool, CmdError> {
    let url = format!("{}/api/releases/{}/download", base_url(), args.release_id);
    let response = client.get(&url).send().await?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let data: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
        let message = data
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("the server couldn't send this file")
            .to_string();
        return Err(CmdError { kind: "http", status: Some(status), message, fields: None });
    }

    let total = response.content_length();
    let partial = partial_path(dest);
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| CmdError::new("disk", format!("couldn't save the file there ({e}). try another folder.")))?;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit: Option<Instant> = None;
    let mut quiet_ticks = 0u32;
    let mut stream = response.bytes_stream();

    let outcome: Result<bool, CmdError> = loop {
        if cancel.load(Ordering::Relaxed) {
            break Ok(false);
        }
        let next = match tokio::time::timeout(Duration::from_millis(250), stream.next()).await {
            Ok(next) => next,
            Err(_) => {
                quiet_ticks += 1;
                if quiet_ticks > 120 {
                    break Err(CmdError::new("network", "the download stalled for 30 seconds. try again."));
                }
                continue;
            }
        };
        quiet_ticks = 0;
        let Some(chunk) = next else {
            break Ok(true);
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => break Err(CmdError::new("network", "the download stopped. check your connection and try again.")),
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk).await {
            break Err(CmdError::new("disk", format!("couldn't write the file ({e}). check that the drive has space.")));
        }
        received += chunk.len() as u64;
        if last_emit.map_or(true, |t| t.elapsed() >= Duration::from_millis(100)) {
            let _ = app.emit("download-progress", Progress { id: &args.id, received, total });
            last_emit = Some(Instant::now());
        }
    };

    let flushed = file.flush().await;
    drop(file);

    let finished = match outcome {
        Ok(true) => flushed.map(|_| true).map_err(|e| CmdError::new("disk", format!("couldn't finish writing the file ({e})."))),
        other => other.map(|_| false),
    };

    if !matches!(finished, Ok(true)) {
        let _ = tokio::fs::remove_file(&partial).await;
        return finished;
    }

    let _ = app.emit("download-progress", Progress { id: &args.id, received, total: Some(received) });

    if let Some(expected) = args.sha256.as_deref().filter(|s| !s.is_empty()) {
        let actual = hex::encode(hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(CmdError::new(
                "checksum",
                "the file didn't match its checksum, so it was deleted. try again, and report the mod if it keeps happening.",
            ));
        }
    }

    tokio::fs::rename(&partial, dest)
        .await
        .map_err(|e| CmdError::new("disk", format!("couldn't save the file there ({e}).")))?;
    Ok(true)
}

#[tauri::command]
fn cancel_download(downloads: State<'_, Downloads>, id: String) {
    if let Some(flag) = downloads.cancel_flags.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
fn reveal_download(app: AppHandle, downloads: State<'_, Downloads>, path: String) -> Result<(), CmdError> {
    let path = PathBuf::from(path);
    if !downloads.saved.lock().unwrap().contains(&path) {
        return Err(CmdError::new("app", "that file wasn't downloaded by Branch"));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|_| CmdError::new("app", "couldn't open the folder"))
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), CmdError> {
    let parsed = url::Url::parse(&url).map_err(|_| CmdError::new("app", "that link isn't valid"))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(CmdError::new("app", "only web links can be opened"));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| CmdError::new("app", "couldn't open your browser"))
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    received: u64,
    total: Option<u64>,
}

fn update_error(message: impl Into<String>) -> CmdError {
    CmdError::new("update", message)
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, CmdError> {
    let updater = app.updater().map_err(|e| update_error(format!("updates aren't available: {e}")))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            current: update.current_version.clone(),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(update_error(format!("couldn't check for updates: {e}"))),
    }
}

#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), CmdError> {
    let updater = app.updater().map_err(|e| update_error(format!("updates aren't available: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| update_error(format!("couldn't check for updates: {e}")))?
        .ok_or_else(|| update_error("you're already on the newest version"))?;
    let handle = app.clone();
    let mut received: u64 = 0;
    let mut last_emit: Option<Instant> = None;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                if last_emit.map_or(true, |t| t.elapsed() >= Duration::from_millis(100)) {
                    let _ = handle.emit("update-progress", UpdateProgress { received, total });
                    last_emit = Some(Instant::now());
                }
            },
            || {},
        )
        .await
        .map_err(|e| update_error(format!("the update couldn't be installed: {e}")))?;
    app.restart();
}

#[cfg(windows)]
fn apply_window_material(app: &tauri::App) -> &'static str {
    match app.get_webview_window("main") {
        Some(window) if window_vibrancy::apply_mica(&window, None).is_ok() => "mica",
        _ => "none",
    }
}

#[cfg(not(windows))]
fn apply_window_material(_app: &tauri::App) -> &'static str {
    "none"
}

pub fn run() {
    let user_agent = concat!("Branch/", env!("CARGO_PKG_VERSION"));
    let api = reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("couldn't set up the http client");
    let files = reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("couldn't set up the http client");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Http { api, files })
        .manage(Downloads::default())
        .setup(|app| {
            let material = apply_window_material(app);
            app.manage(Material(material));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_base,
            window_material,
            api_request,
            api_upload,
            github_api,
            download_release,
            cancel_download,
            reveal_download,
            open_external,
            update_check,
            update_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running branch");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_cleaned() {
        assert_eq!(safe_file_name("..\\..\\evil.dll"), "evil.dll");
        assert_eq!(safe_file_name("my mod?.zip"), "my mod-.zip");
        assert_eq!(safe_file_name("..."), "mod-download");
    }

    #[test]
    fn only_api_paths_are_allowed() {
        assert!(api_url("/api/mods?q=x").is_ok());
        assert!(api_url("/admin").is_err());
        assert!(api_url("/api/../admin").is_err());
        assert!(api_url("https://evil.example/api/").is_err());
    }
}
