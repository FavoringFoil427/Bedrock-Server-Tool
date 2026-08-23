import { world, system } from '@minecraft/server';

/**
 * Persistence layer.
 *
 * Everything is stored in world dynamic properties. A single property has a
 * hard size ceiling, so each logical table is serialised to JSON and split
 * across numbered chunks. Tables are cached in memory and flushed on a short
 * debounce so hot paths (economy, skills) never pay serialisation cost per
 * write.
 */

const CHUNK_SIZE = 24_000;
const FLUSH_DELAY_TICKS = 40;

function readBlob(key: string): string | undefined {
  const count = world.getDynamicProperty(`${key}#n`);
  if (typeof count !== 'number') return undefined;
  let out = '';
  for (let i = 0; i < count; i++) {
    const part = world.getDynamicProperty(`${key}#${i}`);
    if (typeof part !== 'string') return undefined;
    out += part;
  }
  return out;
}

function writeBlob(key: string, data: string): void {
  const previous = world.getDynamicProperty(`${key}#n`);
  const previousCount = typeof previous === 'number' ? previous : 0;
  const count = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
  for (let i = 0; i < count; i++) {
    world.setDynamicProperty(`${key}#${i}`, data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  }
  // Release chunks left over from a previously larger payload.
  for (let i = count; i < previousCount; i++) {
    world.setDynamicProperty(`${key}#${i}`, undefined);
  }
  world.setDynamicProperty(`${key}#n`, count);
}

const dirty = new Set<Table<any>>();
let flushHandle: number | undefined;

function scheduleFlush(): void {
  if (flushHandle !== undefined) return;
  flushHandle = system.runTimeout(() => {
    flushHandle = undefined;
    flushAll();
  }, FLUSH_DELAY_TICKS);
}

/** Forces every pending table write to disk. Called on shutdown and on demand. */
export function flushAll(): void {
  for (const table of dirty) {
    try {
      table.flush();
    } catch (error) {
      console.warn(`[AdminSuite] failed to persist table: ${error}`);
    }
  }
  dirty.clear();
}

/**
 * A keyed collection of JSON-serialisable records backed by dynamic properties.
 */
export class Table<T> {
  private cache: Record<string, T> | undefined;

  constructor(
    readonly key: string,
    private readonly defaults: () => Record<string, T> = () => ({}),
  ) {}

  private load(): Record<string, T> {
    if (this.cache) return this.cache;
    const raw = readBlob(this.key);
    if (raw === undefined) {
      this.cache = this.defaults();
      return this.cache;
    }
    try {
      this.cache = JSON.parse(raw) as Record<string, T>;
    } catch (error) {
      console.warn(`[AdminSuite] table "${this.key}" is corrupt, resetting: ${error}`);
      this.cache = this.defaults();
    }
    return this.cache;
  }

  get(id: string): T | undefined {
    return this.load()[id];
  }

  has(id: string): boolean {
    return this.load()[id] !== undefined;
  }

  set(id: string, value: T): void {
    this.load()[id] = value;
    this.markDirty();
  }

  delete(id: string): boolean {
    const store = this.load();
    if (store[id] === undefined) return false;
    delete store[id];
    this.markDirty();
    return true;
  }

  /** Mutates a record in place and marks the table dirty. */
  update(id: string, mutate: (value: T) => void): boolean {
    const value = this.get(id);
    if (value === undefined) return false;
    mutate(value);
    this.markDirty();
    return true;
  }

  keys(): string[] {
    return Object.keys(this.load());
  }

  values(): T[] {
    return Object.values(this.load());
  }

  entries(): [string, T][] {
    return Object.entries(this.load());
  }

  get size(): number {
    return this.keys().length;
  }

  clear(): void {
    this.cache = {};
    this.markDirty();
  }

  /** Marks the table for a debounced write. Call after any in-place mutation. */
  markDirty(): void {
    dirty.add(this);
    scheduleFlush();
  }

  flush(): void {
    if (!this.cache) return;
    writeBlob(this.key, JSON.stringify(this.cache));
  }
}

/**
 * A single JSON value (used for config and other singletons).
 */
export class Value<T> {
  private cache: T | undefined;

  constructor(
    readonly key: string,
    private readonly fallback: () => T,
  ) {}

  get(): T {
    if (this.cache !== undefined) return this.cache;
    const raw = readBlob(this.key);
    if (raw === undefined) {
      this.cache = this.fallback();
      return this.cache;
    }
    try {
      // Merge onto defaults so upgrades pick up newly added settings.
      this.cache = { ...this.fallback(), ...(JSON.parse(raw) as object) } as T;
    } catch {
      this.cache = this.fallback();
    }
    return this.cache;
  }

  set(value: T): void {
    this.cache = value;
    this.save();
  }

  update(mutate: (value: T) => void): void {
    mutate(this.get());
    this.save();
  }

  save(): void {
    if (this.cache !== undefined) writeBlob(this.key, JSON.stringify(this.cache));
  }
}
