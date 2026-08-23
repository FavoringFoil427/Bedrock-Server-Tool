import { Player } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Profile, profileByName, profileOf, profiles, onlinePlayer } from '../core/profiles';
import { t } from '../core/i18n';
import { C, err, formatNumber, ok, tell } from '../core/util';
import { can } from '../core/permissions';

/** Central money API. Every other module goes through these helpers. */

export function balanceOf(profile: Profile): number {
  return Math.max(0, Math.round(profile.balance));
}

export function money(amount: number): string {
  return `${cfg().currencySymbol}${formatNumber(amount)}`;
}

export function addMoney(profile: Profile, amount: number): void {
  profile.balance = Math.max(0, Math.round(profile.balance + amount));
  profiles.markDirty();
}

export function setMoney(profile: Profile, amount: number): void {
  profile.balance = Math.max(0, Math.round(amount));
  profiles.markDirty();
}

export function canAfford(profile: Profile, amount: number): boolean {
  return balanceOf(profile) >= Math.round(amount);
}

/** Deducts `amount` when affordable. Returns false and changes nothing otherwise. */
export function charge(profile: Profile, amount: number): boolean {
  if (!canAfford(profile, amount)) return false;
  addMoney(profile, -amount);
  return true;
}

/** Moves money between two profiles, applying the configured transfer tax. */
export function transfer(from: Profile, to: Profile, amount: number): boolean {
  if (amount <= 0 || !canAfford(from, amount)) return false;
  const tax = Math.round((amount * cfg().payTaxPercent) / 100);
  addMoney(from, -amount);
  addMoney(to, amount - tax);
  return true;
}

/** Top balances, richest first. */
export function richest(limit = 10): Profile[] {
  return profiles
    .values()
    .sort((a, b) => balanceOf(b) - balanceOf(a))
    .slice(0, limit);
}

export function install(): void {
  register({
    name: 'balance',
    aliases: ['bal', 'money'],
    description: 'Show your balance, or another player\'s.',
    category: 'Economy',
    permission: 'economy.balance',
    args: [{ name: 'player', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      if (args[0]) {
        const target = profileByName(args[0]);
        if (!target) return err(player, t('err.playerNotFound'));
        return tell(player, `${C.accent}${target.name}${C.reset}: ${C.good}${money(balanceOf(target))}`);
      }
      const profile = profileOf(player);
      tell(player, t('economy.balance', { symbol: cfg().currencySymbol, amount: formatNumber(balanceOf(profile)) }));
    },
  });

  register({
    name: 'pay',
    description: 'Send money to another player.',
    category: 'Economy',
    permission: 'economy.pay',
    args: [
      { name: 'player', type: 'player' },
      { name: 'amount', type: 'int' },
    ],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, t('err.playerNotFound'));
      if (target.id === player.id) return err(player, t('err.selfTarget'));

      const amount = Number.parseInt(args[1] ?? '', 10);
      if (!Number.isFinite(amount) || amount <= 0) return err(player, t('err.number'));

      const profile = profileOf(player);
      if (!transfer(profile, target, amount)) {
        return err(player, t('economy.insufficient', { symbol: cfg().currencySymbol, amount: formatNumber(amount) }));
      }
      ok(player, t('economy.paid', { symbol: cfg().currencySymbol, amount: formatNumber(amount), player: target.name }));

      const online = onlinePlayer(target);
      if (online) {
        tell(online, `${C.good}` + t('economy.received', {
          symbol: cfg().currencySymbol,
          amount: formatNumber(amount),
          player: profile.name,
        }));
      }
    },
  });

  register({
    name: 'baltop',
    description: 'Show the richest players.',
    category: 'Economy',
    permission: 'economy.balance',
    handler: ({ player }) => {
      tell(player, `${C.title}Top balances`);
      richest(10).forEach((profile, index) => {
        player.sendMessage(`${C.gold}${index + 1}. ${C.white}${profile.name} ${C.dim}- ${C.good}${money(balanceOf(profile))}`);
      });
    },
  });

  register({
    name: 'eco',
    description: 'Admin: give, take or set a balance.',
    category: 'Economy',
    permission: 'economy.admin',
    args: [
      { name: 'action', type: 'string' },
      { name: 'player', type: 'player' },
      { name: 'amount', type: 'int' },
    ],
    handler: ({ player, args }) => {
      const action = (args[0] ?? '').toLowerCase();
      const target = profileByName(args[1] ?? '');
      const amount = Number.parseInt(args[2] ?? '', 10);
      if (!target) return err(player, t('err.playerNotFound'));
      if (!Number.isFinite(amount)) return err(player, t('err.number'));

      switch (action) {
        case 'give':
        case 'add':
          addMoney(target, amount);
          break;
        case 'take':
        case 'remove':
          addMoney(target, -amount);
          break;
        case 'set':
          setMoney(target, amount);
          break;
        default:
          return err(player, 'Action must be give, take or set.');
      }
      ok(player, `${target.name} now has ${money(balanceOf(target))}.`);
    },
  });
}

/** True when the player may edit other people's balances. */
export function isEconomyAdmin(player: Player): boolean {
  return can(player, 'economy.admin');
}
