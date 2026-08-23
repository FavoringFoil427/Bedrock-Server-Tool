import { Player, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { profileOf, profiles } from '../core/profiles';
import { C, err, ok, tell } from '../core/util';
import { addMoney, money } from './economy';
import { levelOf } from './skills';

/**
 * Jobs pay players for doing what they already do. A job maps block or entity
 * ids to a payout, so joining "Miner" quietly turns ore into income.
 */

export interface Job {
  id: string;
  name: string;
  description: string;
  icon?: string;
  /** Block id (on break) or entity id (on kill) -> payout. */
  payouts: Record<string, number>;
  /** Payout kind this job listens to. */
  trigger: 'break' | 'place' | 'kill';
}

export const jobs = new Table<Job>('adm:jobs');

export function ensureDefaultJobs(): void {
  if (jobs.size > 0) return;
  const seed: Job[] = [
    {
      id: 'miner',
      name: 'Miner',
      description: 'Earn money for every ore you break.',
      icon: 'textures/items/iron_pickaxe',
      trigger: 'break',
      payouts: {
        'minecraft:coal_ore': 3,
        'minecraft:deepslate_coal_ore': 4,
        'minecraft:iron_ore': 6,
        'minecraft:deepslate_iron_ore': 7,
        'minecraft:gold_ore': 10,
        'minecraft:deepslate_gold_ore': 12,
        'minecraft:diamond_ore': 40,
        'minecraft:deepslate_diamond_ore': 45,
        'minecraft:emerald_ore': 35,
        'minecraft:ancient_debris': 120,
        'minecraft:redstone_ore': 5,
        'minecraft:lapis_ore': 8,
      },
    },
    {
      id: 'lumberjack',
      name: 'Lumberjack',
      description: 'Earn money for every log you fell.',
      icon: 'textures/blocks/log_oak',
      trigger: 'break',
      payouts: {
        'minecraft:oak_log': 2,
        'minecraft:birch_log': 2,
        'minecraft:spruce_log': 2,
        'minecraft:jungle_log': 3,
        'minecraft:acacia_log': 3,
        'minecraft:dark_oak_log': 3,
        'minecraft:cherry_log': 4,
        'minecraft:mangrove_log': 4,
      },
    },
    {
      id: 'hunter',
      name: 'Hunter',
      description: 'Earn money for defeating hostile mobs.',
      icon: 'textures/items/iron_sword',
      trigger: 'kill',
      payouts: {
        'minecraft:zombie': 5,
        'minecraft:skeleton': 6,
        'minecraft:creeper': 8,
        'minecraft:spider': 5,
        'minecraft:enderman': 15,
        'minecraft:witch': 20,
        'minecraft:blaze': 18,
        'minecraft:wither_skeleton': 25,
      },
    },
    {
      id: 'farmer',
      name: 'Farmer',
      description: 'Earn money for harvesting crops.',
      icon: 'textures/items/wheat',
      trigger: 'break',
      payouts: {
        'minecraft:wheat': 3,
        'minecraft:carrots': 3,
        'minecraft:potatoes': 3,
        'minecraft:beetroot': 3,
        'minecraft:melon_block': 4,
        'minecraft:pumpkin': 4,
        'minecraft:sugar_cane': 2,
      },
    },
    {
      id: 'builder',
      name: 'Builder',
      description: 'Earn a small amount for placing blocks.',
      icon: 'textures/blocks/brick',
      trigger: 'place',
      payouts: { '*': 1 },
    },
  ];
  for (const job of seed) jobs.set(job.id, job);
}

/** A job bonus multiplier derived from the matching skill level. */
function multiplier(player: Player, job: Job): number {
  const skillId = job.trigger === 'kill' ? 'combat' : job.trigger === 'place' ? 'building' : 'mining';
  const level = levelOf(profileOf(player).skills[skillId] ?? 0);
  return 1 + Math.min(1, level * 0.02);
}

/** Pays the player if their current job covers `targetId`. */
function payFor(player: Player, trigger: Job['trigger'], targetId: string): void {
  if (!cfg().jobsEnabled) return;
  const profile = profileOf(player);
  if (!profile.jobId) return;
  const job = jobs.get(profile.jobId);
  if (!job || job.trigger !== trigger) return;

  const base = job.payouts[targetId] ?? job.payouts['*'];
  if (!base) return;

  const payout = Math.max(1, Math.round(base * multiplier(player, job)));
  addMoney(profile, payout);
  profile.jobXp += 1;
  profiles.markDirty();
}

export function install(): void {
  ensureDefaultJobs();

  register({
    name: 'jobs',
    description: 'List jobs you can take.',
    category: 'Progression',
    permission: 'jobs.use',
    handler: ({ player }) => {
      const profile = profileOf(player);
      tell(player, `${C.title}Jobs`);
      for (const job of jobs.values()) {
        const marker = profile.jobId === job.id ? `${C.good} <- current` : '';
        player.sendMessage(`  ${C.accent}${job.id} ${C.dim}- ${job.description}${marker}`);
      }
      player.sendMessage(`${C.dim}Use !job <id> to take one.`);
    },
  });

  register({
    name: 'job',
    description: 'Take a job, or "quit" to leave your current one.',
    category: 'Progression',
    permission: 'jobs.use',
    args: [{ name: 'id', type: 'string' }],
    handler: ({ player, args }) => {
      const profile = profileOf(player);
      const id = (args[0] ?? '').toLowerCase();

      if (id === 'quit' || id === 'leave') {
        if (!profile.jobId) return err(player, 'You do not have a job.');
        delete profile.jobId;
        profiles.markDirty();
        return ok(player, 'You quit your job.');
      }
      const job = jobs.get(id);
      if (!job) return err(player, 'No job with that id.');
      profile.jobId = job.id;
      profile.jobXp = 0;
      profiles.markDirty();
      ok(player, `You are now a ${job.name}. ${job.description}`);
    },
  });

  register({
    name: 'jobinfo',
    description: 'Show what your job pays.',
    category: 'Progression',
    permission: 'jobs.use',
    handler: ({ player }) => {
      const profile = profileOf(player);
      if (!profile.jobId) return err(player, 'You do not have a job.');
      const job = jobs.get(profile.jobId);
      if (!job) return err(player, 'Your job no longer exists.');
      tell(player, `${C.title}${job.name}`);
      player.sendMessage(`  ${C.dim}${job.description}`);
      player.sendMessage(`  Bonus: ${C.good}x${multiplier(player, job).toFixed(2)}`);
      for (const [target, amount] of Object.entries(job.payouts).slice(0, 12)) {
        player.sendMessage(`  ${C.white}${target.replace('minecraft:', '')} ${C.dim}- ${money(amount)}`);
      }
    },
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    payFor(event.player, 'break', event.brokenBlockPermutation.type.id);
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    payFor(event.player, 'place', event.block.typeId);
  });

  world.afterEvents.entityDie.subscribe((event) => {
    const killer = event.damageSource.damagingEntity;
    if (killer instanceof Player) payFor(killer, 'kill', event.deadEntity.typeId);
  });
}
