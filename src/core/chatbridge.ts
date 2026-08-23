import { Player, world } from '@minecraft/server';

/**
 * Chat interception bridge.
 *
 * `world.beforeEvents.chatSend` is a beta-gated API: it exists only when the
 * world has "Beta APIs" enabled and the manifest requests the beta module.
 * Everything else in this addon runs on the stable surface, so chat is reached
 * through this shim rather than typed directly. When the event is unavailable
 * the suite keeps working and the chat-dependent features report themselves as
 * disabled instead of throwing at load time.
 */

export interface ChatMessage {
  /** The player who typed the message. */
  sender: Player;
  /** The raw message text. */
  message: string;
  /** Set to true to stop the message reaching global chat. */
  cancel: boolean;
}

type ChatSignal = {
  subscribe(callback: (event: ChatMessage) => void): unknown;
};

function chatSignal(): ChatSignal | undefined {
  const events = world.beforeEvents as unknown as Record<string, unknown>;
  const signal = events['chatSend'] as ChatSignal | undefined;
  return signal && typeof signal.subscribe === 'function' ? signal : undefined;
}

let available: boolean | undefined;

/** True when this world can intercept chat (Beta APIs enabled). */
export function chatAvailable(): boolean {
  if (available === undefined) available = chatSignal() !== undefined;
  return available;
}

type Handler = (event: ChatMessage) => void;

const handlers: Handler[] = [];
let installed = false;

/**
 * Registers a chat handler. Handlers run in registration order and may set
 * `event.cancel`; once cancelled, later handlers still run so that logging and
 * moderation both observe the message.
 */
export function onChat(handler: Handler): void {
  handlers.push(handler);
  if (installed) return;

  const signal = chatSignal();
  if (!signal) {
    console.warn('[AdminSuite] Beta APIs are off - chat commands and chat formatting are disabled.');
    return;
  }
  installed = true;
  signal.subscribe((event) => {
    for (const fn of handlers) {
      try {
        fn(event);
      } catch (error) {
        console.warn(`[AdminSuite] chat handler failed: ${error}`);
      }
    }
  });
}
