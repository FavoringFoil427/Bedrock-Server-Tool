import { Player, system } from '@minecraft/server';
import { cfg } from './config';

/**
 * Audible feedback.
 *
 * Menus that answer silently feel broken even when they worked, so every
 * outcome a player can cause has a sound attached. They are named for what
 * happened rather than for the sample, so a surface asks for `denied` and
 * never has to know which vanilla sound that is.
 *
 * Only sounds shipped with the base game are used - a resource pack is not
 * required, and a missing id would fail silently and be hard to spot.
 */
const SFX = {
  /** A menu or sub-screen opened. */
  open: { id: 'random.click', volume: 0.35, pitch: 1.1 },
  /** Something the player asked for worked. */
  done: { id: 'random.orb', volume: 0.4, pitch: 1.3 },
  /** Something the player asked for did not work. */
  denied: { id: 'note.bass', volume: 0.5, pitch: 0.7 },
  /** Money changed hands. */
  trade: { id: 'random.orb', volume: 0.5, pitch: 0.9 },
  /** A rank, level or milestone was reached. */
  triumph: { id: 'random.levelup', volume: 0.5, pitch: 1 },
  /** Arrived somewhere by teleport. */
  travel: { id: 'mob.endermen.portal', volume: 0.45, pitch: 1.2 },
} as const;

export type Sfx = keyof typeof SFX;

/**
 * One action often reports itself twice - an arrival plays its own sound and
 * the caller then confirms it in chat - and two cues in the same instant read
 * as a glitch rather than as feedback. The first cue in a tick wins, so call
 * sites stay free to be expressive without coordinating with each other.
 */
const lastTick = new Map<string, number>();

/**
 * Plays one cue. Never throws: a sound is a nicety, and a player who logged
 * out mid-action must not take a command down with them.
 */
export function sfx(player: Player, name: Sfx): void {
  if (!cfg().soundsEnabled) return;

  const tick = system.currentTick;
  if (lastTick.get(player.id) === tick) return;
  lastTick.set(player.id, tick);

  const cue = SFX[name];
  try {
    player.playSound(cue.id, { volume: cue.volume, pitch: cue.pitch });
  } catch {
    // The player left, or is in a state that cannot receive sound.
  }
}

/** Drops a leaver's entry so the map cannot grow without bound. */
export function forgetSounds(playerId: string): void {
  lastTick.delete(playerId);
}
