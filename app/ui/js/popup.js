import { h } from "./dom.js";
import { icon } from "./icons.js";
import { api } from "./platform.js";
import { toast } from "./ui.js";
import { renderMarkdown } from "../shared/markdown.js";

const KEY = "branch.popupsSeen";

function seen() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function markSeen(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...seen().filter((s) => s !== id)].slice(0, 50)));
  } catch {
  }
}

export async function showPopupOnce() {
  let popup;
  try {
    popup = (await api("/api/popup")).popup;
  } catch {
    return;
  }
  if (!popup || seen().includes(popup.id)) return;
  if (popup.kind === "poll" && (!popup.poll || popup.poll.my_vote)) {
    markSeen(popup.id);
    return;
  }
  markSeen(popup.id);
  await openPopup(popup);
}

function results(poll) {
  return h(
    "ul",
    { class: "popup-results", role: "list" },
    poll.options.map((o) => {
      const percent = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
      return h(
        "li",
        { class: o.id === poll.my_vote ? "mine" : "" },
        h("div", { class: "popup-result-bar", style: `width: ${percent}%` }),
        h("span", null, o.label, o.id === poll.my_vote ? h("span", { class: "popup-yours" }, icon("check"), "your vote") : null),
        h("strong", null, `${percent}%`),
      );
    }),
  );
}

function openPopup(popup) {
  return new Promise((resolve) => {
    const body = h("div", { class: "sheet-body popup-body" });
    const actions = h("div", { class: "sheet-actions" });
    const dialog = h("dialog", { class: "sheet popup-sheet", "aria-labelledby": "popup-title" }, body, actions);
    const done = (label, primary = true) => h("button", { class: primary ? "btn btn-primary" : "btn", type: "button", onclick: () => dialog.close() }, label);
    const head = h("div", { class: "popup-head" }, h("span", { class: "popup-icon", "aria-hidden": "true" }, icon(popup.kind === "poll" ? "poll" : "megaphone")), h("h2", { class: "sheet-title", id: "popup-title" }, popup.title));
    const text = popup.body ? h("div", { class: "prose popup-text", html: renderMarkdown(popup.body) }) : null;

    if (popup.kind === "poll") {
      const poll = popup.poll;
      const choices = h(
        "div",
        { class: "popup-options", role: "group", "aria-label": "Options" },
        poll.options.map((o) =>
          h("button", { class: "popup-option", type: "button", onclick: () => vote(o.id) }, o.label),
        ),
      );
      async function vote(optionId) {
        for (const b of choices.querySelectorAll("button")) b.disabled = true;
        try {
          const data = await api(`/api/polls/${encodeURIComponent(poll.id)}/vote`, { method: "POST", body: { option_id: optionId } });
          body.replaceChildren(head, text || "", h("p", { class: "muted small" }, "thanks for voting! here's how everyone voted so far."), results(data.poll));
          actions.replaceChildren(done("Done"));
        } catch (err) {
          toast(err.message, { tone: "error" });
          for (const b of choices.querySelectorAll("button")) b.disabled = false;
        }
      }
      body.append(head, text || "", choices);
      actions.append(h("button", { class: "btn btn-quiet", type: "button", onclick: () => dialog.close() }, "Skip"));
    } else {
      body.append(head, text || "");
      actions.append(done("Got it"));
    }

    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
