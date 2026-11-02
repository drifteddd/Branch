import { h } from "./dom.js";
import { icon } from "./icons.js";
import { api } from "./platform.js";
import { toast } from "./ui.js";

const KEY = "branch.ratePrompts";
const WAIT = 2 * 24 * 3600 * 1000;
const KEEP = 60;
let shownThisSession = false;

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function write(value) {
  try {
    const entries = Object.entries(value).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
  }
}

export function recordDownload(mod) {
  const all = read();
  if (all[mod.slug]) return;
  all[mod.slug] = { name: mod.name, at: Date.now(), done: Boolean(mod.my_rating) };
  write(all);
}

export function markRated(slug) {
  const all = read();
  if (!all[slug]) return;
  all[slug].done = true;
  write(all);
}

export function checkRatePrompt() {
  if (shownThisSession || document.querySelector("dialog[open], .rate-prompt")) return;
  const all = read();
  const due = Object.entries(all).find(([, d]) => !d.done && Date.now() - d.at >= WAIT);
  if (!due) return;
  const [slug, entry] = due;
  entry.done = true;
  write(all);
  shownThisSession = true;
  showPrompt(slug, entry.name);
}

function showPrompt(slug, name) {
  const close = () => {
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 200);
  };
  const stars = h(
    "div",
    { class: "rate-prompt-stars", role: "group", "aria-label": `Rate ${name}` },
    [1, 2, 3, 4, 5].map((n) =>
      h("button", { type: "button", class: "rate-prompt-star", "aria-label": `${n} ${n === 1 ? "star" : "stars"}`, dataset: { stars: String(n) }, onclick: () => rate(n) }, icon("star")),
    ),
  );
  stars.addEventListener("mouseover", (e) => {
    const n = Number(e.target.closest("[data-stars]")?.dataset.stars || 0);
    for (const b of stars.children) b.classList.toggle("lit", Number(b.dataset.stars) <= n);
  });
  stars.addEventListener("mouseleave", () => { for (const b of stars.children) b.classList.remove("lit"); });

  async function rate(n) {
    for (const b of stars.children) b.disabled = true;
    try {
      await api(`/api/mods/${encodeURIComponent(slug)}/rating`, { method: "POST", body: { stars: n } });
      toast(`Thanks for rating ${name}!`, { tone: "ok" });
      close();
    } catch (err) {
      toast(err.message || "couldn't save your rating", { tone: "error" });
      for (const b of stars.children) b.disabled = false;
    }
  }

  const card = h(
    "aside",
    { class: "rate-prompt", role: "dialog", "aria-label": `Rate ${name}` },
    h("button", { class: "rate-prompt-close", type: "button", "aria-label": "Close", onclick: close }, icon("close")),
    h("p", { class: "rate-prompt-title" }, "How's ", h("a", { href: `#/mod/${encodeURIComponent(slug)}`, onclick: close }, name), "?"),
    h("p", { class: "muted small" }, "you downloaded it a couple of days ago. a quick rating helps other players find good mods."),
    stars,
    h("button", { class: "btn btn-quiet btn-small rate-prompt-later", type: "button", onclick: close }, "Not now"),
  );
  document.body.append(card);
}
