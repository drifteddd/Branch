export const AMBIENT_STYLES = [
  ["off", "Off"],
  ["aurora", "Aurora"],
  ["leaves", "Leaves"],
  ["network", "Network"],
  ["waves", "Waves"],
];

const PALETTE = ["#2f9e6b", "#3b7fc4", "#8e5bd6", "#1aa6a6", "#d4892b", "#c45cb0"];
const FRAME_MS = 1000 / 30;

let canvas = null;
let ctx = null;
let style = "off";
let raf = 0;
let last = 0;
let start = 0;
let items = [];
let pointer = { x: -9999, y: -9999 };
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
  if (style === "aurora") {
    items = PALETTE.slice(0, 5).map((color, i) => ({ color, ax: rand(0.15, 0.85), ay: rand(0.15, 0.85), rx: rand(0.15, 0.35), ry: rand(0.12, 0.3), sx: rand(0.03, 0.07) * (i % 2 ? 1 : -1), sy: rand(0.025, 0.06), phase: rand(0, Math.PI * 2), size: rand(0.35, 0.6) }));
  } else if (style === "leaves") {
    items = Array.from({ length: Math.round(18 + area * 22) }, () => newLeaf(true));
  } else if (style === "network") {
    items = Array.from({ length: Math.round(34 + area * 45) }, () => ({ x: rand(0, w), y: rand(0, h), vx: rand(-12, 12), vy: rand(-12, 12), r: rand(1.6, 3.4), color: PALETTE[Math.floor(rand(0, PALETTE.length))] }));
  } else if (style === "waves") {
    items = [0, 1, 2, 3].map((i) => ({ color: PALETTE[i], amp: rand(18, 42), len: rand(380, 720), speed: rand(0.12, 0.3) * (i % 2 ? 1 : -1), base: 0.62 + i * 0.09, phase: rand(0, Math.PI * 2) }));
  } else items = [];
}

function newLeaf(anywhere) {
  return {
    x: rand(-40, w + 40),
    y: anywhere ? rand(-h * 0.2, h) : rand(-120, -30),
    size: rand(10, 26),
    fall: rand(14, 34),
    sway: rand(18, 46),
    swaySpeed: rand(0.3, 0.8),
    spin: rand(-0.6, 0.6),
    angle: rand(0, Math.PI * 2),
    phase: rand(0, Math.PI * 2),
    color: PALETTE[Math.floor(rand(0, 4))],
  };
}

function drawLeaf(x, y, size, angle, color) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const width = size * 0.42;
  ctx.beginPath();
  ctx.moveTo(x - ux * size, y - uy * size);
  ctx.quadraticCurveTo(x - uy * width * 2, y + ux * width * 2, x + ux * size, y + uy * size);
  ctx.quadraticCurveTo(x + uy * width * 2, y - ux * width * 2, x - ux * size, y - uy * size);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - ux * size * 0.8, y - uy * size * 0.8);
  ctx.lineTo(x + ux * size * 0.8, y + uy * size * 0.8);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
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

  if (style === "aurora") {
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
    ctx.globalCompositeOperation = "source-over";
  } else if (style === "leaves") {
    for (let i = 0; i < items.length; i++) {
      const l = items[i];
      l.y += l.fall * dt;
      l.angle += l.spin * dt;
      const x = l.x + Math.sin(t * l.swaySpeed + l.phase) * l.sway;
      if (l.y - l.size > h + 20) items[i] = newLeaf(false);
      drawLeaf(x, l.y, l.size, l.angle, hexAlpha(l.color, isDark ? 0.34 : 0.26));
    }
  } else if (style === "network") {
    const reach = 130;
    for (const p of items) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -20) p.x = w + 20;
      if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20;
      if (p.y > h + 20) p.y = -20;
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > reach) continue;
        ctx.strokeStyle = hexAlpha(a.color, (1 - d / reach) * (isDark ? 0.35 : 0.25));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const near = Math.max(0, 1 - Math.hypot(a.x - pointer.x, a.y - pointer.y) / 180);
      if (near > 0) {
        ctx.strokeStyle = hexAlpha(a.color, near * 0.5);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(pointer.x, pointer.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r * (1 + near * 0.8), 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(a.color, isDark ? 0.7 : 0.55);
      ctx.fill();
    }
  } else if (style === "waves") {
    for (const wave of items) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w + 10; x += 10) {
        const y = wave.base * h + Math.sin(x / wave.len * Math.PI * 2 + t * wave.speed * 2 + wave.phase) * wave.amp + Math.sin(x / (wave.len * 0.37) + t * wave.speed) * wave.amp * 0.3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, wave.base * h - wave.amp, 0, h);
      g.addColorStop(0, hexAlpha(wave.color, isDark ? 0.22 : 0.14));
      g.addColorStop(1, hexAlpha(wave.color, 0.02));
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
  if (!reduceMotion()) schedule();
}

function schedule() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

function fit() {
  if (!canvas) return;
  const main = document.getElementById("main");
  const box = main.getBoundingClientRect();
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

function onPointer(e) {
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
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
    window.removeEventListener("pointermove", onPointer);
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
    resizeObserver.observe(document.getElementById("main"));
    window.addEventListener("pointermove", onPointer, { passive: true });
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
