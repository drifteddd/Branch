import { h } from "./dom.js";
import { icon } from "./icons.js";
import { canUpdate, checkForUpdate, installUpdate, appVersion } from "./platform.js";
import { settings } from "./store.js";
import { toast } from "./ui.js";
import { renderMarkdown } from "../shared/markdown.js";

const CHECK_EVERY = 6 * 60 * 60 * 1000;
let pending = null;
let card = null;
let installing = false;
let dismissedVersion = null;

const autoUpdate = () => settings.get().autoUpdate !== false;
const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function updatesSupported() {
  return canUpdate || Boolean(window.__branchFakeUpdate);
}

function notesBlock(update) {
  return update.notes ? h("div", { class: "prose up-notes", html: renderMarkdown(update.notes) }) : null;
}

function hideCard() {
  card?.remove();
  card = null;
}

function showCard(update) {
  if (installing || dismissedVersion === update.version) return;
  hideCard();
  card = h(
    "div",
    { class: "up-card", role: "status" },
    h("span", { class: "up-card-icon", "aria-hidden": "true" }, icon("download")),
    h(
      "div",
      { class: "up-card-text" },
      h("strong", null, `Branch ${update.version} is ready`),
      h("p", null, "the update takes a few seconds. Branch restarts by itself."),
    ),
    h(
      "div",
      { class: "up-card-actions" },
      h("button", { class: "btn btn-quiet", type: "button", onclick: () => { dismissedVersion = update.version; hideCard(); } }, "Later"),
      h("button", { class: "btn btn-primary", type: "button", onclick: () => updateNow(update) }, "Update now"),
    ),
  );
  document.body.append(card);
}

export async function updateNow(update = pending) {
  if (installing || !update) return;
  installing = true;
  hideCard();
  const bar = h("div", { class: "progress up-progress", role: "progressbar", "aria-label": "Update progress", "aria-valuemin": "0", "aria-valuemax": "100" }, h("div", { class: "progress-fill indeterminate" }));
  const status = h("p", { class: "up-status", "aria-live": "polite" }, "downloading the update…");
  const actions = h("div", { class: "sheet-actions", hidden: true });
  const dialog = h(
    "dialog",
    { class: "sheet up-sheet", "aria-labelledby": "up-title" },
    h(
      "div",
      { class: "up-body" },
      h("img", { src: "shared/branch-mark.svg", alt: "", width: "52", height: "52" }),
      h("h2", { class: "sheet-title", id: "up-title" }, `Updating to Branch ${update.version}`),
      notesBlock(update),
      bar,
      status,
    ),
    actions,
  );
  dialog.addEventListener("cancel", (e) => e.preventDefault());
  document.body.append(dialog);
  dialog.showModal();
  const fill = bar.firstChild;
  try {
    await installUpdate((received, total) => {
      if (total) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        fill.classList.remove("indeterminate");
        fill.style.width = `${pct}%`;
        bar.setAttribute("aria-valuenow", String(pct));
        status.textContent = pct >= 100 ? "installing… Branch will restart in a moment." : `downloading… ${formatMb(received)} of ${formatMb(total)}`;
      } else {
        status.textContent = `downloading… ${formatMb(received)}`;
      }
    });
    fill.classList.remove("indeterminate");
    fill.style.width = "100%";
    status.textContent = canUpdate ? "installing… Branch will restart in a moment." : "update installed. this preview can't restart, so close and reopen it.";
    if (!canUpdate) {
      actions.replaceChildren(h("button", { class: "btn btn-primary", type: "button", onclick: () => { dialog.close(); dialog.remove(); installing = false; } }, "Done"));
      actions.hidden = false;
    }
  } catch (err) {
    installing = false;
    fill.classList.remove("indeterminate");
    fill.style.width = "0%";
    status.textContent = err.message || "the update couldn't be installed.";
    status.classList.add("up-error");
    actions.replaceChildren(
      h("button", { class: "btn", type: "button", onclick: () => { dialog.close(); dialog.remove(); } }, "Not now"),
      h("button", { class: "btn btn-primary", type: "button", onclick: () => { dialog.close(); dialog.remove(); updateNow(update); } }, icon("refresh"), "Try again"),
    );
    actions.hidden = false;
  }
}

export async function checkNow({ manual = false, atStartup = false } = {}) {
  if (!updatesSupported()) return null;
  try {
    const update = await checkForUpdate();
    pending = update;
    if (!update) {
      hideCard();
      if (manual) toast(`you're on the newest version (${await appVersion()})`, { tone: "ok" });
      return null;
    }
    if (atStartup && autoUpdate()) updateNow(update);
    else if (manual) updateNow(update);
    else showCard(update);
    return update;
  } catch (err) {
    if (manual) toast(err.message || "couldn't check for updates", { tone: "error" });
    return null;
  }
}

export function startUpdater() {
  if (!updatesSupported()) return;
  setTimeout(() => checkNow({ atStartup: true }), 1500);
  setInterval(() => checkNow(), CHECK_EVERY);
}
