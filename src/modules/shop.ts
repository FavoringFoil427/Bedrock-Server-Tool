import { EquipmentSlot, Player, world } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { profileByName, profileOf, profiles, onlinePlayer } from '../core/profiles';
import { countItem, giveItem, makeStack, prettyItemName, removeItem } from '../core/items';
import { C, err, now, ok, tell, uid } from '../core/util';
import { addMoney, balanceOf, charge, money } from './economy';

/**
 * Server shop and player auction house.
 *
 * Shop prices are static by design: dynamic pricing is fun for a week and then
 * becomes impossible for players to reason about. Admins set a buy price, a
 * sell price, or both.
 */

export interface ShopEntry {
  id: string;
  typeId: string;
  name: string;
  category: string;
  /** Zero disables buying. */
  buyPrice: number;
  /** Zero disables selling. */
  sellPrice: number;
  amount: number;
}

export interface AuctionLot {
  id: string;
  sellerId: string;
  sellerName: string;
  typeId: string;
  amount: number;
  price: number;
  listedAt: number;
}

export const shopItems = new Table<ShopEntry>('adm:shop');
export const auctions = new Table<AuctionLot>('adm:auctions');

function seed(typeId: string, category: string, buy: number, sell: number, amount = 1): ShopEntry {
  return { id: typeId.replace('minecraft:', ''), typeId, name: prettyItemName(typeId), category, buyPrice: buy, sellPrice: sell, amount };
}

export function ensureDefaultShop(): void {
  if (shopItems.size > 0) return;
  const catalog: ShopEntry[] = [
    seed('minecraft:oak_log', 'Blocks', 12, 4, 8),
    seed('minecraft:stone', 'Blocks', 6, 2, 16),
    seed('minecraft:glass', 'Blocks', 10, 3, 8),
    seed('minecraft:iron_ingot', 'Resources', 45, 18),
    seed('minecraft:gold_ingot', 'Resources', 70, 28),
    seed('minecraft:diamond', 'Resources', 400, 160),
    seed('minecraft:emerald', 'Resources', 320, 130),
    seed('minecraft:netherite_ingot', 'Resources', 4000, 1600),
    seed('minecraft:coal', 'Resources', 15, 5, 4),
    seed('minecraft:bread', 'Food', 8, 3, 4),
    seed('minecraft:cooked_beef', 'Food', 14, 5, 4),
    seed('minecraft:golden_apple', 'Food', 250, 90),
    seed('minecraft:iron_pickaxe', 'Tools', 120, 0),
    seed('minecraft:diamond_pickaxe', 'Tools', 900, 0),
    seed('minecraft:diamond_sword', 'Tools', 850, 0),
    seed('minecraft:bow', 'Tools', 150, 0),
    seed('minecraft:arrow', 'Tools', 3, 1, 16),
    seed('minecraft:wheat_seeds', 'Farming', 5, 1, 8),
    seed('minecraft:bone_meal', 'Farming', 8, 2, 8),
    seed('minecraft:torch', 'Misc', 4, 1, 16),
    seed('minecraft:ender_pearl', 'Misc', 180, 60),
  ];
  for (const entry of catalog) shopItems.set(entry.id, entry);
}

export function categories(): string[] {
  return [...new Set(shopItems.values().map((entry) => entry.category))].sort();
}

export function itemsIn(category: string): ShopEntry[] {
  return shopItems.values().filter((entry) => entry.category === category);
}

/** Buys `entry` for the player. Returns an error string, or undefined on success. */
export function buy(player: Player, entry: ShopEntry, bundles = 1): string | undefined {
  if (entry.buyPrice <= 0) return 'That item is not for sale.';
  const profile = profileOf(player);
  const cost = entry.buyPrice * bundles;
  const stack = makeStack(entry.typeId, entry.amount * bundles);
  if (!stack) return 'That item no longer exists in this version.';
  if (!charge(profile, cost)) return `You need ${money(cost)}.`;
  giveItem(player, stack);
  return undefined;
}

/** Sells `bundles` worth of an entry from the player's inventory. */
export function sell(player: Player, entry: ShopEntry, bundles = 1): string | undefined {
  if (entry.sellPrice <= 0) return 'That item cannot be sold here.';
  const wanted = entry.amount * bundles;
  if (countItem(player, entry.typeId) < wanted) return `You need ${wanted}x ${entry.name}.`;
  const removed = removeItem(player, entry.typeId, wanted);
  const payout = Math.round((entry.sellPrice * removed) / entry.amount);
  addMoney(profileOf(player), payout);
  return undefined;
}

export function install(): void {
  ensureDefaultShop();

  register({
    name: 'shop',
    description: 'Browse the server shop.',
    category: 'Economy',
    permission: 'shop.use',
    args: [{ name: 'category', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      if (!args[0]) {
        tell(player, `${C.title}Shop categories`);
        for (const category of categories()) {
          player.sendMessage(`  ${C.accent}${category} ${C.dim}(${itemsIn(category).length} items)`);
        }
        player.sendMessage(`${C.dim}Open the Member menu for the full shop UI.`);
        return;
      }
      const needle = args[0].toLowerCase();
      const list = shopItems.values().filter((entry) => entry.category.toLowerCase() === needle);
      if (list.length === 0) return err(player, 'No such category.');
      tell(player, `${C.title}${args[0]}`);
      for (const entry of list) {
        const buyText = entry.buyPrice > 0 ? `${C.good}buy ${money(entry.buyPrice)}` : `${C.dim}no buy`;
        const sellText = entry.sellPrice > 0 ? `${C.warn}sell ${money(entry.sellPrice)}` : `${C.dim}no sell`;
        player.sendMessage(`  ${C.white}${entry.amount}x ${entry.name} ${C.dim}- ${buyText} ${C.dim}| ${sellText}`);
      }
    },
  });

  register({
    name: 'sellhand',
    description: 'Sell the stack you are holding.',
    category: 'Economy',
    permission: 'shop.use',
    handler: ({ player }) => {
      const equipment = player.getComponent('minecraft:equippable');
      const held = equipment?.getEquipment(EquipmentSlot.Mainhand);
      if (!held) return err(player, 'You are not holding anything.');
      const entry = shopItems.values().find((item) => item.typeId === held.typeId);
      if (!entry || entry.sellPrice <= 0) return err(player, 'That item cannot be sold.');

      const bundles = Math.floor(held.amount / entry.amount);
      if (bundles < 1) return err(player, `You need at least ${entry.amount} of them.`);
      const problem = sell(player, entry, bundles);
      if (problem) return err(player, problem);
      ok(player, `Sold for ${money(entry.sellPrice * bundles)}.`);
    },
  });

  register({
    name: 'shopadd',
    description: 'Admin: add an item to the shop.',
    category: 'Economy',
    permission: 'shop.admin',
    args: [
      { name: 'itemId', type: 'string' },
      { name: 'category', type: 'string' },
      { name: 'buy', type: 'int' },
      { name: 'sell', type: 'int' },
      { name: 'amount', type: 'int', optional: true },
    ],
    handler: ({ player, args }) => {
      const typeId = (args[0] ?? '').includes(':') ? args[0] : `minecraft:${args[0]}`;
      if (!makeStack(typeId)) return err(player, `"${typeId}" is not a valid item id.`);
      const id = typeId.replace('minecraft:', '');
      shopItems.set(id, {
        id,
        typeId,
        name: prettyItemName(typeId),
        category: args[1] ?? 'Misc',
        buyPrice: Number.parseInt(args[2] ?? '0', 10) || 0,
        sellPrice: Number.parseInt(args[3] ?? '0', 10) || 0,
        amount: Number.parseInt(args[4] ?? '1', 10) || 1,
      });
      ok(player, `${prettyItemName(typeId)} added to the shop.`);
    },
  });

  register({
    name: 'shopremove',
    description: 'Admin: remove a shop item.',
    category: 'Economy',
    permission: 'shop.admin',
    args: [{ name: 'itemId', type: 'string' }],
    handler: ({ player, args }) => {
      const id = (args[0] ?? '').replace('minecraft:', '');
      if (!shopItems.delete(id)) return err(player, 'That item is not in the shop.');
      ok(player, 'Removed from the shop.');
    },
  });

  /* Auction house ------------------------------------------------------ */

  register({
    name: 'ah',
    aliases: ['auction'],
    description: 'Auction house: ah | ah sell <price> | ah buy <id>',
    category: 'Economy',
    permission: 'auction.use',
    args: [
      { name: 'action', type: 'string', optional: true },
      { name: 'value', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const action = (args[0] ?? 'list').toLowerCase();

      if (action === 'list') {
        const lots = auctions.values();
        if (lots.length === 0) return tell(player, `${C.dim}Nothing is listed right now.`);
        tell(player, `${C.title}Auction house`);
        for (const lot of lots) {
          player.sendMessage(
            `  ${C.accent}${lot.id} ${C.white}${lot.amount}x ${prettyItemName(lot.typeId)} ${C.dim}- ${money(lot.price)} from ${lot.sellerName}`,
          );
        }
        return;
      }

      if (action === 'sell') {
        const price = Number.parseInt(args[1] ?? '', 10);
        if (!Number.isFinite(price) || price <= 0) return err(player, 'Give a price above zero.');
        const equipment = player.getComponent('minecraft:equippable');
        const held = equipment?.getEquipment(EquipmentSlot.Mainhand);
        if (!held) return err(player, 'Hold the item you want to sell.');

        const id = uid().slice(-5);
        auctions.set(id, {
          id,
          sellerId: player.id,
          sellerName: player.name,
          typeId: held.typeId,
          amount: held.amount,
          price,
          listedAt: now(),
        });
        removeItem(player, held.typeId, held.amount);
        return ok(player, `Listed ${held.amount}x ${prettyItemName(held.typeId)} for ${money(price)} (id ${id}).`);
      }

      if (action === 'buy') {
        const lot = auctions.get(args[1] ?? '');
        if (!lot) return err(player, 'No listing with that id.');
        if (lot.sellerId === player.id) return err(player, 'That is your own listing - use ah cancel.');
        const profile = profileOf(player);
        if (!charge(profile, lot.price)) return err(player, `You need ${money(lot.price)}.`);

        const stack = makeStack(lot.typeId, lot.amount);
        if (!stack) {
          addMoney(profile, lot.price);
          return err(player, 'That item could not be delivered.');
        }
        giveItem(player, stack);
        auctions.delete(lot.id);

        const seller = profiles.get(lot.sellerId);
        if (seller) {
          addMoney(seller, lot.price);
          const online = onlinePlayer(seller);
          if (online) tell(online, `${C.good}${player.name} bought your ${prettyItemName(lot.typeId)} for ${money(lot.price)}.`);
        }
        return ok(player, `Bought ${lot.amount}x ${prettyItemName(lot.typeId)}.`);
      }

      if (action === 'cancel') {
        const lot = auctions.get(args[1] ?? '');
        if (!lot) return err(player, 'No listing with that id.');
        if (lot.sellerId !== player.id) return err(player, 'That is not your listing.');
        const stack = makeStack(lot.typeId, lot.amount);
        if (stack) giveItem(player, stack);
        auctions.delete(lot.id);
        return ok(player, 'Listing cancelled and item returned.');
      }

      err(player, 'Use: ah list | ah sell <price> | ah buy <id> | ah cancel <id>');
    },
  });

  register({
    name: 'deposit',
    description: 'Sell every sellable item in your inventory.',
    category: 'Economy',
    permission: 'shop.use',
    handler: ({ player }) => {
      let earned = 0;
      for (const entry of shopItems.values()) {
        if (entry.sellPrice <= 0) continue;
        const held = countItem(player, entry.typeId);
        const bundles = Math.floor(held / entry.amount);
        if (bundles < 1) continue;
        const removed = removeItem(player, entry.typeId, bundles * entry.amount);
        earned += Math.round((entry.sellPrice * removed) / entry.amount);
      }
      if (earned === 0) return err(player, 'You have nothing the shop buys.');
      addMoney(profileOf(player), earned);
      ok(player, `Sold everything for ${money(earned)}. Balance: ${money(balanceOf(profileOf(player)))}`);
    },
  });

  register({
    name: 'givemoneyall',
    description: 'Admin: give money to every online player.',
    category: 'Economy',
    permission: 'economy.admin',
    args: [{ name: 'amount', type: 'int' }],
    handler: ({ player, args }) => {
      const amount = Number.parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(amount)) return err(player, 'Give a number.');
      let count = 0;
      for (const online of world.getAllPlayers()) {
        const profile = profileByName(online.name);
        if (!profile) continue;
        addMoney(profile, amount);
        count++;
      }
      ok(player, `Gave ${money(amount)} to ${count} players.`);
    },
  });
}
