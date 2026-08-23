import { Player, world } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { profileOf, profiles } from '../core/profiles';
import { C, err, ok, tell, uid } from '../core/util';
import { Reward, grant } from './rewards';
import { prettyItemName } from '../core/items';

/**
 * Quests.
 *
 * A quest is one objective plus a reward. Progress is stored per player and
 * advanced by the same gameplay events the stat tracker listens to, so quests
 * never need their own polling loop.
 */

export type ObjectiveKind = 'mine' | 'kill' | 'place' | 'earn' | 'playtime';

export interface Quest {
  id: string;
  name: string;
  description: string;
  kind: ObjectiveKind;
  /** Block/entity id for mine, kill and place objectives; ignored otherwise. */
  target: string;
  amount: number;
  reward: Reward;
  /** Repeatable quests can be completed again after claiming. */
  repeatable: boolean;
}

interface QuestProgress {
  /** questId -> count so far */
  counts: Record<string, number>;
  /** questIds already completed and claimed */
  done: string[];
}

export const quests = new Table<Quest>('adm:quests');
const progressTable = new Table<QuestProgress>('adm:questprogress');

function progressOf(playerId: string): QuestProgress {
  let entry = progressTable.get(playerId);
  if (!entry) {
    entry = { counts: {}, done: [] };
    progressTable.set(playerId, entry);
  }
  return entry;
}

function reward(moneyAmount: number, xp: number, items: [string, number][] = []): Reward {
  return { money: moneyAmount, xp, items: items.map(([typeId, amount]) => ({ typeId, amount })) };
}

export function ensureDefaultQuests(): void {
  if (quests.size > 0) return;
  const seed: Quest[] = [
    {
      id: 'first_steps',
      name: 'First Steps',
      description: 'Mine 64 stone blocks.',
      kind: 'mine',
      target: 'minecraft:stone',
      amount: 64,
      reward: reward(300, 50, [['minecraft:iron_pickaxe', 1]]),
      repeatable: false,
    },
    {
      id: 'iron_will',
      name: 'Iron Will',
      description: 'Mine 32 iron ore.',
      kind: 'mine',
      target: 'minecraft:iron_ore',
      amount: 32,
      reward: reward(750, 100, [['minecraft:iron_block', 2]]),
      repeatable: false,
    },
    {
      id: 'monster_hunter',
      name: 'Monster Hunter',
      description: 'Defeat 50 zombies.',
      kind: 'kill',
      target: 'minecraft:zombie',
      amount: 50,
      reward: reward(600, 120, [['minecraft:diamond', 1]]),
      repeatable: true,
    },
    {
      id: 'architect',
      name: 'Architect',
      description: 'Place 500 blocks.',
      kind: 'place',
      target: '*',
      amount: 500,
      reward: reward(500, 80),
      repeatable: true,
    },
    {
      id: 'entrepreneur',
      name: 'Entrepreneur',
      description: 'Reach 10,000 in the bank.',
      kind: 'earn',
      target: '',
      amount: 10_000,
      reward: reward(2000, 200, [['minecraft:emerald', 8]]),
      repeatable: false,
    },
    {
      id: 'dedicated',
      name: 'Dedicated',
      description: 'Play for 10 hours.',
      kind: 'playtime',
      target: '',
      amount: 600,
      reward: reward(2500, 300, [['minecraft:netherite_scrap', 2]]),
      repeatable: false,
    },
  ];
  for (const quest of seed) quests.set(quest.id, quest);
}

/** Current progress toward a quest, resolving live values where relevant. */
export function progressFor(player: Player, quest: Quest): number {
  const profile = profileOf(player);
  if (quest.kind === 'earn') return profile.balance;
  if (quest.kind === 'playtime') return Math.floor(profile.playtimeMs / 60_000);
  return progressOf(player.id).counts[quest.id] ?? 0;
}

export function isComplete(player: Player, quest: Quest): boolean {
  return progressFor(player, quest) >= quest.amount;
}

export function isClaimed(player: Player, quest: Quest): boolean {
  return progressOf(player.id).done.includes(quest.id);
}

/** Claims a finished quest. Returns an error string when it cannot be claimed. */
export function claim(player: Player, quest: Quest): string | undefined {
  const entry = progressOf(player.id);
  if (entry.done.includes(quest.id) && !quest.repeatable) return 'You already completed that quest.';
  if (!isComplete(player, quest)) return 'That quest is not finished yet.';

  if (quest.repeatable) {
    // Reset counters so the quest can be run again.
    entry.counts[quest.id] = 0;
    const at = entry.done.indexOf(quest.id);
    if (at !== -1) entry.done.splice(at, 1);
  } else {
    entry.done.push(quest.id);
  }
  progressTable.markDirty();
  grant(player, quest.reward);
  return undefined;
}

/** Advances counter-based objectives. */
function advance(player: Player, kind: ObjectiveKind, targetId: string): void {
  const entry = progressOf(player.id);
  let changed = false;
  for (const quest of quests.values()) {
    if (quest.kind !== kind) continue;
    if (quest.target !== '*' && quest.target !== targetId) continue;
    if (entry.done.includes(quest.id) && !quest.repeatable) continue;

    const current = entry.counts[quest.id] ?? 0;
    if (current >= quest.amount) continue;
    entry.counts[quest.id] = current + 1;
    changed = true;

    if (entry.counts[quest.id] >= quest.amount) {
      tell(player, `${C.good}Quest ready to claim: ${C.reset}${quest.name}`);
    }
  }
  if (changed) progressTable.markDirty();
}

export function install(): void {
  ensureDefaultQuests();

  register({
    name: 'quests',
    description: 'List quests and your progress.',
    category: 'Progression',
    permission: 'quests.use',
    handler: ({ player }) => {
      tell(player, `${C.title}Quests`);
      for (const quest of quests.values()) {
        const have = Math.min(progressFor(player, quest), quest.amount);
        const claimed = isClaimed(player, quest);
        const state = claimed
          ? `${C.dim}completed`
          : have >= quest.amount
            ? `${C.good}ready to claim`
            : `${C.warn}${have}/${quest.amount}`;
        player.sendMessage(`  ${C.accent}${quest.id} ${C.dim}- ${quest.description} ${state}`);
      }
      player.sendMessage(`${C.dim}Use !questclaim <id> to collect a finished quest.`);
    },
  });

  register({
    name: 'questclaim',
    aliases: ['qclaim'],
    description: 'Claim a finished quest.',
    category: 'Progression',
    permission: 'quests.use',
    args: [{ name: 'quest', type: 'string' }],
    handler: ({ player, args }) => {
      const quest = quests.get((args[0] ?? '').toLowerCase());
      if (!quest) return err(player, 'No quest with that id.');
      const problem = claim(player, quest);
      if (problem) return err(player, problem);
      ok(player, `Quest complete: ${quest.name}`);
    },
  });

  register({
    name: 'makequest',
    description: 'Admin: create a quest.',
    category: 'Progression',
    permission: 'quests.admin',
    args: [
      { name: 'name', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'target', type: 'string' },
      { name: 'amount', type: 'int' },
      { name: 'money', type: 'int' },
    ],
    handler: ({ player, args }) => {
      const kind = (args[1] ?? '').toLowerCase() as ObjectiveKind;
      if (!['mine', 'kill', 'place', 'earn', 'playtime'].includes(kind)) {
        return err(player, 'Kind must be mine, kill, place, earn or playtime.');
      }
      const target = (args[2] ?? '*').includes(':') || args[2] === '*' ? args[2] : `minecraft:${args[2]}`;
      const amount = Number.parseInt(args[3] ?? '1', 10) || 1;
      const id = (args[0] ?? uid()).toLowerCase().replace(/\s+/g, '_');

      quests.set(id, {
        id,
        name: args[0] ?? id,
        description: `${kind} ${amount}x ${target === '*' ? 'anything' : prettyItemName(target)}`,
        kind,
        target,
        amount,
        reward: reward(Number.parseInt(args[4] ?? '0', 10) || 0, 0),
        repeatable: false,
      });
      ok(player, `Quest "${id}" created.`);
    },
  });

  register({
    name: 'delquest',
    description: 'Admin: delete a quest.',
    category: 'Progression',
    permission: 'quests.admin',
    args: [{ name: 'quest', type: 'string' }],
    handler: ({ player, args }) => {
      if (!quests.delete((args[0] ?? '').toLowerCase())) return err(player, 'No quest with that id.');
      ok(player, 'Quest deleted.');
    },
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    advance(event.player, 'mine', event.brokenBlockPermutation.type.id);
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    advance(event.player, 'place', event.block.typeId);
  });

  world.afterEvents.entityDie.subscribe((event) => {
    const killer = event.damageSource.damagingEntity;
    if (killer instanceof Player) advance(killer, 'kill', event.deadEntity.typeId);
  });
}

/** Removes stored progress for a player, used by the data admin tools. */
export function resetProgress(playerId: string): void {
  progressTable.delete(playerId);
  profiles.markDirty();
}
