/**
 * Generates the UI icon set into RP/textures/ui/.
 *
 * Menus previously pointed at vanilla texture paths, which is a standing bet
 * that every one of those paths exists and keeps its name across versions.
 * Several did not, and rendered as the magenta missing-texture square. Owning
 * the icons removes the guesswork and keeps the set visually consistent.
 */
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'packs', 'RP', 'textures', 'ui');
const SIZE = 32;

/* ------------------------------------------------------------- png writer */

function crc32(buf) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(pixels, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const c = pixels[y][x];
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]; raw[p++] = c[3];
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ draw canvas */

const CLEAR = [0, 0, 0, 0];
const WHITE = [245, 248, 252, 255];
const SHADE = [0, 0, 0, 70];

function canvas() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => CLEAR.slice()));
}

function put(img, x, y, color) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  if (color[3] === 255) { img[y][x] = color; return; }
  // Simple source-over blend, so soft edges and shadows layer correctly.
  const dst = img[y][x];
  const a = color[3] / 255;
  img[y][x] = [
    Math.round(color[0] * a + dst[0] * (1 - a)),
    Math.round(color[1] * a + dst[1] * (1 - a)),
    Math.round(color[2] * a + dst[2] * (1 - a)),
    Math.max(dst[3], color[3]),
  ];
}

function rect(img, x0, y0, x1, y1, color) {
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) put(img, x, y, color);
  }
}

function disc(img, cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(img, x, y, color);
    }
  }
}

function ring(img, cx, cy, r, thickness, color) {
  const inner = (r - thickness) ** 2;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d <= r * r && d >= inner) put(img, x, y, color);
    }
  }
}

function line(img, x0, y0, x1, y1, thickness, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3 + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(img, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness / 2, color);
  }
}

/** Filled triangle, used for roofs, arrows and flags. */
function tri(img, ax, ay, bx, by, cx2, cy2, color) {
  const minX = Math.floor(Math.min(ax, bx, cx2)), maxX = Math.ceil(Math.max(ax, bx, cx2));
  const minY = Math.floor(Math.min(ay, by, cy2)), maxY = Math.ceil(Math.max(ay, by, cy2));
  const area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
  if (area === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area;
      const w1 = ((x - ax) * (cy2 - ay) - (cx2 - ax) * (y - ay)) / area;
      if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) put(img, x, y, color);
    }
  }
}

/** Rounded plate that every glyph sits on, giving the set one silhouette. */
function plate(img, color) {
  const r = 6;
  rect(img, 2, 2 + r, 30, 30 - r, color);
  rect(img, 2 + r, 2, 30 - r, 30, color);
  for (const [cx, cy] of [[2 + r, 2 + r], [30 - r, 2 + r], [2 + r, 30 - r], [30 - r, 30 - r]]) {
    disc(img, cx - 0.5, cy - 0.5, r, color);
  }
  // A darker base edge stops the flat plate looking like a sticker.
  rect(img, 2 + r - 4, 28, 30 - r + 4, 30, SHADE);
}

/* ----------------------------------------------------------------- glyphs */

const C = {
  blue: [58, 122, 201, 255], green: [76, 165, 90, 255], gold: [214, 158, 46, 255],
  teal: [56, 160, 158, 255], purple: [132, 94, 194, 255], olive: [138, 148, 62, 255],
  pink: [200, 84, 122, 255], cyan: [64, 158, 196, 255], indigo: [86, 96, 176, 255],
  brown: [140, 100, 62, 255], grey: [116, 124, 140, 255], red: [190, 74, 68, 255],
  slate: [92, 104, 126, 255], orange: [201, 122, 58, 255],
};

const ICONS = {
  profile: [C.blue, (i) => { disc(i, 16, 13, 5, WHITE); tri(i, 16, 17, 7, 27, 25, 27, WHITE); }],
  players: [C.blue, (i) => {
    disc(i, 11, 13, 4, WHITE); tri(i, 11, 16, 4, 25, 18, 25, WHITE);
    disc(i, 21, 13, 4, WHITE); tri(i, 21, 16, 14, 25, 28, 25, WHITE);
  }],
  shop: [C.green, (i) => {
    tri(i, 6, 14, 18, 6, 26, 14, WHITE); rect(i, 8, 14, 24, 26, WHITE);
    rect(i, 13, 18, 19, 26, C.green);
  }],
  economy: [C.gold, (i) => { disc(i, 16, 16, 9, WHITE); ring(i, 16, 16, 6, 2, C.gold); rect(i, 15, 10, 17, 22, C.gold); }],
  auction: [C.gold, (i) => { line(i, 9, 23, 21, 11, 4, WHITE); rect(i, 17, 5, 27, 12, WHITE); rect(i, 6, 25, 20, 28, WHITE); }],
  home: [C.teal, (i) => { tri(i, 16, 5, 4, 16, 28, 16, WHITE); rect(i, 8, 16, 24, 27, WHITE); rect(i, 13, 19, 19, 27, C.teal); }],
  warp: [C.purple, (i) => { ring(i, 16, 16, 10, 3, WHITE); tri(i, 22, 16, 12, 10, 12, 22, WHITE); }],
  land: [C.olive, (i) => { rect(i, 9, 5, 12, 28, WHITE); tri(i, 12, 6, 25, 11, 12, 16, WHITE); }],
  reward: [C.pink, (i) => {
    rect(i, 5, 13, 27, 17, WHITE); rect(i, 7, 17, 25, 27, WHITE);
    rect(i, 14, 13, 18, 27, C.pink); disc(i, 12, 10, 4, WHITE); disc(i, 20, 10, 4, WHITE);
  }],
  progress: [C.cyan, (i) => { rect(i, 6, 20, 11, 27, WHITE); rect(i, 14, 14, 19, 27, WHITE); rect(i, 22, 7, 27, 27, WHITE); }],
  clan: [C.indigo, (i) => { tri(i, 16, 27, 5, 9, 27, 9, WHITE); rect(i, 5, 6, 27, 10, WHITE); rect(i, 14, 12, 18, 20, C.indigo); }],
  vault: [C.brown, (i) => { rect(i, 5, 10, 27, 15, WHITE); rect(i, 5, 16, 27, 27, WHITE); rect(i, 14, 15, 18, 21, C.brown); }],
  settings: [C.grey, (i) => {
    for (let a = 0; a < 8; a++) {
      const t = (a / 8) * Math.PI * 2;
      disc(i, 16 + Math.cos(t) * 10, 16 + Math.sin(t) * 10, 3.2, WHITE);
    }
    disc(i, 16, 16, 8, WHITE); disc(i, 16, 16, 3.5, C.grey);
  }],
  moderation: [C.red, (i) => { ring(i, 16, 13, 6, 3, WHITE); rect(i, 8, 14, 24, 27, WHITE); rect(i, 15, 18, 17, 23, C.red); }],
  world: [C.green, (i) => { disc(i, 16, 16, 11, WHITE); ring(i, 16, 16, 11, 2, C.green); rect(i, 5, 15, 27, 17, C.green); ring(i, 16, 16, 6, 2, C.green); }],
  roles: [C.orange, (i) => { ring(i, 11, 12, 6, 3, WHITE); line(i, 14, 15, 26, 27, 3, WHITE); rect(i, 21, 24, 26, 26, WHITE); }],
  content: [C.purple, (i) => { rect(i, 6, 5, 26, 27, WHITE); rect(i, 15, 5, 17, 27, C.purple); rect(i, 9, 10, 14, 12, C.purple); rect(i, 18, 10, 23, 12, C.purple); }],
  data: [C.slate, (i) => { line(i, 6, 22, 12, 15, 3, WHITE); line(i, 12, 15, 19, 19, 3, WHITE); line(i, 19, 19, 26, 8, 3, WHITE); rect(i, 5, 25, 27, 27, WHITE); }],
  mining: [C.slate, (i) => { line(i, 8, 24, 24, 8, 3, WHITE); tri(i, 24, 4, 16, 8, 26, 14, WHITE); }],
  combat: [C.red, (i) => { line(i, 9, 24, 23, 9, 3, WHITE); rect(i, 6, 22, 13, 25, WHITE); tri(i, 26, 5, 20, 9, 24, 13, WHITE); }],
  building: [C.orange, (i) => {
    rect(i, 5, 9, 27, 14, WHITE); rect(i, 5, 16, 27, 21, WHITE); rect(i, 5, 23, 27, 27, WHITE);
    rect(i, 14, 9, 16, 14, C.orange); rect(i, 9, 16, 11, 21, C.orange); rect(i, 20, 16, 22, 21, C.orange);
  }],
  farming: [C.gold, (i) => {
    line(i, 16, 27, 16, 8, 3, WHITE);
    for (const y of [10, 15, 20]) { line(i, 16, y + 3, 9, y, 2.5, WHITE); line(i, 16, y + 3, 23, y, 2.5, WHITE); }
  }],
  explore: [C.cyan, (i) => { ring(i, 16, 16, 11, 3, WHITE); tri(i, 21, 11, 14, 18, 18, 22, WHITE); }],
  back: [C.grey, (i) => { tri(i, 8, 16, 18, 8, 18, 24, WHITE); rect(i, 17, 14, 25, 18, WHITE); }],
};

await mkdir(OUT, { recursive: true });
const names = [];
for (const [name, [colour, draw]] of Object.entries(ICONS)) {
  const img = canvas();
  plate(img, colour);
  draw(img);
  await writeFile(path.join(OUT, `adm_${name}.png`), encodePng(img, SIZE, SIZE));
  names.push(`adm_${name}`);
}
console.log(`wrote ${names.length} icons to packs/RP/textures/ui/`);
