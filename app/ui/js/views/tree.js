import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { api, isDesktop } from "../platform.js";
import { errorBlock } from "../ui.js";
import { settings } from "../store.js";

const DEG = Math.PI / 180;
const TRUNK_ANGLE = -83 * DEG;
const PALETTE = ["#2f9e6b", "#3b7fc4", "#d4892b", "#8e5bd6", "#d1495b", "#1aa6a6", "#7a8b2c", "#c45cb0", "#5c6bc0", "#b5783a"];
const NODE_RADIUS = 5.5;
const MODS_PER_BRANCH = 7;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (x, y, angle, length) => ({ x: x + Math.cos(angle) * length, y: y + Math.sin(angle) * length });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function buildTree(mods) {
  const random = seeded(7);
  const segments = [];
  const nodes = [];
  const leaves = [];
  let maxOrder = 1;
  const stamp = (item) => { maxOrder = Math.max(maxOrder, item.order + 1); return item; };

  const groups = new Map();
  const loose = [];
  for (const mod of mods) {
    if (!mod.category_slug) { loose.push(mod); continue; }
    if (!groups.has(mod.category_slug)) groups.set(mod.category_slug, { slug: mod.category_slug, name: mod.category_name || mod.category_slug, mods: [] });
    groups.get(mod.category_slug).mods.push(mod);
  }
  const categories = [...groups.values()].sort((a, b) => b.mods.length - a.mods.length || a.name.localeCompare(b.name));
  categories.forEach((c, i) => { c.color = PALETTE[i % PALETTE.length]; });

  const total = mods.length;
  const trunkLength = 150 + 34 * Math.sqrt(total);
  const trunkWidth = 12 + 1.7 * Math.sqrt(total);
  const top = at(0, 0, TRUNK_ANGLE, trunkLength);

  const placeAlong = (list, from, to, angle, width, color, group, order, start = 0.3) => {
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    list.forEach((mod, k) => {
      const t = list.length === 1 ? (start + 1) / 2 : start + (1 - start) * (k / (list.length - 1));
      const p = lerp(from, to, t);
      const side = k % 2 === 0 ? 1 : -1;
      const offset = side * (width * 0.5 + 8 + random() * 4);
      nodes.push(stamp({ x: p.x + nx * offset, y: p.y + ny * offset, mod, color, group, order: order + t }));
    });
  };

  const grow = (list, x, y, angle, width, color, group, depth, order) => {
    const length = 46 + 30 * Math.sqrt(list.length);
    const end = at(x, y, angle, length);
    segments.push(stamp({ x1: x, y1: y, x2: end.x, y2: end.y, w1: width, w2: Math.max(1.4, width * 0.55), order }));
    const own = depth >= 6 ? list : list.slice(0, MODS_PER_BRANCH);
    const rest = depth >= 6 ? [] : list.slice(MODS_PER_BRANCH);
    placeAlong(own, { x, y }, end, angle, width * 0.7, color, group, order);
    leaves.push(stamp({ x: end.x, y: end.y, angle, length: 14 + 6 * Math.sqrt(own.length), width: 6 + 2.4 * Math.sqrt(own.length), color, order: order + 1 }));
    if (!rest.length) return;
    const kids = Math.min(3, Math.max(1, Math.ceil(rest.length / 12)));
    const size = Math.ceil(rest.length / kids);
    for (let j = 0; j < kids; j++) {
      const chunk = rest.slice(j * size, (j + 1) * size);
      if (!chunk.length) continue;
      const t = 0.42 + (0.5 * (j + 1)) / (kids + 1);
      const p = lerp({ x, y }, end, t);
      const up = angle < -Math.PI / 2 ? 1 : -1;
      const side = (j + depth) % 2 === 0 ? up : -up;
      const spread = (side === up ? 26 + random() * 14 : 20 + random() * 10) * DEG;
      grow(chunk, p.x, p.y, angle + side * spread, Math.max(1.6, width * 0.62), color, group, depth + 1, order + t);
    }
  };

  segments.push(stamp({ x1: 0, y1: 0, x2: top.x, y2: top.y, w1: trunkWidth, w2: trunkWidth * 0.42, order: 0 }));
  placeAlong(loose.slice(0, 40), { x: 0, y: 0 }, top, TRUNK_ANGLE, trunkWidth, "#8a8a8e", null, 0, 0.08);
  if (loose.length > 40) grow(loose.slice(40), top.x, top.y, TRUNK_ANGLE - 8 * DEG, trunkWidth * 0.4, "#8a8a8e", null, 1, 1);
  else leaves.push(stamp({ x: top.x, y: top.y, angle: TRUNK_ANGLE, length: 24 + 3 * Math.sqrt(total), width: 10 + 1.2 * Math.sqrt(total), color: null, order: 1 }));

  categories.forEach((cat, i) => {
    const t = categories.length === 1 ? 0.55 : 0.26 + (0.66 * i) / (categories.length - 1);
    const base = lerp({ x: 0, y: 0 }, top, t);
    const left = i % 2 === 0;
    const angle = TRUNK_ANGLE + (left ? -58 : 52) * DEG + (random() - 0.5) * 10 * DEG;
    const width = trunkWidth * (0.58 - 0.26 * t);
    grow(cat.mods, base.x, base.y, angle, width, cat.color, cat.slug, 0, t);
  });

  return { segments, nodes, leaves, categories, loose: loose.length, maxOrder };
}

export function createTreeView() {
  const el = h("section", { class: "view tree-view", "aria-labelledby": "tree-title" });
  let tree = null;
  let view = { x: 0, y: 0, k: 1 };
  let fitK = 1;
  let growth = 1;
  let hovered = null;
  let focused = null;
  let frame = 0;
  let canvas, ctx2d, stage, tooltip, stats, legend, listView, resizeObserver;

  const reduceMotion = () => settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

  function colors() {
    const s = getComputedStyle(document.documentElement);
    return { ink: s.getPropertyValue("--text").trim() || "#1d1d1f", surface: s.getPropertyValue("--surface").trim() || "#fff", muted: s.getPropertyValue("--text-3").trim() || "#888" };
  }

  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function draw() {
    if (!canvas || !tree) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    const c = colors();
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);
    ctx2d.save();
    ctx2d.translate(view.x, view.y);
    ctx2d.scale(view.k, view.k);
    const visible = (order) => order <= growth;
    const part = (order) => Math.max(0, Math.min(1, growth - order));

    for (const leaf of tree.leaves) {
      if (!visible(leaf.order)) continue;
      const g = part(leaf.order);
      const ux = Math.cos(leaf.angle);
      const uy = Math.sin(leaf.angle);
      const len = leaf.length * g;
      const cx = leaf.x + ux * len * 0.82;
      const cy = leaf.y + uy * len * 0.82;
      ctx2d.beginPath();
      ctx2d.moveTo(cx - ux * len, cy - uy * len);
      ctx2d.quadraticCurveTo(cx - uy * leaf.width * 2 * g, cy + ux * leaf.width * 2 * g, cx + ux * len, cy + uy * len);
      ctx2d.quadraticCurveTo(cx + uy * leaf.width * 2 * g, cy - ux * leaf.width * 2 * g, cx - ux * len, cy - uy * len);
      ctx2d.fillStyle = leaf.color || c.ink;
      ctx2d.globalAlpha = leaf.color ? 0.28 : 0.85;
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;

    ctx2d.fillStyle = c.ink;
    for (const s of tree.segments) {
      if (!visible(s.order)) continue;
      const g = part(s.order);
      const x2 = s.x1 + (s.x2 - s.x1) * g;
      const y2 = s.y1 + (s.y2 - s.y1) * g;
      const len = Math.hypot(x2 - s.x1, y2 - s.y1) || 1;
      const nx = -(y2 - s.y1) / len;
      const ny = (x2 - s.x1) / len;
      const w1 = s.w1 / 2;
      const w2 = (s.w1 + (s.w2 - s.w1) * g) / 2;
      ctx2d.beginPath();
      ctx2d.moveTo(s.x1 + nx * w1, s.y1 + ny * w1);
      ctx2d.lineTo(x2 + nx * w2, y2 + ny * w2);
      ctx2d.arc(x2, y2, w2, Math.atan2(ny, nx), Math.atan2(-ny, -nx), true);
      ctx2d.lineTo(s.x1 - nx * w1, s.y1 - ny * w1);
      ctx2d.arc(s.x1, s.y1, w1, Math.atan2(-ny, -nx), Math.atan2(ny, nx), true);
      ctx2d.fill();
    }

    const stroke = 1.6 / Math.max(view.k, 0.4);
    for (const n of tree.nodes) {
      if (!visible(n.order)) continue;
      const g = Math.min(1, part(n.order) * 3);
      const r = NODE_RADIUS * g * (n === hovered || n === focused ? 1.6 : 1);
      ctx2d.beginPath();
      ctx2d.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = n.color;
      ctx2d.fill();
      ctx2d.lineWidth = stroke;
      ctx2d.strokeStyle = c.surface;
      ctx2d.stroke();
    }
    if (focused) {
      ctx2d.beginPath();
      ctx2d.arc(focused.x, focused.y, NODE_RADIUS * 3, 0, Math.PI * 2);
      ctx2d.lineWidth = 2.5 / view.k;
      ctx2d.strokeStyle = focused.color;
      ctx2d.stroke();
    }
    ctx2d.restore();

    if (view.k >= 1.35 && growth >= tree.maxOrder) {
      ctx2d.font = "500 12px " + getComputedStyle(document.body).fontFamily;
      ctx2d.textBaseline = "middle";
      ctx2d.lineJoin = "round";
      let drawn = 0;
      const taken = [];
      for (const n of tree.nodes) {
        const sx = n.x * view.k + view.x;
        const sy = n.y * view.k + view.y;
        if (sx < -50 || sy < -20 || sx > w + 10 || sy > hgt + 20) continue;
        const label = n.mod.name.length > 28 ? `${n.mod.name.slice(0, 27)}…` : n.mod.name;
        const box = { x: sx + NODE_RADIUS * view.k + 3, y: sy - 8, w: ctx2d.measureText(label).width + 4, h: 16 };
        if (taken.some((t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h)) continue;
        taken.push(box);
        ctx2d.lineWidth = 4;
        ctx2d.strokeStyle = c.surface;
        ctx2d.strokeText(label, sx + NODE_RADIUS * view.k + 5, sy);
        ctx2d.fillStyle = c.ink;
        ctx2d.fillText(label, sx + NODE_RADIUS * view.k + 5, sy);
        if (++drawn > 450) break;
      }
    }
  }

  function bounds(list) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y, pad) => { minX = Math.min(minX, x - pad); minY = Math.min(minY, y - pad); maxX = Math.max(maxX, x + pad); maxY = Math.max(maxY, y + pad); };
    for (const item of list) {
      if ("x1" in item) { add(item.x1, item.y1, item.w1); add(item.x2, item.y2, item.w2); }
      else if ("length" in item) add(item.x, item.y, item.length * 1.8);
      else add(item.x, item.y, NODE_RADIUS * 2);
    }
    return { minX, minY, maxX, maxY };
  }

  function fitTo(b, animate = true, maxK = 6) {
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    const k = Math.min(maxK, Math.min(w / (b.maxX - b.minX + 80), hgt / (b.maxY - b.minY + 80)));
    const target = { k, x: w / 2 - ((b.minX + b.maxX) / 2) * k, y: hgt / 2 - ((b.minY + b.maxY) / 2) * k };
    animateView(target, animate);
  }

  function fitAll(animate = true) {
    const b = bounds([...tree.segments, ...tree.leaves, ...tree.nodes]);
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    fitK = Math.min(w / (b.maxX - b.minX + 80), hgt / (b.maxY - b.minY + 80));
    fitTo(b, animate, 3);
  }

  function animateView(target, animate) {
    if (!animate || reduceMotion()) {
      view = target;
      requestDraw();
      return;
    }
    const start = { ...view };
    const began = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - began) / 450);
      const e = 1 - Math.pow(1 - t, 3);
      view = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e, k: start.k + (target.k - start.k) * e };
      draw();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function zoomAt(factor, sx, sy) {
    const k = Math.max(fitK * 0.4, Math.min(10, view.k * factor));
    const real = k / view.k;
    view = { k, x: sx - (sx - view.x) * real, y: sy - (sy - view.y) * real };
    requestDraw();
  }

  function nodeAt(sx, sy) {
    const wx = (sx - view.x) / view.k;
    const wy = (sy - view.y) / view.k;
    const reach = Math.max(NODE_RADIUS * 1.6, 10 / view.k);
    let best = null;
    let bestDist = reach * reach;
    for (const n of tree.nodes) {
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d < bestDist) { best = n; bestDist = d; }
    }
    return best;
  }

  function showTooltip(n, sx, sy) {
    if (!n) { tooltip.hidden = true; return; }
    tooltip.replaceChildren(
      h("strong", null, n.mod.name),
      h("span", { class: "tree-tip-meta" }, h("span", { class: "tree-dot" }), n.mod.category_name || "No category", n.mod.community ? " · community" : ""),
      h("span", { class: "muted small" }, "click to open"),
    );
    tooltip.querySelector(".tree-dot").style.background = n.color;
    tooltip.hidden = false;
    const box = stage.getBoundingClientRect();
    tooltip.style.left = `${Math.min(sx + 14, box.width - 230)}px`;
    tooltip.style.top = `${Math.max(8, sy - 12)}px`;
  }

  function focusNode(n) {
    focused = n;
    fitTo({ minX: n.x - 60, maxX: n.x + 60, minY: n.y - 40, maxY: n.y + 40 }, true, 3);
  }

  function attachInput() {
    const pointers = new Map();
    let dragStart = null;
    let moved = false;
    let pinch = null;

    canvas.addEventListener("pointerdown", (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      dragStart = { x: e.offsetX, y: e.offsetY, vx: view.x, vy: view.y };
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((pinch.k * (dist / pinch.dist)) / view.k, (a.x + b.x) / 2, (a.y + b.y) / 2);
        moved = true;
        return;
      }
      if (dragStart && pointers.size === 1) {
        const dx = e.offsetX - dragStart.x;
        const dy = e.offsetY - dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (moved) {
          view = { ...view, x: dragStart.vx + dx, y: dragStart.vy + dy };
          tooltip.hidden = true;
          canvas.classList.add("dragging");
          requestDraw();
          return;
        }
      }
      const n = nodeAt(e.offsetX, e.offsetY);
      if (n !== hovered) {
        hovered = n;
        canvas.style.cursor = n ? "pointer" : "grab";
        requestDraw();
      }
      showTooltip(n, e.offsetX, e.offsetY);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      canvas.classList.remove("dragging");
      if (!moved && dragStart && pointers.size === 0) {
        const n = nodeAt(e.offsetX, e.offsetY);
        if (n) location.hash = `#/mod/${encodeURIComponent(n.mod.slug)}`;
      }
      if (pointers.size === 0) dragStart = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => { if (!dragStart) { hovered = null; tooltip.hidden = true; requestDraw(); } });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
    }, { passive: false });
    canvas.addEventListener("dblclick", (e) => zoomAt(1.8, e.offsetX, e.offsetY));
    canvas.addEventListener("keydown", (e) => {
      const step = 60;
      const keys = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (keys[e.key]) { view = { ...view, x: view.x + keys[e.key][0], y: view.y + keys[e.key][1] }; requestDraw(); e.preventDefault(); }
      else if (e.key === "+" || e.key === "=") { zoomAt(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2); e.preventDefault(); }
      else if (e.key === "-") { zoomAt(0.8, canvas.clientWidth / 2, canvas.clientHeight / 2); e.preventDefault(); }
      else if (e.key === "0") { fitAll(); e.preventDefault(); }
    });
  }

  function grow() {
    if (reduceMotion()) {
      growth = tree.maxOrder;
      requestDraw();
      return;
    }
    growth = 0;
    const began = performance.now();
    const duration = Math.min(2800, 1200 + tree.maxOrder * 180);
    const step = (now) => {
      const t = Math.min(1, (now - began) / duration);
      growth = (1 - Math.pow(1 - t, 2)) * tree.maxOrder;
      draw();
      if (t < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  let drawnFrom = "";

  function setMods(mods, { quiet = false } = {}) {
    drawnFrom = JSON.stringify(mods);
    const focusedSlug = quiet ? focused?.mod.slug : null;
    tree = buildTree(mods);
    hovered = null;
    focused = focusedSlug ? tree.nodes.find((n) => n.mod.slug === focusedSlug) || null : null;
    const branches = tree.segments.length - 1;
    stats.textContent = `${mods.length} ${mods.length === 1 ? "mod" : "mods"} · ${tree.categories.length} ${tree.categories.length === 1 ? "limb" : "limbs"} · ${branches} ${branches === 1 ? "branch" : "branches"}`;
    clear(legend).append(
      ...tree.categories.map((c) =>
        h(
          "button",
          { class: "tree-chip", type: "button", title: `zoom to ${c.name}`, onclick: () => fitTo(bounds(tree.nodes.filter((n) => n.group === c.slug)), true, 3) },
          h("span", { class: "tree-dot" }),
          `${c.name} (${c.mods.length})`,
        ),
      ),
    );
    legend.querySelectorAll(".tree-dot").forEach((dot, i) => { dot.style.background = tree.categories[i].color; });
    clear(listView).append(
      ...tree.categories.map((c) => h("section", null, h("h3", null, `${c.name} (${c.mods.length})`), h("ul", null, c.mods.map((m) => h("li", null, h("a", { href: `#/mod/${encodeURIComponent(m.slug)}` }, m.name)))))),
      tree.loose ? h("section", null, h("h3", null, "No category"), h("ul", null, mods.filter((m) => !m.category_slug).map((m) => h("li", null, h("a", { href: `#/mod/${encodeURIComponent(m.slug)}` }, m.name))))) : null,
    );
    stage.querySelector(".tree-hint").textContent = mods.length < 5
      ? "the tree is just a sapling for now. it grows a new node for every mod added to Branch"
      : "scroll to zoom · drag to move · click a node to open the mod";
    resize();
    if (quiet) {
      growth = tree.maxOrder;
      requestDraw();
      return;
    }
    fitAll(false);
    grow();
  }

  async function poll() {
    if (!tree || !el.isConnected) return;
    try {
      const data = await api("/api/tree");
      if (JSON.stringify(data.mods) !== drawnFrom) setMods(data.mods, { quiet: true });
    } catch {
    }
  }

  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    requestDraw();
  }

  async function render() {
    canvas = h("canvas", { class: "tree-canvas", tabindex: "0", "aria-label": "Tree of Life. drag to move, scroll or use + and - to zoom, 0 to fit. use the list view for a text version." });
    ctx2d = canvas.getContext("2d");
    tooltip = h("div", { class: "tree-tip", role: "tooltip", hidden: true });
    stats = h("p", { class: "muted tree-stats" }, "growing…");
    legend = h("div", { class: "tree-legend", "aria-label": "Categories" });
    listView = h("div", { class: "tree-list", hidden: true });
    const search = h("input", { class: "input tree-search", type: "search", placeholder: "find a mod on the tree", "aria-label": "Find a mod on the tree" });
    const results = h("ul", { class: "tree-results", role: "listbox", hidden: true });
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const hits = q && tree ? tree.nodes.filter((n) => n.mod.name.toLowerCase().includes(q)).slice(0, 8) : [];
      results.replaceChildren(...hits.map((n) => h("li", null, h("button", { type: "button", onclick: () => { results.hidden = true; search.value = n.mod.name; focusNode(n); } }, n.mod.name))));
      results.hidden = !hits.length;
    });
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") results.querySelector("button")?.click(); });
    const listToggle = h("button", { class: "btn btn-quiet", type: "button", "aria-pressed": "false" }, "View as list");
    listToggle.addEventListener("click", () => {
      const showList = listView.hidden;
      listView.hidden = !showList;
      stage.hidden = showList;
      listToggle.setAttribute("aria-pressed", String(showList));
      listToggle.textContent = showList ? "View as tree" : "View as list";
      if (!showList) resize();
    });

    stage = h(
      "div",
      { class: "tree-stage" },
      canvas,
      tooltip,
      h(
        "div",
        { class: "tree-controls" },
        h("button", { class: "icon-btn", type: "button", "aria-label": "Zoom in", title: "Zoom in (+)", onclick: () => zoomAt(1.35, canvas.clientWidth / 2, canvas.clientHeight / 2) }, h("span", { class: "tree-sym" }, "+")),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Zoom out", title: "Zoom out (-)", onclick: () => zoomAt(0.74, canvas.clientWidth / 2, canvas.clientHeight / 2) }, h("span", { class: "tree-sym" }, "−")),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Show the whole tree", title: "Show the whole tree (0)", onclick: () => fitAll() }, icon("grid")),
      ),
      h("p", { class: "tree-hint" }, "scroll to zoom · drag to move · click a node to open the mod"),
    );

    clear(el).append(
      h(
        "header",
        { class: "tree-head" },
        h("div", null, h("h1", { class: "view-title", id: "tree-title" }, "Tree of Life"), h("p", { class: "muted" }, "every mod on Branch is a node on this tree. each category is a limb, and the tree grows as people add mods."), stats),
        h("div", { class: "tree-tools" }, h("div", { class: "tree-search-wrap" }, search, results), listToggle),
      ),
      legend,
      stage,
      listView,
    );
    attachInput();
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => { resize(); });
    resizeObserver.observe(canvas);

    try {
      const data = await api("/api/tree");
      setMods(data.mods);
    } catch (err) {
      stage.replaceWith(errorBlock(err, render));
    }
  }

  if (!isDesktop) window.__branchTree = { setMods: (mods) => setMods(mods) };

  return {
    el,
    title: () => "Tree of Life",
    show() { render(); return 0; },
    poll,
    hide() { resizeObserver?.disconnect(); },
  };
}
