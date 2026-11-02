use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::error::{ApiResult, AppError, FieldErrors};
use crate::github::{parse_repo, repo_of};
use crate::models::file_url;
use crate::routes::accounts::account_poster;
use crate::routes::public::{rating, Rating, MAX_SCREENSHOTS, TOP_RATED_SQL};
use crate::state::AppState;
use crate::util::{too_long, Visitor};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/creator/me", post(me))
        .route("/api/creator/mods/{slug}/github", post(set_github))
        .route("/api/creator/mods/{slug}/listing", post(listing))
        .route("/api/creator/mods/{slug}/edit", post(edit_listing).layer(DefaultBodyLimit::max(crate::uploads::MAX_IMAGE_BYTES * (1 + MAX_SCREENSHOTS) + 128 * 1024)))
        .route("/api/creator/mods/{slug}/release", post(new_release).layer(DefaultBodyLimit::max(crate::scan::MAX_CHECK_BYTES + 64 * 1024)))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct KeyInput {
    key: String,
}

#[derive(FromRow)]
struct MyModRow {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    thumbnail_key: Option<String>,
    download_count: i64,
    rating_sum: i32,
    rating_count: i32,
    featured: bool,
    latest_version: Option<String>,
    created_at: DateTime<Utc>,
    source_url: Option<String>,
    project_url: Option<String>,
    github_sync: bool,
    github_tag: Option<String>,
    github_checked_at: Option<DateTime<Utc>>,
    scan_score: Option<i32>,
    from_github: i64,
}

#[derive(Serialize)]
struct MyMod {
    slug: String,
    name: String,
    status: String,
    thumbnail_url: Option<String>,
    downloads: i64,
    week_downloads: i64,
    rating: Rating,
    featured: bool,
    latest_version: Option<String>,
    created_at: DateTime<Utc>,
    scan_score: Option<i32>,
    github: Option<Value>,
}

async fn me(State(state): State<AppState>, visitor: Visitor, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let (poster, username) = account_poster(&state, &input.key, &visitor).await?;
    let rows: Vec<MyModRow> = sqlx::query_as(&format!(
        "with top as ({TOP_RATED_SQL})
         select m.id, m.slug, m.name, m.status, m.thumbnail_key, m.download_count, m.rating_sum, m.rating_count,
                (m.id in (select id from top)) as featured, lr.version as latest_version, m.created_at,
                m.source_url, m.project_url, m.github_sync, m.github_tag, m.github_checked_at,
                round((m.import_info->>'scan_score')::numeric)::int as scan_score,
                (select count(*) from releases g where g.mod_id = m.id and g.from_github) as from_github
         from mods m
         left join lateral (
             select version from releases r where r.mod_id = m.id order by released_on desc, created_at desc limit 1
         ) lr on true
         where m.uploader_poster = $1 and m.status in ('published', 'unpublished')
         order by m.created_at desc limit 200"
    ))
    .bind(poster.id)
    .fetch_all(&state.db)
    .await?;

    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let daily_rows: Vec<(Uuid, i32, i64)> = sqlx::query_as(
        "select r.mod_id, (current_date - de.day)::int as ago, count(*)
         from download_events de join releases r on r.id = de.release_id
         where r.mod_id = any($1) and de.day > current_date - 14
         group by 1, 2",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let mut daily = [0i64; 14];
    for (_, ago, count) in &daily_rows {
        if (0..14).contains(ago) {
            daily[13 - *ago as usize] += count;
        }
    }

    let (rank, creators): (Option<i64>, i64) = sqlx::query_as(
        "with t as (
             select uploader_poster as p, sum(download_count)::bigint as d from mods
             where status = 'published' and uploader_poster is not null group by 1
         )
         select case when exists(select 1 from t where p = $1)
                     then (select count(*) from t where d > (select d from t where p = $1)) + 1 end,
                (select count(*) from t)",
    )
    .bind(poster.id)
    .fetch_one(&state.db)
    .await?;

    let published: Vec<&MyModRow> = rows.iter().filter(|r| r.status == "published").collect();
    let downloads: i64 = published.iter().map(|r| r.download_count).sum();
    let rating_sum: i64 = published.iter().map(|r| r.rating_sum as i64).sum();
    let ratings: i64 = published.iter().map(|r| r.rating_count as i64).sum();
    let week: i64 = daily[7..].iter().sum();

    let mods: Vec<MyMod> = rows
        .iter()
        .map(|r| {
            let week_downloads = daily_rows.iter().filter(|(id, ago, _)| *id == r.id && *ago < 7).map(|(_, _, c)| c).sum();
            let github = repo_of(r.source_url.as_deref(), r.project_url.as_deref()).map(|(owner, repo)| {
                json!({
                    "repo": format!("{owner}/{repo}"),
                    "url": format!("https://github.com/{owner}/{repo}"),
                    "sync": r.github_sync,
                    "tag": r.github_tag,
                    "checked_at": r.github_checked_at,
                    "updates": r.from_github,
                })
            });
            MyMod {
                slug: r.slug.clone(),
                name: r.name.clone(),
                status: r.status.clone(),
                thumbnail_url: r.thumbnail_key.as_deref().map(file_url),
                downloads: r.download_count,
                week_downloads,
                rating: rating(r.rating_sum, r.rating_count),
                featured: r.featured,
                latest_version: r.latest_version.clone(),
                created_at: r.created_at,
                scan_score: r.scan_score,
                github,
            }
        })
        .collect();

    Ok(Json(json!({
        "name": username,
        "mods": mods,
        "totals": {
            "uploads": published.len(),
            "downloads": downloads,
            "week_downloads": week,
            "ratings": ratings,
            "average": if ratings > 0 { Some(((rating_sum as f64 / ratings as f64) * 10.0).round() / 10.0) } else { None },
            "featured": published.iter().filter(|r| r.featured).count(),
            "five_star": published.iter().filter(|r| r.rating_count >= 3 && r.rating_sum as f64 / r.rating_count as f64 >= 4.5).count(),
            "github_linked": published.iter().filter(|r| repo_of(r.source_url.as_deref(), r.project_url.as_deref()).is_some() && r.github_sync).count(),
            "clean": !published.is_empty() && published.iter().all(|r| r.scan_score.is_none_or(|s| s <= 40)),
        },
        "daily": daily,
        "rank": rank,
        "creators": creators,
    })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct GithubInput {
    key: String,
    url: Option<String>,
    sync: Option<bool>,
}

async fn set_github(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>, Json(input): Json<GithubInput>) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("creator-github:{}", visitor.id), 30, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little and try again in a few minutes."));
    }
    let (poster, _) = account_poster(&state, &input.key, &visitor).await?;
    let owned: Option<(Uuid, String)> = sqlx::query_as("select id, name from mods where slug = $1 and uploader_poster = $2 and status in ('published', 'unpublished')")
        .bind(&slug)
        .bind(poster.id)
        .fetch_optional(&state.db)
        .await?;
    let Some((mod_id, _)) = owned else {
        return Err(AppError::not_found("you can only change mods you uploaded"));
    };
    if let Some(url) = input.url.as_deref().map(str::trim) {
        if url.is_empty() {
            sqlx::query("update mods set source_url = null, github_tag = null where id = $1").bind(mod_id).execute(&state.db).await?;
        } else {
            let Some((owner, repo)) = parse_repo(url) else {
                return Err(AppError::field("url", "paste a github link, like https://github.com/you/your-mod"));
            };
            let info = crate::github::repo_info(&state, &owner, &repo).await.map_err(|m| AppError::field("url", &m))?;
            let Some(info) = info else {
                return Err(AppError::field("url", "github couldn't find that repo. it might be private or deleted."));
            };
            sqlx::query("update mods set source_url = $1, github_tag = null, github_checked_at = null, github_sync = true where id = $2")
                .bind(&info.url)
                .bind(mod_id)
                .execute(&state.db)
                .await?;
        }
    }
    if let Some(sync) = input.sync {
        sqlx::query("update mods set github_sync = $1 where id = $2").bind(sync).bind(mod_id).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn owned_mod(state: &AppState, key: &str, visitor: &Visitor, slug: &str) -> ApiResult<(Uuid, String)> {
    let (poster, _) = account_poster(state, key, visitor).await?;
    let owned: Option<(Uuid, String)> = sqlx::query_as("select id, name from mods where slug = $1 and uploader_poster = $2 and status in ('published', 'unpublished')")
        .bind(slug)
        .bind(poster.id)
        .fetch_optional(&state.db)
        .await?;
    owned.ok_or_else(|| AppError::not_found("you can only change mods you uploaded with your creator account"))
}

#[derive(FromRow)]
struct ListingRow {
    id: Uuid,
    slug: String,
    name: String,
    author_name: String,
    description: String,
    category: Option<String>,
    source_url: Option<String>,
    video_id: Option<String>,
    thumbnail_key: Option<String>,
    status: String,
    latest_version: Option<String>,
}

async fn listing(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>, Json(input): Json<KeyInput>) -> ApiResult<Json<Value>> {
    let (mod_id, _) = owned_mod(&state, &input.key, &visitor, &slug).await?;
    let row: ListingRow = sqlx::query_as(
        "select m.id, m.slug, m.name, m.author_name, m.description, c.slug as category, m.source_url, m.video_id, m.thumbnail_key, m.status,
                (select version from releases r where r.mod_id = m.id order by released_on desc, created_at desc limit 1) as latest_version
         from mods m left join categories c on c.id = m.category_id where m.id = $1",
    )
    .bind(mod_id)
    .fetch_one(&state.db)
    .await?;
    let tags: Vec<String> = sqlx::query_scalar("select t.name from mod_tags mt join tags t on t.id = mt.tag_id where mt.mod_id = $1 order by t.name")
        .bind(row.id)
        .fetch_all(&state.db)
        .await?;
    let shots: Vec<(Uuid, String)> = sqlx::query_as("select id, image_key from screenshots where mod_id = $1 order by sort_order, created_at")
        .bind(row.id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({
        "slug": row.slug,
        "name": row.name,
        "author": row.author_name,
        "description": row.description,
        "category": row.category,
        "tags": tags,
        "source_url": row.source_url,
        "video_id": row.video_id,
        "thumbnail_url": row.thumbnail_key.as_deref().map(file_url),
        "screenshots": shots.iter().map(|(id, key)| json!({ "id": id, "url": file_url(key) })).collect::<Vec<_>>(),
        "status": row.status,
        "latest_version": row.latest_version,
    })))
}

type FormParts = (HashMap<String, String>, Vec<(String, String, bytes::Bytes)>);

async fn read_form(multipart: &mut Multipart) -> ApiResult<FormParts> {
    let mut fields = HashMap::new();
    let mut files = Vec::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is too big")),
        };
        let name = field.name().unwrap_or("").to_string();
        if let Some(file_name) = field.file_name().map(str::to_string) {
            let data = field.bytes().await.map_err(|_| AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "the upload was cut off or is too big"))?;
            if !data.is_empty() {
                files.push((name, file_name, data));
            }
        } else if !name.is_empty() {
            let text = field.text().await.map_err(|_| AppError::bad_request("couldn't read the form"))?;
            fields.insert(name, text.chars().take(6000).collect());
        }
    }
    Ok((fields, files))
}

async fn edit_listing(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("creator-edit:{}", visitor.id), 60, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little and try again in a few minutes."));
    }
    let (fields, files) = read_form(&mut multipart).await?;
    let get = |key: &str| fields.get(key).map(|v| v.trim().to_string()).unwrap_or_default();
    let (mod_id, _) = owned_mod(&state, &get("key"), &visitor, &slug).await?;

    let name = get("name");
    let description = get("description");
    let author = get("author");
    let tags = crate::routes::public::parse_tags(&get("tags"));
    let mut errors = FieldErrors::default();
    errors.check(name.chars().count() >= 2, "name", "give your mod a name");
    errors.check(!too_long(&name, 80), "name", "keep the name under 80 characters");
    errors.check(description.chars().count() >= 30, "description", "describe what your mod does (at least 30 characters)");
    errors.check(!too_long(&description, 5000), "description", "keep the description under 5000 characters");
    errors.check(!too_long(&author, 80), "author", "keep the author name under 80 characters");
    errors.check(tags.is_ok(), "tags", tags.as_ref().err().copied().unwrap_or(""));
    let source_url = match crate::util::clean_url(&get("source_url")) {
        Ok(url) => url,
        Err(message) => {
            errors.add("source_url", message);
            None
        }
    };
    let video_id = crate::util::youtube_id(&get("video_url"));
    errors.check(get("video_url").is_empty() || video_id.is_some(), "video_url", "paste a youtube link, like https://youtu.be/abc123xyz00");
    let category = get("category");
    let category_id: Option<Uuid> = if category.is_empty() {
        None
    } else {
        let id = sqlx::query_scalar("select id from categories where slug = $1").bind(&category).fetch_optional(&state.db).await?;
        errors.check(id.is_some(), "category", "that category doesn't exist");
        id
    };
    let status = if get("status") == "unpublished" { "unpublished" } else { "published" };
    let keep: Vec<Uuid> = get("keep_screenshots").split(',').filter_map(|id| Uuid::parse_str(id.trim()).ok()).collect();
    let new_shots: Vec<bytes::Bytes> = files.iter().filter(|(field, _, _)| field == "screenshots").map(|(_, _, data)| data.clone()).collect();
    let kept: i64 = sqlx::query_scalar("select count(*) from screenshots where mod_id = $1 and id = any($2)").bind(mod_id).bind(&keep).fetch_one(&state.db).await?;
    errors.check(kept as usize + new_shots.len() <= MAX_SCREENSHOTS, "screenshots", "add up to 6 screenshots");
    errors.check(files.iter().all(|(_, _, data)| data.len() <= crate::uploads::MAX_IMAGE_BYTES), "screenshots", "images can be up to 8 MB each");
    errors.finish()?;
    let tags = tags.unwrap_or_default();

    let thumbnail = match files.iter().find(|(field, _, _)| field == "thumbnail").map(|(_, _, data)| data.clone()) {
        Some(data) => Some(
            tokio::task::spawn_blocking(move || crate::uploads::process_image(&data, crate::uploads::ImageKind::Thumbnail))
                .await
                .map_err(AppError::internal)?
                .map_err(|message| AppError::field("thumbnail", &message))?,
        ),
        None => None,
    };
    let mut shot_images = Vec::new();
    for data in new_shots {
        let image = tokio::task::spawn_blocking(move || crate::uploads::process_image(&data, crate::uploads::ImageKind::Screenshot))
            .await
            .map_err(AppError::internal)?
            .map_err(|message| AppError::field("screenshots", &message))?;
        shot_images.push(image);
    }

    let mut new_keys: Vec<String> = Vec::new();
    let thumbnail_key = match thumbnail {
        Some(image) => {
            let key = format!("images/{}.{}", Uuid::new_v4(), image.ext);
            crate::storage::put(state.store.as_ref(), &key, image.bytes).await?;
            new_keys.push(key.clone());
            Some(key)
        }
        None => None,
    };
    let mut shot_keys = Vec::new();
    for image in shot_images {
        let key = format!("images/{}.{}", Uuid::new_v4(), image.ext);
        if crate::storage::put(state.store.as_ref(), &key, image.bytes).await.is_ok() {
            new_keys.push(key.clone());
            shot_keys.push(key);
        }
    }
    let remove_thumbnail = get("remove_thumbnail") == "true";
    let old_thumb: Option<String> = sqlx::query_scalar("select thumbnail_key from mods where id = $1").bind(mod_id).fetch_one(&state.db).await?;
    let old_shots: Vec<String> = sqlx::query_scalar("select image_key from screenshots where mod_id = $1 and not (id = any($2))")
        .bind(mod_id)
        .bind(&keep)
        .fetch_all(&state.db)
        .await?;

    let saved: Result<(), sqlx::Error> = async {
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "update mods set name = $1, summary = $2, description = $3, author_name = $4, category_id = $5, source_url = $6, video_id = $7, status = $8,
                thumbnail_key = case when $9::text is not null then $9 when $10 then null else thumbnail_key end, updated_at = now()
             where id = $11",
        )
        .bind(name.chars().take(80).collect::<String>())
        .bind(crate::routes::public::first_sentence(&description))
        .bind(&description)
        .bind(if author.is_empty() { "Anonymous".to_string() } else { author.clone() })
        .bind(category_id)
        .bind(&source_url)
        .bind(&video_id)
        .bind(status)
        .bind(&thumbnail_key)
        .bind(remove_thumbnail)
        .bind(mod_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from screenshots where mod_id = $1 and not (id = any($2))").bind(mod_id).bind(&keep).execute(&mut *tx).await?;
        let start: i32 = sqlx::query_scalar("select coalesce(max(sort_order) + 1, 0) from screenshots where mod_id = $1").bind(mod_id).fetch_one(&mut *tx).await?;
        for (i, key) in shot_keys.iter().enumerate() {
            sqlx::query("insert into screenshots (id, mod_id, image_key, sort_order) values ($1, $2, $3, $4)")
                .bind(Uuid::new_v4())
                .bind(mod_id)
                .bind(key)
                .bind(start + i as i32)
                .execute(&mut *tx)
                .await?;
        }
        crate::routes::admin::set_tags(&mut *tx, mod_id, &tags).await?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(err) = saved {
        for key in &new_keys {
            crate::storage::delete_quietly(state.store.as_ref(), key).await;
        }
        return Err(err.into());
    }
    if thumbnail_key.is_some() || remove_thumbnail {
        if let Some(old) = old_thumb {
            crate::storage::delete_quietly(state.store.as_ref(), &old).await;
        }
    }
    for key in old_shots {
        crate::storage::delete_quietly(state.store.as_ref(), &key).await;
    }
    let slug: String = sqlx::query_scalar("select slug from mods where id = $1").bind(mod_id).fetch_one(&state.db).await?;
    tracing::info!(mod_id = %mod_id, "a creator edited their listing");
    Ok(Json(json!({ "ok": true, "slug": slug })))
}

async fn new_release(State(state): State<AppState>, visitor: Visitor, Path(slug): Path<String>, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    if !state.limiter.check(&format!("creator-release:{}", visitor.id), 20, Duration::from_secs(3600)) {
        return Err(AppError::too_many("slow down a little and try again in a few minutes."));
    }
    let (fields, files) = read_form(&mut multipart).await?;
    let get = |key: &str| fields.get(key).map(|v| v.trim().to_string()).unwrap_or_default();
    let (mod_id, name) = owned_mod(&state, &get("key"), &visitor, &slug).await?;
    let Some((_, file_name, data)) = files.into_iter().find(|(field, _, _)| field == "file") else {
        return Err(AppError::field("file", "attach the new version of your mod (.dll or .zip)"));
    };
    let changelog: String = get("changelog").chars().take(4000).collect();
    let mut version = get("version");
    if too_long(&version, 40) {
        return Err(AppError::field("version", "keep the version under 40 characters"));
    }
    let data = data.to_vec();
    let (checked, report, data) = tokio::task::spawn_blocking(move || {
        let checked = crate::uploads::check_mod_file(&file_name, &data)?;
        let report = crate::scan::scan(&file_name, &data)?;
        Ok::<_, String>((checked, report, data))
    })
    .await
    .map_err(AppError::internal)?
    .map_err(|message| AppError::field("file", &message))?;
    if report.basic_score() >= 85 && report.has_strong_signals() {
        tracing::warn!(mod_id = %mod_id, "a creator's new version was refused by the safety check");
        return Err(AppError::field(
            "file",
            "Branch's automatic safety check flagged this file as likely harmful, so it wasn't added. if you think this is a mistake, email drifted1000@outlook.com.",
        ));
    }
    let same: bool = sqlx::query_scalar("select exists(select 1 from releases where mod_id = $1 and file_sha256 = $2)")
        .bind(mod_id)
        .bind(&checked.sha256)
        .fetch_one(&state.db)
        .await?;
    if same {
        return Err(AppError::field("file", "this exact file is already on your mod. pick the new version."));
    }
    if version.is_empty() {
        version = crate::routes::admin::version_from_file(&checked.name).unwrap_or_else(|| Utc::now().format("%Y.%m.%d").to_string());
    }
    let key = format!("files/{}/{}", Uuid::new_v4(), checked.name);
    crate::storage::put(state.store.as_ref(), &key, data).await?;
    let saved = sqlx::query(
        "insert into releases (id, mod_id, version, released_on, changelog, download_kind, file_key, file_name, file_size, file_sha256, file_type)
         values ($1, $2, $3, current_date, $4, 'hosted', $5, $6, $7, $8, $9)",
    )
    .bind(Uuid::new_v4())
    .bind(mod_id)
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
        return Err(err.into());
    }
    sqlx::query("update mods set updated_at = now(), code_fingerprint = $1 where id = $2").bind(report.fingerprint()).bind(mod_id).execute(&state.db).await?;
    tracing::info!(mod_id = %mod_id, "a creator added a new version");
    Ok(Json(json!({ "ok": true, "version": version, "name": name })))
}
