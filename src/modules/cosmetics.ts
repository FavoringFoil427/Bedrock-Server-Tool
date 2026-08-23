import { MolangVariableMap, Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { profileOf, profiles } from '../core/profiles';
import { can } from '../core/permissions';
import { C, err, ok, tell } from '../core/util';
import { charge, money } from './economy';

/**
 * Cosmetics: particle trails, auras and halos.
 *
 * Particle work is the easiest way to wreck a server's frame rate, so the
 * budget here is deliberate: one shared loop, a hard cap on particles emitted
 * per player per pass, trails that only fire while a player is actually
 * moving, and single-shot particle types only (emitters keep spawning on their
 * own and cannot be throttled from script).
 */

export type CosmeticKind = 'trail' | 'aura' | 'halo';

export interface Cosmetic {
  id: string;
  name: string;
  kind: CosmeticKind;
  /** A single-shot vanilla particle id. Emitters must not be used here. */
  particle: string;
  cost: number;
  permission?: string;
}

export const cosmetics = new Table<Cosmetic>('adm:cosmetics');

/** Particles emitted per player per pass, whatever the cosmetic. */
const PARTICLE_BUDGET = 4;
/** Ticks between passes. */
const PERIOD_TICKS = 6;
/** A player slower than this counts as standing still, so trails pause. */
const MOVING_SPEED = 0.08;

export function ensureDefaultCosmetics(): void {
  if (cosmetics.size > 0) return;
  const seed: Cosmetic[] = [
    { id: 'flame_trail', name: 'Flame Trail', kind: 'trail', particle: 'minecraft:basic_flame_particle', cost: 5_000 },
    { id: 'heart_trail', name: 'Heart Trail', kind: 'trail', particle: 'minecraft:heart_particle', cost: 3_000 },
    { id: 'note_trail', name: 'Music Trail', kind: 'trail', particle: 'minecraft:note_particle', cost: 3_000 },
    { id: 'splash_trail', name: 'Splash Trail', kind: 'trail', particle: 'minecraft:water_splash_particle', cost: 2_500 },
    { id: 'happy_aura', name: 'Happy Aura', kind: 'aura', particle: 'minecraft:villager_happy', cost: 7_500 },
    { id: 'crit_aura', name: 'Critical Aura', kind: 'aura', particle: 'minecraft:basic_crit_particle', cost: 10_000 },
    { id: 'end_aura', name: 'End Aura', kind: 'aura', particle: 'minecraft:endrod', cost: 12_000 },
    { id: 'totem_halo', name: 'Totem Halo', kind: 'halo', particle: 'minecraft:totem_particle', cost: 15_000 },
    { id: 'flame_halo', name: 'Flame Halo', kind: 'halo', particle: 'minecraft:basic_flame_particle', cost: 15_000 },
    {
      id: 'staff_aura',
      name: 'Staff Aura',
      kind: 'aura',
      particle: 'minecraft:endrod',
      cost: 0,
      permission: 'cosmetic.staff',
    },
  ];
  for (const cosmetic of seed) cosmetics.set(cosmetic.id, cosmetic);
}

export function owns(player: Player, cosmetic: Cosmetic): boolean {
  if (cosmetic.permission && can(player, cosmetic.permission)) return true;
  if (cosmetic.cost === 0 && !cosmetic.permission) return true;
  return profileOf(player).cosmeticsOwned?.includes(cosmetic.id) ?? false;
}

/** Buys a cosmetic. Returns an error string, or undefined on success. */
export function purchase(player: Player, cosmetic: Cosmetic): string | undefined {
  if (owns(player, cosmetic)) return 'You already own that.';
  if (cosmetic.permission && !can(player, cosmetic.permission)) return 'That cosmetic is not available to you.';
  const profile = profileOf(player);
  if (cosmetic.cost > 0 && !charge(profile, cosmetic.cost)) return `You need ${money(cosmetic.cost)}.`;

  profile.cosmeticsOwned = [...(profile.cosmeticsOwned ?? []), cosmetic.id];
  profiles.markDirty();
  return undefined;
}

export function equip(player: Player, cosmeticId: string | undefined): void {
  const profile = profileOf(player);
  if (cosmeticId === undefined) delete profile.cosmeticEquipped;
  else profile.cosmeticEquipped = cosmeticId;
  profiles.markDirty();
}

/** Emits one pass of a cosmetic's particles around a player. */
function emit(player: Player, cosmetic: Cosmetic): void {
  const { x, y, z } = player.location;
  const variables = new MolangVariableMap();

  try {
    switch (cosmetic.kind) {
      case 'trail': {
        const velocity = player.getVelocity();
        const speed = Math.hypot(velocity.x, velocity.z);
        // A stationary player would otherwise pile particles at their feet.
        if (speed < MOVING_SPEED) return;
        player.dimension.spawnParticle(cosmetic.particle, { x, y: y + 0.1, z }, variables);
        return;
      }
      case 'aura': {
        const t = (system.currentTick % 40) / 40;
        for (let i = 0; i < PARTICLE_BUDGET; i++) {
          const angle = t * Math.PI * 2 + (i / PARTICLE_BUDGET) * Math.PI * 2;
          player.dimension.spawnParticle(
            cosmetic.particle,
            { x: x + Math.cos(angle) * 0.9, y: y + 0.4, z: z + Math.sin(angle) * 0.9 },
            variables,
          );
        }
        return;
      }
      case 'halo': {
        const t = (system.currentTick % 60) / 60;
        for (let i = 0; i < PARTICLE_BUDGET; i++) {
          const angle = t * Math.PI * 2 + (i / PARTICLE_BUDGET) * Math.PI * 2;
          player.dimension.spawnParticle(
            cosmetic.particle,
            { x: x + Math.cos(angle) * 0.45, y: y + 2.2, z: z + Math.sin(angle) * 0.45 },
            variables,
          );
        }
        return;
      }
    }
  } catch {
    // An unknown particle id on this game version must not kill the loop.
  }
}

export function install(): void {
  ensureDefaultCosmetics();

  register({
    name: 'cosmetics',
    aliases: ['cosmetic', 'stylist'],
    description: 'List cosmetics you own and can buy.',
    category: 'Rewards',
    handler: ({ player }) => {
      const profile = profileOf(player);
      tell(player, `${C.title}Cosmetics`);
      for (const cosmetic of cosmetics.values()) {
        const state = profile.cosmeticEquipped === cosmetic.id
          ? `${C.good}equipped`
          : owns(player, cosmetic)
            ? `${C.accent}owned`
            : `${C.dim}${money(cosmetic.cost)}`;
        player.sendMessage(`  ${C.white}${cosmetic.name} ${C.dim}(${cosmetic.kind}) - ${state}`);
      }
      player.sendMessage(`${C.dim}Use !equip <name> or visit a Stylist NPC.`);
    },
  });

  register({
    name: 'buycosmetic',
    description: 'Buy a cosmetic.',
    category: 'Rewards',
    args: [{ name: 'cosmetic', type: 'string' }],
    handler: ({ player, args }) => {
      const cosmetic = cosmetics.get((args[0] ?? '').toLowerCase());
      if (!cosmetic) return err(player, 'No cosmetic with that id.');
      const problem = purchase(player, cosmetic);
      if (problem) return err(player, problem);
      ok(player, `Bought ${cosmetic.name}. Use !equip ${cosmetic.id} to wear it.`);
    },
  });

  register({
    name: 'equip',
    description: 'Equip a cosmetic, or "none" to remove it.',
    category: 'Rewards',
    args: [{ name: 'cosmetic', type: 'string' }],
    handler: ({ player, args }) => {
      const id = (args[0] ?? '').toLowerCase();
      if (id === 'none' || id === 'off') {
        equip(player, undefined);
        return ok(player, 'Cosmetic removed.');
      }
      const cosmetic = cosmetics.get(id);
      if (!cosmetic) return err(player, 'No cosmetic with that id.');
      if (!owns(player, cosmetic)) return err(player, `You do not own that. It costs ${money(cosmetic.cost)}.`);
      equip(player, cosmetic.id);
      ok(player, `Now wearing ${cosmetic.name}.`);
    },
  });

  // One shared loop drives every equipped cosmetic.
  system.runInterval(() => {
    if (!cfg().cosmeticsEnabled) return;
    for (const player of world.getAllPlayers()) {
      const profile = profiles.get(player.id);
      const equipped = profile?.cosmeticEquipped;
      if (!equipped) continue;
      // A vanished staff member should not be given away by their particles.
      if (profile?.vanished) continue;
      const cosmetic = cosmetics.get(equipped);
      if (cosmetic) emit(player, cosmetic);
    }
  }, PERIOD_TICKS);
}
