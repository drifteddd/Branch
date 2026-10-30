import { h } from "./dom.js";
import { renderMarkdown } from "../shared/markdown.js";
import { appWindow, isDesktop } from "./platform.js";

export const TERMS_VERSION = 9;
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
      docBox.innerHTML = which === "terms" ? terms : privacy;
      docBox.scrollTop = 0;
    };
    for (const [value, label] of [["terms", "Terms of Use"], ["privacy", "Privacy Notice"]]) {
      const radio = h("input", { type: "radio", name: "terms-doc", value, checked: value === "terms" });
      radio.addEventListener("change", () => showDoc(value));
      tabs.append(h("label", null, radio, h("span", null, label)));
    }
    showDoc("terms");

    const agreeBox = h("input", { type: "checkbox", id: "terms-agree" });
    const agree = h("button", { class: "btn btn-primary btn-large", type: "button", disabled: true }, "Agree and continue");
    const quit = h("button", { class: "btn btn-large", type: "button" }, isDesktop ? "Decline and quit" : "Decline");
    const note = h("p", { class: "terms-note", role: "alert", hidden: true }, "You must accept the Terms of Use to use Branch.");
    agreeBox.addEventListener("change", () => { agree.disabled = !agreeBox.checked; });

    const dialog = h(
      "dialog",
      { class: "sheet terms-sheet", "aria-labelledby": "terms-title" },
      h(
        "div",
        { class: "terms-body" },
        h("img", { src: "shared/branch-mark.svg", alt: "", width: "48", height: "48" }),
        h("h2", { class: "sheet-title", id: "terms-title" }, "Terms of Use and Privacy Notice"),
        h("p", { class: "terms-intro" }, "Please review and accept the following before using Branch. Key points include:"),
        h(
          "ul",
          { class: "terms-points" },
          h("li", null, "You must be ", h("strong", null, "at least 13 years old"), ". If you are under the age of majority, a parent or legal guardian must accept these Terms on your behalf."),
          h("li", null, "Mods are created by third parties, including other users. You download and use them ", h("strong", null, "entirely at your own risk"), ", including the risk of device damage and game account penalties."),
          h("li", null, "If you upload a Mod, you confirm that you have the right to distribute it, that it contains no malicious code, and you grant the Operator a license to host and distribute it."),
          h("li", null, "The Service is provided ", h("strong", null, "\"as is\" without warranties"), ", and the Operator's liability is limited to the fullest extent permitted by law."),
          h("li", null, "Community Forum posts, chat messages and your display name are public. Do not share personal information. The Operator may remove content and restrict posting."),
          h("li", null, "The Rewards Program is a discretionary, limited-time promotion that may change or end at any time. Rewards are not guaranteed until delivered."),
          h("li", null, "Mod Checker results, Ask Branch answers and Player Tracker data are automated, may be inaccurate, and are used at your own risk."),
          h("li", null, "Branch is not affiliated with or endorsed by Another Axiom Inc. or Gorilla Tag."),
        ),
        tabs,
        docBox,
        h("label", { class: "terms-check", for: "terms-agree" }, agreeBox, h("span", null, "I have read and agree to the Terms of Use and acknowledge the Privacy Notice.")),
        note,
      ),
      h("div", { class: "sheet-actions" }, quit, agree),
    );

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
