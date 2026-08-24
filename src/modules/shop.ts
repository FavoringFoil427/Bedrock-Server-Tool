import { EquipmentSlot, Player, world } from '@minecraft/server';
import { can } from '../core/permissions';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { profileByName, profileOf, profiles, onlinePlayer } from '../core/profiles';
import { countItem, giveItem, makeStack, prettyItemName, removeItem } from '../core/items';
import { C, err, now, ok, tell, uid } from '../core/util';
import { cfg } from '../core/config';
import { addMoney, balanceOf, charge, money } from './economy';

/**
 * The shop, holding two kinds of listing.
 *
 * A *server* listing is created by staff and has unlimited stock: it both sells
 * to players and buys from them at fixed prices, acting as the economy's faucet
 * and sink.
 *
 * A *player* listing is created by anyone and is backed by real stock, taken
 * from the lister's inventory when they create it. Buyers pay the lister and
 * the stock falls; when it runs out the listing disappears. This is the reason
 * players set a price on what they sell but never on what the shop buys: a
 * player-set buy-back price would let anyone list dirt at a fortune and sell it
 * to the server forever.
 */

export interface ShopEntry {
  id: string;
  typeId: string;
  name: string;
  category: string;
  /** Zero disables buying. */
  buyPrice: number;
  /** Zero disables selling. Only meaningful on server listings. */
  sellPrice: number;
  amount: number;
  /** Set on player listings; absent means this is a server listing. */
  sellerId?: string;
  sellerName?: string;
  /** Bundles remaining. Only present on player listings. */
  stock?: number;
  listedAt?: number;
}

/** Price of a single item, for comparing listings with different bundle sizes. */
export function unitPrice(entry: ShopEntry): number {
  return Math.ceil(entry.buyPrice / Math.max(1, entry.amount));
}

/** True when the listing is stocked and owned by a player. */
export function isPlayerListing(entry: ShopEntry): entry is ShopEntry & { sellerId: string; stock: number } {
  return entry.sellerId !== undefined;
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

export function categories(): string[] {
  return [...new Set(shopItems.values().map((entry) => entry.category))].sort();
}

export function itemsIn(category: string): ShopEntry[] {
  return shopItems.values().filter((entry) => entry.category === category);
}

/** Buys `entry` for the player. Returns an error string, or undefined on success. */
export function buy(player: Player, entry: ShopEntry, bundles = 1): string | undefined {
  if (entry.buyPrice <= 0) return 'That item is not for sale.';
  if (isPlayerListing(entry)) {
    if (entry.sellerId === player.id) return 'That is your own listing.';
    if (entry.stock < bundles) return `Only ${entry.stock} left.`;
  }

  const profile = profileOf(player);
  const cost = entry.buyPrice * bundles;
  const stack = makeStack(entry.typeId, entry.amount * bundles);
  if (!stack) return 'That item no longer exists in this version.';
  if (!charge(profile, cost)) return `You need ${money(cost)}.`;
  giveItem(player, stack);

  if (isPlayerListing(entry)) {
    entry.stock -= bundles;
    const seller = profiles.get(entry.sellerId);
    if (seller) {
      // The server may take a cut, which gives the economy a sink.
      const fee = Math.round((cost * cfg().marketFeePercent) / 100);
      addMoney(seller, cost - fee);
      const online = onlinePlayer(seller);
      if (online) {
        tell(online, `${C.good}${player.name} bought ${bundles}x ${entry.name} for ${money(cost - fee)}.`);
      }
    }
    if (entry.stock <= 0) shopItems.delete(entry.id);
    else shopItems.markDirty();
  }
  return undefined;
}

/** Listings owned by a player. */
export function listingsOf(playerId: string): ShopEntry[] {
  return shopItems.values().filter((entry) => entry.sellerId === playerId);
}

/**
 * Creates a player listing from the held stack.
 * Returns an error string, or undefined on success.
 */
export function listForSale(
  player: Player,
  price: number,
  bundleSize: number,
  bundles: number,
  category: string,
): string | undefined {
  const config = cfg();
  if (!config.playerListingsEnabled) return 'Player listings are disabled on this server.';
  if (price <= 0) return 'Set a price above zero.';
  if (config.maxListingPrice > 0 && price > config.maxListingPrice) {
    return `The most you can charge per bundle is ${money(config.maxListingPrice)}.`;
  }
  if (bundleSize < 1 || bundles < 1) return 'Give a valid amount.';

  const held = player.getComponent('minecraft:equippable')?.getEquipment(EquipmentSlot.Mainhand);
  if (!held) return 'Hold the item you want to sell.';

  const mine = listingsOf(player.id);
  if (mine.length >= config.maxListingsPerPlayer && !can(player, 'shop.admin')) {
    return `You can only have ${config.maxListingsPerPlayer} listings at once.`;
  }

  const wanted = bundleSize * bundles;
  if (countItem(player, held.typeId) < wanted) return `You need ${wanted}x ${prettyItemName(held.typeId)}.`;

  const taken = removeItem(player, held.typeId, wanted);
  if (taken < wanted) {
    // Put back whatever was pulled before giving up, so nothing is lost.
    const refund = makeStack(held.typeId, taken);
    if (refund) giveItem(player, refund);
    return 'Could not take the items from your inventory.';
  }

  const id = `p_${uid()}`;
  shopItems.set(id, {
    id,
    typeId: held.typeId,
    name: prettyItemName(held.typeId),
    category: category || 'Player Stalls',
    buyPrice: price,
    sellPrice: 0,
    amount: bundleSize,
    sellerId: player.id,
    sellerName: player.name,
    stock: bundles,
    listedAt: now(),
  });
  return undefined;
}

/**
 * Cancels a player listing. The stock always goes back to whoever listed it,
 * never to the staff member removing it. If that owner is offline the items
 * cannot be handed over, so they are paid the listed value instead rather than
 * having their stock quietly destroyed.
 */
export function unlist(player: Player, entry: ShopEntry): string | undefined {
  if (!isPlayerListing(entry)) return 'That is a server listing.';
  const isOwner = entry.sellerId === player.id;
  if (!isOwner && !can(player, 'shop.admin')) return 'That is not your listing.';

  const owner = profiles.get(entry.sellerId);
  const recipient = isOwner ? player : owner ? onlinePlayer(owner) : undefined;

  if (recipient) {
    let remaining = entry.stock * entry.amount;
    while (remaining > 0) {
      const size = Math.min(64, remaining);
      const stack = makeStack(entry.typeId, size);
      if (!stack) break;
      giveItem(recipient, stack);
      remaining -= size;
    }
    if (!isOwner) tell(recipient, `${C.warn}Your listing of ${entry.name} was removed by staff.`);
  } else if (owner) {
    addMoney(owner, entry.buyPrice * entry.stock);
  }
  shopItems.delete(entry.id);
  return undefined;
}

/** Sells `bundles` worth of an entry from the player's inventory. */
export function sell(player: Player, entry: ShopEntry, bundles = 1): string | undefined {
  // Only the server buys items; a player listing is stock, not a buy order.
  if (isPlayerListing(entry) || entry.sellPrice <= 0) return 'That item cannot be sold here.';
  const wanted = entry.amount * bundles;
  if (countItem(player, entry.typeId) < wanted) return `You need ${wanted}x ${entry.name}.`;
  const removed = removeItem(player, entry.typeId, wanted);
  const payout = Math.round((entry.sellPrice * removed) / entry.amount);
  addMoney(profileOf(player), payout);
  return undefined;
}

export function install(): void {

  register({
    name: 'shop',
    description: 'Browse the shop.',
    category: 'Economy',
    permission: 'shop.use',
    // Categories may contain spaces, so the name swallows the rest of the line.
    greedy: true,
    args: [{ name: 'category', type: 'string', optional: true }],
    handler: ({ player, args }) => {
      if (shopItems.size === 0) {
        tell(player, `${C.dim}The shop is empty.`);
        if (can(player, 'shop.admin')) {
          player.sendMessage(`${C.dim}Add the item you are holding with ${C.accent}!shopadd hand <category> <buy> <sell>`);
        }
        return;
      }
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
    name: 'listitem',
    aliases: ['stall'],
    description: 'List the item you are holding for sale at your own price.',
    category: 'Economy',
    permission: 'shop.sell',
    args: [
      { name: 'price', type: 'int' },
      { name: 'bundleSize', type: 'int', optional: true },
      { name: 'bundles', type: 'int', optional: true },
    ],
    handler: ({ player, args }) => {
      const price = Number.parseInt(args[0] ?? '', 10);
      const bundleSize = Number.parseInt(args[1] ?? '1', 10) || 1;
      const bundles = Number.parseInt(args[2] ?? '1', 10) || 1;
      if (!Number.isFinite(price)) return err(player, 'Give a price.');

      const problem = listForSale(player, price, bundleSize, bundles, 'Player Stalls');
      if (problem) return err(player, problem);
      ok(player, `Listed ${bundles}x (${bundleSize} per bundle) at ${money(price)} each.`);
    },
  });

  register({
    name: 'mylistings',
    description: 'Show the items you have listed for sale.',
    category: 'Economy',
    permission: 'shop.sell',
    handler: ({ player }) => {
      const mine = listingsOf(player.id);
      if (mine.length === 0) return tell(player, `${C.dim}You have nothing listed.`);
      tell(player, `${C.title}Your listings`);
      for (const entry of mine) {
        player.sendMessage(
          `  ${C.accent}${entry.id} ${C.white}${entry.amount}x ${entry.name} ${C.dim}- ${money(entry.buyPrice)} each, ${entry.stock} left`,
        );
      }
      player.sendMessage(`${C.dim}Use !unlist <id> to take one down.`);
    },
  });

  register({
    name: 'unlist',
    description: 'Take down one of your listings and get the stock back.',
    category: 'Economy',
    permission: 'shop.sell',
    args: [{ name: 'id', type: 'string' }],
    handler: ({ player, args }) => {
      const entry = shopItems.get(args[0] ?? '');
      if (!entry) return err(player, 'No listing with that id.');
      const problem = unlist(player, entry);
      if (problem) return err(player, problem);
      ok(player, 'Listing removed and stock returned.');
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
      if (!entry) return err(player, 'The shop does not buy that. An admin can add it with !shopadd.');
      if (entry.sellPrice <= 0) return err(player, 'That item cannot be sold.');

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
      // "hand" is a shortcut for whatever the admin is currently holding.
      const raw = args[0] ?? '';
      const held = player.getComponent('minecraft:equippable')?.getEquipment(EquipmentSlot.Mainhand);
      const source = raw.toLowerCase() === 'hand' ? held?.typeId : raw;
      if (!source) return err(player, 'Hold an item, or give its id.');
      const typeId = source.includes(':') ? source : `minecraft:${source}`;
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
