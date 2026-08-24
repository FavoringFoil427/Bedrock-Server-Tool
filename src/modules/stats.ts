import { Player, system, world } from '@minecraft/server';
import { profileOf, profiles } from '../core/profiles';
import { checkAndAnnounce } from './ranks';
import { addSkillXp } from './skills';

/**
 * Tracks playtime, combat and building activity. These numbers feed ranks,
 * leaderboards, the sidebar and quest progress.
 */

const PLAYTIME_INTERVAL_TICKS = 200; // 10 seconds

export function install(): void {
  // Accrue playtime and run promotion checks on a slow tick.
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      const profile = profileOf(player);
      profile.playtimeMs += PLAYTIME_INTERVAL_TICKS * 50;
      profile.lastSeen = Date.now();
    }
    profiles.markDirty();
    for (const player of world.getAllPlayers()) checkAndAnnounce(player);
  }, PLAYTIME_INTERVAL_TICKS);

  world.afterEvents.entityDie.subscribe((event) => {
    const victim = event.deadEntity;
    const killer = event.damageSource.damagingEntity;

    if (victim instanceof Player) {
      const profile = profileOf(victim);
      profile.stats.deaths++;
      profiles.markDirty();
    }
    if (killer instanceof Player) {
      const profile = profileOf(killer);
      if (victim instanceof Player) profile.stats.kills++;
      else profile.stats.mobKills++;
      /*
       * Lifetime total only, deliberately not vanilla experience: the game
       * already pays XP for kills and ore, and topping that up per event would
       * make enchanting trivial. Vanilla XP comes from deliberate rewards.
       */
      profile.xp += victim instanceof Player ? 10 : 2;
      profiles.markDirty();
      addSkillXp(killer, 'combat', victim instanceof Player ? 15 : 3);
    }
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const profile = profileOf(event.player);
    profile.stats.blocksMined++;
    profile.xp += 1;
    profiles.markDirty();
    addSkillXp(event.player, 'mining', 1);
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const profile = profileOf(event.player);
    profile.stats.blocksPlaced++;
    profiles.markDirty();
    addSkillXp(event.player, 'building', 1);
  });
}
