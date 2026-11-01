import { h, clear, formatBytes, formatDate, plural } from "../dom.js";
import { icon } from "../icons.js";
import { api, plugins, canManageMods, openExternal, ApiError } from "../platform.js";
import { confirmDialog, errorBlock, stateBlock, toast } from "../ui.js";
import { checkFileNext } from "./checker.js";

const FOLDER_KEY = "branch.gameFolder";
const BEPINEX_URL = "https://github.com/BepInEx/BepInEx/releases";

export function savedGameFolder() {
  try {
    return localStorage.getItem(FOLDER_KEY) || "";
  } catch {
    return "";
  }
}

function saveFolder(path) {
  try {
    if (path) localStorage.setItem(FOLDER_KEY, path);
    else localStorage.removeItem(FOLDER_KEY);
  } catch {}
}

let folderReady = null;

export async function ensureGameFolder() {
  if (!canManageMods) return null;
  const saved = savedGameFolder();
  if (!saved) return null;
  if (!folderReady) {
    folderReady = plugins("plugins_set_folder", { path: saved }).catch((err) => {
      folderReady = null;
      throw err;
    });
  }
  return folderReady;
}

export async function installToGame(release, fileName) {
  await ensureGameFolder();
  return plugins("plugins_install", { args: { id: `install-${release.id}`, releaseId: release.id, fileName, sha256: release.sha256 || null } });
}

export function createManagerView(ctx) {
  const el = h("section", { class: "view page manager-view", "aria-labelledby": "manager-title" });
  let folder = null;
  let files = [];
  let matches = {};
  let filter = "all";
  let query = "";
  const listHost = h("div", { class: "mm-list-host" });
  const statsLine = h("p", { class: "muted small mm-stats" });

  const head = () => h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "manager-title" }, "Mod manager"));

  function renderUnavailable() {
    clear(el).append(head(), stateBlock({ iconName: "plug", title: "Only in the desktop app", message: "the mod manager works with the files on your computer, so it needs the Branch desktop app." }));
  }

  async function useFolder(info) {
    folder = info;
    saveFolder(info.game_dir);
    folderReady = Promise.resolve(info);
    await load();
  }

  async function renderSetup(message) {
    const detectArea = h("div", { class: "mm-detect" }, h("div", { class: "spinner small-spinner", "aria-hidden": "true" }), h("span", { class: "muted small" }, "looking for Gorilla Tag…"));
    const pick = h("button", { class: "btn btn-primary", type: "button", id: "mm-pick" }, icon("folder"), "Choose folder…");
    pick.addEventListener("click", async () => {
      try {
        const info = await plugins("plugins_pick_folder");
        if (info) await useFolder(info);
      } catch (err) {
        renderSetup(err.message);
      }
    });
    clear(el).append(
      head(),
      h(
        "section",
        { class: "rw-card mm-setup" },
        h("span", { class: "mm-setup-icon" }, icon("plug")),
        h("h2", null, "Link your Gorilla Tag folder"),
        h("p", { class: "muted" }, "Branch reads the mods in your BepInEx plugins folder, so you can turn them on and off, check them for malware, and update them. nothing is uploaded unless you press Scan."),
        detectArea,
        h("div", { class: "mm-setup-actions" }, pick),
        h("p", { class: "muted small" }, "usually Steam\\steamapps\\common\\Gorilla Tag. you can also pick the BepInEx\\plugins folder itself."),
        message ? h("div", { class: "banner danger compact", role: "alert" }, icon("alert"), h("p", null, message)) : null,
      ),
    );
    try {
      const found = await plugins("plugins_detect");
      detectArea.replaceChildren(
        ...(found.length
          ? [
              h("p", { class: "small" }, found.length === 1 ? "found Gorilla Tag here:" : "found Gorilla Tag in these places:"),
              ...found.map((path) =>
                h(
                  "button",
                  {
                    class: "mm-found",
                    type: "button",
                    onclick: async () => {
                      try {
                        await useFolder(await plugins("plugins_set_folder", { path }));
                      } catch (err) {
                        renderSetup(err.message);
                      }
                    },
                  },
                  icon("folder"),
                  h("span", null, path),
                  h("span", { class: "mm-found-use" }, "Use this"),
                ),
              ),
            ]
          : [h("p", { class: "muted small" }, "couldn't find Gorilla Tag automatically. choose the folder yourself.")]),
      );
    } catch {
      detectArea.replaceChildren();
    }
  }

  async function load() {
    clear(el).append(head(), h("div", { class: "spinner", role: "progressbar", "aria-label": "Reading your mods" }));
    try {
      files = await plugins("plugins_list");
    } catch (err) {
      clear(el).append(head(), errorBlock(err, load));
      return;
    }
    matches = {};
    const hashes = files.map((f) => f.sha256).filter(Boolean);
    if (hashes.length) {
      try {
        matches = (await api("/api/mods/identify", { method: "POST", body: { hashes } })).matches || {};
      } catch {}
    }
    render();
  }

  function matchOf(f) {
    return matches[(f.sha256 || "").toLowerCase()] || null;
  }

  function shown() {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (filter === "on" && !f.enabled) return false;
      if (filter === "off" && f.enabled) return false;
      if (filter === "updates" && !matchOf(f)?.update) return false;
      if (q && !`${f.name} ${f.folder || ""} ${matchOf(f)?.name || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  async function toggle(f, enabled, quiet = false) {
    try {
      f.id = await plugins("plugins_set_enabled", { id: f.id, enabled });
      f.enabled = enabled;
      if (!quiet) toast(enabled ? `${f.name} is on` : `${f.name} is off`, { tone: "ok" });
      return true;
    } catch (err) {
      toast(err.message, { tone: "error" });
      return false;
    }
  }

  async function scan(f) {
    try {
      const bytes = await plugins("plugins_read", { id: f.id });
      checkFileNext(new File([bytes], f.file_name, { type: "application/octet-stream" }));
      location.hash = "#/check";
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  async function remove(f) {
    const ok = await confirmDialog({ title: `Remove ${f.name}?`, message: "the file is moved to BepInEx\\branch-removed, so you can put it back later if you change your mind.", confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await plugins("plugins_remove", { id: f.id });
      files = files.filter((x) => x !== f);
      toast(`Removed ${f.name}`, { tone: "ok" });
      render();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  async function update(f, button) {
    const m = matchOf(f);
    if (!m?.update) return;
    if (!m.update.installable || !/\.dll$/i.test(m.update.file_name || "")) {
      location.hash = `#/mod/${encodeURIComponent(m.slug)}`;
      return;
    }
    button.disabled = true;
    button.replaceChildren(h("span", { class: "spinner small-spinner", "aria-hidden": "true" }), "Updating…");
    try {
      await plugins("plugins_install", { args: { id: `update-${m.update.release_id}`, releaseId: m.update.release_id, fileName: m.update.file_name, sha256: m.update.sha256 || null } });
      if (m.update.file_name.toLowerCase() !== f.file_name.toLowerCase()) await plugins("plugins_remove", { id: f.id });
      toast(`${m.name} updated to ${m.update.version}`, { tone: "ok" });
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
      button.disabled = false;
      button.replaceChildren(icon("download"), `Update to ${m.update.version}`);
    }
  }

  function row(f) {
    const m = matchOf(f);
    const sw = h("input", { type: "checkbox", checked: f.enabled, "aria-label": `${f.name} on or off` });
    sw.addEventListener("change", async () => {
      sw.disabled = true;
      if (!(await toggle(f, sw.checked))) sw.checked = !sw.checked;
      sw.disabled = false;
      card.classList.toggle("off", !f.enabled);
      drawStats();
    });
    const updateBtn = m?.update ? h("button", { class: "btn btn-primary btn-small", type: "button" }, icon("download"), `Update to ${m.update.version}`) : null;
    updateBtn?.addEventListener("click", () => update(f, updateBtn));
    const card = h(
      "article",
      { class: `mm-row${f.enabled ? "" : " off"}`, dataset: { file: f.file_name } },
      h("span", { class: "switch" }, sw),
      h(
        "div",
        { class: "mm-main" },
        h("div", { class: "mm-top" }, h("strong", null, f.name), f.folder ? h("span", { class: "ch-tag" }, icon("folder"), f.folder) : null, f.enabled ? null : h("span", { class: "ch-tag" }, "Off")),
        h(
          "p",
          { class: "muted small" },
          m ? h("a", { href: `#/mod/${encodeURIComponent(m.slug)}` }, `On Branch: ${m.name}`, m.version ? ` ${m.version}` : "") : "not on Branch",
          ` · ${formatBytes(f.size)}`,
          f.modified ? ` · changed ${formatDate(new Date(f.modified * 1000).toISOString())}` : "",
        ),
      ),
      h(
        "div",
        { class: "mm-actions" },
        updateBtn,
        h("button", { class: "btn btn-quiet btn-small", type: "button", title: "Check this file with the mod checker", onclick: () => scan(f) }, icon("scan"), "Scan"),
        h("button", { class: "icon-btn", type: "button", "aria-label": `Show ${f.name} in its folder`, title: "Show in folder", onclick: () => plugins("plugins_open", { which: "file", id: f.id }).catch((e) => toast(e.message, { tone: "error" })) }, icon("folder")),
        h("button", { class: "icon-btn", type: "button", "aria-label": `Remove ${f.name}`, title: "Remove", onclick: () => remove(f) }, icon("close")),
      ),
    );
    return card;
  }

  function drawStats() {
    const on = files.filter((f) => f.enabled).length;
    const updates = files.filter((f) => matchOf(f)?.update).length;
    statsLine.textContent = `${plural(files.length, "mod", "mods")} · ${on} on · ${files.length - on} off${updates ? ` · ${plural(updates, "update", "updates")} available` : ""}`;
  }

  function drawList() {
    const list = shown();
    if (!files.length) {
      clear(listHost).append(stateBlock({ iconName: "plug", title: "No mods installed yet", message: "your plugins folder is empty. find mods on Branch and press Install, or drop .dll files into the folder." }));
      return;
    }
    clear(listHost).append(list.length ? h("div", { class: "mm-list" }, list.map(row)) : stateBlock({ iconName: "search", title: "Nothing matches", message: "try a different search or filter." }));
  }

  function render() {
    const search = h("input", { class: "input mm-search", type: "search", placeholder: "Search your mods", value: query, "aria-label": "Search your mods" });
    search.addEventListener("input", () => { query = search.value; drawList(); });
    const tabs = h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-label": "Show" },
      [["all", "All"], ["on", "On"], ["off", "Off"], ["updates", "Updates"]].map(([value, label]) =>
        h("label", null, h("input", { type: "radio", name: "mm-filter", value, checked: filter === value, onchange: () => { filter = value; drawList(); } }), h("span", null, label)),
      ),
    );
    const anyOn = files.some((f) => f.enabled);
    const allToggle = h("button", { class: "btn btn-small", type: "button", id: "mm-all" }, icon("plug"), anyOn ? "Turn all off" : "Turn all on");
    allToggle.addEventListener("click", async () => {
      allToggle.disabled = true;
      const target = !files.some((f) => f.enabled);
      let changed = 0;
      for (const f of files.filter((x) => x.enabled !== target)) if (await toggle(f, target, true)) changed++;
      toast(target ? `Turned on ${plural(changed, "mod", "mods")}` : `Turned off ${plural(changed, "mod", "mods")}. good for playing in public lobbies.`, { tone: "ok" });
      render();
    });
    clear(el).append(
      head(),
      h(
        "div",
        { class: "rw-card mm-folder" },
        h("span", { class: "mm-folder-icon" }, icon("folder")),
        h("div", { class: "mm-folder-text" }, h("strong", null, "Gorilla Tag folder"), h("p", { class: "muted small" }, folder.game_dir)),
        h(
          "div",
          { class: "mm-folder-actions" },
          h("button", { class: "btn btn-small", type: "button", onclick: () => plugins("plugins_open", { which: "plugins" }).catch((e) => toast(e.message, { tone: "error" })) }, icon("folder"), "Plugins folder"),
          h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => plugins("plugins_open", { which: "config" }).catch((e) => toast(e.message, { tone: "error" })) }, "Config"),
          h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => { saveFolder(""); folderReady = null; renderSetup(); } }, "Change"),
        ),
      ),
      folder.bepinex
        ? ""
        : h("div", { class: "banner warn compact", role: "status" }, icon("alert"), h("p", null, "BepInEx isn't installed in this folder yet. most mods need it. ", h("a", { href: BEPINEX_URL, "data-external": true, onclick: (e) => { e.preventDefault(); openExternal(BEPINEX_URL); } }, "Get BepInEx 5 (x64)"), ", unzip it into the Gorilla Tag folder and start the game once.")),
      h("div", { class: "mm-toolbar" }, search, tabs, h("span", { class: "grow" }), allToggle, h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: load }, icon("refresh"), "Refresh")),
      statsLine,
      listHost,
      h("p", { class: "muted small mm-foot" }, "turning a mod off renames it to .dll.disabled so BepInEx skips it. changes apply the next time you start Gorilla Tag."),
    );
    drawStats();
    drawList();
  }

  async function show() {
    if (!canManageMods) return renderUnavailable();
    const saved = savedGameFolder();
    if (!saved) return renderSetup();
    try {
      folder = await ensureGameFolder();
      await load();
    } catch (err) {
      renderSetup(err instanceof ApiError ? err.message : "couldn't open your Gorilla Tag folder.");
    }
  }

  return { el, title: () => "Mod manager", show() { show(); return 0; }, hide() {} };
}
