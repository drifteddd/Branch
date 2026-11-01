import { h, clear, formatDate, formatNumber, plural } from "../dom.js";
import { icon } from "../icons.js";
import { api, openExternal } from "../platform.js";
import { forumKey } from "../forum-identity.js";
import { errorBlock, toast, thumbnail } from "../ui.js";
import { settings } from "../store.js";

const reduceMotion = () => settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  const el = h("section", { class: "view rewards creator-hub", "aria-labelledby": "hub-title" });
  let host = h("div", { class: "ch-panel" });

  function hero(enabled, limits) {
    return h(
      "header",
      { class: "rw-hero" },
      h("div", { class: "rw-hero-glow", "aria-hidden": "true" }),
      h(
        "div",
        { class: "rw-hero-text" },
        h("span", { class: "rw-pill" }, icon("clock"), enabled ? "Limited-time offer" : "Paused"),
        h("h2", { class: "rw-hero-title" }, "Earn Robux for sharing mods"),
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

  async function renderRewards(data) {
    if (!data) {
      clear(host).append(h("div", { class: "rw-hero skeleton rw-hero-skeleton" }));
      try {
        data = await api("/api/rewards/me", { method: "POST", body: { key: forumKey() } });
      } catch (err) {
        clear(host).append(errorBlock(err, () => renderRewards()));
        return;
      }
    }
    const render = () => renderRewards();
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
    clear(host).append(...blocks);
  }

  const LEVELS = [
    [0, "Seed", "sprout"],
    [40, "Sprout", "sprout"],
    [150, "Sapling", "tree"],
    [500, "Branch", "tree"],
    [1500, "Oak", "crown"],
    [5000, "Ancient oak", "crown"],
  ];

  function levelOf(t) {
    const points = t.uploads * 20 + t.downloads + t.ratings * 5 + t.featured * 100;
    let i = 0;
    while (i + 1 < LEVELS.length && points >= LEVELS[i + 1][0]) i++;
    const [floor, name, iconName] = LEVELS[i];
    const next = LEVELS[i + 1] || null;
    const percent = next ? ((points - floor) / (next[0] - floor)) * 100 : 100;
    return { points, number: i + 1, name, iconName, next, percent, toNext: next ? next[0] - points : 0 };
  }

  function badgesFor(t, rank) {
    return [
      { id: "first", icon: "sprout", title: "First upload", text: "share your first mod", have: t.uploads, need: 1 },
      { id: "five", icon: "layers", title: "Collector", text: "upload 5 mods", have: t.uploads, need: 5 },
      { id: "ten", icon: "box", title: "Prolific", text: "upload 10 mods", have: t.uploads, need: 10 },
      { id: "dl100", icon: "download", title: "Getting noticed", text: "reach 100 downloads", have: t.downloads, need: 100 },
      { id: "dl1k", icon: "flame", title: "On fire", text: "reach 1,000 downloads", have: t.downloads, need: 1000 },
      { id: "loved", icon: "starFill", title: "Fan favorite", text: "a mod with 4.5+ stars from 3+ ratings", have: t.five_star, need: 1 },
      { id: "featured", icon: "award", title: "Featured", text: "get a mod into the top 10", have: t.featured, need: 1 },
      { id: "top", icon: "crown", title: "Top creator", text: "be a top 10 creator by downloads", have: rank && rank <= 10 ? 1 : 0, need: 1 },
      { id: "github", icon: "repo", title: "Autopilot", text: "link a mod to github so updates arrive by themselves", have: t.github_linked, need: 1 },
      { id: "clean", icon: "scan", title: "Clean record", text: "every upload passes the safety check", have: t.clean ? 1 : 0, need: 1 },
    ].map((b) => ({ ...b, earned: b.have >= b.need }));
  }

  function levelRing(level) {
    const r = 46;
    const c = 2 * Math.PI * r;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 108 108");
    svg.setAttribute("class", "ch-ring");
    svg.setAttribute("aria-hidden", "true");
    const track = document.createElementNS(ns, "circle");
    const fill = document.createElementNS(ns, "circle");
    for (const [node, cls] of [[track, "ch-ring-track"], [fill, "ch-ring-fill"]]) {
      node.setAttribute("cx", "54");
      node.setAttribute("cy", "54");
      node.setAttribute("r", String(r));
      node.setAttribute("class", cls);
      svg.append(node);
    }
    fill.setAttribute("stroke-dasharray", String(c));
    const offset = c * (1 - Math.max(0, Math.min(100, level.percent)) / 100);
    if (reduceMotion()) fill.setAttribute("stroke-dashoffset", String(offset));
    else {
      fill.setAttribute("stroke-dashoffset", String(c));
      requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute("stroke-dashoffset", String(offset))));
    }
    return h("div", { class: "ch-level" }, svg, h("div", { class: "ch-level-inner" }, icon(level.iconName), h("strong", null, `Lv ${level.number}`)));
  }

  function sparkline(values) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 140 36");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "ch-spark");
    svg.setAttribute("aria-hidden", "true");
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => [(i / (values.length - 1)) * 140, 33 - (v / max) * 29]);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = document.createElementNS(ns, "polygon");
    area.setAttribute("points", `0,36 ${line} 140,36`);
    area.setAttribute("class", "ch-spark-area");
    const poly = document.createElementNS(ns, "polyline");
    poly.setAttribute("points", line);
    poly.setAttribute("class", "ch-spark-line");
    svg.append(area, poly);
    return svg;
  }

  function hubHero(data, level) {
    const t = data.totals;
    const fresh = t.uploads === 0;
    return h(
      "header",
      { class: "ch-hero" },
      h("div", { class: "ch-hero-glow", "aria-hidden": "true" }),
      levelRing(level),
      h(
        "div",
        { class: "ch-hero-text" },
        h("span", { class: "rw-pill" }, icon("hub"), "Creator hub"),
        h("h1", { id: "hub-title" }, fresh ? "Start your creator journey" : `Hi, ${data.name}`),
        h(
          "p",
          null,
          fresh
            ? "upload your first mod to plant your seed. every upload, download and rating grows your level and unlocks badges."
            : level.next
              ? `Level ${level.number} · ${level.name}. ${formatNumber(level.toNext)} more points to ${level.next[1]}.`
              : `Level ${level.number} · ${level.name}. you've reached the top level!`,
        ),
        h("div", { class: "ch-level-bar" }, bar(level.percent, "gold")),
        h("p", { class: "ch-points" }, `${formatNumber(level.points)} points`, h("span", null, "20 per upload · 1 per download · 5 per rating · 100 per featured mod")),
      ),
      h("a", { class: "btn btn-primary ch-hero-cta", href: "#/upload" }, icon("upload"), fresh ? "Upload your first mod" : "Upload a mod"),
    );
  }

  function statTiles(data) {
    const t = data.totals;
    const tile = (iconName, label, value, sub, extra, cls = "") =>
      h("div", { class: `ch-tile ${cls}` }, h("div", { class: "ch-tile-head" }, h("span", { class: "ch-tile-icon" }, icon(iconName)), h("p", { class: "rw-label" }, label)), h("p", { class: "ch-tile-value" }, value), sub ? h("p", { class: "muted small" }, sub) : null, extra || null);
    return h(
      "div",
      { class: "ch-tiles" },
      tile("download", "Downloads", formatNumber(t.downloads), t.week_downloads ? `+${formatNumber(t.week_downloads)} this week` : "none this week yet", sparkline(data.daily), "downloads"),
      tile("star", "Rating", t.average ? h("span", null, t.average.toFixed(1), h("small", null, " / 5")) : "–", t.ratings ? plural(t.ratings, "rating", "ratings") : "no ratings yet"),
      tile("award", "Featured", formatNumber(t.featured), t.featured ? "in the top 10 right now" : "top rated mods get featured"),
      tile("crown", "Creator rank", data.rank ? `#${formatNumber(data.rank)}` : "–", data.rank ? `of ${plural(data.creators, "creator", "creators")}` : "upload a mod to get ranked"),
    );
  }

  function badgeGrid(data) {
    const badges = badgesFor(data.totals, data.rank);
    const earned = badges.filter((b) => b.earned).length;
    return h(
      "section",
      { class: "rw-card ch-badges" },
      h("div", { class: "ch-card-head" }, h("h2", null, "Badges"), h("span", { class: "ch-count" }, `${earned} / ${badges.length}`)),
      h(
        "ul",
        { class: "ch-badge-grid" },
        badges.map((b) =>
          h(
            "li",
            { class: `ch-badge${b.earned ? " earned" : ""}`, title: b.text },
            h("span", { class: "ch-badge-medal" }, icon(b.icon)),
            h("strong", null, b.title),
            h("p", null, b.text),
            b.earned ? h("span", { class: "ch-badge-state" }, icon("check"), "Earned") : b.need > 1 ? h("div", { class: "ch-badge-progress" }, bar((b.have / b.need) * 100), h("span", null, `${formatNumber(Math.min(b.have, b.need))} / ${formatNumber(b.need)}`)) : h("span", { class: "ch-badge-state locked" }, "Locked"),
          ),
        ),
      ),
    );
  }

  function rewardsTeaser(rewards) {
    if (!rewards || !rewards.enabled) return null;
    const m = rewards.member;
    const text = m && m.status === "accepted"
      ? `you've earned ${m.earned} R$ so far. every new unique mod adds ${rewards.limits.per_mod} R$.`
      : m && m.status === "pending"
        ? "your rewards application is being reviewed."
        : `${Math.min(rewards.uploads, rewards.threshold)} / ${rewards.threshold} unique mods. reach ${rewards.threshold} to apply and earn ${rewards.limits.per_mod} R$ per mod after that.`;
    return h(
      "button",
      { class: "ch-teaser", type: "button", onclick: () => switchTab("rewards") },
      h("span", { class: "ch-teaser-coin", "aria-hidden": "true" }, "R$"),
      h("div", null, h("strong", null, "Earn Robux for your uploads"), h("p", null, text), !m ? bar((Math.min(rewards.uploads, rewards.threshold) / rewards.threshold) * 100, "gold") : null),
      icon("chevronRight"),
    );
  }

  function githubRow(mod, reload) {
    if (!mod.github) {
      const input = h("input", { class: "input", type: "url", placeholder: "https://github.com/you/your-mod", "aria-label": `GitHub link for ${mod.name}` });
      const error = h("p", { class: "error", hidden: true });
      const save = h("button", { class: "btn btn-primary", type: "submit" }, "Link");
      const form = h("form", { class: "ch-gh-form", hidden: true }, input, save, error);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        error.hidden = true;
        save.disabled = true;
        try {
          await api(`/api/creator/mods/${encodeURIComponent(mod.slug)}/github`, { method: "POST", body: { key: forumKey(), url: input.value.trim() } });
          toast("Linked to GitHub. new releases will be added automatically.", { tone: "ok" });
          reload();
        } catch (err) {
          error.textContent = err.fields?.url || err.message;
          error.hidden = false;
          save.disabled = false;
        }
      });
      const open = h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => { open.hidden = true; form.hidden = false; input.focus(); } }, icon("repo"), "Link GitHub for automatic updates");
      return h("div", { class: "ch-gh" }, open, form);
    }
    const g = mod.github;
    const sw = h("input", { type: "checkbox", checked: g.sync, "aria-label": `Automatic GitHub updates for ${mod.name}` });
    sw.addEventListener("change", async () => {
      sw.disabled = true;
      try {
        await api(`/api/creator/mods/${encodeURIComponent(mod.slug)}/github`, { method: "POST", body: { key: forumKey(), sync: sw.checked } });
        toast(sw.checked ? "Automatic updates are on" : "Automatic updates are off", { tone: "ok" });
      } catch (err) {
        sw.checked = !sw.checked;
        toast(err.message, { tone: "error" });
      }
      sw.disabled = false;
    });
    const status = g.tag ? `newest github release: ${g.tag}` : g.checked_at ? "no releases found on github yet" : "Branch checks github every 30 minutes";
    return h(
      "div",
      { class: "ch-gh linked" },
      h("span", { class: "ch-gh-icon" }, icon("repo")),
      h("div", { class: "ch-gh-text" }, h("strong", null, "Auto-update from GitHub"), h("p", { class: "muted small" }, h("a", { href: g.url, "data-external": true }, g.repo), ` · ${status}${g.updates ? ` · ${plural(g.updates, "update", "updates")} added` : ""}`)),
      h("span", { class: "switch" }, sw),
    );
  }

  function modCard(mod, reload) {
    const score = mod.scan_score;
    return h(
      "article",
      { class: "ch-mod" },
      h("a", { class: "ch-mod-thumb", href: `#/mod/${encodeURIComponent(mod.slug)}`, tabindex: "-1", "aria-hidden": "true" }, thumbnail(mod.thumbnail_url, "ch-thumb", mod)),
      h(
        "div",
        { class: "ch-mod-main" },
        h(
          "div",
          { class: "ch-mod-top" },
          h("a", { class: "ch-mod-name", href: `#/mod/${encodeURIComponent(mod.slug)}` }, mod.name),
          mod.latest_version ? h("span", { class: "muted small" }, mod.latest_version) : null,
          mod.featured ? h("span", { class: "ch-tag gold" }, icon("award"), "Featured") : null,
          mod.status !== "published" ? h("span", { class: "ch-tag" }, "Hidden") : null,
          score != null && score <= 40 ? h("span", { class: "ch-tag ok" }, icon("scan"), "Looks clean") : null,
        ),
        h(
          "div",
          { class: "ch-mod-stats" },
          h("span", null, icon("download"), h("strong", null, formatNumber(mod.downloads)), " downloads"),
          h("span", null, icon("trend"), h("strong", null, `+${formatNumber(mod.week_downloads)}`), " this week"),
          h("span", null, icon("star"), mod.rating.count ? h("strong", null, mod.rating.average.toFixed(1)) : h("strong", null, "–"), ` (${formatNumber(mod.rating.count)})`),
          h("span", { class: "muted" }, `uploaded ${formatDate(mod.created_at)}`),
        ),
        githubRow(mod, reload),
      ),
    );
  }

  function modsPanel(data, reload) {
    if (!data.mods.length) {
      return h(
        "section",
        { class: "rw-card ch-empty" },
        h("span", { class: "ch-empty-icon" }, icon("sprout")),
        h("h2", null, "No uploads yet"),
        h("p", { class: "muted" }, "mods you upload from this computer show up here with their downloads, ratings and automatic github updates."),
        h("a", { class: "btn btn-primary", href: "#/upload" }, icon("upload"), "Upload a mod"),
      );
    }
    return h(
      "section",
      { class: "ch-mods" },
      h("p", { class: "muted small" }, "link a mod to its github repo and Branch adds every new github release to it automatically, after a safety check."),
      ...data.mods.map((m) => modCard(m, reload)),
    );
  }

  function topMods(data) {
    const best = [...data.mods].filter((m) => m.status === "published").sort((a, b) => b.week_downloads - a.week_downloads || b.downloads - a.downloads).slice(0, 3);
    if (!best.length) return null;
    return h(
      "section",
      { class: "rw-card" },
      h("div", { class: "ch-card-head" }, h("h2", null, "Your top mods this week"), h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => switchTab("mods") }, "See all")),
      h(
        "ol",
        { class: "ch-top" },
        best.map((m, i) => h("li", null, h("span", { class: "ch-top-rank" }, String(i + 1)), h("a", { href: `#/mod/${encodeURIComponent(m.slug)}` }, m.name), h("span", { class: "muted small" }, `+${formatNumber(m.week_downloads)} this week · ${formatNumber(m.downloads)} total`))),
      ),
    );
  }

  let tab = "overview";
  let hub = null;
  let rewards = null;
  const TABS = [["overview", "Overview"], ["mods", "My mods"], ["rewards", "Robux rewards"]];

  function switchTab(next) {
    tab = next;
    for (const input of el.querySelectorAll(".ch-tabs input")) input.checked = input.value === tab;
    paint();
  }

  function paint() {
    if (!hub) return;
    host = h("div", { class: "ch-panel" });
    const level = levelOf(hub.totals);
    if (tab === "overview") host.append(statTiles(hub), rewardsTeaser(rewards) || "", badgeGrid(hub), topMods(hub) || "");
    else if (tab === "mods") host.append(modsPanel(hub, render));
    else renderRewards(rewards);
    const tabs = h(
      "div",
      { class: "segmented ch-tabs", role: "radiogroup", "aria-label": "Creator hub sections" },
      TABS.map(([value, label]) =>
        h("label", null, h("input", { type: "radio", name: "hub-tab", value, checked: tab === value, onchange: () => switchTab(value) }), h("span", null, label, value === "mods" && hub.mods.length ? h("span", { class: "inbox-tab-count ch-tab-count" }, String(hub.mods.length)) : null)),
      ),
    );
    clear(el).append(hubHero(hub, level), tabs, host);
  }

  async function render() {
    if (!hub) clear(el).append(h("div", { class: "ch-hero skeleton rw-hero-skeleton" }), h("div", { class: "skeleton sk-line" }));
    try {
      const [mine, rw] = await Promise.all([
        api("/api/creator/me", { method: "POST", body: { key: forumKey() } }),
        api("/api/rewards/me", { method: "POST", body: { key: forumKey() } }).catch(() => null),
      ]);
      hub = mine;
      rewards = rw;
    } catch (err) {
      clear(el).append(errorBlock(err, render));
      return;
    }
    paint();
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

  return { el, title: () => "Creator hub", show() {
      const wanted = new URLSearchParams(location.hash.split("?")[1] || "").get("tab");
      if (TABS.some(([value]) => value === wanted)) tab = wanted;
      render();
      return 0;
    }, hide() {} };
}

export { openExternal };
