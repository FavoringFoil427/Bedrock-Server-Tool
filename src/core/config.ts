import { Value } from './storage';

/** Every tunable the settings menu can edit. Stored as one JSON blob. */
export interface Config {
  /** Chat prefix for text commands (native `/adm:` commands always work too). */
  commandPrefix: string;
  language: string;

  serverName: string;
  motd: string;

  /** Economy */
  /** Player stalls: anyone may list their own stock at their own price. */
  playerListingsEnabled: boolean;
  maxListingsPerPlayer: number;
  /** Percentage the server takes from each player sale, as an economy sink. */
  marketFeePercent: number;
  /** Purchases at or above this ask for confirmation first. 0 disables. */
  confirmPurchaseAbove: number;
  /** Ceiling on what a player may charge per bundle. 0 means no limit. */
  maxListingPrice: number;

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
  /**
   * Sidebar rows. The scoreboard sidebar is world-global in Bedrock, so these
   * may only use server-wide tokens ({online}, {server}); per-player values
   * belong in `actionBarFormat`.
   */
  sidebarLines: string[];
  /** Per-player status line, shown on the action bar. Empty disables it. */
  actionBarEnabled: boolean;
  actionBarFormat: string;
  hologramsEnabled: boolean;

  /** World border (soft border enforced by script) */
  worldBorderEnabled: boolean;
  worldBorderRadius: number;

  /** Systems */
  registrationRequired: boolean;
  broadcastIntervalSeconds: number;
  broadcastEnabled: boolean;
  gravestonesEnabled: boolean;
  cosmeticsEnabled: boolean;
  duelsEnabled: boolean;
  dailyRewardEnabled: boolean;
  jobsEnabled: boolean;
  skillsEnabled: boolean;
  /** Reward XP also grants spendable vanilla experience for enchanting. */
  rewardsGiveVanillaXp: boolean;
  combatTagSeconds: number;

  /** Daily block quotas (0 = unlimited) */
  blockQuotaEnabled: boolean;
  blockQuotaMined: number;
  blockQuotaPlaced: number;

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

    playerListingsEnabled: true,
    maxListingsPerPlayer: 5,
    marketFeePercent: 0,
    confirmPurchaseAbove: 1000,
    maxListingPrice: 0,

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
      '§7Server: §f{server}',
      '§7Online: §f{online}',
      '§7Use §b!info',
    ],
    actionBarEnabled: true,
    actionBarFormat: '§7{rank} §f{name}  §a{symbol}{balance}  §7{playtime}',
    hologramsEnabled: true,

    worldBorderEnabled: false,
    worldBorderRadius: 5000,

    registrationRequired: false,
    broadcastIntervalSeconds: 300,
    broadcastEnabled: true,
    gravestonesEnabled: true,
    cosmeticsEnabled: true,
    duelsEnabled: true,
    dailyRewardEnabled: true,
    jobsEnabled: true,
    skillsEnabled: true,
    rewardsGiveVanillaXp: true,
    combatTagSeconds: 10,

    blockQuotaEnabled: false,
    blockQuotaMined: 0,
    blockQuotaPlaced: 0,

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
