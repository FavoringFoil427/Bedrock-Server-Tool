import { Block, Dimension, GameMode, ItemStack, Player, Vector3, system, world } from '@minecraft/server';
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

export type ViolationKind =
  | 'bundle_exploit'
  | 'container_item'
  | 'illegal_item'
  | 'overstack'
  | 'banned_block'
  | 'protected_break'
  | 'piston_dupe'
  | 'minecart_dupe'
  | 'portal_dupe';

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

/**
 * Records a violation, tells staff, and escalates once the threshold is hit.
 *
 * `escalate` is false for heuristics - patterns that merely look like an
 * exploit. Those are worth telling staff about but must never push somebody
 * toward an automatic ban on their own.
 */
export function flag(
  player: Player,
  kind: ViolationKind,
  detail: string,
  action: string,
  escalate = true,
): void {
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
  if (escalate) {
    profile.acViolations = (profile.acViolations ?? 0) + 1;
    profiles.markDirty();
  }

  const config = cfg();
  if (config.anticheatAlertStaff) {
    const tally = escalate ? `, ${profile.acViolations} total` : ', not counted';
    notifyStaff(`${C.bad}[AC]${C.reset} ${player.name}: ${detail} ${C.dim}(${action}${tally})`);
  }

  const threshold = config.anticheatBanThreshold;
  if (escalate && threshold > 0 && (profile.acViolations ?? 0) >= threshold) {
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

/* ---------------------------------------------------- duplication vectors */

/** Containers whose block entity can be duplicated by a piston push. */
function isDupeContainer(typeId: string): boolean {
  return (
    typeId.endsWith('shulker_box') ||
    typeId === 'minecraft:chest' ||
    typeId === 'minecraft:trapped_chest' ||
    typeId === 'minecraft:barrel'
  );
}

function isPiston(typeId: string): boolean {
  return typeId === 'minecraft:piston' || typeId === 'minecraft:sticky_piston';
}

/** facing_direction, as either the legacy integer or the newer string trait. */
const FACING_BY_INDEX: Vector3[] = [
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
];
const FACING_BY_NAME: Record<string, Vector3> = {
  down: FACING_BY_INDEX[0],
  up: FACING_BY_INDEX[1],
  north: FACING_BY_INDEX[2],
  south: FACING_BY_INDEX[3],
  west: FACING_BY_INDEX[4],
  east: FACING_BY_INDEX[5],
};

/** Which way a piston pushes, or undefined when the state cannot be read. */
function pistonFacing(block: Block): Vector3 | undefined {
  try {
    const states = block.permutation.getAllStates();
    const index = states['facing_direction'];
    if (typeof index === 'number' && FACING_BY_INDEX[index]) return FACING_BY_INDEX[index];
    const named = states['minecraft:facing_direction'];
    if (typeof named === 'string' && FACING_BY_NAME[named]) return FACING_BY_NAME[named];
  } catch {
    // Older blocks may not expose the state at all.
  }
  return undefined;
}

/**
 * Breaks a piston dupe setup by popping the *piston*, returned as an item.
 *
 * Never the container or its contents: a false positive should cost at most one
 * piston, not somebody's shulker box full of gear.
 */
function neutralisePiston(block: Block, containerName: string, culprit: Player | undefined): void {
  const dimension = block.dimension;
  const location = { x: block.location.x, y: block.location.y, z: block.location.z };
  const pistonType = block.typeId;

  try {
    dimension.setBlockType(location, 'minecraft:air');
    dimension.spawnItem(new ItemStack(pistonType, 1), {
      x: location.x + 0.5,
      y: location.y + 0.5,
      z: location.z + 0.5,
    });
  } catch (error) {
    console.warn(`[AdminSuite] could not neutralise a piston setup: ${error}`);
    return;
  }

  const where = formatVec(location);
  if (culprit) {
    flag(culprit, 'piston_dupe', `piston aimed at a ${containerName} at ${where}`, 'piston removed');
  } else {
    notifyStaff(`${C.bad}[AC]${C.reset} A piston ${containerName} dupe setup was removed at ${where}.`);
  }
  for (const nearby of dimension.getPlayers({ location, maxDistance: 16 })) {
    try {
      nearby.playSound('note.bass', { pitch: 0.5, volume: 1 });
    } catch {
      // Sound is a courtesy, never a reason to fail.
    }
  }
}

/** True when any of the six neighbours of a position is a shulker box. */
function hasAdjacentShulker(dimension: Dimension, at: Vector3): boolean {
  for (const offset of FACING_BY_INDEX) {
    try {
      const neighbour = dimension.getBlock({ x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z });
      if (neighbour?.typeId.endsWith('shulker_box')) return true;
    } catch {
      // Unloaded neighbour; nothing to judge.
    }
  }
  return false;
}

/** Blocks a piston physically cannot push past; stop tracing the line here. */
function stopsPistonPush(typeId: string): boolean {
  return (
    typeId === 'minecraft:air' ||
    typeId === 'minecraft:obsidian' ||
    typeId === 'minecraft:bedrock' ||
    typeId === 'minecraft:barrier' ||
    isPiston(typeId)
  );
}

/**
 * Sweep-time piston check.
 *
 * Reading a piston's facing proved unreliable across versions, so adjacency
 * comes first: a shulker box touching a piston on any side is virtually never a
 * real build. The push line is then traced as a bonus, which catches a
 * container sitting behind a pushed block, or one further down the line.
 *
 * The sweep cannot attribute a setup to whoever built it, so it removes and
 * alerts without counting toward anybody's ban. Attribution happens at
 * placement time instead.
 */
function checkPistonSetup(piston: Block, dimension: Dimension): void {
  const at = piston.location;
  if (hasAdjacentShulker(dimension, at)) {
    neutralisePiston(piston, 'shulker_box', undefined);
    return;
  }

  const facing = pistonFacing(piston);
  if (!facing) return;

  for (let step = 1; step <= 12; step++) {
    const probe = { x: at.x + facing.x * step, y: at.y + facing.y * step, z: at.z + facing.z * step };
    let block;
    try {
      block = dimension.getBlock(probe);
    } catch {
      return;
    }
    if (!block) return;

    if (isDupeContainer(block.typeId)) {
      neutralisePiston(piston, block.typeId.replace('minecraft:', ''), undefined);
      return;
    }
    if (hasAdjacentShulker(dimension, probe)) {
      neutralisePiston(piston, 'shulker_box', undefined);
      return;
    }
    if (stopsPistonPush(block.typeId)) return;
  }
}

/** Containers a bundle or shulker exploit can be funnelled through. */
function isFunnelContainer(typeId: string): boolean {
  return typeId === 'minecraft:hopper' || typeId === 'minecraft:dispenser' || typeId === 'minecraft:dropper';
}

/**
 * Containers worth sweeping for illegal items. The ender chest is excluded
 * deliberately: its contents are per-player and not really "there", so touching
 * it would delete items belonging to someone who is not present.
 */
function isScannableContainer(typeId: string): boolean {
  if (typeId === 'minecraft:ender_chest') return false;
  if (typeId.endsWith('shulker_box')) return true;
  return (
    typeId === 'minecraft:chest' ||
    typeId === 'minecraft:trapped_chest' ||
    typeId === 'minecraft:barrel' ||
    isFunnelContainer(typeId)
  );
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

  /*
   * Piston duplication, caught at build time where it can be attributed.
   * Both orders are covered: a piston placed facing a container, and a
   * container placed in front of a piston that is already there.
   */
  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const config = cfg();
    if (!config.anticheatEnabled || !config.anticheatPistonDupe) return;
    const player = event.player;
    if (exemptFromAnticheat(player)) return;

    const block = event.block;
    const dimension = block.dimension;
    const origin = block.location;

    if (isPiston(block.typeId)) {
      /*
       * Facing tells us the intended push, but the glitch has several
       * geometric variants. A shulker box touching a piston on any side is
       * virtually never a real build, so that alone is enough.
       */
      if (hasAdjacentShulker(dimension, origin)) {
        system.run(() => neutralisePiston(block, 'shulker_box', player));
        return;
      }
      const facing = pistonFacing(block);
      if (!facing) return;
      const front = dimension.getBlock({
        x: origin.x + facing.x,
        y: origin.y + facing.y,
        z: origin.z + facing.z,
      });
      if (front && isDupeContainer(front.typeId)) {
        const name = front.typeId.replace('minecraft:', '');
        system.run(() => neutralisePiston(block, name, player));
      }
      return;
    }

    if (!isDupeContainer(block.typeId)) return;
    // A container just went down: pop any piston already aimed at this spot.
    for (const offset of FACING_BY_INDEX) {
      const neighbourAt = { x: origin.x - offset.x, y: origin.y - offset.y, z: origin.z - offset.z };
      let neighbour;
      try {
        neighbour = dimension.getBlock(neighbourAt);
      } catch {
        continue;
      }
      if (!neighbour || !isPiston(neighbour.typeId)) continue;
      const facing = pistonFacing(neighbour);
      if (!facing || facing.x !== offset.x || facing.y !== offset.y || facing.z !== offset.z) continue;
      const name = block.typeId.replace('minecraft:', '');
      system.run(() => neutralisePiston(neighbour, name, player));
      return;
    }
  });

  /*
   * Minecart chest duplication: the same chest minecart removed twice in quick
   * succession at one spot. This is a pattern rather than proof, so it alerts
   * staff without counting toward an automatic ban.
   *
   * The removal is read from the *before* event because the after event
   * carries only an id and a type - there is no location on it to work from,
   * and the entity is already gone by then.
   */
  const recentMinecartRemovals = new Map<string, number>();
  world.beforeEvents.entityRemove.subscribe((event) => {
    const config = cfg();
    if (!config.anticheatEnabled || !config.anticheatMinecartDupe) return;

    const entity = event.removedEntity;
    if (!entity?.typeId.includes('chest_minecart')) return;

    const at = entity.location;
    const dimension = entity.dimension;
    const key = `${dimension.id}:${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`;
    const seenAt = recentMinecartRemovals.get(key);
    const stamp = Date.now();

    if (seenAt !== undefined && stamp - seenAt < 3000) {
      const location = { x: at.x, y: at.y, z: at.z };
      system.run(() => {
        for (const nearby of dimension.getPlayers({ location, maxDistance: 8 })) {
          if (exemptFromAnticheat(nearby)) continue;
          flag(nearby, 'minecart_dupe', `possible minecart chest dupe at ${formatVec(location)}`, 'logged only', false);
        }
      });
    }
    recentMinecartRemovals.set(key, stamp);
    system.runTimeout(() => recentMinecartRemovals.delete(key), 100);
  });

  /*
   * Nether portal duplication: a container tossed as an item into a portal and
   * force-quit through copies itself. The force-quit is invisible to scripts,
   * so the vector is denied instead - a container item sitting in portal blocks
   * is removed before it can transfer. Containers are essentially never thrown
   * through portals in normal play, since you carry them.
   */
  system.runInterval(() => {
    const config = cfg();
    if (!config.anticheatEnabled || !config.anticheatPortalDupe) return;

    for (const player of world.getAllPlayers()) {
      const dimension = player.dimension;
      let items;
      try {
        items = dimension.getEntities({ type: 'minecraft:item', location: player.location, maxDistance: 16 });
      } catch {
        continue;
      }
      for (const entity of items) {
        try {
          const stack = entity.getComponent('minecraft:item')?.itemStack;
          if (!stack || !isDupeContainer(stack.typeId)) continue;
          const block = dimension.getBlock(entity.location);
          if (block?.typeId !== 'minecraft:portal') continue;

          const where = formatVec(entity.location);
          const name = stack.typeId.replace('minecraft:', '');
          entity.remove();
          notifyStaff(`${C.bad}[AC]${C.reset} A ${name} nether portal dupe was blocked at ${where}.`);
        } catch {
          // The item may already be gone; nothing to do.
        }
      }
    }
  }, 5);

  /*
   * One cube sweep per player serving three checks at once: piston setups,
   * bundle and shulker exploits being funnelled through hoppers, and illegal
   * items stashed in nearby containers. Doing them together means each block is
   * fetched once rather than three times over separate intervals, which is what
   * makes a radius-6 sweep affordable at this cadence.
   */
  system.runInterval(() => {
    const config = cfg();
    if (!config.anticheatEnabled || !config.anticheatNearbyScan) return;

    const radius = config.anticheatScanRadius;
    const illegal = new Set(config.anticheatIllegalItems);

    for (const player of world.getAllPlayers()) {
      if (exemptFromAnticheat(player)) continue;
      const dimension = player.dimension;
      const origin = {
        x: Math.floor(player.location.x),
        y: Math.floor(player.location.y),
        z: Math.floor(player.location.z),
      };

      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            let block;
            try {
              block = dimension.getBlock({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz });
            } catch {
              continue;
            }
            if (!block) continue;
            const typeId = block.typeId;

            if (config.anticheatPistonDupe && isPiston(typeId)) {
              checkPistonSetup(block, dimension);
              continue;
            }

            const sweepFunnel = config.anticheatBundleExploit && isFunnelContainer(typeId);
            const sweepItems = config.anticheatContainerScan && isScannableContainer(typeId);
            if (!sweepFunnel && !sweepItems) continue;

            const container = block.getComponent('minecraft:inventory')?.container;
            if (!container) continue;

            for (let slot = 0; slot < container.size; slot++) {
              const item = container.getItem(slot);
              if (!item) continue;

              /*
               * A bundle or shulker inside a hopper, dispenser or dropper is
               * the funnel half of a storage duplication exploit; neither has
               * any legitimate reason to be piped through one.
               */
              if (sweepFunnel && (item.typeId.includes('bundle') || item.typeId.includes('shulker_box'))) {
                container.setItem(slot, undefined);
                flag(
                  player,
                  'bundle_exploit',
                  `${prettyItemName(item.typeId)} funnelled through a ${typeId.replace('minecraft:', '')} at ${formatVec(block.location)}`,
                  'item removed',
                );
                break;
              }

              if (sweepItems && illegal.has(item.typeId)) {
                container.setItem(slot, undefined);
                flag(
                  player,
                  'container_item',
                  `${prettyItemName(item.typeId)} stashed in a container at ${formatVec(block.location)}`,
                  'item removed',
                  false,
                );
              }
            }
          }
        }
      }
    }
  }, 10);

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
