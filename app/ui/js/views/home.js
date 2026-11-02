import { h, clear, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { api, aiOff } from "../platform.js";
import { forumKey } from "../forum-identity.js";
import { thumbnail } from "../ui.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { inboxPreview } from "./inbox.js";
import { myProfile, avatarEl } from "../profile.js";

function timeAgo(value) {
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export function createHomeView(ctx) {
  const el = h("section", { class: "view home", "aria-labelledby": "home-title" });
  let chatTimer = null;
  let repaintProfile = null;
  window.addEventListener("branch-profile", () => repaintProfile?.());

  const panel = (cls, title, link, ...body) =>
    h("section", { class: `home-panel ${cls}` }, h("div", { class: "home-panel-head" }, h("h2", null, title), link || null), ...body);

  async function profileCard() {
    const card = h("section", { class: "home-panel home-profile" });
    const paint = async () => {
      const me = await myProfile();
      card.replaceChildren(
        avatarEl(me.avatar, 64),
        h(
          "div",
          { class: "home-profile-text" },
          h("p", { class: "muted small" }, greeting()),
          h("h1", { id: "home-title" }, me.name),
          h("p", { class: "muted small" }, me.account ? "creator account" : "local profile, saved on this computer"),
        ),
        h(
          "div",
          { class: "home-profile-actions" },
          h("a", { class: "btn btn-small", href: "#/settings" }, icon("edit"), "Edit profile"),
          h("a", { class: "btn btn-small btn-quiet", href: "#/rewards" }, icon("hub"), me.account ? "Creator hub" : "Make an account"),
        ),
      );
    };
    repaintProfile = paint;
    paint();
    return card;
  }

  function featuredPanel() {
    const list = h("div", { class: "home-featured" }, ...Array.from({ length: 6 }, () => h("div", { class: "skeleton home-mod-skel" })));
    api("/api/mods?featured=true&per_page=6")
      .then((data) => {
        list.replaceChildren(
          ...data.items.slice(0, 6).map((m) =>
            h(
              "a",
              { class: "home-mod", href: `#/mod/${encodeURIComponent(m.slug)}` },
              thumbnail(m.thumbnail_url, "home-mod-thumb", m),
              h("strong", null, m.name),
              h("span", { class: "muted small" }, m.rating?.count ? `★ ${m.rating.average.toFixed(1)} · ${m.category?.name || "mod"}` : m.category?.name || "mod"),
            ),
          ),
        );
      })
      .catch(() => list.replaceChildren(h("p", { class: "muted" }, "couldn't load featured mods right now.")));
    return panel("home-featured-panel", "Featured mods", h("a", { class: "home-link", href: "#/featured" }, "See all", icon("chevronRight")), list);
  }

  function inboxPanel() {
    const body = h("div", { class: "home-inbox" }, h("div", { class: "skeleton sk-line" }));
    inboxPreview(4)
      .then(({ items, since }) => {
        if (!items.length) return body.replaceChildren(h("p", { class: "muted" }, "nothing here yet."));
        body.replaceChildren(
          ...items.map((i) =>
            h(
              "a",
              { class: `home-inbox-item${i.date.getTime() > since ? " new" : ""}`, href: "#/inbox" },
              h("span", { class: "home-inbox-dot", "aria-hidden": "true" }),
              h("div", null, h("strong", null, i.title || (i.type === "report" ? `Your report on ${i.report?.mod_name || "a mod"}` : "Message")), h("span", { class: "muted small" }, formatDate(i.date))),
            ),
          ),
        );
      })
      .catch(() => body.replaceChildren(h("p", { class: "muted" }, "couldn't load your inbox right now.")));
    return panel("home-inbox-panel", "Inbox", h("a", { class: "home-link", href: "#/inbox" }, "Open", icon("chevronRight")), body);
  }

  function chatPanel() {
    let lastId = 0;
    const shown = new Set();
    const log = h("div", { class: "home-chat-log", role: "log", "aria-live": "polite", "aria-label": "Global chat" });
    const input = h("input", { class: "input", maxlength: "500", autocomplete: "off", placeholder: "say something…", "aria-label": "Chat message" });
    const send = h("button", { class: "btn btn-primary btn-small", type: "submit" }, "Send");
    const error = h("p", { class: "error small", role: "alert", hidden: true });
    const form = h("form", { class: "home-chat-form", novalidate: true }, input, send);
    const poll = async (force = false) => {
      if (document.hidden && lastId && !force) return;
      try {
        const data = await api(`/api/chat${lastId ? `?after=${lastId}` : ""}`);
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        for (const m of data.messages.slice(-30)) {
          if (shown.has(m.id)) continue;
          shown.add(m.id);
          log.append(h("p", { class: "home-chat-msg" }, h("strong", null, m.author.name), " ", h("span", { class: "muted small" }, timeAgo(m.created_at)), h("br"), m.removed ? "[removed by a moderator]" : m.body));
        }
        while (log.children.length > 40) log.firstChild.remove();
        const first = !lastId;
        lastId = Math.max(lastId, data.latest_id || 0);
        if (first || nearBottom) log.scrollTop = log.scrollHeight;
        if (!log.children.length) log.replaceChildren(h("p", { class: "muted" }, "no messages yet. say hi!"));
        error.hidden = true;
      } catch {
        error.textContent = "lost connection to the chat. retrying…";
        error.hidden = false;
      }
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        await api("/api/chat", { method: "POST", body: { key: forumKey(), body, website: "" } });
        input.value = "";
        if (log.querySelector("p.muted:only-child")) log.replaceChildren();
        await poll(true);
        log.scrollTop = log.scrollHeight;
      } catch (err) {
        error.textContent = err.fields?.body || err.message;
        error.hidden = false;
      } finally {
        send.disabled = false;
      }
    });
    poll();
    chatTimer = setInterval(() => poll(), 4000);
    return panel("home-chat-panel", "Global chat", h("a", { class: "home-link", href: "#/forum/chat" }, "Open", icon("chevronRight")), log, error, form);
  }

  function askPanel() {
    if (aiOff()) {
      return panel("home-ask-panel", "Ask Branch", null, h("p", { class: "muted" }, "Branch AI is turned off in Settings."));
    }
    const answer = h("div", { class: "home-ask-answer prose", "aria-live": "polite" }, h("p", { class: "muted" }, "ask about any mod, how to install something, or how Branch works."));
    const input = h("input", { class: "input", maxlength: "500", autocomplete: "off", placeholder: "e.g. what's a good camera mod?", "aria-label": "Ask Branch" });
    const send = h("button", { class: "btn btn-primary btn-small", type: "submit" }, icon("ask"), "Ask");
    const form = h("form", { class: "home-ask-form", novalidate: true }, input, send);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question) return;
      send.disabled = true;
      answer.replaceChildren(h("p", { class: "muted" }, "thinking…"));
      try {
        const data = await api("/api/assistant", { method: "POST", body: { messages: [{ role: "user", content: question }] } });
        answer.innerHTML = renderMarkdown(data.reply);
        input.value = "";
      } catch (err) {
        answer.replaceChildren(h("p", { class: "error" }, err.message));
      } finally {
        send.disabled = false;
      }
    });
    return panel("home-ask-panel", "Ask Branch", h("a", { class: "home-link", href: "#/ask" }, "Full chat", icon("chevronRight")), answer, form);
  }

  async function render() {
    stop();
    clear(el).append(
      h("div", { class: "home-grid" }, await profileCard(), inboxPanel(), featuredPanel(), chatPanel(), askPanel()),
    );
  }

  function stop() {
    if (chatTimer) clearInterval(chatTimer);
    chatTimer = null;
  }

  return {
    el,
    title: () => "Home",
    show() {
      render();
      return 0;
    },
    hide() {
      stop();
    },
  };
}
