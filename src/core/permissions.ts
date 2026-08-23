import { Player } from '@minecraft/server';
import { Table } from './storage';
import { profileOf, profiles, Profile } from './profiles';

/**
 * Role-based permissions.
 *
 * Permission nodes are dot-separated (`players.ban`). A role may hold an exact
 * node, a prefix wildcard (`players.*`) or the root wildcard (`*`). A player's
 * effective permissions are the union of every role they hold; the highest
 * `priority` role supplies their chat prefix and colour.
 */

export interface Role {
  id: string;
  name: string;
  prefix: string;
  color: string;
  priority: number;
  permissions: string[];
  /** Roles marked default are granted to every player automatically. */
  isDefault?: boolean;
}

/** Catalogue of every permission node the suite checks, grouped for the UI. */
export const PERMISSION_GROUPS: Record<string, string[]> = {
  General: ['menu.admin', 'menu.member', 'bypass.protection', 'bypass.cooldown', 'bypass.quota'],
  Players: [
    'players.view',
    'players.teleport',
    'players.gamemode',
    'players.inventory',
    'players.enderchest',
    'players.heal',
    'players.kill',
    'players.clear',
    'players.give',
  ],
  Moderation: [
    'mod.kick',
    'mod.ban',
    'mod.unban',
    'mod.mute',
    'mod.freeze',
    'mod.vanish',
    'mod.spy',
    'mod.reports',
  ],
  World: [
    'world.time',
    'world.weather',
    'world.difficulty',
    'world.gamerule',
    'world.border',
    'world.entities',
  ],
  Economy: ['economy.balance', 'economy.pay', 'economy.admin', 'shop.use', 'shop.admin', 'auction.use'],
  Teleport: ['tp.home', 'tp.warp', 'tp.warp.admin', 'tp.tpa', 'tp.rtp', 'tp.back'],
  Land: ['land.claim', 'land.admin'],
  Progression: ['ranks.admin', 'skills.use', 'jobs.use', 'quests.use', 'quests.admin'],
  Content: ['npc.admin', 'hologram.admin', 'kit.admin', 'redeem.admin', 'broadcast.admin', 'cosmetic.admin', 'cosmetic.staff'],
  Social: ['clan.use', 'clan.admin', 'duel.use'],
  Server: ['server.settings', 'server.roles', 'server.data'],
};

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSION_GROUPS).flat();

export const roles = new Table<Role>('adm:roles');

/** Seeds the standard role ladder the first time the pack runs. */
export function ensureDefaultRoles(): void {
  if (roles.size > 0) return;
  const seed: Role[] = [
    { id: 'owner', name: 'Owner', prefix: '§4[Owner]', color: '§c', priority: 100, permissions: ['*'] },
    {
      id: 'admin',
      name: 'Admin',
      prefix: '§c[Admin]',
      color: '§c',
      priority: 80,
      permissions: [
        'menu.admin', 'players.*', 'mod.*', 'world.*', 'economy.*', 'tp.*',
        'land.admin', 'npc.admin', 'hologram.admin', 'kit.admin', 'redeem.admin',
        'broadcast.admin', 'quests.admin', 'ranks.admin', 'bypass.*', 'shop.admin',
      ],
    },
    {
      id: 'mod',
      name: 'Mod',
      prefix: '§9[Mod]',
      color: '§9',
      priority: 60,
      permissions: [
        'menu.admin', 'players.view', 'players.teleport', 'mod.kick', 'mod.mute',
        'mod.freeze', 'mod.vanish', 'mod.spy', 'mod.reports', 'world.time', 'world.weather',
      ],
    },
    {
      id: 'builder',
      name: 'Builder',
      prefix: '§a[Builder]',
      color: '§a',
      priority: 40,
      permissions: ['menu.admin', 'players.gamemode', 'world.time', 'world.weather', 'hologram.admin'],
    },
    {
      id: 'member',
      name: 'Member',
      prefix: '§7[Member]',
      color: '§7',
      priority: 0,
      isDefault: true,
      permissions: [
        'menu.member', 'economy.balance', 'economy.pay', 'shop.use', 'auction.use',
        'tp.home', 'tp.warp', 'tp.tpa', 'tp.rtp', 'tp.back', 'land.claim',
        'skills.use', 'jobs.use', 'quests.use', 'clan.use', 'duel.use',
      ],
    },
  ];
  for (const role of seed) roles.set(role.id, role);
}

export function defaultRoles(): Role[] {
  return roles.values().filter((r) => r.isDefault);
}

/** Every role a player holds, including default roles, highest priority first. */
export function rolesOf(profile: Profile): Role[] {
  const held = profile.roles
    .map((id) => roles.get(id))
    .filter((role): role is Role => role !== undefined);
  for (const role of defaultRoles()) {
    if (!held.some((r) => r.id === role.id)) held.push(role);
  }
  return held.sort((a, b) => b.priority - a.priority);
}

export function topRole(profile: Profile): Role | undefined {
  return rolesOf(profile)[0];
}

function nodeMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (!granted.endsWith('*')) return false;
  // `players.*` matches `players.ban`; `*` is handled above.
  const stem = granted.slice(0, -1);
  return required.startsWith(stem);
}

/**
 * True when the player may use `node`.
 *
 * The `admin` tag is a bootstrap escape hatch so a fresh world always has
 * someone who can open the suite and build out the role ladder.
 */
export function can(player: Player, node: string): boolean {
  if (player.hasTag('admin')) return true;
  const profile = profileOf(player);
  for (const role of rolesOf(profile)) {
    for (const granted of role.permissions) {
      if (nodeMatches(granted, node)) return true;
    }
  }
  return false;
}

/** True when the player bypasses land/protection checks. */
export function bypasses(player: Player): boolean {
  return player.hasTag('bypass') || can(player, 'bypass.protection');
}

export function grantRole(profile: Profile, roleId: string): boolean {
  if (!roles.has(roleId) || profile.roles.includes(roleId)) return false;
  profile.roles.push(roleId);
  profiles.markDirty();
  return true;
}

export function revokeRole(profile: Profile, roleId: string): boolean {
  const index = profile.roles.indexOf(roleId);
  if (index === -1) return false;
  profile.roles.splice(index, 1);
  profiles.markDirty();
  return true;
}

/** Removes a role from every profile, used when a role is deleted. */
export function purgeRole(roleId: string): void {
  for (const profile of profiles.values()) {
    const index = profile.roles.indexOf(roleId);
    if (index !== -1) profile.roles.splice(index, 1);
  }
  profiles.markDirty();
  roles.delete(roleId);
}
