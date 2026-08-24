/** Minimal stand-in for @minecraft/server, enough to execute the bundle. */

function signal() {
  const subs = [];
  return {
    subscribe(cb) { subs.push(cb); return cb; },
    unsubscribe(cb) { const i = subs.indexOf(cb); if (i !== -1) subs.splice(i, 1); },
    emit(event) { for (const cb of subs) cb(event); },
    get count() { return subs.length; },
  };
}

const EVENT_NAMES_AFTER = [
  'entityDie', 'playerBreakBlock', 'playerPlaceBlock', 'playerSpawn', 'playerLeave',
  'itemUse', 'entityHurt', 'playerJoin', 'entityHitEntity', 'playerDimensionChange',
];
const EVENT_NAMES_BEFORE = [
  'playerBreakBlock', 'playerInteractWithBlock', 'playerInteractWithEntity',
  'entityHurt', 'playerLeave', 'chatSend', 'entityRemove',
];

function makeEvents(names) {
  const out = {};
  for (const n of names) out[n] = signal();
  return out;
}

export class Player {
  constructor(name = 'Tester', id = 'p1') {
    this.name = name;
    this.id = id;
    this.nameTag = name;
    this.isValid = true;
    this.location = { x: 0, y: 64, z: 0 };
    this.dimension = overworld;
    this.onScreenDisplay = { setActionBar() {}, setTitle() {} };
    this.lockedInput = new Map();
    this.inputPermissions = {
      setPermissionCategory: (category, enabled) => { this.lockedInput.set(category, enabled); },
    };
    this.messages = [];
    this.tags = new Set();
    // A real slot array, so inventory maths is actually exercised.
    this.slots = new Array(36).fill(undefined);
    this.mainhand = undefined;
    this.offhand = undefined;
    this.experience = 0;
    this.gameMode = 'survival';
    const slots = this.slots;
    this.container = {
      size: 36,
      get emptySlotsCount() { return slots.filter((s) => s === undefined).length; },
      getItem: (i) => slots[i],
      setItem: (i, item) => { slots[i] = item; },
      addItem: (item) => {
        const free = slots.indexOf(undefined);
        if (free !== -1) slots[free] = item;
      },
      clearAll: () => slots.fill(undefined),
    };
  }

  /** Test helper: put a stack in the inventory and in hand. */
  hold(typeId, amount, maxAmount = 64) {
    const stack = { typeId, amount, maxAmount };
    this.slots[0] = stack;
    this.mainhand = stack;
    return stack;
  }
  sendMessage(m) { this.messages.push(m); }
  teleport() {}
  addExperience(amount) { this.experience += amount; return this.experience; }
  addLevels(amount) { this.experience += amount * 10; return this.experience; }
  getTotalXp() { return this.experience; }
  getVelocity() { return { x: 0.2, y: 0, z: 0.2 }; }
  getHeadLocation() { return { x: this.location.x, y: this.location.y + 1.6, z: this.location.z }; }
  getViewDirection() { return { x: 0, y: 0, z: 1 }; }
  addEffect() {}
  removeEffect() {}
  hasTag(t) { return this.tags.has(t); }
  addTag(t) { this.tags.add(t); return true; }
  removeTag(t) { return this.tags.delete(t); }
  setGameMode(m) { this.gameMode = m; }
  getGameMode() { return this.gameMode ?? 'survival'; }
  runCommand() { return { successCount: 1 }; }
  getComponent(id) {
    if (id === 'minecraft:health') return { currentValue: 20, effectiveMax: 20, resetToMaxValue() {} };
    if (id === 'minecraft:inventory') return { container: this.container };
    if (id === 'minecraft:equippable') {
      return {
        getEquipment: (slot) =>
          slot === 'Mainhand' ? this.mainhand : slot === 'Offhand' ? this.offhand : undefined,
      };
    }
    return undefined;
  }
  getDynamicProperty() {}
  setDynamicProperty() {}
}

class Dimension {
  constructor(id) { this.id = id; this.blocks = new Map(); this.placed = []; }
  getEntities() { return []; }
  getPlayers() { return world.getAllPlayers(); }
  getTopmostBlock() { return { location: { x: 0, y: 64, z: 0 } }; }
  getBlock(loc) {
    const key = `${loc.x},${loc.y},${loc.z}`;
    if (this.blocks.has(key)) return this.blocks.get(key);
    // Empty space is air, not "no block": undefined means an unloaded chunk.
    return {
      typeId: 'minecraft:air',
      location: { ...loc },
      dimension: this,
      permutation: { getAllStates: () => ({}) },
      getComponent: () => undefined,
    };
  }
  setBlockType(loc, type) {
    this.placed.push({ loc, type });
    if (type === 'minecraft:air') this.blocks.delete(`${loc.x},${loc.y},${loc.z}`);
    else this.setBlock(loc.x, loc.y, loc.z, type);
  }
  /** Test helper: put a block into this dimension. */
  setBlock(x, y, z, typeId, states = {}, container) {
    const dimension = this;
    this.blocks.set(`${x},${y},${z}`, {
      typeId,
      location: { x, y, z },
      dimension,
      permutation: { getAllStates: () => states },
      getComponent: (id) => (id === 'minecraft:inventory' && container ? { container } : undefined),
    });
  }
  spawnEntity() {
    return { nameTag: '', getDynamicProperty() {}, setDynamicProperty() {}, remove() {}, location: { x: 0, y: 0, z: 0 } };
  }
  spawnItem() {}
  spawnParticle(id) { particles.push(id); }
  runCommand() { return { successCount: 1 }; }
}

/** Particle ids emitted this run, for assertions. */
const particles = [];

const overworld = new Dimension('minecraft:overworld');
const dimensions = {
  'overworld': overworld,
  'minecraft:overworld': overworld,
  'nether': new Dimension('minecraft:nether'),
  'minecraft:nether': new Dimension('minecraft:nether'),
  'the_end': new Dimension('minecraft:the_end'),
  'minecraft:the_end': new Dimension('minecraft:the_end'),
};

const props = new Map();
const players = [];

/**
 * The engine forbids touching world state while the script is still loading
 * (and during the startup event). Reproducing that here is the only way this
 * harness can catch code that reads storage at module scope.
 */
let earlyExecution = true;

function assertNotEarly(what) {
  if (earlyExecution) {
    throw new ReferenceError(`Native function [World::${what}] cannot be used in early execution.`);
  }
}

class ScoreboardObjective {
  constructor(id, displayName) { this.id = id; this.displayName = displayName; this.scores = new Map(); }
  getParticipants() { return []; }
  removeParticipant() {}
  setScore(p, v) { this.scores.set(p, v); }
}

export const world = {
  afterEvents: makeEvents(EVENT_NAMES_AFTER),
  beforeEvents: makeEvents(EVENT_NAMES_BEFORE),
  scoreboard: {
    objectives: new Map(),
    getObjective(id) { return this.objectives.get(id); },
    addObjective(id, name) { const o = new ScoreboardObjective(id, name); this.objectives.set(id, o); return o; },
    removeObjective(o) { this.objectives.delete(typeof o === 'string' ? o : o.id); },
    setObjectiveAtDisplaySlot() {},
    clearObjectiveAtDisplaySlot() {},
  },
  getAllPlayers() { return players; },
  getDimension(id) {
    const d = dimensions[id];
    if (!d) throw new Error(`unknown dimension ${id}`);
    return d;
  },
  getDefaultSpawnLocation() { return { x: 0, y: 64, z: 0 }; },
  setTimeOfDay() {},
  setDifficulty() {},
  sendMessage(m) { world.broadcasts.push(m); },
  broadcasts: [],
  getDynamicProperty(k) { assertNotEarly('getDynamicProperty'); return props.get(k); },
  setDynamicProperty(k, v) {
    assertNotEarly('setDynamicProperty');
    if (v === undefined) props.delete(k); else props.set(k, v);
  },
};

let nextHandle = 1;
export const system = {
  currentTick: 0,
  intervals: [],
  timeouts: [],
  beforeEvents: { startup: signal(), shutdown: signal() },
  // Real system.run defers to the next tick, after early execution ends.
  pending: [],
  run(cb) { system.pending.push(cb); return nextHandle++; },
  runTimeout(cb, ticks) { system.timeouts.push({ cb, ticks }); return nextHandle++; },
  runInterval(cb, ticks) { system.intervals.push({ cb, ticks }); return nextHandle++; },
  clearRun() {},
};

export class ItemStack {
  constructor(typeId, amount = 1) {
    if (typeof typeId !== 'string' || !typeId.includes(':')) throw new Error(`bad item ${typeId}`);
    this.typeId = typeId;
    this.amount = amount;
    this.maxAmount = 64;
  }
}

export const GameMode = { Survival: 'survival', Creative: 'creative', Adventure: 'adventure', Spectator: 'spectator' };
export const Difficulty = { Peaceful: 'peaceful', Easy: 'easy', Normal: 'normal', Hard: 'hard' };
export const EquipmentSlot = { Mainhand: 'Mainhand', Offhand: 'Offhand', Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet' };
export const DisplaySlotId = { Sidebar: 'Sidebar', List: 'List', BelowName: 'BelowName' };
export const ObjectiveSortOrder = { Ascending: 'Ascending', Descending: 'Descending' };
export const InputPermissionCategory = { Camera: 1, Movement: 2, Jump: 6 };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2 };
export const CustomCommandParamType = {
  Boolean: 'Boolean', Integer: 'Integer', Float: 'Float', String: 'String',
  PlayerSelector: 'PlayerSelector', EntitySelector: 'EntitySelector', Location: 'Location',
  BlockType: 'BlockType', ItemType: 'ItemType', EntityType: 'EntityType', Enum: 'Enum',
};
export const CustomCommandStatus = { Success: 0, Failure: 1 };
export const CustomCommandSource = { Entity: 'Entity', Block: 'Block', Server: 'Server', NPCDialogue: 'NPCDialogue' };
export class CustomCommandOrigin {}
export class Entity {}

export class MolangVariableMap {
  setColorRGB() {}
  setColorRGBA() {}
  setFloat() {}
  setSpeedAndDirection() {}
  setVector3() {}
}

/** A small set of real block ids is enough to exercise the quota check. */
const KNOWN_BLOCKS = new Set([
  'minecraft:stone', 'minecraft:dirt', 'minecraft:oak_log', 'minecraft:cobblestone',
  'minecraft:glass', 'minecraft:iron_block', 'minecraft:sand',
]);

export class BlockTypes {
  static get(typeName) { return KNOWN_BLOCKS.has(typeName) ? { id: typeName } : undefined; }
  static getAll() { return [...KNOWN_BLOCKS].map((id) => ({ id })); }
}

/** Test-only helpers. */
/**
 * Ends early execution and drains queued work, the way the first tick does.
 * Callbacks may queue more work, so this loops until quiet.
 */
function flush() {
  earlyExecution = false;
  for (let guard = 0; guard < 50 && system.pending.length; guard++) {
    const queued = system.pending.splice(0);
    for (const cb of queued) cb();
  }
}

export const __test = { players, props, overworld, signal, particles, flush };
