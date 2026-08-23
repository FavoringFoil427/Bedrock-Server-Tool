import { Value } from './storage';

/** Every tunable the settings menu can edit. Stored as one JSON blob. */
export interface Config {
  /** Chat prefix for text commands (native `/adm:` commands always work too). */
  commandPrefix: string;
  language: string;

  serverName: string;
  motd: string;

  /** Economy */
  currencySymbol: string;
  currencyName: string;
  startingBalance: number;
  payTaxPercent: number;

  /** Teleporting */
  tpaTimeoutSeconds: number;
  tpaWarmupSeconds: number;
  homeLimitDefault: number;
  rtpMinRadius: number;
  rtpMaxRadius: number;
  rtpCooldownSeconds: number;
  warpCooldownSeconds: number;

  /** Land claims */
  claimBlocksDefault: number;
  claimMaxRadius: number;
  claimsEnabled: boolean;

  /** Presentation */
  chatFormatEnabled: boolean;
  chatFormat: string;
  nametagsEnabled: boolean;
  nametagFormat: string;
  sidebarEnabled: boolean;
  sidebarTitle: string;
  sidebarLines: string[];
  hologramsEnabled: boolean;

  /** World border (soft border enforced by script) */
  worldBorderEnabled: boolean;
  worldBorderRadius: number;

  /** Systems */
  registrationRequired: boolean;
  broadcastIntervalSeconds: number;
  broadcastEnabled: boolean;
  gravestonesEnabled: boolean;
  duelsEnabled: boolean;
  dailyRewardEnabled: boolean;
  jobsEnabled: boolean;
  skillsEnabled: boolean;
  combatTagSeconds: number;

  /** Moderation */
  antiSpamEnabled: boolean;
  antiSpamIntervalMs: number;
  maxMessageLength: number;
  bannedWords: string[];
}

export function defaultConfig(): Config {
  return {
    commandPrefix: '!',
    language: 'en',

    serverName: 'My Server',
    motd: '§bWelcome to the server!',

    currencySymbol: '$',
    currencyName: 'Coins',
    startingBalance: 100,
    payTaxPercent: 0,

    tpaTimeoutSeconds: 60,
    tpaWarmupSeconds: 3,
    homeLimitDefault: 3,
    rtpMinRadius: 500,
    rtpMaxRadius: 5000,
    rtpCooldownSeconds: 120,
    warpCooldownSeconds: 5,

    claimBlocksDefault: 2048,
    claimMaxRadius: 64,
    claimsEnabled: true,

    chatFormatEnabled: true,
    chatFormat: '{rankcolor}{rank} §r{namecolor}{name}§r§7:§f {message}',
    nametagsEnabled: true,
    nametagFormat: '{rankcolor}{rank}\n§f{name}\n§c{health}§4❤',
    sidebarEnabled: true,
    sidebarTitle: '§l§bSERVER',
    sidebarLines: [
      '§7Player: §f{name}',
      '§7Rank: §f{rank}',
      '§7Balance: §a{symbol}{balance}',
      '§7Online: §f{online}',
      '§7Playtime: §f{playtime}',
    ],
    hologramsEnabled: true,

    worldBorderEnabled: false,
    worldBorderRadius: 5000,

    registrationRequired: false,
    broadcastIntervalSeconds: 300,
    broadcastEnabled: true,
    gravestonesEnabled: true,
    duelsEnabled: true,
    dailyRewardEnabled: true,
    jobsEnabled: true,
    skillsEnabled: true,
    combatTagSeconds: 10,

    antiSpamEnabled: true,
    antiSpamIntervalMs: 700,
    maxMessageLength: 180,
    bannedWords: [],
  };
}

const store = new Value<Config>('adm:config', defaultConfig);

export function cfg(): Config {
  return store.get();
}

export function saveConfig(mutate?: (config: Config) => void): void {
  if (mutate) store.update(mutate);
  else store.save();
}
