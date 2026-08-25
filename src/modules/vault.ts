import { EquipmentSlot, Player } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { giveItem, makeStack, prettyItemName, removeItem } from '../core/items';
import { menu, paged, confirm, askText } from '../core/ui';
import { Profile, profileByName } from '../core/profiles';
import { can } from '../core/permissions';
import { C, err, ok } from '../core/util';

/**
 * Personal vaults.
 *
 * The script API cannot read or write a player's ender chest, so the suite
 * provides its own server-side storage instead. Unlike an ender chest a vault
 * is fully inspectable, which is what staff actually need when investigating
 * duped or stolen items.
 */

export interface VaultItem {
  typeId: string;
  amount: number;
}

const vaults = new Table<VaultItem[]>('adm:vaults');

const SLOT_LIMIT = 45;

export function vaultOf(playerId: string): VaultItem[] {
  return vaults.get(playerId) ?? [];
}

function save(playerId: string, items: VaultItem[]): void {
  vaults.set(playerId, items);
}

/** Adds a stack to a vault, merging into an existing entry where possible. */
export function deposit(playerId: string, typeId: string, amount: number): boolean {
  const items = vaultOf(playerId);
  const existing = items.find((item) => item.typeId === typeId);
  if (existing) {
    existing.amount += amount;
  } else {
    if (items.length >= SLOT_LIMIT) return false;
    items.push({ typeId, amount });
  }
  save(playerId, items);
  return true;
}

export function withdraw(player: Player, index: number): boolean {
  const items = vaultOf(player.id);
  const entry = items[index];
  if (!entry) return false;

  // Hand back in stack-sized chunks so nothing is lost to the 64 item cap.
  let remaining = entry.amount;
  while (remaining > 0) {
    const size = Math.min(64, remaining);
    const stack = makeStack(entry.typeId, size);
    if (!stack) break;
    giveItem(player, stack);
    remaining -= size;
  }
  items.splice(index, 1);
  save(player.id, items);
  return true;
}

async function openVault(player: Player, ownerId: string, ownerName: string, readOnly: boolean): Promise<void> {
  const items = vaultOf(ownerId);

  await paged(player, {
    title: `${C.title}${readOnly ? `${ownerName}'s vault` : 'Your vault'}`,
    empty: readOnly
      ? `${C.dim}${ownerName}'s vault is empty.`
      : `${C.dim}Your vault is empty. Deposit something you are holding to fill it.`,
    body: `${C.dim}${items.length}/${SLOT_LIMIT} slots used`,
    items: items.map((item, index) => ({ item, index })),
    render: ({ item }) => ({ text: `${C.white}${item.amount}x ${prettyItemName(item.typeId)}` }),
    onPick: async ({ item, index }) => {
      if (readOnly) {
        const yes = await confirm(
          player,
          'Remove item',
          `Delete ${item.amount}x ${prettyItemName(item.typeId)} from ${ownerName}'s vault?`,
        );
        if (!yes) return;
        const current = vaultOf(ownerId);
        current.splice(index, 1);
        save(ownerId, current);
        return ok(player, 'Item removed.');
      }
      if (withdraw(player, index)) ok(player, `Withdrew ${item.amount}x ${prettyItemName(item.typeId)}.`);
    },
    back: readOnly ? undefined : () => openVaultMenu(player),
  });
}

async function openVaultMenu(player: Player): Promise<void> {
  const items = vaultOf(player.id);
  await menu(player, {
    title: `${C.title}Vault`,
    body: `${C.dim}${items.length}/${SLOT_LIMIT} slots used`,
    buttons: [
      { text: `${C.accent}Browse & withdraw`, onClick: () => openVault(player, player.id, player.name, false) },
      {
        text: `${C.good}Deposit what you are holding`,
        onClick: async () => {
          const held = player.getComponent('minecraft:equippable')?.getEquipment(EquipmentSlot.Mainhand);
          if (!held) return err(player, 'You are not holding anything.');
          if (!deposit(player.id, held.typeId, held.amount)) return err(player, 'Your vault is full.');
          removeItem(player, held.typeId, held.amount);
          ok(player, `Stored ${held.amount}x ${prettyItemName(held.typeId)}.`);
        },
      },
      {
        text: `${C.warn}Deposit a specific item`,
        onClick: async () => {
          const answer = await askText(player, 'Deposit', 'Item id (e.g. diamond)', 'diamond');
          if (!answer) return;
          const typeId = answer.includes(':') ? answer : `minecraft:${answer}`;
          const amountText = await askText(player, 'Deposit', 'How many?', '64', '64');
          const amount = Number.parseInt(amountText ?? '', 10);
          if (!Number.isFinite(amount) || amount < 1) return err(player, 'Give a valid amount.');
          const taken = removeItem(player, typeId, amount);
          if (taken === 0) return err(player, 'You do not have that item.');
          if (!deposit(player.id, typeId, taken)) {
            const stack = makeStack(typeId, taken);
            if (stack) giveItem(player, stack);
            return err(player, 'Your vault is full.');
          }
          ok(player, `Stored ${taken}x ${prettyItemName(typeId)}.`);
        },
      },
    ],
  });
}

/** Opens the player's own vault menu. */
export function openVaultCommand(player: Player): void {
  void openVaultMenu(player);
}

/** Opens another player's vault for staff review. */
export function openVaultFor(staff: Player, target: Profile): void {
  void openVault(staff, target.id, target.name, true);
}

export function install(): void {
  register({
    name: 'vault',
    aliases: ['storage'],
    description: 'Open your personal vault.',
    category: 'General',
    handler: ({ player }) => openVaultCommand(player),
  });

  register({
    name: 'viewvault',
    description: 'Admin: inspect another player\'s vault.',
    category: 'Players',
    permission: 'players.enderchest',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      if (!can(player, 'players.enderchest')) return err(player, 'You do not have permission.');
      const target = profileByName(args[0] ?? '');
      if (!target) return err(player, 'Player not found.');
      openVaultFor(player, target);
    },
  });
}
