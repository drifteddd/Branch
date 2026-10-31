import { h, clear, debounce } from "./dom.js";
import { icon, hydrateIcons } from "./icons.js";
import { api, appWindow, initPlatform, isDesktop, openExternal, setNativeTheme, windowMaterial } from "./platform.js";
import { settings, favorites, recent } from "./store.js";
import { runSplash } from "./splash.js";
import { requireTerms } from "./terms.js";
import { showStoryOnce } from "./story.js";
import { runOnboardingOnce } from "./onboarding.js";
import { setAmbient, refreshAmbient } from "./ambient.js";
import { startUpdater, checkOnSplash } from "./updater.js";
import { toast } from "./ui.js";
import { createBrowseView } from "./views/browse.js";
import { createDetailView } from "./views/detail.js";
import { createSettingsView, createAboutView, createLegalView } from "./views/pages.js";
import { createUploadView } from "./views/upload.js";
import { createForumView } from "./views/forum.js";
import { createRewardsView } from "./views/rewards.js";
import { createCheckerView } from "./views/checker.js";
import { createTreeView } from "./views/tree.js";
import { createTrackerView } from "./views/tracker.js";
import { createAssistantView } from "./views/assistant.js";
import { createInboxView, inboxUnread } from "./views/inbox.js";

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
  browse: { mode: "all", q: "", category: "", compat: "", sort: "top" },
  link(href, label) {
    return h("a", { class: "btn btn-primary", href }, label);
  },
  refreshLists() {
    views.browse.invalidate();
    loadMeta();
  },
  setTitle(text) {
    document.title = text ? `${text} · Branch` : "Branch";
  },
  setSearchText(text) {
    search.value = text;
  },
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
    refreshAmbient();
  },
  applyMotion(reduce) {
    settings.set({ reduceMotion: reduce });
    if (reduce) root.dataset.motion = "reduce";
    else delete root.dataset.motion;
    refreshAmbient();
  },
  setInboxCount(count) {
    const badge = document.getElementById("inbox-count");
    if (!badge) return;
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.hidden = !count;
  },
  applyAmbient(style) {
    settings.set({ ambient: style });
    setAmbient(style);
  },
};

const views = {
  browse: createBrowseView(ctx),
  detail: createDetailView(ctx),
  settings: createSettingsView(ctx),
  about: createAboutView(ctx),
  legal: createLegalView(ctx),
  upload: createUploadView(ctx),
  forum: createForumView(ctx),
  rewards: createRewardsView(ctx),
  check: createCheckerView(ctx),
  tree: createTreeView(ctx),
  tracker: createTrackerView(ctx),
  ask: createAssistantView(ctx),
  inbox: createInboxView(ctx),
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
  if (first === "upload") return { name: "upload", path };
  if (first === "rewards") return { name: "rewards", path };
  if (first === "forum") return { name: "forum", path, thread: parts[1] ? decodeURIComponent(parts[1]) : null, board: params.get("board") || "" };
  if (first === "check") return { name: "check", path };
  if (first === "tree") return { name: "tree", path };
  if (first === "tracker") return { name: "tracker", path };
  if (first === "ask") return { name: "ask", path };
  if (first === "inbox") return { name: "inbox", path };
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
  } else if (["settings", "about", "upload", "check", "forum", "rewards", "tree", "tracker", "ask", "inbox"].includes(route.name)) {
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
    setTimeout(loadMeta, 15_000);
  }
}

const REFRESH_EVERY = 30_000;
let lastRefresh = Date.now();

async function refreshEverything() {
  if (document.hidden) return;
  lastRefresh = Date.now();
  try {
    const meta = await api("/api/meta");
    if (JSON.stringify(meta) !== JSON.stringify(ctx.meta)) {
      ctx.meta = meta;
      renderCategories();
      views.browse.metaChanged();
    }
  } catch {
    return;
  }
  await views.browse.quietRefresh();
  if (currentView === views.tree) await views.tree.poll();
  await updateInboxBadge();
}

async function updateInboxBadge() {
  if (currentView === views.inbox) return;
  try {
    ctx.setInboxCount(await inboxUnread());
  } catch {}
}

function startAutoRefresh() {
  setInterval(refreshEverything, REFRESH_EVERY);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastRefresh > REFRESH_EVERY) refreshEverything();
  });
  if (!isDesktop) window.__branchRefresh = refreshEverything;
}

function applyTheme(theme) {
  if (theme === "system" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  setNativeTheme(theme);
}

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

backButton.addEventListener("click", goBack);

function goBack() {
  if (history.length > 1) history.back();
  else location.hash = "#/browse";
}

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

function setupWindow() {
  if (!isDesktop || !appWindow) return;
  root.classList.add("is-desktop");
  document.getElementById("window-controls").hidden = false;
  document.getElementById("wc-close").addEventListener("click", () => appWindow.close());
  document.getElementById("wc-min").addEventListener("click", () => appWindow.minimize());
  document.getElementById("wc-max").addEventListener("click", () => appWindow.toggleMaximize());
  const syncMaximized = async () => {
    try {
      const maximized = await appWindow.isMaximized();
      const button = document.getElementById("wc-max");
      root.classList.toggle("is-maximized", maximized);
      button.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
      button.title = maximized ? "Restore" : "Maximize";
    } catch {
    }
  };
  window.addEventListener("resize", syncMaximized);
  syncMaximized();
  window.addEventListener("blur", () => root.classList.add("window-inactive"));
  window.addEventListener("focus", () => root.classList.remove("window-inactive"));
}

async function start() {
  hydrateIcons();
  applyTheme(settings.get().theme);
  setupWindow();
  setAmbient(settings.get().ambient);

  let update = null;
  await runSplash(async (say) => {
    say("Connecting to the Branch server");
    try {
      await initPlatform();
    } catch {
      say("Couldn't start the network helper");
    }
    if ((await windowMaterial()) === "mica") root.classList.add("material-mica");

    try {
      say("Loading categories");
      ctx.meta = await api("/api/meta");
      for (const c of ctx.meta.categories) say(`Loading ${c.name}`);
      renderCategories();
      route();
      say("Loading the mod list");
      for (let page = 1; page <= 10; page++) {
        const data = await api(`/api/mods?sort=name&per_page=50&page=${page}`);
        for (const m of data.items) say(`Loading ${m.name}`);
        if (!data.has_more) break;
      }
    } catch {
      say("Couldn't reach the Branch server");
    }
    say(`Loading favorites (${favorites.list().length})`);
    say(`Loading recently viewed (${recent.list().length})`);
    say("Checking for updates");
    update = await checkOnSplash();
    say(update ? `Branch ${update.version} is ready to install` : "Branch is up to date");
    say("Loading settings");
    say("Getting everything ready");
  });

  await startUpdater(update);
  await requireTerms();
  await showStoryOnce();
  await runOnboardingOnce(ctx);

  if (!currentRoute) route();
  if (!ctx.meta) loadMeta();
  else views.browse.metaChanged();
  startAutoRefresh();
  updateInboxBadge();
}

start();

export { icon };