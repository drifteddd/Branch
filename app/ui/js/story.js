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
  return new Promise((resolve) => {
    const point = (iconName, title, text) => h("li", null, h("span", { class: "story-icon" }, icon(iconName)), h("div", null, h("strong", null, title), h("p", null, text)));
    const go = h("button", { class: "btn btn-primary btn-large", type: "button" }, "Let's go");
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
          "before branch, i made an app called ii engine. i added a telemetry system to it that collected data it didn't need, and it never asked anyone for permission. that wasn't okay, and i didn't want to ever do that again.",
        ),
        h(
          "ul",
          { class: "story-points" },
          point("shield", "built for complete privacy", "no accounts. no personal data stored. no tracking. and it never asks for admin access on your pc. your favorites and settings stay on your computer."),
          point("chat", "run by the community", "i built the app (with a lot of help from ai, to be honest about it), but you're the ones who add the mods and keep branch alive."),
          point("gift", "free, for real", "i pay for the ai, the servers and everything else, so you get the best free experience possible without giving up your privacy."),
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
