// end-to-end checks of the real api against a real postgres database.
// they only run when TEST_DATABASE_URL is set (the github workflow sets it).
// warning: the test wipes that database, so never point it at real data.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use branch_server::config::{Config, StorageConfig};

const ADMIN: &str = "test-admin";
const START_PASSWORD: &str = "starting-password";
const NEW_PASSWORD: &str = "a much longer new passphrase";

struct Client {
    app: Router,
    cookie: Option<String>,
}

struct Reply {
    status: StatusCode,
    json: Value,
    bytes: Vec<u8>,
    headers: axum::http::HeaderMap,
}

impl Client {
    async fn send(&mut self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        if let Some(cookie) = headers.get(header::SET_COOKIE).and_then(|v| v.to_str().ok()) {
            let pair = cookie.split(';').next().unwrap().to_string();
            self.cookie = if pair.ends_with('=') { None } else { Some(pair) };
        }
        let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, json, bytes, headers }
    }

    fn build(&self, method: &str, path: &str, admin: bool) -> axum::http::request::Builder {
        let mut builder = Request::builder().method(method).uri(path);
        if admin {
            builder = builder.header("x-branch-admin", "1");
        }
        if let Some(cookie) = &self.cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder
    }

    async fn get(&mut self, path: &str) -> Reply {
        let admin = path.starts_with("/api/admin");
        let request = self.build("GET", path, admin).body(Body::empty()).unwrap();
        self.send(request).await
    }

    async fn json(&mut self, method: &str, path: &str, body: Value) -> Reply {
        let admin = path.starts_with("/api/admin");
        let request = self
            .build(method, path, admin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.send(request).await
    }

    async fn form(&mut self, path: &str, fields: &[(&str, &str)], file: Option<(&str, &[u8])>) -> Reply {
        let boundary = "branchformboundary";
        let mut body = Vec::new();
        for (name, value) in fields {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
        }
        if let Some((file_name, data)) = file {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let request = self
            .build("POST", path, false)
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
            .body(Body::from(body))
            .unwrap();
        self.send(request).await
    }

    async fn upload(&mut self, path: &str, file_name: &str, data: &[u8]) -> Reply {
        let boundary = "branchtestboundary";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let request = self
            .build("POST", path, true)
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
            .body(Body::from(body))
            .unwrap();
        self.send(request).await
    }
}

fn png_bytes() -> Vec<u8> {
    let image = image::DynamicImage::new_rgb8(64, 36);
    let mut out = std::io::Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn setup() -> Option<Client> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL isn't set, skipping api tests");
        return None;
    };
    // start from an empty database every time
    let pool = sqlx::PgPool::connect(&database_url).await.unwrap();
    sqlx::raw_sql("drop schema public cascade; create schema public;").execute(&pool).await.unwrap();
    pool.close().await;

    let dir = std::env::temp_dir().join(format!("branch-test-{}", uuid::Uuid::new_v4()));
    let config = Config {
        database_url,
        port: 0,
        server_secret: "test-secret-that-is-at-least-32-characters".into(),
        cookie_secure: false,
        trust_proxy: false,
        storage: StorageConfig::Local { dir },
        bootstrap_username: Some(ADMIN.into()),
        bootstrap_password: Some(START_PASSWORD.into()),
        // no key in tests, so the checker falls back to the basic scan and never spends money
        ai_api_key: None,
        ai_model: "test".into(),
        ai_base_url: "http://127.0.0.1:9".into(),
        ai_daily_per_visitor: 3,
        ai_daily_global: 10,
    };
    let state = branch_server::build_state(config).await.unwrap();
    Some(Client { app: branch_server::routes::router(state), cookie: None })
}

// one long test, because every step builds on the one before it
#[tokio::test]
async fn full_flow() {
    let Some(mut c) = setup().await else { return };

    // ---- health and migrations ----
    let r = c.get("/health").await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c.get("/api/meta").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["categories"].as_array().unwrap().len(), 5, "starter categories from the migration");
    let category_id = r.json["categories"][0]["id"].as_str().unwrap().to_string();

    // ---- admin routes are locked ----
    let r = c.get("/api/admin/mods").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let request = Request::builder().method("POST").uri("/api/admin/login").header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "username": ADMIN, "password": START_PASSWORD }).to_string())).unwrap();
    let r = c.send(request).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "login without the admin header is refused");

    let r = c.json("POST", "/api/admin/login", json!({ "username": ADMIN, "password": "wrong" })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = c.json("POST", "/api/admin/login", json!({ "username": "nobody", "password": "wrong" })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // ---- first login has to change the password ----
    let r = c.json("POST", "/api/admin/login", json!({ "username": ADMIN, "password": START_PASSWORD })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["must_change_password"], true);
    assert!(r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().contains("HttpOnly"));
    let r = c.get("/api/admin/mods").await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["code"], "password_change_required");

    let r = c.json("POST", "/api/admin/password", json!({ "current_password": START_PASSWORD, "new_password": "short" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = c.json("POST", "/api/admin/password", json!({ "current_password": START_PASSWORD, "new_password": NEW_PASSWORD })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c.get("/api/admin/mods").await;
    assert_eq!(r.status, StatusCode::OK);

    // a stolen cookie without the header still can't do anything
    let request = Request::builder().uri("/api/admin/mods").header(header::COOKIE, c.cookie.clone().unwrap()).body(Body::empty()).unwrap();
    assert_eq!(c.send(request).await.status, StatusCode::FORBIDDEN);

    // ---- drafts ----
    let r = c.json("POST", "/api/admin/mods", json!({ "name": "" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(r.json["fields"]["name"].is_string());
    let r = c.json("POST", "/api/admin/mods", json!({ "name": "Test Mod", "author_url": "javascript:alert(1)" })).await;
    assert!(r.json["fields"]["author_url"].is_string(), "unsafe links are rejected");

    let r = c.json("POST", "/api/admin/mods", json!({ "name": "Test Mod", "tags": ["hats", "Hats", "client side"] })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let mod_id = r.json["id"].as_str().unwrap().to_string();
    assert_eq!(r.json["slug"], "test-mod");
    assert_eq!(r.json["tags"].as_array().unwrap().len(), 2, "duplicate tags are merged");
    assert_eq!(r.json["status"], "draft");

    let r = c.json("POST", "/api/admin/mods", json!({ "name": "Test Mod" })).await;
    assert_eq!(r.json["fields"]["slug"].as_str().is_some(), true, "duplicate slugs are refused");

    assert_eq!(c.get("/api/mods/test-mod").await.status, StatusCode::NOT_FOUND, "drafts aren't public");

    // ---- publishing needs the important fields and a working release ----
    let r = c.json("POST", &format!("/api/admin/mods/{mod_id}/status"), json!({ "status": "published" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    for field in ["summary", "author_name", "category_id", "license_name", "releases"] {
        assert!(r.json["fields"][field].is_string(), "publish should require {field}");
    }

    let full = json!({
        "name": "Test Mod", "summary": "a test mod", "description": "**hi**", "author_name": "Tester",
        "category_id": category_id, "tags": ["hats"], "compatibility": "tested", "game_versions": "1.0",
        "platforms": ["steam"], "mod_loader": "BepInEx 5", "dependencies": [{ "name": "BepInEx", "url": "https://github.com/BepInEx/BepInEx", "required": true }],
        "license_name": "MIT", "redistribution": "unknown"
    });
    let r = c.json("PUT", &format!("/api/admin/mods/{mod_id}"), full.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);

    // hosting needs permission
    let r = c.json("POST", &format!("/api/admin/mods/{mod_id}/releases"), json!({ "version": "1.0.0", "released_on": "2026-10-01", "download_kind": "hosted" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(r.json["fields"]["download_kind"].is_string());

    let r = c.json("POST", &format!("/api/admin/mods/{mod_id}/releases"), json!({ "version": "1.0.0", "released_on": "2026-10-01", "download_kind": "external", "external_url": "https://example.com/release" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let external_id = r.json["id"].as_str().unwrap().to_string();

    let r = c.json("POST", &format!("/api/admin/mods/{mod_id}/status"), json!({ "status": "published" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);

    // ---- public browsing ----
    let r = c.get("/api/mods").await;
    assert_eq!(r.json["total"], 1);
    assert_eq!(r.json["items"][0]["latest_version"], "1.0.0");
    assert_eq!(c.get("/api/mods?q=tester").await.json["total"], 1, "search covers authors");
    assert_eq!(c.get("/api/mods?q=hats").await.json["total"], 1, "search covers tags");
    assert_eq!(c.get("/api/mods?q=nothing-like-this").await.json["total"], 0);
    assert_eq!(c.get("/api/mods?q=100%25").await.json["total"], 0, "% is not a wildcard");
    assert_eq!(c.get("/api/mods?compat=tested").await.json["total"], 1);
    assert_eq!(c.get("/api/mods?compat=broken").await.json["total"], 0);
    assert_eq!(c.get("/api/mods?sort=bogus").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.get("/api/mods?slugs=test-mod,missing").await.json["total"], 1);

    let r = c.get("/api/mods/test-mod").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["releases"][0]["kind"], "external");
    assert_eq!(r.json["releases"][0]["external_host"], "example.com");

    let r = c.get(&format!("/api/releases/{external_id}/out")).await;
    assert!(r.status.is_redirection());
    let r = c.get(&format!("/api/releases/{external_id}/out")).await;
    assert!(r.status.is_redirection());
    assert_eq!(c.get("/api/mods/test-mod").await.json["downloads"], 1, "one person counts once a day");

    // ---- hosted files and uploads ----
    let mut allowed = full.clone();
    allowed["redistribution"] = json!("allowed");
    c.json("PUT", &format!("/api/admin/mods/{mod_id}"), allowed).await;
    let r = c.json("POST", &format!("/api/admin/mods/{mod_id}/releases"), json!({ "version": "1.1.0", "released_on": "2026-10-20", "download_kind": "hosted" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let hosted_id = r.json["id"].as_str().unwrap().to_string();

    let r = c.upload(&format!("/api/admin/releases/{hosted_id}/file"), "evil.exe", b"MZ\x90\x00").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "only dll and zip");
    let r = c.upload(&format!("/api/admin/releases/{hosted_id}/file"), "fake.dll", b"#!/bin/sh\nrm -rf /").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "content has to match the type");
    let file_data = b"MZ this is a pretend dll for the test";
    let r = c.upload(&format!("/api/admin/releases/{hosted_id}/file"), "../../Test Mod.dll", file_data).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    assert_eq!(r.json["file"]["name"], "Test-Mod.dll", "path parts are stripped");
    assert_eq!(r.json["file"]["sha256"].as_str().unwrap().len(), 64);

    let r = c.get(&format!("/api/releases/{hosted_id}/download")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.bytes, file_data);
    assert!(r.headers.get(header::CONTENT_DISPOSITION).unwrap().to_str().unwrap().contains("attachment"));

    // images are checked and re-encoded
    let r = c.upload(&format!("/api/admin/mods/{mod_id}/thumbnail"), "thumb.png", b"not really a png").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = c.upload(&format!("/api/admin/mods/{mod_id}/thumbnail"), "thumb.png", &png_bytes()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let thumb = r.json["thumbnail_url"].as_str().unwrap().to_string();
    let r = c.get(&thumb).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers.get(header::CACHE_CONTROL).unwrap().to_str().unwrap().contains("immutable"));
    assert_eq!(c.get("/files/files/anything.dll").await.status, StatusCode::NOT_FOUND, "only images are served from /files");
    assert_eq!(c.get("/files/images/../files/x.jpg").await.status, StatusCode::NOT_FOUND);

    // ---- turning a download off ----
    let r = c.json("POST", &format!("/api/admin/releases/{hosted_id}/availability"), json!({ "disabled": true })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "a reason is required");
    let r = c.json("POST", &format!("/api/admin/releases/{hosted_id}/availability"), json!({ "disabled": true, "reason": "reported as harmful" })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c.get(&format!("/api/releases/{hosted_id}/download")).await;
    assert_eq!(r.status, StatusCode::GONE);
    assert!(r.json["error"].as_str().unwrap().contains("reported as harmful"));

    // ---- reports ----
    let r = c.json("POST", "/api/reports", json!({ "mod_slug": "test-mod", "reason": "nonsense" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = c.json("POST", "/api/reports", json!({ "mod_slug": "test-mod", "reason": "other" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "other needs details");
    let r = c.json("POST", "/api/reports", json!({ "mod_slug": "test-mod", "reason": "broken_download", "details": "404", "website": "http://spam" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "bots get a fake success");
    let r = c.json("POST", "/api/reports", json!({ "mod_slug": "test-mod", "reason": "broken_download", "details": "the link 404s", "contact": "me#1234" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    c.json("POST", "/api/reports", json!({ "mod_slug": "test-mod", "reason": "broken_download", "details": "again" })).await;

    let r = c.get("/api/admin/reports?status=open").await;
    let reports = r.json["items"].as_array().unwrap();
    assert_eq!(reports.len(), 1, "honeypot and same-day duplicates aren't stored");
    assert_eq!(reports[0]["contact"], "me#1234");
    let report_id = reports[0]["id"].as_str().unwrap().to_string();
    let r = c.json("PUT", &format!("/api/admin/reports/{report_id}"), json!({ "status": "resolved", "admin_note": "fixed the link" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(c.get("/api/admin/reports?status=open").await.json["items"].as_array().unwrap().len(), 0);
    // public endpoints never expose reports
    assert!(!String::from_utf8_lossy(&c.get("/api/mods/test-mod").await.bytes).contains("me#1234"));

    // ---- unpublish, archive and delete ----
    let r = c.json("POST", &format!("/api/admin/mods/{mod_id}/status"), json!({ "status": "unpublished" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(c.get("/api/mods").await.json["total"], 0);
    assert_eq!(c.get(&format!("/api/releases/{external_id}/out")).await.status, StatusCode::NOT_FOUND, "hidden mods can't be downloaded");

    let r = c.json("DELETE", &format!("/api/admin/mods/{mod_id}"), json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(c.get(&format!("/api/admin/mods/{mod_id}")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(c.get(&thumb).await.status, StatusCode::NOT_FOUND, "stored files are removed too");
    assert_eq!(c.get("/api/admin/reports").await.json["items"][0]["mod_name"], "Test Mod", "reports keep the name");

    // ---- mod requests ----
    let r = c.json("POST", "/api/requests", json!({ "mod_name": "Cool Hat", "url": "not a link" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(r.json["fields"]["url"].is_string());
    let r = c.json("POST", "/api/requests", json!({ "mod_name": "Cool Hat", "url": "https://github.com/someone/cool-hat", "author": "someone", "details": "it's great" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let r = c.get("/api/admin/requests?status=open").await;
    let requests = r.json["items"].as_array().unwrap().clone();
    assert_eq!(requests.len(), 1);
    let request_id = requests[0]["id"].as_str().unwrap().to_string();
    let r = c.json("POST", &format!("/api/admin/requests/{request_id}/draft"), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let draft_id = r.json["mod_id"].as_str().unwrap().to_string();
    let r = c.get(&format!("/api/admin/mods/{draft_id}")).await;
    assert_eq!(r.json["status"], "draft");
    assert_eq!(r.json["source_url"], "https://github.com/someone/cool-hat");
    assert_eq!(c.get("/api/admin/requests?status=accepted").await.json["items"].as_array().unwrap().len(), 1);

    // ---- mod checker (no ai key in tests, so it uses the basic scan and spends nothing) ----
    let r = c.get("/api/check/usage").await;
    assert_eq!(r.json["used"], 0);
    assert_eq!(r.json["limit"], 3);
    let r = c.upload("/api/check", "notes.txt", b"just some text").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "only dll and zip can be checked");
    let stealer = b"MZ\x90\x00\x00https://discord.com/api/webhooks/1/x\x00\\Local Storage\\leveldb\x00CreateRemoteThread\x00";
    let r = c.upload("/api/check", "free-cosmetics.dll", stealer).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    assert!(r.json["score"].as_u64().unwrap() >= 70, "{}", r.json);
    assert_eq!(r.json["source"], "basic");
    assert_eq!(r.json["used"], 1, "a refused file doesn't use up a check");
    let clean = b"MZ\x90\x00\x00BepInEx\x00HarmonyLib\x00UnityEngine\x00";
    let r = c.upload("/api/check", "hat.dll", clean).await;
    assert!(r.json["score"].as_u64().unwrap() <= 20, "{}", r.json);
    c.upload("/api/check", "hat.dll", clean).await;
    let r = c.upload("/api/check", "hat.dll", clean).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "daily limit");
    // ---- bulk import: a zip full of mods becomes one draft per mod ----
    let mut pack = std::io::Cursor::new(Vec::new());
    {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(&mut pack);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("mods/GorillaHats_v1.4.dll", opts).unwrap();
        zip.write_all(b"MZ hats BepInEx").unwrap();
        zip.start_file("mods/SpeedReadout.dll", opts).unwrap();
        zip.write_all(b"MZ speed BepInEx").unwrap();
        zip.start_file("readme.txt", opts).unwrap();
        zip.write_all(b"not a mod").unwrap();
        zip.finish().unwrap();
    }
    let r = c.upload("/api/admin/import", "pack.zip", pack.get_ref()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let imported = r.json["imported"].as_array().unwrap().clone();
    assert_eq!(imported.len(), 2, "{}", r.json);
    let hats = imported.iter().find(|m| m["file_name"] == "GorillaHats_v1.4.dll").unwrap();
    assert_eq!(hats["name"], "Gorilla Hats");
    assert_eq!(hats["version"], "1.4");
    let speed = imported.iter().find(|m| m["file_name"] == "SpeedReadout.dll").unwrap();
    assert_eq!(speed["version"], "unknown");
    let r = c.get("/api/admin/mods?imported=true").await;
    assert_eq!(r.json["items"].as_array().unwrap().len(), 2);
    assert_eq!(r.json["items"][0]["status"], "draft");

    // imported drafts can't go public until they're filled in, and a hosted copy needs permission
    let speed_id = speed["mod_id"].as_str().unwrap().to_string();
    let mut filled = full.clone();
    filled["name"] = json!("Speed Readout");
    let r = c.json("PUT", &format!("/api/admin/mods/{speed_id}"), filled).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let r = c.json("POST", &format!("/api/admin/mods/{speed_id}/status"), json!({ "status": "published" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(r.json["fields"]["redistribution"].is_string(), "{}", r.json);
    assert!(r.json["fields"]["releases"].is_string(), "{}", r.json);

    // ---- community uploads ----
    let description = "adds tiny hats to every player. works in private lobbies.";
    let r = c.form("/api/submissions", &[("name", "Tiny Hats"), ("description", "too short")], Some(("TinyHats.dll", &b"MZ BepInEx hats"[..]))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(r.json["fields"]["description"].is_string(), "{}", r.json);
    assert!(r.json["fields"]["confirm"].is_string(), "the rights confirmation is required");
    let r = c.form("/api/submissions", &[("name", "Free Robux"), ("description", description), ("confirm", "true")], Some(("x.dll", &b"MZ https://discord.com/api/webhooks/1/x \\Local Storage\\leveldb CreateRemoteThread"[..]))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "harmful files are refused: {}", r.json);
    assert!(r.json["fields"]["file"].as_str().unwrap().contains("safety check"));
    // uploads from the app carry the person's community key, so they count toward rewards
    let member_key = "f00d".repeat(16);
    let r = c.form("/api/submissions", &[("name", "Tiny Hats"), ("description", description), ("anonymous", "true"), ("author", "should be hidden"), ("confirm", "true"), ("key", member_key.as_str())], Some(("TinyHats_v2.1.dll", &b"MZ BepInEx hats"[..]))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let slug = r.json["slug"].as_str().unwrap().to_string();
    let r = c.get(&format!("/api/mods/{slug}")).await;
    assert_eq!(r.status, StatusCode::OK, "community uploads go live right away");
    assert_eq!(r.json["author"]["name"], "Anonymous");
    assert_eq!(r.json["community"], true);
    assert_eq!(r.json["releases"][0]["version"], "2.1");
    let release_id = r.json["releases"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(c.get(&format!("/api/releases/{release_id}/download")).await.bytes, b"MZ BepInEx hats");
    assert_eq!(c.get("/api/admin/mods?source=community").await.json["items"].as_array().unwrap().len(), 1);
    let r = c.form("/api/submissions", &[("name", "Tiny Hats Again"), ("description", description), ("confirm", "true")], Some(("copy.dll", &b"MZ BepInEx hats"[..]))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "the exact same file can't be uploaded twice");
    assert!(r.json["fields"]["file"].as_str().unwrap().contains("already on Branch"), "{}", r.json);
    for n in 2..=10 {
        let name = format!("Hat Pack {n}");
        let bytes = format!("MZ BepInEx pack number {n}");
        let r = c.form("/api/submissions", &[("name", name.as_str()), ("description", description), ("confirm", "true"), ("key", member_key.as_str())], Some(("pack.dll", bytes.as_bytes()))).await;
        assert_eq!(r.status, StatusCode::CREATED, "upload {n}: {}", r.json);
        assert_eq!(r.json["reward"]["uploads"], n, "uploads are counted toward rewards");
        assert_eq!(r.json["reward"]["earned"], 0, "nothing is earned before joining");
    }
    let r = c.form("/api/submissions", &[("name", "One Too Many"), ("description", description), ("confirm", "true")], Some(("pack.dll", &b"MZ BepInEx one too many"[..]))).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "10 uploads a day");

    // ---- rewards program ----
    let r = c.json("POST", "/api/rewards/me", json!({ "key": member_key })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    assert_eq!(r.json["uploads"], 10);
    assert_eq!(r.json["enabled"], true);
    assert!(r.json["member"].is_null());
    let r = c.json("POST", "/api/rewards/apply", json!({ "key": member_key, "roblox_username": "x", "payout_item_url": "https://evil.example/item", "confirm": true })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(r.json["fields"]["roblox_username"].is_string() && r.json["fields"]["payout_item_url"].is_string(), "{}", r.json);
    let r = c.json("POST", "/api/rewards/apply", json!({ "key": member_key, "roblox_username": "Cool_Climber", "payout_item_url": "https://www.roblox.com/game-pass/123456/Support", "confirm": true })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    assert_eq!(r.json["status"], "pending", "without the ai, applications go straight to the admin");
    let r = c.json("POST", "/api/rewards/apply", json!({ "key": member_key, "roblox_username": "Cool_Climber", "payout_item_url": "https://www.roblox.com/game-pass/123456/Support", "confirm": true })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "can't apply twice");
    let r = c.get("/api/admin/rewards").await;
    let member_id = r.json["members"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(r.json["members"][0]["status"], "pending");
    assert_eq!(r.json["members"][0]["uploads"], 10);
    let r = c.json("POST", &format!("/api/admin/rewards/members/{member_id}"), json!({ "status": "accepted" })).await;
    assert_eq!(r.status, StatusCode::OK);

    // the next day: the daily upload limit has reset
    let pool = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap()).await.unwrap();
    sqlx::query("update mods set created_at = created_at - interval '1 day'").execute(&pool).await.unwrap();
    let r = c.form("/api/submissions", &[("name", "Brand New Mod"), ("description", description), ("confirm", "true"), ("key", member_key.as_str())], Some(("new.dll", &b"MZ BepInEx brand new"[..]))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    assert_eq!(r.json["reward"]["earned"], 10, "members earn 10 R$ per unique upload: {}", r.json);
    let r = c.json("POST", "/api/rewards/me", json!({ "key": member_key })).await;
    assert_eq!(r.json["member"]["status"], "accepted");
    assert_eq!(r.json["member"]["earned"], 10);
    assert_eq!(r.json["member"]["owed"], 10);
    assert_eq!(r.json["member"]["today"], 10);
    assert_eq!(r.json["member"]["events"][0]["mod_name"], "Brand New Mod");
    let r = c.get("/api/admin/rewards").await;
    assert_eq!(r.json["events"][0]["roblox_username"], "Cool_Climber", "the admin sees exactly who earned it");
    let r = c.json("POST", &format!("/api/admin/rewards/members/{member_id}/paid"), json!({})).await;
    assert_eq!(r.json["paid"], 10);
    let r = c.json("POST", "/api/rewards/me", json!({ "key": member_key })).await;
    assert_eq!(r.json["member"]["paid"], 10);
    assert_eq!(r.json["member"]["owed"], 0);

    // the program can be switched off
    c.json("POST", "/api/admin/rewards/settings", json!({ "enabled": false })).await;
    assert_eq!(c.json("POST", "/api/rewards/me", json!({ "key": member_key })).await.json["enabled"], false);
    c.json("POST", "/api/admin/rewards/settings", json!({ "enabled": true })).await;

    // ---- community forum ----
    let key = "ab12".repeat(16);
    let r = c.json("POST", "/api/forum/me", json!({ "key": key })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    assert!(r.json["name"].as_str().unwrap().len() >= 3, "a random name is made");
    assert_eq!(r.json["tag"].as_str().unwrap().len(), 4);
    let r = c.json("POST", "/api/forum/me", json!({ "key": "not-a-key" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = c.json("PUT", "/api/forum/me", json!({ "key": key, "name": "Branch Admin" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "staff-like names are blocked");
    let r = c.json("PUT", "/api/forum/me", json!({ "key": key, "name": "Cool Climber" })).await;
    assert_eq!(r.json["name"], "Cool Climber");

    let r = c.json("POST", "/api/forum/threads", json!({ "key": key, "board": "nope", "title": "hi", "body": "short" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = c.json("POST", "/api/forum/threads", json!({ "key": key, "board": "help", "title": "how do i install bepinex?", "body": "i tried but the mods folder never shows up." })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let thread_id = r.json["id"].as_str().unwrap().to_string();
    let r = c.get("/api/forum/threads?board=help").await;
    assert_eq!(r.json["items"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["items"][0]["author"]["name"], "Cool Climber");

    let reply = json!({ "key": key, "body": "run the game once after installing it." });
    let r = c.json("POST", &format!("/api/forum/threads/{thread_id}/replies"), reply.clone()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let reply_id = r.json["id"].as_str().unwrap().to_string();
    let r = c.json("POST", &format!("/api/forum/threads/{thread_id}/replies"), reply).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "double posts are blocked");
    let r = c.get(&format!("/api/forum/threads/{thread_id}")).await;
    assert_eq!(r.json["thread"]["reply_count"], 1);
    assert_eq!(r.json["replies"].as_array().unwrap().len(), 1);

    let r = c.json("POST", "/api/forum/report", json!({ "reply_id": reply_id, "reason": "spam" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let r = c.get("/api/admin/forum").await;
    assert_eq!(r.json["reports"].as_array().unwrap().len(), 1, "{}", r.json);
    let poster_id = r.json["reports"][0]["poster_id"].as_str().unwrap().to_string();
    let r = c.json("POST", &format!("/api/admin/forum/replies/{reply_id}"), json!({ "removed": true })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c.get(&format!("/api/forum/threads/{thread_id}")).await;
    assert_eq!(r.json["replies"][0]["body"], "[removed by a moderator]");
    assert_eq!(c.get("/api/admin/forum").await.json["reports"].as_array().unwrap().len(), 0, "removing closes the report");

    // ---- main chat ----
    let r = c.json("POST", "/api/chat", json!({ "key": key, "body": "   " })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = c.json("POST", "/api/chat", json!({ "key": key, "body": "hello everyone" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let first_id = r.json["id"].as_i64().unwrap();
    let r = c.json("POST", "/api/chat", json!({ "key": key, "body": "hello everyone" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "repeats are blocked");
    c.json("POST", "/api/chat", json!({ "key": key, "body": "anyone have a good fly mod?" })).await;
    let r = c.get("/api/chat").await;
    assert_eq!(r.json["messages"].as_array().unwrap().len(), 2);
    assert_eq!(r.json["messages"][0]["author"]["name"], "Cool Climber");
    let r = c.get(&format!("/api/chat?after={first_id}")).await;
    assert_eq!(r.json["messages"].as_array().unwrap().len(), 1, "only newer messages come back");
    let r = c.json("POST", "/api/forum/report", json!({ "chat_id": first_id, "reason": "rude" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let r = c.get("/api/admin/forum").await;
    assert_eq!(r.json["chat"][0]["open_reports"], 1, "reported messages come first: {}", r.json["chat"]);
    let r = c.json("POST", &format!("/api/admin/chat/{first_id}"), json!({ "removed": true })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c.get("/api/chat").await;
    assert_eq!(r.json["messages"][0]["body"], "[removed by a moderator]");
    assert!(r.json["removed"].as_array().unwrap().iter().any(|id| id.as_i64() == Some(first_id)));

    let r = c.json("POST", &format!("/api/admin/forum/posters/{poster_id}"), json!({ "banned": true })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c.json("POST", &format!("/api/forum/threads/{thread_id}/replies"), json!({ "key": key, "body": "am i banned?" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "banned posters can't post");
    let other = "cd34".repeat(16);
    let r = c.json("POST", "/api/forum/threads", json!({ "key": other, "board": "general", "title": "new name, same person", "body": "trying to get around the ban" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "a new key on the same connection is blocked too");

    // ---- activity log and logout ----
    let actions: Vec<String> = c.get("/api/admin/audit").await.json["items"].as_array().unwrap().iter().map(|a| a["action"].as_str().unwrap().to_string()).collect();
    for action in ["login", "change_password", "create_mod", "set_status", "upload_file", "disable_download", "delete_mod", "accept_request"] {
        assert!(actions.iter().any(|a| a == action), "audit log is missing {action}");
    }
    let r = c.json("POST", "/api/admin/logout", json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(c.get("/api/admin/me").await.status, StatusCode::UNAUTHORIZED);

    // the old password stopped working
    let r = c.json("POST", "/api/admin/login", json!({ "username": ADMIN, "password": START_PASSWORD })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}
