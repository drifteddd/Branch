import { h, clear, formatDate, plural } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../platform.js";
import { favorites, recent, changes } from "../store.js";
import { compatBadge, errorBlock, skeletonRows, stateBlock, thumbnail, showCompatHelp, setBusy } from "../ui.js";

const PAGE_SIZE = 20;

export function versionLabel(version) {
  const v = String(version || "").replace(/^v(?=\d)/i, "");
  return /^\d/.test(v) ? `v${v}` : v;
}

const MODES = {
  all: { title: "All mods" },
  featured: { title: "Featured" },
  favorites: { title: "Favorites" },
  recent: { title: "Recently viewed" },
};

const SORTS = [
  ["updated", "Recently updated"],
  ["newest", "Newest"],
  ["name", "Name"],
  ["downloads", "Most downloaded"],
];

export function createBrowseView(ctx) {
  const state = ctx.browse;

  const title = h("h1", { class: "view-title", id: "browse-title" });
  const count = h("p", { class: "view-count" });

  const categorySelect = h("select", { class: "select", id: "filter-category" });
  const compatSelect = h("select", { class: "select", id: "filter-compat" });
  const sortSelect = h("select", { class: "select", id: "filter-sort" }, SORTS.map(([value, label]) => h("option", { value }, label)));
  const sortField = h("div", { class: "filter" }, h("label", { for: "filter-sort" }, "Sort by"), sortSelect);
  const clearButton = h("button", { class: "btn btn-quiet", type: "button", onclick: clearFilters }, icon("close"), "Clear filters");
  const compatHelp = h("button", { class: "icon-btn", type: "button", "aria-label": "What the compatibility labels mean", title: "What the compatibility labels mean", onclick: () => showCompatHelp(ctx.meta) }, icon("info"));

  const notice = h("div", { class: "notice", hidden: true });
  const statusArea = h("div", { class: "status-area" });
  const list = h("ul", { class: "mod-list", role: "list", "aria-labelledby": "browse-title" });
  const loadMoreButton = h("button", { class: "btn", type: "button", onclick: () => load(false) }, "Load more");
  const foot = h("div", { class: "list-foot" });

  const el = h(
    "section",
    { class: "view browse", "aria-labelledby": "browse-title" },
    h("header", { class: "view-head" }, title, count),
    h(
      "div",
      { class: "filters", role: "group", "aria-label": "Filters and sorting" },
      h("div", { class: "filter" }, h("label", { for: "filter-category" }, "Category"), categorySelect),
      h("div", { class: "filter" }, h("label", { for: "filter-compat" }, "Compatibility"), h("div", { class: "filter-with-help" }, compatSelect, compatHelp)),
      sortField,
      clearButton,
    ),
    notice,
    statusArea,
    list,
    foot,
  );

  let items = [];
  let page = 0;
  let hasMore = false;
  let total = 0;
  let loading = false;
  let loadedKey = null;
  let requestId = 0;
  let savedScroll = 0;

  function fillFilterOptions() {
    const categories = ctx.meta?.categories || [];
    clear(categorySelect).append(h("option", { value: "" }, "All categories"), ...categories.map((c) => h("option", { value: c.slug }, c.name)));
    const compat = ctx.meta?.compatibility || [];
    clear(compatSelect).append(h("option", { value: "" }, "Any status"), ...compat.map((c) => h("option", { value: c.key }, c.label)));
    syncControls();
  }

  function syncControls() {
    categorySelect.value = state.category;
    compatSelect.value = state.compat;
    sortSelect.value = state.sort;
    sortField.hidden = state.mode === "recent";
    clearButton.hidden = !hasFilters();
  }

  function hasFilters() {
    return Boolean(state.q || state.category || state.compat || state.sort !== "updated");
  }

  categorySelect.addEventListener("change", () => { state.category = categorySelect.value; ctx.syncBrowseHash(); refresh(); });
  compatSelect.addEventListener("change", () => { state.compat = compatSelect.value; refresh(); });
  sortSelect.addEventListener("change", () => { state.sort = sortSelect.value; refresh(); });

  function clearFilters() {
    state.q = "";
    state.category = "";
    state.compat = "";
    state.sort = "updated";
    ctx.setSearchText("");
    ctx.syncBrowseHash();
    refresh();
  }

  function currentKey() {
    const slugs = state.mode === "favorites" ? favorites.list() : state.mode === "recent" ? recent.list() : null;
    return JSON.stringify([state.mode, state.q, state.category, state.compat, state.sort, slugs]);
  }

  function slugsForMode() {
    if (state.mode === "favorites") return favorites.list().slice(0, 200);
    if (state.mode === "recent") return recent.list();
    return null;
  }

  function listUrl(pageNumber, slugs) {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.category) params.set("category", state.category);
    if (state.compat) params.set("compat", state.compat);
    params.set("sort", state.mode === "recent" ? "updated" : state.sort);
    if (state.mode === "featured") params.set("featured", "true");
    if (slugs) params.set("slugs", slugs.join(","));
    params.set("page", String(pageNumber));
    params.set("per_page", String(state.mode === "recent" ? 30 : PAGE_SIZE));
    return `/api/mods?${params}`;
  }

  function ordered(batch, slugs) {
    if (state.mode !== "recent") return batch;
    const order = new Map(slugs.map((s, i) => [s, i]));
    return [...batch].sort((a, b) => order.get(a.slug) - order.get(b.slug));
  }

  async function quietRefresh() {
    if (loading || loadedKey !== currentKey()) return;
    const slugs = slugsForMode();
    if (slugs && slugs.length === 0) return;
    if (page > 5) return;
    const id = requestId;
    const fresh = [];
    let last = null;
    try {
      for (let p = 1; p <= Math.max(1, page); p++) {
        last = await api(listUrl(p, slugs));
        fresh.push(...ordered(last.items, slugs));
        if (!last.has_more) break;
      }
    } catch {
      return;
    }
    if (id !== requestId || loading || loadedKey !== currentKey()) return;
    if (fresh.length && !items.length) {
      load(true);
      return;
    }
    if (last.total === total && JSON.stringify(fresh) === JSON.stringify(items)) return;

    const before = new Map([...list.querySelectorAll(".mod-row")].map((row) => [row.dataset.slug, row]));
    const focusedSlug = document.activeElement?.closest?.(".mod-row")?.dataset.slug;
    const rows = fresh.map((mod) => {
      const old = before.get(mod.slug);
      if (old && old.signature === JSON.stringify(mod)) return old;
      const row = renderRow(mod);
      if (!old) row.classList.add("row-new");
      return row;
    });
    let cursor = list.firstChild;
    for (const row of rows) {
      if (row === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    if (focusedSlug) list.querySelector(`.mod-row[data-slug="${CSS.escape(focusedSlug)}"] .row-link`)?.focus({ preventScroll: true });
    items = fresh;
    total = last.total;
    hasMore = last.has_more;
    renderFooter();
    renderCount();
    if (!items.length) renderEmpty();
  }

  async function load(reset) {
    if (loading && !reset) return;
    const id = ++requestId;
    loading = true;
    setBusy(list, true);

    if (reset) {
      items = [];
      page = 0;
      hasMore = false;
      loadedKey = currentKey();
      clear(statusArea);
      notice.hidden = true;
      clear(list).append(...skeletonRows());
      clear(foot);
      count.textContent = "";
    } else {
      clear(foot).append(h("div", { class: "spinner", role: "progressbar", "aria-label": "Loading more mods" }));
    }

    const slugs = slugsForMode();
    if (slugs && slugs.length === 0) {
      loading = false;
      setBusy(list, false);
      clear(list);
      renderEmpty();
      return;
    }

    try {
      const data = await api(listUrl(page + 1, slugs));
      if (id !== requestId) return;
      page = data.page;
      hasMore = data.has_more;
      total = data.total;
      const batch = ordered(data.items, slugs);
      if (reset) clear(list);
      items.push(...batch);
      list.append(...batch.map(renderRow));
      renderFooter();
      renderCount();
      if (items.length === 0) renderEmpty();
      if (state.mode === "favorites" && !hasMore && !hasFilters()) renderMissing(slugs);
    } catch (err) {
      if (id !== requestId) return;
      if (reset) {
        clear(list);
        clear(statusArea).append(errorBlock(err, () => load(true)));
        loadedKey = null;
      } else {
        clear(foot).append(h("p", { class: "muted" }, "couldn't load more mods. "), h("button", { class: "btn", type: "button", onclick: () => load(false) }, icon("refresh"), "Try again"));
      }
    } finally {
      if (id === requestId) {
        loading = false;
        setBusy(list, false);
      }
    }
  }

  function renderCount() {
    count.textContent = items.length ? plural(total, "mod", "mods") : "";
  }

  function renderFooter() {
    clear(foot);
    if (hasMore) foot.append(loadMoreButton);
    else if (items.length > PAGE_SIZE) foot.append(h("p", { class: "muted" }, "that's everything."));
  }

  function renderEmpty() {
    clear(statusArea);
    count.textContent = "";
    if (hasFilters()) {
      statusArea.append(
        stateBlock({
          iconName: "search",
          title: "No mods match",
          message: state.q ? `nothing matched "${state.q}" with these filters. try fewer words or clear the filters.` : "nothing matches these filters right now.",
          actions: [h("button", { class: "btn btn-primary", type: "button", onclick: clearFilters }, "Clear filters")],
        }),
      );
      return;
    }
    const empty = {
      all: { iconName: "box", title: "No mods yet", message: "nothing has been published on Branch yet. check back soon." },
      featured: { iconName: "sparkle", title: "Nothing featured right now", message: "featured picks show up here when the Branch admin chooses some.", actions: [ctx.link("#/browse", "Browse all mods")] },
      favorites: { iconName: "star", title: "No favorites yet", message: "tap the star on any mod to keep it here. favorites are saved on this computer only.", actions: [ctx.link("#/browse", "Browse mods")] },
      recent: { iconName: "clock", title: "Nothing viewed yet", message: "mods you open will show up here so you can find them again.", actions: [ctx.link("#/browse", "Browse mods")] },
    }[state.mode];
    statusArea.append(stateBlock(empty));
  }

  function renderMissing(slugs) {
    const found = new Set(items.map((m) => m.slug));
    const missing = slugs.filter((s) => !found.has(s));
    if (!missing.length) return;
    clear(notice).append(
      icon("info"),
      h("span", null, `${plural(missing.length, "favorite isn't", "favorites aren't")} listed on Branch anymore.`),
      h("button", { class: "btn btn-quiet", type: "button", onclick: () => { favorites.remove(missing); notice.hidden = true; } }, "Remove from favorites"),
    );
    notice.hidden = false;
  }

  function renderRow(mod) {
    const fav = favorites.has(mod.slug);
    const star = h(
      "button",
      {
        class: `icon-btn fav-toggle${fav ? " on" : ""}`,
        type: "button",
        "aria-pressed": String(fav),
        "aria-label": `Favorite ${mod.name}`,
        title: fav ? "Remove from favorites" : "Add to favorites",
        dataset: { slug: mod.slug },
      },
      icon(fav ? "starFill" : "star"),
    );
    star.addEventListener("click", () => {
      favorites.toggle(mod.slug);
    });

    const meta = [`by ${mod.author || "unknown author"}`, mod.category?.name, mod.last_updated ? `Updated ${formatDate(mod.last_updated)}` : null].filter(Boolean);

    const row = h(
      "li",
      { class: "mod-row", dataset: { slug: mod.slug } },
      thumbnail(mod.thumbnail_url),
      h(
        "div",
        { class: "row-main" },
        h(
          "div",
          { class: "row-title" },
          h("a", { class: "row-link", href: `#/mod/${encodeURIComponent(mod.slug)}` }, mod.name),
          mod.latest_version ? h("span", { class: "version" }, versionLabel(mod.latest_version)) : null,
          mod.featured ? h("span", { class: "badge plain featured-badge" }, "Featured") : null,
          mod.community ? h("span", { class: "badge plain community-badge", title: "uploaded by someone in the community" }, "Community") : null,
        ),
        h("p", { class: "row-summary" }, mod.summary || "no description yet."),
        h("p", { class: "row-meta" }, meta.join("  ·  ")),
      ),
      h("div", { class: "row-side" }, compatBadge(mod.compatibility, ctx.meta)),
      star,
    );
    row.signature = JSON.stringify(mod);
    return row;
  }

  changes.addEventListener("favorites", () => {
    for (const button of list.querySelectorAll(".fav-toggle")) {
      const on = favorites.has(button.dataset.slug);
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
      button.title = on ? "Remove from favorites" : "Add to favorites";
      button.replaceChildren(icon(on ? "starFill" : "star"));
    }
  });

  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = [...list.querySelectorAll(".row-link")];
    const index = links.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next = links[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
  });

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore && !loading) load(false);
    },
    { root: document.getElementById("main"), rootMargin: "400px" },
  );
  observer.observe(foot);

  function refresh() {
    syncControls();
    load(true);
  }

  return {
    el,
    title: () => MODES[state.mode].title,
    show() {
      title.textContent = MODES[state.mode].title;
      fillFilterOptions();
      if (currentKey() !== loadedKey) {
        load(true);
        return 0;
      }
      return savedScroll;
    },
    hide(scrollTop) {
      savedScroll = scrollTop;
    },
    refresh,
    quietRefresh,
    metaChanged: fillFilterOptions,
    invalidate() {
      loadedKey = null;
    },
  };
}
