import { system, world } from '@minecraft/server';
import { ensureDefaultRoles } from './core/permissions';
import { installChatCommands, installNativeCommands, register, sendCommandList } from './core/commands';
import { flushAll } from './core/storage';
import { profileOf, profiles } from './core/profiles';
import { C, tell } from './core/util';

import * as economy from './modules/economy';
import * as teleport from './modules/teleport';
import * as moderation from './modules/moderation';
import * as worldtools from './modules/worldtools';
import * as ranks from './modules/ranks';
import * as skills from './modules/skills';
import * as chat from './modules/chat';
import * as stats from './modules/stats';
import * as display from './modules/display';
import * as land from './modules/land';

/**
 * Entry point.
 *
 * Native command registration must happen during the startup event, so it is
 * wired before anything else; everything that touches the world is deferred to
 * the first tick.
 */

const MODULES = [economy, teleport, moderation, worldtools, ranks, skills, chat, stats, display, land];

register({
  name: 'info',
  aliases: ['help', 'commands'],
  description: 'List every command you can use.',
  category: 'General',
  handler: ({ player }) => sendCommandList(player),
});

for (const module of MODULES) module.install();

installNativeCommands();

system.run(() => {
  ensureDefaultRoles();
  installChatCommands();
  land.reindex();
  display.rebuildHolograms();

  for (const player of world.getAllPlayers()) profileOf(player);
  console.log('[AdminSuite] ready');
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  const player = event.player;
  profileOf(player);
  system.runTimeout(() => {
    if (!player.isValid) return;
    chat.greet(player);
    tell(player, `${C.dim}Type ${C.accent}!info${C.dim} or ${C.accent}/adm:info${C.dim} for commands.`);
  }, 40);
});

world.beforeEvents.playerLeave.subscribe((event) => {
  const profile = profiles.get(event.player.id);
  if (profile) {
    profile.lastSeen = Date.now();
    profiles.markDirty();
  }
});

system.beforeEvents.shutdown.subscribe(() => flushAll());
