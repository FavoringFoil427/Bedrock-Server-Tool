import { system, world } from '@minecraft/server';
import { register } from '../core/commands';
import { cfg } from '../core/config';
import { Value } from '../core/storage';
import { expand } from '../core/placeholders';
import { C, broadcast as say, err, ok, tell } from '../core/util';

/** Rotating automated announcements plus a manual broadcast command. */

interface BroadcastState {
  messages: string[];
  next: number;
}

const state = new Value<BroadcastState>('adm:broadcasts', () => ({
  messages: [
    '§bTip: §fuse §a!info§f to see every command you can run.',
    '§bTip: §fclaim your land with §a!claim§f to keep your base safe.',
    '§bTip: §fclaim a free reward every day with §a!daily§f.',
  ],
  next: 0,
}));

export function messages(): string[] {
  return state.get().messages;
}

export function install(): void {
  register({
    name: 'broadcast',
    aliases: ['bc'],
    description: 'Send a message to everyone.',
    category: 'Content',
    permission: 'broadcast.admin',
    greedy: true,
    args: [{ name: 'message', type: 'string' }],
    handler: ({ player, args, rest }) => {
      const message = args[0] || rest;
      if (!message) return err(player, 'Say something.');
      say(message);
    },
  });

  register({
    name: 'autobroadcast',
    aliases: ['abc'],
    description: 'Manage rotating announcements: abc list | add <text> | remove <n>',
    category: 'Content',
    permission: 'broadcast.admin',
    greedy: true,
    args: [
      { name: 'action', type: 'string' },
      { name: 'value', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const action = (args[0] ?? '').toLowerCase();
      const value = args[1] ?? '';
      const current = state.get();

      if (action === 'list') {
        if (current.messages.length === 0) return tell(player, `${C.dim}No automatic messages.`);
        tell(player, `${C.title}Automatic messages`);
        current.messages.forEach((message, index) => {
          player.sendMessage(`  ${C.accent}${index + 1}. ${C.reset}${message}`);
        });
        return;
      }
      if (action === 'add') {
        if (!value) return err(player, 'Give the message text.');
        state.update((s) => {
          s.messages.push(value);
        });
        return ok(player, 'Message added.');
      }
      if (action === 'remove') {
        const index = Number.parseInt(value, 10) - 1;
        if (!Number.isFinite(index) || index < 0 || index >= current.messages.length) {
          return err(player, 'Give a valid message number.');
        }
        state.update((s) => {
          s.messages.splice(index, 1);
        });
        return ok(player, 'Message removed.');
      }
      err(player, 'Use: list, add <text>, remove <number>');
    },
  });

  // Rotate through the configured messages on the configured interval.
  let ticks = 0;
  system.runInterval(() => {
    const config = cfg();
    if (!config.broadcastEnabled) return;
    ticks += 20;
    if (ticks < config.broadcastIntervalSeconds * 20) return;
    ticks = 0;

    const current = state.get();
    if (current.messages.length === 0) return;
    const players = world.getAllPlayers();
    if (players.length === 0) return;

    const message = current.messages[current.next % current.messages.length];
    state.update((s) => {
      s.next = (s.next + 1) % Math.max(1, s.messages.length);
    });
    // Expand per player so placeholders resolve to their own values.
    for (const player of players) player.sendMessage(expand(player, message));
  }, 20);
}
