import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { appVersion, assetUrl, isDesktop, openExternal } from "../platform.js";
import { showStory } from "../story.js";
import { AMBIENT_STYLES } from "../ambient.js";
import { checkNow, updatesSupported } from "../updater.js";
import { runOnboarding } from "../onboarding.js";

function adminDoor() {
  const img = h("img", { src: "shared/branch-mark.svg", alt: "", width: "88", height: "88", class: "about-icon" });
  let clicks = 0;
  let timer;
  img.addEventListener("click", () => {
    clicks += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 1500);
    if (clicks >= 7) {
      clicks = 0;
      toast("Opening the admin panel in your browser");
      openExternal(new URL(assetUrl("/admin"), location.href).href).catch(() => toast("couldn't open your browser", { tone: "error" }));
    }
  });
  return img;
}
import { settings, favorites, recent } from "../store.js";
import { myIdentity, rename as renameIdentity, randomName as randomIdentityName } from "../forum-identity.js";
import { confirmDialog, toast, stateBlock } from "../ui.js";

export const REPO_URL = "https://github.com/drifteddd/Branch";
export const CONTACT_EMAIL = "drifted1000@outlook.com";
export const DISCORD_URL = "https://discord.gg/ycCMckZ2N";

export function createSettingsView(ctx) {
  const el = h("section", { class: "view page", "aria-labelledby": "settings-title" });

  function render() {
    const current = settings.get();
    const themes = [["light", "Light"], ["dark", "Dark"], ["system", "Match Windows"]];
    const themeGroup = h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-labelledby": "appearance-label" },
      themes.map(([value, label]) =>
        h("label", null, h("input", { type: "radio", name: "theme", value, checked: current.theme === value, onchange: () => ctx.applyTheme(value) }), h("span", null, label)),
      ),
    );
    const motion = h("input", { type: "checkbox", id: "reduce-motion", checked: current.reduceMotion, onchange: (e) => ctx.applyMotion(e.target.checked) });
    const ambientGroup = h(
      "div",
      { class: "ambient-picker", role: "radiogroup", "aria-labelledby": "ambient-label" },
      AMBIENT_STYLES.map(([value, label, look]) => {
        const swatch = h("span", { class: `ambient-swatch${value === "off" ? " is-off" : ""}`, "aria-hidden": "true" });
        if (look !== "none") swatch.style.backgroundImage = look;
        return h("label", { class: "ambient-tile" }, h("input", { type: "radio", name: "ambient", value, checked: (current.ambient || "off") === value, onchange: () => ctx.applyAmbient(value) }), swatch, h("span", { class: "ambient-name" }, label));
      }),
    );

    clear(el).append(
      h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "settings-title" }, "Settings")),
      group(
        "Appearance",
        row(h("span", { id: "appearance-label" }, "Theme"), themeGroup),
        h("div", { class: "settings-row ambient-row" }, h("span", { id: "ambient-label" }, "Animated background", h("span", { class: "row-hint" }, "a moving background behind the app. it pauses when Branch is minimized.")), ambientGroup),
        row(h("label", { for: "reduce-motion" }, "Reduce motion", h("span", { class: "row-hint" }, "Windows' animation setting is always followed too.")), h("span", { class: "switch" }, motion)),
      ),
      updatesGroup(current),
      group(
        "Setup",
        row(h("span", null, "Run setup again", h("span", { class: "row-hint" }, "pick a name and background, get mod suggestions and take the tour again.")), h("button", { class: "btn", type: "button", onclick: async () => { await runOnboarding(ctx); render(); } }, icon("sparkle"), "Start setup")),
      ),
      group(
        "Community name",
        communityRow(),
        h("p", { class: "group-text small" }, "this is the name people see on your community posts. there's no account: Branch keeps a secret key on this computer instead, so if you clear it you'll get a new name."),
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

  function updatesGroup(current) {
    const version = h("span", { class: "row-hint" }, "version …");
    appVersion().then((v) => { version.textContent = `version ${v}`; });
    if (!updatesSupported()) {
      return group("Updates", row(h("span", null, "Branch", version), h("span", { class: "muted small" }, "updates work in the desktop app")));
    }
    const auto = h("input", { type: "checkbox", id: "auto-update", checked: current.autoUpdate !== false, onchange: (e) => settings.set({ autoUpdate: e.target.checked }) });
    const check = h("button", { class: "btn", type: "button" }, icon("refresh"), "Check for updates");
    check.addEventListener("click", async () => {
      check.disabled = true;
      check.lastChild.textContent = "Checking…";
      await checkNow({ manual: true });
      check.disabled = false;
      check.lastChild.textContent = "Check for updates";
    });
    return group(
      "Updates",
      row(h("span", null, "Branch", version), check),
      row(h("label", { for: "auto-update" }, "Update automatically", h("span", { class: "row-hint" }, "installs new versions when Branch starts. otherwise you'll be asked first.")), h("span", { class: "switch" }, auto)),
    );
  }

  function communityRow() {
    const input = h("input", { class: "input", id: "community-name", maxlength: "24", autocomplete: "off", "aria-describedby": "community-name-error" });
    const tag = h("span", { class: "post-tag" }, "");
    const error = h("p", { class: "error", id: "community-name-error", hidden: true });
    const save = h("button", { class: "btn btn-primary", type: "button" }, "Save name");
    const random = h("button", { class: "btn", type: "button" }, "Random name");
    const show = (me) => {
      input.value = me.name;
      tag.textContent = `#${me.tag}`;
    };
    myIdentity().then(show).catch(() => {
      error.textContent = "couldn't reach the community right now.";
      error.hidden = false;
    });
    const run = async (task, message) => {
      error.hidden = true;
      try {
        show(await task());
        toast(message, { tone: "ok" });
      } catch (err) {
        error.textContent = err.fields?.name || err.message;
        error.hidden = false;
      }
    };
    save.addEventListener("click", () => run(() => renameIdentity(input.value.trim()), "Name saved"));
    random.addEventListener("click", () => run(randomIdentityName, "New random name"));
    return h(
      "div",
      { class: "settings-row community-row" },
      h("label", { for: "community-name" }, "Your name", h("span", { class: "row-hint" }, "3 to 24 letters, numbers, spaces, - or _")),
      h("div", { class: "community-controls" }, h("div", { class: "name-input" }, input, tag), h("div", { class: "community-buttons" }, random, save), error),
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
      adminDoor(),
      h("h1", { class: "view-title", id: "about-title" }, "Branch"),
      h("p", { class: "muted" }, "Version ", version),
      h("p", { class: "made-by" }, "made by Drifted"),
      h("button", { class: "btn about-story", type: "button", onclick: () => showStory({ again: true }) }, icon("info"), "Why I made Branch"),
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
      linkRow("#/legal/privacy", "Privacy Notice"),
      linkRow("#/legal/terms", "Terms of Use"),
      linkRow("#/legal/takedown", "Copyright and Takedown Policy"),
      linkRow("#/legal/licenses", "Licenses and Credits"),
      h("div", { class: "settings-row" }, h("span", null, "Discord server"), h("a", { href: DISCORD_URL, "data-external": true }, "Join the Discord", icon("external", "inline-icon"))),
      h("div", { class: "settings-row" }, h("span", null, "Contact"), h("span", { class: "muted contact-email" }, CONTACT_EMAIL)),
      h("div", { class: "settings-row" }, h("span", null, "Source code"), h("a", { href: REPO_URL, "data-external": true }, "GitHub", icon("external", "inline-icon"))),
    ),
  );

  return { el, title: () => "About", show() { return 0; }, hide() {} };
}

const LEGAL_DOCS = {
  privacy: "Privacy Notice",
  terms: "Terms of Use",
  takedown: "Copyright and Takedown Policy",
  licenses: "Licenses and Credits",
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
