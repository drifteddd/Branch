// the rewards page: earn robux for uploading unique mods.
// upload 10 unique mods, apply, get accepted, then every new unique upload earns 10 R$
// (up to 50 a day and 500 total). a limited-time offer the operator can end at any time.
import { h, clear, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { api, openExternal } from "../platform.js";
import { forumKey } from "../forum-identity.js";
import { errorBlock, toast } from "../ui.js";
import { settings } from "../store.js";

const reduceMotion = () => settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

// grows a bar from 0 to its value so progress feels earned
function animateBar(fill, percent) {
  const target = Math.max(0, Math.min(100, percent));
  if (reduceMotion()) {
    fill.style.width = `${target}%`;
    return;
  }
  fill.style.width = "0%";
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${target}%`; }));
}

function robux(n) {
  return h("span", { class: "robux" }, h("span", { class: "robux-mark", "aria-hidden": "true" }, "R$"), h("span", { class: "visually-hidden" }, "Robux "), String(n));
}

function bar(percent, cls = "") {
  const fill = h("div", { class: "rw-bar-fill" });
  const el = h("div", { class: `rw-bar ${cls}`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(percent)) }, fill);
  animateBar(fill, percent);
  return el;
}

export function createRewardsView(ctx) {
  const el = h("section", { class: "view rewards", "aria-labelledby": "rewards-title" });

  function hero(enabled, limits) {
    return h(
      "header",
      { class: "rw-hero" },
      h("div", { class: "rw-hero-glow", "aria-hidden": "true" }),
      h(
        "div",
        { class: "rw-hero-text" },
        h("span", { class: "rw-pill" }, icon("sparkle"), enabled ? "Limited-time offer" : "Paused"),
        h("h1", { id: "rewards-title" }, "Earn Robux for sharing mods"),
        h("p", null, `get ${limits.per_mod} R$ for every unique mod you upload after your first ${10}. earn up to ${limits.total} R$.`),
      ),
      h("div", { class: "rw-coin", "aria-hidden": "true" }, h("span", null, "R$")),
    );
  }

  function steps(current) {
    const items = [
      ["Upload 10 unique mods", "copies of mods already on Branch don't count."],
      ["Apply", "add your roblox username and an item for payouts."],
      ["Get approved", "the AI checks your uploads, then the operator reviews."],
      ["Earn", "10 R$ for each new unique mod. up to 50 R$ a day."],
    ];
    return h(
      "ol",
      { class: "rw-steps" },
      items.map(([title, text], i) =>
        h(
          "li",
          { class: i < current ? "done" : i === current ? "current" : "" },
          h("span", { class: "rw-step-dot", "aria-hidden": "true" }, i < current ? icon("check") : String(i + 1)),
          h("div", null, h("strong", null, title), h("p", null, text)),
        ),
      ),
    );
  }

  function rules(limits) {
    return h(
      "details",
      { class: "rw-rules" },
      h("summary", null, "How rewards work"),
      h(
        "ul",
        null,
        h("li", null, `after you're accepted, each new unique mod you upload adds ${limits.per_mod} R$ to your rewards.`),
        h("li", null, `you can earn up to ${limits.daily} R$ a day and ${limits.total} R$ in total. uploads before you were accepted don't earn anything.`),
        h("li", null, "the operator pays you by buying your gamepass or clothing item for what you've earned. roblox's marketplace fees apply."),
        h("li", null, "copied, stolen, fake or harmful uploads aren't rewarded, and can get you removed from the program."),
        h("li", null, "this is a limited-time offer. it can change or end at any time at the operator's discretion, and it may come back later."),
        h("li", null, "if you're under 18, you need a parent or guardian's permission to take part."),
      ),
      h("p", { class: "muted small" }, "see the Terms of Use for the full rules. Branch isn't affiliated with Roblox."),
    );
  }

  function progressCard(data) {
    const left = Math.max(0, data.threshold - data.uploads);
    const dots = h(
      "div",
      { class: "rw-dots", "aria-hidden": "true" },
      Array.from({ length: data.threshold }, (_, i) => h("span", { class: i < Math.min(data.uploads, data.threshold) ? "on" : "" })),
    );
    return h(
      "section",
      { class: "rw-card rw-progress" },
      h(
        "div",
        { class: "rw-progress-head" },
        h("div", null, h("p", { class: "rw-label" }, "Your progress"), h("p", { class: "rw-big" }, h("span", null, String(Math.min(data.uploads, data.threshold))), h("small", null, ` / ${data.threshold} unique mods`))),
        left > 0 ? h("a", { class: "btn btn-primary", href: "#/upload" }, icon("upload"), "Upload a mod") : null,
      ),
      bar((Math.min(data.uploads, data.threshold) / data.threshold) * 100, "gold"),
      dots,
      h("p", { class: "rw-note" }, left > 0 ? `${left} more unique ${left === 1 ? "mod" : "mods"} until you can apply.` : "you've reached 10 unique mods. you can apply now!"),
    );
  }

  function applyCard(data, reload) {
    const username = h("input", { class: "input", id: "rw-username", maxlength: "20", autocomplete: "off", placeholder: "your roblox username" });
    const item = h("input", { class: "input", id: "rw-item", type: "url", autocomplete: "off", placeholder: "https://www.roblox.com/game-pass/…" });
    const confirm = h("input", { type: "checkbox", id: "rw-confirm" });
    const submit = h("button", { class: "btn btn-primary btn-large", type: "submit" }, "Apply for rewards");
    const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
    const errorFor = (key) => h("p", { class: "error", "data-error": key, hidden: true });
    const form = h(
      "form",
      { class: "rw-card rw-apply", novalidate: true },
      h("h2", null, "Apply for the rewards program"),
      h("p", { class: "muted" }, "the AI checks that your uploads are unique, then the operator reviews your application."),
      h("div", { class: "field" }, h("label", { for: "rw-username" }, "Roblox username", h("span", { class: "req", "aria-hidden": "true" }, "*")), username, errorFor("roblox_username")),
      h(
        "div",
        { class: "field" },
        h("label", { for: "rw-item" }, "Gamepass or clothing item link", h("span", { class: "req", "aria-hidden": "true" }, "*")),
        item,
        h("p", { class: "hint" }, "the operator pays you by buying this item. make one on roblox (a gamepass, shirt or pants) and paste its link."),
        errorFor("payout_item_url"),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "inline-check legal-check", for: "rw-confirm" }, confirm, h("span", null, "I agree to the Rewards Program terms in the Terms of Use. I understand rewards are discretionary, limited-time, capped at 50 R$ per day and 500 R$ in total, may be withdrawn or voided, and are paid by the Operator purchasing the item above. If I am under 18, I have a parent or guardian's permission.")),
        errorFor("confirm"),
      ),
      formError,
      h("div", null, submit),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      for (const e of form.querySelectorAll(".error")) e.hidden = true;
      formError.hidden = true;
      submit.disabled = true;
      submit.replaceChildren(h("span", { class: "spinner small-spinner", "aria-hidden": "true" }), "Checking your uploads…");
      try {
        const result = await api("/api/rewards/apply", { method: "POST", body: { key: forumKey(), roblox_username: username.value.trim(), payout_item_url: item.value.trim(), confirm: confirm.checked } });
        toast(result.status === "pending" ? "Application sent for review" : "Your application wasn't approved", { tone: result.status === "pending" ? "ok" : "error" });
        reload();
      } catch (err) {
        if (err.fields) {
          for (const [key, message] of Object.entries(err.fields)) {
            const e = form.querySelector(`[data-error="${key}"]`);
            if (e) { e.textContent = message; e.hidden = false; }
          }
        } else {
          formError.replaceChildren(icon("alert"), h("p", null, err.message));
          formError.hidden = false;
        }
        submit.disabled = false;
        submit.replaceChildren("Apply for rewards");
      }
    });
    return form;
  }

  function statusCard(kind, title, text, extra) {
    return h("section", { class: `rw-card rw-status ${kind}` }, h("div", { class: "rw-status-icon" }, icon(kind === "pending" ? "clock" : kind === "rejected" ? "alert" : "info")), h("div", null, h("h2", null, title), h("p", null, text), extra || null));
  }

  function dashboard(m, limits) {
    const tile = (label, value, max, sub, cls) =>
      h(
        "div",
        { class: `rw-tile ${cls || ""}` },
        h("p", { class: "rw-label" }, label),
        h("p", { class: "rw-tile-value" }, robux(value), max ? h("small", null, ` / ${max}`) : null),
        max ? bar((value / max) * 100, cls === "today" ? "teal" : "gold") : null,
        sub ? h("p", { class: "muted small" }, sub) : null,
      );
    const events = m.events.length
      ? h(
          "ul",
          { class: "rw-events" },
          m.events.map((e) =>
            h(
              "li",
              { class: e.status },
              h("span", { class: "rw-event-plus" }, `+${e.amount}`),
              h("div", null, e.mod_id ? h("strong", null, e.mod_name) : h("strong", null, e.mod_name), h("p", { class: "muted small" }, formatDate(e.created_at))),
              h("span", { class: `rw-event-status ${e.status}` }, e.status === "owed" ? "waiting for payout" : e.status === "paid" ? "paid" : "voided"),
            ),
          ),
        )
      : h("p", { class: "muted rw-empty" }, "you haven't earned anything yet. upload a new unique mod to earn your first 10 R$!");
    return [
      h(
        "section",
        { class: "rw-card rw-member" },
        h("div", { class: "rw-member-head" }, h("div", null, h("span", { class: "rw-pill dark" }, icon("check"), "Member"), h("h2", null, `Hi, ${m.roblox_username}`)), h("a", { class: "btn", href: "#/upload" }, icon("upload"), "Upload a mod")),
        h("div", { class: "rw-tiles" }, tile("Total earned", m.earned, limits.total, m.earned >= limits.total ? "you've reached the limit. thank you!" : `${limits.total - m.earned} R$ left to earn`, "total"), tile("Earned today", m.today, limits.daily, "resets at midnight (UTC)", "today"), tile("Waiting for payout", m.owed, null, m.paid ? `${m.paid} R$ paid so far` : "the operator pays out by buying your item", "owed")),
        h("p", { class: "muted small" }, "payout item: ", h("a", { href: m.payout_item_url, "data-external": true }, "your roblox item", icon("external", "inline-icon"))),
      ),
      h("section", { class: "rw-card" }, h("h2", null, "Your rewards"), events),
    ];
  }

  async function render() {
    clear(el).append(h("div", { class: "rw-hero skeleton rw-hero-skeleton" }), h("div", { class: "skeleton sk-line" }));
    let data;
    try {
      data = await api("/api/rewards/me", { method: "POST", body: { key: forumKey() } });
    } catch (err) {
      clear(el).append(errorBlock(err, render));
      return;
    }
    const m = data.member;
    const blocks = [hero(data.enabled, data.limits)];

    if (!data.enabled && !(m && m.status === "accepted")) {
      blocks.push(statusCard("info", "The rewards program is paused", "the operator has ended the rewards program for now. it may come back later, so check back!"));
    } else if (!m || (m.status === "rejected" && canReapply(m))) {
      const current = data.uploads >= data.threshold ? 1 : 0;
      blocks.push(progressCard(data), steps(current));
      if (m && m.status === "rejected") blocks.push(statusCard("rejected", "Your last application wasn't approved", m.review?.summary || "you can apply again now.", reasonsList(m.review?.reasons)));
      if (data.uploads >= data.threshold) blocks.push(applyCard(data, render));
    } else if (m.status === "pending") {
      blocks.push(steps(2), statusCard("pending", "Your application is being reviewed", `applied ${formatDate(m.applied_at)} as ${m.roblox_username}. you'll see the result here.`));
    } else if (m.status === "rejected") {
      blocks.push(statusCard("rejected", "Your application wasn't approved", m.review?.summary || "the operator didn't approve this application.", h("div", null, reasonsList(m.review?.reasons), h("p", { class: "muted small" }, `you can apply again ${reapplyText(m)}.`))));
    } else if (m.status === "removed") {
      blocks.push(statusCard("rejected", "You're no longer in the rewards program", "the operator removed you from the program. rewards you were already owed may still be paid at the operator's discretion."));
    } else {
      blocks.push(...dashboard(m, data.limits));
      if (!data.enabled) blocks.push(statusCard("info", "The rewards program is paused", "new uploads aren't earning rewards right now. anything you're owed is still shown above."));
    }
    blocks.push(rules(data.limits));
    clear(el).append(...blocks);
  }

  function reasonsList(reasons) {
    return reasons?.length ? h("ul", { class: "rw-reasons" }, reasons.map((r) => h("li", null, r))) : null;
  }

  function canReapply(m) {
    return !m.decided_at || Date.now() - new Date(m.decided_at).getTime() > 24 * 3600 * 1000;
  }

  function reapplyText(m) {
    const hours = Math.ceil((24 * 3600 * 1000 - (Date.now() - new Date(m.decided_at).getTime())) / 3600000);
    return hours <= 1 ? "in about an hour" : `in about ${hours} hours`;
  }

  return { el, title: () => "Rewards", show() { render(); return 0; }, hide() {} };
}

export { openExternal };
