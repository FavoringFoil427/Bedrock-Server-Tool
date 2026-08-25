import { Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import {
  Profile,
  StoredLocation,
  cooldownLeft,
  onlinePlayer,
  profileByName,
  profileOf,
  profiles,
  setCooldown,
} from '../core/profiles';
import { Table } from '../core/storage';
import { t } from '../core/i18n';
import { C, distance, err, formatDuration, formatVec, ok, tell } from '../core/util';
import { sfx } from '../core/sound';
import { can } from '../core/permissions';
import { charge, money } from './economy';
import { blockedByCombat } from './combat';
import { isFrozen } from './moderation';

/**
 * Movement systems: homes, warps, player-to-player requests, random teleport
 * and the death/teleport return point.
 */

export interface Warp extends StoredLocation {
  id: string;
  name: string;
  icon?: string;
  permission?: string;
  cost: number;
}

export const warps = new Table<Warp>('adm:warps');

/** Where `!back` returns each player to; cleared once used. */
const backPoints = new Map<string, StoredLocation>();

export function rememberBack(player: Player): void {
  backPoints.set(player.id, locationOf(player));
}

export function locationOf(player: Player): StoredLocation {
  const { x, y, z } = player.location;
  return { x, y, z, dimension: player.dimension.id };
}

/** Teleports a player to a stored location, resolving the dimension by id. */
export function goTo(player: Player, target: StoredLocation): boolean {
  try {
    const dimension = world.getDimension(target.dimension);
    rememberBack(player);
    player.teleport({ x: target.x, y: target.y, z: target.z }, { dimension });
    sfx(player, 'travel');
    return true;
  } catch (error) {
    console.warn(`[AdminSuite] teleport failed: ${error}`);
    return false;
  }
}

/**
 * Runs the configured warmup, cancelling if the player moves. Resolves true
 * when the teleport should proceed.
 */
export function warmup(player: Player): Promise<boolean> {
  /*
   * Every teleport funnels through here, so the gates live here too.
   *
   * Freezing somebody is pointless if they can simply !home out of it, and
   * unlike the combat gate this one has no bypass: staff freeze people
   * precisely so they cannot leave.
   */
  if (isFrozen(player)) {
    err(player, 'You are frozen and cannot teleport.');
    return Promise.resolve(false);
  }
  if (blockedByCombat(player)) return Promise.resolve(false);

  const seconds = cfg().tpaWarmupSeconds;
  if (seconds <= 0 || can(player, 'bypass.cooldown')) return Promise.resolve(true);

  const start = player.location;
  tell(player, t('tpa.warmup', { seconds }));
  return new Promise((resolve) => {
    let elapsed = 0;
    const handle = system.runInterval(() => {
      if (!player.isValid) {
        system.clearRun(handle);
        return resolve(false);
      }
      if (distance(player.location, start) > 1.5) {
        system.clearRun(handle);
        tell(player, `${C.bad}` + t('tpa.cancelled'));
        return resolve(false);
      }
      elapsed += 1;
      if (elapsed >= seconds) {
        system.clearRun(handle);
        resolve(true);
      }
    }, 20);
  });
}

/** Applies a cooldown gate, messaging the player when they must wait. */
export function gate(player: Player, profile: Profile, key: string, seconds: number): boolean {
  if (can(player, 'bypass.cooldown')) return true;
  const left = cooldownLeft(profile, key);
  if (left > 0) {
    err(player, t('err.cooldown', { time: formatDuration(left) }));
    return false;
  }
  setCooldown(profile, key, seconds);
  return true;
}

/**
 * Travels to one of the player's homes, applying the warmup and every gate.
 * Returns an error string, or undefined on success.
 */
export async function travelHome(player: Player, name: string): Promise<string | undefined> {
  const profile = profileOf(player);
  const key = (name || 'home').toLowerCase();
  const target = profile.homes[key];
  if (!target) return t('home.missing', { name: key });
  if (!(await warmup(player))) return undefined;
  return goTo(player, target) ? undefined : 'The teleport failed.';
}

/**
 * Travels to a server warp, charging its cost and applying the cooldown.
 * Returns an error string, or undefined on success.
 */
export async function travelToWarp(player: Player, warp: Warp): Promise<string | undefined> {
  if (warp.permission && !can(player, warp.permission)) return t('err.noPermission');

  const profile = profileOf(player);
  if (!gate(player, profile, 'warp', cfg().warpCooldownSeconds)) return undefined;

  if (warp.cost > 0 && !charge(profile, warp.cost)) return `That warp costs ${money(warp.cost)}.`;
  if (!(await warmup(player))) return undefined;
  return goTo(player, warp) ? undefined : 'The teleport failed.';
}

/* ------------------------------------------------------------------ homes */

export function homeLimit(player: Player): number {
  return can(player, 'bypass.cooldown') ? 99 : cfg().homeLimitDefault;
}

function installHomes(): void {
  register({
    name: 'sethome',
    description: 'Save your current position as a home.',
    category: 'Teleport',
    permission: 'tp.home',
    args: [{ name: 'name', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      const profile = profileOf(player);
      const name = (args[0] || 'home').toLowerCase();
      const existing = profile.homes[name] !== undefined;
      if (!existing && Object.keys(profile.homes).length >= homeLimit(player)) {
        return err(player, t('home.limit', { limit: homeLimit(player) }));
      }
      profile.homes[name] = locationOf(player);
      profiles.markDirty();
      ok(player, t('home.set', { name }));
    },
  });

  register({
    name: 'home',
    description: 'Teleport to one of your homes.',
    category: 'Teleport',
    permission: 'tp.home',
    args: [{ name: 'name', type: 'string', optional: true }],
    handler: async ({ player, args }) => {
      const name = (args[0] || 'home').toLowerCase();
      const problem = await travelHome(player, name);
      if (problem) return err(player, problem);
      ok(player, `Welcome home (${name}).`);
    },
  });

  register({
    name: 'delhome',
    description: 'Delete one of your homes.',
    category: 'Teleport',
    permission: 'tp.home',
    args: [{ name: 'name', type: 'string' }],
    handler: ({ player, args }) => {
      const profile = profileOf(player);
      const name = (args[0] ?? '').toLowerCase();
      if (!profile.homes[name]) return err(player, t('home.missing', { name }));
      delete profile.homes[name];
      profiles.markDirty();
      ok(player, t('home.deleted', { name }));
    },
  });

  register({
    name: 'homes',
    description: 'List your saved homes.',
    category: 'Teleport',
    permission: 'tp.home',
    handler: ({ player }) => {
      const profile = profileOf(player);
      const names = Object.keys(profile.homes);
      if (names.length === 0) return tell(player, `${C.dim}You have no homes yet.`);
      tell(player, `${C.title}Your homes ${C.dim}(${names.length}/${homeLimit(player)})`);
      for (const name of names) {
        const home = profile.homes[name];
        player.sendMessage(`  ${C.accent}${name} ${C.dim}- ${formatVec(home)} (${home.dimension.replace('minecraft:', '')})`);
      }
    },
  });
}

/* ------------------------------------------------------------------ warps */

/**
 * Creates or replaces a server warp where the player is standing. Shared by
 * `!setwarp` and the admin menu's create button so the two cannot drift apart.
 * Returns a problem string, or the warp and whether it replaced an older one.
 */
export function createWarp(
  player: Player,
  name: string,
  cost: number,
): string | { warp: Warp; replaced: boolean } {
  const clean = name.trim();
  if (clean.length === 0) return 'A warp needs a name.';
  if (clean.length > 24) return 'That name is too long - 24 characters at most.';

  // Names are matched case-insensitively, so the lowercased name is the id.
  const id = clean.toLowerCase();
  const replaced = warps.has(id);
  const warp: Warp = {
    id,
    name: clean,
    cost: Math.max(0, Math.floor(cost) || 0),
    ...locationOf(player),
  };
  warps.set(id, warp);
  return { warp, replaced };
}

function installWarps(): void {
  register({
    name: 'warp',
    description: 'Teleport to a server warp.',
    category: 'Teleport',
    permission: 'tp.warp',
    args: [{ name: 'name', type: 'string', optional: true }],
    handler: async ({ player, args }) => {
      const all = warps.values();
      if (!args[0]) {
        if (all.length === 0) return tell(player, `${C.dim}No warps have been created.`);
        tell(player, `${C.title}Warps`);
        for (const warp of all) {
          player.sendMessage(`  ${C.accent}${warp.name}${warp.cost > 0 ? ` ${C.dim}(${cfg().currencySymbol}${warp.cost})` : ''}`);
        }
        return;
      }
      const needle = args[0].toLowerCase();
      const warp = all.find((w) => w.name.toLowerCase() === needle);
      if (!warp) return err(player, `No warp called "${args[0]}".`);
      const problem = await travelToWarp(player, warp);
      if (problem) return err(player, problem);
      ok(player, `Warped to ${warp.name}.`);
    },
  });

  register({
    name: 'setwarp',
    description: 'Admin: create a warp at your position.',
    category: 'Teleport',
    permission: 'tp.warp.admin',
    args: [
      { name: 'name', type: 'string' },
      { name: 'cost', type: 'int', optional: true },
    ],
    handler: ({ player, args }) => {
      const result = createWarp(player, args[0] ?? '', Number.parseInt(args[1] ?? '0', 10) || 0);
      if (typeof result === 'string') return err(player, result);
      ok(player, `Warp "${result.warp.name}" ${result.replaced ? 'moved here' : 'saved'}.`);
    },
  });

  register({
    name: 'delwarp',
    description: 'Admin: delete a warp.',
    category: 'Teleport',
    permission: 'tp.warp.admin',
    args: [{ name: 'name', type: 'string' }],
    handler: ({ player, args }) => {
      const id = (args[0] ?? '').toLowerCase();
      if (!warps.delete(id)) return err(player, `No warp called "${args[0]}".`);
      ok(player, t('ok.deleted'));
    },
  });
}

/* -------------------------------------------------------------------- tpa */

interface TeleportRequest {
  fromId: string;
  toId: string;
  /** `here` asks the target to come to the sender instead. */
  here: boolean;
  expires: number;
}

const requests = new Map<string, TeleportRequest>();

/** Sends a teleport request. `here` asks the target to come to the sender. */
export function sendTeleportRequest(from: Player, to: Player, here: boolean): string | undefined {
  if (to.id === from.id) return 'You cannot teleport to yourself.';
  requests.set(to.id, {
    fromId: from.id,
    toId: to.id,
    here,
    expires: Date.now() + cfg().tpaTimeoutSeconds * 1000,
  });
  tell(
    to,
    here
      ? `${from.name} wants you to teleport to them. Use ${cfg().commandPrefix}tpaccept or ${cfg().commandPrefix}tpdeny.`
      : t('tpa.received', { player: from.name, prefix: cfg().commandPrefix }),
  );
  return undefined;
}

/** True when this player has a request waiting on them. */
export function hasPendingRequest(playerId: string): boolean {
  return pendingFor(playerId) !== undefined;
}

/** Accepts the pending request, performing the teleport. */
export async function acceptTeleportRequest(player: Player): Promise<string | undefined> {
  const request = pendingFor(player.id);
  if (!request) return t('tpa.none');
  requests.delete(player.id);

  const sender = world.getAllPlayers().find((p) => p.id === request.fromId);
  if (!sender) return 'That player is no longer online.';

  const mover = request.here ? player : sender;
  const anchor = request.here ? sender : player;
  if (!(await warmup(mover))) return undefined;

  if (goTo(mover, locationOf(anchor))) {
    tell(sender, t('tpa.accepted'));
    return undefined;
  }
  return 'The teleport failed.';
}

/** Declines the pending request. */
export function denyTeleportRequest(player: Player): string | undefined {
  const request = pendingFor(player.id);
  if (!request) return t('tpa.none');
  requests.delete(player.id);
  const sender = world.getAllPlayers().find((p) => p.id === request.fromId);
  if (sender) tell(sender, `${C.warn}${player.name} denied your teleport request.`);
  return undefined;
}

function pendingFor(targetId: string): TeleportRequest | undefined {
  const request = requests.get(targetId);
  if (!request) return undefined;
  if (request.expires < Date.now()) {
    requests.delete(targetId);
    return undefined;
  }
  return request;
}

function installTpa(): void {
  const send = (here: boolean) => async ({ player, args }: { player: Player; args: string[] }) => {
    const target = profileByName(args[0] ?? '');
    if (!target) return err(player, t('err.playerNotFound'));
    if (target.id === player.id) return err(player, t('err.selfTarget'));
    const online = onlinePlayer(target);
    if (!online) return err(player, `${target.name} is not online.`);

    const problem = sendTeleportRequest(player, online, here);
    if (problem) return err(player, problem);
    ok(player, t('tpa.sent', { player: target.name }));
  };

  register({
    name: 'tpa',
    description: 'Ask to teleport to a player.',
    category: 'Teleport',
    permission: 'tp.tpa',
    args: [{ name: 'player', type: 'player' }],
    handler: send(false),
  });

  register({
    name: 'tpahere',
    description: 'Ask a player to teleport to you.',
    category: 'Teleport',
    permission: 'tp.tpa',
    args: [{ name: 'player', type: 'player' }],
    handler: send(true),
  });

  register({
    name: 'tpaccept',
    description: 'Accept a pending teleport request.',
    category: 'Teleport',
    permission: 'tp.tpa',
    handler: async ({ player }) => {
      const request = pendingFor(player.id);
      if (!request) return err(player, t('tpa.none'));
      requests.delete(player.id);

      const sender = world.getAllPlayers().find((p) => p.id === request.fromId);
      if (!sender) return err(player, 'That player is no longer online.');

      // `here` moves the accepting player; otherwise the sender travels.
      const mover = request.here ? player : sender;
      const anchor = request.here ? sender : player;
      if (!(await warmup(mover))) return;

      if (goTo(mover, locationOf(anchor))) {
        ok(player, t('tpa.accepted'));
        tell(sender, t('tpa.accepted'));
      }
    },
  });

  register({
    name: 'tpdeny',
    description: 'Deny a pending teleport request.',
    category: 'Teleport',
    permission: 'tp.tpa',
    handler: ({ player }) => {
      const request = pendingFor(player.id);
      if (!request) return err(player, t('tpa.none'));
      requests.delete(player.id);
      ok(player, t('tpa.denied'));
      const sender = world.getAllPlayers().find((p) => p.id === request.fromId);
      if (sender) tell(sender, `${C.warn}${player.name} denied your teleport request.`);
    },
  });
}

/* -------------------------------------------------------------- rtp / back */

/**
 * Drops the player at a random surface position.
 *
 * The destination chunk is almost never loaded when the roll happens, so the
 * player is placed high above the target first; once the terrain streams in the
 * topmost block is resolvable and they are settled onto it.
 */
export async function randomTeleport(player: Player): Promise<boolean> {
  const config = cfg();
  const angle = Math.random() * Math.PI * 2;
  const radius = config.rtpMinRadius + Math.random() * Math.max(1, config.rtpMaxRadius - config.rtpMinRadius);
  const x = Math.round(Math.cos(angle) * radius);
  const z = Math.round(Math.sin(angle) * radius);
  const dimension = player.dimension;

  rememberBack(player);
  // The Nether has a bedrock ceiling, so aim below it rather than at build height.
  const highY = dimension.id === 'minecraft:nether' ? 100 : 300;
  player.teleport({ x: x + 0.5, y: highY, z: z + 0.5 }, { dimension });

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => system.runTimeout(resolve, 5));
    if (!player.isValid) return false;
    let surface;
    try {
      surface = dimension.getTopmostBlock({ x, z });
    } catch {
      surface = undefined;
    }
    if (surface) {
      player.teleport({ x: x + 0.5, y: surface.location.y + 1, z: z + 0.5 }, { dimension });
      return true;
    }
  }
  // Terrain never resolved; leave them safely where they are.
  return false;
}

/** Returns a player to where they last were. Undefined on success. */
export async function goBack(player: Player): Promise<string | undefined> {
  const target = backPoints.get(player.id);
  if (!target) return 'You have nowhere to go back to.';
  if (!(await warmup(player))) return undefined;

  // Capture where they are first, so `back` toggles between the two points.
  const current = locationOf(player);
  if (!goTo(player, target)) return 'The teleport failed.';
  backPoints.set(player.id, current);
  return undefined;
}

/** Sends a player to the world spawn. Undefined on success. */
export async function goToSpawn(player: Player): Promise<string | undefined> {
  if (!(await warmup(player))) return undefined;
  const spawn = world.getDefaultSpawnLocation();
  // A y above the build limit means "use the surface"; resolve it.
  const y =
    spawn.y > 30000
      ? (world.getDimension('overworld').getTopmostBlock({ x: spawn.x, z: spawn.z })?.location.y ?? 64) + 1
      : spawn.y;
  return goTo(player, { x: spawn.x, y, z: spawn.z, dimension: 'minecraft:overworld' })
    ? undefined
    : 'The teleport failed.';
}

function installRtpAndBack(): void {
  register({
    name: 'rtp',
    aliases: ['wild'],
    description: 'Teleport to a random location in the wild.',
    category: 'Teleport',
    permission: 'tp.rtp',
    handler: async ({ player }) => {
      const profile = profileOf(player);
      if (!gate(player, profile, 'rtp', cfg().rtpCooldownSeconds)) return;
      tell(player, `${C.dim}Finding somewhere to drop you...`);
      if (await randomTeleport(player)) ok(player, 'Teleported to the wild.');
      else err(player, 'Could not find a safe spot. Try again.');
    },
  });

  register({
    name: 'back',
    description: 'Return to your previous location.',
    category: 'Teleport',
    permission: 'tp.back',
    handler: async ({ player }) => {
      const problem = await goBack(player);
      if (problem) return err(player, problem);
      ok(player, 'Returned to your previous location.');
    },
  });

  register({
    name: 'spawn',
    description: 'Teleport to the world spawn.',
    category: 'Teleport',
    permission: 'tp.warp',
    handler: async ({ player }) => {
      const problem = await goToSpawn(player);
      if (problem) return err(player, problem);
      ok(player, 'Teleported to spawn.');
    },
  });
}

export function install(): void {
  installHomes();
  installWarps();
  installTpa();
  installRtpAndBack();

  // Dying should leave a return point.
  world.afterEvents.entityDie.subscribe((event) => {
    const entity = event.deadEntity;
    if (entity instanceof Player) backPoints.set(entity.id, locationOf(entity));
  });
}
