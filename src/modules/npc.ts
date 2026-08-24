import { Entity, Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { menu } from '../core/ui';
import { C, err, formatVec, ok, tell } from '../core/util';
import { openShopCategories } from '../menus/member';
import { openMemberMenu } from '../menus/member';
import { profileOf, profiles } from '../core/profiles';
import { claimKit, dailyReward, grant, kits } from './rewards';
import { formatDuration } from '../core/util';
import { ladder, rankOf } from './ranks';
import { charge, money } from './economy';
import { warps, goTo } from './teleport';
import { jobOf, jobs, jobsEnabled } from './jobs';
import {
  cosmetics,
  equip as equipCosmetic,
  owns as ownsCosmetic,
  purchase as purchaseCosmetic,
} from './cosmetics';

/**
 * Interactive NPCs.
 *
 * Each NPC is a persistent entity tagged with a role; interacting with one
 * opens the matching menu. NPCs are stored separately from their entities so
 * they can be respawned if the entity is ever lost.
 */

export type NpcRole =
  | 'shop' | 'kits' | 'daily' | 'quests' | 'jobs' | 'warps' | 'rankshop' | 'stylist' | 'info';

export interface Npc {
  id: string;
  name: string;
  role: NpcRole;
  x: number;
  y: number;
  z: number;
  dimension: string;
}

export const npcs = new Table<Npc>('adm:npcs');

const NPC_TYPE = 'adm:npc';
const ID_PROPERTY = 'adm:npc_id';

const ROLE_LABELS: Record<NpcRole, string> = {
  shop: 'Shopkeeper',
  kits: 'Kit Master',
  daily: 'Daily Rewards',
  quests: 'Quest Giver',
  jobs: 'Job Board',
  warps: 'Travel Agent',
  rankshop: 'Rank Shop',
  stylist: 'The Stylist',
  info: 'Information',
};

/** Opens the menu belonging to an NPC's role. */
async function interact(player: Player, npc: Npc): Promise<void> {
  switch (npc.role) {
    case 'shop':
      return openShopCategories(player);

    case 'kits':
      return menu(player, {
        title: `${C.title}${npc.name}`,
        body: `${C.dim}Pick a kit to claim.`,
        buttons: kits.values().map((kit) => ({
          text: `${C.accent}${kit.name}\n${C.dim}${kit.cooldown === 0 ? 'One time' : `Every ${formatDuration(kit.cooldown * 1000)}`}`,
          ...(kit.icon ? { icon: kit.icon } : {}),
          onClick: async () => {
            const problem = claimKit(player, kit);
            if (problem) err(player, problem);
            else ok(player, `Claimed ${kit.name}.`);
          },
        })),
      });

    case 'daily': {
      const profile = profileOf(player);
      const DAY = 86_400_000;
      const elapsed = Date.now() - (profile.dailyLastClaim ?? 0);
      return menu(player, {
        title: `${C.title}${npc.name}`,
        body:
          elapsed < DAY
            ? `${C.dim}Your next reward is ready in ${formatDuration(DAY - elapsed)}.`
            : `${C.good}Your daily reward is ready!`,
        buttons: [
          {
            text: elapsed < DAY ? `${C.dim}Not ready yet` : `${C.good}Claim day ${profile.dailyStreak + 1}`,
            onClick: async () => {
              if (elapsed < DAY) return err(player, 'Come back later.');
              profile.dailyStreak = elapsed < DAY * 2 ? profile.dailyStreak + 1 : 1;
              profile.dailyLastClaim = Date.now();
              profiles.markDirty();
              ok(player, `Daily reward - day ${profile.dailyStreak}!`);
              grant(player, dailyReward(profile.dailyStreak));
            },
          },
        ],
      });
    }

    case 'jobs': {
      const profile = profileOf(player);
      if (!jobsEnabled()) {
        return menu(player, {
          title: `${C.title}${npc.name}`,
          body: `${C.dim}The job board is closed - jobs are turned off on this server.`,
          buttons: [],
        });
      }
      return menu(player, {
        title: `${C.title}${npc.name}`,
        body: jobOf(profile) ? `${C.dim}Current job: ${C.white}${jobOf(profile)?.name}` : `${C.dim}You have no job.`,
        buttons: jobs.values().map((job) => ({
          text: `${C.accent}${job.name}\n${C.dim}${job.description}`,
          ...(job.icon ? { icon: job.icon } : {}),
          onClick: async () => {
            profile.jobId = job.id;
            profiles.markDirty();
            ok(player, `You are now a ${job.name}.`);
          },
        })),
      });
    }

    case 'warps':
      return menu(player, {
        title: `${C.title}${npc.name}`,
        body: `${C.dim}Choose a destination.`,
        buttons: warps.values().map((warp) => ({
          text: `${C.accent}${warp.name}${warp.cost > 0 ? `\n${C.dim}${money(warp.cost)}` : ''}`,
          onClick: async () => {
            const profile = profileOf(player);
            if (warp.cost > 0 && !charge(profile, warp.cost)) return err(player, `You need ${money(warp.cost)}.`);
            goTo(player, warp);
            ok(player, `Warped to ${warp.name}.`);
          },
        })),
      });

    case 'rankshop': {
      const profile = profileOf(player);
      const list = ladder();
      const current = rankOf(profile);
      return menu(player, {
        title: `${C.title}${npc.name}`,
        body: `${C.dim}Current rank: ${current ? current.color + current.name : 'none'}`,
        buttons: list
          .filter((rank) => rank.cost > 0)
          .map((rank) => ({
            text: `${rank.color}${rank.name}\n${C.dim}${money(rank.cost)}`,
            onClick: async () => {
              const index = list.findIndex((r) => r.id === rank.id);
              if (index <= profile.rankIndex) return err(player, 'You already have that rank.');
              if (!charge(profile, rank.cost)) return err(player, `You need ${money(rank.cost)}.`);
              profile.rankIndex = index;
              profiles.markDirty();
              ok(player, `You are now ${rank.name}!`);
            },
          })),
      });
    }

    case 'stylist': {
      const profile = profileOf(player);
      return menu(player, {
        title: `${C.title}${npc.name}`,
        body: `${C.dim}Buy and wear cosmetic effects.`,
        buttons: [
          {
            text: profile.cosmeticEquipped ? `${C.bad}Remove current cosmetic` : `${C.dim}Nothing equipped`,
            onClick: async () => {
              if (!profile.cosmeticEquipped) return;
              equipCosmetic(player, undefined);
              ok(player, 'Cosmetic removed.');
            },
          },
          ...cosmetics.values().map((cosmetic) => {
            const owned = ownsCosmetic(player, cosmetic);
            const worn = profile.cosmeticEquipped === cosmetic.id;
            return {
              text: `${worn ? C.good : owned ? C.accent : C.dim}${cosmetic.name}\n${C.dim}${cosmetic.kind} - ${worn ? 'equipped' : owned ? 'owned' : money(cosmetic.cost)}`,
              onClick: async () => {
                if (!owned) {
                  const problem = purchaseCosmetic(player, cosmetic);
                  if (problem) return err(player, problem);
                  ok(player, `Bought ${cosmetic.name}.`);
                }
                equipCosmetic(player, cosmetic.id);
                ok(player, `Now wearing ${cosmetic.name}.`);
              },
            };
          }),
        ],
      });
    }

    case 'quests':
    case 'info':
    default:
      return openMemberMenu(player);
  }
}

/** Spawns the entity for an NPC record if it is missing. */
function ensureEntity(npc: Npc): void {
  let dimension;
  try {
    dimension = world.getDimension(npc.dimension);
  } catch {
    return;
  }
  const location = { x: npc.x, y: npc.y, z: npc.z };
  const existing = dimension
    .getEntities({ type: NPC_TYPE, location, maxDistance: 3 })
    .find((entity) => entity.getDynamicProperty(ID_PROPERTY) === npc.id);

  if (existing) {
    existing.nameTag = `${C.accent}${npc.name}\n${C.dim}${ROLE_LABELS[npc.role]}`;
    return;
  }
  try {
    const entity = dimension.spawnEntity(NPC_TYPE, location);
    entity.setDynamicProperty(ID_PROPERTY, npc.id);
    entity.nameTag = `${C.accent}${npc.name}\n${C.dim}${ROLE_LABELS[npc.role]}`;
  } catch {
    // Chunk not loaded yet; a later pass will spawn it.
  }
}

function npcOf(entity: Entity): Npc | undefined {
  const id = entity.getDynamicProperty(ID_PROPERTY);
  return typeof id === 'string' ? npcs.get(id) : undefined;
}

export function install(): void {
  register({
    name: 'npc',
    description: 'NPCs: npc create <role> <name> | list | remove <id>',
    category: 'Content',
    permission: 'npc.admin',
    greedy: true,
    args: [
      { name: 'action', type: 'string' },
      { name: 'value', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const action = (args[0] ?? '').toLowerCase();
      const value = args[1] ?? '';

      if (action === 'create') {
        const [roleText, ...rest] = value.split(/\s+/);
        const role = roleText?.toLowerCase() as NpcRole;
        if (!(role in ROLE_LABELS)) {
          return err(player, `Role must be one of: ${Object.keys(ROLE_LABELS).join(', ')}`);
        }
        const id = `npc_${Date.now().toString(36)}`;
        const { x, y, z } = player.location;
        npcs.set(id, {
          id,
          name: rest.join(' ') || ROLE_LABELS[role],
          role,
          x: Math.floor(x) + 0.5,
          y,
          z: Math.floor(z) + 0.5,
          dimension: player.dimension.id,
        });
        ensureEntity(npcs.get(id)!);
        return ok(player, `${ROLE_LABELS[role]} NPC created.`);
      }

      if (action === 'list') {
        const all = npcs.values();
        if (all.length === 0) return tell(player, `${C.dim}No NPCs yet.`);
        tell(player, `${C.title}NPCs (${all.length})`);
        for (const npc of all) {
          player.sendMessage(`  ${C.accent}${npc.id} ${C.white}${npc.name} ${C.dim}- ${npc.role} at ${formatVec(npc)}`);
        }
        return;
      }

      if (action === 'remove') {
        const npc = npcs.get(value);
        if (!npc) return err(player, 'No NPC with that id.');
        try {
          const dimension = world.getDimension(npc.dimension);
          for (const entity of dimension.getEntities({ type: NPC_TYPE, location: { x: npc.x, y: npc.y, z: npc.z }, maxDistance: 3 })) {
            if (entity.getDynamicProperty(ID_PROPERTY) === npc.id) entity.remove();
          }
        } catch {
          // The entity may be in an unloaded chunk; the record still goes.
        }
        npcs.delete(npc.id);
        return ok(player, 'NPC removed.');
      }

      err(player, `Use: npc create <role> <name> | npc list | npc remove <id>. Roles: ${Object.keys(ROLE_LABELS).join(', ')}`);
    },
  });

  // Interacting with an NPC opens its menu instead of the vanilla behaviour.
  world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    if (event.target.typeId !== NPC_TYPE) return;
    const npc = npcOf(event.target);
    if (!npc) return;
    event.cancel = true;
    const player = event.player;
    system.run(() => void interact(player, npc));
  });

  // Keep NPC entities alive and labelled.
  system.runInterval(() => {
    for (const npc of npcs.values()) ensureEntity(npc);
  }, 100);
}
