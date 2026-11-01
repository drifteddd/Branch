use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Clone, Serialize)]
pub struct Asset {
    pub name: String,
    pub size: Option<i64>,
    pub url: String,
}

#[derive(Clone, Serialize)]
pub struct Release {
    pub tag: String,
    pub version: String,
    pub title: String,
    pub notes: String,
    pub published_at: String,
    pub url: String,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
}

#[derive(Clone, Serialize)]
pub struct RepoInfo {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub description: String,
    pub stars: Option<i64>,
    pub url: String,
}

fn valid_owner(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn valid_repo(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn parse_repo(input: &str) -> Option<(String, String)> {
    let s = input.trim();
    let s = s.split(['?', '#']).next().unwrap_or("");
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(s);
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let path = if let Some(r) = rest.strip_prefix("github.com/") {
        r
    } else if let Some(r) = rest.strip_prefix("raw.githubusercontent.com/") {
        r
    } else {
        let first = rest.split('/').next().unwrap_or("");
        if first.contains('.') || first.contains(':') || s.contains("://") {
            return None;
        }
        rest
    };
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches(".git").to_string();
    (valid_owner(&owner) && valid_repo(&repo)).then_some((owner, repo))
}

pub fn repo_key(owner: &str, repo: &str) -> String {
    format!("{}/{}", owner.to_ascii_lowercase(), repo.to_ascii_lowercase())
}

pub fn normalize_version(v: &str) -> String {
    v.trim().trim_start_matches(['v', 'V']).to_ascii_lowercase()
}

type Cache<T> = Mutex<Option<HashMap<String, (Instant, Option<T>)>>>;
static RELEASES: Cache<Release> = Mutex::new(None);
static REPOS: Cache<RepoInfo> = Mutex::new(None);
static API_LIMITED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
const CACHE_FOR: Duration = Duration::from_secs(600);

fn cached<T: Clone>(cache: &Cache<T>, key: &str) -> Option<Option<T>> {
    let guard = cache.lock().ok()?;
    let (at, value) = guard.as_ref()?.get(key)?;
    (at.elapsed() < CACHE_FOR).then(|| value.clone())
}

fn remember<T: Clone>(cache: &Cache<T>, key: &str, value: &Option<T>) {
    if let Ok(mut guard) = cache.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if map.len() > 2000 {
            map.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
        }
        map.insert(key.to_string(), (Instant::now(), value.clone()));
    }
}

fn api_usable() -> bool {
    API_LIMITED_UNTIL.lock().map(|g| g.is_none_or(|t| Instant::now() >= t)).unwrap_or(true)
}

fn mark_api_limited() {
    if let Ok(mut g) = API_LIMITED_UNTIL.lock() {
        *g = Some(Instant::now() + Duration::from_secs(15 * 60));
    }
}

enum ApiAnswer {
    Found(Value),
    Missing,
    Unavailable,
}

async fn api_get(state: &AppState, path: &str) -> ApiAnswer {
    if state.config.github_token.is_none() && !api_usable() {
        return ApiAnswer::Unavailable;
    }
    let mut request = state
        .http
        .get(format!("https://api.github.com{path}"))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(12));
    if let Some(token) = &state.config.github_token {
        request = request.bearer_auth(token);
    }
    let Ok(response) = request.send().await else { return ApiAnswer::Unavailable };
    match response.status().as_u16() {
        200 => response.json().await.map(ApiAnswer::Found).unwrap_or(ApiAnswer::Unavailable),
        404 => ApiAnswer::Missing,
        403 | 429 => {
            mark_api_limited();
            ApiAnswer::Unavailable
        }
        _ => ApiAnswer::Unavailable,
    }
}

async fn page(state: &AppState, url: &str) -> Result<Option<String>, String> {
    let response = state
        .http
        .get(url)
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| "couldn't reach github".to_string())?;
    match response.status().as_u16() {
        200 => response.text().await.map(Some).map_err(|_| "github sent a broken page".to_string()),
        404 | 301 | 302 => Ok(None),
        429 => Err("github is busy right now. try again in a few minutes.".into()),
        code => Err(format!("github answered with an error ({code})")),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn parse_assets(html: &str, owner: &str, repo: &str) -> Vec<Asset> {
    let prefix = format!("/{owner}/{repo}/releases/download/").to_ascii_lowercase();
    let mut out: Vec<Asset> = Vec::new();
    for part in html.split("href=\"").skip(1) {
        let Some(end) = part.find('"') else { continue };
        let href = &part[..end];
        if !href.to_ascii_lowercase().starts_with(&prefix) {
            continue;
        }
        let url = format!("https://github.com{href}");
        if out.iter().any(|a| a.url == url) {
            continue;
        }
        out.push(Asset { name: percent_decode(href.rsplit('/').next().unwrap_or("")), size: None, url });
    }
    out
}

fn release_from_api(r: &Value) -> Option<Release> {
    let tag = r.get("tag_name")?.as_str()?.to_string();
    let assets = r
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(Asset {
                        name: a.get("name")?.as_str()?.to_string(),
                        size: a.get("size").and_then(|s| s.as_i64()),
                        url: a.get("browser_download_url")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Release {
        version: tag.trim_start_matches(['v', 'V']).to_string(),
        title: r.get("name").and_then(|n| n.as_str()).filter(|n| !n.trim().is_empty()).unwrap_or(&tag).to_string(),
        notes: r.get("body").and_then(|b| b.as_str()).unwrap_or("").chars().take(6000).collect(),
        published_at: r.get("published_at").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        url: r.get("html_url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
        prerelease: r.get("prerelease").and_then(|p| p.as_bool()).unwrap_or(false),
        tag,
        assets,
    })
}

pub async fn latest_release(state: &AppState, owner: &str, repo: &str) -> Result<Option<Release>, String> {
    let key = repo_key(owner, repo);
    if let Some(hit) = cached(&RELEASES, &key) {
        return Ok(hit);
    }
    let found = match api_get(state, &format!("/repos/{owner}/{repo}/releases?per_page=8")).await {
        ApiAnswer::Found(list) => list
            .as_array()
            .and_then(|items| {
                let usable: Vec<&Value> = items.iter().filter(|r| r.get("draft").and_then(|d| d.as_bool()) != Some(true)).collect();
                usable
                    .iter()
                    .find(|r| r.get("prerelease").and_then(|p| p.as_bool()) != Some(true))
                    .or(usable.first())
                    .and_then(|r| release_from_api(r))
            }),
        ApiAnswer::Missing => None,
        ApiAnswer::Unavailable => {
            let Some(feed) = page(state, &format!("https://github.com/{owner}/{repo}/releases.atom")).await? else {
                remember(&RELEASES, &key, &None);
                return Ok(None);
            };
            match crate::routes::inbox::parse_feed(&feed).into_iter().next() {
                None => None,
                Some(entry) => {
                    let url = entry["url"].as_str().unwrap_or("").to_string();
                    let tag = percent_decode(url.rsplit('/').next().unwrap_or(""));
                    let assets = match page(state, &format!("https://github.com/{owner}/{repo}/releases/expanded_assets/{}", url.rsplit('/').next().unwrap_or(""))).await {
                        Ok(Some(html)) => parse_assets(&html, owner, repo),
                        _ => Vec::new(),
                    };
                    Some(Release {
                        version: tag.trim_start_matches(['v', 'V']).to_string(),
                        title: entry["title"].as_str().unwrap_or(&tag).to_string(),
                        notes: entry["notes"].as_str().unwrap_or("").chars().take(6000).collect(),
                        published_at: entry["published_at"].as_str().unwrap_or("").to_string(),
                        url,
                        prerelease: false,
                        tag,
                        assets,
                    })
                }
            }
        }
    };
    remember(&RELEASES, &key, &found);
    Ok(found)
}

fn meta_content(html: &str, attr: &str) -> Option<String> {
    let start = html.find(attr)?;
    let tag_start = html[..start].rfind('<')?;
    let tag_end = start + html[start..].find('>')?;
    let tag = &html[tag_start..tag_end];
    let c = tag.find("content=\"")? + 9;
    let end = tag[c..].find('"')? + c;
    Some(tag[c..end].replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">"))
}

pub async fn repo_info(state: &AppState, owner: &str, repo: &str) -> Result<Option<RepoInfo>, String> {
    let key = repo_key(owner, repo);
    if let Some(hit) = cached(&REPOS, &key) {
        return Ok(hit);
    }
    let found = match api_get(state, &format!("/repos/{owner}/{repo}")).await {
        ApiAnswer::Found(r) => {
            let full = r.get("full_name").and_then(|f| f.as_str()).unwrap_or("").to_string();
            let (o, n) = full.split_once('/').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((owner.to_string(), repo.to_string()));
            Some(RepoInfo {
                description: r.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                stars: r.get("stargazers_count").and_then(|s| s.as_i64()),
                url: format!("https://github.com/{o}/{n}"),
                full_name: format!("{o}/{n}"),
                owner: o,
                name: n,
            })
        }
        ApiAnswer::Missing => None,
        ApiAnswer::Unavailable => match page(state, &format!("https://github.com/{owner}/{repo}")).await? {
            None => None,
            Some(html) => {
                let description = meta_content(&html, "name=\"description\"")
                    .map(|d| {
                        let d = d.split(" Contribute to ").next().unwrap_or(&d).trim().to_string();
                        let d = d.trim_end_matches(&format!(" - {owner}/{repo}")).to_string();
                        if d.starts_with("Contribute to ") { String::new() } else { d }
                    })
                    .unwrap_or_default();
                Some(RepoInfo { owner: owner.to_string(), name: repo.to_string(), full_name: format!("{owner}/{repo}"), description, stars: None, url: format!("https://github.com/{owner}/{repo}") })
            }
        },
    };
    remember(&REPOS, &key, &found);
    Ok(found)
}

pub fn pick_asset(assets: &[Asset]) -> Option<&Asset> {
    let usable = |a: &&Asset| {
        let lower = a.name.to_ascii_lowercase();
        !lower.contains("source") && a.size.is_none_or(|s| s as usize <= crate::uploads::MAX_MOD_FILE_BYTES)
    };
    assets
        .iter()
        .filter(usable)
        .find(|a| a.name.to_ascii_lowercase().ends_with(".dll"))
        .or_else(|| assets.iter().filter(usable).find(|a| a.name.to_ascii_lowercase().ends_with(".zip")))
}

pub async fn download_asset(owner: &str, repo: &str, url: &str) -> Result<Vec<u8>, String> {
    let prefix = format!("https://github.com/{owner}/{repo}/releases/download/").to_ascii_lowercase();
    if !url.to_ascii_lowercase().starts_with(&prefix) {
        return Err("that file isn't from this repo's releases".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("branch-server")
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or("").to_string();
            if attempt.previous().len() > 5 {
                attempt.error("too many redirects")
            } else if attempt.url().scheme() == "https" && (host == "github.com" || host.ends_with(".githubusercontent.com")) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(url).timeout(Duration::from_secs(120)).send().await.map_err(|_| "couldn't download the file from github".to_string())?;
    if !response.status().is_success() {
        return Err(format!("github answered with an error ({})", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|l| l as usize > crate::uploads::MAX_MOD_FILE_BYTES) {
        return Err("the file is bigger than 50 MB".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "the download from github stopped".to_string())? {
        data.extend_from_slice(&chunk);
        if data.len() > crate::uploads::MAX_MOD_FILE_BYTES {
            return Err("the file is bigger than 50 MB".into());
        }
    }
    Ok(data)
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        let mut tick = tokio::time::interval(Duration::from_secs(30 * 60));
        loop {
            tick.tick().await;
            if let Err(err) = sync_all(&state).await {
                tracing::warn!(error = %err.message, "github sync failed");
            }
        }
    });
}

#[derive(FromRow)]
struct SyncRow {
    id: Uuid,
    name: String,
    source_url: Option<String>,
    project_url: Option<String>,
    github_tag: Option<String>,
    redistribution: String,
    uploader_poster: Option<Uuid>,
    latest_version: Option<String>,
    latest_created: Option<DateTime<Utc>>,
    latest_sha: Option<String>,
}

pub fn repo_of(source_url: Option<&str>, project_url: Option<&str>) -> Option<(String, String)> {
    source_url
        .filter(|u| u.contains("github.com/"))
        .and_then(parse_repo)
        .or_else(|| project_url.filter(|u| u.contains("github.com/")).and_then(parse_repo))
}

pub async fn sync_all(state: &AppState) -> ApiResult<()> {
    let rows: Vec<SyncRow> = sqlx::query_as(
        "select m.id, m.name, m.source_url, m.project_url, m.github_tag, m.redistribution, m.uploader_poster,
                lr.version as latest_version, lr.created_at as latest_created, lr.file_sha256 as latest_sha
         from mods m
         left join lateral (
             select version, created_at, file_sha256 from releases r where r.mod_id = m.id order by released_on desc, created_at desc limit 1
         ) lr on true
         where m.status = 'published' and m.github_sync
           and (m.source_url ilike '%github.com/%' or m.project_url ilike '%github.com/%')
         order by m.github_checked_at asc nulls first limit 150",
    )
    .fetch_all(&state.db)
    .await?;
    for row in rows {
        if let Err(err) = sync_one(state, &row).await {
            tracing::warn!(error = %err, mod_id = %row.id, "couldn't check a mod's github releases");
        }
        sqlx::query("update mods set github_checked_at = now() where id = $1").bind(row.id).execute(&state.db).await?;
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Ok(())
}

async fn set_tag(state: &AppState, id: Uuid, tag: &str) -> ApiResult<()> {
    sqlx::query("update mods set github_tag = $1 where id = $2").bind(tag).bind(id).execute(&state.db).await?;
    Ok(())
}

pub async fn notify(state: &AppState, poster: Option<Uuid>, mod_id: Uuid, title: &str, body: &str) {
    let Some(poster) = poster else { return };
    let result = sqlx::query("insert into creator_notices (id, poster_id, mod_id, title, body) values ($1, $2, $3, $4, $5)")
        .bind(Uuid::new_v4())
        .bind(poster)
        .bind(mod_id)
        .bind(title)
        .bind(body)
        .execute(&state.db)
        .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "couldn't save a creator notice");
    }
}

async fn sync_one(state: &AppState, row: &SyncRow) -> Result<(), String> {
    let Some((owner, repo)) = repo_of(row.source_url.as_deref(), row.project_url.as_deref()) else { return Ok(()) };
    let Some(release) = latest_release(state, &owner, &repo).await? else { return Ok(()) };
    if release.prerelease || row.github_tag.as_deref() == Some(release.tag.as_str()) {
        return Ok(());
    }
    let same_version = row.latest_version.as_deref().map(normalize_version) == Some(normalize_version(&release.version));
    let published = DateTime::parse_from_rfc3339(&release.published_at).ok().map(|d| d.with_timezone(&Utc));
    let older = row.github_tag.is_none() && matches!((published, row.latest_created), (Some(p), Some(c)) if p <= c);
    if same_version || older {
        return set_tag(state, row.id, &release.tag).await.map_err(|e| e.message);
    }

    let hosted = row.redistribution == "allowed";
    let changelog: String = release.notes.chars().take(4000).collect();
    let version: String = if release.version.is_empty() { release.tag.clone() } else { release.version.clone() }.chars().take(40).collect();
    if hosted {
        let Some(asset) = pick_asset(&release.assets) else {
            return set_tag(state, row.id, &release.tag).await.map_err(|e| e.message);
        };
        let data = download_asset(&owner, &repo, &asset.url).await?;
        let name = asset.name.clone();
        let (checked, report, data) = tokio::task::spawn_blocking(move || {
            let checked = crate::uploads::check_mod_file(&name, &data)?;
            let report = crate::scan::scan(&name, &data)?;
            Ok::<_, String>((checked, report, data))
        })
        .await
        .map_err(|e| e.to_string())??;
        if row.latest_sha.as_deref() == Some(checked.sha256.as_str()) {
            return set_tag(state, row.id, &release.tag).await.map_err(|e| e.message);
        }
        let score = report.basic_score();
        if score >= 85 && report.has_strong_signals() {
            tracing::warn!(score, mod_id = %row.id, "github update refused by the safety check");
            set_tag(state, row.id, &release.tag).await.map_err(|e| e.message)?;
            notify(state, row.uploader_poster, row.id, &format!("{} {} wasn't added", row.name, version), "Branch's safety check flagged the new file from github, so it wasn't added. if you think this is a mistake, email drifted1000@outlook.com.").await;
            return Ok(());
        }
        let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
        crate::storage::put(state.store.as_ref(), &key, data).await.map_err(|e| e.to_string())?;
        let saved = sqlx::query(
            "insert into releases (id, mod_id, version, released_on, changelog, download_kind, file_key, file_name, file_size, file_sha256, file_type, from_github)
             values ($1, $2, $3, current_date, $4, 'hosted', $5, $6, $7, $8, $9, true)",
        )
        .bind(Uuid::new_v4())
        .bind(row.id)
        .bind(&version)
        .bind(&changelog)
        .bind(&key)
        .bind(&checked.name)
        .bind(checked.size)
        .bind(&checked.sha256)
        .bind(checked.kind)
        .execute(&state.db)
        .await;
        if let Err(err) = saved {
            crate::storage::delete_quietly(state.store.as_ref(), &key).await;
            return Err(err.to_string());
        }
        sqlx::query("update mods set github_tag = $1, updated_at = now(), code_fingerprint = $2 where id = $3")
            .bind(&release.tag)
            .bind(report.fingerprint())
            .bind(row.id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        sqlx::query(
            "insert into releases (id, mod_id, version, released_on, changelog, download_kind, external_url, from_github)
             values ($1, $2, $3, current_date, $4, 'external', $5, true)",
        )
        .bind(Uuid::new_v4())
        .bind(row.id)
        .bind(&version)
        .bind(&changelog)
        .bind(&release.url)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("update mods set github_tag = $1, updated_at = now() where id = $2").bind(&release.tag).bind(row.id).execute(&state.db).await.map_err(|e| e.to_string())?;
    }
    tracing::info!(mod_id = %row.id, version, "added a new version from github");
    notify(state, row.uploader_poster, row.id, &format!("{} was updated to {}", row.name, version), "Branch saw a new release on github and added it to your mod automatically.").await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_github_links() {
        assert_eq!(parse_repo("https://github.com/Owner/My-Mod"), Some(("Owner".into(), "My-Mod".into())));
        assert_eq!(parse_repo("github.com/owner/mod.git"), Some(("owner".into(), "mod".into())));
        assert_eq!(parse_repo("https://github.com/owner/mod/releases/tag/v1.2?x=1"), Some(("owner".into(), "mod".into())));
        assert_eq!(parse_repo("owner/mod"), Some(("owner".into(), "mod".into())));
        assert_eq!(parse_repo("https://gitlab.com/owner/mod"), None);
        assert_eq!(parse_repo("https://github.com/owner"), None);
        assert_eq!(parse_repo("https://github.com/bad owner/mod"), None);
    }

    #[test]
    fn finds_release_files() {
        let html = r#"<a href="/o/r/releases/download/v1.0/My%20Mod.dll">x</a><a href="/o/r/archive/refs/tags/v1.0.zip">src</a><a href="/o/r/releases/download/v1.0/Pack.zip">y</a>"#;
        let assets = parse_assets(html, "o", "r");
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].name, "My Mod.dll");
        assert_eq!(pick_asset(&assets).unwrap().name, "My Mod.dll");
        assert_eq!(normalize_version("V1.2.0"), "1.2.0");
    }
}
