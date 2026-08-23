import { BlockTypes, Player, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { profileByName, profileOf, profiles } from '../core/profiles';
import { bypasses, can } from '../core/permissions';
import { C, err, ok, tell } from '../core/util';

/**
 * Daily block quotas.
 *
 * Caps how many blocks a player may break or place per day, which blunts
 * automated grief runs and stops a single player strip-mining a fresh world
 * flat overnight. Quotas reset on the calendar day, staff bypass them, and a
 * limit of zero means unlimited.
 */

/** Local calendar day key, so quotas reset at midnight rather than 24h after first use. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

interface Usage {
  mined: number;
  placed: number;
}

/** Returns today's usage, rolling the counters over on a new day. */
function usageOf(player: Player): Usage {
  const profile = profileOf(player);
  if (profile.quotaDay !== today()) {
    profile.quotaDay = today();
    profile.quotaMined = 0;
    profile.quotaPlaced = 0;
    profiles.markDirty();
  }
  return { mined: profile.quotaMined ?? 0, placed: profile.quotaPlaced ?? 0 };
}

export function exempt(player: Player): boolean {
  return bypasses(player) || can(player, 'bypass.quota');
}

/** Remaining allowance as `[mined, placed]`; -1 means unlimited. */
export function remaining(player: Player): [number, number] {
  const config = cfg();
  const usage = usageOf(player);
  return [
    config.blockQuotaMined > 0 ? Math.max(0, config.blockQuotaMined - usage.mined) : -1,
    config.blockQuotaPlaced > 0 ? Math.max(0, config.blockQuotaPlaced - usage.placed) : -1,
  ];
}

function warnAtLimit(player: Player, kind: 'break' | 'place'): void {
  player.onScreenDisplay.setActionBar(
    `${C.bad}Daily ${kind} limit reached - resets tomorrow`,
  );
}

export function install(): void {
  register({
    name: 'quota',
    description: 'Show how much of your daily block allowance is left.',
    category: 'General',
    handler: ({ player }) => {
      const config = cfg();
      if (!config.blockQuotaEnabled) return tell(player, `${C.dim}Block quotas are disabled.`);
      if (exempt(player)) return tell(player, `${C.good}You are exempt from block quotas.`);

      const usage = usageOf(player);
      const [mined, placed] = remaining(player);
      tell(player, `${C.title}Daily block quota`);
      player.sendMessage(
        `  ${C.dim}Broken: ${C.white}${usage.mined}${config.blockQuotaMined > 0 ? `/${config.blockQuotaMined}` : ''} ${mined === -1 ? `${C.dim}(unlimited)` : `${C.good}${mined} left`}`,
      );
      player.sendMessage(
        `  ${C.dim}Placed: ${C.white}${usage.placed}${config.blockQuotaPlaced > 0 ? `/${config.blockQuotaPlaced}` : ''} ${placed === -1 ? `${C.dim}(unlimited)` : `${C.good}${placed} left`}`,
      );
    },
  });

  register({
    name: 'resetquota',
    description: 'Admin: reset a player\'s daily block quota.',
    category: 'Players',
    permission: 'players.view',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, 'Player not found.');
      target.quotaMined = 0;
      target.quotaPlaced = 0;
      target.quotaDay = today();
      profiles.markDirty();
      ok(player, `Reset ${target.name}'s block quota.`);
    },
  });

  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const config = cfg();
    if (!config.blockQuotaEnabled || config.blockQuotaMined <= 0) return;
    const player = event.player;
    if (exempt(player)) return;

    const usage = usageOf(player);
    if (usage.mined >= config.blockQuotaMined) {
      event.cancel = true;
      warnAtLimit(player, 'break');
    }
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const config = cfg();
    if (!config.blockQuotaEnabled || config.blockQuotaMined <= 0) return;
    if (exempt(event.player)) return;
    const profile = profileOf(event.player);
    profile.quotaMined = (profile.quotaMined ?? 0) + 1;
    profiles.markDirty();
  });

  /*
   * There is no before-event for block placement, so placement is gated on the
   * interaction that causes it: if the held item names a real block type, the
   * interaction is a placement attempt.
   */
  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const config = cfg();
    if (!config.blockQuotaEnabled || config.blockQuotaPlaced <= 0) return;
    const held = event.itemStack;
    if (!held || !BlockTypes.get(held.typeId)) return;

    const player = event.player;
    if (exempt(player)) return;

    const usage = usageOf(player);
    if (usage.placed >= config.blockQuotaPlaced) {
      event.cancel = true;
      warnAtLimit(player, 'place');
    }
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const config = cfg();
    if (!config.blockQuotaEnabled || config.blockQuotaPlaced <= 0) return;
    if (exempt(event.player)) return;
    const profile = profileOf(event.player);
    profile.quotaPlaced = (profile.quotaPlaced ?? 0) + 1;
    profiles.markDirty();
  });
}
