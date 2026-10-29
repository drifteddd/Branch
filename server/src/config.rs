// reads settings from environment variables and stops early with a clear
// message if something is missing. this type purposely doesn't derive Debug,
// so secrets can't end up in a log by accident.

use std::path::PathBuf;

use anyhow::{bail, Context};

#[derive(Clone)]
pub enum StorageConfig {
    Local {
        dir: PathBuf,
    },
    S3 {
        bucket: String,
        endpoint: Option<String>,
        region: String,
        access_key_id: String,
        secret_access_key: String,
        path_style: bool,
    },
}

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub port: u16,
    /// used to hash ip addresses for rate limits and download counts
    pub server_secret: String,
    pub cookie_secure: bool,
    /// only true behind a proxy we trust (railway), so x-forwarded-for can be believed
    pub trust_proxy: bool,
    pub storage: StorageConfig,
    pub bootstrap_username: Option<String>,
    pub bootstrap_password: Option<String>,
}

fn optional(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn required(key: &str) -> anyhow::Result<String> {
    optional(key).with_context(|| format!("{key} is missing. see .env.example for what it should look like"))
}

fn flag(key: &str, default: bool) -> anyhow::Result<bool> {
    match optional(key).as_deref() {
        None => Ok(default),
        Some("1" | "true" | "yes") => Ok(true),
        Some("0" | "false" | "no") => Ok(false),
        Some(other) => bail!("{key} should be true or false, not '{other}'"),
    }
}

fn on_railway() -> bool {
    std::env::var_os("RAILWAY_ENVIRONMENT_NAME").is_some() || std::env::var_os("RAILWAY_ENVIRONMENT").is_some()
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = required("DATABASE_URL")?;
        let port = match optional("PORT") {
            Some(p) => p.parse::<u16>().context("PORT must be a number")?,
            None => 8080,
        };

        let server_secret = required("SERVER_SECRET")?;
        if server_secret.len() < 32 {
            bail!("SERVER_SECRET must be at least 32 characters long");
        }

        let driver = optional("STORAGE_DRIVER").unwrap_or_else(|| {
            if optional("S3_BUCKET").is_some() { "s3".into() } else { "local".into() }
        });
        let storage = match driver.as_str() {
            "s3" => StorageConfig::S3 {
                bucket: required("S3_BUCKET")?,
                endpoint: optional("S3_ENDPOINT"),
                region: optional("S3_REGION").unwrap_or_else(|| "auto".into()),
                access_key_id: required("S3_ACCESS_KEY_ID")?,
                secret_access_key: required("S3_SECRET_ACCESS_KEY")?,
                path_style: flag("S3_FORCE_PATH_STYLE", true)?,
            },
            "local" => {
                let dir = PathBuf::from(optional("LOCAL_STORAGE_DIR").unwrap_or_else(|| "./data".into()));
                // on railway the normal disk is wiped on every deploy. local storage is only
                // allowed there when it points into a mounted volume, which does persist.
                if on_railway() {
                    let volume = optional("RAILWAY_VOLUME_MOUNT_PATH");
                    let inside_volume = volume.as_deref().is_some_and(|v| dir.starts_with(v));
                    if !inside_volume {
                        bail!("on railway, uploads need a bucket (STORAGE_DRIVER=s3) or LOCAL_STORAGE_DIR inside a mounted volume. otherwise every deploy would delete them");
                    }
                }
                StorageConfig::Local { dir }
            }
            other => bail!("STORAGE_DRIVER must be 's3' or 'local', not '{other}'"),
        };

        Ok(Self {
            database_url,
            port,
            server_secret,
            cookie_secure: flag("COOKIE_SECURE", true)?,
            trust_proxy: flag("TRUST_PROXY", on_railway())?,
            storage,
            bootstrap_username: optional("ADMIN_BOOTSTRAP_USERNAME"),
            bootstrap_password: optional("ADMIN_BOOTSTRAP_PASSWORD"),
        })
    }
}
