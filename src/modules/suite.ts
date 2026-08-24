import { Player, system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { can } from '../core/permissions';
import { giveItem, makeStack } from '../core/items';
import { C, err, ok, tell } from '../core/util';
import { openAdminMenu } from '../menus/admin';
import { openMemberMenu } from '../menus/member';
import { profileOf, profiles } from '../core/profiles';

/** The two menu items and the commands that hand them out. */

export const ADMIN_ITEM = 'adm:admin_suite';
export const MEMBER_ITEM = 'adm:member_book';

function giveSuiteItem(player: Player, typeId: string): boolean {
  const stack = makeStack(typeId, 1);
  if (!stack) return false;
  giveItem(player, stack);
  return true;
}

/** Gives the member book once, the first time a player joins. */
export function grantMemberBook(player: Player): void {
  const profile = profileOf(player);
  if (profile.gotMemberBook) return;
  profile.gotMemberBook = true;
  profiles.markDirty();
  giveSuiteItem(player, MEMBER_ITEM);
}

export function install(): void {
  register({
    name: 'suite',
    aliases: ['adminmenu', 'panel'],
    description: 'Open the admin panel.',
    category: 'General',
    permission: 'menu.admin',
    handler: ({ player }) => void openAdminMenu(player),
  });

  register({
    name: 'menu',
    description: 'Open the player menu.',
    category: 'General',
    handler: ({ player }) => void openMemberMenu(player),
  });

  register({
    name: 'getsuite',
    description: 'Give yourself the Admin Suite item.',
    category: 'General',
    permission: 'menu.admin',
    handler: ({ player }) => {
      if (!giveSuiteItem(player, ADMIN_ITEM)) return err(player, 'The Admin Suite item is missing from the pack.');
      ok(player, 'Admin Suite item added to your inventory.');
    },
  });

  register({
    name: 'getbook',
    description: 'Give yourself the Member Suite book.',
    category: 'General',
    handler: ({ player }) => {
      if (!giveSuiteItem(player, MEMBER_ITEM)) return err(player, 'The Member Suite item is missing from the pack.');
      ok(player, 'Member Suite book added to your inventory.');
    },
  });

  register({
    name: 'give',
    description: 'Admin: give an item to a player.',
    category: 'Players',
    permission: 'players.give',
    args: [
      { name: 'player', type: 'player' },
      { name: 'item', type: 'string' },
      { name: 'amount', type: 'int', optional: true },
    ],
    handler: ({ player, args }) => {
      const needle = (args[0] ?? '').toLowerCase();
      const target = world.getAllPlayers().find((p) => p.name.toLowerCase() === needle);
      if (!target) return err(player, 'That player is not online.');

      const typeId = (args[1] ?? '').includes(':') ? args[1] : `minecraft:${args[1]}`;
      const stack = makeStack(typeId, Number.parseInt(args[2] ?? '1', 10) || 1);
      if (!stack) return err(player, `"${typeId}" is not a valid item.`);
      giveItem(target, stack);
      ok(player, `Gave ${stack.amount}x ${typeId.replace('minecraft:', '')} to ${target.name}.`);
    },
  });

  /**
   * Opens the menu bound to a suite item. Returns true when the item was one
   * of ours, so the caller can swallow the interaction.
   */
  const openFor = (player: Player, typeId: string | undefined): boolean => {
    if (typeId === ADMIN_ITEM) {
      if (!can(player, 'menu.admin')) {
        tell(player, `${C.bad}You do not have permission to use this.`);
        return true;
      }
      void openAdminMenu(player);
      return true;
    }
    if (typeId === MEMBER_ITEM) {
      void openMemberMenu(player);
      return true;
    }
    return false;
  };

  // Using the item while aiming at air.
  world.afterEvents.itemUse.subscribe((event) => {
    openFor(event.source, event.itemStack.typeId);
  });

  /*
   * Using it while aiming at a block raises this instead of itemUse, which is
   * what happens most of the time in practice. Without this the menu would
   * only open when the player happened to be facing the sky.
   */
  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const typeId = event.itemStack?.typeId;
    if (typeId !== ADMIN_ITEM && typeId !== MEMBER_ITEM) return;
    // Stop the item being placed or the block being activated.
    event.cancel = true;
    const player = event.player;
    system.run(() => openFor(player, typeId));
  });

  // Same again for aiming at an entity, so the menu is never swallowed.
  world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    const typeId = event.itemStack?.typeId;
    if (typeId !== ADMIN_ITEM && typeId !== MEMBER_ITEM) return;
    // NPCs have their own menu; opening both at once would fight for the screen.
    if (event.target.typeId === 'adm:npc') return;
    event.cancel = true;
    const player = event.player;
    system.run(() => openFor(player, typeId));
  });
}
