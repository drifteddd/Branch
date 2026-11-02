import { h, clear, formatDate, formatBytes, formatNumber } from "../dom.js";
import { icon } from "../icons.js";
import { api, openExternal } from "../platform.js";
import { errorBlock, stateBlock, toast, thumbnail, libraryTabs } from "../ui.js";
import { renderMarkdown } from "../../shared/markdown.js";

const STORE_KEY = "branch.watchlist";
const CHECK_EVERY = 30 * 60 * 1000;

export function watchlist() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveWatchlist(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {}
}

const keyOf = (repo) => `${repo.owner}/${repo.name}`.toLowerCase();
const isNew = (entry) => entry.latest && entry.latest.tag !== entry.seenTag;

export function watchUnseen() {
  return watchlist().filter(isNew).length;
}

export function watchInboxItems() {
  const items = [];
  for (const entry of watchlist()) {
    for (const u of entry.updates || []) {
      items.push({
        type: "mods",
        kind: "watch",
        id: `w-${entry.key}-${u.tag}`,
        title: `${entry.name} ${u.version || u.tag} is out`,
        body: `a new version of ${entry.full_name} is on github. open your Watchlist to get it.`,
        link: "#/watch",
        date: new Date(u.at),
      });
    }
  }
  return items;
}

let checking = null;
let lastCheck = 0;

export async function checkWatchlist({ force = false, onChange } = {}) {
  const list = watchlist();
  if (!list.length) return 0;
  if (!force && Date.now() - lastCheck < CHECK_EVERY) return 0;
  if (checking) return checking;
  lastCheck = Date.now();
  checking = (async () => {
    let fresh = 0;
    try {
      const data = await api("/api/github/latest", { method: "POST", body: { repos: list.map((e) => e.full_name) } });
      const current = watchlist();
      for (const entry of current) {
        const result = data.results?.[entry.key];
        if (!result || result.error) continue;
        const latest = result.latest;
        if (latest && entry.latest && latest.tag !== entry.latest.tag) {
          entry.updates = [{ tag: latest.tag, version: latest.version, at: Date.now() }, ...(entry.updates || [])].slice(0, 20);
          fresh++;
          toast(`${entry.name} has a new version: ${latest.version || latest.tag}`, { tone: "ok", timeout: 6000 });
        } else if (latest && !entry.latest) {
          entry.updates = [{ tag: latest.tag, version: latest.version, at: Date.now() }, ...(entry.updates || [])].slice(0, 20);
          fresh++;
          toast(`${entry.name} has its first release: ${latest.version || latest.tag}`, { tone: "ok", timeout: 6000 });
        }
        entry.latest = latest;
        entry.recommended = result.recommended;
        entry.branch = result.branch;
        entry.checkedAt = Date.now();
      }
      saveWatchlist(current);
      onChange?.();
    } catch {
    } finally {
      checking = null;
    }
    return fresh;
  })();
  return checking;
}

function assetFor(latest, name) {
  return latest?.assets?.find((a) => a.name === name) || null;
}

function getLatest(entry) {
  if (entry.branch && entry.branch.up_to_date && entry.branch.hosted) {
    location.hash = `#/mod/${encodeURIComponent(entry.branch.slug)}`;
    return;
  }
  const asset = assetFor(entry.latest, entry.recommended);
  if (asset) openExternal(asset.url);
  else if (entry.latest?.url) openExternal(entry.latest.url);
  else openExternal(entry.url);
}

export function createWatchView(ctx) {
  const el = h("section", { class: "view page watch-view", "aria-labelledby": "watch-title" });
  const resultHost = h("div", { class: "wt-result-host", "aria-live": "polite" });
  const listHost = h("div", { class: "wt-list-host" });
  let lastResult = null;

  function entryFrom(result) {
    return {
      key: keyOf(result.repo),
      owner: result.repo.owner,
      name: result.branch?.name || result.repo.name,
      full_name: result.repo.full_name,
      url: result.repo.url,
      description: result.repo.description,
      latest: result.latest,
      seenTag: result.latest?.tag || null,
      recommended: result.recommended,
      branch: result.branch,
      addedAt: Date.now(),
      checkedAt: Date.now(),
      updates: [],
    };
  }

  function getButtonLabel(branch, latest, recommended) {
    if (branch && branch.up_to_date && branch.hosted) return [icon("scan"), "Get it on Branch"];
    if (recommended) return [icon("download"), `Download ${recommended}`];
    if (latest) return [icon("external"), "Open the release on GitHub"];
    return [icon("external"), "Open on GitHub"];
  }

  function notes(latest) {
    if (!latest?.notes?.trim()) return null;
    return h("details", { class: "wt-notes" }, h("summary", null, "What's new"), h("div", { class: "prose", html: renderMarkdown(latest.notes) }));
  }

  function renderResult(result) {
    lastResult = result;
    const { repo, latest, branch, recommended } = result;
    const watching = watchlist().some((e) => e.key === keyOf(repo));
    const watchBtn = h(
      "button",
      { class: `btn${watching ? " is-on" : ""}`, type: "button", id: "wt-watch" },
      icon("bell"),
      watching ? "Watching" : "Watch for updates",
    );
    watchBtn.addEventListener("click", () => {
      const list = watchlist();
      if (list.some((e) => e.key === keyOf(repo))) {
        saveWatchlist(list.filter((e) => e.key !== keyOf(repo)));
        toast("Stopped watching", { tone: "ok" });
      } else {
        saveWatchlist([entryFrom(result), ...list]);
        toast(`Watching ${branch?.name || repo.name}. you'll get a notification when a new version comes out.`, { tone: "ok" });
      }
      renderResult(result);
      renderList();
      ctx.setWatchCount?.(watchUnseen());
    });
    const getBtn = h("button", { class: "btn btn-primary", type: "button", id: "wt-get" }, ...getButtonLabel(branch, latest, recommended));
    getBtn.addEventListener("click", () => getLatest({ ...entryFrom(result) }));

    const match = branch
      ? h(
          "a",
          { class: "wt-branch", href: `#/mod/${encodeURIComponent(branch.slug)}` },
          thumbnail(branch.thumbnail_url, "wt-branch-thumb", branch),
          h(
            "div",
            null,
            h("span", { class: "wt-branch-label" }, icon("check"), "Found on Branch"),
            h("strong", null, branch.name),
            h("p", { class: "muted small" }, branch.up_to_date ? (branch.hosted ? "Branch has the newest version, safety checked." : "Branch links to the newest version.") : `Branch has ${branch.latest_version || "an older version"}. the newest version is on github.`),
          ),
          icon("chevronRight"),
        )
      : h("div", { class: "wt-branch none" }, h("span", { class: "wt-branch-label" }, icon("info"), "Not on Branch yet"), h("p", { class: "muted small" }, "files straight from github aren't safety checked by Branch. you can run them through the Mod checker before you use them."));

    const assets = latest?.assets?.length
      ? h(
          "ul",
          { class: "wt-assets" },
          latest.assets.map((a) =>
            h(
              "li",
              { class: a.name === recommended ? "recommended" : "" },
              icon(/\.dll$/i.test(a.name) ? "code" : /\.zip$/i.test(a.name) ? "box" : "download"),
              h("span", { class: "wt-asset-name" }, a.name),
              a.size ? h("span", { class: "muted small" }, formatBytes(a.size)) : null,
              a.name === recommended ? h("span", { class: "ch-tag ok" }, "Best match") : null,
              h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => openExternal(a.url) }, icon("download"), "Download"),
            ),
          ),
        )
      : null;

    clear(resultHost).append(
      h(
        "article",
        { class: "rw-card wt-result" },
        h(
          "header",
          { class: "wt-result-head" },
          h("span", { class: "wt-repo-icon" }, icon("repo")),
          h("div", null, h("h2", null, branch?.name || repo.name), h("p", { class: "muted small" }, h("a", { href: repo.url, "data-external": true }, repo.full_name), repo.stars != null ? ` · ${formatNumber(repo.stars)} stars` : "")),
        ),
        repo.description ? h("p", { class: "wt-desc" }, repo.description) : null,
        match,
        latest
          ? h(
              "div",
              { class: "wt-latest" },
              h("div", null, h("p", { class: "rw-label" }, "Latest version"), h("p", { class: "wt-version" }, latest.version || latest.tag), h("p", { class: "muted small" }, `${latest.title && latest.title !== latest.tag ? `${latest.title} · ` : ""}${latest.published_at ? `released ${formatDate(latest.published_at)}` : ""}`)),
              h("div", { class: "wt-actions" }, getBtn, watchBtn),
            )
          : h("div", { class: "wt-latest" }, h("div", null, h("p", { class: "rw-label" }, "Latest version"), h("p", { class: "muted" }, "this repo doesn't have any releases yet. watch it and Branch will tell you when the first one comes out.")), h("div", { class: "wt-actions" }, watchBtn)),
        notes(latest),
        assets,
      ),
    );
  }

  function watchCard(entry) {
    const fresh = isNew(entry);
    const markSeen = () => {
      const list = watchlist();
      const e = list.find((x) => x.key === entry.key);
      if (e) e.seenTag = e.latest?.tag || null;
      saveWatchlist(list);
      ctx.setWatchCount?.(watchUnseen());
      renderList();
    };
    return h(
      "article",
      { class: `wt-card${fresh ? " is-new" : ""}`, dataset: { repo: entry.key } },
      h("span", { class: "wt-repo-icon" }, icon("repo")),
      h(
        "div",
        { class: "wt-card-main" },
        h("div", { class: "wt-card-top" }, h("strong", null, entry.name), entry.latest ? h("span", { class: "wt-card-version" }, entry.latest.version || entry.latest.tag) : h("span", { class: "muted small" }, "no releases yet"), fresh ? h("span", { class: "inbox-new" }, "New version") : null),
        h("p", { class: "muted small" }, h("a", { href: entry.url, "data-external": true }, entry.full_name), entry.latest?.published_at ? ` · released ${formatDate(entry.latest.published_at)}` : "", entry.checkedAt ? ` · checked ${formatDate(new Date(entry.checkedAt).toISOString())}` : ""),
        fresh ? notes(entry.latest) : null,
      ),
      h(
        "div",
        { class: "wt-card-actions" },
        entry.latest ? h("button", { class: `btn btn-small${fresh ? " btn-primary" : ""}`, type: "button", onclick: () => { getLatest(entry); markSeen(); } }, icon("download"), "Get latest") : null,
        fresh ? h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: markSeen }, "Mark as seen") : null,
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": `Stop watching ${entry.name}`,
            title: "Stop watching",
            onclick: () => {
              saveWatchlist(watchlist().filter((e) => e.key !== entry.key));
              ctx.setWatchCount?.(watchUnseen());
              renderList();
              if (lastResult) renderResult(lastResult);
            },
          },
          icon("close"),
        ),
      ),
    );
  }

  function renderList() {
    const list = watchlist();
    const check = h("button", { class: "btn btn-quiet btn-small", type: "button" }, icon("refresh"), "Check now");
    check.addEventListener("click", async () => {
      check.disabled = true;
      const fresh = await checkWatchlist({ force: true });
      if (!fresh) toast("Everything is up to date", { tone: "ok" });
      ctx.setWatchCount?.(watchUnseen());
      renderList();
    });
    clear(listHost).append(
      h("div", { class: "ch-card-head wt-list-head" }, h("h2", null, "Watching"), list.length ? check : null),
      list.length
        ? h("div", { class: "wt-list" }, list.map(watchCard))
        : stateBlock({ iconName: "bell", title: "You're not watching anything yet", message: "find a mod above and press Watch for updates. Branch checks for new versions every 30 minutes while the app is open." }),
    );
  }

  function build() {
    const input = h("input", { class: "input", id: "wt-url", type: "url", autocomplete: "off", spellcheck: "false", placeholder: "https://github.com/someone/their-mod" });
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, icon("search"), "Find mod");
    const error = h("p", { class: "error", hidden: true, role: "alert" });
    const form = h(
      "form",
      { class: "wt-search", novalidate: true },
      h("label", { class: "visually-hidden", for: "wt-url" }, "GitHub link"),
      h("div", { class: "wt-search-row" }, h("span", { class: "wt-search-icon" }, icon("repo")), input, submit),
      error,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!input.value.trim()) {
        error.textContent = "paste a github link first";
        error.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.replaceChildren(h("span", { class: "spinner small-spinner", "aria-hidden": "true" }), "Looking…");
      clear(resultHost).append(h("div", { class: "rw-card skeleton wt-skeleton" }));
      try {
        renderResult(await api("/api/github/lookup", { method: "POST", body: { url: input.value.trim() } }));
      } catch (err) {
        clear(resultHost);
        if (err.fields?.url) {
          error.textContent = err.fields.url;
          error.hidden = false;
        } else {
          resultHost.append(errorBlock(err, () => form.requestSubmit()));
        }
      }
      submit.disabled = false;
      submit.replaceChildren(icon("search"), "Find mod");
    });
    clear(el).append(
      libraryTabs("watch"),
      h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "watch-title" }, "Watchlist")),
      h("p", { class: "muted wt-intro" }, "paste a github link to any mod. Branch finds out what it is, gets you the newest version, and lets you know whenever a new one comes out."),
      form,
      resultHost,
      listHost,
    );
    renderList();
  }

  let built = false;
  return {
    el,
    title: () => "Watchlist",
    show() {
      if (!built) {
        build();
        built = true;
      } else {
        renderList();
      }
      checkWatchlist({ onChange: renderList }).then(() => ctx.setWatchCount?.(watchUnseen()));
      return 0;
    },
    hide() {},
    refreshList: renderList,
  };
}
