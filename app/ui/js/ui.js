// shared interface pieces: toasts, confirm dialogs, empty/error states, badges.
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { assetUrl } from "./platform.js";

export function toast(message, { tone = "neutral", timeout = 3200 } = {}) {
  const host = document.getElementById("toasts");
  const item = h("div", { class: `toast ${tone}` }, tone === "error" ? icon("alert") : tone === "ok" ? icon("check") : null, h("span", null, message));
  host.append(item);
  setTimeout(() => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 250);
  }, timeout);
}

// a modal confirm for destructive actions. resolves true or false.
export function confirmDialog({ title, message, confirmLabel = "Confirm", destructive = false }) {
  return new Promise((resolve) => {
    const cancel = h("button", { class: "btn", type: "button", value: "cancel" }, "Cancel");
    const ok = h("button", { class: destructive ? "btn btn-danger-solid" : "btn btn-primary", type: "button" }, confirmLabel);
    const dialog = h(
      "dialog",
      { class: "sheet", "aria-labelledby": "confirm-title" },
      h("div", { class: "sheet-body" }, h("h2", { class: "sheet-title", id: "confirm-title" }, title), message ? h("p", { class: "muted" }, message) : null),
      h("div", { class: "sheet-actions" }, cancel, ok),
    );
    let answer = false;
    cancel.addEventListener("click", () => dialog.close());
    ok.addEventListener("click", () => { answer = true; dialog.close(); });
    dialog.addEventListener("close", () => { dialog.remove(); resolve(answer); });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

// used for empty lists, errors and "not found" pages
export function stateBlock({ iconName = "info", title, message, actions = [] }) {
  return h(
    "div",
    { class: "state-block" },
    h("div", { class: "state-icon" }, icon(iconName)),
    h("h2", null, title),
    message ? h("p", null, message) : null,
    actions.length ? h("div", { class: "state-actions" }, actions) : null,
  );
}

export function errorBlock(err, retry) {
  const offline = err?.kind === "network";
  return stateBlock({
    iconName: "alert",
    title: offline ? "Can't reach Branch right now" : "Something went wrong",
    message: offline
      ? "check your internet connection, then try again. if it keeps happening the Branch server might be down for a bit."
      : err?.message || "the server sent back an error.",
    actions: retry ? [h("button", { class: "btn btn-primary", type: "button", onclick: retry }, icon("refresh"), "Try again")] : [],
  });
}

export function compatBadge(status, meta) {
  const info = meta?.compatibility?.find((c) => c.key === status);
  return h("span", { class: `badge ${status}`, title: info?.description || "" }, info?.label || status);
}

export function thumbnail(path, className = "thumb") {
  const url = assetUrl(path);
  if (!url) {
    return h("div", { class: `${className} thumb-empty`, "aria-hidden": "true" }, h("img", { src: "shared/branch-mark.svg", alt: "" }));
  }
  const img = h("img", { class: className, src: url, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(thumbnail(null, className)), { once: true });
  return img;
}

// explains what each compatibility status means, so badges are never a guess
export function showCompatHelp(meta) {
  const close = h("button", { class: "btn btn-primary", type: "button" }, "Done");
  const dialog = h(
    "dialog",
    { class: "sheet", "aria-labelledby": "compat-title" },
    h(
      "div",
      { class: "sheet-body" },
      h("h2", { class: "sheet-title", id: "compat-title" }, "What compatibility means"),
      h("p", { class: "muted" }, "these labels are set by the Branch admin. they aren't a safety check and they can go out of date when the game updates."),
      h(
        "dl",
        { class: "compat-list" },
        (meta?.compatibility || []).map((c) => [h("dt", null, compatBadge(c.key, meta)), h("dd", null, c.description)]),
      ),
    ),
    h("div", { class: "sheet-actions" }, close),
  );
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export function skeletonRows(count = 6) {
  return Array.from({ length: count }, () =>
    h(
      "li",
      { class: "mod-row skeleton-row", "aria-hidden": "true" },
      h("div", { class: "thumb skeleton" }),
      h("div", { class: "row-main" }, h("div", { class: "skeleton sk-title" }), h("div", { class: "skeleton sk-line" }), h("div", { class: "skeleton sk-meta" })),
    ),
  );
}

export function setBusy(el, busy) {
  el.setAttribute("aria-busy", busy ? "true" : "false");
}

export { clear };
