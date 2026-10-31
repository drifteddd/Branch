import { h } from "./dom.js";
import { icon } from "./icons.js";

const KEY = "branch.storySeen";

function seen() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function showStoryOnce() {
  if (seen()) return Promise.resolve();
  return showStory();
}

export function showStory({ again = false } = {}) {
  return new Promise((resolve) => {
    const point = (iconName, title, text) => h("li", null, h("span", { class: "story-icon" }, icon(iconName)), h("div", null, h("strong", null, title), h("p", null, text)));
    const go = h("button", { class: "btn btn-primary btn-large", type: "button" }, again ? "Close" : "Let's go");
    const dialog = h(
      "dialog",
      { class: "sheet story-sheet", "aria-labelledby": "story-title" },
      h(
        "div",
        { class: "story-body" },
        h("img", { src: "shared/branch-mark.svg", alt: "", width: "56", height: "56" }),
        h("h2", { class: "sheet-title", id: "story-title" }, "why i made branch"),
        h(
          "p",
          { class: "story-lead" },
          "branch is a free, privacy-first home for gorilla tag mods. the goal is to make it the biggest place to find and share mods, without ever asking you for anything in return.",
        ),
        h(
          "ul",
          { class: "story-points" },
          point("shield", "private by design", "no accounts. no personal data stored. no tracking. it never asks for admin access on your pc, and your favorites and settings stay on your computer."),
          point("sparkle", "way more than a mod list", "a safety check for every file, the tree of life, a live player tracker, a community forum and chat, and an ai assistant that knows every mod on branch."),
          point("gift", "free, for everyone", "i pay for the servers, the ai and everything else, so all of it stays free."),
          point("chat", "run by the community", "i built the app (with a lot of help from ai, to be honest), but you're the ones who add the mods and help it grow."),
        ),
        h(
          "p",
          { class: "story-note" },
          "branch is also my way of making up for ii engine, an app i made before that collected data it didn't need without asking. this time it's the opposite.",
        ),
        h("p", { class: "story-sign" }, "thanks for being here.", h("br"), "drifted"),
      ),
      h("div", { class: "sheet-actions" }, go),
    );
    const finish = () => {
      try {
        localStorage.setItem(KEY, "1");
      } catch {}
      dialog.close();
      dialog.remove();
      resolve();
    };
    go.addEventListener("click", finish);
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    document.body.append(dialog);
    dialog.showModal();
    go.focus();
  });
}
