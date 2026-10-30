import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../platform.js";
import { renderMarkdown } from "../../shared/markdown.js";

const SUGGESTIONS = [
  "What are the best cosmetic mods right now?",
  "How do I install mods on Gorilla Tag?",
  "Who did the tracker find most recently?",
  "Which mods are safe to use in public lobbies?",
];

const MOD_LINK = /\[([^\]\n]+)\]\(mod:([a-z0-9-]+)\)/g;
const TOKEN = /\u0001([a-z0-9-]+)\u0002([^\u0003]*)\u0003/g;

function replyContent(text) {
  const marked = text.replace(MOD_LINK, (_, label, slug) => `\u0001${slug}\u0002${label.replace(/[\u0001-\u0003]/g, "")}\u0003`);
  const box = h("div", { class: "prose as-prose", html: renderMarkdown(marked) });
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes("\u0001")) hits.push(walker.currentNode);
  for (const node of hits) {
    const parts = [];
    let last = 0;
    for (const m of node.nodeValue.matchAll(TOKEN)) {
      parts.push(node.nodeValue.slice(last, m.index));
      parts.push(h("a", { class: "as-mod-link", href: `#/mod/${m[1]}` }, icon("box"), m[2]));
      last = m.index + m[0].length;
    }
    parts.push(node.nodeValue.slice(last));
    node.replaceWith(...parts.filter((p) => p !== ""));
  }
  return box;
}

function untilText(iso) {
  if (!iso) return "";
  const mins = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function createAssistantView() {
  const el = h("section", { class: "view assistant-view", "aria-labelledby": "assistant-title" });
  const history = [];
  let usage = null;
  let available = true;
  let busy = false;
  let thread, input, sendButton, meter, meterText, emptyState;

  function renderUsage() {
    if (!meter || !usage) return;
    const pct = (usage.remaining / usage.limit) * 100;
    meter.firstChild.style.width = `${pct}%`;
    meter.classList.toggle("low", usage.remaining <= 5);
    meterText.textContent = !available
      ? "the assistant isn't available right now"
      : usage.remaining > 0
        ? `${usage.remaining} of ${usage.limit} free messages left${usage.used && usage.resets_at ? ` · next one back in ${untilText(usage.resets_at)}` : ` · every ${usage.window_hours} hours`}`
        : `out of free messages · next one back in ${untilText(usage.resets_at)}`;
    const blocked = !available || usage.remaining <= 0;
    input.disabled = blocked || busy;
    sendButton.disabled = blocked || busy || !input.value.trim();
  }

  async function loadUsage() {
    try {
      const data = await api("/api/assistant/usage");
      usage = data;
      available = data.available;
      renderUsage();
    } catch {
      meterText.textContent = "couldn't check your messages left";
    }
  }

  function bubble(role, content) {
    return h(
      "li",
      { class: `as-msg ${role}` },
      role === "assistant" ? h("span", { class: "as-avatar", "aria-hidden": "true" }, h("span", { class: "as-glyph" })) : null,
      h("div", { class: "as-bubble" }, content),
    );
  }

  function scrollDown() {
    const main = document.getElementById("main");
    requestAnimationFrame(() => main.scrollTo({ top: main.scrollHeight, behavior: "smooth" }));
  }

  async function send(text) {
    const message = text.trim();
    if (!message || busy) return;
    busy = true;
    emptyState.hidden = true;
    history.push({ role: "user", content: message });
    thread.append(bubble("user", h("p", null, message)));
    input.value = "";
    autosize();
    const typing = bubble("assistant", h("span", { class: "as-typing", "aria-label": "Branch is thinking" }, h("span"), h("span"), h("span")));
    thread.append(typing);
    renderUsage();
    scrollDown();
    try {
      const data = await api("/api/assistant", { method: "POST", body: { messages: history.slice(-14) } });
      history.push({ role: "assistant", content: data.reply });
      typing.replaceWith(bubble("assistant", replyContent(data.reply)));
      usage = data.usage;
    } catch (err) {
      history.pop();
      typing.replaceWith(
        h(
          "li",
          { class: "as-msg error" },
          h("div", { class: "as-error", role: "alert" }, icon("alert"), h("p", null, err.message), h("button", { class: "btn btn-quiet", type: "button", onclick: (e) => { e.currentTarget.closest("li").remove(); thread.lastElementChild?.remove(); send(message); } }, icon("refresh"), "Try again")),
        ),
      );
      if (err.status === 429 || err.status === 503) loadUsage();
    } finally {
      busy = false;
      renderUsage();
      scrollDown();
      input.focus();
    }
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  function newChat() {
    history.length = 0;
    clear(thread);
    emptyState.hidden = false;
    input.focus();
  }

  function render() {
    thread = h("ul", { class: "as-thread", "aria-live": "polite", "aria-label": "Conversation" });
    meter = h("div", { class: "as-meter", "aria-hidden": "true" }, h("span"));
    meterText = h("span", { class: "as-meter-text" }, "checking your free messages…");
    input = h("textarea", { class: "as-input", rows: "1", maxlength: "2000", placeholder: "Ask about mods, the app or the player tracker…", "aria-label": "Message" });
    sendButton = h("button", { class: "as-send", type: "submit", "aria-label": "Send", disabled: true }, icon("chevronRight"));
    input.addEventListener("input", () => { autosize(); renderUsage(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(input.value);
      }
    });
    const form = h("form", { class: "as-composer" }, input, sendButton);
    form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });

    emptyState = h(
      "div",
      { class: "as-empty" },
      h("span", { class: "as-hero-mark", "aria-hidden": "true" }, h("span", { class: "as-glyph" })),
      h("h2", null, "What can I help with?"),
      h("p", { class: "muted" }, "I know every mod on Branch, how the app works, and the last 50 players the tracker found."),
      h("div", { class: "as-suggestions" }, SUGGESTIONS.map((s) => h("button", { class: "as-suggestion", type: "button", onclick: () => send(s) }, s))),
    );

    clear(el).append(
      h(
        "header",
        { class: "as-head" },
        h("div", null, h("div", { class: "as-title-row" }, h("h1", { class: "view-title", id: "assistant-title" }, "Ask Branch"), h("span", { class: "as-free" }, "Free")), h("div", { class: "as-usage" }, meter, meterText)),
        h("button", { class: "btn btn-quiet", type: "button", onclick: newChat }, icon("refresh"), "New chat"),
      ),
      emptyState,
      thread,
      h("div", { class: "as-dock" }, form, h("p", { class: "as-fine" }, "AI can make mistakes, so double-check anything important. chats aren't saved by Branch.")),
    );
  }

  return {
    el,
    title: () => "Ask Branch",
    show() {
      if (!thread) render();
      loadUsage();
      setTimeout(() => input.focus(), 50);
      return 0;
    },
    hide() {},
  };
}
