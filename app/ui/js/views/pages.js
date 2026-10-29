// settings, about and the legal pages.
import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { appVersion, isDesktop } from "../platform.js";
import { settings, favorites, recent } from "../store.js";
import { confirmDialog, toast, stateBlock } from "../ui.js";

export const REPO_URL = "https://github.com/drifteddd/gt-mod-finder";

export function createSettingsView(ctx) {
  const el = h("section", { class: "view page", "aria-labelledby": "settings-title" });

  function render() {
    const current = settings.get();
    const themes = [["system", "Match Windows"], ["light", "Light"], ["dark", "Dark"]];
    const themeGroup = h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-labelledby": "appearance-label" },
      themes.map(([value, label]) =>
        h("label", null, h("input", { type: "radio", name: "theme", value, checked: current.theme === value, onchange: () => ctx.applyTheme(value) }), h("span", null, label)),
      ),
    );
    const motion = h("input", { type: "checkbox", id: "reduce-motion", checked: current.reduceMotion, onchange: (e) => ctx.applyMotion(e.target.checked) });

    clear(el).append(
      h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "settings-title" }, "Settings")),
      group(
        "Appearance",
        row(h("span", { id: "appearance-label" }, "Theme"), themeGroup),
        row(h("label", { for: "reduce-motion" }, "Reduce motion", h("span", { class: "row-hint" }, "Windows' animation setting is always followed too.")), h("span", { class: "switch" }, motion)),
      ),
      group(
        "Downloads",
        h("p", { class: "group-text" }, "Branch asks where to save every download. files are never opened, installed or run for you, and Branch never asks for administrator access."),
      ),
      group(
        "Saved on this computer",
        row(h("span", null, "Favorites", h("span", { class: "row-hint" }, `${favorites.list().length} saved`)), h("button", { class: "btn btn-danger", type: "button", onclick: clearFavorites }, "Clear favorites")),
        row(h("span", null, "Recently viewed", h("span", { class: "row-hint" }, `${recent.list().length} saved`)), h("button", { class: "btn btn-danger", type: "button", onclick: clearRecent }, "Clear history")),
      ),
    );
  }

  async function clearFavorites() {
    const ok = await confirmDialog({ title: "Clear all favorites?", message: "this removes every favorite saved on this computer. it can't be undone.", confirmLabel: "Clear favorites", destructive: true });
    if (!ok) return;
    favorites.clear();
    toast("Favorites cleared");
    render();
  }

  async function clearRecent() {
    const ok = await confirmDialog({ title: "Clear recently viewed?", message: "this removes your viewing history from this computer.", confirmLabel: "Clear history", destructive: true });
    if (!ok) return;
    recent.clear();
    toast("History cleared");
    render();
  }

  return { el, title: () => "Settings", show() { render(); return 0; }, hide() {} };
}

export function createAboutView(ctx) {
  const version = h("span");
  appVersion().then((v) => { version.textContent = v; });

  const el = h(
    "section",
    { class: "view page about", "aria-labelledby": "about-title" },
    h(
      "div",
      { class: "about-hero" },
      h("img", { src: "shared/branch-mark.svg", alt: "", width: "88", height: "88" }),
      h("h1", { class: "view-title", id: "about-title" }, "Branch"),
      h("p", { class: "muted" }, "Version ", version),
      h("p", { class: "made-by" }, "made by Drifted"),
    ),
    group(
      null,
      h("p", { class: "group-text" }, "Branch is a free app for finding Gorilla Tag mods. you can search, read about a mod, and download it in a couple of clicks."),
      h(
        "p",
        { class: "group-text" },
        "Branch is an independent project. it isn't made by, endorsed by, or connected to Another Axiom or the Gorilla Tag team. mods are made by their own authors, not by Branch.",
      ),
    ),
    group(
      "Before you use mods",
      h(
        "ul",
        { class: "plain-list" },
        h("li", null, "mods can break your game or stop working after an update. back up your game files first."),
        h("li", null, "Branch doesn't scan or guarantee any file. only use mods from authors you trust."),
        h("li", null, "using mods in public lobbies can break the game's rules and could get your account banned. that's on the person using the mod."),
      ),
    ),
    group(
      "More",
      linkRow("#/legal/privacy", "Privacy notice"),
      linkRow("#/legal/terms", "Terms of use"),
      linkRow("#/legal/takedown", "Copyright and takedown requests"),
      linkRow("#/legal/licenses", "Licenses and credits"),
      h("div", { class: "settings-row" }, h("span", null, "Source code"), h("a", { href: REPO_URL, "data-external": true }, "GitHub", icon("external", "inline-icon"))),
    ),
  );

  return { el, title: () => "About", show() { return 0; }, hide() {} };
}

const LEGAL_DOCS = {
  privacy: "Privacy notice",
  terms: "Terms of use",
  takedown: "Copyright and takedown requests",
  licenses: "Licenses and credits",
};

export function createLegalView(ctx) {
  const el = h("section", { class: "view page legal" });
  const cache = new Map();

  async function show(params) {
    const doc = params.doc;
    if (!LEGAL_DOCS[doc]) {
      clear(el).append(stateBlock({ iconName: "info", title: "Page not found", actions: [ctx.link("#/about", "Back to About")] }));
      return 0;
    }
    ctx.setTitle(LEGAL_DOCS[doc]);
    clear(el).append(h("div", { class: "skeleton sk-title-lg" }));
    try {
      if (!cache.has(doc)) {
        const res = await fetch(`legal/${doc}.md`);
        if (!res.ok) throw new Error();
        cache.set(doc, await res.text());
      }
      clear(el).append(h("article", { class: "prose legal-doc", html: renderMarkdown(cache.get(doc)) }));
    } catch {
      clear(el).append(stateBlock({ iconName: "alert", title: "Couldn't open this page", message: `you can read it on GitHub instead: ${REPO_URL}` }));
    }
    return 0;
  }

  return { el, title: () => "Legal", show, hide() {} };
}

function group(title, ...content) {
  return h("section", { class: "settings-group" }, title ? h("h2", null, title) : null, h("div", { class: "group-card" }, ...content));
}

function row(label, control) {
  return h("div", { class: "settings-row" }, label, control);
}

function linkRow(href, label) {
  return h("a", { class: "settings-row link-row", href }, h("span", null, label), icon("chevronRight", "row-chevron"));
}

export { isDesktop };
