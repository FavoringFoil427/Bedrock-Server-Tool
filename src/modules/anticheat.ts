import { GameMode, Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { profileOf, profiles } from '../core/profiles';
import { can } from '../core/permissions';
import { inventoryOf, prettyItemName } from '../core/items';
import { C, err, formatVec, now, ok, tell, uid } from '../core/util';
import { banProfile, notifyStaff } from './moderation';

/**
 * Anticheat: illegal items, duplication signatures and protected blocks.
 *
 * The philosophy here is that detection is cheap and reversible while
 * punishment is not. Every check removes the offending item or blocks the
 * action, records what happened, and tells staff; banning only happens once a
 * player crosses a threshold that the server sets, and never on a single hit.
 * That keeps a false positive from turning into a wrongly banned player.
 *
 * Staff are exempt throughout: an admin holding a command block in creative is
 * doing their job, not cheating.
 */

export type ViolationKind = 'illegal_item' | 'overstack' | 'banned_block' | 'protected_break';

export interface Violation {
  id: string;
  at: number;
  playerId: string;
  playerName: string;
  kind: ViolationKind;
  detail: string;
  action: string;
}

/** Rolling log, newest last. Capped so it can never grow without bound. */
export const violations = new Table<Violation>('adm:violations');

const LOG_CAP = 200;

/** True when this player is outside the anticheat's remit. */
export function exemptFromAnticheat(player: Player): boolean {
  if (can(player, 'bypass.anticheat') || can(player, 'mod.ban')) return true;
  // Creative and spectator are staff modes; policing them creates noise.
  const mode = player.getGameMode();
  return mode === GameMode.Creative || mode === GameMode.Spectator;
}

/** Records a violation, tells staff, and escalates once the threshold is hit. */
export function flag(player: Player, kind: ViolationKind, detail: string, action: string): void {
  const id = uid();
  violations.set(id, {
    id,
    at: now(),
    playerId: player.id,
    playerName: player.name,
    kind,
    detail,
    action,
  });

  // Trim oldest first so the log stays bounded.
  const all = violations.values().sort((a, b) => a.at - b.at);
  for (const old of all.slice(0, Math.max(0, all.length - LOG_CAP))) violations.delete(old.id);

  const profile = profileOf(player);
  profile.acViolations = (profile.acViolations ?? 0) + 1;
  profiles.markDirty();

  const config = cfg();
  if (config.anticheatAlertStaff) {
    notifyStaff(`${C.bad}[AC]${C.reset} ${player.name}: ${detail} ${C.dim}(${action}, ${profile.acViolations} total)`);
  }

  const threshold = config.anticheatBanThreshold;
  if (threshold > 0 && profile.acViolations >= threshold) {
    banProfile(profile, 'Anticheat', `Automatic: ${threshold} anticheat violations`);
    notifyStaff(`${C.bad}[AC] ${player.name} was banned automatically after ${profile.acViolations} violations.`);
  }
}

/* ------------------------------------------------------------ item checks */

/**
 * Sweeps a player's inventory for items that should not exist.
 *
 * A stack larger than the item's own maximum is the clearest duplication
 * signature there is: no legitimate route produces 128 diamond blocks in one
 * slot, so it is treated as proof rather than suspicion.
 */
export function scanInventory(player: Player): number {
  const config = cfg();
  if (!config.anticheatEnabled || exemptFromAnticheat(player)) return 0;

  const container = inventoryOf(player);
  if (!container) return 0;

  const illegal = new Set(config.anticheatIllegalItems);
  let found = 0;

  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;

    if (illegal.has(item.typeId)) {
      container.setItem(slot, undefined);
      found++;
      flag(player, 'illegal_item', `held ${item.amount}x ${prettyItemName(item.typeId)}`, 'item removed');
      continue;
    }

    if (config.anticheatCheckOverstacks && item.amount > item.maxAmount) {
      const excess = item.amount;
      container.setItem(slot, undefined);
      found++;
      flag(
        player,
        'overstack',
        `stack of ${excess}x ${prettyItemName(item.typeId)} (max ${item.maxAmount})`,
        'stack removed',
      );
    }
  }
  return found;
}

export function install(): void {
  register({
    name: 'ac',
    aliases: ['anticheat'],
    description: 'Show anticheat status.',
    category: 'Moderation',
    permission: 'mod.reports',
    handler: ({ player }) => {
      const config = cfg();
      tell(player, `${C.title}Anticheat`);
      player.sendMessage(`  ${C.dim}Status: ${config.anticheatEnabled ? `${C.good}on` : `${C.bad}off`}`);
      player.sendMessage(`  ${C.dim}Illegal items watched: ${C.white}${config.anticheatIllegalItems.length}`);
      player.sendMessage(`  ${C.dim}Banned blocks: ${C.white}${config.anticheatBannedBlocks.length}`);
      player.sendMessage(`  ${C.dim}Overstack detection: ${config.anticheatCheckOverstacks ? 'on' : 'off'}`);
      player.sendMessage(`  ${C.dim}Auto ban at: ${C.white}${config.anticheatBanThreshold || 'never'}`);
      player.sendMessage(`  ${C.dim}Logged violations: ${C.white}${violations.size}`);
    },
  });

  register({
    name: 'aclog',
    description: 'Show recent anticheat detections.',
    category: 'Moderation',
    permission: 'mod.reports',
    handler: ({ player }) => {
      const recent = violations.values().sort((a, b) => b.at - a.at).slice(0, 15);
      if (recent.length === 0) return tell(player, `${C.dim}No detections logged.`);
      tell(player, `${C.title}Recent detections`);
      for (const entry of recent) {
        player.sendMessage(`  ${C.bad}${entry.playerName} ${C.dim}- ${entry.detail} (${entry.action})`);
      }
    },
  });

  register({
    name: 'accheck',
    description: 'Scan a player\'s inventory now.',
    category: 'Moderation',
    permission: 'mod.reports',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const needle = (args[0] ?? '').toLowerCase();
      const target = world.getAllPlayers().find((p) => p.name.toLowerCase() === needle);
      if (!target) return err(player, 'That player is not online.');
      const found = scanInventory(target);
      ok(player, found === 0 ? `${target.name} is clean.` : `Removed ${found} illegal item(s) from ${target.name}.`);
    },
  });

  register({
    name: 'acclear',
    description: 'Clear the anticheat log and violation counts.',
    category: 'Moderation',
    permission: 'server.data',
    handler: ({ player }) => {
      violations.clear();
      for (const profile of profiles.values()) delete profile.acViolations;
      profiles.markDirty();
      ok(player, 'Anticheat log and violation counts cleared.');
    },
  });

  /* Enforcement ---------------------------------------------------------- */

  // Placing a banned block is undone rather than merely logged.
  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const config = cfg();
    if (!config.anticheatEnabled) return;
    const player = event.player;
    if (exemptFromAnticheat(player)) return;

    const typeId = event.block.typeId;
    if (!config.anticheatBannedBlocks.includes(typeId)) return;

    try {
      event.block.setType('minecraft:air');
    } catch (error) {
      console.warn(`[AdminSuite] could not remove a banned block: ${error}`);
    }
    flag(player, 'banned_block', `placed ${prettyItemName(typeId)} at ${formatVec(event.block.location)}`, 'block removed');
  });

  // Breaking a protected block is stopped before it happens.
  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const config = cfg();
    if (!config.anticheatEnabled) return;
    const player = event.player;
    if (exemptFromAnticheat(player)) return;

    const typeId = event.block.typeId;
    if (!config.anticheatProtectedBlocks.includes(typeId)) return;

    event.cancel = true;
    const name = prettyItemName(typeId);
    const location = formatVec(event.block.location);
    system.run(() => {
      player.onScreenDisplay.setActionBar(`${C.bad}You cannot break that`);
      flag(player, 'protected_break', `tried to break ${name} at ${location}`, 'blocked');
    });
  });

  // Joining players are swept, which catches anything carried in from elsewhere.
  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn || !cfg().anticheatEnabled) return;
    const player = event.player;
    system.runTimeout(() => {
      if (player.isValid) scanInventory(player);
    }, 60);
  });

  // Periodic sweep, staggered so a full server never scans everyone at once.
  let cursor = 0;
  system.runInterval(() => {
    const config = cfg();
    if (!config.anticheatEnabled || config.anticheatScanSeconds <= 0) return;
    const players = world.getAllPlayers();
    if (players.length === 0) return;
    cursor = (cursor + 1) % players.length;
    scanInventory(players[cursor]);
  }, 40);
}
