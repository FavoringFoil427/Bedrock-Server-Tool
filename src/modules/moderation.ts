import { InputPermissionCategory, Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { Profile, onlinePlayer, profileByName, profileOf, profiles } from '../core/profiles';
import { t } from '../core/i18n';
import {
  C,
  err,
  formatDuration,
  now,
  ok,
  overworld,
  runCommand,
  splitDurationReason,
  tell,
  uid,
} from '../core/util';
import { can } from '../core/permissions';

/** Bans, mutes, freezing, vanish, staff spy and the player report queue. */

export interface BanRecord {
  id: string;
  name: string;
  reason: string;
  by: string;
  at: number;
  /** Absent for a permanent ban. */
  until?: number;
}

export interface Report {
  id: string;
  reporter: string;
  target: string;
  reason: string;
  at: number;
  handled: boolean;
}

export const bans = new Table<BanRecord>('adm:bans');
export const reports = new Table<Report>('adm:reports');

/** Returns the active ban for a profile, clearing it if it has expired. */
export function activeBan(id: string): BanRecord | undefined {
  const record = bans.get(id);
  if (!record) return undefined;
  if (record.until !== undefined && record.until <= now()) {
    bans.delete(id);
    return undefined;
  }
  return record;
}

function banMessage(record: BanRecord): string {
  return record.until === undefined
    ? t('mod.banned', { reason: record.reason })
    : t('mod.bannedUntil', { until: formatDuration(record.until - now()), reason: record.reason });
}

/** Removes a player from the server; the API has no kick, so the command is used. */
export function kickPlayer(name: string, reason: string): void {
  runCommand(overworld(), `kick "${name}" ${reason}`);
}

export function banProfile(target: Profile, by: string, reason: string, durationMs?: number): void {
  const record: BanRecord = {
    id: target.id,
    name: target.name,
    reason: reason || 'No reason given',
    by,
    at: now(),
    ...(durationMs !== undefined ? { until: now() + durationMs } : {}),
  };
  bans.set(target.id, record);
  const online = onlinePlayer(target);
  if (online) kickPlayer(online.name, banMessage(record));
}

export function isMuted(profile: Profile): boolean {
  if (profile.muteUntil === undefined) return false;
  // 0 is stored for a permanent mute.
  if (profile.muteUntil === 0) return true;
  if (profile.muteUntil <= now()) {
    delete profile.muteUntil;
    delete profile.muteReason;
    profiles.markDirty();
    return false;
  }
  return true;
}

export function setFrozen(player: Player, frozen: boolean): void {
  const profile = profileOf(player);
  profile.frozen = frozen;
  profiles.markDirty();
  applyFreeze(player, frozen);
  tell(player, frozen ? `${C.bad}` + t('mod.frozen') : `${C.good}You are no longer frozen.`);
}

function applyFreeze(player: Player, frozen: boolean): void {
  try {
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, !frozen);
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Jump, !frozen);
  } catch (error) {
    console.warn(`[AdminSuite] could not toggle movement: ${error}`);
  }
}

export function setVanished(player: Player, vanished: boolean): void {
  const profile = profileOf(player);
  profile.vanished = vanished;
  profiles.markDirty();
  if (vanished) {
    player.addEffect('invisibility', 20_000_000, { amplifier: 1, showParticles: false });
    player.nameTag = '';
  } else {
    player.removeEffect('invisibility');
    player.nameTag = player.name;
  }
}

/** Sends a message to every staff member with the spy flag enabled. */
export function notifyStaff(message: string): void {
  for (const player of world.getAllPlayers()) {
    const profile = profileOf(player);
    if (profile.spy || can(player, 'mod.reports')) {
      player.sendMessage(`${C.gold}[Staff]${C.reset} ${message}`);
    }
  }
}

export function install(): void {
  register({
    name: 'kick',
    description: 'Remove a player from the server.',
    category: 'Moderation',
    permission: 'mod.kick',
    greedy: true,
    args: [
      { name: 'player', type: 'player' },
      { name: 'reason', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      const online = onlinePlayer(target);
      if (!online) return err(player, `${target.name} is not online.`);
      const reason = args[1] || 'No reason given';
      kickPlayer(online.name, reason);
      notifyStaff(`${player.name} kicked ${target.name}: ${reason}`);
    },
  });

  register({
    name: 'ban',
    description: 'Ban a player, optionally for a duration (30m, 2h, 7d).',
    category: 'Moderation',
    permission: 'mod.ban',
    greedy: true,
    args: [
      { name: 'player', type: 'player' },
      { name: 'duration', type: 'string', optional: true },
      { name: 'reason', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      if (target.id === player.id) return err(player, t('err.selfTarget'));

      const { duration, reason } = splitDurationReason(args[1], args[2]);
      banProfile(target, player.name, reason, duration);
      ok(player, `Banned ${target.name}${duration ? ` for ${formatDuration(duration)}` : ' permanently'}.`);
      notifyStaff(`${player.name} banned ${target.name}: ${reason}`);
    },
  });

  register({
    name: 'unban',
    description: 'Lift a ban.',
    category: 'Moderation',
    permission: 'mod.unban',
    args: [{ name: 'player', type: 'string' }],
    handler: ({ player, args }) => {
      const needle = (args[0] ?? '').toLowerCase();
      const record = bans.values().find((b) => b.name.toLowerCase() === needle);
      if (!record) return err(player, 'That player is not banned.');
      bans.delete(record.id);
      ok(player, `Unbanned ${record.name}.`);
    },
  });

  register({
    name: 'banlist',
    description: 'List active bans.',
    category: 'Moderation',
    permission: 'mod.ban',
    handler: ({ player }) => {
      const active = bans.values().filter((b) => activeBan(b.id));
      if (active.length === 0) return tell(player, `${C.dim}Nobody is banned.`);
      tell(player, `${C.title}Bans (${active.length})`);
      for (const record of active) {
        const span = record.until === undefined ? 'permanent' : formatDuration(record.until - now());
        player.sendMessage(`  ${C.bad}${record.name} ${C.dim}- ${span} - ${record.reason}`);
      }
    },
  });

  register({
    name: 'mute',
    description: 'Stop a player from chatting.',
    category: 'Moderation',
    permission: 'mod.mute',
    greedy: true,
    args: [
      { name: 'player', type: 'player' },
      { name: 'duration', type: 'string', optional: true },
      { name: 'reason', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      const { duration, reason } = splitDurationReason(args[1], args[2]);
      target.muteUntil = duration === undefined ? 0 : now() + duration;
      target.muteReason = reason;
      profiles.markDirty();
      ok(player, `Muted ${target.name}${duration ? ` for ${formatDuration(duration)}` : ' permanently'}.`);
      const online = onlinePlayer(target);
      if (online) tell(online, `${C.bad}` + t('mod.muted'));
    },
  });

  register({
    name: 'unmute',
    description: 'Allow a muted player to chat again.',
    category: 'Moderation',
    permission: 'mod.mute',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      delete target.muteUntil;
      delete target.muteReason;
      profiles.markDirty();
      ok(player, `Unmuted ${target.name}.`);
    },
  });

  register({
    name: 'freeze',
    description: 'Freeze or unfreeze a player in place.',
    category: 'Moderation',
    permission: 'mod.freeze',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      const online = onlinePlayer(target);
      if (!online) return err(player, `${target.name} is not online.`);
      setFrozen(online, !target.frozen);
      ok(player, `${target.name} is now ${target.frozen ? 'frozen' : 'unfrozen'}.`);
    },
  });

  register({
    name: 'vanish',
    description: 'Toggle invisibility for staff.',
    category: 'Moderation',
    permission: 'mod.vanish',
    handler: ({ player }) => {
      const profile = profileOf(player);
      setVanished(player, !profile.vanished);
      ok(player, profile.vanished ? 'You are now vanished.' : 'You are visible again.');
    },
  });

  register({
    name: 'spy',
    description: 'Toggle staff notifications.',
    category: 'Moderation',
    permission: 'mod.spy',
    handler: ({ player }) => {
      const profile = profileOf(player);
      profile.spy = !profile.spy;
      profiles.markDirty();
      ok(player, profile.spy ? 'Staff spy enabled.' : 'Staff spy disabled.');
    },
  });

  register({
    name: 'report',
    description: 'Report a player to staff.',
    category: 'Social',
    greedy: true,
    args: [
      { name: 'player', type: 'player' },
      { name: 'reason', type: 'string' },
    ],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      if (target.id === player.id) return err(player, t('err.selfTarget'));
      const id = uid();
      reports.set(id, {
        id,
        reporter: player.name,
        target: target.name,
        reason: args[1] ?? 'No reason given',
        at: now(),
        handled: false,
      });
      ok(player, 'Report submitted. Thank you.');
      notifyStaff(`${player.name} reported ${target.name}: ${args[1]}`);
    },
  });

  register({
    name: 'reports',
    description: 'List open player reports.',
    category: 'Moderation',
    permission: 'mod.reports',
    handler: ({ player }) => {
      const open = reports.values().filter((r) => !r.handled);
      if (open.length === 0) return tell(player, `${C.dim}No open reports.`);
      tell(player, `${C.title}Open reports (${open.length})`);
      for (const report of open) {
        player.sendMessage(`  ${C.warn}${report.target} ${C.dim}by ${report.reporter} - ${report.reason}`);
      }
    },
  });

  /* Enforcement -------------------------------------------------------- */

  // Bans and freezes are re-applied when a player joins.
  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    const player = event.player;
    const profile = profileOf(player);

    const ban = activeBan(profile.id);
    if (ban) {
      kickPlayer(player.name, banMessage(ban));
      return;
    }
    if (profile.frozen) applyFreeze(player, true);
    if (profile.vanished) setVanished(player, true);
  });

  // A frozen player who somehow moves is pulled back to where they were.
  const anchors = new Map<string, { x: number; y: number; z: number }>();
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      const profile = profiles.get(player.id);
      if (!profile?.frozen) {
        anchors.delete(player.id);
        continue;
      }
      const anchor = anchors.get(player.id);
      if (!anchor) {
        anchors.set(player.id, { ...player.location });
        continue;
      }
      const moved =
        Math.abs(player.location.x - anchor.x) > 0.6 ||
        Math.abs(player.location.y - anchor.y) > 0.6 ||
        Math.abs(player.location.z - anchor.z) > 0.6;
      if (moved) player.teleport(anchor);
      player.onScreenDisplay.setActionBar(`${C.bad}You are frozen`);
    }
  }, 10);
}
