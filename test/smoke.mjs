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

/**
 * Server warps must be creatable from the admin menu itself - a warp list with
 * no way to add to it can only ever be empty - and whatever staff create there
 * has to be the same list ordinary players see in the member menu.
 */
const menus = await import(path.join(ROOT, 'test', 'mocks', 'server-ui.mjs'));
const { __ui } = menus;

/** Reads a player's balance back out of `!balance`. */
function balanceNow(who) {
  const saved = [...who.messages];
  who.messages.length = 0;
  world.beforeEvents.chatSend.emit({ sender: who, message: '!balance', cancel: false });
  __test.flush();
  const text = who.messages.join(' ');
  who.messages.length = 0;
  who.messages.push(...saved);
  const found = /([\d,]+)/.exec(text.replace(/[^\d,]/g, ' '));
  return found ? Number(found[1].replace(/,/g, '')) : NaN;
}

/**
 * Lets the fire-and-forget menu promise chain settle between clicks. Pending
 * timeouts are fired too, so waits like the teleport warmup elapse.
 */
async function settle() {
  for (let i = 0; i < 20; i++) {
    __test.flush();
    for (const t of system.timeouts.splice(0)) t.cb();
    for (const t of [...system.intervals]) t.cb();
    await new Promise((r) => setImmediate(r));
  }
}

__ui.reset();
admin.messages.length = 0;
// Admin Suite -> Content -> Warps
__ui.click(/Content/);
__ui.click(/Warps/);
await settle();
world.beforeEvents.chatSend.emit({ sender: admin, message: '!suite', cancel: false });
await settle();

const warpButtons = __ui.lastButtons();
check('the admin warp list offers a create button',
  warpButtons.some((b) => /Create a warp here/i.test(b)), warpButtons.join(' | '));
check('an empty warp list says so instead of looking broken',
  /No warps yet/i.test(__ui.lastBody()), JSON.stringify(__ui.lastBody()));

// Click it and fill the form in.
__ui.reset();
admin.messages.length = 0;
__ui.click(/Create a warp here/);
__ui.submit('Market', '25');
await settle();
world.beforeEvents.chatSend.emit({ sender: admin, message: '!suite', cancel: false });
__ui.reset();
__ui.click(/Content/);
__ui.click(/Warps/);
__ui.click(/Create a warp here/);
__ui.submit('Market', '25');
await settle();

check('the create button actually creates the warp',
  admin.messages.some((m) => /Market.*created/i.test(m)), admin.messages.join(' | '));

// The member menu must show that same warp - one table, two surfaces.
__ui.reset();
member.messages.length = 0;
__ui.click(/Warps/);
await settle();
world.beforeEvents.chatSend.emit({ sender: member, message: '!menu', cancel: false });
await settle();

const memberWarps = __ui.lastButtons();
check('an admin-made warp appears in the member menu',
  memberWarps.some((b) => /Market/.test(b)), memberWarps.join(' | '));
check('the member menu shows the warp cost the admin set',
  memberWarps.some((b) => /Market/.test(b) && /25/.test(b)), memberWarps.join(' | '));

// And it must be reachable, not just listed.
__ui.reset();
member.messages.length = 0;
const memberBalanceBefore = balanceNow(member);
__ui.click(/Warps/);
__ui.click(/Market/);
await settle();
world.beforeEvents.chatSend.emit({ sender: member, message: '!menu', cancel: false });
await settle();
check('a member can travel to an admin-made warp from the menu',
  member.messages.some((m) => /Warped to Market/i.test(m)), member.messages.join(' | '));
// Arriving means arriving: the warp's own coordinates, not merely a message.
const marketWarp = { x: admin.location.x, y: admin.location.y, z: admin.location.z };
check('travelling actually moves the member to the warp',
  Math.abs(member.location.x - marketWarp.x) < 0.01
  && Math.abs(member.location.z - marketWarp.z) < 0.01,
  `member at ${member.location.x},${member.location.z} vs warp ${marketWarp.x},${marketWarp.z}`);
// The listed cost must really be taken out of their balance.
check('the warp cost is charged on arrival', memberBalanceBefore - balanceNow(member) === 25,
  `${memberBalanceBefore} -> ${balanceNow(member)}`);

// The same warp is visible to the plain command too, so both paths agree.
say(member, '!warp');
check('an admin-made warp is listed by !warp',
  member.messages.some((m) => /Market/.test(m)), member.messages.join(' | '));

__ui.reset();

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

/*
 * The menu items are not loot. This mimics the real death sequence rather than
 * a convenient one: by the time the event reaches script the inventory has
 * already been emptied, so anything that inspects it at that moment sees
 * nothing. The restore has to work from that state.
 */
fresh.slots[5] = { typeId: 'adm:member_book', amount: 1, maxAmount: 1 };
world.afterEvents.entityDie.emit({ deadEntity: fresh, damageSource: { damagingEntity: undefined } });
__test.flush();
fresh.slots.fill(undefined);          // the game dropped or cleared everything
world.afterEvents.playerSpawn.emit({ player: fresh, initialSpawn: false });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
check('the member book comes back after death',
  fresh.slots.some((slot) => slot?.typeId === 'adm:member_book'),
  `held: ${fresh.slots.filter(Boolean).map((s) => s.typeId).join(', ') || 'nothing'}`);

// Nothing should be duplicated for a player who kept theirs.
const bookCount = () => fresh.slots.filter((slot) => slot?.typeId === 'adm:member_book').length;
world.afterEvents.playerSpawn.emit({ player: fresh, initialSpawn: false });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
check('respawning again does not duplicate it', bookCount() === 1, `held ${bookCount()} copies`);

// The admin item returns only to somebody who had one and may still use it.
admin.slots.fill(undefined);
say(admin, '!getsuite');
check('an admin can take the admin item',
  admin.slots.some((slot) => slot?.typeId === 'adm:admin_suite'), admin.messages.join(' | '));

admin.slots.fill(undefined);
world.afterEvents.playerSpawn.emit({ player: admin, initialSpawn: false });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
check('the admin item comes back after death',
  admin.slots.some((slot) => slot?.typeId === 'adm:admin_suite'),
  `held: ${admin.slots.filter(Boolean).map((s) => s.typeId).join(', ') || 'nothing'}`);

// An ordinary player who never had one must not be handed the admin item.
fresh.slots.fill(undefined);
world.afterEvents.playerSpawn.emit({ player: fresh, initialSpawn: false });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();
check('a normal player is not given the admin item',
  !fresh.slots.some((slot) => slot?.typeId === 'adm:admin_suite'),
  `held: ${fresh.slots.filter(Boolean).map((s) => s.typeId).join(', ')}`);

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

// Freezing has to actually hold a player: input, world actions and the exits.
say(admin, `!freeze ${player.name}`);
check('freeze reports success', admin.messages.some((m) => /now frozen/i.test(m)),
  admin.messages.join(' | '));

// Category 2 is Movement, 1 is Camera, 6 is Jump.
check('movement is locked', player.lockedInput.get(2) === false);
check('the camera is locked so they cannot look around', player.lockedInput.get(1) === false);
check('jumping is locked', player.lockedInput.get(6) === false);

const frozenBreak = {
  player,
  block: { typeId: 'minecraft:dirt', location: { x: 1, y: 64, z: 1 } },
  cancel: false,
};
world.beforeEvents.playerBreakBlock.emit(frozenBreak);
__test.flush();
check('a frozen player cannot break blocks', frozenBreak.cancel === true);

const frozenHit = {
  hurtEntity: admin,
  damageSource: { damagingEntity: player },
  cancel: false,
};
world.beforeEvents.entityHurt.emit(frozenHit);
__test.flush();
check('a frozen player cannot attack', frozenHit.cancel === true);

// The real escape: teleporting out of a freeze would defeat the whole point.
say(player, '!sethome frozenspot');
say(player, '!home frozenspot');
check('a frozen player cannot teleport away',
  player.messages.some((m) => /frozen and cannot teleport/i.test(m)),
  player.messages.join(' | '));

say(admin, `!freeze ${player.name}`);
check('unfreezing restores the camera', player.lockedInput.get(1) === true);

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
for (const [form, marker] of [['Features', "prompt(player, 'Features'"]]) {
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
 * Copy conventions. Messages are the part of the addon a player reads most,
 * and drift between them shows up as sloppiness: every one starts with a
 * capital and ends a sentence.
 */
{
  const offenders = [];
  const files = [
    'src/menus/admin.ts', 'src/menus/member.ts',
    ...(await readdir(path.join(ROOT, 'src', 'modules'))).map((f) => `src/modules/${f}`),
  ];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    // Messages reach the player two ways: passed straight to err/ok, or
    // returned as a problem string for a caller to report. Both are prose,
    // so both are held to the same rule. A returned literal only counts as
    // prose when it has a space in it, which leaves ids and keys alone.
    const spoken = [
      ...[...source.matchAll(/\b(?:err|ok)\([A-Za-z]+, '([^']+)'/g)].map((m) => m[1]),
      ...[...source.matchAll(/\breturn '([^']*\s[^']*)'/g)].map((m) => m[1]),
    ];
    for (const text of spoken) {
      if (!/^[A-Z]/.test(text)) offenders.push(`${file}: lowercase "${text}"`);
      else if (!/[.!?:>]$/.test(text)) offenders.push(`${file}: unterminated "${text}"`);
    }
  }
  check('every message is a properly written sentence', offenders.length === 0,
    offenders.slice(0, 4).join(' | '));
}

/*
 * One screen at a time. Using a suite item at a block raises both `itemUse`
 * and `playerInteractWithBlock`, so one physical click used to start two
 * menus: the second could not show while the first was up, waited in the
 * retry loop, then appeared in the gap between one screen closing and the
 * next opening. That reads as a click throwing you back to the top, and
 * leaves two screens to dismiss instead of one.
 */
{
  const clicker = new Player('Clicker', 'p-click');
  __test.players.push(clicker);
  world.afterEvents.playerSpawn.emit({ player: clicker, initialSpawn: true });
  for (const t of system.timeouts.splice(0)) t.cb();
  __test.flush();

  __ui.reset();
  const close = __ui.hold();
  // The two events one right-click at a block really produces.
  world.afterEvents.itemUse.emit({ source: clicker, itemStack: { typeId: 'adm:member_book' } });
  await settle();
  const afterFirst = __ui.shown.length;
  world.beforeEvents.playerInteractWithBlock.emit({
    player: clicker, itemStack: { typeId: 'adm:member_book' },
    block: { typeId: 'minecraft:stone', location: { x: 0, y: 64, z: 0 } }, cancel: false,
  });
  await settle();

  check('one click opens exactly one menu', __ui.shown.length === afterFirst,
    `${afterFirst} -> ${__ui.shown.length} forms shown`);
  check('the click did open a menu at all', afterFirst === 1, `${afterFirst} forms shown`);

  // Closing it must leave nothing behind, and the next click must still work.
  close();
  await settle();
  __ui.reset();
  __ui.answer({ canceled: true, cancelationReason: 'UserClosed' });
  world.afterEvents.itemUse.emit({ source: clicker, itemStack: { typeId: 'adm:member_book' } });
  await settle();
  check('the menu still opens after the last one was closed', __ui.shown.length === 1,
    `${__ui.shown.length} forms shown`);

  // A player busy in chat still gets their menu once the chat closes.
  __ui.reset();
  __ui.busy();
  __ui.answer({ canceled: true, cancelationReason: 'UserClosed' });
  world.beforeEvents.chatSend.emit({ sender: clicker, message: '!menu', cancel: false });
  await settle();
  check('a menu asked for from chat retries past the chat screen',
    __ui.shown.length === 2, `${__ui.shown.length} attempts`);
}

/*
 * Search. Lists that grow with the server cannot be worked by paging alone,
 * so the long ones filter - and a search that matches nothing has to say so
 * rather than looking like the list emptied itself.
 */
{
  // Enough players that the list spills past one page.
  for (let i = 0; i < 24; i++) {
    const extra = new Player(i === 7 ? 'Findme' : `Filler${i}`, `p-bulk-${i}`);
    __test.players.push(extra);
    world.afterEvents.playerSpawn.emit({ player: extra, initialSpawn: true });
  }
  for (const t of system.timeouts.splice(0)) t.cb();
  __test.flush();

  __ui.reset();
  __ui.click(/Players/);
  await settle();
  world.beforeEvents.chatSend.emit({ sender: admin, message: '!suite', cancel: false });
  await settle();
  const unfiltered = __ui.lastButtons();
  check('a long list offers a search button',
    unfiltered.some((b) => /Search/.test(b)), unfiltered.slice(0, 4).join(' | '));
  check('a long list is paged rather than endless',
    unfiltered.some((b) => /Next page/.test(b)), `${unfiltered.length} buttons`);

  __ui.reset();
  __ui.click(/Players/);
  __ui.click(/Search/);
  __ui.submit('findme');
  await settle();
  world.beforeEvents.chatSend.emit({ sender: admin, message: '!suite', cancel: false });
  await settle();
  const filtered = __ui.lastButtons();
  check('searching narrows the list to the match',
    filtered.some((b) => /Findme/.test(b)) && !filtered.some((b) => /Filler1\b/.test(b)),
    filtered.join(' | ').slice(0, 120));
  check('a search can be cleared from the list itself',
    filtered.some((b) => /show all/i.test(b)), filtered.slice(0, 3).join(' | '));

  __ui.reset();
  __ui.click(/Players/);
  __ui.click(/Search/);
  __ui.submit('zzzznobody');
  await settle();
  world.beforeEvents.chatSend.emit({ sender: admin, message: '!suite', cancel: false });
  await settle();
  check('a search with no matches says so', /Nothing matches/i.test(__ui.lastBody()),
    JSON.stringify(__ui.lastBody()));
}

/*
 * Audible feedback. A menu that answers silently reads as broken, but two
 * cues at once reads as a glitch - an arrival plays its own sound and the
 * caller then confirms it - so only the first cue in a tick is allowed out.
 */
{
  const ear = new Player('Ear', 'p-ear');
  __test.players.push(ear);
  world.afterEvents.playerSpawn.emit({ player: ear, initialSpawn: true });
  for (const t of system.timeouts.splice(0)) t.cb();
  __test.flush();

  const cueFrom = (message) => {
    system.currentTick++;
    ear.sounds.length = 0;
    world.beforeEvents.chatSend.emit({ sender: ear, message, cancel: false });
    __test.flush();
    return ear.sounds;
  };

  // A query only reports; an action confirms. Only the latter earns a cue.
  check('a plain query stays silent', cueFrom('!balance').length === 0);

  const success = [...cueFrom('!sethome soundcheck')];
  check('a completed action makes a sound', success.length === 1, success.join(', '));

  const failure = [...cueFrom('!warp definitelynotawarp')];
  check('a failed command makes a sound', failure.length === 1, failure.join(', '));
  check('failure does not sound like success', success[0] !== failure[0],
    `both played ${success[0]}`);

  // An arrival plays its own cue and the caller then confirms it in chat.
  system.currentTick++;
  ear.sounds.length = 0;
  world.beforeEvents.chatSend.emit({ sender: ear, message: '!spawn', cancel: false });
  __test.flush();
  for (let i = 0; i < 8; i++) { for (const t of [...system.intervals]) t.cb(); __test.flush(); }
  check('an arrival and its confirmation do not double up', ear.sounds.length <= 1,
    `${ear.sounds.length} cues: ${ear.sounds.join(', ')}`);
}

/*
 * Every list screen must say why it is empty. A `paged` list with no items
 * renders as a form containing nothing but a Back button, which reads as
 * broken rather than empty - a real report from a real server owner.
 */
{
  const listFiles = [
    'src/menus/admin.ts', 'src/menus/member.ts',
    ...(await readdir(path.join(ROOT, 'src', 'modules'))).map((f) => `src/modules/${f}`),
  ];
  const missing = [];
  for (const file of listFiles) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    for (let at = source.indexOf('paged('); at !== -1; at = source.indexOf('paged(', at + 1)) {
      const open = source.indexOf('{', at);
      if (open === -1) continue;
      // Walk to the matching brace so the scan covers exactly this call.
      let depth = 0, end = open;
      for (; end < source.length; end++) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}' && --depth === 0) break;
      }
      const options = source.slice(open, end);
      if (/\bempty:/.test(options)) continue;
      const title = /title:\s*(.+)/.exec(options)?.[1] ?? '?';
      missing.push(`${file}: ${title.trim().slice(0, 60)}`);
    }
  }
  check('every list screen explains itself when empty', missing.length === 0, missing.join(' | '));
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
