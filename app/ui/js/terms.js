// the terms screen people have to accept before using branch. it shows right
// after the startup screen the first time, and again whenever the terms change.
import { h } from "./dom.js";
import { renderMarkdown } from "../shared/markdown.js";
import { appWindow, isDesktop } from "./platform.js";

// bump this whenever terms.md or privacy.md change in an important way
export const TERMS_VERSION = 2;
const KEY = "branch.termsAccepted";

export function termsAccepted() {
  try {
    return JSON.parse(localStorage.getItem(KEY))?.version === TERMS_VERSION;
  } catch {
    return false;
  }
}

async function loadDoc(name) {
  try {
    const res = await fetch(`legal/${name}.md`);
    if (!res.ok) throw new Error();
    return renderMarkdown(await res.text());
  } catch {
    return "<p>couldn't load this document. you can read it on github: https://github.com/drifteddd/Branch</p>";
  }
}

export async function requireTerms() {
  if (termsAccepted()) return;
  const [terms, privacy] = await Promise.all([loadDoc("terms"), loadDoc("privacy")]);

  return new Promise((resolve) => {
    const docBox = h("div", { class: "terms-doc prose", tabindex: "0", "aria-label": "Document text" });
    const tabs = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Document" });
    const showDoc = (which) => {
      docBox.innerHTML = which === "terms" ? terms : privacy; // rendered by renderMarkdown, which escapes everything
      docBox.scrollTop = 0;
    };
    for (const [value, label] of [["terms", "Terms of use"], ["privacy", "Privacy notice"]]) {
      const radio = h("input", { type: "radio", name: "terms-doc", value, checked: value === "terms" });
      radio.addEventListener("change", () => showDoc(value));
      tabs.append(h("label", null, radio, h("span", null, label)));
    }
    showDoc("terms");

    const agreeBox = h("input", { type: "checkbox", id: "terms-agree" });
    const agree = h("button", { class: "btn btn-primary btn-large", type: "button", disabled: true }, "Agree and continue");
    const quit = h("button", { class: "btn btn-large", type: "button" }, isDesktop ? "Quit" : "Don't agree");
    const note = h("p", { class: "terms-note", role: "alert", hidden: true }, "you need to accept the terms to use Branch.");
    agreeBox.addEventListener("change", () => { agree.disabled = !agreeBox.checked; });

    const dialog = h(
      "dialog",
      { class: "sheet terms-sheet", "aria-labelledby": "terms-title" },
      h(
        "div",
        { class: "terms-body" },
        h("img", { src: "shared/branch-mark.svg", alt: "", width: "48", height: "48" }),
        h("h2", { class: "sheet-title", id: "terms-title" }, "Before you start"),
        h(
          "ul",
          { class: "terms-points" },
          h("li", null, "you're ", h("strong", null, "13 or older"), ", and if you're under 18 a parent or guardian agrees to these terms for you."),
          h("li", null, "mods are made by other people. you use them ", h("strong", null, "at your own risk"), ". they can break your game or get you banned."),
          h("li", null, "Branch is free and comes ", h("strong", null, "with no warranty"), ". Drifted isn't responsible for what mods or downloads do."),
          h("li", null, "the mod checker is an ", h("strong", null, "automated guess"), " and can be wrong."),
          h("li", null, "Branch isn't connected to Another Axiom or Gorilla Tag."),
        ),
        tabs,
        docBox,
        h("label", { class: "terms-check", for: "terms-agree" }, agreeBox, h("span", null, "I've read and agree to the Terms of Use and the Privacy Notice.")),
        note,
      ),
      h("div", { class: "sheet-actions" }, quit, agree),
    );

    // there's no way around this screen. browsers sometimes let escape close a dialog
    // anyway, so if it closes without agreeing, it just opens again.
    let accepted = false;
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    dialog.addEventListener("close", () => {
      if (!accepted && dialog.isConnected) dialog.showModal();
    });
    agree.addEventListener("click", () => {
      if (!agreeBox.checked) return;
      accepted = true;
      try {
        localStorage.setItem(KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString() }));
      } catch {
        // if storage is blocked they'll just be asked again next time
      }
      dialog.close();
      dialog.remove();
      resolve();
    });
    quit.addEventListener("click", () => {
      if (isDesktop && appWindow) appWindow.close();
      else note.hidden = false;
    });

    document.body.append(dialog);
    dialog.showModal();
    agreeBox.focus();
  });
}
