use std::convert::Infallible;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use url::Url;

use crate::state::AppState;

pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !out.is_empty() && !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 80 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 80
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn too_long(text: &str, max_chars: usize) -> bool {
    text.chars().count() > max_chars
}

pub fn clean_url(raw: &str) -> Result<Option<String>, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > 500 {
        return Err("this link is too long");
    }
    let url = Url::parse(raw).map_err(|_| "use a full link that starts with https://")?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("only http and https links are allowed");
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("this link isn't allowed");
    }
    Ok(Some(url.to_string()))
}

pub fn sanitize_filename(name: &str) -> Option<String> {
    let base = name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
    let mut out = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else if c == ' ' {
            out.push('-');
        }
    }
    let out = out.trim_matches('.').to_string();
    if out.is_empty() || out.len() > 120 {
        return None;
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4);
    Some(if reserved { format!("file-{out}") } else { out })
}

pub fn like_pattern(query: &str) -> String {
    let mut out = String::from("%");
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn visitor_hash(secret: &str, ip: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(ip.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..16])
}

pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(last) = forwarded.rsplit(',').map(str::trim).find(|s| !s.is_empty()) {
                return last.to_string();
            }
        }
    }
    peer.map(|p| p.ip().to_string()).unwrap_or_else(|| "unknown".into())
}

pub struct Visitor {
    pub id: String,
}

impl FromRequestParts<AppState> for Visitor {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        let ip = client_ip(&parts.headers, peer, state.config.trust_proxy);
        Ok(Visitor { id: visitor_hash(&state.config.server_secret, &ip) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Sky Lanterns 2!"), "sky-lanterns-2");
        assert_eq!(slugify("  --Hi--  "), "hi");
        assert!(valid_slug("sky-lanterns-2"));
        assert!(!valid_slug("Sky"));
        assert!(!valid_slug("-x"));
    }

    #[test]
    fn urls() {
        assert_eq!(clean_url("").unwrap(), None);
        assert!(clean_url("https://github.com/x").unwrap().is_some());
        assert!(clean_url("javascript:alert(1)").is_err());
        assert!(clean_url("file:///c:/windows").is_err());
        assert!(clean_url("https://user:pass@example.com").is_err());
        assert!(clean_url("github.com").is_err());
    }

    #[test]
    fn filenames() {
        assert_eq!(sanitize_filename("../../evil.dll").as_deref(), Some("evil.dll"));
        assert_eq!(sanitize_filename("C:\\x\\My Mod.zip").as_deref(), Some("My-Mod.zip"));
        assert_eq!(sanitize_filename("con.dll").as_deref(), Some("file-con.dll"));
        assert_eq!(sanitize_filename("...").as_deref(), None);
    }

    #[test]
    fn like_escaping() {
        assert_eq!(like_pattern("100%_x"), "%100\\%\\_x%");
    }

    #[test]
    fn forwarded_ip_uses_the_last_hop() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        assert_eq!(client_ip(&headers, None, true), "2.2.2.2");
        assert_eq!(client_ip(&headers, None, false), "unknown");
    }
}
