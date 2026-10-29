// app shell: routing, sidebar, search box, theme and keyboard shortcuts.
import { h, clear, debounce } from "./dom.js";
import { icon, hydrateIcons } from "./icons.js";
import { api, initPlatform, openExternal, setNativeTheme, windowMaterial } from "./platform.js";
import { settings } from "./store.js";
import { toast } from "./ui.js";
import { createBrowseView } from "./views/browse.js";
import { createDetailView } from "./views/detail.js";
import { createSettingsView, createAboutView, createLegalView } from "./views/pages.js";

const root = document.documentElement;
const main = document.getElementById("main");
const viewHost = document.getElementById("view");
const search = document.getElementById("search");
const backButton = document.getElementById("back-button");
const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("sidebar-scrim");
const sidebarToggle = document.getElementById("sidebar-toggle");
const categoryNav = document.getElementById("category-nav");

const BROWSE_MODES = { browse: "all", featured: "featured", favorites: "favorites", recent: "recent" };

const ctx = {
  meta: null,
  browse: { mode: "all", q: "", category: "", compat: "", sort: "updated" },
  link(href, label) {
    return h("a", { class: "btn btn-primary", href }, label);
  },
  setTitle(text) {
    document.title = text ? `${text} · Branch` : "Branch";
  },
  setSearchText(text) {
    search.value = text;
  },
  // keeps the address in sync with the category so "back" returns to the same list
  syncBrowseHash() {
    const route = currentRoute;
    if (!route || route.name !== "browse") return;
    const base = route.path;
    const hash = ctx.browse.category ? `#${base}?category=${encodeURIComponent(ctx.browse.category)}` : `#${base}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    markSidebar();
  },
  applyTheme(theme) {
    settings.set({ theme });
    applyTheme(theme);
  },
  applyMotion(reduce) {
    settings.set({ reduceMotion: reduce });
    if (reduce) root.dataset.motion = "reduce";
    else delete root.dataset.motion;
  },
};

const views = {
  browse: createBrowseView(ctx),
  detail: createDetailView(ctx),
  settings: createSettingsView(ctx),
  about: createAboutView(ctx),
  legal: createLegalView(ctx),
};

let currentRoute = null;
let currentView = null;

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/browse";
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  const first = parts[0] || "browse";

  if (BROWSE_MODES[first]) return { name: "browse", path: `/${first}`, mode: BROWSE_MODES[first], category: params.get("category") || "" };
  if (first === "mod" && parts[1]) return { name: "detail", path, slug: decodeURIComponent(parts[1]) };
  if (first === "settings") return { name: "settings", path };
  if (first === "about") return { name: "about", path };
  if (first === "legal" && parts[1]) return { name: "legal", path, doc: parts[1] };
  return { name: "browse", path: "/browse", mode: "all", category: "" };
}

function route() {
  const next = parseRoute();
  const view = views[next.name];

  if (currentView) currentView.hide(main.scrollTop);

  if (next.name === "browse") {
    const b = ctx.browse;
    b.mode = next.mode;
    b.category = next.category;
  }

  if (currentView !== view) {
    clear(viewHost).append(view.el);
  }
  currentRoute = next;
  currentView = view;

  backButton.hidden = next.name === "browse";
  ctx.setTitle(next.name === "browse" ? null : view.title());
  markSidebar();
  closeSidebar();

  const scrollTo = view.show(next) || 0;
  // wait a frame so the restored list has its height before scrolling
  requestAnimationFrame(() => { main.scrollTop = scrollTo; });
}

function markSidebar() {
  const route = currentRoute;
  for (const link of sidebar.querySelectorAll("a")) link.removeAttribute("aria-current");
  if (!route) return;
  let active = null;
  if (route.name === "browse") {
    if (route.mode === "all" && ctx.browse.category) active = categoryNav.querySelector(`[data-category="${CSS.escape(ctx.browse.category)}"]`);
    else active = sidebar.querySelector(`[data-nav="${route.mode}"]`);
  } else if (route.name === "settings" || route.name === "about") {
    active = sidebar.querySelector(`[data-nav="${route.name}"]`);
  } else if (route.name === "legal") {
    active = sidebar.querySelector('[data-nav="about"]');
  }
  active?.setAttribute("aria-current", "page");
}

function renderCategories() {
  clear(categoryNav);
  for (const c of ctx.meta?.categories || []) {
    categoryNav.append(
      h("li", null, h("a", { href: `#/browse?category=${encodeURIComponent(c.slug)}`, dataset: { category: c.slug } }, h("span", { class: "nav-dot", "aria-hidden": "true" }), c.name, c.mod_count ? h("span", { class: "nav-count" }, String(c.mod_count)) : null)),
    );
  }
  document.getElementById("categories-heading").hidden = !(ctx.meta?.categories || []).length;
  markSidebar();
}

async function loadMeta() {
  try {
    ctx.meta = await api("/api/meta");
    renderCategories();
    views.browse.metaChanged();
  } catch {
    // the browse view shows its own error with a retry. try meta again later.
    setTimeout(loadMeta, 15_000);
  }
}

// ---------- theme ----------

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  setNativeTheme(theme);
}

// ---------- search ----------

const runSearch = debounce(() => {
  const q = search.value.trim();
  if (q === ctx.browse.q) return;
  ctx.browse.q = q;
  if (currentRoute?.name !== "browse") {
    location.hash = ctx.browse.category ? `#/browse?category=${encodeURIComponent(ctx.browse.category)}` : "#/browse";
  } else {
    views.browse.refresh();
  }
}, 250);

search.addEventListener("input", runSearch);
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && search.value) {
    event.stopPropagation();
    search.value = "";
    runSearch();
  }
  if (event.key === "Enter") {
    runSearch();
  }
});

// ---------- sidebar on narrow windows ----------

function openSidebar() {
  sidebar.classList.add("open");
  scrim.hidden = false;
  sidebarToggle.setAttribute("aria-expanded", "true");
  sidebar.querySelector("a")?.focus();
}

function closeSidebar() {
  if (!sidebar.classList.contains("open")) return;
  sidebar.classList.remove("open");
  scrim.hidden = true;
  sidebarToggle.setAttribute("aria-expanded", "false");
}

sidebarToggle.addEventListener("click", () => (sidebar.classList.contains("open") ? closeSidebar() : openSidebar()));
scrim.addEventListener("click", closeSidebar);

// ---------- navigation ----------

backButton.addEventListener("click", goBack);

function goBack() {
  if (history.length > 1) history.back();
  else location.hash = "#/browse";
}

// every link marked external opens in the normal browser, never inside branch
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-external]");
  if (!link) return;
  event.preventDefault();
  openExternal(link.href).catch(() => toast("couldn't open your browser", { tone: "error" }));
});

document.addEventListener("keydown", (event) => {
  const typing = event.target.closest("input, textarea, select, [contenteditable]");
  if ((event.ctrlKey && (event.key === "f" || event.key === "k")) || (!typing && event.key === "/")) {
    event.preventDefault();
    search.focus();
    search.select();
  } else if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    goBack();
  } else if (event.key === "Backspace" && !typing && currentRoute?.name !== "browse") {
    event.preventDefault();
    goBack();
  } else if (event.ctrlKey && event.key === ",") {
    event.preventDefault();
    location.hash = "#/settings";
  } else if (event.key === "Escape" && sidebar.classList.contains("open")) {
    closeSidebar();
    sidebarToggle.focus();
  }
});

window.addEventListener("hashchange", route);

// ---------- start ----------

async function start() {
  hydrateIcons();
  applyTheme(settings.get().theme);
  try {
    await initPlatform();
  } catch {
    toast("Branch couldn't start its network helper. try restarting the app.", { tone: "error", timeout: 8000 });
  }
  if ((await windowMaterial()) === "mica") root.classList.add("material-mica");
  route();
  loadMeta();
}

start();

export { icon };
