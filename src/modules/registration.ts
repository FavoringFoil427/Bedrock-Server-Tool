import { InputPermissionCategory, Player, system, world } from '@minecraft/server';
import { register, setCommandGate } from '../core/commands';
import { cfg } from '../core/config';
import { profileOf, profiles } from '../core/profiles';
import { askText } from '../core/ui';
import { t } from '../core/i18n';
import { C, err, ok, tell } from '../core/util';

/**
 * Optional account gate.
 *
 * When enabled, a player must set a password on first join and enter it on
 * every later join before they can move or chat. This guards against another
 * person joining on the same gamertag on a shared device; it is not real
 * authentication. Passwords are stored as a non-cryptographic digest, so treat
 * it as a convenience lock rather than a security boundary.
 */

/** FNV-1a digest. Fast and dependency free, deliberately not a secure hash. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Players who have satisfied the gate this session. */
const authenticated = new Set<string>();

export function isAuthenticated(player: Player): boolean {
  return !cfg().registrationRequired || authenticated.has(player.id);
}

function lock(player: Player, locked: boolean): void {
  try {
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, !locked);
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Jump, !locked);
  } catch {
    // Older clients may not support input locking; the chat gate still applies.
  }
}

function completeLogin(player: Player): void {
  authenticated.add(player.id);
  lock(player, false);
  ok(player, 'Welcome back!');
}

/** Opens the register/login prompt for a player who is not yet through. */
async function challenge(player: Player): Promise<void> {
  const profile = profileOf(player);
  const registering = profile.passwordHash === undefined;

  const answer = await askText(
    player,
    registering ? 'Create your account' : 'Log in',
    registering ? 'Choose a password (remember it!)' : 'Enter your password',
    'password',
  );

  if (!player.isValid) return;

  if (!answer) {
    tell(player, `${C.warn}You must ${registering ? 'register' : 'log in'} to play.`);
    // Re-prompt shortly so a dismissed form is not a way around the gate.
    system.runTimeout(() => void challenge(player), 60);
    return;
  }

  if (registering) {
    if (answer.length < 4) {
      err(player, 'Use at least 4 characters.');
      system.runTimeout(() => void challenge(player), 20);
      return;
    }
    profile.passwordHash = digest(answer);
    profiles.markDirty();
    authenticated.add(player.id);
    lock(player, false);
    ok(player, 'Account created. Remember your password!');
    return;
  }

  if (digest(answer) !== profile.passwordHash) {
    err(player, 'Wrong password.');
    system.runTimeout(() => void challenge(player), 20);
    return;
  }
  completeLogin(player);
}

export function install(): void {
  // Until a player is through the gate, only the account commands work.
  const ALLOWED_WHILE_LOCKED = new Set(['register', 'login', 'info', 'help', 'commands']);
  setCommandGate((player, command) => {
    if (isAuthenticated(player)) return true;
    if (ALLOWED_WHILE_LOCKED.has(command.name)) return true;
    err(player, t('err.notRegistered', { prefix: cfg().commandPrefix }));
    return false;
  });

  register({
    name: 'register',
    description: 'Create your account password.',
    category: 'Account',
    args: [{ name: 'password', type: 'string' }],
    handler: ({ player, args }) => {
      const profile = profileOf(player);
      if (profile.passwordHash !== undefined) return err(player, 'You already have a password. Use !login.');
      const password = args[0] ?? '';
      if (password.length < 4) return err(player, 'Use at least 4 characters.');
      profile.passwordHash = digest(password);
      profiles.markDirty();
      authenticated.add(player.id);
      lock(player, false);
      ok(player, 'Account created.');
    },
  });

  register({
    name: 'login',
    description: 'Log in with your password.',
    category: 'Account',
    args: [{ name: 'password', type: 'string' }],
    handler: ({ player, args }) => {
      const profile = profileOf(player);
      if (profile.passwordHash === undefined) return err(player, t('err.notRegistered', { prefix: cfg().commandPrefix }));
      if (digest(args[0] ?? '') !== profile.passwordHash) return err(player, 'Wrong password.');
      completeLogin(player);
    },
  });

  register({
    name: 'changepassword',
    description: 'Change your account password.',
    category: 'Account',
    args: [
      { name: 'old', type: 'string' },
      { name: 'new', type: 'string' },
    ],
    handler: ({ player, args }) => {
      const profile = profileOf(player);
      if (profile.passwordHash !== undefined && digest(args[0] ?? '') !== profile.passwordHash) {
        return err(player, 'Your current password is wrong.');
      }
      if ((args[1] ?? '').length < 4) return err(player, 'Use at least 4 characters.');
      profile.passwordHash = digest(args[1] ?? '');
      profiles.markDirty();
      ok(player, 'Password changed.');
    },
  });

  register({
    name: 'resetpassword',
    description: 'Admin: clear a player\'s password.',
    category: 'Account',
    permission: 'server.data',
    args: [{ name: 'player', type: 'player' }],
    handler: ({ player, args }) => {
      const needle = (args[0] ?? '').toLowerCase();
      const target = profiles.values().find((p) => p.name.toLowerCase() === needle);
      if (!target) return err(player, 'Player not found.');
      delete target.passwordHash;
      profiles.markDirty();
      ok(player, `${target.name} can set a new password on next join.`);
    },
  });

  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn || !cfg().registrationRequired) return;
    const player = event.player;
    lock(player, true);
    system.runTimeout(() => {
      if (player.isValid) void challenge(player);
    }, 40);
  });

  world.afterEvents.playerLeave.subscribe((event) => {
    authenticated.delete(event.playerId);
  });
}
