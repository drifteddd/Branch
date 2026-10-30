import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { api, isDesktop } from "../platform.js";
import { errorBlock, toast } from "../ui.js";
import { settings } from "../store.js";

const FEED_SIZE = 50;
const CHECK_EVERY = 6000;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

const gameColor = ([r, g, b]) => [r, g, b].map((v) => Math.round((v / 255) * 9)).join(" ");
const inkFor = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "rgba(0, 0, 0, 0.78)" : "rgba(255, 255, 255, 0.94)");

export function createTrackerView() {
  const el = h("section", { class: "view tracker-view", "aria-labelledby": "tracker-title" });
  const seenCards = new Set();
  let cards = [];
  let feed = [];
  let queue = [];
  let status = "starting";
  let paused = false;
  let query = "";
  let region = "";
  let checkTimer = 0;
  let dripTimer = 0;
  let started = false;
  let list, statusPill, statsRow, regionRow, pauseButton, notice, emptyNote;

  const reduceMotion = () => settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

  const sightings = (card) => card.players.map((p) => ({ ...p, room: card.room, region: card.region, key: `${card.id}:${p.id}`, shown: null }));

  function copy(text, what) {
    navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied`, { tone: "ok" }),
      () => toast("couldn't copy. select the text instead.", { tone: "error" }),
    );
  }

  function playerCard(s, animate) {
    const avatar = h("span", { class: "tk-avatar", "aria-hidden": "true" }, h("span", { class: "tk-glyph" }));
    avatar.style.background = `rgb(${s.color.join(",")})`;
    avatar.firstChild.style.background = inkFor(s.color);
    const shown = s.shown || new Date();
    return h(
      "li",
      { class: `tk-card${animate && !reduceMotion() ? " tk-in" : ""}`, dataset: { key: s.key, room: s.room, player: s.id } },
      h(
        "div",
        { class: "tk-top" },
        avatar,
        h(
          "div",
          { class: "tk-who" },
          h("strong", { class: "tk-name" }, s.name),
          h("button", { class: "tk-id", type: "button", title: "Copy player ID", "aria-label": `Copy player ID ${s.id}`, onclick: () => copy(s.id, "Player ID") }, h("code", null, s.id), icon("copy")),
        ),
        h("time", { class: "tk-time", datetime: shown.toISOString() }, timeFormat.format(shown)),
      ),
      h(
        "div",
        { class: "tk-meta" },
        h("button", { class: "tk-chip tk-room", type: "button", title: "Copy room code", onclick: () => copy(s.room, "Room code") }, h("span", { class: "tk-chip-label" }, "Room"), s.room, icon("copy")),
        s.region ? h("span", { class: "tk-chip" }, h("span", { class: "tk-chip-label" }, "Region"), s.region) : null,
        h("span", { class: "tk-chip", title: `rgb ${s.color.join(", ")}` }, h("span", { class: "tk-chip-label" }, "Color"), gameColor(s.color)),
      ),
    );
  }

  function matches(s) {
    if (region && s.region !== region) return false;
    if (!query) return true;
    return [s.name, s.id, s.room].some((v) => v.toLowerCase().includes(query));
  }

  const filtering = () => Boolean(query || region);

  function renderList() {
    if (!list) return;
    const items = filtering() ? cards.flatMap(sightings).filter(matches).map((s) => feed.find((f) => f.key === s.key) || s) : feed;
    clear(list).append(...items.map((s) => playerCard(s, false)));
    emptyNote.hidden = items.length > 0;
    emptyNote.textContent = filtering() ? "no players match. try a different name, ID, room or region." : status === "not_set_up" ? "" : "waiting for the first players to come in…";
    renderStats();
  }

  function renderStats() {
    if (!statsRow) return;
    const players = cards.reduce((n, c) => n + c.players.length, 0);
    const regions = new Set(cards.map((c) => c.region).filter(Boolean));
    const stat = (value, label) => h("div", { class: "tk-stat" }, h("strong", null, String(value)), h("span", null, label));
    statsRow.replaceChildren(stat(players, players === 1 ? "player found" : "players found"), stat(cards.length, cards.length === 1 ? "room" : "rooms"), stat(regions.size, regions.size === 1 ? "region" : "regions"));
    const chips = [["", "All regions"], ...[...regions].sort().map((r) => [r, r])];
    regionRow.replaceChildren(
      ...chips.map(([value, label]) => h("button", { class: "tk-filter", type: "button", "aria-pressed": String(region === value), onclick: () => { region = value; renderList(); } }, label)),
    );
  }

  function renderStatus() {
    if (!statusPill) return;
    const labels = { live: "Live", starting: "Connecting", offline: "Offline", not_set_up: "Not set up" };
    statusPill.className = `tk-status ${status}`;
    statusPill.replaceChildren(h("span", { class: "tk-dot", "aria-hidden": "true" }), labels[status] || "Offline");
    notice.hidden = status === "live" || status === "starting";
    notice.textContent = status === "not_set_up" ? "the tracker isn't switched on yet. check back soon." : "can't reach the tracker bot right now. you're seeing the last players it found.";
  }

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
    const s = { ...queue.shift(), shown: new Date() };
    feed = [s, ...feed.filter((f) => !(f.id === s.id && f.room === s.room))].slice(0, FEED_SIZE);
    if (list && !filtering()) {
      [...list.children].find((li) => li.dataset.room === s.room && li.dataset.player === s.id)?.remove();
      list.prepend(playerCard(s, true));
      while (list.children.length > FEED_SIZE) list.lastElementChild.remove();
      emptyNote.hidden = true;
    }
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
        started = true;
        const [newest, ...older] = cards;
        const now = Date.now();
        feed = older.flatMap(sightings).slice(0, FEED_SIZE).map((s, i) => ({ ...s, shown: new Date(now - (i + 1) * 3000) }));
        queue = newest ? sightings(newest) : [];
        cards.forEach((c) => seenCards.add(c.id));
        renderList();
      } else if (fresh.length) {
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
        { class: "tk-hero" },
        h("div", { class: "tk-radar", "aria-hidden": "true" }, h("span"), h("span"), icon("radar")),
        h(
          "div",
          { class: "tk-hero-text" },
          h("div", { class: "tk-title-row" }, h("h1", { class: "view-title", id: "tracker-title" }, "Player Tracker"), h("span", { class: "tk-beta" }, "Beta"), statusPill),
          h("p", { class: "muted" }, "players spotted in public Gorilla Tag rooms, streamed in as they're found. free to use."),
          statsRow,
        ),
        pauseButton,
      ),
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

  return {
    el,
    title: () => "Player Tracker",
    show() {
      if (!list) render();
      check();
      if (!paused) drip();
      return 0;
    },
    hide() {
      clearTimeout(checkTimer);
      clearTimeout(dripTimer);
      dripTimer = 0;
    },
  };
}
