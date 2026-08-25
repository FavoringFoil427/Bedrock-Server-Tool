import { Player, world } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { Profile, onlinePlayer, profileByName, profileOf, profiles } from '../core/profiles';
import { C, broadcast, err, formatDuration, ok, tell } from '../core/util';
import { sfx } from '../core/sound';
import { balanceOf, charge, money } from './economy';

/**
 * Progression ranks.
 *
 * Ranks form an ordered ladder separate from staff roles: roles grant
 * permissions, ranks are the visible progression players climb. A rank is
 * reached either by meeting its requirement automatically or, when it carries
 * a price, by buying it from the rank shop.
 */

export type RequirementKind = 'none' | 'xp' | 'playtime' | 'balance' | 'kills' | 'blocks';

export interface Rank {
  id: string;
  name: string;
  prefix: string;
  color: string;
  /** Position in the ladder; lower comes first. */
  order: number;
  requirement: RequirementKind;
  requirementValue: number;
  /** When above zero the rank can be purchased from the rank shop. */
  cost: number;
}

export const ranks = new Table<Rank>('adm:ranks');

export function ensureDefaultRanks(): void {
  if (ranks.size > 0) return;
  const seed: Rank[] = [
    { id: 'novice', name: 'Novice', prefix: '§8[Novice]', color: '§8', order: 0, requirement: 'none', requirementValue: 0, cost: 0 },
    { id: 'apprentice', name: 'Apprentice', prefix: '§7[Apprentice]', color: '§7', order: 1, requirement: 'playtime', requirementValue: 60, cost: 0 },
    { id: 'adventurer', name: 'Adventurer', prefix: '§a[Adventurer]', color: '§a', order: 2, requirement: 'playtime', requirementValue: 300, cost: 0 },
    { id: 'veteran', name: 'Veteran', prefix: '§b[Veteran]', color: '§b', order: 3, requirement: 'playtime', requirementValue: 1200, cost: 0 },
    { id: 'elite', name: 'Elite', prefix: '§d[Elite]', color: '§d', order: 4, requirement: 'balance', requirementValue: 50_000, cost: 0 },
    { id: 'legend', name: 'Legend', prefix: '§6[Legend]', color: '§6', order: 5, requirement: 'none', requirementValue: 0, cost: 250_000 },
  ];
  for (const rank of seed) ranks.set(rank.id, rank);
}

/** The ladder in ascending order. */
export function ladder(): Rank[] {
  return ranks.values().sort((a, b) => a.order - b.order);
}

export function rankOf(profile: Profile): Rank | undefined {
  const list = ladder();
  if (list.length === 0) return undefined;
  return list[Math.min(profile.rankIndex, list.length - 1)];
}

function progressValue(profile: Profile, kind: RequirementKind): number {
  switch (kind) {
    case 'xp':
      return profile.xp;
    case 'playtime':
      return Math.floor(profile.playtimeMs / 60_000);
    case 'balance':
      return balanceOf(profile);
    case 'kills':
      return profile.stats.kills;
    case 'blocks':
      return profile.stats.blocksMined;
    default:
      return 0;
  }
}

export function describeRequirement(rank: Rank): string {
  switch (rank.requirement) {
    case 'playtime':
      return `${rank.requirementValue} minutes played`;
    case 'xp':
      return `${rank.requirementValue} XP`;
    case 'balance':
      return `${money(rank.requirementValue)} earned`;
    case 'kills':
      return `${rank.requirementValue} kills`;
    case 'blocks':
      return `${rank.requirementValue} blocks mined`;
    default:
      return rank.cost > 0 ? `Purchase for ${money(rank.cost)}` : 'No requirement';
  }
}

/**
 * Promotes a player as far up the ladder as their progress allows.
 * Ranks that must be bought stop the automatic climb.
 */
export function checkPromotion(profile: Profile): Rank | undefined {
  const list = ladder();
  let promoted: Rank | undefined;
  while (profile.rankIndex < list.length - 1) {
    const next = list[profile.rankIndex + 1];
    if (next.cost > 0) break;
    if (next.requirement === 'none') break;
    if (progressValue(profile, next.requirement) < next.requirementValue) break;
    profile.rankIndex++;
    promoted = next;
  }
  if (promoted) profiles.markDirty();
  return promoted;
}

/** Runs a promotion check and announces the result. */
export function checkAndAnnounce(player: Player): void {
  const profile = profileOf(player);
  const promoted = checkPromotion(profile);
  if (promoted) {
    broadcast(`${C.gold}${player.name} ${C.reset}reached ${promoted.color}${promoted.name}${C.reset}!`);
    sfx(player, 'triumph');
  }
}

/** Deferred setup. Runs on the first tick, when world state is reachable. */
export function init(): void {
  ensureDefaultRanks();
}

export function install(): void {

  register({
    name: 'rank',
    description: 'Show your rank and what comes next.',
    category: 'Progression',
    handler: ({ player }) => {
      const profile = profileOf(player);
      const current = rankOf(profile);
      const list = ladder();
      tell(player, `${C.title}Your rank`);
      player.sendMessage(`  Current: ${current ? current.color + current.name : 'None'}`);
      const next = list[profile.rankIndex + 1];
      if (!next) {
        player.sendMessage(`  ${C.dim}You are at the top of the ladder.`);
        return;
      }
      const have = progressValue(profile, next.requirement);
      player.sendMessage(`  Next: ${next.color}${next.name} ${C.dim}- ${describeRequirement(next)}`);
      if (next.requirement !== 'none') {
        player.sendMessage(`  ${C.dim}Progress: ${have}/${next.requirementValue}`);
      }
    },
  });

  register({
    name: 'ranks',
    description: 'List the rank ladder.',
    category: 'Progression',
    handler: ({ player }) => {
      const profile = profileOf(player);
      tell(player, `${C.title}Rank ladder`);
      ladder().forEach((rank, index) => {
        const marker = index === profile.rankIndex ? `${C.good} <- you` : '';
        player.sendMessage(`  ${rank.color}${rank.name} ${C.dim}- ${describeRequirement(rank)}${marker}`);
      });
    },
  });

  register({
    name: 'buyrank',
    description: 'Buy the next rank if it is purchasable.',
    category: 'Progression',
    handler: ({ player }) => {
      const profile = profileOf(player);
      const list = ladder();
      const next = list[profile.rankIndex + 1];
      if (!next) return err(player, 'You are already at the top rank.');
      if (next.cost <= 0) return err(player, `${next.name} cannot be bought - ${describeRequirement(next)}.`);
      if (!charge(profile, next.cost)) return err(player, `You need ${money(next.cost)}.`);
      profile.rankIndex++;
      profiles.markDirty();
      broadcast(`${C.gold}${player.name} ${C.reset}bought the rank ${next.color}${next.name}${C.reset}!`);
    },
  });

  register({
    name: 'setrank',
    description: 'Admin: set a player\'s rank.',
    category: 'Progression',
    permission: 'ranks.admin',
    args: [
      { name: 'player', type: 'player' },
      { name: 'rank', type: 'string' },
    ],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, 'Player not found.');
      const list = ladder();
      const index = list.findIndex((r) => r.id.toLowerCase() === (args[1] ?? '').toLowerCase());
      if (index === -1) return err(player, `No rank called "${args[1]}".`);
      target.rankIndex = index;
      profiles.markDirty();
      ok(player, `${target.name} is now ${list[index].name}.`);
      const online = onlinePlayer(target);
      if (online) tell(online, `${C.good}Your rank is now ${list[index].color}${list[index].name}.`);
    },
  });

  register({
    name: 'playtime',
    description: 'Show how long you have played.',
    category: 'General',
    args: [{ name: 'player', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      const target = args[0] ? profileByName(args[0]) : profileOf(player);
      if (!target) return err(player, 'Player not found.');
      tell(player, `${C.accent}${target.name}${C.reset} has played for ${C.good}${formatDuration(target.playtimeMs)}`);
    },
  });

  // Re-check promotions periodically so playtime and balance ranks land.
  world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) checkAndAnnounce(event.player);
  });
}
