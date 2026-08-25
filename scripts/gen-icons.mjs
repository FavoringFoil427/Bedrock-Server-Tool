/**
 * Generates the UI icon set into RP/textures/ui/.
 *
 * Menus previously pointed at vanilla texture paths, which is a standing bet
 * that every one of those paths exists and keeps its name across versions.
 * Several did not, and rendered as the magenta missing-texture square. Owning
 * the icons removes the guesswork and keeps the set visually consistent.
 *
 * Each icon is a thing that exists in the game rather than a generic dashboard
 * symbol, so a player recognises it before reading the label. They are authored
 * as 16x16 character maps - the resolution vanilla item art uses - and doubled
 * to 32x32, which keeps the pixel grid crisp instead of resampling it.
 */
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'packs', 'RP', 'textures', 'ui');
const ART_SIZE = 16;
const SIZE = ART_SIZE * 2;

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

/* ------------------------------------------------------------------ palette */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255,
];

const PAL = {
  k: hex('#17181d'), w: hex('#f4f7fb'), s: hex('#c8cfd9'), g: hex('#8c95a3'),
  d: hex('#4c535e'), n: hex('#4a3524'), b: hex('#7a5230'), t: hex('#b98a52'),
  r: hex('#c0392b'), R: hex('#e8615a'), o: hex('#e08a34'), y: hex('#f2c24c'),
  Y: hex('#c9962e'), e: hex('#3fbf74'), E: hex('#24894f'), l: hex('#8fcf48'),
  c: hex('#4fc3d9'), u: hex('#3c7adb'), U: hex('#2a55a0'), p: hex('#9b6be0'),
  P: hex('#5e3e96'), m: hex('#d96ba0'), i: hex('#dce1e8'), I: hex('#98a1b0'),
  q: hex('#5ae0d8'), f: hex('#d9a57c'), h: hex('#3a2a1e'),
};

/* --------------------------------------------------------------------- art */

const ART = {
  // A player head, the way you recognise somebody in game.
  profile: [
    '................', '................', '................',
    '...kkkkkkkkkk...', '...khhhhhhhhk...', '...khhhhhhhhk...',
    '...kffffffffk...', '...kfwwffwwfk...', '...kfuuffuufk...',
    '...kffffffffk...', '...kfnnnnnnfk...', '...kffffffffk...',
    '...kkkkkkkkkk...', '................', '................', '................',
  ],
  // Two players stood together, not one head behind another.
  players: [
    '................', '................', '................',
    '.kkkkkk..kkkkkk.', '.khhhhk..khhhhk.', '.kffffk..kffffk.',
    '.kfuufk..kfuufk.', '.kffffk..kffffk.', '.kkkkkk..kkkkkk.',
    '.kuuuuk..keeeek.', '.kuuuuk..keeeek.', '.kuuuuk..keeeek.',
    '.kkkkkk..kkkkkk.', '................', '................',
    '................',
  ],
  // An emerald - what you actually trade with.
  shop: [
    '................', '................', '................',
    '......kkkk......', '.....keeeek.....', '....keewweek....',
    '...keeewweeek...', '..keeeewweeeek..', '..kEeeeeeeeeEk..',
    '...kEeeeeeeEk...', '....kEeeeeEk....', '.....kEeeEk.....',
    '......kEEk......', '.......kk.......', '................', '................',
  ],
  economy: [
    '................', '................', '................', '................',
    '................', '....kkkkkkkk....', '...kyyyyyyyyk...',
    '..kyywwwwwwyyk..', '..kyyyyyyyyyyk..', '.kYyyyyyyyyyyYk.',
    '.kYYyyyyyyyyYYk.', '.kkkkkkkkkkkkkk.', '................',
    '................', '................', '................',
  ],
  auction: [
    '................', '................', '.......kk.......',
    '......kyyk......', '.....kyyyyk.....', '....kyyyyyyk....',
    '...kyywwwwyyk...', '...kyyyyyyyyk...', '..kyyyyyyyyyyk..',
    '..kYyyyyyyyyYk..', '.kYYYYYYYYYYYYk.', '.kkkkkkkkkkkkkk.',
    '......kYYk......', '......kkkk......', '................', '................',
  ],
  home: [
    '................', '................', '................', '................',
    '..kkkkkkkkkkkk..', '..kwwwwkrrrrrk..', '..kwwwwkrrrrrk..',
    '..kRrrrrrrrrrk..', '..krrrrrrrrrrk..', '..kttttttttttk..',
    '..kkkkkkkkkkkk..', '..kk........kk..', '..kk........kk..',
    '................', '................', '................',
  ],
  // Ender pearl - the thing you throw to teleport.
  warp: [
    '................', '................', '.....kkkkkk.....',
    '...kkqqqqqqkk...', '..kqqqqqqqqqqk..', '..kqwwqqqqqqqk..',
    '..kqwwqqqqqqqk..', '..kqqqqEEqqqqk..', '..kqqqEEEEqqqk..',
    '..kqqqqEEqqqqk..', '..kqqqqqqqqqqk..', '..kqqqqqqqqqqk..',
    '...kkqqqqqqkk...', '.....kkkkkk.....', '................',
    '................',
  ],
  // Eye of ender - a pearl someone else made, that others can follow.
  pwarp: [
    '................', '................', '.....kkkkkk.....',
    '...kkeeeeeekk...', '..keeeeeeeeeek..', '..kewweeeeeeek..',
    '..keeeekkeeeek..', '..keeekkkkeeek..', '..keeekkkkeeek..',
    '..keeeekkeeeek..', '..keeeeeeeeeek..', '..keeeeeeeeeek..',
    '...kkeeeeeekk...', '.....kkkkkk.....', '................',
    '................',
  ],
  // A map with a marker on it.
  land: [
    '................', '................', '................',
    '..kkkkkkkkkkkk..', '..kttttttttttk..', '..ktwwwwwwwwtk..',
    '..ktwEEEwwwwtk..', '..ktEEEEEwrwtk..', '..ktwEEEwrrwtk..',
    '..ktwwwwwwwwtk..', '..kttttttttttk..', '..kkkkkkkkkkkk..',
    '................', '................', '................',
    '................',
  ],
  // Golden apple - the thing you are pleased to be handed.
  reward: [
    '................', '................', '......kk........',
    '......kkEEEk....', '....kkkyykkk....', '..kkyyyyyyyykk..',
    '..kyywwyyyyyyk..', '.kyywwyyyyyyyyk.', '.kyyyyyyyyyyyyk.',
    '.kyyyyyyyyyyyyk.', '.kYyyyyyyyyyyYk.', '..kYyyyyyyyyYk..',
    '...kYYyyyyYYk...', '....kkYYYYkk....', '......kkkk......',
    '................',
  ],
  progress: [
    '................', '................', '......kkkk......',
    '......kttk......', '......kwwk......', '.....kwwwwk.....',
    '....kwwwwwwk....', '...kwwllllwwk...', '...kwllllllwk...',
    '..kwllllllllwk..', '..kwllllllllwk..', '..kwEllllllEwk..',
    '..kwEEEEEEEEwk..', '..kkkkkkkkkkkk..', '................', '................',
  ],
  clan: [
    '................', '................', '..kkkkkkkkkkkk..',
    '..kbkuuuuuuuuk..', '..kbkuuwwwwuuk..', '..kbkuwwwwwwuk..',
    '..kbkuuwwwwuuk..', '..kbkuuuwwuuuk..', '..kbkuuuuuuuuk..',
    '..kbkUUUUUUUUk..', '..kbkkkkkkkkkk..', '..kbk...........',
    '..kbk...........', '..kkk...........', '................', '................',
  ],
  // Ender chest - storage that follows you, which is what a vault is.
  vault: [
    '................', '................', '................', '................',
    '..kkkkkkkkkkkk..', '..kPPPPPPPPPPk..', '..kPppppppppPk..',
    '..kkkkkkkkkkkk..', '..kPppkyykppPk..', '..kPppkyykppPk..',
    '..kPppppppppPk..', '..kPppppppppPk..', '..kkkkkkkkkkkk..',
    '................', '................', '................',
  ],
  // A lever - the most literal "switch things on and off" in the game.
  settings: [
    '................', '................', '................',
    '..........kRk...', '.........kRRRk..', '.........kRRRk..',
    '..........kbk...', '.........kbk....', '........kbk.....',
    '.......kbk......', '..kkkkkkkkkkkk..', '..kggggggggggk..',
    '..kgddgggddggk..', '..kkkkkkkkkkkk..', '................', '................',
  ],
  moderation: [
    '................', '................', '..kkkkkkkkkkkk..',
    '..kiiiiiiiiiik..', '..kittttttttik..', '..kitwwwwwwtik..',
    '..kitwwwwwwtik..', '..kittttttttik..', '..kiiiiiiiiiik..',
    '...kiiiiiiiik...', '....kiiiiiik....', '.....kiiiik.....',
    '......kiik......', '.......kk.......', '................', '................',
  ],
  world: [
    '................', '................', '................',
    '..kkkkkkkkkkkk..', '..kllllllllllk..', '..klEllllElllk..',
    '..kEEEEEEEEEEk..', '..kbbbbbbbbbbk..', '..kbnbbbbbnbbk..',
    '..kbbbbnbbbbbk..', '..kbbnbbbbbnbk..', '..kbbbbbbbbbbk..',
    '..kkkkkkkkkkkk..', '................', '................', '................',
  ],
  // A name tag - a role is the label you wear.
  roles: [
    '................', '................', '................',
    '................', '..kkkkkkkkkkkk..', '..kttttttttttk..',
    '..ktwwwwwwwwtk..', '..ktwkkkkkkwtk..', '..ktwkkkkwwwtk..',
    '..ktwwwwwwwwtk..', '..kttttttttttk..', '..kkkkkkkkkkkk..',
    '................', '................', '................',
    '................',
  ],
  content: [
    '................', '................', '................',
    '..kkkkkkkkkkkk..', '..kuuuuuuuuuwk..', '..kuwwwwwwwuwk..',
    '..kuwwwwwwwuwk..', '..kuwkkkkkwuwk..', '..kuwwwwwwwuwk..',
    '..kuwkkkkkwuwk..', '..kuwwwwwwwuwk..', '..kUUUUUUUUUwk..',
    '..kkkkkkkkkkkk..', '................', '................',
    '................',
  ],
  data: [
    '................', '................', '................',
    '..kkkkkkkkkkkk..', '..kwwwwwwwwwwk..', '..kwwwwwwwuuwk..',
    '..kwwwwwwwuuwk..', '..kwwwwuuwuuwk..', '..kwwwwuuwuuwk..',
    '..kwuuwuuwuuwk..', '..kwuuwuuwuuwk..', '..kkkkkkkkkkkk..',
    '................', '................', '................', '................',
  ],
  mining: [
    '................', '................', '...kkk....kkk...',
    '..kqqqkkkkqqqk..', '..kqqqqqqqqqqk..', '..kkqqqqqqqqkk..',
    '......kbbk......', '.....kbbk.......', '....kbbk........',
    '...kbbk.........', '..kbbk..........', '..kbbk..........',
    '..kkk...........', '................', '................', '................',
  ],
  combat: [
    '................', '.......kk.......', '......kiik......',
    '......kiik......', '......kiik......', '......kiik......',
    '......kiik......', '......kiik......', '....kyyiiyyk....',
    '....kkkiikkk....', '......kbbk......', '......kbbk......',
    '......kbbk......', '......kkkk......', '................', '................',
  ],
  building: [
    '................', '................', '................',
    '..kkkkkkkkkkkk..', '..krrrrkrrrrrk..', '..krrrrkrrrrrk..',
    '..kkkkkkkkkkkk..', '..krrkrrrrkrrk..', '..krrkrrrrkrrk..',
    '..kkkkkkkkkkkk..', '..krrrrkrrrrrk..', '..krrrrkrrrrrk..',
    '..kkkkkkkkkkkk..', '................', '................', '................',
  ],
  // A carrot - a crop you can actually hold.
  farming: [
    '................', '................', '....kEk..kEk....',
    '.....kEkkEk.....', '......kEEk......', '.....kkkkkk.....',
    '.....kooook.....', '.....kooook.....', '.....kooook.....',
    '......kook......', '......kook......', '.......kk.......',
    '.......kk.......', '................', '................',
    '................',
  ],
  // A compass, needle and all.
  explore: [
    '................', '................', '.....kkkkkk.....',
    '...kkiiiiiikk...', '..kiiiiiiiiiik..', '..kiiwwrrwwiik..',
    '..kiwwwrrwwwik..', '..kiwwwrrwwwik..', '..kiwwwddwwwik..',
    '..kiwwwddwwwik..', '..kiiwwddwwiik..', '..kiiiiiiiiiik..',
    '...kkiiiiiikk...', '.....kkkkkk.....', '................',
    '................',
  ],
  back: [
    '................', '................', '................',
    '......kk........', '.....kwk........', '....kwwk........',
    '...kwwwkkkkkkk..', '..kwwwwwwwwwwwk.', '..kwwwwwwwwwwwk.',
    '...kwwwkkkkkkk..', '....kwwk........', '.....kwk........',
    '......kk........', '................', '................', '................',
  ],
};

/* ------------------------------------------------------------------ render */

/**
 * Turns one character map into pixels. Every row must be exactly ART_SIZE
 * characters and every character must be in the palette - a typo in art this
 * dense is otherwise invisible until it ships, so it fails the build instead.
 */
function render(name, rows) {
  if (rows.length !== ART_SIZE) {
    throw new Error(`${name}: expected ${ART_SIZE} rows, got ${rows.length}`);
  }
  const img = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => [0, 0, 0, 0]));
  rows.forEach((row, y) => {
    if (row.length !== ART_SIZE) {
      throw new Error(`${name} row ${y}: expected ${ART_SIZE} characters, got ${row.length}`);
    }
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const colour = PAL[ch];
      if (!colour) throw new Error(`${name} row ${y}: "${ch}" is not in the palette`);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) img[y * 2 + dy][x * 2 + dx] = colour;
      }
    });
  });
  return img;
}

await mkdir(OUT, { recursive: true });
const names = [];
for (const [name, rows] of Object.entries(ART)) {
  await writeFile(path.join(OUT, `adm_${name}.png`), encodePng(render(name, rows), SIZE, SIZE));
  names.push(`adm_${name}`);
}
console.log(`wrote ${names.length} icons to packs/RP/textures/ui/`);
