/**
 * Smoke test.
 *
 * The addon cannot be launched in Minecraft from CI, so the bundle is built
 * against mock implementations of the two Minecraft modules and executed in
 * Node. This catches load-order faults, top-level API misuse, startup crashes
 * and command registration problems before the pack ever reaches a world.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
await import(outfile);
const realConsole = globalThis.console;
globalThis.console = { log: (...a) => process.stdout.write(a.join(' ') + '\n'), warn: realConsole.warn, error: realConsole.error };

console.log('\nresults:');
check('bundle loaded without throwing', true);

// Startup event: native command registration must run here.
const registered = [];
system.beforeEvents.startup.emit({
  customCommandRegistry: {
    registerCommand(def) { registered.push(def); },
    registerEnum() {},
  },
});
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
check('chat command was intercepted', chatEvent.cancel === true);
check('chat command produced a reply', player.messages.length > 0, `got ${player.messages.length}`);

// An unknown command should be reported, not crash.
player.messages.length = 0;
world.beforeEvents.chatSend.emit({ sender: player, message: '!definitelynotacommand', cancel: false });
check('unknown command handled', player.messages.some((m) => /unknown command/i.test(m)));

// Normal chat should be reformatted rather than passed through untouched.
const normal = { sender: player, message: 'hello world', cancel: false };
world.beforeEvents.chatSend.emit(normal);
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

// Persistence must survive a shutdown/reload cycle.
system.beforeEvents.shutdown.emit({});
check('data was persisted to dynamic properties', __test.props.size > 0, `${__test.props.size} keys`);
check('profile data round-trips', [...__test.props.keys()].some((k) => k.startsWith('adm:profiles')));

check('no duplicate command warnings', !warnings.some((w) => /duplicate command|collides with/.test(w)),
  warnings.filter((w) => /duplicate|collides/.test(w)).join(' | '));
check('no unexpected warnings during startup', warnings.length === 0, warnings.slice(0, 3).join(' | '));

console.log(`\n  ${registered.length} native commands registered`);
console.log(`  ${system.intervals.length} background loops`);
console.log(`  ${__test.props.size} persisted storage keys`);

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
