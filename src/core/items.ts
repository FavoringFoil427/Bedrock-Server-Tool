import { ItemStack, Player } from '@minecraft/server';

/** Inventory helpers shared by the shop, kits, quests and reward systems. */

export function inventoryOf(player: Player) {
  return player.getComponent('minecraft:inventory')?.container;
}

/**
 * Gives an item to a player, dropping it at their feet when the inventory is
 * full so rewards are never silently lost.
 */
export function giveItem(player: Player, stack: ItemStack): void {
  const container = inventoryOf(player);
  if (container && container.emptySlotsCount > 0) {
    container.addItem(stack);
    return;
  }
  player.dimension.spawnItem(stack, player.location);
}

/** Creates a stack, returning undefined for an unknown item id. */
export function makeStack(typeId: string, amount = 1): ItemStack | undefined {
  try {
    return new ItemStack(typeId, Math.max(1, Math.min(64, amount)));
  } catch {
    return undefined;
  }
}

/** Total number of `typeId` items held by the player. */
export function countItem(player: Player, typeId: string): number {
  const container = inventoryOf(player);
  if (!container) return 0;
  let total = 0;
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (item?.typeId === typeId) total += item.amount;
  }
  return total;
}

/**
 * Removes up to `amount` of `typeId` from the inventory.
 * Returns how many were actually taken.
 */
export function removeItem(player: Player, typeId: string, amount: number): number {
  const container = inventoryOf(player);
  if (!container) return 0;
  let remaining = amount;
  for (let slot = 0; slot < container.size && remaining > 0; slot++) {
    const item = container.getItem(slot);
    if (item?.typeId !== typeId) continue;
    if (item.amount <= remaining) {
      remaining -= item.amount;
      container.setItem(slot, undefined);
    } else {
      item.amount -= remaining;
      container.setItem(slot, item);
      remaining = 0;
    }
  }
  return amount - remaining;
}

/** Strips the `minecraft:` namespace and turns an id into a readable label. */
export function prettyItemName(typeId: string): string {
  return typeId
    .replace(/^minecraft:/, '')
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
