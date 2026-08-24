import { Player } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { StoredLocation, onlinePlayer, profileOf, profiles } from '../core/profiles';
import { can } from '../core/permissions';
import { C, err, formatVec, ok, stripColor, tell, uid } from '../core/util';
import { gate, goTo, locationOf, warmup } from './teleport';
import { claimAt, mayBuild } from './land';
import { charge, money } from './economy';

/**
 * Player warps.
 *
 * Distinct from both homes and server warps: a home is private to one player,
 * a server warp is public but only staff may create one, and a player warp is
 * public and anyone may create one. They live in their own table and their own
 * menu so the public server destinations staff curate are never mixed up with
 * whatever players have published.
 */

export interface PlayerWarp extends StoredLocation {
  id: string;
  /** Display name, unique across all player warps, case-insensitively. */
  name: string;
  ownerId: string;
  ownerName: string;
  description: string;
  createdAt: number;
  visits: number;
}

export const playerWarps = new Table<PlayerWarp>('adm:pwarps');

export function playerWarpsEnabled(): boolean {
  return cfg().playerWarpsEnabled;
}

export function warpsOwnedBy(ownerId: string): PlayerWarp[] {
  return playerWarps.values().filter((warp) => warp.ownerId === ownerId);
}

export function findPlayerWarp(name: string): PlayerWarp | undefined {
  const needle = name.trim().toLowerCase();
  return playerWarps.values().find((warp) => warp.name.toLowerCase() === needle);
}

/** Player warps sorted by how often they are visited, most popular first. */
export function popularWarps(): PlayerWarp[] {
  return playerWarps.values().sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
}

export function warpLimit(player: Player): number {
  return can(player, 'tp.pwarp.admin') ? 999 : cfg().playerWarpLimit;
}

/**
 * Publishes a warp at the player's position.
 * Returns an error string, or undefined on success.
 */
export function createPlayerWarp(player: Player, rawName: string, description: string): string | undefined {
  const config = cfg();
  if (!config.playerWarpsEnabled) return 'Player warps are turned off on this server.';

  const name = stripColor(rawName).trim().replace(/\s+/g, ' ').slice(0, 24);
  if (name.length < 2) return 'Give the warp a name of at least two characters.';
  if (findPlayerWarp(name)) return `There is already a player warp called "${name}".`;

  const mine = warpsOwnedBy(player.id);
  if (mine.length >= warpLimit(player)) {
    return `You can only have ${warpLimit(player)} player warps. Delete one first.`;
  }

  /*
   * A warp published inside someone else's claim would hand every player a
   * doorway into their base, so it is only allowed where the creator could
   * build anyway.
   */
  const claim = claimAt(player.dimension.id, player.location);
  if (claim && !mayBuild(player, claim)) {
    return `You cannot publish a warp inside ${claim.ownerName}'s land.`;
  }

  const profile = profileOf(player);
  if (config.playerWarpCost > 0 && !charge(profile, config.playerWarpCost)) {
    return `Publishing a warp costs ${money(config.playerWarpCost)}.`;
  }

  const id = `pw_${uid()}`;
  playerWarps.set(id, {
    id,
    name,
    ownerId: player.id,
    ownerName: player.name,
    description: stripColor(description).trim().slice(0, 60),
    createdAt: Date.now(),
    visits: 0,
    ...locationOf(player),
  });
  return undefined;
}

/** Removes a warp. Staff may remove anyone's; players only their own. */
export function removePlayerWarp(player: Player, warp: PlayerWarp): string | undefined {
  const isOwner = warp.ownerId === player.id;
  if (!isOwner && !can(player, 'tp.pwarp.admin')) return 'That is not your warp.';
  playerWarps.delete(warp.id);

  if (!isOwner) {
    const owner = profiles.get(warp.ownerId);
    const online = owner ? onlinePlayer(owner) : undefined;
    if (online) tell(online, `${C.warn}Your player warp "${warp.name}" was removed by staff.`);
  }
  return undefined;
}

/** Travels to a player warp, counting the visit. */
export async function visitPlayerWarp(player: Player, warp: PlayerWarp): Promise<void> {
  if (!playerWarpsEnabled()) return err(player, 'Player warps are turned off on this server.');

  const profile = profileOf(player);
  if (!gate(player, profile, 'pwarp', cfg().warpCooldownSeconds)) return;
  if (!(await warmup(player))) return;

  if (goTo(player, warp)) {
    warp.visits++;
    playerWarps.markDirty();
    ok(player, `Warped to ${warp.name} (by ${warp.ownerName}).`);
  }
}

export function install(): void {
  register({
    name: 'pwarp',
    aliases: ['playerwarp'],
    description: 'Travel to a player warp, or list them all.',
    category: 'Teleport',
    permission: 'tp.pwarp',
    greedy: true,
    args: [{ name: 'name', type: 'string', optional: true }],
    handler: async ({ player, args }) => {
      if (!playerWarpsEnabled()) return err(player, 'Player warps are turned off on this server.');

      if (!args[0]) {
        const all = popularWarps();
        if (all.length === 0) return tell(player, `${C.dim}Nobody has published a player warp yet.`);
        tell(player, `${C.title}Player warps (${all.length})`);
        for (const warp of all) {
          player.sendMessage(
            `  ${C.accent}${warp.name} ${C.dim}by ${warp.ownerName}${warp.description ? ` - ${warp.description}` : ''} (${warp.visits} visits)`,
          );
        }
        player.sendMessage(`${C.dim}Use !pwarp <name> to travel there.`);
        return;
      }
      const warp = findPlayerWarp(args[0]);
      if (!warp) return err(player, `No player warp called "${args[0]}".`);
      await visitPlayerWarp(player, warp);
    },
  });

  register({
    name: 'setpwarp',
    description: 'Publish a player warp where you are standing.',
    category: 'Teleport',
    permission: 'tp.pwarp.create',
    greedy: true,
    args: [
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const problem = createPlayerWarp(player, args[0] ?? '', args[1] ?? '');
      if (problem) return err(player, problem);
      ok(player, `Published "${args[0]}". Anyone can now use !pwarp ${args[0]}.`);
    },
  });

  register({
    name: 'delpwarp',
    description: 'Remove one of your player warps.',
    category: 'Teleport',
    permission: 'tp.pwarp.create',
    greedy: true,
    args: [{ name: 'name', type: 'string' }],
    handler: ({ player, args }) => {
      const warp = findPlayerWarp(args[0] ?? '');
      if (!warp) return err(player, `No player warp called "${args[0]}".`);
      const problem = removePlayerWarp(player, warp);
      if (problem) return err(player, problem);
      ok(player, `Removed "${warp.name}".`);
    },
  });

  register({
    name: 'mypwarps',
    description: 'List the player warps you have published.',
    category: 'Teleport',
    permission: 'tp.pwarp.create',
    handler: ({ player }) => {
      const mine = warpsOwnedBy(player.id);
      if (mine.length === 0) return tell(player, `${C.dim}You have not published any warps.`);
      tell(player, `${C.title}Your player warps ${C.dim}(${mine.length}/${warpLimit(player)})`);
      for (const warp of mine) {
        player.sendMessage(`  ${C.accent}${warp.name} ${C.dim}- ${formatVec(warp)}, ${warp.visits} visits`);
      }
    },
  });
}
