import { h, clear, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { api } from "../platform.js";
import { forumKey, myIdentity } from "../forum-identity.js";
import { errorBlock, stateBlock, toast } from "../ui.js";

const BOARDS = [
  ["", "All"],
  ["general", "General"],
  ["help", "Help"],
  ["showcase", "Showcase"],
  ["ideas", "Mod ideas"],
];
const boardLabel = (key) => BOARDS.find(([k]) => k === key)?.[1] || key;

function timeAgo(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDate(value);
}

function authorLine(author, when) {
  return h("span", { class: "post-author" }, h("strong", null, author.name), h("span", { class: "post-tag" }, `#${author.tag}`), h("span", { class: "muted" }, ` · ${timeAgo(when)}`));
}

function fieldError(form, fields) {
  for (const e of form.querySelectorAll(".error")) e.hidden = true;
  for (const [key, message] of Object.entries(fields || {})) {
    const error = form.querySelector(`[data-error="${key}"]`);
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }
}

function reportPost(target) {
  const reason = h("textarea", { class: "textarea", rows: "3", maxlength: "500", id: "forum-report-reason" });
  const error = h("p", { class: "error", hidden: true });
  const send = h("button", { class: "btn btn-primary", type: "button" }, "Send report");
  const dialog = h(
    "dialog",
    { class: "sheet", "aria-labelledby": "forum-report-title" },
    h("div", { class: "sheet-body" }, h("h2", { class: "sheet-title", id: "forum-report-title" }, "Report this post"), h("p", { class: "muted" }, "tell the admin what's wrong, like spam, harassment, or a dangerous link. reports are private."), h("div", { class: "field" }, h("label", { for: "forum-report-reason" }, "What's wrong?"), reason, error)),
    h("div", { class: "sheet-actions" }, h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), send),
  );
  send.addEventListener("click", async () => {
    if (!reason.value.trim()) {
      error.textContent = "say briefly what's wrong.";
      error.hidden = false;
      return;
    }
    try {
      await api("/api/forum/report", { method: "POST", body: { ...target, reason: reason.value.trim() } });
      dialog.close();
      toast("Report sent", { tone: "ok" });
    } catch (err) {
      error.textContent = err.fields?.reason || err.message;
      error.hidden = false;
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  reason.focus();
}

export function createForumView(ctx) {
  const el = h("section", { class: "view forum", "aria-labelledby": "forum-title" });
  let board = "";
  let page = 1;
  let threads = [];
  let hasMore = false;

  async function identityBadge() {
    const badge = h("a", { class: "identity-badge", href: "#/settings", title: "change your community name in Settings" }, icon("sliders"), "loading your name…");
    myIdentity()
      .then((me) => badge.replaceChildren(h("span", { class: "muted" }, "posting as "), h("strong", null, me.name), h("span", { class: "post-tag" }, `#${me.tag}`)))
      .catch(() => badge.replaceChildren("couldn't load your community name"));
    return badge;
  }

  function composer(onDone) {
    const boardSelect = h("select", { class: "select", id: "forum-board" }, BOARDS.slice(1).map(([k, l]) => h("option", { value: k }, l)));
    if (board) boardSelect.value = board;
    const title = h("input", { class: "input", id: "forum-title-input", maxlength: "120", autocomplete: "off" });
    const body = h("textarea", { class: "textarea", id: "forum-body", rows: "6", maxlength: "5000" });
    const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Post");
    const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
    const form = h(
      "form",
      { class: "form-card composer", novalidate: true },
      h("div", { class: "composer-row" }, h("div", { class: "field" }, h("label", { for: "forum-board" }, "Board"), boardSelect), h("div", { class: "field grow" }, h("label", { for: "forum-title-input" }, "Title"), title, h("p", { class: "error", "data-error": "title", hidden: true }))),
      h("div", { class: "field" }, h("label", { for: "forum-body" }, "Message"), body, h("p", { class: "hint" }, "be nice. don't share personal info like your real name, address or passwords. posts are public."), h("p", { class: "error", "data-error": "body", hidden: true })),
      h("div", { class: "trap", "aria-hidden": "true" }, trap),
      formError,
      h("div", { class: "composer-actions" }, h("button", { class: "btn btn-quiet", type: "button", onclick: () => onDone(null) }, "Cancel"), submit),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      formError.hidden = true;
      submit.disabled = true;
      try {
        const result = await api("/api/forum/threads", { method: "POST", body: { key: forumKey(), board: boardSelect.value, title: title.value, body: body.value, website: trap.value } });
        onDone(result.id);
      } catch (err) {
        if (err.fields) fieldError(form, err.fields);
        else {
          formError.replaceChildren(icon("alert"), h("p", null, err.message));
          formError.hidden = false;
        }
      } finally {
        submit.disabled = false;
      }
    });
    setTimeout(() => title.focus(), 0);
    return form;
  }

  function threadRow(t) {
    return h(
      "li",
      { class: "thread-row" },
      h(
        "div",
        { class: "thread-main" },
        h(
          "div",
          { class: "thread-title-row" },
          t.pinned ? h("span", { class: "badge plain pin-badge" }, "Pinned") : null,
          h("a", { class: "row-link thread-link", href: `#/forum/${t.id}` }, t.title),
          t.locked ? h("span", { class: "badge plain" }, "Locked") : null,
        ),
        h("p", { class: "row-summary" }, t.excerpt),
        h("p", { class: "row-meta" }, h("span", { class: "board-chip" }, boardLabel(t.board)), "  ", authorLine(t.author, t.created_at)),
      ),
      h("div", { class: "thread-side" }, h("strong", null, String(t.reply_count)), h("span", { class: "muted small" }, t.reply_count === 1 ? "reply" : "replies"), h("span", { class: "muted small" }, timeAgo(t.last_post_at))),
    );
  }

  async function renderList(reset = true) {
    if (reset) {
      page = 1;
      threads = [];
    }
    const list = h("ul", { class: "mod-list thread-list", role: "list" });
    const foot = h("div", { class: "list-foot" });
    const tabs = h(
      "div",
      { class: "segmented board-tabs", role: "radiogroup", "aria-label": "Board" },
      BOARDS.map(([k, l]) => {
        const radio = h("input", { type: "radio", name: "forum-board-tab", value: k, checked: board === k });
        radio.addEventListener("change", () => { board = k; renderList(); });
        return h("label", null, radio, h("span", null, l));
      }),
    );
    const composeArea = h("div");
    const newPost = h("button", { class: "btn btn-primary", type: "button" }, icon("upload"), "New post");
    newPost.addEventListener("click", () => {
      newPost.hidden = true;
      composeArea.replaceChildren(
        composer((id) => {
          composeArea.replaceChildren();
          newPost.hidden = false;
          if (id) location.hash = `#/forum/${id}`;
        }),
      );
    });

    clear(el).append(
      h("header", { class: "view-head forum-head" }, h("h1", { class: "view-title", id: "forum-title" }, "Community"), await identityBadge(), h("span", { class: "grow" }), newPost),
      communityTabs("forum"),
      h("p", { class: "muted forum-intro" }, "talk about mods, ask for help, show off what you made. no account needed."),
      tabs,
      composeArea,
      list,
      foot,
    );
    latestPoll().then((teaser) => {
      if (teaser && el.contains(tabs)) tabs.before(teaser);
    });
    list.append(...Array.from({ length: 4 }, () => h("li", { class: "thread-row skeleton-row", "aria-hidden": "true" }, h("div", { class: "row-main" }, h("div", { class: "skeleton sk-title" }), h("div", { class: "skeleton sk-line" })))));

    try {
      const params = new URLSearchParams({ page: String(page) });
      if (board) params.set("board", board);
      const data = await api(`/api/forum/threads?${params}`);
      threads.push(...data.items);
      hasMore = data.has_more;
      clear(list).append(...threads.map(threadRow));
      if (!threads.length) {
        list.replaceWith(stateBlock({ iconName: "chat", title: "No posts yet", message: board ? "nothing on this board yet. start the first thread!" : "be the first to start a conversation." }));
      }
      if (hasMore) {
        foot.append(h("button", { class: "btn", type: "button", onclick: async () => { page += 1; const more = await api(`/api/forum/threads?${new URLSearchParams({ page: String(page), ...(board ? { board } : {}) })}`); threads.push(...more.items); hasMore = more.has_more; list.append(...more.items.map(threadRow)); if (!hasMore) foot.replaceChildren(); } }, "Load more"));
      }
    } catch (err) {
      list.replaceWith(errorBlock(err, () => renderList()));
    }
  }

  async function renderThread(id) {
    clear(el).append(h("div", { class: "skeleton sk-title-lg" }), h("div", { class: "skeleton sk-line" }));
    let data;
    try {
      data = await api(`/api/forum/threads/${encodeURIComponent(id)}`);
    } catch (err) {
      clear(el).append(err.status === 404 ? stateBlock({ iconName: "chat", title: "This post isn't there anymore", message: "it may have been removed.", actions: [ctx.link("#/forum", "Back to Community")] }) : errorBlock(err, () => renderThread(id)));
      return;
    }
    const t = data.thread;
    ctx.setTitle(t.title);
    const post = (p, kind) =>
      h(
        "article",
        { class: `post${p.removed ? " removed" : ""}` },
        h("div", { class: "post-head" }, authorLine(p.author, p.created_at), p.removed ? null : h("button", { class: "btn btn-quiet small-btn", type: "button", onclick: () => reportPost(kind === "thread" ? { thread_id: p.id } : { reply_id: p.id }) }, icon("flag"), "Report")),
        p.removed ? h("p", { class: "muted" }, p.body) : h("div", { class: "prose", html: renderMarkdown(p.body) }),
      );

    const replyBox = h("textarea", { class: "textarea", id: "forum-reply", rows: "4", maxlength: "3000", placeholder: "write a reply…" });
    const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const send = h("button", { class: "btn btn-primary", type: "submit" }, "Reply");
    const replyError = h("p", { class: "error", "data-error": "body", hidden: true });
    const replyForm = h(
      "form",
      { class: "form-card reply-form", novalidate: true },
      h("label", { for: "forum-reply", class: "field-label" }, "Your reply"),
      replyBox,
      replyError,
      h("div", { class: "trap", "aria-hidden": "true" }, trap),
      h("div", { class: "composer-actions" }, await identityBadge(), h("span", { class: "grow" }), send),
    );
    replyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      replyError.hidden = true;
      if (!replyBox.value.trim()) {
        replyError.textContent = "write something first.";
        replyError.hidden = false;
        return;
      }
      send.disabled = true;
      try {
        await api(`/api/forum/threads/${encodeURIComponent(id)}/replies`, { method: "POST", body: { key: forumKey(), body: replyBox.value, website: trap.value } });
        toast("Reply posted", { tone: "ok" });
        renderThread(id);
      } catch (err) {
        replyError.textContent = err.fields?.body || err.message;
        replyError.hidden = false;
        send.disabled = false;
      }
    });

    clear(el).append(
      h("a", { class: "back-link", href: board ? `#/forum?board=${board}` : "#/forum" }, icon("chevronLeft"), "Community"),
      h("header", { class: "thread-header" }, h("span", { class: "board-chip" }, boardLabel(t.board)), h("h1", { class: "view-title", id: "forum-title" }, t.title), t.locked ? h("span", { class: "badge plain" }, "Locked") : null),
      post(t, "thread"),
      h("h2", { class: "replies-heading" }, `${data.replies.length} ${data.replies.length === 1 ? "reply" : "replies"}`),
      h("div", { class: "replies" }, data.replies.map((r) => post(r, "reply"))),
      t.locked ? h("p", { class: "muted" }, "this thread is locked, so no new replies.") : replyForm,
    );
  }

  let chatTimer = null;

  function pollCard(poll, onChange) {
    const voted = Boolean(poll.my_vote);
    const card = h("article", { class: `poll-card${poll.open ? "" : " closed"}`, dataset: { poll: poll.id } });
    const draw = (p) => {
      const results = Boolean(p.my_vote) || !p.open;
      card.replaceChildren(
        h("div", { class: "poll-head" }, h("span", { class: "poll-icon", "aria-hidden": "true" }, icon("poll")), h("h2", null, p.question), h("span", { class: `poll-state ${p.open ? "open" : ""}` }, p.open ? "Open" : "Closed")),
        h(
          "ul",
          { class: "poll-options", role: "list" },
          p.options.map((o) => {
            const pct = p.total ? Math.round((o.votes / p.total) * 100) : 0;
            const mine = p.my_vote === o.id;
            const btn = h(
              "button",
              { class: `poll-option${mine ? " mine" : ""}${results ? " results" : ""}`, type: "button", disabled: !p.open, "aria-pressed": mine ? "true" : "false", style: results ? `--pct:${pct}%` : null },
              h("span", { class: "poll-fill", "aria-hidden": "true" }),
              h("span", { class: "poll-label" }, mine ? icon("check") : null, o.label),
              results ? h("span", { class: "poll-pct" }, `${pct}%`) : null,
            );
            btn.addEventListener("click", async () => {
              if (!p.open || mine) return;
              for (const b of card.querySelectorAll(".poll-option")) b.disabled = true;
              try {
                const res = await api(`/api/polls/${p.id}/vote`, { method: "POST", body: { option_id: o.id } });
                if (res.poll) {
                  draw(res.poll);
                  onChange?.(res.poll);
                }
                toast(voted || p.my_vote ? "Vote changed" : "Thanks for voting!", { tone: "ok" });
              } catch (err) {
                toast(err.message, { tone: "error" });
                draw(p);
              }
            });
            return h("li", null, btn);
          }),
        ),
        h("p", { class: "muted small poll-foot" }, `${p.total} vote${p.total === 1 ? "" : "s"}${p.open ? (p.closes_at ? ` · closes ${formatDate(p.closes_at)}` : "") : " · voting has ended"}${results && p.open ? " · tap another option to change your vote" : ""}`),
      );
    };
    draw(poll);
    return card;
  }

  async function renderPolls() {
    clear(el).append(
      h("header", { class: "view-head forum-head" }, h("h1", { class: "view-title", id: "forum-title" }, "Community")),
      communityTabs("polls"),
      h("div", { class: "skeleton sk-title" }),
    );
    let data;
    try {
      data = await api("/api/polls");
    } catch (err) {
      el.lastChild.replaceWith(errorBlock(err, renderPolls));
      return;
    }
    const open = data.polls.filter((x) => x.open);
    const closed = data.polls.filter((x) => !x.open);
    el.lastChild.replaceWith(
      h(
        "div",
        { class: "poll-list" },
        h("p", { class: "muted forum-intro" }, "polls from the Branch team. vote to help decide what happens next. you can change your vote while a poll is open."),
        data.polls.length ? null : stateBlock({ iconName: "poll", title: "No polls yet", message: "when the Branch team asks the community something, the poll shows up here." }),
        ...open.map((x) => pollCard(x)),
        closed.length ? h("h2", { class: "poll-section" }, "Ended") : null,
        ...closed.map((x) => pollCard(x)),
      ),
    );
  }

  async function latestPoll() {
    try {
      const data = await api("/api/polls");
      const open = data.polls.find((x) => x.open);
      if (!open) return null;
      return h("div", { class: "poll-teaser" }, pollCard(open), h("a", { class: "poll-more small", href: "#/forum/polls" }, "See all polls", icon("chevronRight")));
    } catch {
      return null;
    }
  }

  function stopChat() {
    clearInterval(chatTimer);
    chatTimer = null;
  }

  async function renderChat() {
    stopChat();
    ctx.setTitle("Chat");
    let lastId = 0;
    let first = true;
    const shown = new Map();
    const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite", "aria-label": "Chat messages", tabindex: "0" });
    const empty = h("p", { class: "muted chat-empty" }, "no messages yet. say hi!");
    log.append(empty);
    const input = h("input", { class: "input chat-input", id: "chat-input", maxlength: "500", autocomplete: "off", placeholder: "say something…", "aria-label": "Chat message" });
    const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", class: "trap" });
    const send = h("button", { class: "btn btn-primary", type: "submit" }, "Send");
    const error = h("p", { class: "error chat-error", role: "alert", hidden: true });
    const form = h("form", { class: "chat-form", novalidate: true }, input, trap, send);

    const addMessage = (m) => {
      if (shown.has(m.id)) return;
      empty.remove();
      const text = h("p", { class: "chat-text" }, m.body);
      const report = m.removed ? null : h("button", { class: "chat-report", type: "button", title: "Report this message", "aria-label": `Report message from ${m.author.name}`, onclick: () => reportPost({ chat_id: m.id }) }, icon("flag"));
      const row = h(
        "div",
        { class: `chat-msg${m.removed ? " removed" : ""}`, dataset: { id: String(m.id) } },
        h("div", { class: "chat-meta" }, h("strong", null, m.author.name), h("span", { class: "post-tag" }, `#${m.author.tag}`), h("span", { class: "muted" }, timeAgo(m.created_at)), report),
        text,
      );
      shown.set(m.id, { row, text });
      log.append(row);
    };

    const markRemoved = (id) => {
      const item = shown.get(id);
      if (!item || item.row.classList.contains("removed")) return;
      item.row.classList.add("removed");
      item.text.textContent = "[removed by a moderator]";
      item.row.querySelector(".chat-report")?.remove();
    };

    const poll = async () => {
      if (document.hidden && !first) return;
      try {
        const data = await api(`/api/chat${lastId ? `?after=${lastId}` : ""}`);
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        data.messages.forEach(addMessage);
        (data.removed || []).forEach(markRemoved);
        lastId = Math.max(lastId, data.latest_id || 0);
        if (first || (nearBottom && data.messages.length)) log.scrollTop = log.scrollHeight;
        first = false;
        error.hidden = true;
      } catch (err) {
        error.textContent = err.kind === "network" ? "lost connection to the chat. retrying…" : err.message;
        error.hidden = false;
      }
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        await api("/api/chat", { method: "POST", body: { key: forumKey(), body, website: trap.value } });
        input.value = "";
        await poll();
        log.scrollTop = log.scrollHeight;
        error.hidden = true;
      } catch (err) {
        error.textContent = err.fields?.body || err.message;
        error.hidden = false;
      } finally {
        send.disabled = false;
        input.focus();
      }
    });

    clear(el).append(
      h("header", { class: "view-head forum-head" }, h("h1", { class: "view-title", id: "forum-title" }, "Community"), await identityBadge()),
      communityTabs("chat"),
      h("div", { class: "chat-panel" }, log, error, form),
      h("p", { class: "muted small chat-note" }, "one big chat for everyone. be nice, and don't share personal info. messages are public and deleted after 30 days."),
    );
    await poll();
    chatTimer = setInterval(poll, 3000);
    input.focus();
  }

  return {
    el,
    title: () => "Community",
    show(params) {
      stopChat();
      if (params.thread === "chat") renderChat();
      else if (params.thread === "polls") renderPolls();
      else if (params.thread) renderThread(params.thread);
      else {
        board = params.board || board;
        renderList();
      }
      return 0;
    },
    hide() {
      stopChat();
    },
  };
}

let inboxCount = 0;

export function setCommunityInboxCount(count) {
  inboxCount = count;
  for (const badge of document.querySelectorAll(".community-inbox-badge")) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = !count;
  }
}

export function communityTabs(active) {
  return h(
    "nav",
    { class: "community-tabs", "aria-label": "Community" },
    h("a", { href: "#/forum", "aria-current": active === "forum" ? "page" : null }, icon("layers"), "Forum"),
    h("a", { href: "#/forum/chat", "aria-current": active === "chat" ? "page" : null }, icon("chat"), "Chat"),
    h("a", { href: "#/forum/polls", "aria-current": active === "polls" ? "page" : null }, icon("poll"), "Polls"),
    h("a", { href: "#/inbox", "aria-current": active === "inbox" ? "page" : null }, icon("inbox"), "Inbox", h("span", { class: "inbox-tab-count community-inbox-badge", hidden: !inboxCount }, inboxCount > 99 ? "99+" : String(inboxCount))),
  );
}
