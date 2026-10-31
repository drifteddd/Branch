import { renderMarkdown } from "/shared/markdown.js";
import { openSourceViewer as openViewer, parseGithub } from "/shared/source-viewer.js";

function openSourceViewer(url) {
  if (!openViewer(url)) toast("only github links can be viewed inside Branch", "error");
}

const app = document.getElementById("app");
let me = null;
let meta = { compatibility: [], platforms: [], report_reasons: [] };
let categories = [];
let dirty = false;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "html") el.innerHTML = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function fill(el, ...children) {
  el.replaceChildren();
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const fmtDate = (v) => (v ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00" : v).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const fmtTime = (v) => (v ? new Date(v).toLocaleString() : "");
const fmtBytes = (n) => (n == null ? "" : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const label = (list, key) => list.find((x) => x.key === key)?.label || key;

class ApiError extends Error {
  constructor(message, status, code, fields) {
    super(message);
    Object.assign(this, { status, code, fields });
  }
}

async function api(path, { method = "GET", body, form } = {}) {
  const headers = { "x-branch-admin": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError("couldn't reach the server. check your connection.", 0, "network");
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== "/api/admin/login") {
    const wasLoggedIn = me !== null;
    me = null;
    renderLogin(wasLoggedIn ? "your session ended. log in again." : "");
    throw new ApiError("logged out", 401, "unauthorized");
  }
  if (res.status === 403 && data?.code === "password_change_required") {
    renderPasswordChange(true);
    throw new ApiError(data.error, 403, data.code);
  }
  if (!res.ok) throw new ApiError(data?.error || `request failed (${res.status})`, res.status, data?.code, data?.fields);
  return data;
}

function toast(message, tone = "") {
  const el = h("div", { class: `toast ${tone}` }, message);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), 3500);
}

function confirmDialog(title, message, confirmLabel = "Confirm", destructive = true) {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = h(
      "dialog",
      { class: "sheet" },
      h("div", { class: "sheet-body" }, h("h2", { class: "sheet-title" }, title), h("p", { class: "muted" }, message)),
      h(
        "div",
        { class: "sheet-actions" },
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: destructive ? "btn btn-danger-solid" : "btn btn-primary", type: "button", onclick: () => { answer = true; dialog.close(); } }, confirmLabel),
      ),
    );
    dialog.addEventListener("close", () => { dialog.remove(); resolve(answer); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function promptDialog(title, message, fieldLabel, confirmLabel) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h("textarea", { class: "textarea", id: "prompt-input", maxlength: "300", rows: "3" });
    const dialog = h(
      "dialog",
      { class: "sheet" },
      h("div", { class: "sheet-body" }, h("h2", { class: "sheet-title" }, title), h("p", { class: "muted" }, message), h("div", { class: "field" }, h("label", { for: "prompt-input" }, fieldLabel), input)),
      h(
        "div",
        { class: "sheet-actions" },
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn btn-danger-solid", type: "button", onclick: () => { answer = input.value.trim(); dialog.close(); } }, confirmLabel),
      ),
    );
    dialog.addEventListener("close", () => { dialog.remove(); resolve(answer); });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

function field(id, text, control, { hint, needed, required, name } = {}) {
  control.id = control.id || id;
  const error = h("p", { class: "error hidden", id: `${id}-error` });
  control.setAttribute("aria-describedby", `${id}-error${hint ? ` ${id}-hint` : ""}`);
  return h(
    "div",
    { class: "field", dataset: { field: name || id } },
    h("label", { for: control.id }, text, required ? h("span", { class: "req", title: "required" }, "*") : null, needed ? h("span", { class: "needed" }, "needed to publish") : null),
    control,
    hint ? h("p", { class: "hint", id: `${id}-hint` }, hint) : null,
    error,
  );
}

function showFieldErrors(root, fields) {
  for (const el of root.querySelectorAll(".field .error")) { el.classList.add("hidden"); el.textContent = ""; }
  for (const el of root.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  let first = null;
  let unmatched = [];
  for (const [name, message] of Object.entries(fields || {})) {
    const wrap = root.querySelector(`[data-field="${name}"]`);
    if (!wrap) { unmatched.push(message); continue; }
    const error = wrap.querySelector(".error");
    error.textContent = message;
    error.classList.remove("hidden");
    const control = wrap.querySelector("input, textarea, select");
    control?.setAttribute("aria-invalid", "true");
    first = first || control || wrap;
  }
  first?.focus?.();
  return unmatched;
}

window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

function renderLogin(message) {
  const username = h("input", { class: "input", autocomplete: "username", required: true, autocapitalize: "off", spellcheck: "false" });
  const password = h("input", { class: "input", type: "password", autocomplete: "current-password", required: true });
  const error = h("div", { class: `form-error${message ? "" : " hidden"}`, role: "alert" }, message || "");
  const submit = h("button", { class: "btn btn-primary btn-large", type: "submit" }, "Log in");
  const form = h(
    "form",
    { class: "auth-card", novalidate: true },
    h("header", null, h("img", { src: "/shared/branch-mark.svg", alt: "", width: "56", height: "56" }), h("h1", null, "Branch Admin"), h("p", { class: "muted" }, "only for the Branch admin.")),
    field("login-username", "Username", username),
    field("login-password", "Password", password),
    error,
    submit,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.classList.add("hidden");
    submit.disabled = true;
    try {
      me = await api("/api/admin/login", { method: "POST", body: { username: username.value, password: password.value } });
      password.value = "";
      if (me.must_change_password) renderPasswordChange(true);
      else start();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove("hidden");
      password.select();
    } finally {
      submit.disabled = false;
    }
  });
  app.replaceChildren(h("main", { class: "auth" }, form));
  username.focus();
}

function passwordForm(onDone) {
  const current = h("input", { class: "input", type: "password", autocomplete: "current-password" });
  const next = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const again = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Change password");
  const form = h(
    "form",
    { class: "stack", novalidate: true },
    h("div", { dataset: { field: "current_password" }, class: "field" }, h("label", { for: "pw-current" }, "Current password"), Object.assign(current, { id: "pw-current" }), h("p", { class: "error hidden" })),
    h("div", { dataset: { field: "new_password" }, class: "field" }, h("label", { for: "pw-new" }, "New password"), Object.assign(next, { id: "pw-new" }), h("p", { class: "hint" }, "at least 12 characters. a few random words works well."), h("p", { class: "error hidden" })),
    h("div", { dataset: { field: "confirm" }, class: "field" }, h("label", { for: "pw-again" }, "New password again"), Object.assign(again, { id: "pw-again" }), h("p", { class: "error hidden" })),
    h("div", null, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (next.value !== again.value) { showFieldErrors(form, { confirm: "the two new passwords don't match" }); return; }
    submit.disabled = true;
    try {
      await api("/api/admin/password", { method: "POST", body: { current_password: current.value, new_password: next.value } });
      for (const input of [current, next, again]) input.value = "";
      showFieldErrors(form, {});
      toast("Password changed. other sessions were logged out.");
      onDone?.();
    } catch (err) {
      showFieldErrors(form, err.fields || { current_password: err.message });
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function renderPasswordChange(forced) {
  if (!forced) return;
  app.replaceChildren(
    h(
      "main",
      { class: "auth" },
      h(
        "div",
        { class: "auth-card" },
        h("header", null, h("h1", null, "Pick a new password"), h("p", { class: "muted" }, "the starting password only works once. choose your own before using the panel.")),
        passwordForm(() => { me.must_change_password = false; start(); }),
      ),
    ),
  );
}

const NAV = [
  ["mods", "Mods"],
  ["import", "Import"],
  ["reports", "Reports"],
  ["requests", "Requests"],
  ["forum", "Forum"],
  ["rewards", "Rewards"],
  ["categories", "Categories & tags"],
  ["activity", "Activity"],
  ["account", "Account"],
];

let overview = null;

async function start() {
  try {
    overview = await api("/api/admin/overview");
    meta = overview;
    categories = (await api("/api/admin/categories")).items;
  } catch {
    return;
  }
  if (!location.hash) location.hash = "#/mods";
  route();
}

function shell(active, content) {
  const nav = NAV.map(([key, text]) =>
    h("a", { href: `#/${key}`, "aria-current": active === key ? "page" : null }, text, key === "reports" && overview?.open_reports ? h("span", { class: "count", "aria-label": `${overview.open_reports} open` }, String(overview.open_reports)) : key === "requests" && overview?.open_requests ? h("span", { class: "count", "aria-label": `${overview.open_requests} open` }, String(overview.open_requests)) : key === "forum" && overview?.open_forum_reports ? h("span", { class: "count", "aria-label": `${overview.open_forum_reports} reported` }, String(overview.open_forum_reports)) : key === "rewards" && overview?.pending_rewards ? h("span", { class: "count", "aria-label": `${overview.pending_rewards} waiting` }, String(overview.pending_rewards)) : null),
  );
  app.replaceChildren(
    h(
      "div",
      { class: "layout" },
      h("nav", { class: "side", "aria-label": "Admin sections" }, h("div", { class: "brand" }, h("img", { src: "/shared/branch-mark.svg", alt: "", width: "24", height: "24" }), "Branch ", h("small", null, "admin")), nav, h("div", { class: "spacer" }), h("div", { class: "who" }, `logged in as ${me.username}`)),
      h("main", { class: "content", id: "content", tabindex: "-1" }, content),
    ),
  );
}

let lastHash = location.hash;
window.addEventListener("hashchange", async () => {
  if (dirty && !(await confirmDialog("Leave without saving?", "your changes to this mod haven't been saved.", "Leave", true))) {
    history.replaceState(null, "", lastHash);
    return;
  }
  dirty = false;
  route();
});

async function route() {
  lastHash = location.hash;
  if (!me) return;
  const [section, id] = location.hash.replace(/^#\//, "").split("/");
  try {
    if (section === "mods" && id) await renderEditor(id === "new" ? null : id);
    else if (section === "reports") await renderReports();
    else if (section === "requests") await renderRequests();
    else if (section === "import") await renderImport();
    else if (section === "forum") await renderForum();
    else if (section === "rewards") await renderRewardsAdmin();
    else if (section === "categories") await renderCategories();
    else if (section === "activity") await renderActivity();
    else if (section === "account") renderAccount();
    else await renderMods();
  } catch (err) {
    if (err.status === 401 || err.code === "password_change_required") return;
    shell(section, h("div", { class: "form-error", role: "alert" }, err.message, h("button", { class: "btn", type: "button", onclick: route }, "Try again")));
  }
}

async function refreshOverview() {
  try { overview = await api("/api/admin/overview"); } catch {}
}

let modsFilter = { q: "", status: "", source: "" };

async function renderMods() {
  const params = new URLSearchParams();
  if (modsFilter.q) params.set("q", modsFilter.q);
  if (modsFilter.status) params.set("status", modsFilter.status);
  if (modsFilter.source) params.set("source", modsFilter.source);
  const { items } = await api(`/api/admin/mods?${params}`);

  const search = h("input", { class: "input", type: "search", placeholder: "Search by name or author", value: modsFilter.q, "aria-label": "Search mods" });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { modsFilter.q = search.value.trim(); renderMods().then(() => document.querySelector(".toolbar-row input")?.focus()); }, 300); });
  const status = h("select", { class: "select", "aria-label": "Filter by status" }, [["", "All statuses"], ["published", "Published"], ["draft", "Drafts"], ["unpublished", "Unpublished"], ["archived", "Archived"]].map(([v, t]) => h("option", { value: v }, t)));
  status.value = modsFilter.status;
  status.addEventListener("change", () => { modsFilter.status = status.value; renderMods(); });
  const source = h("select", { class: "select", "aria-label": "Filter by who added it" }, [["", "Everyone"], ["community", "Community uploads"], ["admin", "Added by you"]].map(([v, t]) => h("option", { value: v }, t)));
  source.value = modsFilter.source;
  source.addEventListener("change", () => { modsFilter.source = source.value; renderMods(); });

  const quick = (label, cls, handler) => h("button", { class: `btn btn-quiet ${cls}`, type: "button", onclick: (e) => { e.stopPropagation(); handler(); } }, label);

  const rows = items.map((m) =>
    h(
      "tr",
      { class: "clickable", onclick: (e) => { if (!e.target.closest("a, button")) location.hash = `#/mods/${m.id}`; } },
      h("td", null, h("a", { href: `#/mods/${m.id}` }, m.name), m.featured ? h("span", { class: "needed" }, "featured") : null, h("div", { class: "muted small" }, m.author_name || "no author yet")),
      h("td", null, h("span", { class: `pill ${m.status}` }, m.status)),
      h("td", null, m.source === "community" ? h("span", { class: "pill community" }, "community") : h("span", { class: "muted small" }, "you")),
      h("td", null, m.category_name || h("span", { class: "muted" }, "none")),
      h("td", null, m.open_reports ? h("span", { class: "pill open" }, `${m.open_reports} open`) : h("span", { class: "muted" }, "0")),
      h("td", { class: "muted small" }, fmtDate(m.updated_at)),
      h(
        "td",
        { class: "row-actions" },
        m.status === "published"
          ? quick("Unpublish", "", async () => { await api(`/api/admin/mods/${m.id}/status`, { method: "POST", body: { status: "unpublished" } }); toast(`${m.name} unpublished`); await refreshOverview(); renderMods(); })
          : null,
        quick("Remove", "btn-danger", async () => {
          if (!(await confirmDialog(`Remove ${m.name} for good?`, "this deletes the listing, its releases, pictures and hosted files. it can't be undone. use Unpublish instead if you might want it back.", "Remove forever"))) return;
          await api(`/api/admin/mods/${m.id}`, { method: "DELETE" });
          toast(`${m.name} removed`);
          await refreshOverview();
          renderMods();
        }),
      ),
    ),
  );

  shell(
    "mods",
    [
      h("div", { class: "page-head" }, h("h1", null, "All mods"), h("a", { class: "btn btn-primary", href: "#/mods/new" }, "New mod")),
      h("p", { class: "muted" }, `${overview.published} published · ${overview.drafts} drafts · ${overview.hidden} hidden`),
      h("div", { class: "toolbar-row" }, search, status, source),
      items.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["Mod", "Status", "Added by", "Category", "Reports", "Updated", ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, rows)))
        : h("div", { class: "card" }, h("p", null, modsFilter.q || modsFilter.status || modsFilter.source ? "no mods match this search." : "no mods yet.")),
    ],
  );
}

const EMPTY_MOD = {
  name: "", slug: "", summary: "", description: "", author: { name: "", url: "" }, category: null, tags: [],
  compatibility: { status: "unconfirmed", note: "", checked_on: null }, game_versions: "", platforms: [], mod_loader: "",
  dependencies: [], install_instructions: "", known_issues: "", source_url: "", project_url: "", license: { name: "", url: "" },
  redistribution: "unknown", redistribution_note: "", status: "draft", featured: false, releases: [], screenshots: [], thumbnail_url: null,
};

function toForm(mod) {
  return {
    name: mod.name, slug: mod.slug, summary: mod.summary, description: mod.description,
    author_name: mod.author.name, author_url: mod.author.url || "", category_id: mod.category?.id || "",
    tags: mod.tags.join(", "), compatibility: mod.compatibility.status, compatibility_note: mod.compatibility.note,
    compatibility_checked_on: mod.compatibility.checked_on || "", game_versions: mod.game_versions, platforms: [...mod.platforms],
    mod_loader: mod.mod_loader, dependencies: (mod.dependencies || []).map((d) => ({ name: d.name, url: d.url || "", required: Boolean(d.required) })),
    install_instructions: mod.install_instructions, known_issues: mod.known_issues, source_url: mod.source_url || "", project_url: mod.project_url || "",
    license_name: mod.license.name, license_url: mod.license.url || "", redistribution: mod.redistribution, redistribution_note: mod.redistribution_note,
  };
}

function toPayload(form) {
  return {
    ...form,
    category_id: form.category_id || null,
    compatibility_checked_on: form.compatibility_checked_on || null,
    tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
    dependencies: form.dependencies.filter((d) => d.name.trim() || d.url.trim()),
  };
}

async function renderEditor(id) {
  let mod = id ? await api(`/api/admin/mods/${id}`) : structuredClone(EMPTY_MOD);
  const form = toForm(mod);
  dirty = false;

  const root = h("div");
  const unsaved = h("span", { class: "unsaved hidden" }, "unsaved changes");
  const markDirty = () => { dirty = true; unsaved.classList.remove("hidden"); };
  const formError = h("div", { class: "form-error hidden", role: "alert" });

  const text = (key, props = {}) => {
    const input = h("input", { class: "input", value: form[key] ?? "", ...props });
    input.addEventListener("input", () => { form[key] = input.value; markDirty(); });
    return input;
  };
  const area = (key, rows = 5, props = {}) => {
    const input = h("textarea", { class: "textarea", rows: String(rows), ...props });
    input.value = form[key] ?? "";
    input.addEventListener("input", () => { form[key] = input.value; markDirty(); });
    return input;
  };
  const select = (key, options) => {
    const input = h("select", { class: "select" }, options.map(([v, t]) => h("option", { value: v }, t)));
    input.value = form[key] ?? "";
    input.addEventListener("change", () => { form[key] = input.value; markDirty(); });
    return input;
  };
  const markdownArea = (key, rows) => {
    const input = area(key, rows);
    const preview = h("div", { class: "md-preview prose hidden" });
    const writeTab = h("button", { class: "btn btn-quiet", type: "button", "aria-pressed": "true" }, "Write");
    const previewTab = h("button", { class: "btn btn-quiet", type: "button", "aria-pressed": "false" }, "Preview");
    writeTab.addEventListener("click", () => { input.classList.remove("hidden"); preview.classList.add("hidden"); writeTab.setAttribute("aria-pressed", "true"); previewTab.setAttribute("aria-pressed", "false"); });
    previewTab.addEventListener("click", () => { preview.innerHTML = renderMarkdown(input.value) || "<p class='muted'>nothing yet.</p>"; input.classList.add("hidden"); preview.classList.remove("hidden"); writeTab.setAttribute("aria-pressed", "false"); previewTab.setAttribute("aria-pressed", "true"); });
    return { input, wrap: h("div", { class: "stack" }, h("div", { class: "md-tabs" }, writeTab, previewTab), input, preview) };
  };

  const description = markdownArea("description", 10);
  const basics = h(
    "section",
    { class: "card" },
    h("h2", null, "Basics"),
    h("p", { class: "card-intro" }, "fields marked * are needed to save. \"needed to publish\" fields can wait while it's a draft."),
    h(
      "div",
      { class: "grid-2" },
      field("name", "Name", text("name", { maxlength: "80" }), { required: true }),
      field("slug", "Link name", text("slug", { maxlength: "80", placeholder: "made from the name if empty" }), { hint: "lowercase letters, numbers and dashes. used in links." }),
      h("div", { class: "full" }, field("summary", "Short summary", text("summary", { maxlength: "200" }), { needed: true, hint: "one sentence shown in the list. up to 200 characters." })),
      field("author_name", "Author", text("author_name", { maxlength: "80" }), { needed: true }),
      field("author_url", "Author link", text("author_url", { type: "url", placeholder: "https://" })),
      field("category_id", "Category", select("category_id", [["", "Pick a category"], ...categories.map((c) => [c.id, c.name])]), { needed: true }),
      field("tags", "Tags", text("tags", { placeholder: "e.g. hats, client side" }), { hint: "separate with commas. up to 15." }),
      h("div", { class: "full" }, h("div", { class: "field", dataset: { field: "description" } }, h("label", { for: description.input.id || "description" }, "Full description"), description.wrap, h("p", { class: "hint" }, "markdown works: **bold**, lists, links. images and html are removed."), h("p", { class: "error hidden" }))),
    ),
  );
  description.input.id = "description";

  const platformChecks = h(
    "div",
    { class: "checks" },
    meta.platforms.map((p) => {
      const box = h("input", { type: "checkbox", value: p.key, checked: form.platforms.includes(p.key) });
      box.addEventListener("change", () => {
        form.platforms = box.checked ? [...form.platforms, p.key] : form.platforms.filter((x) => x !== p.key);
        markDirty();
      });
      return h("label", null, box, p.label);
    }),
  );
  const depsList = h("div", { class: "stack" });
  const drawDeps = () => {
    fill(depsList, 
      ...form.dependencies.map((dep, i) => {
        const name = h("input", { class: "input", value: dep.name, placeholder: "Name, e.g. BepInEx", "aria-label": `Requirement ${i + 1} name` });
        const url = h("input", { class: "input", value: dep.url, placeholder: "https://", "aria-label": `Requirement ${i + 1} link` });
        const req = h("input", { type: "checkbox", checked: dep.required });
        name.addEventListener("input", () => { dep.name = name.value; markDirty(); });
        url.addEventListener("input", () => { dep.url = url.value; markDirty(); });
        req.addEventListener("change", () => { dep.required = req.checked; markDirty(); });
        return h("div", { class: "dep-row" }, name, url, h("label", null, req, "required"), h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: () => { form.dependencies.splice(i, 1); markDirty(); drawDeps(); } }, "Remove"));
      }),
      h("div", null, h("button", { class: "btn", type: "button", onclick: () => { form.dependencies.push({ name: "", url: "", required: true }); markDirty(); drawDeps(); } }, "Add requirement")),
    );
  };
  drawDeps();
  const compat = h(
    "section",
    { class: "card" },
    h("h2", null, "Compatibility"),
    h("p", { class: "card-intro" }, "be honest here. people see exactly what each status means."),
    h(
      "div",
      { class: "grid-2" },
      field("compatibility", "Status", select("compatibility", meta.compatibility.map((c) => [c.key, c.label])), { required: true, hint: "\"Tested\" means you tried it yourself on the game version below." }),
      field("game_versions", "Game versions", text("game_versions", { maxlength: "120", placeholder: "e.g. 1.1.104" })),
      field("compatibility_checked_on", "Last checked on", text("compatibility_checked_on", { type: "date" })),
      field("mod_loader", "Mod loader", text("mod_loader", { maxlength: "80", placeholder: "e.g. BepInEx 5" })),
      h("div", { class: "full" }, field("compatibility_note", "Compatibility note", text("compatibility_note", { maxlength: "500" }), { hint: "shown next to the status, e.g. \"breaks the hand menu since the last update\"." })),
      h("div", { class: "full field", dataset: { field: "platforms" } }, h("span", { class: "field-label" }, "Platforms"), platformChecks, h("p", { class: "error hidden" })),
      h("div", { class: "full field", dataset: { field: "dependencies" } }, h("span", { class: "field-label" }, "Requirements"), depsList, h("p", { class: "error hidden" })),
    ),
  );

  const install = markdownArea("install_instructions", 6);
  install.input.id = "install_instructions";
  const issues = markdownArea("known_issues", 4);
  issues.input.id = "known_issues";
  const help = h(
    "section",
    { class: "card" },
    h("h2", null, "Install steps and known issues"),
    h(
      "div",
      { class: "stack" },
      h("div", { class: "field", dataset: { field: "install_instructions" } }, h("label", { for: "install_instructions" }, "How to install"), install.wrap, h("p", { class: "hint" }, "short numbered steps work best."), h("p", { class: "error hidden" })),
      h("div", { class: "field", dataset: { field: "known_issues" } }, h("label", { for: "known_issues" }, "Known issues"), issues.wrap, h("p", { class: "error hidden" })),
    ),
  );

  const redistribution = h(
    "div",
    { class: "radio-list", role: "radiogroup", "aria-label": "Redistribution permission" },
    [
      ["allowed", "Allowed", "the license or the author says copies can be shared. Branch can host the file."],
      ["not_allowed", "Not allowed", "only link to the author's own release."],
      ["unknown", "Don't know", "treated like \"not allowed\". credit alone isn't permission."],
    ].map(([value, title, explain]) => {
      const radio = h("input", { type: "radio", name: "redistribution", value, checked: form.redistribution === value });
      radio.addEventListener("change", () => { form.redistribution = value; markDirty(); });
      return h("label", null, radio, title, h("span", { class: "muted" }, explain));
    }),
  );
  const links = h(
    "section",
    { class: "card" },
    h("h2", null, "Links and license"),
    h(
      "div",
      { class: "grid-2" },
      h("div", null, field("source_url", "Source code", text("source_url", { type: "url", placeholder: "https://github.com/..." })), h("button", { class: "btn btn-quiet", type: "button", onclick: () => openSourceViewer(form.source_url) }, "View source in Branch")),
      field("project_url", "Original project page", text("project_url", { type: "url", placeholder: "https://" })),
      field("license_name", "License", text("license_name", { maxlength: "80", placeholder: "e.g. MIT, or unknown" }), { needed: true }),
      field("license_url", "License link", text("license_url", { type: "url", placeholder: "https://" })),
      h("div", { class: "full field", dataset: { field: "redistribution" } }, h("span", { class: "field-label" }, "Can Branch host a copy?", h("span", { class: "req" }, "*")), redistribution, h("p", { class: "error hidden" })),
      h("div", { class: "full" }, field("redistribution_note", "Permission note", text("redistribution_note", { maxlength: "500" }), { hint: "where the permission came from, e.g. \"MIT license\" or \"author said yes on discord, oct 2026\"." })),
    ),
  );

  const media = h("section", { class: "card" });
  const releases = h("section", { class: "card", dataset: { field: "releases" } });

  function drawMedia() {
    if (!mod.id) {
      fill(media, h("h2", null, "Pictures"), h("p", { class: "muted" }, "save the mod first, then you can add a thumbnail and screenshots."));
      return;
    }
    const thumbInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", "aria-label": "Thumbnail image" });
    const shotInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", "aria-label": "Screenshot image" });
    const shotCaption = h("input", { class: "input", placeholder: "Caption (optional)", maxlength: "200", "aria-label": "Screenshot caption" });
    const mediaError = h("div", { class: "form-error hidden", role: "alert" });

    const upload = async (url, input, extra = {}) => {
      if (!input.files[0]) { mediaError.textContent = "pick a file first."; mediaError.classList.remove("hidden"); return; }
      const data = new FormData();
      for (const [k, v] of Object.entries(extra)) data.append(k, v);
      data.append("file", input.files[0]);
      mediaError.classList.add("hidden");
      try {
        mod = await api(url, { method: "POST", form: data });
        toast("Uploaded");
        drawMedia();
      } catch (err) {
        mediaError.textContent = err.fields?.file || err.fields?.caption || err.message;
        mediaError.classList.remove("hidden");
      }
    };

    fill(media, 
      h("h2", null, "Pictures"),
      h("p", { class: "card-intro" }, "png, jpg, webp or gif up to 8 MB. Branch resizes them and removes hidden photo info."),
      h(
        "div",
        { class: "thumb-box" },
        mod.thumbnail_url ? h("img", { src: mod.thumbnail_url, alt: "current thumbnail" }) : h("div", { class: "thumb-placeholder" }, "no thumbnail"),
        h(
          "div",
          { class: "stack" },
          h("strong", null, "Thumbnail"),
          h("p", { class: "muted small" }, "16:9 looks best, like 1280 × 720."),
          thumbInput,
          h("div", { class: "upload-row" }, h("button", { class: "btn", type: "button", onclick: () => upload(`/api/admin/mods/${mod.id}/thumbnail`, thumbInput) }, mod.thumbnail_url ? "Replace thumbnail" : "Upload thumbnail"), mod.thumbnail_url ? h("button", { class: "btn btn-danger", type: "button", onclick: async () => { if (await confirmDialog("Remove the thumbnail?", "the image is deleted from storage.", "Remove")) { mod = await api(`/api/admin/mods/${mod.id}/thumbnail`, { method: "DELETE" }); drawMedia(); } } }, "Remove") : null),
        ),
      ),
      h("h3", { class: "small muted" }, `Screenshots (${mod.screenshots.length} of 12)`),
      h(
        "div",
        { class: "shots" },
        mod.screenshots.map((s, i) => {
          const caption = h("input", { class: "input", value: s.caption, maxlength: "200", "aria-label": `Screenshot ${i + 1} caption` });
          return h(
            "div",
            { class: "shot" },
            h("img", { src: s.url, alt: s.caption || `screenshot ${i + 1}` }),
            caption,
            h(
              "div",
              { class: "shot-actions" },
              h("button", { class: "btn", type: "button", onclick: async () => { mod = await api(`/api/admin/screenshots/${s.id}`, { method: "PUT", body: { caption: caption.value, sort_order: s.sort_order } }); toast("Caption saved"); } }, "Save caption"),
              h("button", { class: "btn btn-danger", type: "button", onclick: async () => { if (await confirmDialog("Delete this screenshot?", "it's removed from the mod and from storage.", "Delete")) { mod = await api(`/api/admin/screenshots/${s.id}`, { method: "DELETE" }); drawMedia(); } } }, "Delete"),
            ),
          );
        }),
      ),
      mod.screenshots.length < 12 ? h("div", { class: "upload-row" }, shotInput, shotCaption, h("button", { class: "btn", type: "button", onclick: () => upload(`/api/admin/mods/${mod.id}/screenshots`, shotInput, { caption: shotCaption.value }) }, "Add screenshot")) : null,
      mediaError,
    );
  }

  function releaseForm(existing, onDone) {
    const r = existing
      ? { version: existing.version, released_on: existing.released_on, changelog: existing.changelog, game_version: existing.game_version, download_kind: existing.kind, external_url: existing.external_url || "" }
      : { version: "", released_on: new Date().toISOString().slice(0, 10), changelog: "", game_version: "", download_kind: form.redistribution === "allowed" ? "hosted" : "external", external_url: "" };
    const bind = (key, el) => { el.value = r[key] ?? ""; el.addEventListener("input", () => { r[key] = el.value; }); el.addEventListener("change", () => { r[key] = el.value; }); return el; };
    const kind = bind("download_kind", h("select", { class: "select" }, h("option", { value: "external" }, "Link to the author's release"), h("option", { value: "hosted" }, "Hosted on Branch (needs permission)")));
    const urlField = field(`rel-url-${existing?.id || "new"}`, "Release link", bind("external_url", h("input", { class: "input", type: "url", placeholder: "https://github.com/author/mod/releases/tag/v1.0.0" })));
    urlField.dataset.field = "external_url";
    const syncKind = () => urlField.classList.toggle("hidden", kind.value !== "external");
    kind.addEventListener("change", syncKind);
    syncKind();
    const error = h("div", { class: "form-error hidden", role: "alert" });
    const box = h(
      "form",
      { class: "release-form", novalidate: true },
      h(
        "div",
        { class: "grid-2" },
        field(`rel-version-${existing?.id || "new"}`, "Version", bind("version", h("input", { class: "input", maxlength: "40", placeholder: "1.0.0" })), { required: true, name: "version" }),
        field(`rel-date-${existing?.id || "new"}`, "Release date", bind("released_on", h("input", { class: "input", type: "date" })), { required: true, name: "released_on" }),
        field(`rel-game-${existing?.id || "new"}`, "Game version", bind("game_version", h("input", { class: "input", maxlength: "60" })), { name: "game_version" }),
        field(`rel-kind-${existing?.id || "new"}`, "How people get it", kind, { required: true, name: "download_kind" }),
        h("div", { class: "full" }, urlField),
        h("div", { class: "full" }, field(`rel-log-${existing?.id || "new"}`, "Changelog", bind("changelog", h("textarea", { class: "textarea", rows: "4" })), { hint: "markdown works.", name: "changelog" })),
      ),
      error,
      h("div", { class: "release-actions" }, h("button", { class: "btn btn-primary", type: "submit" }, existing ? "Save release" : "Add release"), h("button", { class: "btn", type: "button", onclick: () => onDone(false) }, "Cancel")),
    );
    box.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.classList.add("hidden");
      try {
        const body = { ...r, released_on: r.released_on || null };
        if (existing) await api(`/api/admin/releases/${existing.id}`, { method: "PUT", body });
        else await api(`/api/admin/mods/${mod.id}/releases`, { method: "POST", body });
        toast(existing ? "Release saved" : "Release added");
        onDone(true);
      } catch (err) {
        const left = showFieldErrors(box, err.fields);
        if (!err.fields || left.length) { error.textContent = left[0] || err.message; error.classList.remove("hidden"); }
      }
    });
    return box;
  }

  async function reloadMod() {
    mod = await api(`/api/admin/mods/${mod.id}`);
    drawReleases();
    drawBar();
  }

  function drawReleases(openForm = false) {
    if (!mod.id) {
      fill(releases, h("h2", null, "Releases and downloads"), h("p", { class: "muted" }, "save the mod first, then add a release."));
      return;
    }
    const releaseError = h("p", { class: "error hidden" });
    const list = mod.releases.map((rel) => {
      const fileInput = h("input", { type: "file", accept: ".dll,.zip", "aria-label": `File for ${rel.version}` });
      const row = h("div", { class: "release" });
      const draw = () =>
        fill(row, 
          h(
            "div",
            { class: "release-head" },
            h("strong", null, rel.version),
            h("span", { class: "muted" }, fmtDate(rel.released_on)),
            h("span", { class: "pill" }, rel.kind === "hosted" ? "hosted on Branch" : "author link"),
            rel.disabled ? h("span", { class: "pill open" }, "download off") : rel.available ? h("span", { class: "pill published" }, "working") : h("span", { class: "pill draft" }, rel.kind === "hosted" ? "no file yet" : "no link"),
          ),
          rel.disabled ? h("p", { class: "small" }, `reason shown to people: ${rel.disabled_reason}`) : null,
          rel.kind === "external" && rel.external_url ? h("p", { class: "small code" }, rel.external_url) : null,
          rel.file ? h("p", { class: "small" }, `${rel.file.name} · ${fmtBytes(rel.file.size)} · `, h("span", { class: "code" }, `sha256 ${rel.file.sha256}`)) : null,
          rel.kind === "hosted"
            ? h(
                "div",
                { class: "upload-row" },
                fileInput,
                h("button", { class: "btn", type: "button", onclick: async () => {
                  if (!fileInput.files[0]) { toast("pick a .dll or .zip first", "error"); return; }
                  const data = new FormData();
                  data.append("file", fileInput.files[0]);
                  try { await api(`/api/admin/releases/${rel.id}/file`, { method: "POST", form: data }); toast("File uploaded"); await reloadMod(); }
                  catch (err) { toast(err.fields?.file || err.message, "error"); }
                } }, rel.file ? "Replace file" : "Upload file"),
                rel.file ? h("button", { class: "btn btn-danger", type: "button", onclick: async () => { if (await confirmDialog("Remove the hosted file?", "people won't be able to download this version until you upload a new file.", "Remove file")) { await api(`/api/admin/releases/${rel.id}/file`, { method: "DELETE" }); await reloadMod(); } } }, "Remove file") : null,
                h("span", { class: "muted small" }, ".dll or .zip, up to 50 MB"),
              )
            : null,
          h(
            "div",
            { class: "release-actions" },
            h("button", { class: "btn", type: "button", onclick: () => fill(row, releaseForm(rel, async (saved) => (saved ? reloadMod() : draw()))) }, "Edit"),
            rel.disabled
              ? h("button", { class: "btn", type: "button", onclick: async () => { await api(`/api/admin/releases/${rel.id}/availability`, { method: "POST", body: { disabled: false } }); toast("Download turned back on"); await reloadMod(); } }, "Turn download back on")
              : h("button", { class: "btn btn-danger", type: "button", onclick: async () => {
                  const reason = await promptDialog("Turn off this download?", "people will see the reason on the mod page. use this for broken or suspicious files.", "Reason", "Turn off download");
                  if (reason === null) return;
                  try { await api(`/api/admin/releases/${rel.id}/availability`, { method: "POST", body: { disabled: true, reason } }); toast("Download turned off"); await reloadMod(); }
                  catch (err) { toast(err.fields?.reason || err.message, "error"); }
                } }, "Turn off download"),
            h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { if (await confirmDialog(`Delete release ${rel.version}?`, "its changelog and any hosted file are deleted for good.", "Delete release")) { await api(`/api/admin/releases/${rel.id}`, { method: "DELETE" }); await reloadMod(); } } }, "Delete"),
          ),
        );
      draw();
      return row;
    });
    const addArea = h("div");
    const addButton = h("button", { class: "btn btn-primary", type: "button", onclick: () => { fill(addArea, releaseForm(null, async (saved) => { if (saved) await reloadMod(); else drawReleases(); })); addButton.remove(); } }, "Add release");
    fill(releases, 
      h("h2", null, "Releases and downloads", h("span", { class: "needed" }, "needed to publish")),
      h("p", { class: "card-intro" }, "the newest release is what the download button gives people. hosted files need redistribution set to \"allowed\"."),
      ...(list.length ? list : [h("p", { class: "muted" }, "no releases yet.")]),
      releaseError,
      addArea,
      addButton,
    );
    releaseError.classList.add("error");
    if (openForm) addButton.click();
  }

  const bar = h("div", { class: "editor-bar" });
  async function save() {
    formError.classList.add("hidden");
    try {
      const body = toPayload(form);
      if (mod.id) mod = await api(`/api/admin/mods/${mod.id}`, { method: "PUT", body });
      else {
        mod = await api("/api/admin/mods", { method: "POST", body });
        dirty = false;
        history.replaceState(null, "", `#/mods/${mod.id}`);
        lastHash = location.hash;
      }
      Object.assign(form, toForm(mod));
      dirty = false;
      unsaved.classList.add("hidden");
      showFieldErrors(root, {});
      toast("Saved");
      drawBar();
      drawMedia();
      drawReleases();
      return true;
    } catch (err) {
      handleFormError(err);
      return false;
    }
  }

  function handleFormError(err) {
    const left = showFieldErrors(root, err.fields);
    if (err.fields?.releases) {
      const relError = releases.querySelector(".error");
      if (relError) { relError.textContent = err.fields.releases; relError.classList.remove("hidden"); }
    }
    formError.textContent = err.fields ? `couldn't save yet: ${Object.values(err.fields).join(" · ")}` : err.message;
    formError.classList.remove("hidden");
    if (!err.fields || left.length) formError.scrollIntoView({ block: "center" });
  }

  async function setStatus(status) {
    if (dirty && !(await save())) return;
    try {
      mod = await api(`/api/admin/mods/${mod.id}/status`, { method: "POST", body: { status } });
      toast({ published: "Published", unpublished: "Unpublished", archived: "Archived", draft: "Moved to drafts" }[status]);
      drawBar();
      refreshOverview();
    } catch (err) {
      handleFormError(err);
    }
  }

  function drawBar() {
    const isNew = !mod.id;
    fill(bar, 
      h("a", { class: "btn btn-quiet", href: "#/mods" }, "← Mods"),
      h("span", { class: `pill ${mod.status}` }, isNew ? "new" : mod.status),
      unsaved,
      h("span", { class: "grow" }),
      isNew ? null : h("button", { class: "btn", type: "button", onclick: () => openPreview(mod, form) }, "Preview"),
      h("button", { class: "btn", type: "button", onclick: save }, isNew ? "Save draft" : "Save"),
      isNew
        ? null
        : mod.status === "published"
          ? h("button", { class: "btn", type: "button", onclick: () => setStatus("unpublished") }, "Unpublish")
          : h("button", { class: "btn btn-primary", type: "button", onclick: () => setStatus("published") }, "Publish"),
      isNew || mod.status === "archived" ? null : h("button", { class: "btn btn-quiet", type: "button", onclick: async () => { if (await confirmDialog("Archive this mod?", "it disappears from the app but stays here. you can publish it again later.", "Archive", false)) setStatus("archived"); } }, "Archive"),
      isNew ? null : h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => {
        if (!(await confirmDialog(`Delete ${mod.name} for good?`, "this deletes the listing, its releases, pictures and hosted files. reports keep the mod's name. this can't be undone. archive it instead if you might want it back.", "Delete forever"))) return;
        await api(`/api/admin/mods/${mod.id}`, { method: "DELETE" });
        dirty = false;
        toast("Deleted");
        refreshOverview();
        location.hash = "#/mods";
      } }, "Delete"),
    );
  }

  drawBar();
  drawMedia();
  drawReleases();
  root.append(
    bar,
    h("div", { class: "page-head" }, h("h1", null, mod.id ? mod.name : "New mod"), mod.open_reports ? h("a", { class: "pill open", href: "#/reports" }, `${mod.open_reports} open report${mod.open_reports === 1 ? "" : "s"}`) : null),
    formError,
    mod.import_info
      ? h(
          "div",
          { class: "notice-box" },
          mod.community ? `community upload (${mod.import_info.file_name}). safety check score: ${mod.import_info.scan_score}/100` : `imported from ${mod.import_info.file_name}. basic malware scan: ${mod.import_info.scan_score}/100`,
          mod.import_info.signals?.length ? ` (${mod.import_info.signals.join("; ")})` : " (nothing suspicious found)",
          mod.community ? ". it went live automatically. remove or unpublish it if anything looks wrong." : ". fill in the details below, check the license, then publish.",
        )
      : null,
    basics,
    compat,
    help,
    links,
    media,
    releases,
  );
  shell("mods", root);
}

function openPreview(mod, form) {
  const p = toPayload(form);
  const latest = mod.releases[0];
  const compatInfo = meta.compatibility.find((c) => c.key === p.compatibility);
  const section = (title, md) => (md ? h("section", null, h("h3", null, title), h("div", { class: "prose", html: renderMarkdown(md) })) : null);
  const dialog = h(
    "dialog",
    { class: "sheet preview" },
    h(
      "div",
      { class: "sheet-body" },
      h("p", { class: "notice-box" }, "preview of how the app shows this mod, with your unsaved edits. pictures and releases are the saved ones."),
      h(
        "div",
        { class: "preview-head" },
        mod.thumbnail_url ? h("img", { src: mod.thumbnail_url, alt: "" }) : h("div", { class: "thumb-placeholder" }, "no thumbnail"),
        h(
          "div",
          { class: "stack" },
          h("h2", null, p.name || "untitled"),
          h("p", { class: "muted" }, `by ${p.author_name || "unknown author"}`),
          p.summary ? h("p", null, p.summary) : null,
          h("p", null, h("span", { class: `badge ${p.compatibility}` }, compatInfo?.label || p.compatibility), " ", h("span", { class: "muted small" }, compatInfo?.description || "")),
          latest ? h("p", { class: "small" }, `download: ${latest.version} · ${latest.kind === "hosted" ? (latest.file ? `${latest.file.name}, ${fmtBytes(latest.file.size)}` : "no file uploaded") : `opens ${latest.external_host || "the author's page"}`}${latest.available ? "" : " · not available"}`) : h("p", { class: "small muted" }, "no release yet"),
        ),
      ),
      h(
        "div",
        { class: "preview-sections" },
        section("About this mod", p.description),
        section("How to install", p.install_instructions),
        section("Known issues", p.known_issues),
        h(
          "dl",
          { class: "facts" },
          [["Game versions", p.game_versions], ["Platforms", p.platforms.map((k) => label(meta.platforms, k)).join(", ")], ["Mod loader", p.mod_loader], ["License", p.license_name], ["Tags", p.tags.join(", ")], ["Requirements", p.dependencies.map((d) => `${d.name}${d.required ? "" : " (optional)"}`).join(", ")]]
            .filter(([, v]) => v)
            .map(([k, v]) => [h("dt", null, k), h("dd", null, v)]),
        ),
      ),
    ),
    h("div", { class: "sheet-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => dialog.close() }, "Close preview")),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let reportFilter = "open";

async function renderReports() {
  const { items } = await api(`/api/admin/reports${reportFilter ? `?status=${reportFilter}` : ""}`);
  const filter = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Report status" }, [["open", "Open"], ["resolved", "Resolved"], ["dismissed", "Dismissed"], ["", "All"]].map(([v, t]) => {
    const radio = h("input", { type: "radio", name: "report-filter", value: v, checked: reportFilter === v });
    radio.addEventListener("change", () => { reportFilter = v; renderReports(); });
    return h("label", null, radio, h("span", null, t));
  }));

  const cards = items.map((r) => {
    const note = h("textarea", { class: "textarea", rows: "2", maxlength: "2000", "aria-label": "Private admin note" });
    note.value = r.admin_note;
    const update = async (status) => {
      await api(`/api/admin/reports/${r.id}`, { method: "PUT", body: { status, admin_note: note.value } });
      toast(status === "open" ? "Reopened" : status === "resolved" ? "Marked resolved" : "Dismissed");
      await refreshOverview();
      renderReports();
    };
    return h(
      "article",
      { class: "card report" },
      h(
        "div",
        { class: "report-head" },
        h("h2", null, r.mod_id ? h("a", { href: `#/mods/${r.mod_id}` }, r.mod_name) : `${r.mod_name} (deleted)`),
        h("span", { class: `pill ${r.reason === "harmful" || r.reason === "copyright" ? "open" : ""}` }, label(meta.report_reasons, r.reason)),
        h("span", { class: `pill ${r.status}` }, r.status),
        h("span", { class: "muted small" }, fmtTime(r.created_at)),
      ),
      r.details ? h("p", { class: "report-body" }, r.details) : h("p", { class: "muted" }, "no details given."),
      r.contact ? h("p", { class: "small" }, "contact: ", h("span", { class: "code" }, r.contact)) : h("p", { class: "muted small" }, "no contact info."),
      r.resolved_by ? h("p", { class: "muted small" }, `${r.status} by ${r.resolved_by} on ${fmtTime(r.resolved_at)}`) : null,
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Private note"), note),
      h(
        "div",
        { class: "report-actions" },
        r.status === "open" ? h("button", { class: "btn btn-primary", type: "button", onclick: () => update("resolved") }, "Mark resolved") : h("button", { class: "btn", type: "button", onclick: () => update("open") }, "Reopen"),
        r.status === "open" ? h("button", { class: "btn", type: "button", onclick: () => update("dismissed") }, "Dismiss") : h("button", { class: "btn", type: "button", onclick: () => update(r.status) }, "Save note"),
        r.mod_id ? h("a", { class: "btn btn-quiet", href: `#/mods/${r.mod_id}` }, "Open mod (turn off downloads, edit, remove)") : null,
        h("span", { class: "grow" }),
        h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { if (await confirmDialog("Delete this report?", "it's removed for good, including any contact info.", "Delete report")) { await api(`/api/admin/reports/${r.id}`, { method: "DELETE" }); await refreshOverview(); renderReports(); } } }, "Delete"),
      ),
    );
  });

  shell("reports", [
    h("div", { class: "page-head" }, h("h1", null, "Reports"), filter),
    h("p", { class: "muted", style: null }, "reports are private. closed reports are deleted automatically 180 days after they're resolved or dismissed."),
    h("div", { class: "stack" }, cards.length ? cards : h("div", { class: "card" }, h("p", null, reportFilter === "open" ? "no open reports. nice." : "nothing here."))),
  ]);
}

async function renderCategories() {
  categories = (await api("/api/admin/categories")).items;
  const tags = (await api("/api/admin/tags")).items;

  const categoryForm = (cat) => {
    const values = { name: cat?.name || "", slug: cat?.slug || "", description: cat?.description || "", sort_order: cat?.sort_order ?? categories.length + 1 };
    const input = (key, props) => { const el = h("input", { class: "input", value: values[key], ...props }); el.addEventListener("input", () => { values[key] = props.type === "number" ? Number(el.value) : el.value; }); return el; };
    const form = h(
      "form",
      { class: "release-form", novalidate: true },
      h("div", { class: "grid-2" }, field(`cat-name-${cat?.id || "new"}`, "Name", input("name", { maxlength: "40" }), { required: true, name: "name" }), field(`cat-slug-${cat?.id || "new"}`, "Link name", input("slug", { maxlength: "80" }), { name: "slug" }), field(`cat-desc-${cat?.id || "new"}`, "Description", input("description", { maxlength: "300" }), { name: "description" }), field(`cat-order-${cat?.id || "new"}`, "Order", input("sort_order", { type: "number", min: "0" }))),
      h("div", { class: "release-actions" }, h("button", { class: "btn btn-primary", type: "submit" }, cat ? "Save category" : "Add category"), cat ? h("button", { class: "btn", type: "button", onclick: renderCategories }, "Cancel") : null),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        if (cat) await api(`/api/admin/categories/${cat.id}`, { method: "PUT", body: values });
        else await api("/api/admin/categories", { method: "POST", body: values });
        toast("Saved");
        renderCategories();
      } catch (err) {
        showFieldErrors(form, err.fields || { name: err.message });
      }
    });
    return form;
  };

  const catRows = categories.map((c) => {
    const row = h("tr");
    row.append(
      h("td", null, h("strong", null, c.name), h("div", { class: "muted small" }, c.slug)),
      h("td", { class: "muted" }, c.description || ""),
      h("td", null, String(c.mod_count)),
      h(
        "td",
        null,
        h("button", { class: "btn btn-quiet", type: "button", onclick: () => fill(row, h("td", { colspan: "4" }, categoryForm(c))) }, "Edit"),
        h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => {
          if (!(await confirmDialog(`Delete ${c.name}?`, "mods in it will have no category. published mods have to be moved first.", "Delete category"))) return;
          try { await api(`/api/admin/categories/${c.id}`, { method: "DELETE" }); renderCategories(); } catch (err) { toast(err.message, "error"); }
        } }, "Delete"),
      ),
    );
    return row;
  });

  const tagRows = tags.map((t) => {
    const name = h("input", { class: "input", value: t.name, maxlength: "32", "aria-label": `Rename tag ${t.name}` });
    return h(
      "tr",
      null,
      h("td", null, name),
      h("td", null, String(t.mod_count)),
      h(
        "td",
        null,
        h("button", { class: "btn btn-quiet", type: "button", onclick: async () => { try { await api(`/api/admin/tags/${t.id}`, { method: "PUT", body: { name: name.value } }); toast("Tag renamed"); } catch (err) { toast(err.fields?.name || err.message, "error"); } } }, "Rename"),
        h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { if (await confirmDialog(`Delete the tag "${t.name}"?`, "it's removed from every mod that uses it.", "Delete tag")) { await api(`/api/admin/tags/${t.id}`, { method: "DELETE" }); renderCategories(); } } }, "Delete"),
      ),
    );
  });

  shell("categories", [
    h("div", { class: "page-head" }, h("h1", null, "Categories & tags")),
    h("section", { class: "card" }, h("h2", null, "Categories"), h("p", { class: "card-intro" }, "these show in the app's sidebar and filters."), h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["Category", "Description", "Mods", ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, catRows)))),
    h("section", { class: "card" }, h("h2", null, "Add a category"), categoryForm(null)),
    h("section", { class: "card" }, h("h2", null, "Tags"), h("p", { class: "card-intro" }, "tags are added from the mod editor. rename or clean them up here."), tags.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["Tag", "Mods", ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, tagRows))) : h("p", { class: "muted" }, "no tags yet.")),
  ]);
}

let requestFilter = "open";

async function renderRequests() {
  const { items } = await api(`/api/admin/requests${requestFilter ? `?status=${requestFilter}` : ""}`);
  const filter = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Request status" }, [["open", "Open"], ["accepted", "Accepted"], ["denied", "Denied"], ["", "All"]].map(([v, t]) => {
    const radio = h("input", { type: "radio", name: "request-filter", value: v, checked: requestFilter === v });
    radio.addEventListener("change", () => { requestFilter = v; renderRequests(); });
    return h("label", null, radio, h("span", null, t));
  }));

  const cards = items.map((r) => {
    const note = h("textarea", { class: "textarea", rows: "2", maxlength: "2000", "aria-label": "Private admin note" });
    note.value = r.admin_note;
    const decide = async (status) => {
      await api(`/api/admin/requests/${r.id}`, { method: "PUT", body: { status, admin_note: note.value } });
      toast(status === "denied" ? "Request denied" : status === "open" ? "Reopened" : "Saved");
      await refreshOverview();
      renderRequests();
    };
    const github = parseGithub(r.url);
    return h(
      "article",
      { class: "card report" },
      h("div", { class: "report-head" }, h("h2", null, r.mod_name), h("span", { class: `pill ${r.status === "accepted" ? "resolved" : r.status === "denied" ? "dismissed" : "open"}` }, r.status), h("span", { class: "muted small" }, fmtTime(r.created_at))),
      h("p", { class: "small code" }, r.url),
      r.author ? h("p", { class: "small" }, `made by ${r.author}`) : null,
      r.details ? h("p", { class: "report-body" }, r.details) : h("p", { class: "muted" }, "no details given."),
      r.contact ? h("p", { class: "small" }, "contact: ", h("span", { class: "code" }, r.contact)) : null,
      r.decided_by ? h("p", { class: "muted small" }, `${r.status} by ${r.decided_by} on ${fmtTime(r.decided_at)}`) : null,
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Private note"), note),
      h(
        "div",
        { class: "report-actions" },
        github ? h("button", { class: "btn", type: "button", onclick: () => openSourceViewer(r.url) }, "View source code") : null,
        h("a", { class: "btn btn-quiet", href: r.url, target: "_blank", rel: "noopener noreferrer" }, "Open link"),
        r.created_mod_id
          ? h("a", { class: "btn btn-primary", href: `#/mods/${r.created_mod_id}` }, "Open the draft")
          : h("button", { class: "btn btn-primary", type: "button", onclick: async () => {
              const { mod_id } = await api(`/api/admin/requests/${r.id}/draft`, { method: "POST", body: {} });
              toast("Accepted. a draft was created.");
              await refreshOverview();
              location.hash = `#/mods/${mod_id}`;
            } }, "Accept and create draft"),
        r.status !== "denied" ? h("button", { class: "btn btn-danger", type: "button", onclick: () => decide("denied") }, "Deny") : h("button", { class: "btn", type: "button", onclick: () => decide("open") }, "Reopen"),
        h("button", { class: "btn btn-quiet", type: "button", onclick: () => decide(r.status) }, "Save note"),
        h("span", { class: "grow" }),
        h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { if (await confirmDialog("Delete this request?", "it's removed for good, including any contact info.", "Delete request")) { await api(`/api/admin/requests/${r.id}`, { method: "DELETE" }); await refreshOverview(); renderRequests(); } } }, "Delete"),
      ),
    );
  });

  shell("requests", [
    h("div", { class: "page-head" }, h("h1", null, "Mod requests"), filter),
    h("p", { class: "muted" }, "mods people asked for in the app. accepting one creates a draft listing for you to finish. remember: only host a copy when the license allows it."),
    h("div", { class: "stack" }, cards.length ? cards : h("div", { class: "card" }, h("p", null, requestFilter === "open" ? "no open requests." : "nothing here."))),
  ]);
}

async function renderActivity() {
  const { items } = await api("/api/admin/audit");
  shell("activity", [
    h("div", { class: "page-head" }, h("h1", null, "Activity")),
    h("p", { class: "muted" }, "the last 300 admin actions."),
    h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["When", "Who", "What", "On", "Details"].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, items.map((a) => h("tr", null, h("td", { class: "muted small" }, fmtTime(a.created_at)), h("td", null, a.admin_username), h("td", null, a.action.replaceAll("_", " ")), h("td", null, a.target), h("td", { class: "small code" }, a.details)))))),
  ]);
}

function renderAccount() {
  shell("account", [
    h("div", { class: "page-head" }, h("h1", null, "Account")),
    h("section", { class: "card" }, h("h2", null, "Change password"), h("p", { class: "card-intro" }, "changing it logs out your other sessions."), passwordForm()),
    h("section", { class: "card" }, h("h2", null, "Log out"), h("p", { class: "card-intro" }, "sessions also end on their own after 2 hours of no activity, or 12 hours total."), h("button", { class: "btn", type: "button", onclick: async () => { await api("/api/admin/logout", { method: "POST" }); me = null; dirty = false; renderLogin("you're logged out."); } }, "Log out")),
  ]);
}

(async () => {
  try {
    me = await api("/api/admin/me");
    if (me.must_change_password) renderPasswordChange(true);
    else start();
  } catch (err) {
    if (err.status !== 401 && err.code !== "password_change_required") renderLogin(err.status === 0 ? err.message : "");
  }
})();

async function renderImport() {
  const filesInput = h("input", { type: "file", multiple: true, accept: ".dll,.zip", class: "hidden", id: "import-files" });
  const folderInput = h("input", { type: "file", multiple: true, webkitdirectory: true, class: "hidden", id: "import-folder" });
  const split = h("input", { type: "checkbox", checked: true, id: "import-split" });
  const queue = h("ul", { class: "import-queue", role: "list" });
  const listArea = h("div");

  async function drawImported() {
    const { items } = await api("/api/admin/mods?imported=true&status=draft");
    listArea.replaceChildren(
      h("h2", { class: "import-heading" }, `Imported drafts waiting to be filled in (${items.length})`),
      items.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "table" },
              h("thead", null, h("tr", null, ["Mod", "File", "Basic scan", "Imported", ""].map((t) => h("th", { scope: "col" }, t)))),
              h(
                "tbody",
                null,
                items.map((m) =>
                  h(
                    "tr",
                    { class: "clickable", onclick: (e) => { if (!e.target.closest("a")) location.hash = `#/mods/${m.id}`; } },
                    h("td", null, h("a", { href: `#/mods/${m.id}` }, m.name)),
                    h("td", { class: "small code" }, m.import_info?.file_name || ""),
                    h("td", null, h("span", { class: `pill ${(m.import_info?.scan_score ?? 0) > 45 ? "open" : (m.import_info?.scan_score ?? 0) > 20 ? "draft" : "published"}` }, `${m.import_info?.scan_score ?? "?"}/100`)),
                    h("td", { class: "muted small" }, fmtDate(m.imported_at)),
                    h("td", null, h("a", { class: "btn", href: `#/mods/${m.id}` }, "Fill in")),
                  ),
                ),
              ),
            ),
          )
        : h("div", { class: "card" }, h("p", { class: "muted" }, "nothing waiting. imported mods show up here until you publish them.")),
    );
  }

  async function run(files) {
    const mods = [...files].filter((f) => /\.(dll|zip)$/i.test(f.name));
    if (!mods.length) {
      toast("no .dll or .zip files were found", "error");
      return;
    }
    queue.replaceChildren();
    let created = 0;
    for (const file of mods) {
      const status = h("span", { class: "muted small" }, "waiting");
      queue.append(h("li", null, h("span", { class: "code small" }, file.webkitRelativePath || file.name), status));
    }
    const rows = [...queue.children];
    for (let i = 0; i < mods.length; i++) {
      const status = rows[i].lastChild;
      status.textContent = "uploading…";
      const data = new FormData();
      data.append("split", split.checked ? "true" : "false");
      data.append("file", mods[i]);
      try {
        const result = await api("/api/admin/import", { method: "POST", form: data });
        created += result.imported.length;
        const bits = [];
        if (result.imported.length) bits.push(`added ${result.imported.length} draft${result.imported.length === 1 ? "" : "s"}`);
        if (result.failed.length) bits.push(`${result.failed.length} skipped: ${result.failed.map((f) => `${f.file_name} (${f.error})`).join(", ")}`);
        status.textContent = bits.join(" · ") || "nothing to import";
        status.className = result.failed.length ? "small warn-text" : "small ok-text";
      } catch (err) {
        status.textContent = err.message;
        status.className = "small error";
      }
    }
    toast(`Imported ${created} mod${created === 1 ? "" : "s"}`);
    filesInput.value = "";
    folderInput.value = "";
    await drawImported();
  }

  filesInput.addEventListener("change", () => run(filesInput.files));
  folderInput.addEventListener("change", () => run(folderInput.files));

  shell("import", [
    h("div", { class: "page-head" }, h("h1", null, "Import mods")),
    h(
      "section",
      { class: "card" },
      h("p", { class: "card-intro" }, "each .dll or .zip becomes a private draft with its file attached and a basic malware scan. nothing goes public until you open it, fill it in and press publish."),
      h(
        "div",
        { class: "upload-row" },
        h("button", { class: "btn btn-primary", type: "button", onclick: () => filesInput.click() }, "Choose files"),
        h("button", { class: "btn", type: "button", onclick: () => folderInput.click() }, "Choose a folder"),
        filesInput,
        folderInput,
      ),
      h("label", { class: "checks import-split", for: "import-split" }, split, "a zip full of mods: make each .dll or .zip inside it its own draft"),
      queue,
    ),
    listArea,
  ]);
  await drawImported();
}

async function renderForum() {
  const { reports, posts, chat = [] } = await api("/api/admin/forum");
  const reload = async () => { await refreshOverview(); renderForum(); };
  const removeLabel = (p) => (p.removed ? "Restore" : "Remove");
  const removePost = async (kind, id, removed) => {
    const url = kind === "thread" ? `/api/admin/forum/threads/${id}` : `/api/admin/forum/replies/${id}`;
    await api(url, { method: "POST", body: { removed } });
    toast(removed ? "Post removed" : "Post restored");
    reload();
  };
  const ban = async (posterId, name, banned) => {
    if (banned && !(await confirmDialog(`Ban ${name}?`, "they won't be able to post anymore, and neither will anyone else on the same connection. their old posts stay until you remove them.", "Ban"))) return;
    await api(`/api/admin/forum/posters/${posterId}`, { method: "POST", body: { banned } });
    toast(banned ? `${name} banned` : `${name} unbanned`);
    reload();
  };
  const excerpt = (text) => (text.length > 280 ? `${text.slice(0, 280)}…` : text);

  const reportCards = reports.map((r) =>
    h(
      "article",
      { class: "card report" },
      h("div", { class: "report-head" }, h("h2", null, r.kind === "thread" ? "Thread" : "Reply", " in “", r.thread_title, "”"), h("span", { class: "pill open" }, "reported"), h("span", { class: "muted small" }, fmtTime(r.created_at))),
      h("p", { class: "small" }, h("strong", null, "reason: "), r.reason),
      h("p", { class: "report-body" }, excerpt(r.body)),
      h("p", { class: "muted small" }, `posted by ${r.poster_name}${r.poster_banned ? " (banned)" : ""}`),
      h(
        "div",
        { class: "report-actions" },
        h("button", { class: "btn btn-danger", type: "button", onclick: () => removePost(r.kind, r.post_id, !r.removed) }, removeLabel(r)),
        h("button", { class: "btn", type: "button", onclick: () => ban(r.poster_id, r.poster_name, !r.poster_banned) }, r.poster_banned ? "Unban" : "Ban poster"),
        h("button", { class: "btn btn-quiet", type: "button", onclick: async () => { await api(`/api/admin/forum/reports/${r.id}`, { method: "POST", body: {} }); toast("Report closed"); reload(); } }, "Close report (nothing wrong)"),
      ),
    ),
  );

  const rows = posts.map((p) =>
    h(
      "tr",
      null,
      h("td", null, h("span", { class: `pill ${p.removed ? "dismissed" : p.kind === "thread" ? "published" : ""}` }, p.removed ? "removed" : p.kind), p.pinned ? h("span", { class: "needed" }, "pinned") : null, p.locked ? h("span", { class: "needed" }, "locked") : null),
      h("td", null, h("strong", null, p.kind === "thread" ? p.thread_title : `re: ${p.thread_title}`), h("div", { class: "muted small forum-excerpt" }, excerpt(p.body))),
      h("td", null, p.poster_name, p.poster_banned ? h("span", { class: "pill open" }, "banned") : null),
      h("td", { class: "muted small" }, fmtTime(p.created_at)),
      h(
        "td",
        { class: "row-actions" },
        p.kind === "thread"
          ? [
              h("button", { class: "btn btn-quiet", type: "button", onclick: async () => { await api(`/api/admin/forum/threads/${p.id}`, { method: "POST", body: { pinned: !p.pinned } }); reload(); } }, p.pinned ? "Unpin" : "Pin"),
              h("button", { class: "btn btn-quiet", type: "button", onclick: async () => { await api(`/api/admin/forum/threads/${p.id}`, { method: "POST", body: { locked: !p.locked } }); reload(); } }, p.locked ? "Unlock" : "Lock"),
            ]
          : null,
        h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: () => removePost(p.kind, p.id, !p.removed) }, removeLabel(p)),
        h("button", { class: "btn btn-quiet", type: "button", onclick: () => ban(p.poster_id, p.poster_name, !p.poster_banned) }, p.poster_banned ? "Unban" : "Ban"),
      ),
    ),
  );

  shell("forum", [
    h("div", { class: "page-head" }, h("h1", null, "Community forum")),
    h("p", { class: "muted" }, "removed posts show as \"[removed by a moderator]\". banning someone also blocks new names from the same connection."),
    h("h2", { class: "import-heading" }, `Reported posts (${reports.length})`),
    h("div", { class: "stack" }, reportCards.length ? reportCards : h("div", { class: "card" }, h("p", { class: "muted" }, "nothing reported."))),
    h("h2", { class: "import-heading" }, `Chat (${chat.filter((m) => m.open_reports > 0).length} reported)`),
    chat.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", null, h("tr", null, ["Message", "By", "When", ""].map((t) => h("th", { scope: "col" }, t)))),
            h(
              "tbody",
              null,
              chat.map((m) =>
                h(
                  "tr",
                  null,
                  h("td", null, m.open_reports ? h("span", { class: "pill open" }, `reported: ${m.report_reasons || ""}`) : null, m.removed ? h("span", { class: "pill dismissed" }, "removed") : null, h("div", { class: "forum-excerpt" }, m.body)),
                  h("td", null, m.poster_name, m.poster_banned ? h("span", { class: "pill open" }, "banned") : null),
                  h("td", { class: "muted small" }, fmtTime(m.created_at)),
                  h(
                    "td",
                    { class: "row-actions" },
                    h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { await api(`/api/admin/chat/${m.id}`, { method: "POST", body: { removed: !m.removed } }); toast(m.removed ? "Message restored" : "Message removed"); reload(); } }, m.removed ? "Restore" : "Remove"),
                    h("button", { class: "btn btn-quiet", type: "button", onclick: () => ban(m.poster_id, m.poster_name, !m.poster_banned) }, m.poster_banned ? "Unban" : "Ban"),
                  ),
                ),
              ),
            ),
          ),
        )
      : h("div", { class: "card" }, h("p", { class: "muted" }, "no chat messages yet.")),    h("h2", { class: "import-heading" }, "Recent posts"),
    posts.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["Type", "Post", "By", "When", ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, rows)))
      : h("div", { class: "card" }, h("p", { class: "muted" }, "no posts yet.")),
  ]);
}

async function renderRewardsAdmin() {
  const { enabled, members, events } = await api("/api/admin/rewards");
  const reload = async () => { await refreshOverview(); renderRewardsAdmin(); };
  const pending = members.filter((m) => m.status === "pending");
  const accepted = members.filter((m) => m.status === "accepted");
  const others = members.filter((m) => m.status === "rejected" || m.status === "removed");
  const itemLink = (m) => h("a", { href: m.payout_item_url, target: "_blank", rel: "noopener noreferrer" }, "payout item ↗");
  const decide = async (m, status, label) => {
    await api(`/api/admin/rewards/members/${m.id}`, { method: "POST", body: { status } });
    toast(`${m.roblox_username} ${label}`);
    reload();
  };

  const toggle = h("input", { type: "checkbox", id: "rewards-enabled", checked: enabled });
  toggle.addEventListener("change", async () => {
    if (!toggle.checked && !(await confirmDialog("Turn off the rewards program?", "people can't apply or earn while it's off. what members are already owed stays listed here.", "Turn off", true))) {
      toggle.checked = true;
      return;
    }
    await api("/api/admin/rewards/settings", { method: "POST", body: { enabled: toggle.checked } });
    toast(toggle.checked ? "Rewards program is on" : "Rewards program is off");
    reload();
  });

  const applicationCards = pending.map((m) => {
    const review = m.ai_review || {};
    return h(
      "article",
      { class: "card report" },
      h("div", { class: "report-head" }, h("h2", null, m.roblox_username), h("span", { class: "pill open" }, "waiting for you"), h("span", { class: "muted small" }, `applied ${fmtTime(m.applied_at)}`)),
      h("p", { class: "small" }, `community name ${m.poster_name} · ${m.uploads} unique uploads · `, itemLink(m)),
      h(
        "div",
        { class: "notice-box" },
        h("strong", null, review.by === "ai" ? (review.approve ? "AI review: looks fine. " : "AI review: concerns. ") : "AI review unavailable. "),
        review.summary || "",
        review.reasons?.length ? h("ul", { class: "reasons-list" }, review.reasons.map((r) => h("li", null, r))) : null,
        review.flagged?.length ? h("p", { class: "small" }, `flagged uploads: ${review.flagged.length}`) : null,
      ),
      h(
        "div",
        { class: "report-actions" },
        h("button", { class: "btn btn-primary", type: "button", onclick: () => decide(m, "accepted", "accepted") }, "Accept into rewards"),
        h("button", { class: "btn btn-danger", type: "button", onclick: () => decide(m, "rejected", "rejected") }, "Reject"),
        h("a", { class: "btn btn-quiet", href: "#/mods", onclick: () => { modsFilter.source = "community"; } }, "See community uploads"),
      ),
    );
  });

  const memberRows = accepted.map((m) =>
    h(
      "tr",
      null,
      h("td", null, h("strong", null, m.roblox_username), h("div", { class: "muted small" }, m.poster_name)),
      h("td", null, itemLink(m)),
      h("td", null, `${m.earned} / 500 R$`),
      h("td", null, `${m.today} / 50`),
      h("td", null, m.owed ? h("span", { class: "pill draft" }, `${m.owed} R$ owed`) : h("span", { class: "muted" }, "0")),
      h("td", { class: "muted small" }, `${m.paid} R$`),
      h(
        "td",
        { class: "row-actions" },
        m.owed
          ? h("button", { class: "btn btn-primary", type: "button", onclick: async () => {
              if (!(await confirmDialog(`Mark ${m.owed} R$ as paid?`, `do this after you've bought ${m.roblox_username}'s item for ${m.owed} R$ (plus roblox's fee if you want them to receive the full amount).`, "Mark as paid", false))) return;
              await api(`/api/admin/rewards/members/${m.id}/paid`, { method: "POST", body: {} });
              toast(`${m.owed} R$ marked as paid`);
              reload();
            } }, "Mark paid")
          : null,
        h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { if (await confirmDialog(`Remove ${m.roblox_username} from rewards?`, "they won't earn anything new. what they're owed stays listed.", "Remove")) decide(m, "removed", "removed"); } }, "Remove"),
      ),
    ),
  );

  const eventRows = events.map((e) =>
    h(
      "tr",
      null,
      h("td", { class: "muted small" }, fmtTime(e.created_at)),
      h("td", null, h("strong", null, e.roblox_username)),
      h("td", null, e.mod_id ? h("a", { href: `#/mods/${e.mod_id}` }, e.mod_name) : `${e.mod_name} (removed)`),
      h("td", null, `+${e.amount} R$`),
      h("td", null, h("span", { class: `pill ${e.status === "paid" ? "resolved" : e.status === "void" ? "dismissed" : "draft"}` }, e.status)),
      h(
        "td",
        { class: "row-actions" },
        e.status === "void"
          ? h("button", { class: "btn btn-quiet", type: "button", onclick: async () => { await api(`/api/admin/rewards/events/${e.id}`, { method: "POST", body: { status: "owed" } }); reload(); } }, "Restore")
          : e.status === "owed"
            ? h("button", { class: "btn btn-quiet btn-danger", type: "button", onclick: async () => { await api(`/api/admin/rewards/events/${e.id}`, { method: "POST", body: { status: "void" } }); toast("Reward voided"); reload(); } }, "Void")
            : null,
      ),
    ),
  );

  const totalOwed = accepted.reduce((sum, m) => sum + Number(m.owed), 0);
  shell("rewards", [
    h("div", { class: "page-head" }, h("h1", null, "Rewards program"), h("label", { class: "switch", for: "rewards-enabled" }, toggle, h("span", null, enabled ? "On" : "Off"))),
    h("p", { class: "muted" }, `10 R$ per unique upload after acceptance, 50 R$ a day, 500 R$ total. ${totalOwed} R$ is waiting to be paid across ${accepted.length} member${accepted.length === 1 ? "" : "s"}.`),
    h("h2", { class: "import-heading" }, `Applications (${pending.length})`),
    h("div", { class: "stack" }, applicationCards.length ? applicationCards : h("div", { class: "card" }, h("p", { class: "muted" }, "no applications waiting."))),
    h("h2", { class: "import-heading" }, `Members (${accepted.length})`),
    accepted.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["Roblox user", "Item", "Earned", "Today", "Owed", "Paid", ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, memberRows)))
      : h("div", { class: "card" }, h("p", { class: "muted" }, "nobody has been accepted yet.")),
    h("h2", { class: "import-heading" }, "Every reward"),
    events.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, ["When", "Who", "Mod", "Amount", "Status", ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", null, eventRows)))
      : h("div", { class: "card" }, h("p", { class: "muted" }, "no rewards earned yet.")),
    others.length ? h("p", { class: "muted small" }, `${others.length} rejected or removed application(s) aren't shown.`) : null,
  ]);
}