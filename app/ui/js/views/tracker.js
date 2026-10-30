// the free beta player tracker. a discord bot posts rooms it finds, and branch shows the
// players one at a time, so there's a steady stream instead of a whole room at once.
import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { api, isDesktop } from "../platform.js";
import { errorBlock, toast } from "../ui.js";
import { settings } from "../store.js";

const FEED_SIZE = 50;
const CHECK_EVERY = 6000;

// gorilla tag's color sliders go from 0 to 9
const gameColor = ([r, g, b]) => [r, g, b].map((v) => Math.round((v / 255) * 9)).join(" ");

function timeAgo(date) {
  const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hours = Math.round(m / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function createTrackerView() {
  const el = h("section", { class: "view tracker-view", "aria-labelledby": "tracker-title" });
  const seenCards = new Set();
  let cards = []; // newest first, straight from the server
  let feed = []; // the player cards on screen, newest first
  let queue = []; // players waiting to stream in
  let status = "starting";
  let paused = false;
  let query = "";
  let region = "";
  let checkTimer = 0;
  let dripTimer = 0;
  let clockTimer = 0;
  let started = false;
  let list, statusPill, statsRow, regionRow, pauseButton, notice, emptyNote;

  const reduceMotion = () => settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

  // one sighting: a player in a room at a time
  const sightings = (card) => card.players.map((p) => ({ ...p, room: card.room, region: card.region, seen: new Date(card.seen_at), key: `${card.id}:${p.id}` }));

  function copy(text, what) {
    navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied`, { tone: "ok" }),
      () => toast("couldn't copy. select the text instead.", { tone: "error" }),
    );
  }

  function playerCard(s, animate) {
    const swatch = h("span", { class: "tk-swatch", "aria-hidden": "true" });
    swatch.style.background = `rgb(${s.color.join(",")})`;
    const card = h(
      "li",
      { class: `tk-card${animate && !reduceMotion() ? " tk-in" : ""}`, dataset: { key: s.key } },
      swatch,
      h(
        "div",
        { class: "tk-main" },
        h("div", { class: "tk-name-row" }, h("strong", { class: "tk-name" }, s.name), h("span", { class: "tk-time", dataset: { seen: String(s.seen.getTime()) } }, timeAgo(s.seen))),
        h(
          "div",
          { class: "tk-meta" },
          h("button", { class: "tk-chip tk-room", type: "button", title: "Copy room code", onclick: () => copy(s.room, "Room code") }, icon("copy"), s.room),
          s.region ? h("span", { class: "tk-chip" }, s.region) : null,
          h("span", { class: "tk-color", title: `color ${s.color.join(", ")} (rgb)` }, `color ${gameColor(s.color)}`),
        ),
      ),
      h("button", { class: "tk-id", type: "button", title: "Copy player ID", "aria-label": `Copy player ID ${s.id}`, onclick: () => copy(s.id, "Player ID") }, h("code", null, s.id), icon("copy")),
    );
    return card;
  }

  function matches(s) {
    if (region && s.region !== region) return false;
    if (!query) return true;
    return [s.name, s.id, s.room].some((v) => v.toLowerCase().includes(query));
  }

  function filtering() {
    return Boolean(query || region);
  }

  // with a search or region picked, look through everything in the last 50 rooms.
  // otherwise show the live stream.
  function renderList() {
    if (!list) return;
    const items = filtering() ? cards.flatMap(sightings).filter(matches) : feed;
    clear(list).append(...items.map((s) => playerCard(s, false)));
    emptyNote.hidden = items.length > 0;
    emptyNote.textContent = filtering() ? "no players match. try a different name, ID, room or region." : status === "not_set_up" ? "" : "waiting for the first players to come in…";
    renderStats();
  }

  function renderStats() {
    if (!statsRow) return;
    const players = cards.reduce((n, c) => n + c.players.length, 0);
    const regions = new Set(cards.map((c) => c.region).filter(Boolean));
    statsRow.replaceChildren(
      h("div", { class: "tk-stat" }, h("strong", null, String(players)), h("span", null, "players found")),
      h("div", { class: "tk-stat" }, h("strong", null, String(cards.length)), h("span", null, cards.length === 1 ? "room" : "rooms")),
      h("div", { class: "tk-stat" }, h("strong", null, String(regions.size)), h("span", null, regions.size === 1 ? "region" : "regions")),
      h("div", { class: "tk-stat" }, h("strong", null, String(queue.length)), h("span", null, "coming up")),
    );
    const known = [...regions].sort();
    const chips = [["", "All regions"], ...known.map((r) => [r, r])];
    regionRow.replaceChildren(
      ...chips.map(([value, label]) =>
        h("button", { class: "tk-filter", type: "button", "aria-pressed": String(region === value), onclick: () => { region = value; renderList(); } }, label),
      ),
    );
  }

  function renderStatus() {
    if (!statusPill) return;
    const labels = { live: "Live", starting: "Connecting", offline: "Offline", not_set_up: "Not set up" };
    statusPill.className = `tk-status ${status}`;
    statusPill.replaceChildren(h("span", { class: "tk-dot", "aria-hidden": "true" }), labels[status] || "Offline");
    notice.hidden = status === "live" || status === "starting";
    notice.textContent =
      status === "not_set_up"
        ? "the tracker isn't switched on yet. check back soon."
        : "can't reach the tracker bot right now. you're seeing the last players it found.";
  }

  // spreads each room's players over the time until the next room usually arrives,
  // about 3 seconds each, and speeds up if a lot are waiting
  function nextDelay() {
    if (!isDesktop && window.__branchTrackerDelay) return window.__branchTrackerDelay;
    if (queue.length > 25) return 1000;
    const times = cards.slice(0, 11).map((c) => new Date(c.seen_at).getTime());
    const gaps = times.slice(1).map((t, i) => times[i] - t).filter((g) => g > 0);
    const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 60000;
    return Math.max(1500, Math.min(4500, gap / Math.max(queue.length, 1)));
  }

  function drip() {
    clearTimeout(dripTimer);
    dripTimer = 0;
    if (!queue.length || paused) return;
    const s = queue.shift();
    // the same player in the same room again just moves back to the top
    feed = [s, ...feed.filter((f) => !(f.id === s.id && f.room === s.room))].slice(0, FEED_SIZE);
    if (list && !filtering()) {
      [...list.children].find((li) => li.querySelector(".tk-room")?.textContent === s.room && li.dataset.key.endsWith(`:${s.id}`))?.remove();
      list.prepend(playerCard(s, true));
      while (list.children.length > FEED_SIZE) list.lastElementChild.remove();
      emptyNote.hidden = true;
    }
    renderStats();
    dripTimer = setTimeout(drip, nextDelay());
  }

  async function check() {
    clearTimeout(checkTimer);
    try {
      const data = await api("/api/tracker");
      status = data.status;
      const fresh = data.cards.filter((c) => !seenCards.has(c.id));
      cards = data.cards;
      if (!started) {
        // first look: fill the feed right away, but stream in the newest room so it feels live
        started = true;
        const [newest, ...older] = cards;
        feed = older.flatMap(sightings).slice(0, FEED_SIZE);
        queue = newest ? sightings(newest) : [];
        cards.forEach((c) => seenCards.add(c.id));
        renderList();
      } else if (fresh.length) {
        // oldest first, so players come in the order they were found
        for (const c of [...fresh].reverse()) {
          seenCards.add(c.id);
          queue.push(...sightings(c));
        }
        if (filtering()) renderList();
      }
      renderStatus();
      renderStats();
      if (!dripTimer) drip();
    } catch (err) {
      if (!started) {
        clear(el).append(errorBlock(err, render));
        return;
      }
      status = "offline";
      renderStatus();
    }
    checkTimer = setTimeout(check, CHECK_EVERY);
  }

  function render() {
    list = h("ul", { class: "tk-feed", "aria-label": "Players found" });
    statusPill = h("span", { class: "tk-status starting" });
    statsRow = h("div", { class: "tk-stats" });
    regionRow = h("div", { class: "tk-filters", role: "group", "aria-label": "Region" });
    notice = h("div", { class: "banner warn compact tk-notice", role: "status", hidden: true });
    emptyNote = h("p", { class: "muted tk-empty" }, "waiting for the first players to come in…");
    const search = h("input", { class: "input tk-search", type: "search", placeholder: "Search name, ID or room", "aria-label": "Search players" });
    search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); renderList(); });
    pauseButton = h("button", { class: "btn", type: "button", "aria-pressed": "false" }, "Pause");
    pauseButton.addEventListener("click", () => {
      paused = !paused;
      pauseButton.setAttribute("aria-pressed", String(paused));
      pauseButton.textContent = paused ? "Resume" : "Pause";
      if (!paused) drip();
    });

    clear(el).append(
      h(
        "header",
        { class: "tk-head" },
        h(
          "div",
          null,
          h("div", { class: "tk-title-row" }, h("h1", { class: "view-title", id: "tracker-title" }, "Player Tracker"), h("span", { class: "tk-beta" }, "Beta"), statusPill),
          h("p", { class: "muted" }, "players spotted in public Gorilla Tag rooms, streamed in as they're found. free to use."),
        ),
        pauseButton,
      ),
      statsRow,
      h("div", { class: "tk-tools" }, search, regionRow),
      notice,
      list,
      emptyNote,
      h(
        "p",
        { class: "fine-print tk-fine" },
        "this is a free beta. the data comes from a third-party Discord bot and may be late, incomplete or wrong. use it at your own risk and be respectful to other players. ",
        h("a", { href: "#/legal/terms" }, "Terms of Use"),
      ),
    );
    renderStatus();
    renderStats();
    if (started) renderList();
  }

  function tickClock() {
    for (const t of el.querySelectorAll(".tk-time")) t.textContent = timeAgo(new Date(Number(t.dataset.seen)));
  }

  return {
    el,
    title: () => "Player Tracker",
    show() {
      if (!list) render();
      check();
      clearInterval(clockTimer);
      clockTimer = setInterval(tickClock, 15000);
      if (!paused) drip();
      return 0;
    },
    hide() {
      // stop checking while the tab isn't open. the queue waits for you
      clearTimeout(checkTimer);
      clearTimeout(dripTimer);
      dripTimer = 0;
      clearInterval(clockTimer);
    },
  };
}
