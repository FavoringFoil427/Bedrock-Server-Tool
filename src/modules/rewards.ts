import { Player } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { profileOf, profiles } from '../core/profiles';
import { giveItem, makeStack, prettyItemName } from '../core/items';
import { can } from '../core/permissions';
import { C, err, formatDuration, now, ok, tell } from '../core/util';
import { addMoney, money } from './economy';

/** Kits, the daily reward streak, and redeemable codes. */

export interface RewardItem {
  typeId: string;
  amount: number;
}

export interface Reward {
  money: number;
  xp: number;
  items: RewardItem[];
}

export interface Kit {
  id: string;
  name: string;
  icon?: string;
  /** Seconds between claims; 0 means once ever. */
  cooldown: number;
  permission?: string;
  reward: Reward;
}

export interface RedeemCode {
  code: string;
  reward: Reward;
  maxUses: number;
  uses: number;
  expiresAt?: number;
  /** Profile ids that already redeemed it. */
  usedBy: string[];
}

export const kits = new Table<Kit>('adm:kits');
export const codes = new Table<RedeemCode>('adm:codes');

function reward(moneyAmount: number, xp: number, items: [string, number][]): Reward {
  return { money: moneyAmount, xp, items: items.map(([typeId, amount]) => ({ typeId, amount })) };
}

export function ensureDefaultKits(): void {
  if (kits.size > 0) return;
  kits.set('starter', {
    id: 'starter',
    name: 'Starter Kit',
    icon: 'textures/items/apple',
    cooldown: 0,
    reward: reward(0, 0, [
      ['minecraft:stone_sword', 1],
      ['minecraft:stone_pickaxe', 1],
      ['minecraft:stone_axe', 1],
      ['minecraft:bread', 16],
      ['minecraft:torch', 32],
      ['minecraft:oak_log', 16],
    ]),
  });
  kits.set('daily', {
    id: 'daily',
    name: 'Daily Kit',
    icon: 'textures/items/gold_ingot',
    cooldown: 86_400,
    reward: reward(250, 0, [
      ['minecraft:cooked_beef', 8],
      ['minecraft:iron_ingot', 4],
    ]),
  });
  kits.set('vip', {
    id: 'vip',
    name: 'VIP Kit',
    icon: 'textures/items/diamond',
    cooldown: 43_200,
    permission: 'kit.admin',
    reward: reward(1000, 0, [
      ['minecraft:diamond', 4],
      ['minecraft:golden_apple', 2],
    ]),
  });
}

/** Hands a reward to a player, reporting what they received. */
export function grant(player: Player, value: Reward): void {
  const profile = profileOf(player);
  if (value.money > 0) addMoney(profile, value.money);
  if (value.xp > 0) {
    profile.xp += value.xp;
    profiles.markDirty();
  }
  for (const item of value.items) {
    const stack = makeStack(item.typeId, item.amount);
    if (stack) giveItem(player, stack);
  }
  const parts: string[] = [];
  if (value.money > 0) parts.push(money(value.money));
  if (value.xp > 0) parts.push(`${value.xp} XP`);
  for (const item of value.items) parts.push(`${item.amount}x ${prettyItemName(item.typeId)}`);
  tell(player, `${C.good}Received: ${C.reset}${parts.join(', ') || 'nothing'}`);
}

/** Attempts a kit claim, returning an error string when it is refused. */
export function claimKit(player: Player, kit: Kit): string | undefined {
  if (kit.permission && !can(player, kit.permission)) return 'You do not have access to that kit.';
  const profile = profileOf(player);
  const last = profile.kitsClaimed[kit.id];

  if (last !== undefined) {
    if (kit.cooldown === 0) return 'That kit can only be claimed once.';
    const ready = last + kit.cooldown * 1000;
    if (ready > now()) return `That kit is ready in ${formatDuration(ready - now())}.`;
  }
  profile.kitsClaimed[kit.id] = now();
  profiles.markDirty();
  grant(player, kit.reward);
  return undefined;
}

/** Daily reward value; grows with the streak and caps out at day 7. */
export function dailyReward(streak: number): Reward {
  const day = Math.min(7, Math.max(1, streak));
  return reward(200 * day, 25 * day, day >= 7 ? [['minecraft:diamond', 3]] : [['minecraft:gold_ingot', day]]);
}

export function install(): void {
  ensureDefaultKits();

  register({
    name: 'kit',
    description: 'Claim a kit, or list what is available.',
    category: 'Rewards',
    args: [{ name: 'name', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      if (!args[0]) {
        const available = kits.values().filter((kit) => !kit.permission || can(player, kit.permission));
        if (available.length === 0) return tell(player, `${C.dim}No kits available.`);
        tell(player, `${C.title}Kits`);
        for (const kit of available) {
          const span = kit.cooldown === 0 ? 'one time' : `every ${formatDuration(kit.cooldown * 1000)}`;
          player.sendMessage(`  ${C.accent}${kit.id} ${C.dim}- ${kit.name} (${span})`);
        }
        return;
      }
      const kit = kits.get((args[0] ?? '').toLowerCase());
      if (!kit) return err(player, 'No kit with that name.');
      const problem = claimKit(player, kit);
      if (problem) return err(player, problem);
      ok(player, `Claimed ${kit.name}.`);
    },
  });

  register({
    name: 'daily',
    description: 'Claim your daily reward.',
    category: 'Rewards',
    handler: ({ player }) => {
      if (!cfg().dailyRewardEnabled) return err(player, 'Daily rewards are disabled.');
      const profile = profileOf(player);
      const DAY = 86_400_000;
      const last = profile.dailyLastClaim ?? 0;
      const elapsed = now() - last;

      if (elapsed < DAY) {
        return err(player, `Your next daily reward is ready in ${formatDuration(DAY - elapsed)}.`);
      }
      // Missing more than two days resets the streak.
      profile.dailyStreak = elapsed < DAY * 2 ? profile.dailyStreak + 1 : 1;
      profile.dailyLastClaim = now();
      profiles.markDirty();

      ok(player, `Daily reward - day ${profile.dailyStreak}!`);
      grant(player, dailyReward(profile.dailyStreak));
    },
  });

  register({
    name: 'redeem',
    description: 'Redeem a code.',
    category: 'Rewards',
    args: [{ name: 'code', type: 'string' }],
    handler: ({ player, args }) => {
      const key = (args[0] ?? '').toUpperCase();
      const entry = codes.get(key);
      if (!entry) return err(player, 'That code is not valid.');
      if (entry.expiresAt !== undefined && entry.expiresAt < now()) return err(player, 'That code has expired.');
      if (entry.maxUses > 0 && entry.uses >= entry.maxUses) return err(player, 'That code has been fully redeemed.');

      const profile = profileOf(player);
      if (entry.usedBy.includes(profile.id)) return err(player, 'You already redeemed that code.');

      entry.uses++;
      entry.usedBy.push(profile.id);
      codes.markDirty();
      profile.redeemedCodes.push(key);
      profiles.markDirty();

      ok(player, `Code ${key} redeemed!`);
      grant(player, entry.reward);
    },
  });

  register({
    name: 'makecode',
    description: 'Admin: create a redeem code (money, xp and max uses).',
    category: 'Rewards',
    permission: 'redeem.admin',
    args: [
      { name: 'code', type: 'string' },
      { name: 'money', type: 'int' },
      { name: 'xp', type: 'int', optional: true },
      { name: 'maxUses', type: 'int', optional: true },
    ],
    handler: ({ player, args }) => {
      const key = (args[0] ?? '').toUpperCase();
      if (!key) return err(player, 'Give the code a name.');
      codes.set(key, {
        code: key,
        reward: reward(Number.parseInt(args[1] ?? '0', 10) || 0, Number.parseInt(args[2] ?? '0', 10) || 0, []),
        maxUses: Number.parseInt(args[3] ?? '0', 10) || 0,
        uses: 0,
        usedBy: [],
      });
      ok(player, `Code ${key} created.`);
    },
  });

  register({
    name: 'delcode',
    description: 'Admin: delete a redeem code.',
    category: 'Rewards',
    permission: 'redeem.admin',
    args: [{ name: 'code', type: 'string' }],
    handler: ({ player, args }) => {
      if (!codes.delete((args[0] ?? '').toUpperCase())) return err(player, 'No such code.');
      ok(player, 'Code deleted.');
    },
  });
}

/** Gives the starter kit the first time a player joins. */
export function grantStarterKit(player: Player): void {
  const starter = kits.get('starter');
  if (!starter) return;
  const profile = profileOf(player);
  if (profile.kitsClaimed['starter'] !== undefined) return;
  claimKit(player, starter);
}
