// a fake branch server for trying the interface on any computer with node.
// everything here is DEMO DATA. none of these mods are real, none of the
// downloads are real mods, and the numbers are made up for testing only.
//
// run:   node dev/mock-server.mjs
// app:   http://localhost:5173/
// admin: http://localhost:5173/admin  (demo login: demo-admin / demo-password-1234)
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

// ---------- demo data ----------

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

function demoFile(seed, size) {
  const buf = Buffer.alloc(size);
  buf.write("MZ", 0, "ascii");
  buf.write("BRANCH DEMO FILE - NOT A REAL MOD - " + seed, 2, "ascii");
  return buf;
}
const files = new Map(); // release id -> Buffer

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
  // one demo download fails on purpose so the error state can be tested
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
    source_url: "https://example.com/source", project_url: null, license: { name: "MIT (demo)", url: null }, redistribution: hosted ? "allowed" : "unknown", redistribution_note: "",
    downloads: (i * 37) % 200, featured: i < 3, status: i === 11 ? "draft" : "published", created_at: day, updated_at: day + "T12:00:00Z", published_at: day, releases: [release], open_reports: 0,
  };
});
for (const m of mods) for (const t of m.tags) tags.set(t, { id: randomUUID(), slug: t, name: t });

const reports = [];
const audit = [];

// ---------- helpers ----------

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

function summary(m) {
  const latest = m.releases[0];
  return { id: m.id, slug: m.slug, name: m.name, summary: m.summary, author: m.author.name, category: m.category ? { slug: m.category.slug, name: m.category.name } : null, thumbnail_url: m.thumbnail_url, compatibility: m.compatibility.status, featured: m.featured, downloads: m.downloads, latest_version: latest?.version || null, last_updated: latest?.released_on || m.updated_at.slice(0, 10) };
}

// a tiny multipart reader, good enough for the demo admin uploads
function parseMultipart(req, body) {
  const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "")?.[1];
  const result = { fields: {}, file: null };
  if (!boundary) return result;
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const [head, ...rest] = part.split("\r\n\r\n");
    if (!rest.length) continue;
    const content = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename != null) result.file = { name: filename, data: Buffer.from(content, "latin1") };
    else if (name) result.fields[name] = content;
  }
  return result;
}

// ---------- demo admin state ----------

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

  const parts = path.split("/").slice(3); // after /api/admin
  const find = (id) => mods.find((m) => m.id === id);
  const findRelease = (id) => { for (const m of mods) { const r = m.releases.find((x) => x.id === id); if (r) return [m, r]; } return [null, null]; };

  if (parts[0] === "overview") {
    return send(res, 200, { published: mods.filter((m) => m.status === "published").length, drafts: mods.filter((m) => m.status === "draft").length, hidden: mods.filter((m) => ["unpublished", "archived"].includes(m.status)).length, open_reports: reports.filter((r) => r.status === "open").length, compatibility: COMPATIBILITY, platforms: PLATFORMS, report_reasons: REASONS });
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
    const items = mods.filter((m) => (!q || m.name.toLowerCase().includes(q)) && (!status || m.status === status)).map((m) => ({ id: m.id, slug: m.slug, name: m.name, author_name: m.author.name, status: m.status, featured: m.featured, compatibility: m.compatibility.status, category_name: m.category?.name || null, release_count: m.releases.length, open_reports: reports.filter((r) => r.mod_id === m.id && r.status === "open").length, updated_at: m.updated_at }));
    return send(res, 200, { items });
  }
  if (parts[0] === "mods" && parts[1]) {
    const m = find(parts[1]);
    if (!m) return fail(res, 404, "that mod doesn't exist");
    if (!parts[2]) {
      if (method === "GET") return send(res, 200, { ...m, open_reports: reports.filter((r) => r.mod_id === m.id && r.status === "open").length });
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
    else { const p = await json(req); r.status = p.status; r.admin_note = p.admin_note; r.resolved_at = p.status === "open" ? null : new Date().toISOString(); r.resolved_by = p.status === "open" ? null : admin.username; }
    return send(res, 200, { ok: true });
  }
  if (parts[0] === "audit") return send(res, 200, { items: audit.slice(0, 300) });
  return fail(res, 404, "not found");
}

// ---------- public api ----------

async function publicApi(req, res, path, url) {
  if (path === "/api/meta") {
    return send(res, 200, { categories: categories.map((c) => ({ ...c, mod_count: mods.filter((m) => m.status === "published" && m.category?.id === c.id).length })), compatibility: COMPATIBILITY, platforms: PLATFORMS, report_reasons: REASONS });
  }
  if (path === "/api/mods") {
    const p = url.searchParams;
    let list = mods.filter((m) => m.status === "published");
    const q = p.get("q")?.toLowerCase();
    if (q) list = list.filter((m) => [m.name, m.summary, m.description, m.author.name, ...m.tags].some((t) => t.toLowerCase().includes(q)));
    if (p.get("category")) list = list.filter((m) => m.category?.slug === p.get("category"));
    if (p.get("compat")) list = list.filter((m) => m.compatibility.status === p.get("compat"));
    if (p.get("featured") === "true") list = list.filter((m) => m.featured);
    if (p.has("slugs")) { const s = p.get("slugs").split(","); list = list.filter((m) => s.includes(m.slug)); }
    const sort = p.get("sort") || "updated";
    const sorters = { updated: (a, b) => summary(b).last_updated.localeCompare(summary(a).last_updated), newest: (a, b) => b.created_at.localeCompare(a.created_at), name: (a, b) => a.name.localeCompare(b.name), downloads: (a, b) => b.downloads - a.downloads };
    if (!sorters[sort]) return fail(res, 400, "unknown sort");
    list = [...list].sort(sorters[sort]);
    const per = Math.min(50, Number(p.get("per_page")) || 20);
    const page = Math.max(1, Number(p.get("page")) || 1);
    const items = list.slice((page - 1) * per, page * per).map(summary);
    await new Promise((r) => setTimeout(r, 250)); // so the loading skeleton is visible
    return send(res, 200, { items, page, per_page: per, total: list.length, has_more: page * per < list.length });
  }
  const modMatch = /^\/api\/mods\/([a-z0-9-]+)$/.exec(path);
  if (modMatch) {
    const m = mods.find((x) => x.slug === modMatch[1] && x.status === "published");
    await new Promise((r) => setTimeout(r, 200));
    return m ? send(res, 200, m) : fail(res, 404, "that mod isn't listed");
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
    // send it slowly so the progress bar has something to show
    for (let i = 0; i < data.length; i += 32 * 1024) {
      if (res.destroyed) return;
      res.write(data.subarray(i, i + 32 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return res.end();
  }
  if (path === "/api/reports" && req.method === "POST") {
    const body = await json(req);
    if (body.website) return send(res, 201, { ok: true });
    if (!REASONS.some((r) => r.key === body.reason)) return fail(res, 422, "pick a reason for the report", { reason: "pick a reason for the report" });
    if (body.reason === "other" && !body.details?.trim()) return fail(res, 422, "tell the admin a little about the problem", { details: "tell the admin a little about the problem" });
    const m = mods.find((x) => x.slug === body.mod_slug && x.status === "published");
    if (!m) return fail(res, 404, "that mod isn't listed anymore");
    reports.unshift({ id: randomUUID(), mod_id: m.id, mod_slug: m.slug, mod_name: m.name, reason: body.reason, details: body.details || "", contact: body.contact || "", status: "open", admin_note: "", created_at: new Date().toISOString(), resolved_at: null, resolved_by: null });
    return send(res, 201, { ok: true });
  }
  return fail(res, 404, "not found");
}

// ---------- static files ----------

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
