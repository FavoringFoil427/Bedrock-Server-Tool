import { GameMode, Player, world } from '@minecraft/server';
import { menu, paged, prompt, askText, confirm } from '../core/ui';
import { cfg, saveConfig } from '../core/config';
import { Profile, profileOf, profiles } from '../core/profiles';
import {
  PERMISSION_GROUPS,
  Role,
  ensureDefaultRoles,
  grantRole,
  purgeRole,
  revokeRole,
  roles,
  rolesOf,
} from '../core/permissions';
import { C, err, formatDuration, ok, parseDuration, tell } from '../core/util';
import { addMoney, balanceOf, money, setMoney } from '../modules/economy';
import { activeBan, bans, banProfile, kickPlayer, reports, setFrozen, setVanished } from '../modules/moderation';
import { cleanEntities, setTime, setWeather } from '../modules/worldtools';
import { holograms } from '../modules/display';
import { warps } from '../modules/teleport';
import { claims } from '../modules/land';
import { shopItems } from '../modules/shop';
import { codes, kits } from '../modules/rewards';
import { ladder } from '../modules/ranks';
import { availableLocales } from '../core/i18n';
import { inventoryOf } from '../core/items';
import { openVaultFor } from '../modules/vault';

/** The staff menu opened by the Admin Suite item. */

export async function openAdminMenu(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Admin Suite`,
    body: `${C.dim}${cfg().serverName} - ${world.getAllPlayers().length} online`,
    buttons: [
      { text: `${C.accent}Players`, icon: 'textures/ui/icon_multiplayer', onClick: () => openPlayers(player) },
      { text: `${C.bad}Moderation`, icon: 'textures/ui/icon_lock', onClick: () => openModeration(player) },
      { text: `${C.good}World`, icon: 'textures/ui/icon_recipe_nature', onClick: () => openWorld(player) },
      { text: `${C.gold}Economy`, icon: 'textures/ui/icon_bundle', onClick: () => openEconomy(player) },
      { text: `${C.accent}Roles & Permissions`, icon: 'textures/ui/icon_setting', onClick: () => openRoles(player) },
      { text: `${C.warn}Content`, icon: 'textures/ui/icon_book_writable', onClick: () => openContent(player) },
      { text: `${C.dim}Server Settings`, icon: 'textures/ui/icon_setting', onClick: () => openSettings(player) },
      { text: `${C.dim}Data & Stats`, icon: 'textures/ui/icon_recipe_item', onClick: () => openData(player) },
    ],
  });
}

/* ------------------------------------------------------------------ players */

async function openPlayers(player: Player): Promise<void> {
  const online = world.getAllPlayers();
  await paged(player, {
    title: `${C.title}Players`,
    body: `${C.dim}${online.length} online, ${profiles.size} known`,
    items: profiles.values().sort((a, b) => a.name.localeCompare(b.name)),
    render: (profile) => {
      const isOnline = online.some((p) => p.id === profile.id);
      return {
        text: `${isOnline ? C.good : C.dim}${profile.name}\n${C.dim}${isOnline ? 'online' : 'offline'} - ${money(balanceOf(profile))}`,
      };
    },
    onPick: (profile) => openPlayer(player, profile),
    back: () => openAdminMenu(player),
  });
}

async function openPlayer(admin: Player, profile: Profile): Promise<void> {
  const target = world.getAllPlayers().find((p) => p.id === profile.id);
  const ban = activeBan(profile.id);
  const roleNames = rolesOf(profile).map((r) => r.name).join(', ');

  const body = [
    `${C.dim}Status: ${target ? `${C.good}online` : `${C.dim}offline`}`,
    `${C.dim}Roles: ${C.white}${roleNames || 'none'}`,
    `${C.dim}Balance: ${C.good}${money(balanceOf(profile))}`,
    `${C.dim}Playtime: ${C.white}${formatDuration(profile.playtimeMs)}`,
    `${C.dim}K/D: ${C.white}${profile.stats.kills}/${profile.stats.deaths}`,
    ban ? `${C.bad}BANNED: ${ban.reason}` : '',
    profile.muteUntil !== undefined ? `${C.warn}Muted` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const buttons = [
    { text: `${C.accent}Manage roles`, onClick: () => openPlayerRoles(admin, profile) },
    { text: `${C.gold}Adjust balance`, onClick: () => openBalanceEditor(admin, profile) },
    { text: `${C.accent}View vault`, onClick: async () => openVaultFor(admin, profile) },
  ];

  if (target) {
    buttons.push(
      {
        text: `${C.accent}Teleport to them`,
        onClick: async () => {
          admin.teleport(target.location, { dimension: target.dimension });
          ok(admin, `Teleported to ${profile.name}.`);
        },
      },
      {
        text: `${C.accent}Bring them here`,
        onClick: async () => {
          target.teleport(admin.location, { dimension: admin.dimension });
          ok(admin, `Brought ${profile.name} to you.`);
        },
      },
      { text: `${C.good}Game mode`, onClick: () => openGameMode(admin, target) },
      { text: `${C.accent}View inventory`, onClick: () => openInventory(admin, target) },
      {
        text: `${C.good}Heal & feed`,
        onClick: async () => {
          const health = target.getComponent('minecraft:health');
          health?.resetToMaxValue();
          target.addEffect('saturation', 40, { amplifier: 5, showParticles: false });
          ok(admin, `Healed ${profile.name}.`);
        },
      },
      {
        text: `${C.warn}${profile.frozen ? 'Unfreeze' : 'Freeze'}`,
        onClick: async () => {
          setFrozen(target, !profile.frozen);
          ok(admin, `${profile.name} is now ${profile.frozen ? 'frozen' : 'unfrozen'}.`);
        },
      },
      {
        text: `${C.warn}${profile.vanished ? 'Unvanish' : 'Vanish'}`,
        onClick: async () => {
          setVanished(target, !profile.vanished);
          ok(admin, `${profile.name} is now ${profile.vanished ? 'hidden' : 'visible'}.`);
        },
      },
      {
        text: `${C.bad}Kick`,
        onClick: async () => {
          const reason = await askText(admin, 'Kick player', 'Reason', 'Behave yourself');
          kickPlayer(target.name, reason ?? 'No reason given');
          ok(admin, `Kicked ${profile.name}.`);
        },
      },
    );
  }

  buttons.push({
    text: ban ? `${C.good}Unban` : `${C.bad}Ban`,
    onClick: async () => {
      if (ban) {
        bans.delete(profile.id);
        return ok(admin, `Unbanned ${profile.name}.`);
      }
      const values = await prompt(admin, `Ban ${profile.name}`, [
        { kind: 'text', label: 'Reason', placeholder: 'Griefing' },
        { kind: 'text', label: 'Duration (30m, 2h, 7d, blank = permanent)', placeholder: '7d' },
      ]);
      if (!values) return;
      const duration = String(values[1]).trim() ? parseDuration(String(values[1])) : undefined;
      banProfile(profile, admin.name, String(values[0]) || 'No reason given', duration);
      ok(admin, `Banned ${profile.name}.`);
    },
  });

  buttons.push({
    text: profile.muteUntil !== undefined ? `${C.good}Unmute` : `${C.warn}Mute`,
    onClick: async () => {
      if (profile.muteUntil !== undefined) {
        delete profile.muteUntil;
        delete profile.muteReason;
        profiles.markDirty();
        return ok(admin, `Unmuted ${profile.name}.`);
      }
      const answer = await askText(admin, `Mute ${profile.name}`, 'Duration (30m, 2h, blank = permanent)', '30m');
      const duration = answer ? parseDuration(answer) : undefined;
      profile.muteUntil = duration === undefined ? 0 : Date.now() + duration;
      profile.muteReason = 'Muted by staff';
      profiles.markDirty();
      ok(admin, `Muted ${profile.name}.`);
    },
  });

  await menu(admin, {
    title: `${C.title}${profile.name}`,
    body,
    buttons,
    back: () => openPlayers(admin),
  });
}

async function openGameMode(admin: Player, target: Player): Promise<void> {
  const modes: [string, GameMode][] = [
    ['Survival', GameMode.Survival],
    ['Creative', GameMode.Creative],
    ['Adventure', GameMode.Adventure],
    ['Spectator', GameMode.Spectator],
  ];
  await menu(admin, {
    title: `${C.title}Game mode`,
    buttons: modes.map(([label, mode]) => ({
      text: `${C.accent}${label}`,
      onClick: async () => {
        target.setGameMode(mode);
        ok(admin, `${target.name} is now in ${label}.`);
      },
    })),
    back: () => openPlayer(admin, profileOf(target)),
  });
}

async function openInventory(admin: Player, target: Player): Promise<void> {
  const container = inventoryOf(target);
  if (!container) return err(admin, 'That player has no inventory.');

  const slots: { slot: number; label: string }[] = [];
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (item) slots.push({ slot, label: `${item.amount}x ${item.typeId.replace('minecraft:', '')}` });
  }

  await paged(admin, {
    title: `${C.title}${target.name}'s inventory`,
    body: `${C.dim}${slots.length} stacks - ${container.emptySlotsCount} empty slots`,
    items: slots,
    render: (entry) => ({ text: `${C.white}${entry.label}\n${C.dim}slot ${entry.slot}` }),
    onPick: async (entry) => {
      const yes = await confirm(admin, 'Remove item', `Delete ${entry.label} from ${target.name}?`);
      if (!yes) return;
      container.setItem(entry.slot, undefined);
      ok(admin, 'Item removed.');
    },
    back: () => openPlayer(admin, profileOf(target)),
  });
}

async function openPlayerRoles(admin: Player, profile: Profile): Promise<void> {
  await menu(admin, {
    title: `${C.title}Roles - ${profile.name}`,
    body: `${C.dim}Tap a role to grant or revoke it.`,
    buttons: roles.values().map((role) => {
      const held = profile.roles.includes(role.id);
      return {
        text: `${held ? C.good : C.dim}${held ? '[x] ' : '[ ] '}${role.name}`,
        onClick: async () => {
          if (held) revokeRole(profile, role.id);
          else grantRole(profile, role.id);
          await openPlayerRoles(admin, profile);
        },
      };
    }),
    back: () => openPlayer(admin, profile),
  });
}

async function openBalanceEditor(admin: Player, profile: Profile): Promise<void> {
  const values = await prompt(admin, `Balance - ${profile.name}`, [
    { kind: 'dropdown', label: 'Action', options: ['Give', 'Take', 'Set'] },
    { kind: 'text', label: 'Amount', placeholder: '1000' },
  ]);
  if (!values) return;
  const amount = Number.parseInt(String(values[1]), 10);
  if (!Number.isFinite(amount)) return err(admin, 'Give a valid number.');

  const action = Number(values[0]);
  if (action === 0) addMoney(profile, amount);
  else if (action === 1) addMoney(profile, -amount);
  else setMoney(profile, amount);
  ok(admin, `${profile.name} now has ${money(balanceOf(profile))}.`);
}

/* --------------------------------------------------------------- moderation */

async function openModeration(player: Player): Promise<void> {
  const open = reports.values().filter((r) => !r.handled);
  const active = bans.values().filter((b) => activeBan(b.id));

  await menu(player, {
    title: `${C.title}Moderation`,
    body: `${C.dim}${active.length} bans, ${open.length} open reports`,
    buttons: [
      {
        text: `${C.warn}Reports (${open.length})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Reports`,
            items: open,
            render: (report) => ({
              text: `${C.warn}${report.target}\n${C.dim}by ${report.reporter} - ${report.reason}`,
            }),
            onPick: async (report) => {
              const yes = await confirm(player, 'Resolve report', `Mark the report on ${report.target} as handled?`, `${C.good}Resolve`);
              if (!yes) return;
              report.handled = true;
              reports.markDirty();
              ok(player, 'Report resolved.');
            },
            back: () => openModeration(player),
          }),
      },
      {
        text: `${C.bad}Ban list (${active.length})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Bans`,
            items: active,
            render: (record) => ({
              text: `${C.bad}${record.name}\n${C.dim}${record.until === undefined ? 'permanent' : formatDuration(record.until - Date.now())} - ${record.reason}`,
            }),
            onPick: async (record) => {
              const yes = await confirm(player, 'Unban', `Lift the ban on ${record.name}?`, `${C.good}Unban`);
              if (!yes) return;
              bans.delete(record.id);
              ok(player, `Unbanned ${record.name}.`);
            },
            back: () => openModeration(player),
          }),
      },
      {
        text: `${C.accent}Chat filter`,
        onClick: async () => {
          const current = cfg().bannedWords.join(', ');
          const answer = await askText(player, 'Blocked words', 'Comma separated', 'word1, word2', current);
          if (answer === undefined) return;
          saveConfig((config) => {
            config.bannedWords = answer.split(',').map((w) => w.trim()).filter(Boolean);
          });
          ok(player, `Filter now blocks ${cfg().bannedWords.length} words.`);
        },
      },
    ],
    back: () => openAdminMenu(player),
  });
}

/* -------------------------------------------------------------------- world */

async function openWorld(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}World`,
    buttons: [
      { text: `${C.gold}Set time`, onClick: () => openTime(player) },
      { text: `${C.accent}Set weather`, onClick: () => openWeather(player) },
      {
        text: `${C.warn}Clear dropped items`,
        onClick: async () => {
          const removed = cleanEntities(false);
          ok(player, `Removed ${removed} entities.`);
        },
      },
      {
        text: `${C.bad}Clear hostile mobs`,
        onClick: async () => {
          const yes = await confirm(player, 'Clear mobs', 'Remove every hostile mob in all dimensions?');
          if (!yes) return;
          const removed = cleanEntities(true);
          ok(player, `Removed ${removed} entities.`);
        },
      },
      {
        text: `${C.accent}World border`,
        onClick: async () => {
          const config = cfg();
          const values = await prompt(player, 'World border', [
            { kind: 'toggle', label: 'Enabled', default: config.worldBorderEnabled },
            { kind: 'slider', label: 'Radius', min: 100, max: 30000, step: 100, default: config.worldBorderRadius },
          ]);
          if (!values) return;
          saveConfig((c) => {
            c.worldBorderEnabled = Boolean(values[0]);
            c.worldBorderRadius = Number(values[1]);
          });
          ok(player, 'World border updated.');
        },
      },
      {
        text: `${C.dim}Land claims (${claims.size})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Claims`,
            items: claims.values(),
            render: (claim) => ({
              text: `${C.accent}${claim.name}\n${C.dim}${claim.minX},${claim.minZ} to ${claim.maxX},${claim.maxZ}`,
            }),
            onPick: async (claim) => {
              const yes = await confirm(player, 'Delete claim', `Remove ${claim.name}?`);
              if (!yes) return;
              claims.delete(claim.id);
              ok(player, 'Claim removed.');
            },
            back: () => openWorld(player),
          }),
      },
    ],
    back: () => openAdminMenu(player),
  });
}

async function openTime(player: Player): Promise<void> {
  const presets = ['day', 'noon', 'sunset', 'night', 'midnight', 'sunrise'];
  await menu(player, {
    title: `${C.title}Time`,
    buttons: presets.map((preset) => ({
      text: `${C.accent}${preset}`,
      onClick: async () => {
        setTime(preset);
        ok(player, `Time set to ${preset}.`);
      },
    })),
    back: () => openWorld(player),
  });
}

async function openWeather(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Weather`,
    buttons: ['clear', 'rain', 'thunder'].map((kind) => ({
      text: `${C.accent}${kind}`,
      onClick: async () => {
        setWeather(kind);
        ok(player, `Weather set to ${kind}.`);
      },
    })),
    back: () => openWorld(player),
  });
}

/* ------------------------------------------------------------------ economy */

async function openEconomy(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Economy`,
    body: `${C.dim}${shopItems.size} shop items`,
    buttons: [
      {
        text: `${C.gold}Give money to everyone`,
        onClick: async () => {
          const answer = await askText(player, 'Give to all', 'Amount', '500');
          const amount = Number.parseInt(answer ?? '', 10);
          if (!Number.isFinite(amount)) return err(player, 'Give a valid number.');
          let count = 0;
          for (const online of world.getAllPlayers()) {
            addMoney(profileOf(online), amount);
            count++;
          }
          ok(player, `Gave ${money(amount)} to ${count} players.`);
        },
      },
      {
        text: `${C.accent}Shop items (${shopItems.size})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Shop items`,
            items: shopItems.values(),
            render: (entry) => ({
              text: `${C.white}${entry.name}\n${C.dim}${entry.category} - buy ${entry.buyPrice} / sell ${entry.sellPrice}`,
            }),
            onPick: async (entry) => {
              const values = await prompt(player, entry.name, [
                { kind: 'text', label: 'Buy price (0 = not for sale)', default: String(entry.buyPrice) },
                { kind: 'text', label: 'Sell price (0 = cannot sell)', default: String(entry.sellPrice) },
                { kind: 'text', label: 'Bundle size', default: String(entry.amount) },
                { kind: 'toggle', label: 'Delete this item', default: false },
              ]);
              if (!values) return;
              if (values[3]) {
                shopItems.delete(entry.id);
                return ok(player, 'Item removed from the shop.');
              }
              entry.buyPrice = Number.parseInt(String(values[0]), 10) || 0;
              entry.sellPrice = Number.parseInt(String(values[1]), 10) || 0;
              entry.amount = Math.max(1, Number.parseInt(String(values[2]), 10) || 1);
              shopItems.markDirty();
              ok(player, 'Shop item updated.');
            },
            back: () => openEconomy(player),
          }),
      },
      {
        text: `${C.accent}Economy settings`,
        onClick: async () => {
          const config = cfg();
          const values = await prompt(player, 'Economy settings', [
            { kind: 'text', label: 'Currency symbol', default: config.currencySymbol },
            { kind: 'text', label: 'Currency name', default: config.currencyName },
            { kind: 'text', label: 'Starting balance', default: String(config.startingBalance) },
            { kind: 'slider', label: 'Pay tax %', min: 0, max: 50, step: 1, default: config.payTaxPercent },
          ]);
          if (!values) return;
          saveConfig((c) => {
            c.currencySymbol = String(values[0]) || '$';
            c.currencyName = String(values[1]) || 'Coins';
            c.startingBalance = Number.parseInt(String(values[2]), 10) || 0;
            c.payTaxPercent = Number(values[3]);
          });
          ok(player, 'Economy settings saved.');
        },
      },
    ],
    back: () => openAdminMenu(player),
  });
}

/* -------------------------------------------------------------------- roles */

async function openRoles(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Roles`,
    body: `${C.dim}${roles.size} roles defined`,
    buttons: [
      ...roles
        .values()
        .sort((a, b) => b.priority - a.priority)
        .map((role) => ({
          text: `${role.color}${role.name}\n${C.dim}priority ${role.priority} - ${role.permissions.length} permissions`,
          onClick: () => openRole(player, role),
        })),
      { text: `${C.good}+ Create a role`, onClick: () => createRole(player) },
      {
        text: `${C.dim}Restore default roles`,
        onClick: async () => {
          const yes = await confirm(player, 'Restore defaults', 'Recreate the default role ladder? Existing roles are kept.');
          if (!yes) return;
          if (roles.size === 0) ensureDefaultRoles();
          else {
            // ensureDefaultRoles only seeds an empty table, so seed by clearing first.
            const existing = roles.values();
            roles.clear();
            ensureDefaultRoles();
            for (const role of existing) if (!roles.has(role.id)) roles.set(role.id, role);
          }
          ok(player, 'Default roles restored.');
        },
      },
    ],
    back: () => openAdminMenu(player),
  });
}

async function createRole(player: Player): Promise<void> {
  const values = await prompt(player, 'Create role', [
    { kind: 'text', label: 'Role name', placeholder: 'Helper' },
    { kind: 'text', label: 'Chat prefix', placeholder: '§e[Helper]' },
    { kind: 'slider', label: 'Priority', min: 0, max: 100, step: 5, default: 20 },
    { kind: 'toggle', label: 'Give to everyone by default', default: false },
  ]);
  if (!values) return;
  const name = String(values[0]).trim();
  if (!name) return err(player, 'Give the role a name.');

  const id = name.toLowerCase().replace(/\s+/g, '_');
  if (roles.has(id)) return err(player, 'A role with that name already exists.');

  roles.set(id, {
    id,
    name,
    prefix: String(values[1]) || `§7[${name}]`,
    color: '§7',
    priority: Number(values[2]),
    permissions: ['menu.member'],
    isDefault: Boolean(values[3]),
  });
  ok(player, `Role "${name}" created. Open it to set permissions.`);
  await openRole(player, roles.get(id)!);
}

async function openRole(player: Player, role: Role): Promise<void> {
  await menu(player, {
    title: `${role.color}${role.name}`,
    body: [
      `${C.dim}Prefix: ${C.reset}${role.prefix}`,
      `${C.dim}Priority: ${C.white}${role.priority}`,
      `${C.dim}Permissions: ${C.white}${role.permissions.includes('*') ? 'all' : role.permissions.length}`,
      `${C.dim}Default role: ${C.white}${role.isDefault ? 'yes' : 'no'}`,
    ].join('\n'),
    buttons: [
      { text: `${C.accent}Edit permissions`, onClick: () => openRolePermissions(player, role) },
      {
        text: `${C.accent}Edit details`,
        onClick: async () => {
          const values = await prompt(player, `Edit ${role.name}`, [
            { kind: 'text', label: 'Name', default: role.name },
            { kind: 'text', label: 'Chat prefix', default: role.prefix },
            { kind: 'slider', label: 'Priority', min: 0, max: 100, step: 5, default: role.priority },
            { kind: 'toggle', label: 'Default role', default: Boolean(role.isDefault) },
          ]);
          if (!values) return;
          role.name = String(values[0]) || role.name;
          role.prefix = String(values[1]);
          role.priority = Number(values[2]);
          role.isDefault = Boolean(values[3]);
          roles.markDirty();
          ok(player, 'Role updated.');
        },
      },
      {
        text: `${C.bad}Delete role`,
        onClick: async () => {
          const yes = await confirm(player, 'Delete role', `Delete "${role.name}" and remove it from every player?`);
          if (!yes) return;
          purgeRole(role.id);
          ok(player, 'Role deleted.');
          await openRoles(player);
        },
      },
    ],
    back: () => openRoles(player),
  });
}

async function openRolePermissions(player: Player, role: Role): Promise<void> {
  const groups = Object.entries(PERMISSION_GROUPS);
  await menu(player, {
    title: `${C.title}${role.name} permissions`,
    body: role.permissions.includes('*')
      ? `${C.good}This role has every permission.`
      : `${C.dim}Choose a group to edit.`,
    buttons: [
      {
        text: role.permissions.includes('*') ? `${C.bad}Remove full access` : `${C.good}Grant full access (*)`,
        onClick: async () => {
          if (role.permissions.includes('*')) role.permissions = role.permissions.filter((p) => p !== '*');
          else role.permissions = ['*'];
          roles.markDirty();
          await openRolePermissions(player, role);
        },
      },
      ...groups.map(([group, nodes]) => ({
        text: `${C.accent}${group}`,
        onClick: () => openPermissionGroup(player, role, group, nodes),
      })),
    ],
    back: () => openRole(player, role),
  });
}

async function openPermissionGroup(player: Player, role: Role, group: string, nodes: string[]): Promise<void> {
  await menu(player, {
    title: `${C.title}${group}`,
    buttons: nodes.map((node) => {
      const held = role.permissions.includes(node);
      return {
        text: `${held ? C.good : C.dim}${held ? '[x] ' : '[ ] '}${node}`,
        onClick: async () => {
          if (held) role.permissions = role.permissions.filter((p) => p !== node);
          else role.permissions.push(node);
          roles.markDirty();
          await openPermissionGroup(player, role, group, nodes);
        },
      };
    }),
    back: () => openRolePermissions(player, role),
  });
}

/* ------------------------------------------------------------------ content */

async function openContent(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Content`,
    buttons: [
      {
        text: `${C.accent}Holograms (${holograms.size})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Holograms`,
            items: holograms.values(),
            render: (hologram) => ({
              text: `${C.accent}${hologram.board ?? hologram.lines[0] ?? 'hologram'}\n${C.dim}${Math.floor(hologram.x)}, ${Math.floor(hologram.y)}, ${Math.floor(hologram.z)}`,
            }),
            onPick: async (hologram) => {
              const yes = await confirm(player, 'Delete hologram', 'Remove this hologram?');
              if (!yes) return;
              holograms.delete(hologram.id);
              ok(player, 'Hologram removed. It disappears within a few seconds.');
            },
            back: () => openContent(player),
          }),
      },
      {
        text: `${C.accent}Warps (${warps.size})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Warps`,
            items: warps.values(),
            render: (warp) => ({ text: `${C.accent}${warp.name}\n${C.dim}cost ${warp.cost}` }),
            onPick: async (warp) => {
              const values = await prompt(player, warp.name, [
                { kind: 'text', label: 'Cost', default: String(warp.cost) },
                { kind: 'toggle', label: 'Delete this warp', default: false },
              ]);
              if (!values) return;
              if (values[1]) {
                warps.delete(warp.id);
                return ok(player, 'Warp deleted.');
              }
              warp.cost = Number.parseInt(String(values[0]), 10) || 0;
              warps.markDirty();
              ok(player, 'Warp updated.');
            },
            back: () => openContent(player),
          }),
      },
      {
        text: `${C.accent}Kits (${kits.size})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Kits`,
            items: kits.values(),
            render: (kit) => ({
              text: `${C.accent}${kit.name}\n${C.dim}${kit.reward.items.length} items, ${money(kit.reward.money)}`,
            }),
            onPick: async (kit) => {
              const values = await prompt(player, kit.name, [
                { kind: 'text', label: 'Money reward', default: String(kit.reward.money) },
                { kind: 'text', label: 'Cooldown seconds (0 = once)', default: String(kit.cooldown) },
              ]);
              if (!values) return;
              kit.reward.money = Number.parseInt(String(values[0]), 10) || 0;
              kit.cooldown = Number.parseInt(String(values[1]), 10) || 0;
              kits.markDirty();
              ok(player, 'Kit updated.');
            },
            back: () => openContent(player),
          }),
      },
      {
        text: `${C.gold}Redeem codes (${codes.size})`,
        onClick: () => openCodes(player),
      },
      {
        text: `${C.accent}Rank ladder (${ladder().length})`,
        onClick: () =>
          paged(player, {
            title: `${C.title}Ranks`,
            items: ladder(),
            render: (rank) => ({ text: `${rank.color}${rank.name}\n${C.dim}order ${rank.order}` }),
            onPick: async (rank) => {
              const values = await prompt(player, rank.name, [
                { kind: 'text', label: 'Display name', default: rank.name },
                { kind: 'text', label: 'Prefix', default: rank.prefix },
                { kind: 'text', label: 'Requirement value', default: String(rank.requirementValue) },
                { kind: 'text', label: 'Purchase cost (0 = not for sale)', default: String(rank.cost) },
              ]);
              if (!values) return;
              rank.name = String(values[0]) || rank.name;
              rank.prefix = String(values[1]);
              rank.requirementValue = Number.parseInt(String(values[2]), 10) || 0;
              rank.cost = Number.parseInt(String(values[3]), 10) || 0;
              ok(player, 'Rank updated.');
            },
            back: () => openContent(player),
          }),
      },
    ],
    back: () => openAdminMenu(player),
  });
}

async function openCodes(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Redeem codes`,
    buttons: [
      ...codes.values().map((entry) => ({
        text: `${C.gold}${entry.code}\n${C.dim}${entry.uses}${entry.maxUses > 0 ? `/${entry.maxUses}` : ''} uses - ${money(entry.reward.money)}`,
        onClick: async () => {
          const yes = await confirm(player, 'Delete code', `Delete ${entry.code}?`);
          if (!yes) return;
          codes.delete(entry.code);
          ok(player, 'Code deleted.');
        },
      })),
      {
        text: `${C.good}+ Create a code`,
        onClick: async () => {
          const values = await prompt(player, 'Create code', [
            { kind: 'text', label: 'Code', placeholder: 'WELCOME2026' },
            { kind: 'text', label: 'Money reward', default: '1000' },
            { kind: 'text', label: 'Max uses (0 = unlimited)', default: '0' },
          ]);
          if (!values) return;
          const code = String(values[0]).toUpperCase().trim();
          if (!code) return err(player, 'Give the code a name.');
          codes.set(code, {
            code,
            reward: { money: Number.parseInt(String(values[1]), 10) || 0, xp: 0, items: [] },
            maxUses: Number.parseInt(String(values[2]), 10) || 0,
            uses: 0,
            usedBy: [],
          });
          ok(player, `Code ${code} created.`);
        },
      },
    ],
    back: () => openContent(player),
  });
}

/* ----------------------------------------------------------------- settings */

async function openSettings(player: Player): Promise<void> {
  const config = cfg();
  const locales = availableLocales();

  await menu(player, {
    title: `${C.title}Server Settings`,
    buttons: [
      {
        text: `${C.accent}General`,
        onClick: async () => {
          const values = await prompt(player, 'General', [
            { kind: 'text', label: 'Server name', default: config.serverName },
            { kind: 'text', label: 'Message of the day', default: config.motd },
            { kind: 'text', label: 'Chat command prefix', default: config.commandPrefix },
            { kind: 'dropdown', label: 'Language', options: locales, default: Math.max(0, locales.indexOf(config.language)) },
          ]);
          if (!values) return;
          saveConfig((c) => {
            c.serverName = String(values[0]);
            c.motd = String(values[1]);
            c.commandPrefix = String(values[2]).slice(0, 2) || '!';
            c.language = locales[Number(values[3])] ?? 'en';
          });
          ok(player, 'Settings saved.');
        },
      },
      {
        text: `${C.accent}Features`,
        onClick: async () => {
          const values = await prompt(player, 'Features', [
            { kind: 'toggle', label: 'Land claims', default: config.claimsEnabled },
            { kind: 'toggle', label: 'Custom chat format', default: config.chatFormatEnabled },
            { kind: 'toggle', label: 'Custom nametags', default: config.nametagsEnabled },
            { kind: 'toggle', label: 'Sidebar', default: config.sidebarEnabled },
            { kind: 'toggle', label: 'Holograms', default: config.hologramsEnabled },
            { kind: 'toggle', label: 'Gravestones', default: config.gravestonesEnabled },
            { kind: 'toggle', label: 'Duels', default: config.duelsEnabled },
            { kind: 'toggle', label: 'Jobs', default: config.jobsEnabled },
            { kind: 'toggle', label: 'Skills', default: config.skillsEnabled },
            { kind: 'toggle', label: 'Daily rewards', default: config.dailyRewardEnabled },
            { kind: 'toggle', label: 'Require login', default: config.registrationRequired },
            { kind: 'toggle', label: 'Auto broadcasts', default: config.broadcastEnabled },
            { kind: 'toggle', label: 'Anti spam', default: config.antiSpamEnabled },
          ]);
          if (!values) return;
          saveConfig((c) => {
            c.claimsEnabled = Boolean(values[0]);
            c.chatFormatEnabled = Boolean(values[1]);
            c.nametagsEnabled = Boolean(values[2]);
            c.sidebarEnabled = Boolean(values[3]);
            c.hologramsEnabled = Boolean(values[4]);
            c.gravestonesEnabled = Boolean(values[5]);
            c.duelsEnabled = Boolean(values[6]);
            c.jobsEnabled = Boolean(values[7]);
            c.skillsEnabled = Boolean(values[8]);
            c.dailyRewardEnabled = Boolean(values[9]);
            c.registrationRequired = Boolean(values[10]);
            c.broadcastEnabled = Boolean(values[11]);
            c.antiSpamEnabled = Boolean(values[12]);
          });
          ok(player, 'Features updated.');
        },
      },
      {
        text: `${C.accent}Teleport & claims`,
        onClick: async () => {
          const values = await prompt(player, 'Teleport & claims', [
            { kind: 'slider', label: 'Home limit', min: 1, max: 20, step: 1, default: config.homeLimitDefault },
            { kind: 'slider', label: 'TPA warmup (seconds)', min: 0, max: 30, step: 1, default: config.tpaWarmupSeconds },
            { kind: 'slider', label: 'RTP cooldown (seconds)', min: 0, max: 600, step: 10, default: config.rtpCooldownSeconds },
            { kind: 'slider', label: 'Max claim radius', min: 8, max: 128, step: 8, default: config.claimMaxRadius },
            { kind: 'text', label: 'Starting claim blocks', default: String(config.claimBlocksDefault) },
          ]);
          if (!values) return;
          saveConfig((c) => {
            c.homeLimitDefault = Number(values[0]);
            c.tpaWarmupSeconds = Number(values[1]);
            c.rtpCooldownSeconds = Number(values[2]);
            c.claimMaxRadius = Number(values[3]);
            c.claimBlocksDefault = Number.parseInt(String(values[4]), 10) || 2048;
          });
          ok(player, 'Saved.');
        },
      },
      {
        text: `${C.accent}Chat & display formats`,
        onClick: async () => {
          const values = await prompt(player, 'Formats', [
            { kind: 'text', label: 'Chat format', default: config.chatFormat },
            { kind: 'text', label: 'Nametag format', default: config.nametagFormat },
            { kind: 'text', label: 'Sidebar title', default: config.sidebarTitle },
            { kind: 'text', label: 'Action bar (per player)', default: config.actionBarFormat },
            { kind: 'toggle', label: 'Show action bar', default: config.actionBarEnabled },
          ]);
          if (!values) return;
          saveConfig((c) => {
            c.chatFormat = String(values[0]);
            c.nametagFormat = String(values[1]);
            c.sidebarTitle = String(values[2]);
            c.actionBarFormat = String(values[3]);
            c.actionBarEnabled = Boolean(values[4]);
          });
          tell(player, `${C.dim}Tokens: {name} {rank} {rankcolor} {balance} {symbol} {online} {playtime} {health} {clan} {message}`);
          ok(player, 'Formats saved.');
        },
      },
    ],
    back: () => openAdminMenu(player),
  });
}

/* --------------------------------------------------------------------- data */

async function openData(player: Player): Promise<void> {
  const totalBalance = profiles.values().reduce((sum, p) => sum + balanceOf(p), 0);

  await menu(player, {
    title: `${C.title}Data & Stats`,
    body: [
      `${C.dim}Known players: ${C.white}${profiles.size}`,
      `${C.dim}Money in circulation: ${C.good}${money(totalBalance)}`,
      `${C.dim}Claims: ${C.white}${claims.size}`,
      `${C.dim}Shop items: ${C.white}${shopItems.size}`,
      `${C.dim}Holograms: ${C.white}${holograms.size}`,
      `${C.dim}Active bans: ${C.white}${bans.values().filter((b) => activeBan(b.id)).length}`,
    ].join('\n'),
    buttons: [
      {
        text: `${C.bad}Reset a player's data`,
        onClick: async () => {
          const all = profiles.values();
          const values = await prompt(player, 'Reset player', [
            { kind: 'dropdown', label: 'Player', options: all.map((p) => p.name) },
          ]);
          if (!values) return;
          const target = all[Number(values[0])];
          const yes = await confirm(player, 'Reset player', `Wipe all stored data for ${target.name}? This cannot be undone.`);
          if (!yes) return;
          profiles.delete(target.id);
          ok(player, `${target.name}'s data was reset.`);
        },
      },
    ],
    back: () => openAdminMenu(player),
  });
}
