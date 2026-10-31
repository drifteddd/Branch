const AURORAS = {
  aurora: ["#2f9e6b", "#3b7fc4", "#8e5bd6", "#1aa6a6", "#d4892b"],
  sunset: ["#ff7a59", "#ff4f8b", "#ffb347", "#c45cb0", "#ff9a76"],
  ocean: ["#1aa6a6", "#3b7fc4", "#2bc4d9", "#4f6bd8", "#7fd1c7"],
  forest: ["#2f9e6b", "#7a9b2c", "#1aa6a6", "#58b368", "#a3c45c"],
  nebula: ["#8e5bd6", "#c45cb0", "#3b4fc4", "#e05a9c", "#5c6bc0"],
  borealis: ["#2fe39a", "#1aa6a6", "#6a5bd6", "#38d4b0", "#3b7fc4"],
};

const preview = (colors) => `radial-gradient(circle at 20% 30%, ${colors[0]}cc, transparent 60%), radial-gradient(circle at 80% 25%, ${colors[1]}cc, transparent 60%), radial-gradient(circle at 55% 85%, ${colors[2]}cc, transparent 65%), radial-gradient(circle at 15% 90%, ${colors[3]}99, transparent 55%)`;

export const AMBIENT_STYLES = [
  ["off", "Off", "none"],
  ["aurora", "Aurora", preview(AURORAS.aurora)],
  ["sunset", "Sunset", preview(AURORAS.sunset)],
  ["ocean", "Ocean", preview(AURORAS.ocean)],
  ["forest", "Forest", preview(AURORAS.forest)],
  ["nebula", "Nebula", `radial-gradient(circle at 30% 40%, #fff 0 1px, transparent 2px), radial-gradient(circle at 70% 65%, #fff 0 1px, transparent 2px), radial-gradient(circle at 85% 20%, #fff 0 1px, transparent 2px), ${preview(AURORAS.nebula)}`],
  ["borealis", "Borealis", `linear-gradient(170deg, transparent 20%, #2fe39a99 38%, transparent 55%), linear-gradient(190deg, transparent 35%, #6a5bd699 52%, transparent 70%), ${preview(AURORAS.borealis)}`],
  ["waves", "Waves", "linear-gradient(172deg, transparent 38%, #3b7fc4aa 46%, transparent 56%), linear-gradient(186deg, transparent 52%, #8e5bd6aa 60%, transparent 70%), linear-gradient(176deg, transparent 64%, #1aa6a6aa 72%, transparent 82%), radial-gradient(circle at 25% 30%, #2f9e6b55, transparent 60%)"],
];

const FRAME_MS = 1000 / 30;

let canvas = null;
let ctx = null;
let style = "off";
let raf = 0;
let last = 0;
let start = 0;
let items = [];
let stars = [];
let ribbons = [];
let glows = [];
let resizeObserver = null;
let w = 0;
let h = 0;

const root = document.documentElement;
const reduceMotion = () => root.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = () => getComputedStyle(root).colorScheme.includes("dark") || (root.dataset.theme === "dark") || (root.dataset.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
const cssVar = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function seed() {
  const area = (w * h) / 1e6;
  stars = [];
  ribbons = [];
  glows = [];
  if (AURORAS[style]) {
    items = AURORAS[style].map((color, i) => ({ color, ax: rand(0.15, 0.85), ay: rand(0.15, 0.85), rx: rand(0.15, 0.35), ry: rand(0.12, 0.3), sx: rand(0.03, 0.07) * (i % 2 ? 1 : -1), sy: rand(0.025, 0.06), phase: rand(0, Math.PI * 2), size: rand(0.35, 0.6) }));
    if (style === "nebula") {
      stars = Array.from({ length: Math.round(60 + area * 90) }, () => ({ x: rand(0, 1), y: rand(0, 1), r: rand(0.4, 1.4), speed: rand(0.6, 2.2), phase: rand(0, Math.PI * 2) }));
    }
    if (style === "borealis") {
      ribbons = [0, 1, 2].map((i) => ({ color: AURORAS.borealis[i * 2 % 5], base: 0.22 + i * 0.12, amp: rand(0.05, 0.1), len: rand(0.6, 1.1), speed: rand(0.08, 0.16) * (i % 2 ? -1 : 1), height: rand(0.22, 0.34), phase: rand(0, Math.PI * 2) }));
    }
  } else if (style === "waves") {
    const colors = ["#3b7fc4", "#8e5bd6", "#1aa6a6", "#2f9e6b", "#c45cb0"];
    glows = [0, 1].map((i) => ({ color: colors[i * 3], ax: rand(0.2, 0.8), ay: rand(0.2, 0.5), phase: rand(0, Math.PI * 2) }));
    items = colors.map((color, i) => ({ color, next: colors[(i + 2) % colors.length], base: 0.4 + i * 0.1, amp: rand(0.04, 0.08), len: rand(0.55, 1.05), speed: rand(0.1, 0.2) * (i % 2 ? -1 : 1), thick: rand(0.07, 0.13), phase: rand(0, Math.PI * 2) }));
  } else items = [];
}

function frame(now) {
  raf = 0;
  if (!canvas || style === "off") return;
  if (now - last < FRAME_MS && !reduceMotion()) {
    schedule();
    return;
  }
  const dt = Math.min(0.1, (now - (last || now)) / 1000);
  last = now;
  const t = (now - start) / 1000;
  const isDark = dark();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--bg", isDark ? "#000" : "#f5f5f7");
  ctx.fillRect(0, 0, w, h);

  if (AURORAS[style]) {
    if (style === "nebula" && isDark) {
      ctx.fillStyle = "rgba(8, 6, 20, 0.35)";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = isDark ? "screen" : "multiply";
    for (const b of items) {
      const x = (b.ax + Math.sin(t * b.sx * 2 + b.phase) * b.rx) * w;
      const y = (b.ay + Math.cos(t * b.sy * 2 + b.phase) * b.ry) * h;
      const r = Math.max(w, h) * b.size;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hexAlpha(b.color, isDark ? 0.32 : 0.22));
      g.addColorStop(1, hexAlpha(b.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    for (const r of ribbons) {
      const top = [];
      for (let x = 0; x <= w + 12; x += 12) {
        const y = (r.base + Math.sin((x / w) * Math.PI * 2 / r.len + t * r.speed * 2 + r.phase) * r.amp + Math.sin((x / w) * 9 + t * r.speed * 3) * r.amp * 0.25) * h;
        top.push([x, y]);
      }
      const band = r.height * h;
      const g = ctx.createLinearGradient(0, r.base * h - r.amp * h, 0, r.base * h + band);
      g.addColorStop(0, hexAlpha(r.color, 0));
      g.addColorStop(0.12, hexAlpha(r.color, isDark ? 0.45 : 0.28));
      g.addColorStop(1, hexAlpha(r.color, 0));
      ctx.beginPath();
      top.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i][0], top[i][1] + band * (0.75 + 0.25 * Math.sin(i * 0.7 + t)));
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    for (const st of stars) {
      const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(t * st.speed + st.phase));
      ctx.beginPath();
      ctx.arc(st.x * w, st.y * h, st.r, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? `rgba(255, 255, 255, ${twinkle * 0.9})` : `rgba(60, 40, 120, ${twinkle * 0.45})`;
      ctx.fill();
    }
  } else if (style === "waves") {
    ctx.globalCompositeOperation = isDark ? "screen" : "multiply";
    for (const glow of glows) {
      const x = (glow.ax + Math.sin(t * 0.05 + glow.phase) * 0.15) * w;
      const y = (glow.ay + Math.cos(t * 0.04 + glow.phase) * 0.1) * h;
      const r = Math.max(w, h) * 0.55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hexAlpha(glow.color, isDark ? 0.22 : 0.14));
      g.addColorStop(1, hexAlpha(glow.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    for (const band of items) {
      const top = [];
      const bottom = [];
      for (let x = -10; x <= w + 20; x += 10) {
        const u = x / w;
        const y = (band.base + Math.sin(u * Math.PI * 2 / band.len + t * band.speed * 2 + band.phase) * band.amp + Math.sin(u * 7 - t * band.speed * 2.6 + band.phase) * band.amp * 0.3) * h;
        const thick = band.thick * h * (0.55 + 0.45 * Math.sin(u * 3.2 + t * band.speed * 1.4 + band.phase * 2));
        top.push([x, y]);
        bottom.push([x, y + thick]);
      }
      const shift = (Math.sin(t * 0.07 + band.phase) + 1) / 2;
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, hexAlpha(band.color, isDark ? 0.42 : 0.3));
      g.addColorStop(0.2 + shift * 0.6, hexAlpha(band.next, isDark ? 0.5 : 0.34));
      g.addColorStop(1, hexAlpha(band.color, isDark ? 0.42 : 0.3));
      ctx.beginPath();
      top.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1]);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      top.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = isDark ? "rgba(255, 255, 255, 0.28)" : hexAlpha(band.color, 0.45);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }
  if (!reduceMotion()) schedule();
}

function schedule() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

function fit() {
  if (!canvas) return;
  const box = document.querySelector(".shell").getBoundingClientRect();
  canvas.style.left = `${box.left}px`;
  canvas.style.top = `${box.top}px`;
  canvas.style.width = `${box.width}px`;
  canvas.style.height = `${box.height}px`;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const changed = Math.round(box.width) !== w || Math.round(box.height) !== h;
  w = Math.round(box.width);
  h = Math.round(box.height);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (changed) seed();
  last = 0;
  schedule();
}

function onVisibility() {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
  } else {
    last = 0;
    schedule();
  }
}

export function setAmbient(next) {
  style = AMBIENT_STYLES.some(([v]) => v === next) ? next : "off";
  if (style === "off") {
    cancelAnimationFrame(raf);
    raf = 0;
    resizeObserver?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    canvas?.remove();
    canvas = null;
    delete root.dataset.ambient;
    return;
  }
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "ambient";
    canvas.setAttribute("aria-hidden", "true");
    document.querySelector(".shell").prepend(canvas);
    ctx = canvas.getContext("2d");
    resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(document.querySelector(".shell"));
    document.addEventListener("visibilitychange", onVisibility);
  }
  root.dataset.ambient = style;
  start = performance.now();
  w = 0;
  fit();
}

export function refreshAmbient() {
  if (style !== "off") {
    last = 0;
    schedule();
  }
}
