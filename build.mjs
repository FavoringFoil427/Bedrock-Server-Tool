#!/usr/bin/env node
/**
 * Build script: bundles the TypeScript sources into the behaviour pack and
 * assembles distributable pack folders (and optionally a .mcaddon archive).
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createZip } from './scripts/zip.mjs';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const pack = args.includes('--package');
// Chat interception (custom chat format, mute, `!` commands) needs the beta
// module. `--stable` builds a pack that loads without the Beta APIs toggle but
// with those chat features inert.
const stable = args.includes('--stable');
const SERVER_MODULE = stable ? '2.9.0' : '2.10.0-beta';

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

/** Keep the manifest version in sync with package.json. */
function semver(v) {
  return v.split('.').slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
}

async function stampManifest(file) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const version = semver(pkg.version);
  manifest.header.version = version;
  for (const mod of manifest.modules ?? []) mod.version = version;
  for (const dep of manifest.dependencies ?? []) {
    if (dep.module_name === '@minecraft/server') dep.version = SERVER_MODULE;
  }
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
}

async function assemble() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(path.join(ROOT, 'packs', 'BP'), path.join(DIST, 'BP'), { recursive: true });
  await cp(path.join(ROOT, 'packs', 'RP'), path.join(DIST, 'RP'), { recursive: true });
  await stampManifest(path.join(DIST, 'BP', 'manifest.json'));
  await stampManifest(path.join(DIST, 'RP', 'manifest.json'));
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(ROOT, 'src', 'main.ts')],
  outfile: path.join(DIST, 'BP', 'scripts', 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  legalComments: 'none',
  // The game supplies these at runtime; they must never be bundled.
  external: ['@minecraft/server', '@minecraft/server-ui', '@minecraft/server-net', '@minecraft/server-admin'],
  banner: { js: `// Admin Suite v${pkg.version} - built ${new Date().toISOString()}` },
};

/** Collects every file under `dir`, as zip entries rooted at `prefix`. */
async function collect(dir, prefix) {
  const entries = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) entries.push(...(await collect(full, name)));
    else entries.push({ name, data: await readFile(full) });
  }
  return entries;
}

async function archive() {
  const out = path.join(DIST, `AdminSuite-v${pkg.version}.mcaddon`);
  await rm(out, { force: true });
  // A .mcaddon is a plain zip holding both pack folders.
  const entries = [...(await collect(path.join(DIST, 'BP'), 'BP')), ...(await collect(path.join(DIST, 'RP'), 'RP'))];
  await writeFile(out, createZip(entries));
  console.log(`packaged -> ${path.relative(ROOT, out)} (${entries.length} files)`);
}

if (watch) {
  await assemble();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching for changes...');
} else {
  await assemble();
  await esbuild.build(options);
  console.log(`build ok -> dist/BP/scripts/main.js (@minecraft/server ${SERVER_MODULE})`);
  if (pack) await archive();
}
