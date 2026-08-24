import { Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { profileOf, profiles } from '../core/profiles';
import { C, tell } from '../core/util';

/**
 * Passive skills.
 *
 * Skills gain XP from ordinary play (mining, fighting, building, farming) and
 * award a small permanent effect at milestone levels, so long-lived players
 * feel measurably stronger without breaking survival balance.
 */

export interface SkillDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Effect granted from `perkLevel` onward, if any. */
  perk?: { effect: string; amplifierPerTier: number };
  perkLevel: number;
}

export const SKILLS: SkillDef[] = [
  {
    id: 'mining',
    name: 'Mining',
    icon: 'textures/ui/adm_mining',
    description: 'Earned by breaking blocks. Grants Haste at higher levels.',
    perk: { effect: 'haste', amplifierPerTier: 1 },
    perkLevel: 10,
  },
  {
    id: 'combat',
    name: 'Combat',
    icon: 'textures/ui/adm_combat',
    description: 'Earned by defeating mobs and players. Grants Strength.',
    perk: { effect: 'strength', amplifierPerTier: 1 },
    perkLevel: 15,
  },
  {
    id: 'building',
    name: 'Building',
    icon: 'textures/ui/adm_building',
    description: 'Earned by placing blocks. Grants Resistance.',
    perk: { effect: 'resistance', amplifierPerTier: 1 },
    perkLevel: 20,
  },
  {
    id: 'farming',
    name: 'Farming',
    icon: 'textures/ui/adm_farming',
    description: 'Earned by harvesting crops. Grants Saturation.',
    perkLevel: 12,
  },
  {
    id: 'exploration',
    name: 'Exploration',
    icon: 'textures/ui/adm_explore',
    description: 'Earned by travelling. Grants Speed.',
    perk: { effect: 'speed', amplifierPerTier: 1 },
    perkLevel: 18,
  },
];

/** XP needed to advance from `level` to the next one. */
export function xpForLevel(level: number): number {
  return 100 + level * 50;
}

export function levelOf(xp: number): number {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpForLevel(level) && level < 100) {
    remaining -= xpForLevel(level);
    level++;
  }
  return level;
}

/** XP progress within the current level, as `[have, need]`. */
export function levelProgress(xp: number): [number, number] {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpForLevel(level) && level < 100) {
    remaining -= xpForLevel(level);
    level++;
  }
  return [remaining, xpForLevel(level)];
}

/** Adds skill XP and announces level ups. */
export function addSkillXp(player: Player, skillId: string, amount: number): void {
  if (!cfg().skillsEnabled || amount <= 0) return;
  const profile = profileOf(player);
  const before = levelOf(profile.skills[skillId] ?? 0);
  profile.skills[skillId] = (profile.skills[skillId] ?? 0) + amount;
  const after = levelOf(profile.skills[skillId]);
  profiles.markDirty();

  if (after > before) {
    const skill = SKILLS.find((s) => s.id === skillId);
    tell(player, `${C.good}${skill?.name ?? skillId} level ${after}!`);
  }
}

export function install(): void {
  register({
    name: 'skills',
    description: 'Show your skill levels.',
    category: 'Progression',
    permission: 'skills.use',
    handler: ({ player }) => {
      const profile = profileOf(player);
      tell(player, `${C.title}Your skills`);
      for (const skill of SKILLS) {
        const xp = profile.skills[skill.id] ?? 0;
        const [have, need] = levelProgress(xp);
        player.sendMessage(`  ${C.accent}${skill.name} ${C.white}Lv.${levelOf(xp)} ${C.dim}(${have}/${need})`);
      }
    },
  });

  // Apply skill perks on a slow loop so effects never lapse.
  system.runInterval(() => {
    if (!cfg().skillsEnabled) return;
    for (const player of world.getAllPlayers()) {
      const profile = profileOf(player);
      for (const skill of SKILLS) {
        if (!skill.perk) continue;
        const level = levelOf(profile.skills[skill.id] ?? 0);
        if (level < skill.perkLevel) continue;
        const tier = Math.floor(level / skill.perkLevel) - 1;
        try {
          player.addEffect(skill.perk.effect, 260, {
            amplifier: Math.min(2, tier * skill.perk.amplifierPerTier),
            showParticles: false,
          });
        } catch {
          // An unknown effect id should never take the loop down.
        }
      }
    }
  }, 200);
}
