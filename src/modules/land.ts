import { Player, Vector3, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { profileByName, profileOf, profiles } from '../core/profiles';
import { bypasses, can } from '../core/permissions';
import { t } from '../core/i18n';
import { C, err, ok, tell, uid } from '../core/util';

/**
 * Land claims.
 *
 * A claim is an axis-aligned rectangle covering full world height. Protection
 * runs on every block and interaction event, so lookups are served from a
 * chunk index rather than by scanning every claim.
 */

export interface Claim {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  dimension: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Profile ids allowed to build inside. */
  members: string[];
  allowPvp: boolean;
  allowContainers: boolean;
}

export const claims = new Table<Claim>('adm:claims');

const CHUNK = 16;
/** chunk key -> claim ids overlapping that chunk. */
let index = new Map<string, string[]>();

function chunkKey(dimension: string, x: number, z: number): string {
  return `${dimension}:${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
}

/** Rebuilds the chunk index. Called on load and after any claim change. */
export function reindex(): void {
  index = new Map();
  for (const claim of claims.values()) {
    const cx0 = Math.floor(claim.minX / CHUNK);
    const cx1 = Math.floor(claim.maxX / CHUNK);
    const cz0 = Math.floor(claim.minZ / CHUNK);
    const cz1 = Math.floor(claim.maxZ / CHUNK);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = `${claim.dimension}:${cx},${cz}`;
        const list = index.get(key) ?? [];
        list.push(claim.id);
        index.set(key, list);
      }
    }
  }
}

export function claimAt(dimension: string, location: Vector3): Claim | undefined {
  const ids = index.get(chunkKey(dimension, location.x, location.z));
  if (!ids) return undefined;
  for (const id of ids) {
    const claim = claims.get(id);
    if (!claim) continue;
    if (
      location.x >= claim.minX &&
      location.x <= claim.maxX &&
      location.z >= claim.minZ &&
      location.z <= claim.maxZ
    ) {
      return claim;
    }
  }
  return undefined;
}

function overlaps(dimension: string, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  return claims
    .values()
    .some(
      (claim) =>
        claim.dimension === dimension &&
        minX <= claim.maxX &&
        maxX >= claim.minX &&
        minZ <= claim.maxZ &&
        maxZ >= claim.minZ,
    );
}

/** True when the player may build/interact inside `claim`. */
export function mayBuild(player: Player, claim: Claim): boolean {
  if (claim.ownerId === player.id) return true;
  if (claim.members.includes(player.id)) return true;
  return bypasses(player) || can(player, 'land.admin');
}

/** Blocks the action and messages the player when the spot is protected. */
function protect(player: Player, location: Vector3): boolean {
  if (!cfg().claimsEnabled) return false;
  const claim = claimAt(player.dimension.id, location);
  if (!claim || mayBuild(player, claim)) return false;
  player.onScreenDisplay.setActionBar(`${C.bad}` + t('land.protected', { owner: claim.ownerName }));
  return true;
}

/** Deferred setup. Runs on the first tick, when world state is reachable. */
export function init(): void {
  reindex();
}

/**
 * Claims land around a player. Returns an error string, or undefined on
 * success. Shared by the command and the menu so both enforce the same rules.
 */
export function claimLand(player: Player, requested: number): string | undefined {
  const config = cfg();
  if (!config.claimsEnabled) return 'Land claims are disabled.';

  const radius = Math.min(config.claimMaxRadius, Math.max(4, requested || 16));
  const size = (radius * 2 + 1) ** 2;
  const profile = profileOf(player);
  if (profile.claimBlocks < size) {
    return `You need ${size} claim blocks but have ${profile.claimBlocks}.`;
  }

  const { x, z } = player.location;
  const minX = Math.floor(x) - radius;
  const maxX = Math.floor(x) + radius;
  const minZ = Math.floor(z) - radius;
  const maxZ = Math.floor(z) + radius;

  if (overlaps(player.dimension.id, minX, minZ, maxX, maxZ)) return t('land.overlap');

  const id = uid();
  claims.set(id, {
    id,
    name: `${player.name}'s land`,
    ownerId: player.id,
    ownerName: player.name,
    dimension: player.dimension.id,
    minX,
    minZ,
    maxX,
    maxZ,
    members: [],
    allowPvp: false,
    allowContainers: false,
  });
  profile.claimBlocks -= size;
  profiles.markDirty();
  reindex();
  return undefined;
}

export function install(): void {

  register({
    name: 'claim',
    description: 'Claim the land around you.',
    category: 'Land',
    permission: 'land.claim',
    args: [{ name: 'radius', type: 'int', optional: true }],
    handler: ({ player, args }) => {
      const radius = Number.parseInt(args[0] ?? '16', 10) || 16;
      const problem = claimLand(player, radius);
      if (problem) return err(player, problem);
      const applied = Math.min(cfg().claimMaxRadius, Math.max(4, radius));
      ok(player, t('land.claimed', { size: (applied * 2 + 1) ** 2 }));
    },
  });

  register({
    name: 'unclaim',
    description: 'Remove the claim you are standing in.',
    category: 'Land',
    permission: 'land.claim',
    handler: ({ player }) => {
      const claim = claimAt(player.dimension.id, player.location);
      if (!claim) return err(player, 'You are not standing in a claim.');
      if (claim.ownerId !== player.id && !can(player, 'land.admin')) {
        return err(player, t('land.notOwner'));
      }
      const size = (claim.maxX - claim.minX + 1) * (claim.maxZ - claim.minZ + 1);
      const owner = profiles.get(claim.ownerId);
      if (owner) {
        owner.claimBlocks += size;
        profiles.markDirty();
      }
      claims.delete(claim.id);
      reindex();
      ok(player, 'Claim removed and blocks refunded.');
    },
  });

  register({
    name: 'trust',
    description: 'Allow a player to build in your claim.',
    category: 'Land',
    permission: 'land.claim',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const claim = claimAt(player.dimension.id, player.location);
      if (!claim) return err(player, 'You are not standing in a claim.');
      if (claim.ownerId !== player.id && !can(player, 'land.admin')) return err(player, t('land.notOwner'));
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      if (claim.members.includes(target.id)) return err(player, `${target.name} is already trusted.`);
      claim.members.push(target.id);
      claims.markDirty();
      ok(player, `${target.name} can now build here.`);
    },
  });

  register({
    name: 'untrust',
    description: 'Revoke build access in your claim.',
    category: 'Land',
    permission: 'land.claim',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const claim = claimAt(player.dimension.id, player.location);
      if (!claim) return err(player, 'You are not standing in a claim.');
      if (claim.ownerId !== player.id && !can(player, 'land.admin')) return err(player, t('land.notOwner'));
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      const at = claim.members.indexOf(target.id);
      if (at === -1) return err(player, `${target.name} is not trusted here.`);
      claim.members.splice(at, 1);
      claims.markDirty();
      ok(player, `${target.name} can no longer build here.`);
    },
  });

  register({
    name: 'claiminfo',
    description: 'Show details about the claim you are in.',
    category: 'Land',
    permission: 'land.claim',
    handler: ({ player }) => {
      const claim = claimAt(player.dimension.id, player.location);
      if (!claim) return tell(player, `${C.dim}This land is unclaimed.`);
      const members = claim.members
        .map((id) => profiles.get(id)?.name ?? 'unknown')
        .join(', ');
      tell(player, `${C.title}${claim.name}`);
      player.sendMessage(`  Owner: ${C.accent}${claim.ownerName}`);
      player.sendMessage(`  Area: ${claim.minX},${claim.minZ} to ${claim.maxX},${claim.maxZ}`);
      player.sendMessage(`  Trusted: ${members || `${C.dim}nobody`}`);
      player.sendMessage(`  PvP: ${claim.allowPvp ? 'on' : 'off'}  Containers: ${claim.allowContainers ? 'shared' : 'private'}`);
    },
  });

  register({
    name: 'claimblocks',
    description: 'Show how many claim blocks you have left.',
    category: 'Land',
    permission: 'land.claim',
    handler: ({ player }) => {
      tell(player, `You have ${C.good}${profileOf(player).claimBlocks}${C.reset} claim blocks.`);
    },
  });

  /* Protection --------------------------------------------------------- */

  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    if (protect(event.player, event.block.location)) event.cancel = true;
  });

  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const claim = cfg().claimsEnabled
      ? claimAt(event.player.dimension.id, event.block.location)
      : undefined;
    if (!claim || mayBuild(event.player, claim)) return;

    // Containers may be opened by anyone when the owner has shared them.
    const isContainer = /chest|barrel|furnace|hopper|shulker|dispenser|dropper|brewing/.test(
      event.block.typeId,
    );
    if (isContainer && claim.allowContainers) return;

    event.cancel = true;
    event.player.onScreenDisplay.setActionBar(
      `${C.bad}` + t('land.protected', { owner: claim.ownerName }),
    );
  });

  world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    if (protect(event.player, event.target.location)) event.cancel = true;
  });

  // PvP is off inside claims unless the owner turns it on.
  world.beforeEvents.entityHurt.subscribe((event) => {
    if (!cfg().claimsEnabled) return;
    const victim = event.hurtEntity;
    const attacker = event.damageSource.damagingEntity;
    if (!(victim instanceof Player) || !(attacker instanceof Player)) return;

    const claim = claimAt(victim.dimension.id, victim.location);
    if (!claim || claim.allowPvp) return;
    if (bypasses(attacker)) return;
    event.cancel = true;
    attacker.onScreenDisplay.setActionBar(`${C.bad}PvP is disabled in this claim`);
  });
}
