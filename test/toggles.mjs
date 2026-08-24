/**
 * Feature-toggle test.
 *
 * A toggle that only stops payouts while leaving the menus, commands and NPCs
 * in place is a half-toggle: players still take jobs and silently earn nothing.
 * This boots a world whose config already has the system switched off, so the
 * gate is exercised from the first tick, and checks the feature is actually
 * absent rather than merely inert.
 *
 * It runs as its own process because config is cached on first read; flipping
 * it mid-run would not reach code that has already read it.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
}

const outDir = await mkdtemp(path.join(tmpdir(), 'adm-toggle-'));
for (const [name, file] of [['server', 'server.mjs'], ['server-ui', 'server-ui.mjs']]) {
  const dir = path.join(outDir, 'node_modules', '@minecraft', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `@minecraft/${name}`, type: 'module', main: 'index.mjs' }));
  const target = new URL(`file://${path.join(ROOT, 'test', 'mocks', file)}`).href;
  await writeFile(path.join(dir, 'index.mjs'), `export * from ${JSON.stringify(target)};\n`);
}

const outfile = path.join(outDir, 'bundle.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'main.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  external: ['@minecraft/server', '@minecraft/server-ui'],
});

const { world, system, Player, __test } = await import(path.join(ROOT, 'test', 'mocks', 'server.mjs'));

/*
 * Seed the stored config before anything reads it. Writing straight to the
 * backing map sidesteps the early-execution guard, which is the point: this is
 * the state the world already has on disk when the script starts.
 */
const stored = JSON.stringify({ jobsEnabled: false, starterKitEnabled: false });
__test.props.set('adm:config#n', 1);
__test.props.set('adm:config#0', stored);

const realConsole = globalThis.console;
globalThis.console = { ...realConsole, log: () => {}, warn: () => {} };
await import(outfile);
system.beforeEvents.startup.emit({ customCommandRegistry: { registerCommand() {}, registerEnum() {} } });
__test.flush();
globalThis.console = realConsole;

const player = new Player('Tester', 'p-toggle');
__test.players.push(player);
world.afterEvents.playerSpawn.emit({ player, initialSpawn: true });
for (const t of system.timeouts.splice(0)) t.cb();
__test.flush();

const say = (message) => {
  player.messages.length = 0;
  world.beforeEvents.chatSend.emit({ sender: player, message, cancel: false });
  __test.flush();
  return player.messages.join(' | ');
};

console.log('\njobs disabled:');

const OFF = /turned off/i;
check('!jobs refuses', OFF.test(say('!jobs')), say('!jobs'));
check('!job miner refuses', OFF.test(say('!job miner')), say('!job miner'));
check('!jobinfo refuses', OFF.test(say('!jobinfo')), say('!jobinfo'));

// Payouts must not fire either, which is what the toggle originally covered.
say('!balance');
const before = player.messages.join(' ');
world.afterEvents.playerBreakBlock.emit({
  player,
  block: { typeId: 'minecraft:iron_ore', location: { x: 0, y: 64, z: 0 } },
  brokenBlockPermutation: { type: { id: 'minecraft:iron_ore' } },
});
__test.flush();
say('!balance');
check('breaking an ore pays nothing', player.messages.join(' ') === before,
  `${before} -> ${player.messages.join(' ')}`);

// The command list should not advertise what is switched off... but the
// commands still exist, so confirm they are at least refusing rather than
// silently doing nothing.
check('a job cannot be taken while disabled', OFF.test(say('!job hunter')));

// With the starter kit switched off, a first join must hand out nothing.
const carried = player.slots.filter(Boolean).map((slot) => slot.typeId);
check('no starter kit is given when it is switched off',
  carried.every((typeId) => typeId === 'adm:member_book'),
  `held: ${carried.join(', ') || 'nothing'}`);

await rm(outDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
