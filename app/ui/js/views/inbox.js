import { h, clear, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../platform.js";
import { forumKey } from "../forum-identity.js";
import { errorBlock, stateBlock } from "../ui.js";
import { renderMarkdown } from "../../shared/markdown.js";

const SEEN_KEY = "branch.inboxSeen";
const FILTERS = [["all", "All"], ["announcement", "Announcements"], ["update", "Updates"], ["report", "My reports"]];
const STATUS = {
  open: ["We're looking at it", "open"],
  resolved: ["Resolved", "resolved"],
  dismissed: ["Closed", "dismissed"],
};

function seenAt() {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {}
}

function toItems(data) {
  const items = [];
  for (const a of data.announcements || []) {
    items.push({ type: a.kind === "update" ? "update" : "announcement", kind: a.kind, id: `a-${a.id}`, title: a.title, body: a.body, date: new Date(a.created_at) });
  }
  for (const r of data.releases || []) {
    if (!r.published_at) continue;
    items.push({ type: "update", kind: "release", id: `r-${r.id}`, title: `Branch ${r.version}`, body: r.notes || "", date: new Date(r.published_at) });
  }
  for (const r of data.reports || []) {
    items.push({ type: "report", id: `p-${r.id}`, report: r, date: new Date(r.resolved_at || r.created_at) });
  }
  return items.sort((a, b) => b.date - a.date);
}

export async function inboxUnread() {
  const data = await api("/api/inbox", { method: "POST", body: { key: forumKey() } });
  const since = seenAt();
  return toItems(data).filter((i) => i.date.getTime() > since).length;
}

export function createInboxView(ctx) {
  const el = h("section", { class: "view page inbox-view", "aria-labelledby": "inbox-title" });
  let filter = "all";
  let items = [];
  let since = 0;

  const reasonLabel = (key) => ctx.meta?.report_reasons?.find((r) => r.key === key)?.label || key;

  function card(item) {
    const isNew = item.date.getTime() > since;
    if (item.type === "report") {
      const r = item.report;
      const [statusText, statusClass] = STATUS[r.status] || STATUS.open;
      return h(
        "article",
        { class: `inbox-card report${isNew ? " is-new" : ""}` },
        h("span", { class: "inbox-icon report", "aria-hidden": "true" }, icon("flag")),
        h(
          "div",
          { class: "inbox-main" },
          h(
            "div",
            { class: "inbox-top" },
            h("strong", null, "Your report about ", r.mod_slug ? h("a", { href: `#/mod/${encodeURIComponent(r.mod_slug)}` }, r.mod_name) : r.mod_name),
            h("span", { class: `inbox-pill ${statusClass}` }, statusText),
            isNew ? h("span", { class: "inbox-new" }, "New") : null,
          ),
          h("p", { class: "muted small" }, `${reasonLabel(r.reason)} · sent ${formatDate(r.created_at)}${r.resolved_at ? ` · updated ${formatDate(r.resolved_at)}` : ""}`),
          r.reply
            ? h("div", { class: "inbox-reply" }, h("span", { class: "section-label" }, "Reply from Branch"), h("p", null, r.reply))
            : r.status === "open"
              ? h("p", { class: "muted small" }, "thanks for reporting. you'll see any reply here.")
              : null,
        ),
      );
    }
    const kindLabel = item.kind === "release" ? "Update" : item.kind === "update" ? "Update log" : item.kind === "notice" ? "Notice" : "Announcement";
    return h(
      "article",
      { class: `inbox-card ${item.type}${isNew ? " is-new" : ""}` },
      h("span", { class: `inbox-icon ${item.type}`, "aria-hidden": "true" }, icon(item.type === "update" ? "download" : item.kind === "notice" ? "alert" : "megaphone")),
      h(
        "div",
        { class: "inbox-main" },
        h("div", { class: "inbox-top" }, h("strong", null, item.title), h("span", { class: "inbox-pill" }, kindLabel), isNew ? h("span", { class: "inbox-new" }, "New") : null),
        h("p", { class: "muted small" }, formatDate(item.date.toISOString())),
        item.body ? h("div", { class: "prose inbox-body", html: renderMarkdown(item.body) }) : null,
      ),
    );
  }

  function renderList(list) {
    const shown = filter === "all" ? items : items.filter((i) => i.type === filter);
    if (!shown.length) {
      const empty = {
        all: ["Nothing here yet", "announcements, update logs and replies to your reports show up here."],
        announcement: ["No announcements yet", "news from the Branch team shows up here."],
        update: ["No updates yet", "what's new in each version of Branch shows up here."],
        report: ["No reports yet", "when you report a mod, you can follow it here and see the reply."],
      }[filter];
      clear(list).append(stateBlock({ iconName: "inbox", title: empty[0], message: empty[1] }));
      return;
    }
    clear(list).append(...shown.map(card));
  }

  async function render() {
    clear(el).append(h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "inbox-title" }, "Inbox")), h("div", { class: "spinner", role: "progressbar", "aria-label": "Loading inbox" }));
    let data;
    try {
      data = await api("/api/inbox", { method: "POST", body: { key: forumKey() } });
    } catch (err) {
      clear(el).append(h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "inbox-title" }, "Inbox")), errorBlock(err, render));
      return;
    }
    since = seenAt();
    items = toItems(data);
    const list = h("div", { class: "inbox-list" });
    const tabs = h(
      "div",
      { class: "segmented inbox-filters", role: "radiogroup", "aria-label": "Show" },
      FILTERS.map(([value, label]) => {
        const count = value === "all" ? 0 : items.filter((i) => i.type === value && i.date.getTime() > since).length;
        return h(
          "label",
          null,
          h("input", { type: "radio", name: "inbox-filter", value, checked: filter === value, onchange: () => { filter = value; renderList(list); } }),
          h("span", null, label, count ? h("span", { class: "inbox-tab-count" }, String(count)) : null),
        );
      }),
    );
    clear(el).append(
      h("header", { class: "view-head" }, h("h1", { class: "view-title", id: "inbox-title" }, "Inbox")),
      h("p", { class: "muted inbox-intro" }, "news from the Branch team, what's new in each update, and replies to the reports you've sent."),
      tabs,
      list,
    );
    renderList(list);
    markSeen();
    ctx.setInboxCount?.(0);
  }

  return { el, title: () => "Inbox", show() { render(); return 0; }, hide() {} };
}
