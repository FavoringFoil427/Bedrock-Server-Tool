import { Difficulty, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg, saveConfig } from '../core/config';
import { C, broadcast, err, ok, overworld, runCommand, tell } from '../core/util';

/** Time, weather, difficulty, game rules, entity cleanup and a soft border. */

const TIME_PRESETS: Record<string, number> = {
  day: 1000,
  noon: 6000,
  sunset: 12000,
  night: 13000,
  midnight: 18000,
  sunrise: 23000,
};

export function setTime(preset: string): boolean {
  const value = TIME_PRESETS[preset.toLowerCase()] ?? Number.parseInt(preset, 10);
  if (!Number.isFinite(value)) return false;
  world.setTimeOfDay(value);
  return true;
}

export function setWeather(kind: string): boolean {
  const map: Record<string, string> = { clear: 'clear', rain: 'rain', thunder: 'thunder' };
  const command = map[kind.toLowerCase()];
  if (!command) return false;
  return runCommand(overworld(), `weather ${command}`);
}

/** Removes loose items and optionally hostile mobs. Returns how many went. */
export function cleanEntities(includeMobs: boolean): number {
  let removed = 0;
  for (const dimensionId of ['overworld', 'nether', 'the_end']) {
    const dimension = world.getDimension(dimensionId);
    try {
      for (const entity of dimension.getEntities({ type: 'minecraft:item' })) {
        entity.remove();
        removed++;
      }
      if (includeMobs) {
        for (const entity of dimension.getEntities({ families: ['monster'] })) {
          entity.remove();
          removed++;
        }
      }
    } catch (error) {
      console.warn(`[AdminSuite] cleanup failed in ${dimensionId}: ${error}`);
    }
  }
  return removed;
}

export function install(): void {
  register({
    name: 'time',
    description: 'Set the world time (day, night, or a number).',
    category: 'World',
    permission: 'world.time',
    args: [{ name: 'value', type: 'string' }],
    handler: ({ player, args }) => {
      if (!setTime(args[0] ?? '')) return err(player, 'Use day, noon, sunset, night, midnight, sunrise or a number.');
      ok(player, `Time set to ${args[0]}.`);
    },
  });

  register({
    name: 'weather',
    description: 'Set the weather (clear, rain, thunder).',
    category: 'World',
    permission: 'world.weather',
    args: [{ name: 'value', type: 'string' }],
    handler: ({ player, args }) => {
      if (!setWeather(args[0] ?? '')) return err(player, 'Use clear, rain or thunder.');
      ok(player, `Weather set to ${args[0]}.`);
    },
  });

  register({
    name: 'difficulty',
    description: 'Set the world difficulty.',
    category: 'World',
    permission: 'world.difficulty',
    args: [{ name: 'value', type: 'string' }],
    handler: ({ player, args }) => {
      const key = (args[0] ?? '').toLowerCase();
      const map: Record<string, Difficulty> = {
        peaceful: Difficulty.Peaceful,
        easy: Difficulty.Easy,
        normal: Difficulty.Normal,
        hard: Difficulty.Hard,
      };
      const value = map[key];
      if (value === undefined) return err(player, 'Use peaceful, easy, normal or hard.');
      world.setDifficulty(value);
      ok(player, `Difficulty set to ${key}.`);
    },
  });

  register({
    name: 'clean',
    description: 'Remove dropped items (add "mobs" to clear hostiles too).',
    category: 'World',
    permission: 'world.entities',
    args: [{ name: 'scope', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      const includeMobs = (args[0] ?? '').toLowerCase() === 'mobs';
      const removed = cleanEntities(includeMobs);
      broadcast(`${C.warn}Cleared ${removed} entities.`);
      void player;
    },
  });

  register({
    name: 'border',
    description: 'Set or disable the soft world border radius.',
    category: 'World',
    permission: 'world.border',
    args: [{ name: 'radius', type: 'string' }],
    handler: ({ player, args }) => {
      const input = (args[0] ?? '').toLowerCase();
      if (input === 'off' || input === 'disable') {
        saveConfig((config) => {
          config.worldBorderEnabled = false;
        });
        return ok(player, 'World border disabled.');
      }
      const radius = Number.parseInt(input, 10);
      if (!Number.isFinite(radius) || radius < 16) return err(player, 'Radius must be at least 16, or "off".');
      saveConfig((config) => {
        config.worldBorderEnabled = true;
        config.worldBorderRadius = radius;
      });
      ok(player, `World border set to ${radius} blocks.`);
    },
  });

  register({
    name: 'gamerule',
    description: 'Change a game rule.',
    category: 'World',
    permission: 'world.gamerule',
    args: [
      { name: 'rule', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    handler: ({ player, args }) => {
      if (runCommand(overworld(), `gamerule ${args[0]} ${args[1]}`)) {
        ok(player, `Game rule ${args[0]} set to ${args[1]}.`);
      } else {
        err(player, 'That game rule or value is not valid.');
      }
    },
  });

  register({
    name: 'motd',
    description: 'Show the server message of the day.',
    category: 'General',
    handler: ({ player }) => tell(player, cfg().motd),
  });

  /* Soft world border ---------------------------------------------------- */

  system.runInterval(() => {
    const config = cfg();
    if (!config.worldBorderEnabled) return;
    const radius = config.worldBorderRadius;
    for (const player of world.getAllPlayers()) {
      if (player.dimension.id !== 'minecraft:overworld') continue;
      const { x, z } = player.location;
      if (Math.abs(x) <= radius && Math.abs(z) <= radius) continue;
      // Pull them back just inside the edge rather than to spawn.
      const clampedX = Math.max(-radius + 2, Math.min(radius - 2, x));
      const clampedZ = Math.max(-radius + 2, Math.min(radius - 2, z));
      player.teleport({ x: clampedX, y: player.location.y, z: clampedZ });
      player.onScreenDisplay.setActionBar(`${C.bad}You have reached the world border`);
    }
  }, 20);
}
