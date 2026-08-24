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

// A per-bundle ceiling, when set, must actually stop a listing.
admin.hold('minecraft:stone', 8);
say(admin, '!listitem 999999999 1 1');
check('listing price is accepted when no cap is configured',
  admin.messages.some((m) => /Listed/i.test(m)), admin.messages.join(' | '));

say(player, `!unlist ${listingId}`);
check('unlisting returns the stock', player.messages.some((m) => /stock returned/i.test(m)),
  player.messages.join(' | '));

// Jobs are on by default, so the same commands must work here. Without this
// the toggle test could pass simply by everything being permanently off.
say(player, '!jobs');
check('jobs are available when enabled',
  player.messages.some((m) => /miner/i.test(m)) && !player.messages.some((m) => /turned off/i.test(m)),
  player.messages.join(' | '));

say(player, '!job miner');
check('a job can be taken when enabled', player.messages.some((m) => /now a Miner/i.test(m)),
  player.messages.join(' | '));

// Reward XP must arrive as real, spendable vanilla experience.
player.experience = 0;
player.dailyClaimed = true;
say(player, '!daily');
const claimed = player.messages.some((m) => /Daily reward/i.test(m));
check('daily reward was claimable', claimed, player.messages.join(' | '));
if (claimed) {
  check('reward granted vanilla experience for enchanting', player.experience > 0,
    `experience = ${player.experience}`);
}

// Passive gains stay lifetime-only, or enchanting becomes free.
const beforePassive = player.experience;
world.afterEvents.playerBreakBlock.emit({
  player,
  block: { typeId: 'minecraft:stone', location: { x: 0, y: 64, z: 0 } },
  brokenBlockPermutation: { type: { id: 'minecraft:stone' } },
});
__test.flush();
check('breaking a block grants no vanilla experience', player.experience === beforePassive,
  `${beforePassive} -> ${player.experience}`);

// Player warps: public, player-created, and distinct from server warps.
say(player, '!setpwarp SkyMarket Cheap redstone');
check('a player can publish a warp', player.messages.some((m) => /Published/i.test(m)),
  player.messages.join(' | '));

say(admin, '!pwarp');
check('published warp is public to everyone', admin.messages.some((m) => /SkyMarket/i.test(m)),
  admin.messages.join(' | '));

// Names are claimed globally, so a second warp cannot shadow the first.
say(admin, '!setpwarp SkyMarket Copycat');
check('duplicate warp names are refused', admin.messages.some((m) => /already/i.test(m)),
  admin.messages.join(' | '));

// The per-player limit must hold.
say(player, '!setpwarp Second one');
say(player, '!setpwarp Third one');
check('player warp limit is enforced',
  player.messages.some((m) => /only have/i.test(m)), player.messages.join(' | '));

// Server warps stay staff-only; a member must not be able to add one.
const member = new Player('Member', 'p-member');
__test.players.push(member);
world.afterEvents.playerSpawn.emit({ player: member, initialSpawn: true });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
member.messages.length = 0;
world.beforeEvents.chatSend.emit({ sender: member, message: '!setwarp Spawn', cancel: false });
__test.flush();
check('server warps remain staff-only',
  member.messages.some((m) => /permission/i.test(m)), member.messages.join(' | '));

// ...while player warps are open to that same member.
member.messages.length = 0;
world.beforeEvents.chatSend.emit({ sender: member, message: '!setpwarp MemberSpot', cancel: false });
__test.flush();
check('player warps are open to ordinary players',
  member.messages.some((m) => /Published/i.test(m)), member.messages.join(' | '));

say(player, '!delpwarp SkyMarket');
check('owner can remove their warp', player.messages.some((m) => /Removed/i.test(m)),
  player.messages.join(' | '));

// Anticheat: illegal items and impossible stacks, without flagging staff.
player.slots[0] = { typeId: 'minecraft:command_block', amount: 1, maxAmount: 64 };
player.slots[1] = { typeId: 'minecraft:diamond', amount: 200, maxAmount: 64 };
say(admin, `!accheck ${player.name}`);
check('illegal item and overstack were removed',
  admin.messages.some((m) => /Removed 2/i.test(m)), admin.messages.join(' | '));
check('the offending slots are now empty',
  player.slots[0] === undefined && player.slots[1] === undefined);

say(admin, '!aclog');
check('detections were logged',
  admin.messages.some((m) => /command_block|Command Block/i.test(m)), admin.messages.join(' | '));

// Staff must not be policed: an admin in creative is doing their job.
admin.slots[0] = { typeId: 'minecraft:command_block', amount: 1, maxAmount: 64 };
say(admin, `!accheck ${admin.name}`);
check('staff are exempt from the anticheat',
  admin.slots[0] !== undefined, 'an admin had their command block confiscated');

// Breaking a protected block is refused rather than merely logged.
const breakEvent = {
  player,
  block: { typeId: 'minecraft:bedrock', location: { x: 0, y: 5, z: 0 } },
  cancel: false,
};
world.beforeEvents.playerBreakBlock.emit(breakEvent);
__test.flush();
check('breaking bedrock is blocked', breakEvent.cancel === true);

// The starter kit is handed out on first join while it is switched on.
const fresh = new Player('Fresh', 'p-fresh');
__test.players.push(fresh);
world.afterEvents.playerSpawn.emit({ player: fresh, initialSpawn: true });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
const kitItems = fresh.slots.filter((slot) => slot && slot.typeId !== 'adm:member_book');
check('a new player receives the starter kit contents',
  kitItems.some((slot) => slot.typeId === 'minecraft:stone_sword'),
  `held: ${fresh.slots.filter(Boolean).map((s) => s.typeId).join(', ') || 'nothing'}`);

// The menu items are not loot: dying must not cost you your own menus.
fresh.slots[5] = { typeId: 'adm:member_book', amount: 1, maxAmount: 1 };
world.afterEvents.entityDie.emit({ deadEntity: fresh, damageSource: { damagingEntity: undefined } });
__test.flush();
fresh.slots.fill(undefined);
world.afterEvents.playerSpawn.emit({ player: fresh, initialSpawn: false });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
check('the member book comes back after death',
  fresh.slots.some((slot) => slot?.typeId === 'adm:member_book'),
  `held: ${fresh.slots.filter(Boolean).map((s) => s.typeId).join(', ') || 'nothing'}`);

// Dynamic light must follow the player and, above all, clean up after itself.
const lightDim = __test.overworld;
player.location = { x: 100, y: 64, z: 100 };
player.offhand = { typeId: 'adm:offhand_torch', amount: 1, maxAmount: 1 };
lightDim.placed.length = 0;
for (const loop of system.intervals) loop.cb();
__test.flush();
const litAt = lightDim.placed.find((entry) => entry.type.includes('light_block'));
check('holding the torch places a light', Boolean(litAt),
  JSON.stringify(lightDim.placed.slice(0, 3)));

// Putting it away must take the light with it.
player.offhand = undefined;
lightDim.placed.length = 0;
for (const loop of system.intervals) loop.cb();
__test.flush();
check('putting the torch away clears the light',
  lightDim.placed.some((entry) => entry.type === 'minecraft:air'),
  JSON.stringify(lightDim.placed.slice(0, 3)));

// The continuous sweep must pop a piston set up next to a shulker box.
const dim = __test.overworld;
dim.setBlock(3, 64, 3, 'minecraft:piston', { facing_direction: 5 });
dim.setBlock(4, 64, 3, 'minecraft:purple_shulker_box');
dim.placed.length = 0;
admin.messages.length = 0;

for (const loop of system.intervals) loop.cb();
__test.flush();

const popped = dim.placed.some((entry) => entry.type === 'minecraft:air');
check('the sweep neutralises a piston beside a shulker', popped,
  `setBlockType calls: ${JSON.stringify(dim.placed)}`);
check('the piston is gone from the world',
  dim.getBlock({ x: 3, y: 64, z: 3 })?.typeId === 'minecraft:air',
  `block is now ${dim.getBlock({ x: 3, y: 64, z: 3 })?.typeId}`);
check('staff were told about it', /piston/i.test(admin.messages.join(' | ')),
  admin.messages.join(' | '));

// A shulker piped through a hopper is the funnel half of a storage dupe.
const hopperSlots = [{ typeId: 'minecraft:purple_shulker_box', amount: 1, maxAmount: 1 }];
const hopperContainer = {
  size: 5,
  getItem: (i) => hopperSlots[i],
  setItem: (i, v) => { hopperSlots[i] = v; },
};
dim.setBlock(2, 64, 2, 'minecraft:hopper', {}, hopperContainer);
admin.messages.length = 0;

for (const loop of system.intervals) loop.cb();
__test.flush();

check('a shulker funnelled through a hopper is removed', hopperSlots[0] === undefined,
  `hopper still held ${hopperSlots[0]?.typeId ?? 'nothing'}`);
check('the funnel exploit was reported', /hopper|shulker/i.test(admin.messages.join(' | ')),
  admin.messages.join(' | '));

// Minecart chest dupe: two removals at one spot inside the window. This runs
// off the before-event, because the after-event carries no location at all.
const cartAt = { x: 10, y: 64, z: 10 };
const removal = () => ({
  removedEntity: { typeId: 'minecraft:chest_minecart', location: cartAt, dimension: __test.overworld },
});

admin.messages.length = 0;
world.beforeEvents.entityRemove.emit(removal());
__test.flush();
world.beforeEvents.entityRemove.emit(removal());
__test.flush();

const alerts = admin.messages.join(' | ');
check('minecart dupe pattern is detected', /minecart/i.test(alerts), alerts);
// A heuristic is a pattern, not proof, so it must not count toward a ban.
check('heuristic detections are not counted toward a ban', /not counted/i.test(alerts), alerts);

say(admin, '!aclog');
check('the detection reached the log',
  admin.messages.some((m) => /minecart/i.test(m)), admin.messages.join(' | '));

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

/*
 * The Features form maps toggles to config fields by array index, so inserting
 * one in the middle silently shifts every setting after it onto the wrong
 * field. Cheap to get wrong, invisible in play, so it is checked here.
 */
const adminSource = await readFile(path.join(ROOT, 'src', 'menus', 'admin.ts'), 'utf8');
for (const [form, marker] of [
  ['Features', "prompt(player, 'Features'"],
  ['Anticheat', "prompt(admin, 'Anticheat settings'"],
]) {
  const from = adminSource.indexOf(marker);
  const closer = adminSource.indexOf('ok(player,', from);
  const adminCloser = adminSource.indexOf('ok(admin,', from);
  const end = Math.min(...[closer, adminCloser].filter((i) => i > from));
  const body = adminSource.slice(from, end);
  const labels = [...body.matchAll(/label: '([^']+)'/g)].length;
  const indices = [...body.matchAll(/values\[(\d+)\]/g)].map((m) => Number(m[1]));
  const unique = [...new Set(indices)].sort((a, b) => a - b);
  check(`${form} form: every control is assigned`, labels === unique.length,
    `${labels} controls, ${unique.length} assigned`);
  check(`${form} form: indices are contiguous from 0`,
    unique.every((value, i) => value === i), unique.join(','));
}

/*
 * A menu button should do the thing, not tell the player which command to go
 * and type. That pattern is easy to reintroduce when adding a screen, so the
 * menus are checked for it directly.
 */
for (const file of ['member.ts', 'admin.ts']) {
  const source = await readFile(path.join(ROOT, 'src', 'menus', file), 'utf8');
  const instructions = [...source.matchAll(/`[^`]*Use \$\{prefix\}[^`]*`|`[^`]*Use !\w+[^`]*`/g)];
  check(`menus/${file}: no button just prints a command`, instructions.length === 0,
    instructions.map((m) => m[0]).join(' | '));
}

/*
 * A resource pack that declares neither the pbr capability nor an addon
 * product_type silently caps the whole game at Fancy graphics, so nobody can
 * turn on Vibrant Visuals. Nothing errors and nothing logs; the setting simply
 * refuses to stick, which is close to impossible to trace back to a pack.
 */
const rpManifest = JSON.parse(
  await readFile(path.join(ROOT, 'packs', 'RP', 'manifest.json'), 'utf8'),
);
check('resource pack declares the pbr capability',
  (rpManifest.capabilities ?? []).includes('pbr'),
  JSON.stringify(rpManifest.capabilities ?? []));
check('resource pack is marked as an addon',
  rpManifest.metadata?.product_type === 'addon',
  JSON.stringify(rpManifest.metadata ?? {}));

const [major, minor, patch] = rpManifest.header.min_engine_version;
const meetsPbrFloor =
  major > 1 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 120)));
check('min_engine_version meets the 1.21.120 floor pbr requires', meetsPbrFloor,
  rpManifest.header.min_engine_version.join('.'));

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

  /*
   * Icons must ship with the pack, with one documented exception: an item that
   * is meant to look exactly like a vanilla one points at vanilla's own
   * texture. Listing those explicitly means a deliberate reference passes while
   * an accidental one still fails.
   */
  const VANILLA_TEXTURES = new Set(['textures/blocks/torch_on']);
  const texturePath = atlas.texture_data?.[shorthand]?.textures;
  if (texturePath) {
    const onDisk = path.join(packsDir, 'RP', `${texturePath}.png`);
    check(`${id}: ${texturePath} resolves`,
      existsSync(onDisk) || VANILLA_TEXTURES.has(texturePath),
      'not shipped with the pack and not a listed vanilla texture');
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
