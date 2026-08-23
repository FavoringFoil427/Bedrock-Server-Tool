import { Player, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Table } from '../core/storage';
import { giveItem, inventoryOf, makeStack } from '../core/items';
import { C, err, formatVec, ok, tell } from '../core/util';

/**
 * Gravestones.
 *
 * On death a player's inventory is copied into storage rather than dropped, so
 * items survive lava, the void and `/kill`. The owner recovers everything with
 * `!grave`, and only the most recent few deaths are kept per player.
 */

interface GraveItem {
  typeId: string;
  amount: number;
}

interface Grave {
  playerId: string;
  at: number;
  x: number;
  y: number;
  z: number;
  dimension: string;
  items: GraveItem[];
}

/** playerId -> their recent graves, newest last. */
const graves = new Table<Grave[]>('adm:graves');

const MAX_GRAVES = 3;

function capture(player: Player): GraveItem[] {
  const container = inventoryOf(player);
  if (!container) return [];
  const items: GraveItem[] = [];
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (item) items.push({ typeId: item.typeId, amount: item.amount });
  }
  return items;
}

export function install(): void {
  register({
    name: 'grave',
    description: 'Recover the items from your last death.',
    category: 'General',
    handler: ({ player }) => {
      if (!cfg().gravestonesEnabled) return err(player, 'Gravestones are disabled.');
      const list = graves.get(player.id) ?? [];
      const grave = list.pop();
      if (!grave) return err(player, 'You have no gravestone to recover.');

      let restored = 0;
      for (const item of grave.items) {
        const stack = makeStack(item.typeId, item.amount);
        if (stack) {
          giveItem(player, stack);
          restored++;
        }
      }
      graves.set(player.id, list);
      ok(player, `Recovered ${restored} stacks from your death at ${formatVec(grave)}.`);
    },
  });

  register({
    name: 'graves',
    description: 'List your stored gravestones.',
    category: 'General',
    handler: ({ player }) => {
      const list = graves.get(player.id) ?? [];
      if (list.length === 0) return tell(player, `${C.dim}You have no gravestones.`);
      tell(player, `${C.title}Your gravestones`);
      for (const grave of list) {
        player.sendMessage(`  ${C.accent}${formatVec(grave)} ${C.dim}- ${grave.items.length} stacks`);
      }
    },
  });

  world.afterEvents.entityDie.subscribe((event) => {
    if (!cfg().gravestonesEnabled) return;
    const player = event.deadEntity;
    if (!(player instanceof Player)) return;

    const items = capture(player);
    if (items.length === 0) return;

    const list = graves.get(player.id) ?? [];
    list.push({
      playerId: player.id,
      at: Date.now(),
      x: player.location.x,
      y: player.location.y,
      z: player.location.z,
      dimension: player.dimension.id,
      items,
    });
    // Keep only the newest few so storage cannot grow without bound.
    while (list.length > MAX_GRAVES) list.shift();
    graves.set(player.id, list);

    // Clear the inventory so the items are not also dropped on the ground.
    const container = inventoryOf(player);
    if (container) container.clearAll();

    tell(player, `${C.warn}Your items were saved to a gravestone. Use !grave to recover them.`);
  });
}
