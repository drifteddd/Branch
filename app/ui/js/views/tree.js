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
const quad = (c, t) => ({ x: (1 - t) * (1 - t) * c.p0.x + 2 * (1 - t) * t * c.c.x + t * t * c.p1.x, y: (1 - t) * (1 - t) * c.p0.y + 2 * (1 - t) * t * c.c.y + t * t * c.p1.y });
const tangent = (c, t) => Math.atan2(2 * (1 - t) * (c.c.y - c.p0.y) + 2 * t * (c.p1.y - c.c.y), 2 * (1 - t) * (c.c.x - c.p0.x) + 2 * t * (c.p1.x - c.c.x));

function curveFrom(x, y, angle, length, bend) {
  const p0 = { x, y };
  const p1 = at(x, y, angle, length);
  const mid = lerp(p0, p1, 0.5);
  return { p0, p1, c: { x: mid.x - Math.sin(angle) * length * bend, y: mid.y + Math.cos(angle) * length * bend } };
}

export function buildTree(mods) {
  const random = seeded(7);
  const segments = [];
  const nodes = [];
  const leaves = [];
  const roots = [];
  const labels = [];
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
  const trunk = curveFrom(0, 0, TRUNK_ANGLE, trunkLength, 0.05);

  const nodeSize = (mod) => {
    const pop = Math.min(0.9, Math.log10(1 + (mod.downloads || 0)) / 3);
    const rated = mod.rating_count ? Math.min(0.35, (mod.rating_sum / mod.rating_count - 2.5) * 0.14) : 0;
    return NODE_RADIUS * (0.85 + pop + Math.max(0, rated));
  };

  const placeAlong = (list, curve, width, color, group, order, start = 0.3) => {
    list.forEach((mod, k) => {
      const t = list.length === 1 ? (start + 1) / 2 : start + (1 - start) * (k / (list.length - 1));
      const p = quad(curve, t);
      const a = tangent(curve, t);
      const side = k % 2 === 0 ? 1 : -1;
      const size = nodeSize(mod);
      const offset = side * (width * 0.5 + size + 4 + random() * 4);
      nodes.push(stamp({ x: p.x - Math.sin(a) * offset, y: p.y + Math.cos(a) * offset, mod, color, group, size, featured: Boolean(mod.featured), order: order + t }));
    });
  };

  const grow = (list, x, y, angle, width, color, group, depth, order, cat) => {
    const length = 46 + 30 * Math.sqrt(list.length);
    const bend = (random() < 0.5 ? -1 : 1) * (0.06 + random() * 0.1);
    const curve = curveFrom(x, y, angle, length, bend);
    segments.push(stamp({ curve, w1: width, w2: Math.max(1.4, width * 0.55), order }));
    if (cat && depth === 0) labels.push({ x: curve.p1.x, y: curve.p1.y, name: cat.name, count: cat.mods.length, color, slug: cat.slug });
    const own = depth >= 6 ? list : list.slice(0, MODS_PER_BRANCH);
    const rest = depth >= 6 ? [] : list.slice(MODS_PER_BRANCH);
    placeAlong(own, curve, width * 0.7, color, group, order);
    const endAngle = tangent(curve, 1);
    leaves.push(stamp({ x: curve.p1.x, y: curve.p1.y, angle: endAngle, length: 14 + 6 * Math.sqrt(own.length), width: 6 + 2.4 * Math.sqrt(own.length), color, phase: random() * Math.PI * 2, order: order + 1 }));
    if (own.length > 3) leaves.push(stamp({ ...quad(curve, 0.62), angle: endAngle + (random() < 0.5 ? -1 : 1) * 0.9, length: 8 + 3 * Math.sqrt(own.length), width: 4 + 1.4 * Math.sqrt(own.length), color, phase: random() * Math.PI * 2, order: order + 0.8 }));
    if (!rest.length) return;
    const kids = Math.min(3, Math.max(1, Math.ceil(rest.length / 12)));
    const size = Math.ceil(rest.length / kids);
    for (let j = 0; j < kids; j++) {
      const chunk = rest.slice(j * size, (j + 1) * size);
      if (!chunk.length) continue;
      const t = 0.42 + (0.5 * (j + 1)) / (kids + 1);
      const p = quad(curve, t);
      const a = tangent(curve, t);
      const up = a < -Math.PI / 2 ? 1 : -1;
      const side = (j + depth) % 2 === 0 ? up : -up;
      const spread = (side === up ? 26 + random() * 14 : 20 + random() * 10) * DEG;
      grow(chunk, p.x, p.y, a + side * spread, Math.max(1.6, width * 0.62), color, group, depth + 1, order + t, null);
    }
  };

  segments.push(stamp({ curve: trunk, w1: trunkWidth, w2: trunkWidth * 0.42, order: 0 }));
  for (let i = 0; i < 5; i++) {
    const angle = (32 + i * 29 + (random() - 0.5) * 12) * DEG;
    roots.push({ curve: curveFrom(0, 0, angle, trunkWidth * (1.1 + random() * 0.8), (random() - 0.5) * 0.3), w1: trunkWidth * (0.7 - Math.abs(i - 2) * 0.1), w2: trunkWidth * 0.12 });
  }
  placeAlong(loose.slice(0, 40), trunk, trunkWidth, "#8a8a8e", null, 0, 0.08);
  const top = trunk.p1;
  if (loose.length > 40) grow(loose.slice(40), top.x, top.y, tangent(trunk, 1) - 8 * DEG, trunkWidth * 0.4, "#8a8a8e", null, 1, 1, null);
  else leaves.push(stamp({ x: top.x, y: top.y, angle: tangent(trunk, 1), length: 24 + 3 * Math.sqrt(total), width: 10 + 1.2 * Math.sqrt(total), color: null, phase: 0, order: 1 }));

  categories.forEach((cat, i) => {
    const t = categories.length === 1 ? 0.55 : 0.26 + (0.66 * i) / (categories.length - 1);
    const base = quad(trunk, t);
    const left = i % 2 === 0;
    const angle = tangent(trunk, t) + (left ? -58 : 52) * DEG + (random() - 0.5) * 10 * DEG;
    const width = trunkWidth * (0.58 - 0.26 * t);
    grow(cat.mods, base.x, base.y, angle, width, cat.color, cat.slug, 0, t, cat);
  });

  return { segments, nodes, leaves, roots, labels, categories, loose: loose.length, maxOrder, trunkWidth };
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
  let breezing = false;
  let labelBoxes = [];
  let canvas, ctx2d, stage, tooltip, stats, legend, listView, resizeObserver;

  const reduceMotion = () => settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

  function colors() {
    const s = getComputedStyle(document.documentElement);
    return { ink: s.getPropertyValue("--text").trim() || "#1d1d1f", surface: s.getPropertyValue("--surface").trim() || "#fff", muted: s.getPropertyValue("--text-3").trim() || "#888" };
  }

  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function taper(curve, w1, w2, upto) {
    const steps = 16;
    const left = [];
    const right = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * upto;
      const p = quad(curve, t);
      const a = tangent(curve, t);
      const half = (w1 + (w2 - w1) * (i / steps)) / 2;
      left.push([p.x - Math.sin(a) * half, p.y + Math.cos(a) * half]);
      right.push([p.x + Math.sin(a) * half, p.y - Math.cos(a) * half]);
    }
    ctx2d.beginPath();
    left.forEach(([x, y], i) => (i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y)));
    for (let i = right.length - 1; i >= 0; i--) ctx2d.lineTo(right[i][0], right[i][1]);
    ctx2d.closePath();
    ctx2d.fill();
    const end = quad(curve, upto);
    ctx2d.beginPath();
    ctx2d.arc(end.x, end.y, w2 / 2, 0, Math.PI * 2);
    ctx2d.arc(curve.p0.x, curve.p0.y, w1 / 2, 0, Math.PI * 2);
    ctx2d.fill();
  }

  function draw() {
    if (!canvas || !tree) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    const c = colors();
    const time = performance.now() / 1000;
    const sway = breezing ? 1 : 0;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);
    ctx2d.save();
    ctx2d.translate(view.x, view.y);
    ctx2d.scale(view.k, view.k);
    const visible = (order) => order <= growth;
    const part = (order) => Math.max(0, Math.min(1, growth - order));
    const tw = tree.trunkWidth;

    const shadow = ctx2d.createRadialGradient(0, tw * 0.4, 0, 0, tw * 0.4, tw * 7);
    shadow.addColorStop(0, "rgba(0, 0, 0, 0.16)");
    shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx2d.fillStyle = shadow;
    ctx2d.beginPath();
    ctx2d.ellipse(0, tw * 0.4, tw * 7, tw * 1.4, 0, 0, Math.PI * 2);
    ctx2d.fill();

    for (const leaf of tree.leaves) {
      if (!visible(leaf.order)) continue;
      const g = part(leaf.order);
      const angle = leaf.angle + Math.sin(time * 1.3 + leaf.phase) * 0.09 * sway;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const len = leaf.length * g;
      const cx = leaf.x + ux * len * 0.82;
      const cy = leaf.y + uy * len * 0.82;
      ctx2d.beginPath();
      ctx2d.moveTo(cx - ux * len, cy - uy * len);
      ctx2d.quadraticCurveTo(cx - uy * leaf.width * 2 * g, cy + ux * leaf.width * 2 * g, cx + ux * len, cy + uy * len);
      ctx2d.quadraticCurveTo(cx + uy * leaf.width * 2 * g, cy - ux * leaf.width * 2 * g, cx - ux * len, cy - uy * len);
      ctx2d.fillStyle = leaf.color || c.ink;
      ctx2d.globalAlpha = leaf.color ? 0.3 : 0.85;
      ctx2d.fill();
      if (leaf.color) {
        ctx2d.globalAlpha = 0.35;
        ctx2d.strokeStyle = leaf.color;
        ctx2d.lineWidth = 0.8;
        ctx2d.beginPath();
        ctx2d.moveTo(cx - ux * len * 0.85, cy - uy * len * 0.85);
        ctx2d.lineTo(cx + ux * len * 0.85, cy + uy * len * 0.85);
        ctx2d.stroke();
      }
    }
    ctx2d.globalAlpha = 1;

    ctx2d.fillStyle = c.ink;
    for (const r of tree.roots) taper(r.curve, r.w1, r.w2, Math.min(1, growth * 3));
    for (const s of tree.segments) {
      if (!visible(s.order)) continue;
      const g = part(s.order);
      taper(s.curve, s.w1, s.w1 + (s.w2 - s.w1) * g, g);
    }

    const stroke = 1.6 / Math.max(view.k, 0.4);
    for (const n of tree.nodes) {
      if (!visible(n.order)) continue;
      const g = Math.min(1, part(n.order) * 3);
      const active = n === hovered || n === focused;
      const r = n.size * g * (active ? 1.5 : 1);
      if (active) {
        const glow = ctx2d.createRadialGradient(n.x, n.y, r, n.x, n.y, r * 3.2);
        glow.addColorStop(0, n.color + "66");
        glow.addColorStop(1, n.color + "00");
        ctx2d.fillStyle = glow;
        ctx2d.beginPath();
        ctx2d.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2);
        ctx2d.fill();
      }
      ctx2d.beginPath();
      ctx2d.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = n.color;
      ctx2d.fill();
      ctx2d.lineWidth = stroke;
      ctx2d.strokeStyle = c.surface;
      ctx2d.stroke();
      if (n.featured && g >= 1) {
        ctx2d.beginPath();
        ctx2d.arc(n.x, n.y, r + 2.6, 0, Math.PI * 2);
        ctx2d.lineWidth = 1.8 / Math.max(view.k, 0.5);
        ctx2d.strokeStyle = "#e0a100";
        ctx2d.stroke();
      }
    }
    if (focused) {
      ctx2d.beginPath();
      ctx2d.arc(focused.x, focused.y, focused.size * 3, 0, Math.PI * 2);
      ctx2d.lineWidth = 2.5 / view.k;
      ctx2d.strokeStyle = focused.color;
      ctx2d.stroke();
    }
    ctx2d.restore();

    labelBoxes = [];
    const font = getComputedStyle(document.body).fontFamily;
    if (growth >= tree.maxOrder && view.k < 1.35) {
      ctx2d.font = "600 12px " + font;
      ctx2d.textBaseline = "middle";
      for (const l of tree.labels) {
        const sx = l.x * view.k + view.x;
        const sy = l.y * view.k + view.y;
        const text = `${l.name} · ${l.count}`;
        const bw = ctx2d.measureText(text).width + 30;
        const box = { x: sx - bw / 2, y: sy - 30, w: bw, h: 22, slug: l.slug };
        if (box.x + box.w < 0 || box.x > w || box.y > hgt || box.y + box.h < 0) continue;
        if (labelBoxes.some((t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h)) continue;
        labelBoxes.push(box);
        ctx2d.fillStyle = c.surface;
        ctx2d.shadowColor = "rgba(0, 0, 0, 0.12)";
        ctx2d.shadowBlur = 8;
        ctx2d.beginPath();
        ctx2d.roundRect(box.x, box.y, box.w, box.h, 11);
        ctx2d.fill();
        ctx2d.shadowBlur = 0;
        ctx2d.fillStyle = l.color;
        ctx2d.beginPath();
        ctx2d.arc(box.x + 12, box.y + 11, 4, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.fillStyle = c.ink;
        ctx2d.fillText(text, box.x + 21, box.y + 11.5);
      }
    }

    if (view.k >= 1.35 && growth >= tree.maxOrder) {
      ctx2d.font = "500 12px " + font;
      ctx2d.textBaseline = "middle";
      ctx2d.lineJoin = "round";
      let drawn = 0;
      const taken = [];
      for (const n of tree.nodes) {
        const sx = n.x * view.k + view.x;
        const sy = n.y * view.k + view.y;
        if (sx < -50 || sy < -20 || sx > w + 10 || sy > hgt + 20) continue;
        const label = n.mod.name.length > 28 ? `${n.mod.name.slice(0, 27)}…` : n.mod.name;
        const offset = n.size * view.k + 5;
        const box = { x: sx + offset - 2, y: sy - 8, w: ctx2d.measureText(label).width + 4, h: 16 };
        if (taken.some((t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h)) continue;
        taken.push(box);
        ctx2d.lineWidth = 4;
        ctx2d.strokeStyle = c.surface;
        ctx2d.strokeText(label, sx + offset, sy);
        ctx2d.fillStyle = c.ink;
        ctx2d.fillText(label, sx + offset, sy);
        if (++drawn > 450) break;
      }
    }
  }

  function startBreeze() {
    if (breezing || reduceMotion()) return;
    breezing = true;
    let last = 0;
    const step = (now) => {
      if (!breezing || !el.isConnected) { breezing = false; return; }
      if (now - last > 42 && growth >= (tree?.maxOrder || 0)) { last = now; draw(); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function bounds(list) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y, pad) => { minX = Math.min(minX, x - pad); minY = Math.min(minY, y - pad); maxX = Math.max(maxX, x + pad); maxY = Math.max(maxY, y + pad); };
    for (const item of list) {
      if (item.curve) { add(item.curve.p0.x, item.curve.p0.y, item.w1); add(item.curve.c.x, item.curve.c.y, item.w1); add(item.curve.p1.x, item.curve.p1.y, item.w2); }
      else if ("length" in item) add(item.x, item.y, item.length * 1.8);
      else add(item.x, item.y, (item.size || NODE_RADIUS) * 2);
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
    const b = bounds([...tree.segments, ...tree.roots, ...tree.leaves, ...tree.nodes]);
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
    const reach = Math.max(NODE_RADIUS * 2, 10 / view.k);
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
      h(
        "span",
        { class: "tree-tip-stats" },
        n.mod.rating_count ? h("span", { class: "tree-tip-rating" }, icon("starFill"), (n.mod.rating_sum / n.mod.rating_count).toFixed(1), h("span", { class: "muted" }, ` (${n.mod.rating_count})`)) : h("span", { class: "muted" }, "not rated yet"),
        h("span", { class: "muted" }, ` · ${n.mod.downloads || 0} downloads`),
        n.featured ? h("span", { class: "tree-tip-featured" }, "Featured") : null,
      ),
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
      const overLabel = labelBoxes.some((b) => e.offsetX >= b.x && e.offsetX <= b.x + b.w && e.offsetY >= b.y && e.offsetY <= b.y + b.h);
      canvas.style.cursor = n || overLabel ? "pointer" : "grab";
      if (n !== hovered) {
        hovered = n;
        requestDraw();
      }
      showTooltip(n, e.offsetX, e.offsetY);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      canvas.classList.remove("dragging");
      if (!moved && dragStart && pointers.size === 0) {
        const label = labelBoxes.find((b) => e.offsetX >= b.x && e.offsetX <= b.x + b.w && e.offsetY >= b.y && e.offsetY <= b.y + b.h);
        if (label) fitTo(bounds(tree.nodes.filter((n) => n.group === label.slug)), true, 3);
        else {
          const n = nodeAt(e.offsetX, e.offsetY);
          if (n) location.hash = `#/mod/${encodeURIComponent(n.mod.slug)}`;
        }
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
    breezing = false;
    const began = performance.now();
    const duration = Math.min(2800, 1200 + tree.maxOrder * 180);
    const step = (now) => {
      const t = Math.min(1, (now - began) / duration);
      growth = (1 - Math.pow(1 - t, 2)) * tree.maxOrder;
      draw();
      if (t < 1 && el.isConnected) requestAnimationFrame(step);
      else startBreeze();
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
      startBreeze();
      return;
    }
    fitAll(false);
    grow();
  }

  let pinned = false;

  async function poll() {
    if (!tree || !el.isConnected || pinned) return;
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
        h("button", { class: "icon-btn", type: "button", "aria-label": "Show the whole tree", title: "Show the whole tree (0)", onclick: () => fitAll() }, icon("fit")),
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

  if (!isDesktop) window.__branchTree = { setMods: (mods) => { pinned = true; setMods(mods); } };

  return {
    el,
    title: () => "Tree of Life",
    show() { render(); return 0; },
    poll,
    hide() { resizeObserver?.disconnect(); breezing = false; },
  };
}
