import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(root, "app", "ui");
const ADMIN = join(root, "server", "admin");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };

const COMPATIBILITY = [
  { key: "tested", label: "Tested", description: "the Branch admin tried this version on the game version listed and it worked at that time." },
  { key: "unconfirmed", label: "Not confirmed", description: "nobody has checked this version with the current game update yet. it might work, or it might not." },
  { key: "outdated", label: "Outdated", description: "made for an older game update. it probably won't work on the current one." },
  { key: "broken", label: "Broken", description: "known not to work right now." },
];
const PLATFORMS = [{ key: "steam", label: "Steam (PC VR)" }, { key: "oculus_pc", label: "Meta / Oculus PC (PC VR)" }, { key: "quest", label: "Quest standalone" }];
const REASONS = [["broken_download", "Broken download"], ["outdated", "Outdated or incompatible"], ["misleading", "Misleading information"], ["harmful", "Suspicious or harmful file"], ["copyright", "Copyright or permission issue"], ["other", "Other"]].map(([key, label]) => ({ key, label }));

const categories = [
  ["cosmetics", "Cosmetics"], ["gameplay", "Gameplay"], ["utilities", "Utilities"], ["maps", "Maps"], ["libraries", "Libraries"],
].map(([slug, name], i) => ({ id: randomUUID(), slug, name, description: "", sort_order: i + 1 }));
const tags = new Map();

const DEMO_NAMES = [
  ["Lantern Trail", "cosmetics", "adds glowing lanterns that follow your hands around the forest."],
  ["Canopy Camera", "utilities", "a smooth spectator camera for recording climbs."],
  ["Moss Boots", "cosmetics", "swaps your hands for mossy tree-bark gloves."],
  ["Echo Lobby Tools", "utilities", "shows ping and room info in a small watch menu."],
  ["Treehouse Map", "maps", "a custom map built around one giant hollow tree."],
  ["Soft Landing", "gameplay", "practice mode that removes fall stun in private rooms."],
  ["Hand Trail Colors", "cosmetics", "pick a color trail for each hand."],
  ["Bark Library", "libraries", "shared code other demo mods use for menus."],
  ["Cave Lights", "maps", "brightens the caves for screenshots."],
  ["Speed Readout", "utilities", "shows your current speed on your wrist."],
  ["River Map", "maps", "a long river course with stepping stones."],
  ["Pebble Pack", "cosmetics", "a set of small rock hats."],
  ["Practice Timer", "gameplay", "times your runs between two points you choose."],
  ["Old Menu Kit", "libraries", "an old menu library that stopped working after an update."],
];
const COMPAT_CYCLE = ["tested", "unconfirmed", "tested", "outdated", "unconfirmed", "tested", "broken"];

function demoSvg(n, label) {
  const hue = (n * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},50%,24%)"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="${120 + ((n * 83) % 400)}" cy="${90 + ((n * 37) % 160)}" r="70" fill="rgba(255,255,255,.12)"/><text x="32" y="320" font-family="Segoe UI, sans-serif" font-size="30" font-weight="700" fill="rgba(255,255,255,.92)">DEMO · ${label.replace(/[<&]/g, "")}</text></svg>`;
}
const images = new Map();
const uploadedImages = new Map();
const assistantCalls = [];
const announcements = [];
const onboardingStats = new Map();
const assistantUsage = () => ({ limit: 25, used: assistantCalls.length, remaining: Math.max(0, 25 - assistantCalls.length), window_hours: 5, resets_at: assistantCalls.length ? new Date(assistantCalls[0] + 5 * 3600_000).toISOString() : null });

const trackerCards = (() => {
  const names = ["REM", "FOREST", "LOPE", "PANCAKE", "SUNRISE", "GORILLA", "ECHO", "MANGO", "PIXEL", "NOVA", "BANANA", "SHADOW", "TOAST", "RIVER", "COMET"];
  const regions = ["US", "USW", "EU"];
  let seed = 7;
  const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; };
  const hex = () => Array.from({ length: 16 }, () => "0123456789ABCDEF"[rand(16)]).join("");
  const step = () => Math.round((rand(10) * 255) / 9);
  return Array.from({ length: 50 }, (_, i) => {
    const count = 3 + rand(7);
    return {
      id: `demo-card-${i}`,
      room: Array.from({ length: 4 + rand(2) }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[rand(34)]).join(""),
      region: regions[rand(3)],
      player_count: count,
      players: Array.from({ length: count }, () => ({ name: `${names[rand(names.length)]}${rand(3) ? "" : rand(9999)}`, id: hex(), color: [step(), step(), step()] })),
      seen_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    };
  });
})();

function demoFile(seed, size) {
  const buf = Buffer.alloc(size);
  buf.write("MZ", 0, "ascii");
  buf.write("BRANCH DEMO FILE - NOT A REAL MOD - " + seed, 2, "ascii");
  return buf;
}
const files = new Map();

const mods = DEMO_NAMES.map(([title, cat, summary], i) => {
  const id = randomUUID();
  const slug = `demo-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const img = `${randomUUID()}.svg`;
  images.set(img, demoSvg(i, title));
  const shots = i % 3 === 0 ? [0, 1, 2].map((k) => { const key = `${randomUUID()}.svg`; images.set(key, demoSvg(i * 5 + k + 1, `${title} ${k + 1}`)); return { id: randomUUID(), url: `/files/demo/${key}`, caption: `demo screenshot ${k + 1}`, sort_order: k }; }) : [];
  const day = new Date(Date.UTC(2026, 9, 26 - i * 3)).toISOString().slice(0, 10);
  const hosted = i % 2 === 0;
  const releaseId = randomUUID();
  const size = 180_000 + i * 25_000;
  if (hosted) files.set(releaseId, demoFile(slug, size));
  const release = {
    id: releaseId, version: `1.${i % 4}.${i}`, released_on: day, changelog: `- demo change number ${i + 1}\n- another **demo** fix`, game_version: "demo", kind: hosted ? "hosted" : "external",
    external_url: hosted ? null : "https://example.com/demo-release", external_host: hosted ? null : "example.com",
    file: hosted ? { name: `${slug}.dll`, size, sha256: createHash("sha256").update(files.get(releaseId)).digest("hex"), type: "dll" } : null,
    available: true, disabled: false, disabled_reason: "", created_at: day + "T12:00:00Z",
  };
  if (title === "Practice Timer") release.demo_fail = true;
  if (title === "Old Menu Kit") { release.available = false; release.disabled = true; release.disabled_reason = "demo: this file was reported as broken."; }
  const category = categories.find((c) => c.slug === cat);
  const modTags = ["demo", cat === "cosmetics" ? "hats" : "tools"];
  return {
    id, slug, name: `${title} (demo)`, summary: `demo data: ${summary}`,
    description: `**this is demo data for testing Branch.** it isn't a real mod.\n\n${summary}\n\n- point one\n- point two\n\n[example link](https://example.com)`,
    author: { name: "Demo Author", url: "https://example.com" }, category: { id: category.id, slug: category.slug, name: category.name }, tags: modTags,
    thumbnail_url: i === 4 ? null : `/files/demo/${img}`, screenshots: shots,
    compatibility: { status: COMPAT_CYCLE[i % COMPAT_CYCLE.length], note: i % 4 === 3 ? "demo note: broke after a game update." : "", checked_on: day },
    game_versions: "demo", platforms: ["steam", "oculus_pc"], mod_loader: "BepInEx 5 (demo)", dependencies: i % 2 ? [{ name: "Bark Library (demo)", url: null, required: true }] : [],
    install_instructions: "1. this is demo text.\n2. real install steps go here.", known_issues: i % 3 === 1 ? "- demo: menu flickers sometimes." : "",
    source_url: i === 0 ? "https://github.com/drifteddd/Branch" : "https://example.com/source", project_url: null, license: { name: "MIT (demo)", url: null }, redistribution: hosted ? "allowed" : "unknown", redistribution_note: "",
    downloads: (i * 37) % 200, featured: i < 3, status: i === 11 ? "draft" : "published", created_at: day, updated_at: day + "T12:00:00Z", published_at: day, releases: [release], open_reports: 0,
  };
});
for (const m of mods) for (const t of m.tags) tags.set(t, { id: randomUUID(), slug: t, name: t });

const reports = [];
const requests = [];
const forum = { posters: new Map(), threads: [], reports: [], chat: [] };
const rewards = { enabled: true, members: new Map(), nextEvent: 1 };
const checkUsage = new Map();
const CHECK_LIMIT = 20;
const audit = [];

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/plain", ...headers });
  res.end(data);
}
const fail = (res, status, error, fields) => send(res, status, { error, fields: fields || null });

async function readBody(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("too big");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req) {
  try { return JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch { return {}; }
}

for (const [i, m] of mods.entries()) {
  const count = i < 7 ? 2 + ((i * 3) % 5) : 0;
  m.rating_count = count;
  m.rating_sum = Math.round(count * (4.8 - i * 0.3));
}
const ratingOf = (m) => ({ average: m.rating_count ? Math.round((m.rating_sum / m.rating_count) * 10) / 10 : null, count: m.rating_count || 0 });
const ratingScore = (m) => ((m.rating_sum || 0) + 15) / ((m.rating_count || 0) + 5);
const topRated = () => new Set(mods.filter((m) => m.status === "published" && m.rating_count > 0).sort((a, b) => ratingScore(b) - ratingScore(a) || b.rating_count - a.rating_count).slice(0, 10).map((m) => m.id));

function summary(m) {
  const latest = m.releases[0];
  return { id: m.id, slug: m.slug, name: m.name, summary: m.summary, author: m.author.name, category: m.category ? { slug: m.category.slug, name: m.category.name } : null, thumbnail_url: m.thumbnail_url, compatibility: m.compatibility.status, featured: topRated().has(m.id), community: Boolean(m.community), downloads: m.downloads, latest_version: latest?.version || null, last_updated: latest?.released_on || m.updated_at.slice(0, 10), rating: ratingOf(m) };
}

function parseMultipart(req, body) {
  const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "")?.[1];
  const result = { fields: {}, file: null, files: {} };
  if (!boundary) return result;
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const [head, ...rest] = part.split("\r\n\r\n");
    if (!rest.length) continue;
    const content = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename != null) {
      const upload = { name: filename, data: Buffer.from(content, "latin1"), type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || "" };
      result.files[name] = upload;
      if (name !== "thumbnail") result.file = upload;
    }
    else if (name) result.fields[name] = content;
  }
  return result;
}

const admin = { username: "demo-admin", password: "demo-password-1234", must_change_password: true };
const sessions = new Set();
const cookieToken = (req) => /branch_session=([a-f0-9-]+)/.exec(req.headers.cookie || "")?.[1];
const log = (action, target, details = "") => audit.unshift({ id: audit.length + 1, admin_username: admin.username, action, target, details, created_at: new Date().toISOString() });

function modPayloadToMod(m, p) {
  const errors = {};
  if (!p.name?.trim()) errors.name = "give the mod a name";
  const slug = (p.slug?.trim() || p.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "");
  if (p.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) errors.slug = "use lowercase letters, numbers and dashes only";
  if (mods.some((o) => o.slug === slug && o.id !== m.id)) errors.slug = "another mod already uses this link name";
  for (const key of ["author_url", "source_url", "project_url", "license_url"]) if (p[key] && !/^https?:\/\/[^\s]+\.[^\s]+/.test(p[key])) errors[key] = "use a full link that starts with https://";
  if (Object.keys(errors).length) return { errors };
  const category = categories.find((c) => c.id === p.category_id);
  Object.assign(m, {
    slug, name: p.name.trim(), summary: p.summary || "", description: p.description || "", author: { name: p.author_name || "", url: p.author_url || null },
    category: category ? { id: category.id, slug: category.slug, name: category.name } : null, tags: p.tags || [],
    compatibility: { status: p.compatibility || "unconfirmed", note: p.compatibility_note || "", checked_on: p.compatibility_checked_on || null },
    game_versions: p.game_versions || "", platforms: p.platforms || [], mod_loader: p.mod_loader || "", dependencies: p.dependencies || [],
    install_instructions: p.install_instructions || "", known_issues: p.known_issues || "", source_url: p.source_url || null, project_url: p.project_url || null,
    license: { name: p.license_name || "", url: p.license_url || null }, redistribution: p.redistribution || "unknown", redistribution_note: p.redistribution_note || "",
    updated_at: new Date().toISOString(),
  });
  for (const t of m.tags) if (!tags.has(t)) tags.set(t, { id: randomUUID(), slug: t, name: t });
  return { mod: m };
}

function publishErrors(m) {
  const e = {};
  if (!m.summary) e.summary = "add a short summary before publishing";
  if (!m.author.name) e.author_name = "add the author's name before publishing";
  if (!m.category) e.category_id = "pick a category before publishing";
  if (!m.license.name) e.license_name = "add the license (or write \"unknown\") before publishing";
  if (!m.releases.some((r) => r.available)) e.releases = "add at least one release with a working download before publishing";
  return e;
}

function refreshRelease(r) {
  r.available = !r.disabled && (r.kind === "hosted" ? Boolean(r.file) : Boolean(r.external_url));
  r.external_host = r.external_url ? new URL(r.external_url).host : null;
  return r;
}

async function adminApi(req, res, path, url) {
  const method = req.method;
  if (req.headers["x-branch-admin"] !== "1") return fail(res, 403, "this request has to come from the admin panel");
  if (path === "/api/admin/login" && method === "POST") {
    const body = await json(req);
    if (body.username?.toLowerCase() !== admin.username || body.password !== admin.password) return fail(res, 401, "wrong username or password");
    const token = randomUUID();
    sessions.add(token);
    log("login", "");
    return send(res, 200, { username: admin.username, must_change_password: admin.must_change_password }, { "set-cookie": `branch_session=${token}; Path=/; HttpOnly; SameSite=Strict` });
  }
  const token = cookieToken(req);
  if (!token || !sessions.has(token)) return fail(res, 401, "you need to log in again");
  if (path === "/api/admin/me") return send(res, 200, { username: admin.username, must_change_password: admin.must_change_password });
  if (path === "/api/admin/logout") { sessions.delete(token); return send(res, 200, { ok: true }, { "set-cookie": "branch_session=; Path=/; Max-Age=0" }); }
  if (path === "/api/admin/password") {
    const body = await json(req);
    if (body.current_password !== admin.password) return fail(res, 422, "that isn't your current password", { current_password: "that isn't your current password" });
    if ((body.new_password || "").length < 12) return fail(res, 422, "use at least 12 characters", { new_password: "use at least 12 characters" });
    admin.password = body.new_password;
    admin.must_change_password = false;
    log("change_password", "");
    return send(res, 200, { ok: true });
  }
  if (admin.must_change_password) return send(res, 403, { error: "change the starting password before doing anything else", code: "password_change_required" });

  const parts = path.split("/").slice(3);
  const find = (id) => mods.find((m) => m.id === id);
  const findRelease = (id) => { for (const m of mods) { const r = m.releases.find((x) => x.id === id); if (r) return [m, r]; } return [null, null]; };

  if (parts[0] === "overview") {
    return send(res, 200, { published: mods.filter((m) => m.status === "published").length, drafts: mods.filter((m) => m.status === "draft").length, hidden: mods.filter((m) => ["unpublished", "archived"].includes(m.status)).length, open_reports: reports.filter((r) => r.status === "open").length, open_requests: requests.filter((r) => r.status === "open").length, compatibility: COMPATIBILITY, platforms: PLATFORMS, report_reasons: REASONS });
  }
  if (parts[0] === "mods" && !parts[1]) {
    if (method === "POST") {
      const m = { id: randomUUID(), status: "draft", featured: false, releases: [], screenshots: [], thumbnail_url: null, downloads: 0, created_at: new Date().toISOString(), published_at: null, open_reports: 0 };
      const result = modPayloadToMod(m, await json(req));
      if (result.errors) return fail(res, 422, Object.values(result.errors)[0], result.errors);
      mods.unshift(m);
      log("create_mod", m.name);
      return send(res, 201, m);
    }
    const q = url.searchParams.get("q")?.toLowerCase() || "";
    const status = url.searchParams.get("status") || "";
    const imported = url.searchParams.get("imported");
    const items = mods.filter((m) => (!q || m.name.toLowerCase().includes(q)) && (!status || m.status === status) && (imported == null || Boolean(m.imported_at) === (imported === "true")) && (!url.searchParams.get("source") || (m.community ? "community" : "admin") === url.searchParams.get("source"))).map((m) => ({ id: m.id, slug: m.slug, name: m.name, author_name: m.author.name, status: m.status, featured: m.featured, compatibility: m.compatibility.status, category_name: m.category?.name || null, release_count: m.releases.length, open_reports: reports.filter((r) => r.mod_id === m.id && r.status === "open").length, updated_at: m.updated_at, imported_at: m.imported_at || null, import_info: m.import_info || null, source: m.community ? "community" : "admin" }));
    return send(res, 200, { items });
  }
  if (parts[0] === "mods" && parts[1]) {
    const m = find(parts[1]);
    if (!m) return fail(res, 404, "that mod doesn't exist");
    if (!parts[2]) {
      if (method === "GET") return send(res, 200, { ...m, imported_at: m.imported_at || null, import_info: m.import_info || null, open_reports: reports.filter((r) => r.mod_id === m.id && r.status === "open").length });
      if (method === "PUT") {
        const result = modPayloadToMod(m, await json(req));
        if (result.errors) return fail(res, 422, Object.values(result.errors)[0], result.errors);
        log("update_mod", m.name);
        return send(res, 200, m);
      }
      if (method === "DELETE") { mods.splice(mods.indexOf(m), 1); log("delete_mod", m.name); return send(res, 200, { ok: true }); }
    }
    if (parts[2] === "status") {
      const { status } = await json(req);
      if (status === "published") { const e = publishErrors(m); if (Object.keys(e).length) return fail(res, 422, Object.values(e)[0], e); m.published_at ||= new Date().toISOString(); }
      m.status = status;
      log("set_status", m.name, status);
      return send(res, 200, m);
    }
    if (parts[2] === "featured") { m.featured = (await json(req)).featured; return send(res, 200, m); }
    if (parts[2] === "thumbnail") {
      if (method === "DELETE") { m.thumbnail_url = null; return send(res, 200, m); }
      const { file } = parseMultipart(req, await readBody(req));
      if (!file || !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) return fail(res, 422, "only png, jpg, webp and gif images are allowed", { file: "only png, jpg, webp and gif images are allowed" });
      const key = `${randomUUID()}.svg`;
      images.set(key, demoSvg(7, "uploaded thumbnail"));
      m.thumbnail_url = `/files/demo/${key}`;
      return send(res, 200, m);
    }
    if (parts[2] === "screenshots") {
      const { file, fields } = parseMultipart(req, await readBody(req));
      if (!file) return fail(res, 400, "no file was attached");
      const key = `${randomUUID()}.svg`;
      images.set(key, demoSvg(9, "uploaded screenshot"));
      m.screenshots.push({ id: randomUUID(), url: `/files/demo/${key}`, caption: fields.caption || "", sort_order: m.screenshots.length });
      return send(res, 200, m);
    }
    if (parts[2] === "releases") {
      const p = await json(req);
      const errors = {};
      if (!p.version) errors.version = "add a version number, like 1.2.0";
      if (!p.released_on) errors.released_on = "pick the release date";
      if (p.download_kind === "external" && !/^https?:\/\//.test(p.external_url || "")) errors.external_url = "add the link to the author's release page";
      if (p.download_kind === "hosted" && m.redistribution !== "allowed") errors.download_kind = "Branch can only host a copy when redistribution is marked \"allowed\". link to the author's release instead.";
      if (Object.keys(errors).length) return fail(res, 422, Object.values(errors)[0], errors);
      const r = refreshRelease({ id: randomUUID(), version: p.version, released_on: p.released_on, changelog: p.changelog || "", game_version: p.game_version || "", kind: p.download_kind, external_url: p.download_kind === "external" ? p.external_url : null, file: null, disabled: false, disabled_reason: "", created_at: new Date().toISOString() });
      m.releases.unshift(r);
      m.releases.sort((a, b) => b.released_on.localeCompare(a.released_on));
      log("create_release", m.name, r.version);
      return send(res, 201, r);
    }
  }
  if (parts[0] === "screenshots") {
    const m = mods.find((x) => x.screenshots.some((s) => s.id === parts[1]));
    if (!m) return fail(res, 404, "that screenshot doesn't exist");
    const s = m.screenshots.find((x) => x.id === parts[1]);
    if (method === "DELETE") m.screenshots.splice(m.screenshots.indexOf(s), 1);
    else Object.assign(s, await json(req));
    return send(res, 200, m);
  }
  if (parts[0] === "releases") {
    const [m, r] = findRelease(parts[1]);
    if (!r) return fail(res, 404, "that release doesn't exist");
    if (!parts[2] && method === "DELETE") { m.releases.splice(m.releases.indexOf(r), 1); return send(res, 200, { ok: true }); }
    if (!parts[2] && method === "PUT") { const p = await json(req); Object.assign(r, { version: p.version, released_on: p.released_on, changelog: p.changelog, game_version: p.game_version, kind: p.download_kind, external_url: p.download_kind === "external" ? p.external_url : null }); return send(res, 200, refreshRelease(r)); }
    if (parts[2] === "file") {
      if (method === "DELETE") { r.file = null; files.delete(r.id); return send(res, 200, refreshRelease(r)); }
      const { file } = parseMultipart(req, await readBody(req));
      if (!file || !/\.(dll|zip)$/i.test(file.name)) return fail(res, 422, "only .dll and .zip files can be hosted", { file: "only .dll and .zip files can be hosted" });
      files.set(r.id, file.data);
      r.file = { name: file.name, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), type: file.name.split(".").pop().toLowerCase() };
      return send(res, 200, refreshRelease(r));
    }
    if (parts[2] === "availability") {
      const p = await json(req);
      if (p.disabled && !p.reason?.trim()) return fail(res, 422, "say why the download is turned off", { reason: "say why the download is turned off. people will see this." });
      r.disabled = p.disabled;
      r.disabled_reason = p.disabled ? p.reason : "";
      return send(res, 200, refreshRelease(r));
    }
  }
  if (parts[0] === "onboarding" && method === "GET") {
    const list = (kind) => [...onboardingStats].filter(([k]) => k.startsWith(kind + ":")).map(([k, count]) => ({ value: k.slice(kind.length + 1), count })).sort((a, b) => b.count - a.count);
    return send(res, 200, { heard_from: list("heard_from"), heard_other: [], uses: list("uses") });
  }
  if (parts[0] === "announcements") {
    if (!parts[1] && method === "GET") return send(res, 200, { items: announcements });
    if (!parts[1] && method === "POST") {
      const p = await json(req);
      if (!p.title || p.title.trim().length < 2) return fail(res, 422, "give it a title", { title: "give it a title" });
      announcements.unshift({ id: randomUUID(), title: p.title.trim(), body: (p.body || "").trim(), kind: p.kind || "announcement", created_at: new Date().toISOString() });
      return send(res, 200, { ok: true });
    }
    if (parts[1] && method === "DELETE") { const i = announcements.findIndex((a) => a.id === parts[1]); if (i >= 0) announcements.splice(i, 1); return send(res, 200, { ok: true }); }
  }
  if (parts[0] === "categories") {
    if (!parts[1] && method === "GET") return send(res, 200, { items: categories.map((c) => ({ ...c, mod_count: mods.filter((m) => m.category?.id === c.id).length })) });
    if (!parts[1] && method === "POST") {
      const p = await json(req);
      if (!p.name?.trim()) return fail(res, 422, "give the category a name", { name: "give the category a name" });
      categories.push({ id: randomUUID(), slug: p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: p.name, description: p.description || "", sort_order: p.sort_order || 0 });
      return send(res, 201, { ok: true });
    }
    const c = categories.find((x) => x.id === parts[1]);
    if (!c) return fail(res, 404, "that category doesn't exist");
    if (method === "DELETE") categories.splice(categories.indexOf(c), 1);
    else Object.assign(c, await json(req));
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "tags") {
    if (!parts[1]) return send(res, 200, { items: [...tags.values()].map((t) => ({ ...t, mod_count: mods.filter((m) => m.tags.includes(t.name)).length })) });
    const t = [...tags.values()].find((x) => x.id === parts[1]);
    if (t && method === "DELETE") tags.delete(t.slug);
    else if (t) t.name = (await json(req)).name;
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "reports") {
    if (!parts[1]) { const s = url.searchParams.get("status"); return send(res, 200, { items: reports.filter((r) => !s || r.status === s) }); }
    const r = reports.find((x) => x.id === parts[1]);
    if (!r) return fail(res, 404, "that report doesn't exist");
    if (method === "DELETE") reports.splice(reports.indexOf(r), 1);
    else { const p = await json(req); r.status = p.status; r.admin_note = p.admin_note; r.reply = p.reply || ""; r.resolved_at = p.status === "open" ? null : new Date().toISOString(); r.resolved_by = p.status === "open" ? null : admin.username; }
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "audit") return send(res, 200, { items: audit.slice(0, 300) });
  if (parts[0] === "rewards") {
    const all = [...rewards.members.values()];
    const totals = (m) => {
      const sum = (f) => m.events.filter(f).reduce((s, e) => s + e.amount, 0);
      return { earned: sum((e) => e.status !== "void"), owed: sum((e) => e.status === "owed"), paid: sum((e) => e.status === "paid"), today: sum((e) => e.status !== "void") };
    };
    if (!parts[1]) {
      const members = all.map((m) => ({ id: m.id, poster_name: forum.posters.get(m.key)?.name || "?", roblox_username: m.roblox_username, payout_item_url: m.payout_item_url, status: m.status, ai_review: m.ai_review, admin_note: "", applied_at: m.applied_at, decided_at: m.decided_at, uploads: mods.filter((x) => x.community && x.uploader_key === m.key).length, ...totals(m) }));
      const events = all.flatMap((m) => m.events.map((e) => ({ ...e, member_id: m.id, roblox_username: m.roblox_username })));
      return send(res, 200, { enabled: rewards.enabled, members, events });
    }
    const body = await json(req);
    if (parts[1] === "settings") { rewards.enabled = body.enabled; return send(res, 200, { ok: true }); }
    const member = all.find((m) => m.id === parts[2]);
    if (parts[1] === "members" && member) {
      if (parts[3] === "paid") { const owed = totals(member).owed; member.events.forEach((e) => { if (e.status === "owed") e.status = "paid"; }); return send(res, 200, { ok: true, paid: owed }); }
      member.status = body.status;
      member.decided_at = new Date().toISOString();
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "chat" && parts[1]) {
    const body = await json(req);
    const m = forum.chat.find((x) => x.id === Number(parts[1]));
    if (!m) return fail(res, 404, "that message doesn't exist");
    m.removed = body.removed;
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "forum") {
    if (!parts[1]) {
      const reports = forum.reports.map((r) => {
        const t = forum.threads.find((x) => x.id === r.thread_id || x.replies.some((y) => y.id === r.reply_id));
        const reply = t?.replies.find((y) => y.id === r.reply_id);
        const post = reply || t;
        return { id: r.id, reason: r.reason, created_at: new Date().toISOString(), kind: reply ? "reply" : "thread", post_id: post.id, thread_id: t.id, thread_title: t.title, body: post.body, removed: post.removed, poster_id: post.poster.id, poster_name: post.poster.name, poster_banned: post.poster.banned };
      });
      const posts = forum.threads.flatMap((t) => [
        { kind: "thread", id: t.id, thread_id: t.id, thread_title: t.title, body: t.body, removed: t.removed, pinned: t.pinned, locked: t.locked, created_at: t.created_at, poster_id: t.poster.id, poster_name: t.poster.name, poster_banned: t.poster.banned },
        ...t.replies.map((r) => ({ kind: "reply", id: r.id, thread_id: t.id, thread_title: t.title, body: r.body, removed: r.removed, pinned: false, locked: false, created_at: r.created_at, poster_id: r.poster.id, poster_name: r.poster.name, poster_banned: r.poster.banned })),
      ]);
      const chat = forum.chat.map((m) => ({ id: m.id, body: m.body, removed: m.removed, created_at: m.created_at, poster_id: m.poster.id, poster_name: m.poster.name, poster_banned: m.poster.banned, open_reports: 0, report_reasons: null })).reverse();
      return send(res, 200, { reports, posts, chat });
    }
    const body = await json(req);
    if (parts[1] === "replies") {
      for (const t of forum.threads) for (const r of t.replies) if (r.id === parts[2]) r.removed = body.removed;
      forum.reports = forum.reports.filter((r) => r.reply_id !== parts[2]);
    }
    if (parts[1] === "threads") Object.assign(forum.threads.find((t) => t.id === parts[2]) || {}, Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)));
    if (parts[1] === "posters") for (const p of forum.posters.values()) if (p.id === parts[2]) p.banned = body.banned;
    if (parts[1] === "reports") forum.reports = forum.reports.filter((r) => r.id !== parts[2]);
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "import" && method === "POST") {
    const { file } = parseMultipart(req, await readBody(req));
    if (!file || !/\.(dll|zip)$/i.test(file.name)) return send(res, 200, { imported: [], failed: [{ file_name: file?.name || "?", error: "only .dll and .zip files can be hosted" }] });
    const name = file.name.replace(/\.(dll|zip)$/i, "").replace(/[_-]?v?\d+(\.\d+)+/, "").replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Imported mod";
    const version = /\d+(\.\d+)+/.exec(file.name)?.[0] || "unknown";
    const m = { id: randomUUID(), status: "draft", featured: false, releases: [], screenshots: [], thumbnail_url: null, downloads: 0, created_at: new Date().toISOString(), published_at: null, open_reports: 0, imported_at: new Date().toISOString(), import_info: { file_name: file.name, scan_score: 4, signals: [], mod_markers: [] } };
    modPayloadToMod(m, { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${mods.length}` });
    files.set(m.id, file.data);
    m.releases.push(refreshRelease({ id: randomUUID(), version, released_on: new Date().toISOString().slice(0, 10), changelog: "", game_version: "", kind: "hosted", external_url: null, file: { name: file.name, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), type: "dll" }, disabled: false, disabled_reason: "", created_at: new Date().toISOString() }));
    mods.unshift(m);
    return send(res, 200, { imported: [{ mod_id: m.id, name, file_name: file.name, version, scan_score: 4 }], failed: [] });
  }
  if (parts[0] === "requests") {
    if (!parts[1]) { const s = url.searchParams.get("status"); return send(res, 200, { items: requests.filter((r) => !s || r.status === s) }); }
    const r = requests.find((x) => x.id === parts[1]);
    if (!r) return fail(res, 404, "that request doesn't exist");
    if (parts[2] === "draft") {
      if (!r.created_mod_id) {
        const m = { id: randomUUID(), status: "draft", featured: false, releases: [], screenshots: [], thumbnail_url: null, downloads: 0, created_at: new Date().toISOString(), published_at: null, open_reports: 0 };
        modPayloadToMod(m, { name: r.mod_name, slug: `${r.mod_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${mods.length}`, author_name: r.author, project_url: r.url, source_url: r.url.includes("github.com") ? r.url : "" });
        mods.unshift(m);
        r.created_mod_id = m.id;
      }
      r.status = "accepted"; r.decided_at = new Date().toISOString(); r.decided_by = admin.username;
      return send(res, 200, { mod_id: r.created_mod_id });
    }
    if (method === "DELETE") requests.splice(requests.indexOf(r), 1);
    else { const p = await json(req); r.status = p.status; r.admin_note = p.admin_note; r.decided_at = p.status === "open" ? null : new Date().toISOString(); r.decided_by = p.status === "open" ? null : admin.username; }
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, "not found");
}

async function publicApi(req, res, path, url) {
  if (path === "/api/meta") {
    return send(res, 200, { categories: categories.map((c) => ({ ...c, mod_count: mods.filter((m) => m.status === "published" && m.category?.id === c.id).length })), compatibility: COMPATIBILITY, platforms: PLATFORMS, report_reasons: REASONS });
  }
  if (path === "/api/assistant/usage") return send(res, 200, { ...assistantUsage(), available: true });
  if (path === "/api/assistant" && req.method === "POST") {
    if (req.headers["x-branch-no-ai"] === "1") return fail(res, 403, "you turned off Branch AI in Settings, so Ask Branch is off.");
    const body = await json(req);
    const question = body.messages?.at(-1)?.content || "";
    if (!question.trim()) return fail(res, 400, "type a message first");
    if (assistantCalls.length >= 25) return fail(res, 429, "you've used all 25 free messages for now. you get another one in 4 h 59 min.");
    assistantCalls.push(Date.now());
    await new Promise((r) => setTimeout(r, 600));
    const picks = mods.filter((m) => m.status === "published").slice(0, 2);
    const player = trackerCards[0].players[0];
    const reply = /track|player|room/i.test(question)
      ? `the newest player the tracker found is **${player.name}** (ID \`${player.id}\`) in room \`${trackerCards[0].room}\` (${trackerCards[0].region}), about a minute ago.`
      : `here are a couple of mods you might like:\n\n- [${picks[0].name}](mod:${picks[0].slug}): ${picks[0].summary}\n- [${picks[1].name}](mod:${picks[1].slug}): ${picks[1].summary}\n\n| Mod | Category |\n| --- | --- |\n| ${picks[0].name} | ${picks[0].category?.name || "none"} |\n| ${picks[1].name} | ${picks[1].category?.name || "none"} |\n\nthis is the demo server, so these answers are made up.`;
    return send(res, 200, { reply, usage: assistantUsage() });
  }
  if (path === "/api/tracker") return send(res, 200, { status: "live", checked_at: new Date().toISOString(), cards: trackerCards.slice(0, 50) });
  if (path === "/api/dev/tracker-card" && req.method === "POST") {
    const body = await json(req);
    trackerCards.unshift({ id: `card-${randomUUID()}`, room: body.room, region: body.region || "US", player_count: body.players.length, players: body.players, seen_at: new Date().toISOString() });
    return send(res, 201, { ok: true });
  }
  if (path === "/api/tree") {
    const list = mods.filter((m) => m.status === "published").sort((a, b) => String(a.published_at || a.created_at).localeCompare(String(b.published_at || b.created_at)));
    return send(res, 200, { mods: list.map((m) => ({ slug: m.slug, name: m.name, category_slug: m.category?.slug || null, category_name: m.category?.name || null, downloads: m.downloads, community: Boolean(m.community), added: m.published_at || m.created_at, rating_sum: m.rating_sum || 0, rating_count: m.rating_count || 0, featured: topRated().has(m.id) })) });
  }
  if (path === "/api/mods") {
    const p = url.searchParams;
    let list = mods.filter((m) => m.status === "published");
    const q = p.get("q")?.toLowerCase();
    if (q) list = list.filter((m) => [m.name, m.summary, m.description, m.author.name, ...m.tags].some((t) => t.toLowerCase().includes(q)));
    if (p.get("category")) list = list.filter((m) => m.category?.slug === p.get("category"));
    if (p.get("compat")) list = list.filter((m) => m.compatibility.status === p.get("compat"));
    if (p.get("featured") === "true") { const top = topRated(); list = list.filter((m) => top.has(m.id)); }
    if (p.has("slugs")) { const s = p.get("slugs").split(","); list = list.filter((m) => s.includes(m.slug)); }
    const sort = p.get("sort") || "top";
    const sorters = { top: (a, b) => ratingScore(b) - ratingScore(a) || (b.rating_count || 0) - (a.rating_count || 0) || b.downloads - a.downloads, updated: (a, b) => summary(b).last_updated.localeCompare(summary(a).last_updated), newest: (a, b) => b.created_at.localeCompare(a.created_at), name: (a, b) => a.name.localeCompare(b.name), downloads: (a, b) => b.downloads - a.downloads };
    if (!sorters[sort]) return fail(res, 400, "unknown sort");
    list = [...list].sort(sorters[sort]);
    const per = Math.min(50, Number(p.get("per_page")) || 20);
    const page = Math.max(1, Number(p.get("page")) || 1);
    const items = list.slice((page - 1) * per, page * per).map(summary);
    await new Promise((r) => setTimeout(r, 250));
    return send(res, 200, { items, page, per_page: per, total: list.length, has_more: page * per < list.length });
  }
  const rateMatch = /^\/api\/mods\/([a-z0-9-]+)\/rating$/.exec(path);
  if (rateMatch && req.method === "POST") {
    const m = mods.find((x) => x.slug === rateMatch[1] && x.status === "published");
    if (!m) return fail(res, 404, "that mod isn't listed");
    const { stars } = await json(req);
    if (!(stars >= 1 && stars <= 5)) return fail(res, 400, "pick between 1 and 5 stars");
    if (m.my_rating) { m.rating_sum -= m.my_rating; m.rating_count -= 1; }
    m.my_rating = stars;
    m.rating_sum = (m.rating_sum || 0) + stars;
    m.rating_count = (m.rating_count || 0) + 1;
    return send(res, 200, { rating: ratingOf(m), my_rating: stars });
  }
  const modMatch = /^\/api\/mods\/([a-z0-9-]+)$/.exec(path);
  if (modMatch) {
    const m = mods.find((x) => x.slug === modMatch[1] && x.status === "published");
    await new Promise((r) => setTimeout(r, 200));
    return m ? send(res, 200, { ...m, featured: topRated().has(m.id), rating: ratingOf(m), my_rating: m.my_rating || null }) : fail(res, 404, "that mod isn't listed");
  }
  const dl = /^\/api\/releases\/([0-9a-f-]+)\/(download|out)$/.exec(path);
  if (dl) {
    const m = mods.find((x) => x.releases.some((r) => r.id === dl[1]));
    const r = m?.releases.find((x) => x.id === dl[1]);
    if (!r || m.status !== "published") return fail(res, 404, "that download doesn't exist");
    if (r.disabled) return fail(res, 410, `this download was turned off: ${r.disabled_reason}`);
    if (dl[2] === "out") { m.downloads++; res.writeHead(302, { location: r.external_url }); return res.end(); }
    if (r.demo_fail) return fail(res, 500, "demo: this download fails on purpose so you can see the error state.");
    const data = files.get(r.id);
    if (!data) return fail(res, 404, "this release isn't hosted on Branch");
    m.downloads++;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length, "content-disposition": `attachment; filename="${r.file.name}"` });
    for (let i = 0; i < data.length; i += 32 * 1024) {
      if (res.destroyed) return;
      res.write(data.subarray(i, i + 32 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return res.end();
  }
  if (path === "/api/onboarding" && req.method === "POST") {
    const body = await json(req);
    const bump = (kind, value) => { const k = kind + ":" + value; onboardingStats.set(k, (onboardingStats.get(k) || 0) + 1); };
    if (body.heard_from) bump("heard_from", body.heard_from);
    for (const u of body.uses || []) bump("uses", u);
    return send(res, 200, { ok: true });
  }
  if (path === "/api/onboarding/picks" && req.method === "POST") {
    const { interests = [] } = await json(req);
    await new Promise((r) => setTimeout(r, 500));
    const words = { cosmetics: ["cosmetic", "hat", "glove", "lantern"], maps: ["map"], movement: ["landing", "climb", "boots"], camera: ["camera"], visuals: ["light", "trail", "color"] };
    const list = mods.filter((m) => m.status === "published").map((m) => {
      const text = (m.name + " " + m.summary + " " + (m.category?.name || "")).toLowerCase();
      const hits = interests.filter((i) => (words[i] || [i]).some((w) => text.includes(w)));
      return { m, score: hits.length * 10 + ratingScore(m), hits };
    }).sort((a, b) => b.score - a.score).slice(0, 4);
    return send(res, 200, { source: "ai", picks: list.map(({ m, hits }) => ({ slug: m.slug, name: m.name, summary: m.summary, category: m.category?.name || null, thumbnail_url: m.thumbnail_url, rating: ratingOf(m), reason: hits.length ? `you said you like ${hits.join(" and ")}, and people love this one.` : "one of the most popular mods on Branch." })) });
  }
  if (path === "/api/inbox" && req.method === "POST") {
    const { key } = await json(req);
    const mine = key ? reports.filter((r) => r.reporter_key === key).map((r) => ({ id: r.id, mod_name: r.mod_name, mod_slug: r.mod_slug, reason: r.reason, status: r.status, reply: r.reply || "", created_at: r.created_at, resolved_at: r.resolved_at })) : [];
    return send(res, 200, { announcements, reports: mine, releases: [{ id: 1, version: "1.0.20", title: "Branch 1.0.20", notes: ["- demo release notes", "- new backgrounds"].join("\n"), published_at: "2026-10-30T12:00:00Z", url: null }] });
  }
  if (path === "/api/reports" && req.method === "POST") {
    const body = await json(req);
    if (body.website) return send(res, 201, { ok: true });
    if (!REASONS.some((r) => r.key === body.reason)) return fail(res, 422, "pick a reason for the report", { reason: "pick a reason for the report" });
    if (body.reason === "other" && !body.details?.trim()) return fail(res, 422, "tell the admin a little about the problem", { details: "tell the admin a little about the problem" });
    const m = mods.find((x) => x.slug === body.mod_slug && x.status === "published");
    if (!m) return fail(res, 404, "that mod isn't listed anymore");
    reports.unshift({ id: randomUUID(), mod_id: m.id, mod_slug: m.slug, mod_name: m.name, reason: body.reason, details: body.details || "", contact: body.contact || "", status: "open", admin_note: "", reply: "", reporter_key: body.key || null, has_inbox: Boolean(body.key), created_at: new Date().toISOString(), resolved_at: null, resolved_by: null });
    return send(res, 201, { ok: true });
  }
  if (path.startsWith("/api/rewards/")) {
    const body = await json(req);
    const uploads = mods.filter((x) => x.community && x.uploader_key === body.key).length;
    const member = rewards.members.get(body.key);
    if (path === "/api/rewards/apply") {
      const errors = {};
      if (!/^[A-Za-z0-9_]{3,20}$/.test(body.roblox_username || "")) errors.roblox_username = "enter your exact roblox username (3 to 20 letters, numbers or _)";
      if (!/^https:\/\/(www\.)?roblox\.com\/(game-pass|catalog|bundles)\//i.test(body.payout_item_url || "")) errors.payout_item_url = "paste the link to one of your roblox gamepasses or clothing items";
      if (!body.confirm) errors.confirm = "you have to agree to the rewards program rules";
      if (Object.keys(errors).length) return fail(res, 422, Object.values(errors)[0], errors);
      if (uploads < 10) return fail(res, 403, `upload ${10 - uploads} more unique mods before applying.`);
      rewards.members.set(body.key, { id: randomUUID(), key: body.key, roblox_username: body.roblox_username, payout_item_url: body.payout_item_url, status: "pending", applied_at: new Date().toISOString(), decided_at: null, events: [], ai_review: { approve: true, summary: "demo: the uploads look like distinct mods.", reasons: [], flagged: [], by: "ai" } });
      return send(res, 201, { status: "pending", summary: null, reasons: [] });
    }
    const sum = (f) => (member?.events || []).filter(f).reduce((s, e) => s + e.amount, 0);
    return send(res, 200, {
      enabled: rewards.enabled,
      uploads,
      threshold: 10,
      limits: { per_mod: 10, daily: 50, total: 500 },
      member: member
        ? { status: member.status, roblox_username: member.roblox_username, payout_item_url: member.payout_item_url, applied_at: member.applied_at, decided_at: member.decided_at, review: null, earned: sum((e) => e.status !== "void"), owed: sum((e) => e.status === "owed"), paid: sum((e) => e.status === "paid"), today: sum((e) => e.status !== "void"), events: member.events }
        : null,
    });
  }
  if (path === "/api/chat") {
    if (req.method === "POST") {
      const body = await json(req);
      const p = forum.posters.get(body.key);
      if (!p) return fail(res, 400, "open the community page first");
      const text = (body.body || "").trim();
      if (!text) return fail(res, 422, "type a message first", { body: "type a message first" });
      const m = { id: forum.chat.length + 1, body: text, removed: false, poster: p, created_at: new Date().toISOString() };
      forum.chat.push(m);
      return send(res, 201, { ok: true, id: m.id });
    }
    const after = Number(url.searchParams.get("after") || 0);
    const list = (after ? forum.chat.filter((m) => m.id > after) : forum.chat.slice(-80)).map((m) => ({ id: m.id, body: m.removed ? "[removed by a moderator]" : m.body, removed: m.removed, author: { name: m.poster.name, tag: m.poster.tag }, created_at: m.created_at }));
    return send(res, 200, { messages: list, latest_id: list.length ? list[list.length - 1].id : after, removed: forum.chat.filter((m) => m.removed).map((m) => m.id) });
  }
  if (path.startsWith("/api/forum/")) {
    const parts = path.split("/").slice(3);
    if (parts[0] === "me") {
      const body = await json(req);
      if (!/^[0-9a-f]{64}$/.test(body.key || "")) return fail(res, 400, "the community key on this computer is broken.");
      let p = forum.posters.get(body.key);
      if (!p) { p = { id: randomUUID(), name: `DemoClimber${forum.posters.size + 10}`, tag: body.key.slice(0, 4), banned: false }; forum.posters.set(body.key, p); }
      if (parts[1] === "random") p.name = `MossyGorilla${Math.floor(Math.random() * 900 + 100)}`;
      else if (req.method === "PUT") {
        const name = (body.name || "").trim();
        if (name.length < 3 || name.length > 24 || !/^[A-Za-z0-9 _-]+$/.test(name)) return fail(res, 422, "names are 3 to 24 characters", { name: "names are 3 to 24 characters" });
        if (/admin|moderator|drifted/i.test(name)) return fail(res, 422, "that name could be confused with Branch staff. pick another one", { name: "that name could be confused with Branch staff. pick another one" });
        p.name = name;
      }
      return send(res, 200, { name: p.name, tag: p.tag, banned: p.banned });
    }
    const author = (p) => ({ name: p.name, tag: p.tag });
    if (parts[0] === "threads" && !parts[1]) {
      if (req.method === "POST") {
        const body = await json(req);
        const p = forum.posters.get(body.key);
        if (!p) return fail(res, 400, "open the community page first");
        const errors = {};
        if ((body.title || "").trim().length < 3) errors.title = "give your post a title (at least 3 characters)";
        if ((body.body || "").trim().length < 10) errors.body = "write a little more (at least 10 characters)";
        if (Object.keys(errors).length) return fail(res, 422, Object.values(errors)[0], errors);
        const t = { id: randomUUID(), board: body.board, title: body.title.trim(), body: body.body.trim(), poster: p, pinned: false, locked: false, removed: false, replies: [], created_at: new Date().toISOString(), last_post_at: new Date().toISOString() };
        forum.threads.unshift(t);
        return send(res, 201, { ok: true, id: t.id });
      }
      const board = url.searchParams.get("board");
      const items = forum.threads.filter((t) => !t.removed && (!board || t.board === board)).map((t) => ({ id: t.id, board: t.board, title: t.title, excerpt: t.body.slice(0, 180), author: author(t.poster), pinned: t.pinned, locked: t.locked, reply_count: t.replies.length, created_at: t.created_at, last_post_at: t.last_post_at }));
      return send(res, 200, { items, page: 1, has_more: false });
    }
    if (parts[0] === "threads" && parts[1]) {
      const t = forum.threads.find((x) => x.id === parts[1] && !x.removed);
      if (!t) return fail(res, 404, "that post isn't there anymore");
      if (parts[2] === "replies") {
        const body = await json(req);
        const p = forum.posters.get(body.key);
        if (!(body.body || "").trim()) return fail(res, 422, "write something first", { body: "write something first" });
        const r = { id: randomUUID(), body: body.body.trim(), poster: p, removed: false, created_at: new Date().toISOString() };
        t.replies.push(r);
        t.last_post_at = r.created_at;
        return send(res, 201, { ok: true, id: r.id });
      }
      return send(res, 200, {
        thread: { id: t.id, board: t.board, title: t.title, body: t.body, author: author(t.poster), pinned: t.pinned, locked: t.locked, removed: false, reply_count: t.replies.length, created_at: t.created_at, last_post_at: t.last_post_at },
        replies: t.replies.map((r) => ({ id: r.id, body: r.removed ? "[removed by a moderator]" : r.body, removed: r.removed, author: author(r.poster), created_at: r.created_at })),
      });
    }
    if (parts[0] === "report") {
      const body = await json(req);
      if (!(body.reason || "").trim()) return fail(res, 422, "say briefly what's wrong", { reason: "say briefly what's wrong" });
      forum.reports.push({ id: randomUUID(), ...body });
      return send(res, 201, { ok: true });
    }
  }
  if (path === "/api/submissions" && req.method === "POST") {
    const { file, fields, files: parts } = parseMultipart(req, await readBody(req));
    if (fields.website) return send(res, 201, { ok: true });
    const thumb = parts.thumbnail;
    const errors = {};
    const easy = fields.mode === "easy";
    let name = (fields.name || "").trim();
    let description = (fields.description || "").trim();
    let wroteListing = false;
    if (easy && file) {
      if (name.length < 2) {
        name = file.name.replace(/\.(dll|zip)$/i, "").split(/[_\- ]/).filter((p) => p && !/^v?\d/.test(p)).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2");
        wroteListing = true;
      }
      if (description.length < 30) {
        description = `adds ${name.toLowerCase()} to Gorilla Tag. this demo text stands in for what Branch's AI writes.\n\n**Features**\n- works in modded lobbies\n- has an in-game toggle\n\n**How to use**\n1. install BepInEx\n2. put the file in BepInEx/plugins`;
        wroteListing = true;
      }
    }
    if (name.length < 2) errors.name = "give your mod a name";
    if (description.length < 30) errors.description = "describe what your mod does (at least 30 characters)";
    if (fields.confirm !== "true") errors.confirm = "you have to confirm that you have the right to share this mod";
    if (thumb && !/^(\x89PNG|\xff\xd8\xff|GIF8|RIFF)/.test(thumb.data.subarray(0, 4).toString("latin1"))) errors.thumbnail = "couldn't read this image";
    if (!file) errors.file = "attach your mod file (.dll or .zip)";
    else if (!["MZ", "PK"].includes(file.data.subarray(0, 2).toString("latin1"))) errors.file = "this .dll doesn't look like a real windows dll";
    if (Object.keys(errors).length) return fail(res, 422, Object.values(errors)[0], errors);
    if (mods.filter((m) => m.community).length >= 40) return fail(res, 429, "you can upload up to 10 mods a day. try again tomorrow.");
    const sha = createHash("sha256").update(file.data).digest("hex");
    const copy = mods.find((x) => x.releases.some((r) => r.file?.sha256 === sha));
    if (copy) return fail(res, 422, `this exact file is already on Branch as "${copy.name}". only new, unique mods can be uploaded.`, { file: `this exact file is already on Branch as "${copy.name}". only new, unique mods can be uploaded.` });
    const m = { id: randomUUID(), status: "draft", featured: false, releases: [], screenshots: [], thumbnail_url: null, downloads: 0, created_at: new Date().toISOString(), published_at: new Date().toISOString(), open_reports: 0, community: true, uploader_key: fields.key || null };
    const author = fields.anonymous === "true" ? "Anonymous" : (fields.author || "").trim() || "Anonymous";
    modPayloadToMod(m, { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${mods.length}`, author_name: author, description, summary: description.split(". ")[0].slice(0, 200), redistribution: "allowed" });
    m.status = "published";
    const text = `${name} ${description}`.toLowerCase();
    const userTags = [...new Set((fields.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 5);
    const guessed = [["hat", "hats"], ["cosmetic", "cosmetics"], ["menu", "menu"], ["fly", "movement"], ["speed", "movement"], ["map", "maps"], ["light", "visuals"], ["sound", "sounds"]].filter(([w]) => text.includes(w)).map(([, t]) => t);
    const aiTags = [...new Set(guessed.length ? guessed : ["utility"])].slice(0, 5);
    m.tags = userTags.length ? userTags : aiTags;
    for (const t of m.tags) if (!tags.has(t)) tags.set(t, { id: randomUUID(), slug: t, name: t });
    const chosenCategory = categories.find((c) => c.slug === fields.category);
    const guessedCategory = chosenCategory ? null : categories.find((c) => (text.includes("hat") && c.slug === "cosmetics") || (text.includes("map") && c.slug === "maps"));
    const finalCategory = chosenCategory || guessedCategory;
    if (finalCategory) m.category = { id: finalCategory.id, slug: finalCategory.slug, name: finalCategory.name };
    const cheat = /fly|speed|noclip|menu/.test(text);
    m.ai = {
      overview: `${name} is a BepInEx plugin. based on its code, it ${cheat ? "adds a menu that changes how your player moves" : "adds client-side changes described by its class names"} and patches a few game methods with Harmony. it doesn't touch files outside the game or connect to the internet.`,
      highlights: cheat ? ["toggle menu in game", "movement changes"] : ["runs only on your game", "no network access"],
      requirements: ["BepInEx", ...(text.includes("utilla") ? ["Utilla"] : [])],
      ban_risk: cheat ? "high" : "none",
      ban_risk_reason: cheat ? "it changes movement, which can get you banned in public lobbies." : "it only changes what you see on your own game.",
      description_match: "matches",
      tags_by_ai: !userTags.length,
      category_by_ai: Boolean(guessedCategory),
      risk: { score: 8, label: "Looks clean", summary: "nothing in the code looks harmful.", what_it_does: "a demo mod", confidence: "high", capabilities: [{ name: "Patches the game", level: "normal", detail: "uses harmony" }, { name: "Reads its config", level: "normal", detail: "its own settings file" }], source: "ai" },
      checked_at: new Date().toISOString(),
    };
    if (thumb) {
      const key = `${randomUUID()}.jpg`;
      uploadedImages.set(key, thumb.data);
      m.thumbnail_url = `/files/uploaded/${key}`;
    }
    files.set(m.id, file.data);
    m.releases.push(refreshRelease({ id: randomUUID(), version: fields.version || "unversioned", released_on: new Date().toISOString().slice(0, 10), changelog: "", game_version: "", kind: "hosted", external_url: null, file: { name: file.name, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), type: "dll" }, disabled: false, disabled_reason: "", created_at: new Date().toISOString() }));
    files.set(m.releases[0].id, file.data);
    mods.unshift(m);
    let earned = 0;
    const member = rewards.members.get(m.uploader_key);
    if (member && member.status === "accepted" && rewards.enabled) {
      const total = member.events.filter((e) => e.status !== "void").reduce((s, e) => s + e.amount, 0);
      if (total < 500 && member.events.length < 5) {
        earned = 10;
        member.events.unshift({ id: rewards.nextEvent++, mod_id: m.id, mod_name: m.name, amount: 10, status: "owed", created_at: new Date().toISOString(), paid_at: null });
      }
    }
    const uploads = mods.filter((x) => x.community && x.uploader_key && x.uploader_key === m.uploader_key).length;
    m.ai.listing_by_ai = wroteListing;
    return send(res, 201, { ok: true, slug: m.slug, name: m.name, reward: { earned, reason: earned ? "earned" : "not in the rewards program", uploads, threshold: 10 }, ai: { overview: m.ai.overview, tags: m.ai.tags_by_ai ? m.tags : [], category: guessedCategory?.name || null, risk_score: 8, wrote_listing: wroteListing, description: wroteListing ? description : null } });
  }
  if (path === "/api/requests" && req.method === "POST") {
    const body = await json(req);
    if (body.website) return send(res, 201, { ok: true });
    const fields = {};
    if (!body.mod_name?.trim()) fields.mod_name = "what's the mod called?";
    if (!/^https?:\/\/\S+\.\S+/.test(body.url || "")) fields.url = "use a full link that starts with https://";
    if (Object.keys(fields).length) return fail(res, 422, Object.values(fields)[0], fields);
    requests.unshift({ id: randomUUID(), mod_name: body.mod_name.trim(), url: body.url.trim(), author: body.author || "", details: body.details || "", contact: body.contact || "", status: "open", admin_note: "", created_mod_id: null, created_at: new Date().toISOString(), decided_at: null, decided_by: null });
    return send(res, 201, { ok: true });
  }
  if (path === "/api/check/usage") { const used = checkUsage.get("me") || 0; return send(res, 200, { used, limit: CHECK_LIMIT, remaining: CHECK_LIMIT - used }); }
  if (path === "/api/check" && req.method === "POST") {
    const used = checkUsage.get("me") || 0;
    if (used >= CHECK_LIMIT) return fail(res, 429, `you've used all ${CHECK_LIMIT} checks for today.`);
    const { file } = parseMultipart(req, await readBody(req));
    if (!file) return fail(res, 400, "no file was attached");
    const head = file.data.subarray(0, 2).toString("latin1");
    if (head !== "MZ" && head !== "PK") return fail(res, 422, "only .dll and .zip files can be checked", { file: "only .dll and .zip files can be checked" });
    const text = file.data.toString("latin1").toLowerCase();
    const signs = [["discord.com/api/webhooks", "has a discord webhook (often used to send stolen data)"], ["createremotethread", "injects code into other programs"], ["leveldb", "reads browser or discord login storage"]].filter(([n]) => text.includes(n));
    const score = Math.min(100, signs.length * 33 + 4);
    checkUsage.set("me", used + 1);
    await new Promise((r) => setTimeout(r, 900));
    return send(res, 200, {
      file: { name: file.name, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), kind: head === "MZ" ? "dll" : "zip" },
      score, verdict: score <= 20 ? "Looks clean" : score <= 45 ? "A few odd things" : score <= 70 ? "Suspicious" : "Likely malicious",
      summary: signs.length ? "demo: this file has several signs of a password stealer." : "demo: nothing unusual was found.",
      reasons: signs.length ? signs.map(([, l]) => l) : ["demo: no webhooks, injection or hidden commands."],
      source: "ai", cached: false, indicators: signs.map(([n, l]) => ({ category: "stealing", label: l, weight: 30, evidence: [n] })), mod_markers: text.includes("bepinex") ? ["BepInEx"] : [],
      confidence: signs.length ? "high" : "medium",
      what_it_does: signs.length ? "demo: claims to unlock cosmetics, but mostly reads login data and sends it to a webhook." : "demo: a small cosmetic mod that adds a hat.",
      capabilities: signs.length
        ? [{ name: "Sends data to a Discord webhook", level: "dangerous", detail: "demo evidence" }, { name: "Injects into other programs", level: "dangerous", detail: "demo evidence" }]
        : [{ name: "Patches the game (Harmony)", level: "normal", detail: "demo evidence" }],
      code: { dotnet: true, types: 12, methods: 80, obfuscated: false },
      used: used + 1, limit: CHECK_LIMIT, remaining: CHECK_LIMIT - used - 1,
    });
  }
  return fail(res, 404, "not found");
}

async function serveStatic(res, base, rel) {
  const target = normalize(join(base, rel));
  if (!target.startsWith(base)) return fail(res, 404, "not found");
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    fail(res, 404, "not found");
  }
}

export function startMockServer(port = 5173) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    try {
      if (path.startsWith("/api/admin/")) return await adminApi(req, res, path, url);
      if (path.startsWith("/api/")) return await publicApi(req, res, path, url);
      if (path.startsWith("/files/uploaded/")) {
        const data = uploadedImages.get(path.slice("/files/uploaded/".length));
        return data ? send(res, 200, data, { "content-type": "image/jpeg" }) : fail(res, 404, "not found");
      }
      if (path.startsWith("/files/demo/")) {
        const svg = images.get(path.slice("/files/demo/".length));
        return svg ? send(res, 200, svg, { "content-type": "image/svg+xml; charset=utf-8" }) : fail(res, 404, "not found");
      }
      if (path === "/admin" || path === "/admin/") return serveStatic(res, ADMIN, "index.html");
      if (path.startsWith("/admin/")) return serveStatic(res, ADMIN, path.slice(7));
      if (path.startsWith("/shared/")) return serveStatic(res, join(UI, "shared"), path.slice(8));
      return serveStatic(res, UI, path === "/" ? "index.html" : path.slice(1));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) fail(res, 500, "mock server error");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT) || 5173;
  await startMockServer(port);
  console.log(`branch demo server (DEMO DATA ONLY) running:\n  app:   http://localhost:${port}/\n  admin: http://localhost:${port}/admin  (demo-admin / demo-password-1234)`);
}
