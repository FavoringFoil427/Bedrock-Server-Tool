import { Player, world, system, Vector3, Dimension } from '@minecraft/server';
import { sfx, Sfx } from './sound';

/** Colour codes used across every menu so the UI reads as one system. */
export const C = {
  reset: '§r',
  accent: '§b',
  good: '§a',
  warn: '§e',
  bad: '§c',
  dim: '§7',
  title: '§l§b',
  gold: '§6',
  white: '§f',
} as const;

export const PREFIX = `${C.accent}[Admin Suite]${C.reset} `;

export function tell(player: Player, message: string): void {
  player.sendMessage(PREFIX + message);
}

/**
 * Confirms an action. `cue` picks the sound: a more specific one where the
 * outcome deserves it, or null where something else already made the noise -
 * an arrival plays its own sound, and two at once reads as a glitch.
 */
export function ok(player: Player, message: string, cue: Sfx | null = 'done'): void {
  tell(player, `${C.good}${message}`);
  if (cue) sfx(player, cue);
}

export function err(player: Player, message: string): void {
  tell(player, `${C.bad}${message}`);
  sfx(player, 'denied');
}

export function broadcast(message: string): void {
  world.sendMessage(PREFIX + message);
}

/** Runs a callback on the next tick, escaping read-only/early-execution contexts. */
export function defer(callback: () => void): void {
  system.run(() => {
    try {
      callback();
    } catch (error) {
      console.warn(`[AdminSuite] deferred task failed: ${error}`);
    }
  });
}

/** Awaitable tick delay. */
export function sleep(ticks: number): Promise<void> {
  return new Promise((resolve) => system.runTimeout(resolve, Math.max(1, ticks)));
}

export function now(): number {
  return Date.now();
}

export function uid(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function distance(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function formatVec(v: Vector3): string {
  return `${Math.floor(v.x)}, ${Math.floor(v.y)}, ${Math.floor(v.z)}`;
}

/** Human readable duration from milliseconds (e.g. "2d 4h 11m"). */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const parts: string[] = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && parts.length < 2) parts.push(`${sec}s`);
  return parts.slice(0, 3).join(' ');
}

/**
 * Parses durations like `30m`, `2h`, `7d`, `perm`.
 * Returns milliseconds, or `undefined` for a permanent/unparseable value.
 */
export function parseDuration(input: string): number | undefined {
  const text = input.trim().toLowerCase();
  if (!text || text === 'perm' || text === 'permanent' || text === 'forever') return undefined;
  const match = /^(\d+)\s*([smhdw]?)$/.exec(text);
  if (!match) return undefined;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 'm';
  const scale: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return amount * (scale[unit] ?? 6e4);
}

/**
 * Splits the trailing `[duration] [reason]` pair used by ban and mute.
 *
 * The duration is optional, so `ban Steve griefing` must read "griefing" as
 * the reason rather than silently discarding it as an unparseable duration.
 */
export function splitDurationReason(
  first: string | undefined,
  rest: string | undefined,
): { duration?: number; reason: string } {
  const parsed = first ? parseDuration(first) : undefined;
  if (parsed !== undefined) {
    return { duration: parsed, reason: (rest || '').trim() || 'No reason given' };
  }
  // `first` was not a duration, so it is the start of the reason.
  const reason = [first, rest].filter(Boolean).join(' ').trim();
  return { reason: reason || 'No reason given' };
}

export function formatNumber(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Strips colour codes so stored/searched text stays clean. */
export function stripColor(text: string): string {
  return text.replace(/§./g, '');
}

export function overworld(): Dimension {
  return world.getDimension('overworld');
}

/** Safe wrapper for `runCommand`, which throws on malformed input. */
export function runCommand(target: Player | Dimension, command: string): boolean {
  try {
    target.runCommand(command);
    return true;
  } catch (error) {
    console.warn(`[AdminSuite] command failed "${command}": ${error}`);
    return false;
  }
}
