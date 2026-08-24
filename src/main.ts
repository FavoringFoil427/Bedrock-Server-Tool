import { system, world } from '@minecraft/server';
import { ensureDefaultRoles } from './core/permissions';
import { installChatCommands, installNativeCommands, register, sendCommandList } from './core/commands';
import { flushAll } from './core/storage';
import { profileOf, profiles } from './core/profiles';
import { C, tell } from './core/util';
import { chatAvailable } from './core/chatbridge';

import * as economy from './modules/economy';
import * as shop from './modules/shop';
import * as teleport from './modules/teleport';
import * as playerwarps from './modules/playerwarps';
import * as land from './modules/land';
import * as moderation from './modules/moderation';
import * as worldtools from './modules/worldtools';
import * as ranks from './modules/ranks';
import * as skills from './modules/skills';
import * as jobs from './modules/jobs';
import * as quests from './modules/quests';
import * as rewards from './modules/rewards';
import * as clans from './modules/clans';
import * as duels from './modules/duels';
import * as combat from './modules/combat';
import * as chat from './modules/chat';
import * as stats from './modules/stats';
import * as display from './modules/display';
import * as broadcast from './modules/broadcast';
import * as gravestone from './modules/gravestone';
import * as cosmetics from './modules/cosmetics';
import * as quota from './modules/quota';
import * as registration from './modules/registration';
import * as npc from './modules/npc';
import * as vault from './modules/vault';
import * as suite from './modules/suite';

/**
 * Entry point.
 *
 * Native commands must be registered during the engine startup event, so all
 * module command declarations run immediately at load; anything that touches
 * the world is deferred to the first tick.
 *
 * Module order matters in a few places: `land` installs PvP protection that
 * `duels` deliberately overrides for active fights, `combat` must load after
 * `duels` so duellists are exempt from combat tagging, and `suite` registers
 * the menu items that the NPC module opens.
 */
/**
 * A module's `install()` may only register commands and subscribe to events:
 * both are legal while the script is still loading. Anything that reads or
 * writes world state belongs in `init()`, which runs on the first tick — the
 * engine rejects dynamic property access during early execution, and a throw
 * there aborts the whole script before any commands are registered.
 */
interface Module {
  install(): void;
  init?: () => void;
}

const MODULES: Module[] = [
  economy,
  shop,
  teleport,
  land,
  playerwarps,
  moderation,
  worldtools,
  ranks,
  skills,
  jobs,
  quests,
  rewards,
  clans,
  duels,
  combat,
  chat,
  stats,
  display,
  broadcast,
  gravestone,
  cosmetics,
  quota,
  registration,
  vault,
  suite,
  npc,
];

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
  // Early execution is over; world state is reachable from here on.
  ensureDefaultRoles();
  for (const module of MODULES) module.init?.();

  installChatCommands();
  display.rebuildHolograms();

  for (const player of world.getAllPlayers()) profileOf(player);

  console.log('[AdminSuite] ready');
  if (!chatAvailable()) {
    console.warn('[AdminSuite] Beta APIs are disabled: chat formatting and "!" commands are off. Use /adm:<command>.');
  }
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  const player = event.player;
  profileOf(player);

  system.runTimeout(() => {
    if (!player.isValid) return;
    suite.grantMemberBook(player);
    rewards.grantStarterKit(player);
    chat.greet(player);
    tell(
      player,
      chatAvailable()
        ? `${C.dim}Type ${C.accent}!info${C.dim} for commands, or open your Member Suite book.`
        : `${C.dim}Type ${C.accent}/adm:info${C.dim} for commands, or open your Member Suite book.`,
    );
  }, 40);
});

world.beforeEvents.playerLeave.subscribe((event) => {
  const profile = profiles.get(event.player.id);
  if (profile) {
    profile.lastSeen = Date.now();
    profiles.markDirty();
  }
});

// Persist everything still buffered when the world unloads.
system.beforeEvents.shutdown.subscribe(() => flushAll());
