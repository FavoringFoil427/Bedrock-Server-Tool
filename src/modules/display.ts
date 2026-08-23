import { DisplaySlotId, ObjectiveSortOrder, Player, system, world } from '@minecraft/server';
import { cfg, saveConfig } from '../core/config';
import { expand } from '../core/placeholders';
import { profileOf } from '../core/profiles';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { C, err, formatVec, ok, tell, uid } from '../core/util';
import { balanceOf } from './economy';
import { profiles } from '../core/profiles';

/**
 * Presentation layer: nametags above players, the scoreboard sidebar, and
 * free-standing holograms with optional live leaderboards.
 */

export interface Hologram {
  id: string;
  lines: string[];
  x: number;
  y: number;
  z: number;
  dimension: string;
  /** When set the hologram renders a live leaderboard of this kind. */
  board?: 'balance' | 'playtime' | 'kills';
}

export const holograms = new Table<Hologram>('adm:holograms');

const HOLOGRAM_TYPE = 'adm:hologram';
const SIDEBAR_OBJECTIVE = 'adm_sidebar';

/* --------------------------------------------------------------- nametags */

function refreshNametags(): void {
  const config = cfg();
  if (!config.nametagsEnabled) return;
  for (const player of world.getAllPlayers()) {
    const profile = profileOf(player);
    // A vanished staff member should stay unlabelled.
    if (profile.vanished) continue;
    try {
      player.nameTag = expand(player, config.nametagFormat);
    } catch (error) {
      console.warn(`[AdminSuite] nametag update failed: ${error}`);
    }
  }
}

/* ---------------------------------------------------------------- sidebar */

/**
 * Renders the sidebar.
 *
 * The scoreboard sidebar is shared by the whole world, so per-player values
 * cannot be shown there. Lines are instead pushed to each player's action bar
 * when they contain personal tokens, and the objective is used for the
 * server-wide header.
 */
function refreshSidebar(): void {
  const config = cfg();
  const scoreboard = world.scoreboard;

  if (!config.sidebarEnabled) {
    if (scoreboard.getObjective(SIDEBAR_OBJECTIVE)) {
      scoreboard.clearObjectiveAtDisplaySlot(DisplaySlotId.Sidebar);
    }
    return;
  }

  let objective = scoreboard.getObjective(SIDEBAR_OBJECTIVE);
  // The display name is fixed at creation, so a retitled sidebar is rebuilt.
  if (objective && objective.displayName !== config.sidebarTitle) {
    scoreboard.removeObjective(objective);
    objective = undefined;
  }
  if (!objective) {
    objective = scoreboard.addObjective(SIDEBAR_OBJECTIVE, config.sidebarTitle);
  }

  // Rebuild from scratch so stale lines never linger.
  for (const participant of objective.getParticipants()) {
    objective.removeParticipant(participant);
  }

  const sample = world.getAllPlayers()[0];
  if (!sample) return;

  // Scores order the rows; the highest score sits at the top.
  const lines = config.sidebarLines;
  lines.forEach((line, index) => {
    const text = expand(sample, line).slice(0, 32);
    try {
      objective.setScore(text, lines.length - index);
    } catch {
      // Duplicate rendered lines collide as participants; skip them.
    }
  });

  scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, {
    objective,
    sortOrder: ObjectiveSortOrder.Descending,
  });
}

/* -------------------------------------------------------------- holograms */

function leaderboardLines(kind: NonNullable<Hologram['board']>): string[] {
  const all = profiles.values();
  const sorted = [...all].sort((a, b) => {
    if (kind === 'balance') return balanceOf(b) - balanceOf(a);
    if (kind === 'playtime') return b.playtimeMs - a.playtimeMs;
    return b.stats.kills - a.stats.kills;
  });
  const label = kind === 'balance' ? 'Richest' : kind === 'playtime' ? 'Most Active' : 'Top Killers';
  const lines = [`${C.title}${label}`];
  sorted.slice(0, 10).forEach((profile, index) => {
    const value =
      kind === 'balance'
        ? `${cfg().currencySymbol}${balanceOf(profile)}`
        : kind === 'playtime'
          ? `${Math.floor(profile.playtimeMs / 60000)}m`
          : String(profile.stats.kills);
    lines.push(`${C.gold}${index + 1}. ${C.white}${profile.name} ${C.dim}- ${value}`);
  });
  return lines;
}

function hologramText(hologram: Hologram): string {
  const lines = hologram.board ? leaderboardLines(hologram.board) : hologram.lines;
  return lines.join('\n');
}

/** Despawns any hologram entities so they can be rebuilt from stored data. */
function clearHologramEntities(): void {
  for (const dimensionId of ['overworld', 'nether', 'the_end']) {
    try {
      for (const entity of world.getDimension(dimensionId).getEntities({ type: HOLOGRAM_TYPE })) {
        entity.remove();
      }
    } catch {
      // Unloaded dimensions simply have nothing to clear.
    }
  }
}

/** Spawns or refreshes the entity backing each stored hologram. */
function refreshHolograms(): void {
  if (!cfg().hologramsEnabled) return;
  for (const hologram of holograms.values()) {
    let dimension;
    try {
      dimension = world.getDimension(hologram.dimension);
    } catch {
      continue;
    }
    const location = { x: hologram.x, y: hologram.y, z: hologram.z };
    let entity = dimension
      .getEntities({ type: HOLOGRAM_TYPE, location, maxDistance: 2 })
      .find((e) => e.getDynamicProperty('adm:hologram_id') === hologram.id);

    if (!entity) {
      try {
        entity = dimension.spawnEntity(HOLOGRAM_TYPE, location);
        entity.setDynamicProperty('adm:hologram_id', hologram.id);
      } catch {
        // The chunk is not loaded; it will be spawned on a later pass.
        continue;
      }
    }
    entity.nameTag = hologramText(hologram);
  }
}

export function install(): void {
  register({
    name: 'hologram',
    aliases: ['holo'],
    description: 'Create a hologram: hologram create <text> | board <kind> | list | remove <id>',
    category: 'Content',
    permission: 'hologram.admin',
    greedy: true,
    args: [
      { name: 'action', type: 'string' },
      { name: 'value', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const action = (args[0] ?? '').toLowerCase();
      const value = args[1] ?? '';
      const { x, y, z } = player.location;

      switch (action) {
        case 'create': {
          if (!value) return err(player, 'Give the hologram some text.');
          const id = uid();
          holograms.set(id, {
            id,
            lines: value.split('|').map((line) => line.trim()),
            x,
            y: y + 1.5,
            z,
            dimension: player.dimension.id,
          });
          refreshHolograms();
          return ok(player, `Hologram created (${id}).`);
        }
        case 'board': {
          const kind = value.toLowerCase();
          if (kind !== 'balance' && kind !== 'playtime' && kind !== 'kills') {
            return err(player, 'Board kind must be balance, playtime or kills.');
          }
          const id = uid();
          holograms.set(id, { id, lines: [], x, y: y + 1.5, z, dimension: player.dimension.id, board: kind });
          refreshHolograms();
          return ok(player, `Leaderboard hologram created (${id}).`);
        }
        case 'list': {
          const all = holograms.values();
          if (all.length === 0) return tell(player, `${C.dim}No holograms.`);
          tell(player, `${C.title}Holograms (${all.length})`);
          for (const hologram of all) {
            player.sendMessage(`  ${C.accent}${hologram.id} ${C.dim}- ${formatVec(hologram)} ${hologram.board ?? ''}`);
          }
          return;
        }
        case 'remove': {
          if (!holograms.delete(value)) return err(player, 'No hologram with that id.');
          clearHologramEntities();
          refreshHolograms();
          return ok(player, 'Hologram removed.');
        }
        default:
          return err(player, 'Use create, board, list or remove.');
      }
    },
  });

  register({
    name: 'sidebar',
    description: 'Toggle the scoreboard sidebar.',
    category: 'Content',
    permission: 'server.settings',
    handler: ({ player }) => {
      saveConfig((config) => {
        config.sidebarEnabled = !config.sidebarEnabled;
      });
      ok(player, `Sidebar ${cfg().sidebarEnabled ? 'enabled' : 'disabled'}.`);
      refreshSidebar();
    },
  });

  // Nametags refresh quickly (health changes), the rest on a slower cadence.
  system.runInterval(refreshNametags, 20);
  system.runInterval(refreshSidebar, 60);
  system.runInterval(refreshHolograms, 100);
}

/** Re-renders holograms after a world reload. */
export function rebuildHolograms(): void {
  clearHologramEntities();
  refreshHolograms();
}

/** Shows a personal action-bar line for values the shared sidebar cannot hold. */
export function personalStatus(player: Player): void {
  const config = cfg();
  if (!config.sidebarEnabled) return;
  player.onScreenDisplay.setActionBar(
    expand(player, `${C.dim}${config.currencySymbol}{balance}  ${C.reset}{rank}`),
  );
}
