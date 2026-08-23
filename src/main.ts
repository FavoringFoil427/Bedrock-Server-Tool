import { world, system } from '@minecraft/server';
import { ensureDefaultRoles } from './core/permissions';
import { installChatCommands, installNativeCommands } from './core/commands';
import { flushAll } from './core/storage';
import { profileOf } from './core/profiles';

installNativeCommands();

system.run(() => {
  ensureDefaultRoles();
  installChatCommands();
  for (const player of world.getAllPlayers()) profileOf(player);
  console.log('[AdminSuite] ready');
});

system.beforeEvents.shutdown.subscribe(() => flushAll());
