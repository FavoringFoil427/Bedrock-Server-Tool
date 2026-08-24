import { Value } from './storage';



/** Items that cannot be obtained legitimately in survival. */
export const DEFAULT_ILLEGAL_ITEMS = [
  'minecraft:command_block',
  'minecraft:chain_command_block',
  'minecraft:repeating_command_block',
  'minecraft:command_block_minecart',
  'minecraft:structure_block',
  'minecraft:structure_void',
  'minecraft:jigsaw',
  'minecraft:barrier',
  'minecraft:light_block',
  'minecraft:allow',
  'minecraft:deny',
  'minecraft:border_block',
  'minecraft:bedrock',
  'minecraft:end_portal_frame',
  'minecraft:monster_egg',
  'minecraft:mob_spawner',
  'minecraft:budding_amethyst',
  'minecraft:dragon_egg',
  'minecraft:infested_deepslate',
];

/** Blocks nobody but staff may place. */
export const DEFAULT_BANNED_BLOCKS = [
  'minecraft:command_block',
  'minecraft:chain_command_block',
  'minecraft:repeating_command_block',
  'minecraft:structure_block',
  'minecraft:jigsaw',
  'minecraft:barrier',
  'minecraft:bedrock',
  'minecraft:allow',
  'minecraft:deny',
  'minecraft:border_block',
];

/** Blocks that must not be broken by ordinary players. */
export const DEFAULT_PROTECTED_BLOCKS = [
  'minecraft:bedrock',
  'minecraft:barrier',
  'minecraft:command_block',
  'minecraft:chain_command_block',
  'minecraft:repeating_command_block',
  'minecraft:structure_block',
  'minecraft:jigsaw',
  'minecraft:end_portal_frame',
  'minecraft:end_portal',
  'minecraft:nether_portal',
];

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

  /** Player warps: public destinations any player may publish. */
  playerWarpsEnabled: boolean;
  playerWarpLimit: number;
  /** Charged when publishing a player warp. 0 is free. */
  playerWarpCost: number;

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
  /** Hand a kit to every player on their first join. */
  starterKitEnabled: boolean;
  /** Which kit that is, so it can be pointed at any kit staff create. */
  starterKitId: string;
  jobsEnabled: boolean;
  skillsEnabled: boolean;
  /** Reward XP also grants spendable vanilla experience for enchanting. */
  rewardsGiveVanillaXp: boolean;
  combatTagSeconds: number;

  /** Daily block quotas (0 = unlimited) */
  blockQuotaEnabled: boolean;
  blockQuotaMined: number;
  blockQuotaPlaced: number;

  /** Anticheat: illegal items, duplication signatures and protected blocks. */
  anticheatEnabled: boolean;
  anticheatAlertStaff: boolean;
  anticheatCheckOverstacks: boolean;
  /** Violations before an automatic ban. 0 never auto-bans. */
  anticheatBanThreshold: number;
  /** Seconds between background inventory sweeps. 0 disables them. */
  anticheatScanSeconds: number;
  /** Duplication vectors, each independently switchable. */
  anticheatPistonDupe: boolean;
  anticheatMinecartDupe: boolean;
  anticheatPortalDupe: boolean;
  /**
   * Continuous sweep of the blocks around each player. One cube pass serves the
   * piston, funnel and container checks together, so the radius is the single
   * dial that governs all three.
   */
  anticheatNearbyScan: boolean;
  anticheatScanRadius: number;
  anticheatContainerScan: boolean;
  anticheatBundleExploit: boolean;
  anticheatIllegalItems: string[];
  anticheatBannedBlocks: string[];
  anticheatProtectedBlocks: string[];

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

    playerWarpsEnabled: true,
    playerWarpLimit: 2,
    playerWarpCost: 0,

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
    starterKitEnabled: true,
    starterKitId: 'starter',
    jobsEnabled: true,
    skillsEnabled: true,
    rewardsGiveVanillaXp: true,
    combatTagSeconds: 10,

    blockQuotaEnabled: false,
    blockQuotaMined: 0,
    blockQuotaPlaced: 0,

    anticheatEnabled: true,
    anticheatAlertStaff: true,
    anticheatCheckOverstacks: true,
    anticheatBanThreshold: 0,
    anticheatScanSeconds: 10,
    anticheatPistonDupe: true,
    anticheatMinecartDupe: true,
    anticheatPortalDupe: true,
    anticheatNearbyScan: true,
    anticheatScanRadius: 6,
    anticheatContainerScan: true,
    anticheatBundleExploit: true,
    anticheatIllegalItems: [...DEFAULT_ILLEGAL_ITEMS],
    anticheatBannedBlocks: [...DEFAULT_BANNED_BLOCKS],
    anticheatProtectedBlocks: [...DEFAULT_PROTECTED_BLOCKS],

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
