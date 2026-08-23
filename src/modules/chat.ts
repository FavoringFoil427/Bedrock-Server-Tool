import { Player, system, world } from '@minecraft/server';
import { onChat, chatAvailable } from '../core/chatbridge';
import { cfg } from '../core/config';
import { expand } from '../core/placeholders';
import { profileOf } from '../core/profiles';
import { can } from '../core/permissions';
import { register } from '../core/commands';
import { t } from '../core/i18n';
import { C, err, now, ok, stripColor, tell } from '../core/util';
import { isMuted, notifyStaff } from './moderation';
import { isAuthenticated } from './registration';

/**
 * Chat pipeline: mute enforcement, anti-spam, word filtering and the custom
 * chat format. Requires the beta chat event; when it is unavailable the
 * commands still register but formatting is skipped.
 */

const lastMessageAt = new Map<string, number>();
const lastMessageText = new Map<string, string>();

function filtered(message: string): string | undefined {
  const words = cfg().bannedWords;
  if (words.length === 0) return undefined;
  const haystack = stripColor(message).toLowerCase();
  return words.find((word) => word && haystack.includes(word.toLowerCase()));
}

/** Applies every gate to an outgoing message. Returns a rejection reason. */
function reject(player: Player, message: string): string | undefined {
  const profile = profileOf(player);
  const config = cfg();

  if (!isAuthenticated(player)) return t('err.notRegistered', { prefix: config.commandPrefix });
  if (isMuted(profile)) return t('mod.muted');
  if (message.length > config.maxMessageLength) return `Messages are limited to ${config.maxMessageLength} characters.`;

  if (config.antiSpamEnabled && !can(player, 'bypass.cooldown')) {
    const previous = lastMessageAt.get(player.id) ?? 0;
    if (now() - previous < config.antiSpamIntervalMs) return 'You are sending messages too quickly.';
    if (lastMessageText.get(player.id) === message) return 'Please do not repeat yourself.';
  }

  const banned = filtered(message);
  if (banned) {
    notifyStaff(`${player.name} tried to say a filtered word ("${banned}").`);
    return 'That message contains a blocked word.';
  }
  return undefined;
}

export function install(): void {
  register({
    name: 'staffchat',
    aliases: ['sc'],
    description: 'Send a message to online staff.',
    category: 'Moderation',
    permission: 'mod.spy',
    greedy: true,
    args: [{ name: 'message', type: 'string' }],
    handler: ({ player, args, rest }) => {
      const message = args[0] || rest;
      if (!message) return err(player, 'Say something.');
      notifyStaff(`${C.accent}${player.name}${C.reset}: ${message}`);
    },
  });

  register({
    name: 'me',
    description: 'Send an action message.',
    category: 'General',
    greedy: true,
    args: [{ name: 'message', type: 'string' }],
    handler: ({ player, args, rest }) => {
      const message = args[0] || rest;
      if (!message) return;
      if (isMuted(profileOf(player))) return err(player, t('mod.muted'));
      world.sendMessage(`${C.dim}* ${player.name} ${message}`);
    },
  });

  register({
    name: 'msg',
    aliases: ['w', 'tell'],
    description: 'Send a private message.',
    category: 'Social',
    greedy: true,
    args: [
      { name: 'player', type: 'player' },
      { name: 'message', type: 'string' },
    ],
    handler: ({ player, args }) => {
      const needle = (args[0] ?? '').toLowerCase();
      const target = world.getAllPlayers().find((p) => p.name.toLowerCase() === needle);
      if (!target) return err(player, t('err.playerNotFound'));
      const message = args[1] ?? '';
      if (!message) return err(player, 'Say something.');
      target.sendMessage(`${C.dim}[${player.name} -> you] ${C.reset}${message}`);
      player.sendMessage(`${C.dim}[you -> ${target.name}] ${C.reset}${message}`);
      notifyStaff(`${C.dim}(msg) ${player.name} -> ${target.name}: ${message}`);
    },
  });

  register({
    name: 'nickcolor',
    description: 'Set the colour of your name in chat.',
    category: 'General',
    args: [{ name: 'code', type: 'string' }],
    handler: ({ player, args }) => {
      const code = (args[0] ?? '').replace('§', '');
      if (!/^[0-9a-fk-or]$/i.test(code)) return err(player, 'Use a single Minecraft colour code, e.g. b or 6.');
      const profile = profileOf(player);
      profile.nameColor = `§${code}`;
      ok(player, `Your name colour is now ${profile.nameColor}this${C.reset}.`);
    },
  });

  if (!chatAvailable()) return;

  onChat((event) => {
    const config = cfg();
    const player = event.sender;
    const message = event.message;

    // Command lines are handled by the command router.
    if (config.commandPrefix && message.startsWith(config.commandPrefix)) return;

    const reason = reject(player, message);
    if (reason) {
      event.cancel = true;
      system.run(() => err(player, reason));
      return;
    }

    lastMessageAt.set(player.id, now());
    lastMessageText.set(player.id, message);

    if (!config.chatFormatEnabled) return;

    // Replace the vanilla line with the formatted one.
    event.cancel = true;
    system.run(() => {
      world.sendMessage(expand(player, config.chatFormat, { message }));
    });
  });
}

/** Sends the message of the day and any join notice. */
export function greet(player: Player): void {
  const config = cfg();
  if (config.motd) tell(player, expand(player, config.motd));
}
