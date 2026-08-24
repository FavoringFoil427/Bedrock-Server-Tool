import { Player, world, Vector3 } from '@minecraft/server';
import { Table } from './storage';
import { cfg } from './config';
import { now } from './util';

export interface StoredLocation extends Vector3 {
  dimension: string;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  blocksMined: number;
  blocksPlaced: number;
  mobKills: number;
}

/** The single per-player record every module reads from. */
export interface Profile {
  id: string;
  name: string;
  roles: string[];

  firstJoin: number;
  lastSeen: number;
  playtimeMs: number;

  balance: number;
  homes: Record<string, StoredLocation>;
  claimBlocks: number;

  rankIndex: number;
  xp: number;
  skills: Record<string, number>;

  jobId?: string;
  jobXp: number;

  clanId?: string;

  stats: PlayerStats;

  passwordHash?: string;
  loggedIn?: boolean;

  dailyLastClaim?: number;
  dailyStreak: number;
  kitsClaimed: Record<string, number>;
  redeemedCodes: string[];

  muteUntil?: number;
  muteReason?: string;
  frozen?: boolean;
  vanished?: boolean;
  spy?: boolean;
  /** Set when the player has opted out of duel challenges. */
  duelsOff?: boolean;
  /** Set once the member book has been handed out. */
  gotMemberBook?: boolean;

  /** Cosmetic ids the player has bought. */
  cosmeticsOwned?: string[];
  cosmeticEquipped?: string;

  /** Calendar day the block quota counters belong to. */
  quotaDay?: string;
  quotaMined?: number;
  quotaPlaced?: number;

  cooldowns: Record<string, number>;
  nameColor?: string;
}

export const profiles = new Table<Profile>('adm:profiles');

export function newProfile(id: string, name: string): Profile {
  const config = cfg();
  return {
    id,
    name,
    roles: [],
    firstJoin: now(),
    lastSeen: now(),
    playtimeMs: 0,
    balance: config.startingBalance,
    homes: {},
    claimBlocks: config.claimBlocksDefault,
    rankIndex: 0,
    xp: 0,
    skills: {},
    jobXp: 0,
    stats: { kills: 0, deaths: 0, blocksMined: 0, blocksPlaced: 0, mobKills: 0 },
    dailyStreak: 0,
    kitsClaimed: {},
    redeemedCodes: [],
    cooldowns: {},
  };
}

/** Returns the stored profile for a player, creating it on first join. */
export function profileOf(player: Player): Profile {
  let profile = profiles.get(player.id);
  if (!profile) {
    profile = newProfile(player.id, player.name);
    profiles.set(player.id, profile);
  } else if (profile.name !== player.name) {
    // Keep the cached display name in step with renames.
    profile.name = player.name;
    profiles.markDirty();
  }
  return profile;
}

/** Looks up a profile by name, including players who are currently offline. */
export function profileByName(name: string): Profile | undefined {
  const needle = name.toLowerCase();
  return (
    profiles.values().find((p) => p.name.toLowerCase() === needle) ??
    profiles.values().find((p) => p.name.toLowerCase().includes(needle))
  );
}

/**
 * Awards account XP, and matching vanilla experience so the number is actually
 * spendable at an enchanting table.
 *
 * The two are tracked separately on purpose. Account XP is a lifetime total
 * that only climbs and feeds rank progression; vanilla XP is a balance the
 * player spends. Sharing one number would mean enchanting a pickaxe undid
 * progress somebody had already earned.
 */
export function addXp(player: Player, amount: number, vanilla = true): void {
  if (amount <= 0) return;
  const profile = profileOf(player);
  profile.xp += amount;
  profiles.markDirty();

  if (!vanilla || !cfg().rewardsGiveVanillaXp) return;
  try {
    player.addExperience(amount);
  } catch (error) {
    console.warn(`[AdminSuite] could not grant vanilla experience: ${error}`);
  }
}

export function save(): void {
  profiles.markDirty();
}

/** Resolves the online `Player` for a stored profile, if they are connected. */
export function onlinePlayer(profile: Profile): Player | undefined {
  return world.getAllPlayers().find((p) => p.id === profile.id);
}

/** Returns remaining cooldown in ms for `key`, or 0 when ready. */
export function cooldownLeft(profile: Profile, key: string): number {
  const until = profile.cooldowns[key];
  if (!until) return 0;
  const left = until - now();
  if (left <= 0) {
    delete profile.cooldowns[key];
    return 0;
  }
  return left;
}

export function setCooldown(profile: Profile, key: string, seconds: number): void {
  if (seconds <= 0) return;
  profile.cooldowns[key] = now() + seconds * 1000;
  profiles.markDirty();
}
