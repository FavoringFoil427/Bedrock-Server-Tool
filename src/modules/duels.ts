import { Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { profileOf, profiles } from '../core/profiles';
import { StoredLocation } from '../core/profiles';
import { C, broadcast, distance, err, ok, tell } from '../core/util';
import { addMoney, charge, money } from './economy';

/**
 * Duels.
 *
 * Two players agree to a wagered fight, are teleported to face each other and
 * fight inside a bounded ring. Whoever dies (or leaves the ring, or logs off)
 * loses; the pot goes to the winner. Duelists are exempt from claim PvP rules
 * for the duration.
 */

interface Duel {
  aId: string;
  bId: string;
  wager: number;
  startedAt: number;
  centre: StoredLocation;
  radius: number;
  /** Where each fighter stood before the duel, so they can be sent home. */
  origins: Record<string, StoredLocation>;
}

interface Challenge {
  fromId: string;
  wager: number;
  expires: number;
}

const active: Duel[] = [];
/** target profile id -> pending challenge */
const challenges = new Map<string, Challenge>();

const RING_RADIUS = 24;
const DUEL_TIMEOUT_MS = 5 * 60_000;

export function inDuel(playerId: string): boolean {
  return active.some((duel) => duel.aId === playerId || duel.bId === playerId);
}

function duelOf(playerId: string): Duel | undefined {
  return active.find((duel) => duel.aId === playerId || duel.bId === playerId);
}

function locationOf(player: Player): StoredLocation {
  const { x, y, z } = player.location;
  return { x, y, z, dimension: player.dimension.id };
}

function sendHome(player: Player, where: StoredLocation | undefined): void {
  if (!where) return;
  try {
    player.teleport({ x: where.x, y: where.y, z: where.z }, { dimension: world.getDimension(where.dimension) });
  } catch {
    // Their origin dimension is gone; leaving them put is acceptable.
  }
}

/** Ends a duel, paying out the pot and returning both fighters. */
function finish(duel: Duel, winnerId: string | undefined, note: string): void {
  const index = active.indexOf(duel);
  if (index !== -1) active.splice(index, 1);

  const a = world.getAllPlayers().find((p) => p.id === duel.aId);
  const b = world.getAllPlayers().find((p) => p.id === duel.bId);

  for (const player of [a, b]) {
    if (!player) continue;
    sendHome(player, duel.origins[player.id]);
    player.removeEffect('resistance');
  }

  if (winnerId === undefined) {
    // A draw refunds both wagers.
    for (const id of [duel.aId, duel.bId]) {
      const profile = profiles.get(id);
      if (profile && duel.wager > 0) addMoney(profile, duel.wager);
    }
    broadcast(`${C.warn}Duel ended in a draw (${note}).`);
    return;
  }

  const winner = profiles.get(winnerId);
  const loserId = winnerId === duel.aId ? duel.bId : duel.aId;
  const loser = profiles.get(loserId);
  if (winner && duel.wager > 0) addMoney(winner, duel.wager * 2);
  if (winner) {
    winner.xp += 25;
    profiles.markDirty();
  }
  const pot = duel.wager > 0 ? ` and won ${money(duel.wager * 2)}` : '';
  broadcast(`${C.gold}${winner?.name ?? 'Someone'} ${C.reset}beat ${loser?.name ?? 'someone'} in a duel${pot}!`);
}

function begin(a: Player, b: Player, wager: number): void {
  const centre = locationOf(a);
  const duel: Duel = {
    aId: a.id,
    bId: b.id,
    wager,
    startedAt: Date.now(),
    centre,
    radius: RING_RADIUS,
    origins: { [a.id]: locationOf(a), [b.id]: locationOf(b) },
  };
  active.push(duel);

  // Face each other a few blocks apart.
  b.teleport({ x: centre.x + 4, y: centre.y, z: centre.z }, { dimension: a.dimension });

  for (const player of [a, b]) {
    player.addEffect('resistance', 60, { amplifier: 4, showParticles: false });
    tell(player, `${C.gold}Duel starting in 3 seconds!`);
  }

  system.runTimeout(() => {
    for (const player of [a, b]) {
      if (player.isValid) {
        player.removeEffect('resistance');
        tell(player, `${C.bad}Fight!`);
      }
    }
  }, 60);
}

export function install(): void {
  register({
    name: 'duel',
    description: 'Challenge a player to a duel, optionally for a wager.',
    category: 'Social',
    permission: 'duel.use',
    args: [
      { name: 'player', type: 'player' },
      { name: 'wager', type: 'int', optional: true },
    ],
    handler: ({ player, args }) => {
      if (!cfg().duelsEnabled) return err(player, 'Duels are disabled.');
      const profile = profileOf(player);
      if (profile.duelsOff) return err(player, 'Turn duels back on first with !duelon.');
      if (inDuel(player.id)) return err(player, 'You are already duelling.');

      const needle = (args[0] ?? '').toLowerCase();
      const target = world.getAllPlayers().find((p) => p.name.toLowerCase() === needle);
      if (!target) return err(player, 'That player is not online.');
      if (target.id === player.id) return err(player, 'You cannot duel yourself.');
      if (inDuel(target.id)) return err(player, `${target.name} is already duelling.`);

      const targetProfile = profileOf(target);
      if (targetProfile.duelsOff) return err(player, `${target.name} has duels turned off.`);

      const wager = Math.max(0, Number.parseInt(args[1] ?? '0', 10) || 0);
      if (wager > 0 && profile.balance < wager) return err(player, `You cannot cover a ${money(wager)} wager.`);

      challenges.set(target.id, { fromId: player.id, wager, expires: Date.now() + 60_000 });
      ok(player, `Challenge sent to ${target.name}.`);
      tell(target, `${C.gold}${player.name} challenged you to a duel${wager > 0 ? ` for ${money(wager)}` : ''}. Use !accept or !deny.`);
    },
  });

  register({
    name: 'accept',
    description: 'Accept a duel challenge.',
    category: 'Social',
    permission: 'duel.use',
    handler: ({ player }) => {
      const challenge = challenges.get(player.id);
      if (!challenge || challenge.expires < Date.now()) {
        challenges.delete(player.id);
        return err(player, 'You have no pending challenge.');
      }
      challenges.delete(player.id);

      const challenger = world.getAllPlayers().find((p) => p.id === challenge.fromId);
      if (!challenger) return err(player, 'That player is no longer online.');

      const me = profileOf(player);
      const them = profileOf(challenger);
      if (challenge.wager > 0) {
        if (!charge(me, challenge.wager)) return err(player, `You need ${money(challenge.wager)}.`);
        if (!charge(them, challenge.wager)) {
          addMoney(me, challenge.wager);
          return err(player, `${challenger.name} can no longer cover the wager.`);
        }
      }
      begin(challenger, player, challenge.wager);
    },
  });

  register({
    name: 'deny',
    description: 'Decline a duel challenge.',
    category: 'Social',
    permission: 'duel.use',
    handler: ({ player }) => {
      const challenge = challenges.get(player.id);
      if (!challenge) return err(player, 'You have no pending challenge.');
      challenges.delete(player.id);
      ok(player, 'Challenge declined.');
      const challenger = world.getAllPlayers().find((p) => p.id === challenge.fromId);
      if (challenger) tell(challenger, `${C.warn}${player.name} declined your duel.`);
    },
  });

  register({
    name: 'duelon',
    description: 'Allow duel challenges.',
    category: 'Social',
    handler: ({ player }) => {
      const profile = profileOf(player);
      profile.duelsOff = false;
      profiles.markDirty();
      ok(player, 'You can now be challenged to duels.');
    },
  });

  register({
    name: 'dueloff',
    description: 'Block duel challenges.',
    category: 'Social',
    handler: ({ player }) => {
      const profile = profileOf(player);
      profile.duelsOff = true;
      profiles.markDirty();
      ok(player, 'Duel challenges are now blocked.');
    },
  });

  // A death inside a duel decides it.
  world.afterEvents.entityDie.subscribe((event) => {
    const victim = event.deadEntity;
    if (!(victim instanceof Player)) return;
    const duel = duelOf(victim.id);
    if (!duel) return;
    finish(duel, duel.aId === victim.id ? duel.bId : duel.aId, 'defeat');
  });

  // Leaving the ring, logging off or stalling all end the fight.
  system.runInterval(() => {
    for (const duel of [...active]) {
      const a = world.getAllPlayers().find((p) => p.id === duel.aId);
      const b = world.getAllPlayers().find((p) => p.id === duel.bId);

      if (!a || !b) {
        finish(duel, a ? duel.aId : b ? duel.bId : undefined, 'a fighter left');
        continue;
      }
      if (Date.now() - duel.startedAt > DUEL_TIMEOUT_MS) {
        finish(duel, undefined, 'time limit');
        continue;
      }
      for (const fighter of [a, b]) {
        const away = distance(fighter.location, { x: duel.centre.x, y: duel.centre.y, z: duel.centre.z });
        if (away > duel.radius) {
          // Pull them back rather than ending the duel on a stray step.
          fighter.teleport({ x: duel.centre.x, y: duel.centre.y, z: duel.centre.z });
          fighter.onScreenDisplay.setActionBar(`${C.bad}Stay in the ring!`);
        }
      }
    }
  }, 20);

  // Duelists ignore claim PvP protection.
  world.beforeEvents.entityHurt.subscribe((event) => {
    const victim = event.hurtEntity;
    const attacker = event.damageSource.damagingEntity;
    if (!(victim instanceof Player) || !(attacker instanceof Player)) return;
    const duel = duelOf(victim.id);
    if (duel && (duel.aId === attacker.id || duel.bId === attacker.id)) event.cancel = false;
  });
}
