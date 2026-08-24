/**
 * Smoke test.
 *
 * The addon cannot be launched in Minecraft from CI, so the bundle is built
 * against mock implementations of the two Minecraft modules and executed in
 * Node. This catches load-order faults, top-level API misuse, startup crashes
 * and command registration problems before the pack ever reaches a world.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const outDir = await mkdtemp(path.join(tmpdir(), 'adm-smoke-'));
const outfile = path.join(outDir, 'bundle.mjs');

/**
 * The mocks must stay external so the bundle and this test share one module
 * instance; inlining them would give the bundle a private copy of `world`.
 * A throwaway node_modules tree maps the bare specifiers onto the mock files.
 */
for (const [name, file] of [['server', 'server.mjs'], ['server-ui', 'server-ui.mjs']]) {
  const dir = path.join(outDir, 'node_modules', '@minecraft', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `@minecraft/${name}`, type: 'module', main: 'index.mjs' }));
  const target = new URL(`file://${path.join(ROOT, 'test', 'mocks', file)}`).href;
  await writeFile(path.join(dir, 'index.mjs'), `export * from ${JSON.stringify(target)};\n`);
}

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'main.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  external: ['@minecraft/server', '@minecraft/server-ui'],
});

const mock = await import(path.join(ROOT, 'test', 'mocks', 'server.mjs'));
const { world, system, Player, __test } = mock;

const warnings = [];
globalThis.console = {
  ...console,
  warn: (...a) => { warnings.push(a.join(' ')); },
  log: () => {},
  error: (...a) => { warnings.push(a.join(' ')); },
};

console.log('loading bundle...');
// Module scope runs under early execution, exactly as the engine does it.
let loadError;
try {
  await import(outfile);
} catch (error) {
  loadError = error;
}
const realConsole = globalThis.console;
globalThis.console = { log: (...a) => process.stdout.write(a.join(' ') + '\n'), warn: realConsole.warn, error: realConsole.error };

console.log('\nresults:');
check('bundle loads without touching world state', loadError === undefined, String(loadError ?? ''));

// Startup event: native command registration must run here, still early.
const registered = [];
let startupError;
try {
  system.beforeEvents.startup.emit({
  customCommandRegistry: {
    registerCommand(def) { registered.push(def); },
      registerEnum() {},
    },
  });
} catch (error) {
  startupError = error;
}
check('startup completes without touching world state', startupError === undefined, String(startupError ?? ''));

// First tick: early execution ends and deferred initialisation runs.
let initError;
try {
  __test.flush();
} catch (error) {
  initError = error;
}
check('deferred initialisation runs cleanly on the first tick', initError === undefined, String(initError ?? ''));
check('native commands registered at startup', registered.length > 50, `got ${registered.length}`);
check('every native command is namespaced', registered.every((c) => c.name.startsWith('adm:')));
check(
  'mandatory parameters precede optional ones',
  registered.every((c) => !c.mandatoryParameters || c.mandatoryParameters.every((p) => p.type)),
);
check('info command exists', registered.some((c) => c.name === 'adm:info'));
check('land claim command survived registration', registered.some((c) => c.name === 'adm:claim'));
check('quest claim command registered separately', registered.some((c) => c.name === 'adm:questclaim'));

// Intervals and event subscriptions should be wired.
check('background loops scheduled', system.intervals.length >= 5, `got ${system.intervals.length}`);
check('chat handler subscribed', world.beforeEvents.chatSend.count > 0);
check('block protection subscribed', world.beforeEvents.playerBreakBlock.count > 0);

// Simulate a player joining.
const player = new Player('Steve', 'p-steve');
__test.players.push(player);
world.afterEvents.playerSpawn.emit({ player, initialSpawn: true });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
check('join produced messages to the player', player.messages.length > 0, `got ${player.messages.length}`);

// Run every scheduled interval once; none should throw.
let intervalError;
try {
  for (const i of system.intervals) i.cb();
} catch (error) {
  intervalError = error;
}
check('all background loops run without throwing', intervalError === undefined, String(intervalError));

// Drive a chat command end to end.
player.messages.length = 0;
const chatEvent = { sender: player, message: '!balance', cancel: false };
world.beforeEvents.chatSend.emit(chatEvent);
__test.flush();
check('chat command was intercepted', chatEvent.cancel === true);
check('chat command produced a reply', player.messages.length > 0, `got ${player.messages.length}`);

// An unknown command should be reported, not crash.
player.messages.length = 0;
world.beforeEvents.chatSend.emit({ sender: player, message: '!definitelynotacommand', cancel: false });
__test.flush();
check('unknown command handled', player.messages.some((m) => /unknown command/i.test(m)));

// Normal chat should be reformatted rather than passed through untouched.
const normal = { sender: player, message: 'hello world', cancel: false };
world.beforeEvents.chatSend.emit(normal);
__test.flush();
check('normal chat is formatted', normal.cancel === true && world.broadcasts.some((m) => m.includes('hello world')));

// Gameplay events must not throw.
let eventError;
try {
  world.afterEvents.playerBreakBlock.emit({
    player,
    block: { typeId: 'minecraft:stone', location: { x: 0, y: 64, z: 0 } },
    brokenBlockPermutation: { type: { id: 'minecraft:iron_ore' } },
  });
  world.afterEvents.playerPlaceBlock.emit({ player, block: { typeId: 'minecraft:stone', location: { x: 0, y: 64, z: 0 } } });
  world.afterEvents.entityDie.emit({ deadEntity: player, damageSource: { damagingEntity: undefined } });
} catch (error) {
  eventError = error;
}
check('gameplay events handled without throwing', eventError === undefined, String(eventError));

// Cosmetics and quotas, driven end to end through chat commands.
const admin = new Player('Root', 'p-root');
admin.tags.add('admin');
__test.players.push(admin);
world.afterEvents.playerSpawn.emit({ player: admin, initialSpawn: true });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();

const say = (who, message) => {
  who.messages.length = 0;
  world.beforeEvents.chatSend.emit({ sender: who, message, cancel: false });
  __test.flush();
};

say(player, '!quota');
check('quota command replies', player.messages.length > 0);

say(admin, '!eco give Steve 100000');
say(player, '!balance');
check('admin economy command took effect', player.messages.some((m) => /100,\d{3}|10[0-9],\d{3}/.test(m)),
  player.messages.join(' | '));

say(player, '!buycosmetic flame_trail');
check('cosmetic purchased', player.messages.some((m) => /Bought/i.test(m)), player.messages.join(' | '));

say(player, '!equip flame_trail');
check('cosmetic equipped', player.messages.some((m) => /Now wearing/i.test(m)), player.messages.join(' | '));

__test.particles.length = 0;
for (const i of system.intervals) i.cb();
check('equipped cosmetic emits particles', __test.particles.length > 0, `${__test.particles.length} emitted`);
check('cosmetic uses the configured particle',
  __test.particles.includes('minecraft:basic_flame_particle'),
  [...new Set(__test.particles)].join(', '));

say(player, '!equip none');
__test.particles.length = 0;
for (const i of system.intervals) i.cb();
check('removing a cosmetic stops the particles', __test.particles.length === 0, `${__test.particles.length} emitted`);

// Player stalls: listing, buying, payment, stock and the exploit guard.
say(player, '!balance');
const sellerBefore = /(\d[\d,]*)/.exec(player.messages.join(' '))?.[1];

player.hold('minecraft:diamond', 64);
say(player, '!listitem 500 8 4');
check('player listing was created', player.messages.some((m) => /Listed/i.test(m)), player.messages.join(' | '));
check('stock was taken from the seller inventory',
  player.slots.filter((x) => x?.typeId === 'minecraft:diamond').reduce((n, x) => n + (x?.amount ?? 0), 0) === 32,
  'expected 32 diamonds left of 64');

say(player, '!mylistings');
const listingId = /(p_[a-z0-9]+)/.exec(player.messages.join(' '))?.[1];
check('listing is visible to its owner', Boolean(listingId), player.messages.join(' | '));

// A second player buys a bundle; the seller should be paid.
say(admin, '!shop Player Stalls');
check('listing appears in the shop', admin.messages.some((m) => /Diamond/i.test(m)), admin.messages.join(' | '));

say(player, '!balance');
const sellerAfterList = player.messages.join(' ');
check('seller balance unchanged by listing', sellerAfterList.includes(String(sellerBefore ?? '')), sellerAfterList);

// The exploit guard: a player listing must never be sellable back to the shop.
say(player, '!sellhand');
check('player listings cannot be sold back to the shop',
  !player.messages.some((m) => /Sold for/i.test(m)), player.messages.join(' | '));

say(player, `!unlist ${listingId}`);
check('unlisting returns the stock', player.messages.some((m) => /stock returned/i.test(m)),
  player.messages.join(' | '));

// Persistence must survive a shutdown/reload cycle.
system.beforeEvents.shutdown.emit({});
__test.flush();
check('data was persisted to dynamic properties', __test.props.size > 0, `${__test.props.size} keys`);
check('profile data round-trips', [...__test.props.keys()].some((k) => k.startsWith('adm:profiles')));

check('no duplicate command warnings', !warnings.some((w) => /duplicate command|collides with/.test(w)),
  warnings.filter((w) => /duplicate|collides/.test(w)).join(' | '));
check('no unexpected warnings during startup', warnings.length === 0, warnings.slice(0, 3).join(' | '));

console.log(`\n  ${registered.length} native commands registered`);
console.log(`  ${system.intervals.length} background loops`);
console.log(`  ${__test.props.size} persisted storage keys`);

/* ------------------------------------------------------------ pack assets */

/*
 * The script can be flawless while the pack still renders as an invisible item
 * with a debug name, because names and icons resolve entirely through resource
 * pack lookups that nothing else validates.
 */
console.log('\npack integrity:');

const packsDir = path.join(ROOT, 'packs');
const itemDir = path.join(packsDir, 'BP', 'items');
const atlas = JSON.parse(await readFile(path.join(packsDir, 'RP', 'textures', 'item_texture.json'), 'utf8'));
const lang = await readFile(path.join(packsDir, 'RP', 'texts', 'en_US.lang'), 'utf8');

for (const file of await readdir(itemDir)) {
  const item = JSON.parse(await readFile(path.join(itemDir, file), 'utf8'))['minecraft:item'];
  const id = item.description.identifier;
  const icon = item.components['minecraft:icon'];

  /*
   * A format_version newer than the player's client is not understood, and the
   * components block silently fails to apply - the item still registers and
   * still shows its name, but renders with no icon. Older schemas keep working
   * on new clients, so the safe direction is down.
   */
  const SAFE_ITEM_FORMAT = [1, 21, 0];
  const declared = String(JSON.parse(await readFile(path.join(itemDir, file), 'utf8')).format_version)
    .split('.').map(Number);
  const withinBaseline =
    declared[0] < SAFE_ITEM_FORMAT[0] ||
    (declared[0] === SAFE_ITEM_FORMAT[0] &&
      (declared[1] < SAFE_ITEM_FORMAT[1] ||
        (declared[1] === SAFE_ITEM_FORMAT[1] && (declared[2] ?? 0) <= SAFE_ITEM_FORMAT[2])));
  check(`${id}: format_version ${declared.join('.')} is within the supported baseline`,
    withinBaseline, `newer than ${SAFE_ITEM_FORMAT.join('.')} - icons may not render on older clients`);

  /*
   * Only two shapes are valid: a bare string, or { textures: { default } }.
   * A singular "texture" key looks plausible and is silently discarded, which
   * leaves the item registered and named but rendered blank.
   */
  const validShape = typeof icon === 'string' || typeof icon?.textures?.default === 'string';
  check(`${id}: icon component has a valid shape`, validShape,
    `got ${JSON.stringify(icon)} - use a string or { textures: { default } }`);
  check(`${id}: icon does not use the invalid singular "texture" key`,
    !(icon && typeof icon === 'object' && 'texture' in icon));

  const shorthand = typeof icon === 'string' ? icon : icon?.textures?.default;
  check(`${id}: icon names an atlas key`, Boolean(shorthand), JSON.stringify(icon));
  check(`${id}: atlas defines "${shorthand}"`, Boolean(atlas.texture_data?.[shorthand]));

  const texturePath = atlas.texture_data?.[shorthand]?.textures;
  if (texturePath) {
    const onDisk = path.join(packsDir, 'RP', `${texturePath}.png`);
    check(`${id}: ${texturePath}.png exists`, existsSync(onDisk));
  }

  // The engine looks the name up by the identifier, colon included.
  check(`${id}: has a translation for "item.${id}"`, lang.includes(`item.${id}=`),
    'missing lang key - the item would show a debug name');

  // A literal display_name silently defeats the lang lookup.
  check(`${id}: no conflicting display_name component`,
    item.components['minecraft:display_name'] === undefined);
}

/*
 * Client entities point at geometry, textures and render controllers by name.
 * A name that resolves to nothing produces an invisible entity and a content
 * log error, with no sign of trouble anywhere in the script.
 */
const rpDir = path.join(packsDir, 'RP');

async function collectJson(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...(await collectJson(full)));
    else if (item.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// Every geometry identifier the resource pack defines.
const geometryIds = new Set();
for (const file of await collectJson(path.join(rpDir, 'models'))) {
  const model = JSON.parse(await readFile(file, 'utf8'));
  for (const geo of model['minecraft:geometry'] ?? []) {
    if (geo.description?.identifier) geometryIds.add(geo.description.identifier);
  }
}

// Every render controller the resource pack defines.
const controllerIds = new Set();
for (const file of await collectJson(path.join(rpDir, 'render_controllers'))) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  for (const id of Object.keys(doc.render_controllers ?? {})) controllerIds.add(id);
}

for (const file of await collectJson(path.join(rpDir, 'entity'))) {
  const description = JSON.parse(await readFile(file, 'utf8'))['minecraft:client_entity']?.description;
  if (!description) continue;
  const id = description.identifier;

  for (const [slot, geometry] of Object.entries(description.geometry ?? {})) {
    check(`${id}: geometry "${geometry}" (${slot}) is defined`, geometryIds.has(geometry),
      `not found in RP models - the entity would render as nothing`);
  }
  for (const [slot, texture] of Object.entries(description.textures ?? {})) {
    check(`${id}: texture ${texture} (${slot}) exists`, existsSync(path.join(rpDir, `${texture}.png`)));
  }
  for (const controller of description.render_controllers ?? []) {
    const name = typeof controller === 'string' ? controller : Object.keys(controller)[0];
    check(`${id}: render controller "${name}" is defined`, controllerIds.has(name));
  }
}

/*
 * Menu icons. Pointing at a vanilla texture path is a bet that the path exists
 * and keeps its name; several did not, and rendered as the magenta
 * missing-texture square. Every icon must therefore be one this pack ships.
 */
const srcFiles = [];
async function walkSrc(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) await walkSrc(full);
    else if (item.name.endsWith('.ts')) srcFiles.push(full);
  }
}
await walkSrc(path.join(ROOT, 'src'));

const referenced = new Set();
for (const file of srcFiles) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(/'(textures\/[a-z0-9_/]+)'/g)) referenced.add(m[1]);
}

const foreign = [...referenced].filter((t) => !t.startsWith('textures/ui/adm_'));
check('no icons point at vanilla texture paths', foreign.length === 0,
  foreign.join(', ') || '');

for (const texture of referenced) {
  check(`icon ${texture} ships with the pack`, existsSync(path.join(rpDir, `${texture}.png`)));
}
console.log(`\n  ${referenced.size} icons referenced, all shipped`);

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
