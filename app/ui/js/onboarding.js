import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { api, assetUrl } from "./platform.js";
import { settings, favorites } from "./store.js";
import { myIdentity, rename, randomName } from "./forum-identity.js";
import { AMBIENT_STYLES } from "./ambient.js";

const DONE_KEY = "branch.onboarded";

const HEARD = [
  ["drifted", "From Drifted"],
  ["friend", "A friend"],
  ["discord", "A Discord server"],
  ["video", "A video (YouTube, TikTok)"],
  ["search", "Searching online"],
  ["forum", "A forum or website"],
  ["other", "Something else"],
];

const USES = [
  ["find", "Finding mods", "search"],
  ["upload", "Uploading my mods", "upload"],
  ["tracker", "The player tracker", "radar"],
  ["community", "Community and chat", "chat"],
  ["checker", "Checking mods for viruses", "shield"],
  ["assistant", "Asking the AI", "sparkle"],
  ["rewards", "Earning rewards", "gift"],
];

const INTERESTS = [
  ["cosmetics", "Cosmetics"],
  ["movement", "Movement"],
  ["menus", "Mod menus"],
  ["maps", "Custom maps"],
  ["visuals", "Visual effects"],
  ["sounds", "Sounds"],
  ["utilities", "Utilities"],
  ["quality", "Quality of life"],
  ["fun", "Fun and silly"],
  ["competitive", "Competitive"],
  ["camera", "Camera and recording"],
  ["performance", "Performance"],
  ["hands", "Hand trails and gloves"],
  ["hud", "HUD and info"],
  ["social", "Social and lobbies"],
  ["libraries", "Libraries for other mods"],
];

const TOUR = [
  { use: "find", selector: '[data-nav="all"]', title: "All mods", text: "every mod on Branch, best rated first. filter by category or compatibility." },
  { use: "find", selector: "#search", title: "Search", text: "find any mod by name, author or tag. press Ctrl+F from anywhere." },
  { use: "find", selector: '[data-nav="tree"]', title: "Tree of Life", text: "every mod drawn as a node on one big tree. zoom in and explore." },
  { use: "tracker", selector: '[data-nav="tracker"]', title: "Player Tracker", text: "a live stream of players spotted in public rooms. free beta." },
  { use: "assistant", selector: '[data-nav="ask"]', title: "Ask Branch", text: "a free AI that knows every mod, the app and the tracker." },
  { use: "upload", selector: '[data-nav="upload"]', title: "Upload a mod", text: "share your own mod. just drop the file and the AI sets up the listing." },
  { use: "checker", selector: '[data-nav="check"]', title: "Mod checker", text: "check any .dll for viruses and stealers before you use it." },
  { use: "community", selector: '[data-nav="forum"]', title: "Community", text: "a forum and one big live chat. no account needed." },
  { use: "rewards", selector: '[data-nav="rewards"]', title: "Rewards", text: "upload unique mods and earn Robux while the program runs." },
  { use: null, selector: '[data-nav="inbox"]', title: "Inbox", text: "announcements, what's new in each update, and replies to your reports." },
  { use: null, selector: '[data-nav="settings"]', title: "Settings", text: "change your name, theme and background any time. you can run this setup again here too." },
];

export function onboardingDone() {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true;
  }
}

function saveLocal(key, value) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {}
}

export function runOnboardingOnce(ctx) {
  if (onboardingDone()) return Promise.resolve();
  return runOnboarding(ctx);
}

export function runOnboarding(ctx) {
  return new Promise((resolve) => {
    const answers = { heard_from: "", heard_other: "", uses: [], interests: [] };
    let step = 0;
    const body = h("div", { class: "ob-body" });
    const dots = h("div", { class: "ob-dots", "aria-hidden": "true" });
    const back = h("button", { class: "btn btn-quiet", type: "button" }, "Back");
    const next = h("button", { class: "btn btn-primary", type: "button" }, "Next");
    const skipStep = h("button", { class: "btn btn-quiet ob-skip-step", type: "button" }, "Skip this step");
    const skipAll = h("button", { class: "ob-skip-all", type: "button" }, "Skip setup");
    const dialog = h(
      "dialog",
      { class: "sheet ob-sheet", "aria-labelledby": "ob-title" },
      h("div", { class: "ob-top" }, dots, skipAll),
      body,
      h("div", { class: "sheet-actions ob-actions" }, back, h("span", { class: "grow" }), skipStep, next),
    );

    const finish = (tour) => {
      saveLocal(DONE_KEY, "1");
      saveLocal("branch.uses", answers.uses);
      saveLocal("branch.interests", answers.interests);
      if (answers.heard_from || answers.uses.length) {
        api("/api/onboarding", { method: "POST", body: { heard_from: answers.heard_from, heard_other: answers.heard_other, uses: answers.uses } }).catch(() => {});
      }
      dialog.close();
      dialog.remove();
      if (tour) runTour(answers.uses).then(resolve);
      else resolve();
    };
    skipAll.addEventListener("click", () => finish(false));
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });

    const chip = (label, selected, onToggle, iconName) => {
      const b = h("button", { class: `ob-chip${selected ? " on" : ""}`, type: "button", "aria-pressed": String(selected) }, iconName ? icon(iconName) : null, label);
      b.addEventListener("click", () => {
        const on = onToggle();
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
      return b;
    };

    const steps = [
      {
        kind: "welcome",
        render() {
          return [
            h("img", { class: "ob-mark", src: "shared/branch-mark.svg", alt: "", width: "64", height: "64" }),
            h("h2", { class: "sheet-title", id: "ob-title" }, "let's set up Branch"),
            h("p", { class: "ob-lead" }, "it takes about a minute: pick a name and a look, tell us what you're into, and we'll find a few mods to start with. you can skip anything."),
          ];
        },
        next: "Let's go",
      },
      {
        kind: "name",
        render() {
          const input = h("input", { class: "input ob-name", id: "ob-name", maxlength: "24", autocomplete: "off", "aria-describedby": "ob-name-error" });
          const tag = h("span", { class: "post-tag" });
          const error = h("p", { class: "error", id: "ob-name-error", hidden: true });
          const random = h("button", { class: "btn", type: "button" }, icon("refresh"), "Random name");
          myIdentity().then((me) => { input.value = me.name; input.dataset.original = me.name; tag.textContent = `#${me.tag}`; }).catch(() => {});
          random.addEventListener("click", async () => {
            error.hidden = true;
            try {
              const me = await randomName();
              input.value = me.name;
              input.dataset.original = me.name;
              tag.textContent = `#${me.tag}`;
            } catch (err) {
              error.textContent = err.message;
              error.hidden = false;
            }
          });
          this.save = async () => {
            const value = input.value.trim();
            if (!value || value === input.dataset.original) return true;
            try {
              await rename(value);
              return true;
            } catch (err) {
              error.textContent = err.fields?.name || err.message;
              error.hidden = false;
              input.focus();
              return false;
            }
          };
          setTimeout(() => input.focus(), 50);
          return [
            h("h2", { class: "sheet-title", id: "ob-title" }, "pick a name"),
            h("p", { class: "ob-lead" }, "this is what people see in the community and chat. no account, no email. skip it and you keep a random one."),
            h("div", { class: "ob-name-row" }, h("div", { class: "name-input" }, input, tag), random),
            error,
          ];
        },
      },
      {
        kind: "look",
        render() {
          const current = settings.get();
          const theme = h(
            "div",
            { class: "segmented", role: "radiogroup", "aria-label": "Theme" },
            [["light", "Light"], ["dark", "Dark"], ["system", "Match Windows"]].map(([value, label]) =>
              h("label", null, h("input", { type: "radio", name: "ob-theme", value, checked: current.theme === value, onchange: () => ctx.applyTheme(value) }), h("span", null, label)),
            ),
          );
          const tiles = h(
            "div",
            { class: "ambient-picker ob-ambient", role: "radiogroup", "aria-label": "Background" },
            AMBIENT_STYLES.map(([value, label, look]) => {
              const swatch = h("span", { class: `ambient-swatch${value === "off" ? " is-off" : ""}`, "aria-hidden": "true" });
              if (look !== "none") swatch.style.backgroundImage = look;
              return h("label", { class: "ambient-tile" }, h("input", { type: "radio", name: "ob-ambient", value, checked: (current.ambient || "off") === value, onchange: () => ctx.applyAmbient(value) }), swatch, h("span", { class: "ambient-name" }, label));
            }),
          );
          return [
            h("h2", { class: "sheet-title", id: "ob-title" }, "make it yours"),
            h("p", { class: "ob-lead" }, "pick a theme and an animated background. you'll see it change behind this window."),
            h("div", { class: "ob-field" }, h("span", { class: "ob-label" }, "Theme"), theme),
            h("div", { class: "ob-field" }, h("span", { class: "ob-label" }, "Background"), tiles),
          ];
        },
        see: true,
      },
      {
        kind: "heard",
        render() {
          const other = h("input", { class: "input", id: "ob-heard-other", maxlength: "40", placeholder: "where? (optional)", hidden: answers.heard_from !== "other", value: answers.heard_other });
          other.addEventListener("input", () => { answers.heard_other = other.value; });
          const group = h("div", { class: "ob-chips" });
          const draw = () =>
            clear(group).append(
              ...HEARD.map(([value, label]) =>
                chip(label, answers.heard_from === value, () => {
                  answers.heard_from = answers.heard_from === value ? "" : value;
                  other.hidden = answers.heard_from !== "other";
                  draw();
                  return answers.heard_from === value;
                }),
              ),
            );
          draw();
          return [
            h("h2", { class: "sheet-title", id: "ob-title" }, "how did you find Branch?"),
            h("p", { class: "ob-lead" }, "optional. it's only counted as an anonymous total, so Drifted knows what's working."),
            group,
            other,
          ];
        },
      },
      {
        kind: "uses",
        render() {
          return [
            h("h2", { class: "sheet-title", id: "ob-title" }, "what will you use Branch for?"),
            h("p", { class: "ob-lead" }, "pick as many as you like. the tour at the end starts with these."),
            h(
              "div",
              { class: "ob-chips ob-uses" },
              USES.map(([value, label, iconName]) =>
                chip(label, answers.uses.includes(value), () => {
                  answers.uses = answers.uses.includes(value) ? answers.uses.filter((u) => u !== value) : [...answers.uses, value];
                  return answers.uses.includes(value);
                }, iconName),
              ),
            ),
          ];
        },
      },
      {
        kind: "interests",
        render() {
          return [
            h("h2", { class: "sheet-title", id: "ob-title" }, "what kind of mods do you like?"),
            h("p", { class: "ob-lead" }, "pick a few and Branch's AI will find some mods for you to start with."),
            h(
              "div",
              { class: "ob-chips ob-interests" },
              INTERESTS.map(([value, label]) =>
                chip(label, answers.interests.includes(value), () => {
                  answers.interests = answers.interests.includes(value) ? answers.interests.filter((i) => i !== value) : [...answers.interests, value];
                  return answers.interests.includes(value);
                }),
              ),
            ),
          ];
        },
        next: "Find mods for me",
      },
      {
        kind: "picks",
        render() {
          const list = h("div", { class: "ob-picks" }, h("div", { class: "ob-thinking" }, h("span", { class: "as-typing" }, h("span"), h("span"), h("span")), "Branch's AI is picking mods for you…"));
          api("/api/onboarding/picks", { method: "POST", body: { interests: answers.interests, uses: answers.uses } })
            .then((data) => {
              if (!data.picks?.length) {
                clear(list).append(h("p", { class: "muted" }, "there aren't any mods on Branch yet. check back soon, or upload your own."));
                return;
              }
              clear(list).append(
                ...data.picks.map((p) => {
                  const fav = h("button", { class: `icon-btn ob-fav${favorites.has(p.slug) ? " on" : ""}`, type: "button", "aria-label": `Favorite ${p.name}`, title: "Add to favorites" }, icon(favorites.has(p.slug) ? "starFill" : "star"));
                  fav.addEventListener("click", () => {
                    const on = favorites.toggle(p.slug);
                    fav.classList.toggle("on", on);
                    fav.replaceChildren(icon(on ? "starFill" : "star"));
                  });
                  const thumb = p.thumbnail_url ? h("img", { class: "ob-pick-thumb", src: assetUrl(p.thumbnail_url), alt: "" }) : h("span", { class: "ob-pick-thumb empty" }, h("img", { src: "shared/branch-mark.svg", alt: "", width: "28", height: "28" }));
                  return h(
                    "div",
                    { class: "ob-pick" },
                    thumb,
                    h(
                      "div",
                      { class: "ob-pick-main" },
                      h("strong", null, p.name),
                      h("p", { class: "ob-pick-reason" }, p.reason || p.summary || ""),
                      h("span", { class: "muted small" }, [p.category, p.rating?.count ? `★ ${p.rating.average.toFixed(1)}` : null].filter(Boolean).join(" · ")),
                    ),
                    fav,
                  );
                }),
                h("p", { class: "muted small ob-picks-note" }, data.source === "ai" ? "picked by Branch's AI from your interests. star the ones you like to save them to Favorites." : "picked from your interests. star the ones you like to save them to Favorites."),
              );
            })
            .catch(() => clear(list).append(h("p", { class: "muted" }, "couldn't load suggestions right now. you can browse every mod in All mods.")));
          return [h("h2", { class: "sheet-title", id: "ob-title" }, "a few mods for you"), list];
        },
        noSkip: true,
      },
      {
        kind: "done",
        render() {
          return [
            h("img", { class: "ob-mark", src: "shared/branch-mark.svg", alt: "", width: "64", height: "64" }),
            h("h2", { class: "sheet-title", id: "ob-title" }, "you're all set"),
            h("p", { class: "ob-lead" }, "want a quick look at where everything is? it takes about 20 seconds."),
          ];
        },
        next: "Show me around",
        last: true,
      },
    ];

    const show = () => {
      const s = steps[step];
      clear(body).append(...s.render.call(s));
      body.dataset.step = s.kind;
      dialog.classList.toggle("ob-see-through", Boolean(s.see));
      clear(dots).append(...steps.map((_, i) => h("span", { class: i === step ? "on" : i < step ? "done" : "" })));
      back.hidden = step === 0;
      skipStep.hidden = step === 0 || s.noSkip || s.last;
      skipStep.textContent = s.last ? "" : "Skip this step";
      next.textContent = s.next || "Next";
      skipAll.textContent = s.last ? "Finish without the tour" : "Skip setup";
      body.scrollTop = 0;
    };

    back.addEventListener("click", () => { if (step > 0) { step -= 1; show(); } });
    skipStep.addEventListener("click", () => { step += 1; show(); });
    next.addEventListener("click", async () => {
      const s = steps[step];
      if (s.save) {
        next.disabled = true;
        const ok = await s.save();
        next.disabled = false;
        if (!ok) return;
      }
      if (s.last) return finish(true);
      step += 1;
      show();
    });

    document.body.append(dialog);
    show();
    dialog.showModal();
    next.focus();
  });
}

export function runTour(uses = []) {
  return new Promise((resolve) => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
    };
    const picked = TOUR.filter((t) => uses.includes(t.use));
    const rest = TOUR.filter((t) => t.use !== null && !uses.includes(t.use));
    const tail = TOUR.filter((t) => t.use === null);
    const stops = [...picked, ...rest.slice(0, Math.max(0, 6 - picked.length)), ...tail].filter((t, i, all) => all.findIndex((x) => x.selector === t.selector) === i).filter((t) => visible(document.querySelector(t.selector)));
    if (!stops.length) return resolve();

    let index = 0;
    const hole = h("div", { class: "tour-hole" });
    const title = h("strong", { class: "tour-title" });
    const text = h("p", { class: "tour-text" });
    const count = h("span", { class: "tour-count" });
    const back = h("button", { class: "btn btn-quiet", type: "button" }, "Back");
    const next = h("button", { class: "btn btn-primary", type: "button" }, "Next");
    const skip = h("button", { class: "tour-skip", type: "button" }, "Skip tour");
    const tip = h("div", { class: "tour-tip", role: "dialog", "aria-live": "polite", "aria-label": "Tour" }, title, text, h("div", { class: "tour-actions" }, count, h("span", { class: "grow" }), back, next), skip);
    const overlay = h("div", { class: "tour-overlay" }, hole, tip);

    const place = () => {
      const stop = stops[index];
      const el = document.querySelector(stop.selector);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = 6;
      Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      title.textContent = stop.title;
      text.textContent = stop.text;
      count.textContent = `${index + 1} of ${stops.length}`;
      back.hidden = index === 0;
      next.textContent = index === stops.length - 1 ? "Done" : "Next";
      const tipW = 300;
      const right = r.right + 18;
      const left = right + tipW < window.innerWidth ? right : Math.max(12, r.left);
      const top = right + tipW < window.innerWidth ? Math.max(12, Math.min(r.top - 8, window.innerHeight - 190)) : Math.min(window.innerHeight - 190, r.bottom + 14);
      Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
      next.focus();
    };
    const end = () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); end(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next.click(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back.click(); }
    };
    next.addEventListener("click", () => { if (index === stops.length - 1) end(); else { index += 1; place(); } });
    back.addEventListener("click", () => { if (index > 0) { index -= 1; place(); } });
    skip.addEventListener("click", end);
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    place();
  });
}
