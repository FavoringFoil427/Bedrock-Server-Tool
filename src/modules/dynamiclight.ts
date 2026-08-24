import { EquipmentSlot, Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { giveItem, makeStack } from '../core/items';
import { C, err, ok, tell } from '../core/util';

/**
 * Handheld torch with dynamic lighting.
 *
 * Bedrock has no API for setting light levels, so the light is a real
 * `light_block` placed at the player's position and moved as they walk. That
 * makes correctness about cleanup: a light block left behind is invisible and
 * effectively permanent, so every path that stops the effect - moving,
 * unequipping, dying, changing dimension, leaving, or the feature being turned
 * off - has to clear the one it placed.
 *
 * Only air is ever replaced, and only a light block is ever cleared, so the
 * effect can never eat somebody's build.
 */

export const TORCH_ITEM = 'adm:offhand_torch';

interface PlacedLight {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

/** The light currently placed for each player, if any. */
const placed = new Map<string, PlacedLight>();

/**
 * Light block ids, newest naming first.
 *
 * The block was split into one id per level in later versions; older worlds
 * still expose the single id with a state. Trying them in order means the same
 * pack works either way.
 */
function lightBlockIds(level: number): string[] {
  const clamped = Math.max(0, Math.min(15, level));
  return [`minecraft:light_block_${clamped}`, 'minecraft:light_block'];
}

function isLightBlock(typeId: string): boolean {
  return typeId.startsWith('minecraft:light_block');
}

/** Clears the light placed for a player, if it is still ours. */
export function clearLight(playerId: string): void {
  const light = placed.get(playerId);
  if (!light) return;
  placed.delete(playerId);

  try {
    const dimension = world.getDimension(light.dimension);
    const block = dimension.getBlock({ x: light.x, y: light.y, z: light.z });
    // Only ever clear our own light: anything else there now is somebody's build.
    if (block && isLightBlock(block.typeId)) {
      dimension.setBlockType({ x: light.x, y: light.y, z: light.z }, 'minecraft:air');
    }
  } catch {
    // Unloaded chunk; the block will be cleaned up when it is next seen.
  }
}

function holdingTorch(player: Player): boolean {
  const equipment = player.getComponent('minecraft:equippable');
  if (!equipment) return false;
  const offhand = equipment.getEquipment(EquipmentSlot.Offhand);
  if (offhand?.typeId === TORCH_ITEM) return true;
  // Holding it normally lights the way too, which is what players expect.
  return equipment.getEquipment(EquipmentSlot.Mainhand)?.typeId === TORCH_ITEM;
}

/** Moves a player's light to their current position. */
function updateLight(player: Player): void {
  const config = cfg();
  const target = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y) + 1,
    z: Math.floor(player.location.z),
  };
  const current = placed.get(player.id);

  if (
    current &&
    current.x === target.x &&
    current.y === target.y &&
    current.z === target.z &&
    current.dimension === player.dimension.id
  ) {
    return;
  }

  clearLight(player.id);

  const dimension = player.dimension;
  let existing;
  try {
    existing = dimension.getBlock(target);
  } catch {
    return;
  }
  // Never replace anything real; if the player is inside a block, skip the tick.
  if (!existing || (existing.typeId !== 'minecraft:air' && !isLightBlock(existing.typeId))) return;

  for (const id of lightBlockIds(config.dynamicLightLevel)) {
    try {
      dimension.setBlockType(target, id);
      placed.set(player.id, { ...target, dimension: dimension.id });
      return;
    } catch {
      // Try the next naming.
    }
  }
}

export function install(): void {
  register({
    name: 'torch',
    description: 'Get a handheld torch that lights your way from the offhand.',
    category: 'General',
    handler: ({ player }) => {
      if (!cfg().dynamicLightEnabled) return err(player, 'Dynamic lighting is turned off on this server.');
      const stack = makeStack(TORCH_ITEM, 1);
      if (!stack) return err(player, 'The torch item is missing from the pack.');
      giveItem(player, stack);
      ok(player, 'Put it in your offhand to light your way.');
    },
  });

  register({
    name: 'lightcleanup',
    description: 'Admin: clear every dynamic light this addon has placed.',
    category: 'World',
    permission: 'world.entities',
    handler: ({ player }) => {
      const count = placed.size;
      for (const id of [...placed.keys()]) clearLight(id);
      tell(player, `${C.good}Cleared ${count} dynamic light${count === 1 ? '' : 's'}.`);
    },
  });

  system.runInterval(() => {
    const config = cfg();
    if (!config.dynamicLightEnabled) {
      // Switched off mid-session: take back the lights already out there.
      for (const id of [...placed.keys()]) clearLight(id);
      return;
    }
    for (const player of world.getAllPlayers()) {
      if (holdingTorch(player)) updateLight(player);
      else clearLight(player.id);
    }
  }, 4);

  // A light must not outlive the player who cast it.
  world.afterEvents.entityDie.subscribe((event) => {
    if (event.deadEntity instanceof Player) clearLight(event.deadEntity.id);
  });
  world.beforeEvents.playerLeave.subscribe((event) => {
    const id = event.player.id;
    system.run(() => clearLight(id));
  });
  world.afterEvents.playerDimensionChange.subscribe((event) => {
    clearLight(event.player.id);
  });
  system.beforeEvents.shutdown.subscribe(() => {
    for (const id of [...placed.keys()]) clearLight(id);
  });
}
