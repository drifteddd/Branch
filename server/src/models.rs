// database rows and the json shapes the app and admin panel receive.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

/// (key, label, what it actually means). shown in the app so a badge is never a guess.
pub const COMPATIBILITY: &[(&str, &str, &str)] = &[
    ("tested", "Tested", "the Branch admin tried this version on the game version listed and it worked at that time."),
    ("unconfirmed", "Not confirmed", "nobody has checked this version with the current game update yet. it might work, or it might not."),
    ("outdated", "Outdated", "made for an older game update. it probably won't work on the current one."),
    ("broken", "Broken", "known not to work right now."),
];

pub const PLATFORMS: &[(&str, &str)] = &[
    ("steam", "Steam (PC VR)"),
    ("oculus_pc", "Meta / Oculus PC (PC VR)"),
    ("quest", "Quest standalone"),
];

pub const REPORT_REASONS: &[(&str, &str)] = &[
    ("broken_download", "Broken download"),
    ("outdated", "Outdated or incompatible"),
    ("misleading", "Misleading information"),
    ("harmful", "Suspicious or harmful file"),
    ("copyright", "Copyright or permission issue"),
    ("other", "Other"),
];

pub const MOD_STATUSES: &[&str] = &["draft", "published", "unpublished", "archived"];
pub const REDISTRIBUTION: &[&str] = &["allowed", "not_allowed", "unknown"];

pub fn file_url(key: &str) -> String {
    format!("/files/{key}")
}

#[derive(FromRow)]
pub struct ModRow {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub author_name: String,
    pub author_url: Option<String>,
    pub category_id: Option<Uuid>,
    pub category_slug: Option<String>,
    pub category_name: Option<String>,
    pub status: String,
    pub featured: bool,
    pub thumbnail_key: Option<String>,
    pub compatibility: String,
    pub compatibility_note: String,
    pub compatibility_checked_on: Option<NaiveDate>,
    pub game_versions: String,
    pub platforms: Vec<String>,
    pub mod_loader: String,
    pub dependencies: Value,
    pub install_instructions: String,
    pub known_issues: String,
    pub source_url: Option<String>,
    pub project_url: Option<String>,
    pub license_name: String,
    pub license_url: Option<String>,
    pub redistribution: String,
    pub redistribution_note: String,
    pub download_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
}

const MOD_SELECT: &str = "select m.id, m.slug, m.name, m.summary, m.description, m.author_name, m.author_url,
    m.category_id, c.slug as category_slug, c.name as category_name, m.status, m.featured, m.thumbnail_key,
    m.compatibility, m.compatibility_note, m.compatibility_checked_on, m.game_versions, m.platforms, m.mod_loader,
    m.dependencies, m.install_instructions, m.known_issues, m.source_url, m.project_url, m.license_name,
    m.license_url, m.redistribution, m.redistribution_note, m.download_count, m.created_at, m.updated_at, m.published_at
    from mods m left join categories c on c.id = m.category_id";

#[derive(FromRow, Clone)]
pub struct ReleaseRow {
    pub id: Uuid,
    pub mod_id: Uuid,
    pub version: String,
    pub released_on: NaiveDate,
    pub changelog: String,
    pub game_version: String,
    pub download_kind: String,
    pub external_url: Option<String>,
    pub file_key: Option<String>,
    pub file_name: Option<String>,
    pub file_size: Option<i64>,
    pub file_sha256: Option<String>,
    pub file_type: Option<String>,
    pub download_disabled: bool,
    pub disabled_reason: String,
    pub created_at: DateTime<Utc>,
}

pub const RELEASE_SELECT: &str = "select id, mod_id, version, released_on, changelog, game_version, download_kind,
    external_url, file_key, file_name, file_size, file_sha256, file_type, download_disabled, disabled_reason, created_at
    from releases";

impl ReleaseRow {
    pub fn available(&self) -> bool {
        !self.download_disabled
            && match self.download_kind.as_str() {
                "hosted" => self.file_key.is_some(),
                _ => self.external_url.is_some(),
            }
    }
}

#[derive(Serialize)]
pub struct FileOut {
    pub name: String,
    pub size: i64,
    pub sha256: String,
    #[serde(rename = "type")]
    pub file_type: String,
}

#[derive(Serialize)]
pub struct ReleaseOut {
    pub id: Uuid,
    pub version: String,
    pub released_on: NaiveDate,
    pub changelog: String,
    pub game_version: String,
    pub kind: String,
    pub external_url: Option<String>,
    pub external_host: Option<String>,
    pub file: Option<FileOut>,
    pub available: bool,
    pub disabled: bool,
    pub disabled_reason: String,
    pub created_at: DateTime<Utc>,
}

impl From<&ReleaseRow> for ReleaseOut {
    fn from(r: &ReleaseRow) -> Self {
        let file = match (&r.file_key, &r.file_name, r.file_size, &r.file_sha256) {
            (Some(_), Some(name), Some(size), Some(sha)) => Some(FileOut {
                name: name.clone(),
                size,
                sha256: sha.clone(),
                file_type: r.file_type.clone().unwrap_or_default(),
            }),
            _ => None,
        };
        let external_url = if r.download_kind == "external" { r.external_url.clone() } else { None };
        let external_host = external_url
            .as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()));
        ReleaseOut {
            id: r.id,
            version: r.version.clone(),
            released_on: r.released_on,
            changelog: r.changelog.clone(),
            game_version: r.game_version.clone(),
            kind: r.download_kind.clone(),
            external_url,
            external_host,
            file,
            available: r.available(),
            disabled: r.download_disabled,
            disabled_reason: r.disabled_reason.clone(),
            created_at: r.created_at,
        }
    }
}

#[derive(Serialize)]
pub struct NamedLink {
    pub name: String,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct CategoryRef {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct Compatibility {
    pub status: String,
    pub note: String,
    pub checked_on: Option<NaiveDate>,
}

#[derive(Serialize, FromRow)]
pub struct ScreenshotOut {
    pub id: Uuid,
    #[sqlx(rename = "image_key")]
    #[serde(skip)]
    pub key: String,
    #[sqlx(skip)]
    pub url: String,
    pub caption: String,
    pub sort_order: i32,
}

#[derive(Serialize)]
pub struct ModDetail {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub author: NamedLink,
    pub category: Option<CategoryRef>,
    pub tags: Vec<String>,
    pub thumbnail_url: Option<String>,
    pub screenshots: Vec<ScreenshotOut>,
    pub compatibility: Compatibility,
    pub game_versions: String,
    pub platforms: Vec<String>,
    pub mod_loader: String,
    pub dependencies: Value,
    pub install_instructions: String,
    pub known_issues: String,
    pub source_url: Option<String>,
    pub project_url: Option<String>,
    pub license: NamedLink,
    pub redistribution: String,
    pub redistribution_note: String,
    pub downloads: i64,
    pub featured: bool,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
    pub releases: Vec<ReleaseOut>,
}

pub enum Lookup<'a> {
    Id(Uuid),
    PublishedSlug(&'a str),
}

/// loads everything about one mod. the public api only finds published mods,
/// the admin panel can load any of them by id.
pub async fn load_detail(db: &PgPool, lookup: Lookup<'_>) -> Result<Option<ModDetail>, sqlx::Error> {
    let row: Option<ModRow> = match lookup {
        Lookup::Id(id) => {
            sqlx::query_as(&format!("{MOD_SELECT} where m.id = $1")).bind(id).fetch_optional(db).await?
        }
        Lookup::PublishedSlug(slug) => {
            sqlx::query_as(&format!("{MOD_SELECT} where m.slug = $1 and m.status = 'published'"))
                .bind(slug)
                .fetch_optional(db)
                .await?
        }
    };
    let Some(m) = row else { return Ok(None) };

    let tags: Vec<String> = sqlx::query_scalar(
        "select t.name from mod_tags mt join tags t on t.id = mt.tag_id where mt.mod_id = $1 order by t.name",
    )
    .bind(m.id)
    .fetch_all(db)
    .await?;

    let mut screenshots: Vec<ScreenshotOut> = sqlx::query_as(
        "select id, image_key, caption, sort_order from screenshots where mod_id = $1 order by sort_order, created_at",
    )
    .bind(m.id)
    .fetch_all(db)
    .await?;
    for shot in &mut screenshots {
        shot.url = file_url(&shot.key);
    }

    let releases: Vec<ReleaseRow> = sqlx::query_as(&format!(
        "{RELEASE_SELECT} where mod_id = $1 order by released_on desc, created_at desc"
    ))
    .bind(m.id)
    .fetch_all(db)
    .await?;

    let category = match (m.category_id, m.category_slug, m.category_name) {
        (Some(id), Some(slug), Some(name)) => Some(CategoryRef { id, slug, name }),
        _ => None,
    };

    Ok(Some(ModDetail {
        id: m.id,
        slug: m.slug,
        name: m.name,
        summary: m.summary,
        description: m.description,
        author: NamedLink { name: m.author_name, url: m.author_url },
        category,
        tags,
        thumbnail_url: m.thumbnail_key.as_deref().map(file_url),
        screenshots,
        compatibility: Compatibility {
            status: m.compatibility,
            note: m.compatibility_note,
            checked_on: m.compatibility_checked_on,
        },
        game_versions: m.game_versions,
        platforms: m.platforms,
        mod_loader: m.mod_loader,
        dependencies: m.dependencies,
        install_instructions: m.install_instructions,
        known_issues: m.known_issues,
        source_url: m.source_url,
        project_url: m.project_url,
        license: NamedLink { name: m.license_name, url: m.license_url },
        redistribution: m.redistribution,
        redistribution_note: m.redistribution_note,
        downloads: m.download_count,
        featured: m.featured,
        status: m.status,
        created_at: m.created_at,
        updated_at: m.updated_at,
        published_at: m.published_at,
        releases: releases.iter().map(ReleaseOut::from).collect(),
    }))
}
