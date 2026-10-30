// draws the branch icon into the png and ico files tauri needs.
// no image tools required, just node. run: node scripts/make-icons.mjs
// the shapes match app/ui/shared/branch-mark.svg.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "app", "src-tauri", "icons");
mkdirSync(out, { recursive: true });

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const PAPER = hex("#ffffff");
const EDGE = hex("#d9d9de");
const INK = hex("#111111");

function inRoundRect(x, y) {
  const [x0, y0, x1, y1, r] = [64, 64, 960, 960, 216];
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inCapsule(x, y, ax, ay, bx, by, radius) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2 <= radius * radius;
}

// the trunk and its limbs: [x1, y1, x2, y2, thickness at the start, thickness at the tip, leaf length, leaf width]
// each limb gets thinner toward its tip and ends in a pointed leaf.
const LIMBS = [
  [470, 840, 540, 262, 34, 21, 66, 28],
  [500, 600, 332, 470, 22, 14, 80, 33],
  [520, 458, 688, 356, 20, 13, 80, 33],
  [492, 716, 636, 656, 17, 11, 64, 27],
  [528, 368, 424, 308, 15, 10, 58, 24],
];

// a leaf is a pointed lens shape: width w * (1 - s²) along its length
function leafFor([x1, y1, bx, by, , , length, width]) {
  const len = Math.hypot(bx - x1, by - y1);
  const ux = (bx - x1) / len, uy = (by - y1) / len;
  // the leaf starts a little inside the limb's tip, so they join smoothly
  return { cx: bx + ux * length * 0.82, cy: by + uy * length * 0.82, ux, uy, length, width };
}
const LEAVES = LIMBS.map((limb) => leafFor(limb));

function inTaperedLimb(x, y, [ax, ay, bx, by, r1, r2]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  const r = r1 + (r2 - r1) * t;
  return (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2 <= r * r;
}

function inLeaf(x, y, { cx, cy, ux, uy, length, width }) {
  const dx = x - cx, dy = y - cy;
  const s = (dx * ux + dy * uy) / length;
  const v = Math.abs(-dx * uy + dy * ux);
  return s >= -1 && s <= 1 && v <= width * (1 - s * s);
}

function inGlyphRaw(x, y) {
  return LIMBS.some((limb) => inTaperedLimb(x, y, limb)) || LEAVES.some((leaf) => inLeaf(x, y, leaf));
}

// measure the drawing and move it so it sits exactly in the middle of the tile
const [OFFSET_X, OFFSET_Y] = (() => {
  let minX = 1024, minY = 1024, maxX = 0, maxY = 0;
  for (let y = 0; y < 1024; y += 2) for (let x = 0; x < 1024; x += 2) {
    if (inGlyphRaw(x, y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  return [Math.round(512 - (minX + maxX) / 2), Math.round(512 - (minY + maxY) / 2)];
})();

function inGlyph(x, y) {
  return inGlyphRaw(x - OFFSET_X, y - OFFSET_Y);
}

// color of one point in the 1024 grid, or null if it's outside the icon
function sample(x, y) {
  if (!inRoundRect(x, y)) return null;
  if (inGlyph(x, y)) return INK;
  // a thin grey edge so the white tile still shows up on white backgrounds
  if (!inRoundRectInset(x, y, 12)) return EDGE;
  return PAPER;
}

function inRoundRectInset(x, y, inset) {
  const [x0, y0, x1, y1, r] = [64 + inset, 64 + inset, 960 - inset, 960 - inset, 216 - inset];
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const ss = 4; // 4x4 samples per pixel for smooth edges
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(((px + (sx + 0.5) / ss) / size) * 1024, ((py + (sy + 0.5) / ss) / size) * 1024);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
        }
      }
      const i = (py * size + px) * 4;
      if (hits) {
        pixels[i] = Math.round(r / hits);
        pixels[i + 1] = Math.round(g / hits);
        pixels[i + 2] = Math.round(b / hits);
        pixels[i + 3] = Math.round((hits / (ss * ss)) * 255);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const pixels = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // rgba
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// .ico files can hold png images directly, which windows vista and newer understand
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

writeFileSync(join(out, "32x32.png"), png(32));
writeFileSync(join(out, "128x128.png"), png(128));
writeFileSync(join(out, "128x128@2x.png"), png(256));
writeFileSync(join(out, "icon.png"), png(512));
writeFileSync(join(out, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256]));

// the same drawing as an svg, used inside the app and the admin panel
function svg() {
  const f = (n) => Math.round(n * 10) / 10;
  const shapes = [];
  for (const [ax, ay, bx, by, r1, r2] of LIMBS) {
    const len = Math.hypot(bx - ax, by - ay);
    const nx = -(by - ay) / len, ny = (bx - ax) / len;
    shapes.push(`<path d="M${f(ax + nx * r1)} ${f(ay + ny * r1)}L${f(bx + nx * r2)} ${f(by + ny * r2)}L${f(bx - nx * r2)} ${f(by - ny * r2)}L${f(ax - nx * r1)} ${f(ay - ny * r1)}Z"/>`);
    shapes.push(`<circle cx="${ax}" cy="${ay}" r="${r1}"/>`, `<circle cx="${bx}" cy="${by}" r="${r2}"/>`);
  }
  for (const { cx, cy, ux, uy, length, width } of LEAVES) {
    const nx = -uy, ny = ux;
    const t1 = [cx - ux * length, cy - uy * length], t2 = [cx + ux * length, cy + uy * length];
    shapes.push(`<path d="M${f(t1[0])} ${f(t1[1])}Q${f(cx + nx * 2 * width)} ${f(cy + ny * 2 * width)} ${f(t2[0])} ${f(t2[1])}Q${f(cx - nx * 2 * width)} ${f(cy - ny * 2 * width)} ${f(t1[0])} ${f(t1[1])}Z"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Branch">
  <rect x="68" y="68" width="888" height="888" rx="212" fill="#ffffff" stroke="#d9d9de" stroke-width="8"/>
  <g fill="#111111" transform="translate(${OFFSET_X} ${OFFSET_Y})">
    ${shapes.join("\n    ")}
  </g>
</svg>
`;
}
writeFileSync(join(root, "app", "ui", "shared", "branch-mark.svg"), svg());
console.log(`icons written to ${out} (glyph moved by ${OFFSET_X}, ${OFFSET_Y} to center it)`);
