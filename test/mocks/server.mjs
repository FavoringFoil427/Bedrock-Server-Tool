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
  'itemUse', 'entityHurt', 'playerJoin', 'entityHitEntity',
];
const EVENT_NAMES_BEFORE = [
  'playerBreakBlock', 'playerInteractWithBlock', 'playerInteractWithEntity',
  'entityHurt', 'playerLeave', 'chatSend',
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
    this.inputPermissions = { setPermissionCategory() {} };
    this.messages = [];
    this.tags = new Set();
  }
  sendMessage(m) { this.messages.push(m); }
  teleport() {}
  getVelocity() { return { x: 0.2, y: 0, z: 0.2 }; }
  getHeadLocation() { return { x: this.location.x, y: this.location.y + 1.6, z: this.location.z }; }
  getViewDirection() { return { x: 0, y: 0, z: 1 }; }
  addEffect() {}
  removeEffect() {}
  hasTag(t) { return this.tags.has(t); }
  addTag(t) { this.tags.add(t); return true; }
  removeTag(t) { return this.tags.delete(t); }
  setGameMode() {}
  runCommand() { return { successCount: 1 }; }
  getComponent(id) {
    if (id === 'minecraft:health') return { currentValue: 20, effectiveMax: 20, resetToMaxValue() {} };
    if (id === 'minecraft:inventory') {
      return { container: { size: 36, emptySlotsCount: 36, getItem() {}, setItem() {}, addItem() {}, clearAll() {} } };
    }
    if (id === 'minecraft:equippable') return { getEquipment() { return undefined; } };
    return undefined;
  }
  getDynamicProperty() {}
  setDynamicProperty() {}
}

class Dimension {
  constructor(id) { this.id = id; }
  getEntities() { return []; }
  getPlayers() { return world.getAllPlayers(); }
  getTopmostBlock() { return { location: { x: 0, y: 64, z: 0 } }; }
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
  getDynamicProperty(k) { return props.get(k); },
  setDynamicProperty(k, v) { if (v === undefined) props.delete(k); else props.set(k, v); },
};

let nextHandle = 1;
export const system = {
  currentTick: 0,
  intervals: [],
  timeouts: [],
  beforeEvents: { startup: signal(), shutdown: signal() },
  run(cb) { cb(); return nextHandle++; },
  runTimeout(cb, ticks) { system.timeouts.push({ cb, ticks }); return nextHandle++; },
  runInterval(cb, ticks) { system.intervals.push({ cb, ticks }); return nextHandle++; },
  clearRun() {},
};

export class ItemStack {
  constructor(typeId, amount = 1) {
    if (typeof typeId !== 'string' || !typeId.includes(':')) throw new Error(`bad item ${typeId}`);
    this.typeId = typeId;
    this.amount = amount;
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
export const __test = { players, props, overworld, signal, particles };
