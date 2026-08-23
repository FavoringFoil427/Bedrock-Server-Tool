import { Player, system, world } from '@minecraft/server';
import { cfg } from '../core/config';
import { register } from '../core/commands';
import { C, err, formatDuration, ok, tell } from '../core/util';
import { can } from '../core/permissions';
import { inDuel } from './duels';
import { notifyStaff } from './moderation';

/**
 * Combat tagging.
 *
 * Trading hits with another player marks both of them as "in combat" for a
 * short window. While tagged a player cannot teleport away, which closes the
 * usual escape routes (`!home`, `!rtp`, `!tpa`) mid-fight. Duellists are
 * exempt: their fight is already bounded by the duel ring.
 */

/** playerId -> timestamp the tag expires. */
const tagged = new Map<string, number>();

export function inCombat(player: Player): boolean {
  const until = tagged.get(player.id);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    tagged.delete(player.id);
    return false;
  }
  return true;
}

export function combatRemaining(player: Player): number {
  const until = tagged.get(player.id);
  return until === undefined ? 0 : Math.max(0, until - Date.now());
}

export function tag(player: Player): void {
  const seconds = cfg().combatTagSeconds;
  if (seconds <= 0) return;
  tagged.set(player.id, Date.now() + seconds * 1000);
}

export function clearTag(player: Player): void {
  tagged.delete(player.id);
}

/**
 * Gate for teleport actions. Returns true (and messages the player) when the
 * action must be refused because they are mid-fight.
 */
export function blockedByCombat(player: Player): boolean {
  if (!inCombat(player)) return false;
  if (inDuel(player.id)) return false;
  if (can(player, 'bypass.cooldown')) return false;
  err(player, `You cannot teleport for another ${formatDuration(combatRemaining(player))} - you are in combat.`);
  return true;
}

export function install(): void {
  register({
    name: 'combatlog',
    description: 'Show whether you are currently in combat.',
    category: 'General',
    handler: ({ player }) => {
      if (!inCombat(player)) return ok(player, 'You are not in combat.');
      tell(player, `${C.bad}In combat for another ${formatDuration(combatRemaining(player))}.`);
    },
  });

  // Any player-on-player hit tags both sides.
  world.afterEvents.entityHurt.subscribe((event) => {
    const victim = event.hurtEntity;
    const attacker = event.damageSource.damagingEntity;
    if (!(victim instanceof Player) || !(attacker instanceof Player)) return;
    if (victim.id === attacker.id) return;
    if (inDuel(victim.id) || inDuel(attacker.id)) return;

    const wasTagged = inCombat(victim) || inCombat(attacker);
    tag(victim);
    tag(attacker);
    if (!wasTagged) {
      tell(victim, `${C.bad}You are now in combat.`);
      tell(attacker, `${C.bad}You are now in combat.`);
    }
  });

  // Logging out while tagged is reported to staff.
  world.beforeEvents.playerLeave.subscribe((event) => {
    const player = event.player;
    if (inCombat(player) && !inDuel(player.id)) {
      const name = player.name;
      system.run(() => notifyStaff(`${name} logged out while in combat.`));
    }
  });

  // Dying ends the tag, and the countdown is surfaced on the action bar.
  world.afterEvents.entityDie.subscribe((event) => {
    if (event.deadEntity instanceof Player) clearTag(event.deadEntity);
  });

  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      if (!inCombat(player)) continue;
      player.onScreenDisplay.setActionBar(`${C.bad}In combat ${C.white}${Math.ceil(combatRemaining(player) / 1000)}s`);
    }
  }, 20);
}
