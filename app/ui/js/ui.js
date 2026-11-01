import { h, clear } from "./dom.js";
import { icon, ICONS } from "./icons.js";
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


const COVER_STYLES = {
  cosmetics: { icon: "sparkle", pattern: "sparkles" },
  gameplay: { icon: "flame", pattern: "stripes" },
  utilities: { icon: "sliders", pattern: "dots" },
  maps: { icon: "compass", pattern: "contours" },
  libraries: { icon: "layers", pattern: "blocks" },
};

function hashText(text) {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function wrapName(name, max) {
  const words = name.replace(/\s*\((demo)\)\s*$/i, "").split(/\s+/).filter(Boolean);
  const lines = [""];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (!line) lines[lines.length - 1] = word;
    else if ((line + " " + word).length <= max) lines[lines.length - 1] = line + " " + word;
    else lines.push(word);
  }
  if (lines.length > 2) {
    lines.length = 2;
    lines[1] = lines[1].slice(0, max - 1) + "…";
  }
  return lines.map((l) => (l.length > max ? l.slice(0, max - 1) + "…" : l));
}

export function modCover(mod, className = "thumb") {
  const name = (mod?.name || "Mod").trim();
  const slug = typeof mod?.category === "string" ? mod.category.toLowerCase() : mod?.category?.slug || "";
  const style = COVER_STYLES[slug] || { icon: "box", pattern: "blobs" };
  const seed = hashText(name);
  const hue = seed % 360;
  const hue2 = (hue + 35 + (seed >> 9) % 50) % 360;
  const id = "cv" + seed.toString(36) + Math.random().toString(36).slice(2, 6);
  const ns = "http://www.w3.org/2000/svg";
  const rand = (i) => ((seed >> (i % 24)) ^ (seed * (i + 7))) >>> 0;
  let pattern = "";
  if (style.pattern === "stripes") {
    for (let i = -4; i < 14; i++) pattern += `<path d="M${i * 34} 190 L${i * 34 + 110} -10" stroke="#fff" stroke-opacity="0.07" stroke-width="12"/>`;
  } else if (style.pattern === "dots") {
    for (let x = 12; x < 320; x += 22) for (let y = 12; y < 180; y += 22) pattern += `<circle cx="${x}" cy="${y}" r="1.8" fill="#fff" fill-opacity="0.13"/>`;
  } else if (style.pattern === "contours") {
    const cx = 200 + (rand(1) % 80), cy = 60 + (rand(2) % 60);
    for (let r = 18; r < 260; r += 22) pattern += `<ellipse cx="${cx}" cy="${cy}" rx="${r * 1.4}" ry="${r}" fill="none" stroke="#fff" stroke-opacity="0.09" stroke-width="1.5"/>`;
  } else if (style.pattern === "blocks") {
    for (let i = 0; i < 9; i++) {
      const s = 26 + (rand(i) % 30);
      pattern += `<rect x="${150 + (rand(i + 3) % 170)}" y="${(rand(i + 5) % 170) - 20}" width="${s}" height="${s}" rx="6" fill="#fff" fill-opacity="${0.05 + (i % 3) * 0.03}" transform="rotate(${(rand(i) % 30) - 15} 240 90)"/>`;
    }
  } else if (style.pattern === "sparkles") {
    for (let i = 0; i < 12; i++) {
      const x = 20 + (rand(i) % 290), y = 10 + (rand(i + 11) % 160), s = 3 + (rand(i + 2) % 7);
      pattern += `<path d="M${x} ${y - s}c.6 ${s * 0.7} ${s * 0.3} ${s} ${s} ${s}-${s * 0.7}.3-${s} ${s * 0.3}-${s} ${s}-.3-${s * 0.7}-${s * 0.3}-${s}-${s}-${s} ${s * 0.7}-.3 ${s}-${s * 0.3} ${s}-${s}z" fill="#fff" fill-opacity="0.18"/>`;
    }
  } else {
    for (let i = 0; i < 4; i++) pattern += `<circle cx="${rand(i) % 320}" cy="${rand(i + 4) % 180}" r="${40 + (rand(i + 8) % 70)}" fill="#fff" fill-opacity="0.06"/>`;
  }
  const long = name.length > 28;
  const max = long ? 20 : 15;
  const size = long ? 25 : 31;
  const lines = wrapName(name, max);
  const escape = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const textY = 180 - 22 - (lines.length - 1) * (size * 1.08);
  const text = lines.map((l, i) => `<tspan x="22" y="${(textY + i * size * 1.08).toFixed(1)}">${escape(l)}</tspan>`).join("");
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 320 180");
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  svg.setAttribute("class", `${className} thumb-gen`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", name);
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 62% 46%)"/><stop offset="1" stop-color="hsl(${hue2} 68% 26%)"/></linearGradient><radialGradient id="${id}g" cx="0.85" cy="0.1" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.38"/></linearGradient></defs><rect width="320" height="180" fill="url(#${id})"/><rect width="320" height="180" fill="url(#${id}g)"/>${pattern}<g transform="translate(212 18) scale(4.4)" fill="none" stroke="#fff" stroke-opacity="0.32" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[style.icon] || ""}</g><rect width="320" height="180" fill="url(#${id}s)"/><text fill="#fff" font-size="${size}" font-weight="750" letter-spacing="-0.5" style="font-family: var(--font-display)">${text}</text>`;
  return svg;
}

export function thumbnail(path, className = "thumb", mod = null) {
  const url = assetUrl(path);
  if (!url && mod) return modCover(mod, className);
  if (!url) {
    return h("div", { class: `${className} thumb-empty`, "aria-hidden": "true" }, h("img", { src: "shared/branch-mark.svg", alt: "" }));
  }
  const img = h("img", { class: className, src: url, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(thumbnail(null, className, mod)), { once: true });
  return img;
}

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
