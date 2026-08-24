import { EquipmentSlot, Player } from '@minecraft/server';
import { menu, paged, prompt, askText, confirm } from '../core/ui';
import { cfg } from '../core/config';
import { profileOf, profiles } from '../core/profiles';
import { topRole } from '../core/permissions';
import { C, err, formatDuration, formatVec, ok, tell } from '../core/util';
import { balanceOf, money, richest, transfer } from '../modules/economy';
import { ShopEntry, auctions, buy, categories, itemsIn, listForSale, listingsOf, sell, unlist } from '../modules/shop';
import { warps, goTo, randomTeleport } from '../modules/teleport';
import { SKILLS, levelOf, levelProgress } from '../modules/skills';
import { describeRequirement, ladder, rankOf } from '../modules/ranks';
import { jobs } from '../modules/jobs';
import { claim as claimQuest, isClaimed, isComplete, progressFor, quests } from '../modules/quests';
import { claimKit, dailyReward, grant, kits } from '../modules/rewards';
import { claimAt, claims } from '../modules/land';
import { clanOf, clans } from '../modules/clans';
import { prettyItemName } from '../core/items';
import { codes } from '../modules/rewards';
import { openVaultCommand } from '../modules/vault';
import { cosmetics, equip as equipCosmetic, owns as ownsCosmetic, purchase as purchaseCosmetic } from '../modules/cosmetics';

/** The player-facing menu opened by the Member Suite item. */

export async function openMemberMenu(player: Player): Promise<void> {
  const profile = profileOf(player);
  const rank = rankOf(profile);
  const role = topRole(profile);

  await menu(player, {
    title: `${C.title}${cfg().serverName}`,
    body: [
      `${C.dim}Player: ${C.white}${profile.name}`,
      `${C.dim}Rank: ${C.reset}${rank ? rank.color + rank.name : role?.name ?? 'Member'}`,
      `${C.dim}Balance: ${C.good}${money(balanceOf(profile))}`,
    ].join('\n'),
    buttons: [
      { text: `${C.accent}Profile`, icon: 'textures/ui/adm_profile', onClick: () => openProfile(player) },
      { text: `${C.good}Shop`, icon: 'textures/ui/adm_shop', onClick: () => openShopCategories(player) },
      { text: `${C.gold}Auction House`, icon: 'textures/ui/adm_auction', onClick: () => openAuction(player) },
      { text: `${C.accent}Homes`, icon: 'textures/ui/adm_home', onClick: () => openHomes(player) },
      { text: `${C.accent}Warps`, icon: 'textures/ui/adm_warp', onClick: () => openWarps(player) },
      { text: `${C.warn}Land`, icon: 'textures/ui/adm_land', onClick: () => openLand(player) },
      { text: `${C.good}Rewards`, icon: 'textures/ui/adm_reward', onClick: () => openRewards(player) },
      { text: `${C.accent}Progression`, icon: 'textures/ui/adm_progress', onClick: () => openProgression(player) },
      { text: `${C.gold}Clan`, icon: 'textures/ui/adm_clan', onClick: () => openClan(player) },
      { text: `${C.accent}Vault`, icon: 'textures/ui/adm_vault', onClick: () => openVaultCommand(player) },
      { text: `${C.dim}Settings`, icon: 'textures/ui/adm_settings', onClick: () => openSettings(player) },
    ],
  });
}

/* ------------------------------------------------------------------ profile */

async function openProfile(player: Player): Promise<void> {
  const profile = profileOf(player);
  const rank = rankOf(profile);
  const clan = clanOf(profile.id);

  const lines = [
    `${C.dim}Rank: ${C.reset}${rank ? rank.color + rank.name : 'None'}`,
    `${C.dim}Balance: ${C.good}${money(balanceOf(profile))}`,
    `${C.dim}Playtime: ${C.white}${formatDuration(profile.playtimeMs)}`,
    `${C.dim}Clan: ${C.white}${clan ? `${clan.name} [${clan.tag}]` : 'none'}`,
    `${C.dim}Job: ${C.white}${profile.jobId ? jobs.get(profile.jobId)?.name ?? 'none' : 'none'}`,
    '',
    `${C.gold}Stats`,
    `${C.dim}Kills: ${C.white}${profile.stats.kills}  ${C.dim}Deaths: ${C.white}${profile.stats.deaths}`,
    `${C.dim}Mobs: ${C.white}${profile.stats.mobKills}`,
    `${C.dim}Blocks mined: ${C.white}${profile.stats.blocksMined}`,
    `${C.dim}Blocks placed: ${C.white}${profile.stats.blocksPlaced}`,
    `${C.dim}Claim blocks: ${C.white}${profile.claimBlocks}`,
  ].join('\n');

  await menu(player, {
    title: `${C.title}${profile.name}`,
    body: lines,
    buttons: [
      { text: `${C.gold}Top Balances`, onClick: () => openBaltop(player) },
      { text: `${C.accent}Pay a Player`, onClick: () => openPay(player) },
    ],
    back: () => openMemberMenu(player),
  });
}

async function openBaltop(player: Player): Promise<void> {
  const lines = richest(10)
    .map((profile, index) => `${C.gold}${index + 1}. ${C.white}${profile.name} ${C.dim}- ${money(balanceOf(profile))}`)
    .join('\n');
  await menu(player, {
    title: `${C.title}Top Balances`,
    body: lines || `${C.dim}No data yet.`,
    buttons: [],
    back: () => openProfile(player),
  });
}

async function openPay(player: Player): Promise<void> {
  const others = profiles.values().filter((p) => p.id !== player.id);
  if (others.length === 0) return err(player, 'There is nobody to pay.');

  const values = await prompt(player, 'Pay a player', [
    { kind: 'dropdown', label: 'Player', options: others.map((p) => p.name) },
    { kind: 'text', label: 'Amount', placeholder: '100' },
  ]);
  if (!values) return;

  const target = others[Number(values[0])];
  const amount = Number.parseInt(String(values[1]), 10);
  if (!Number.isFinite(amount) || amount <= 0) return err(player, 'Give a valid amount.');
  if (!transfer(profileOf(player), target, amount)) return err(player, `You need ${money(amount)}.`);
  ok(player, `Paid ${money(amount)} to ${target.name}.`);
}

/* --------------------------------------------------------------------- shop */

export async function openShopCategories(player: Player): Promise<void> {
  const list = categories();
  const empty = list.length === 0;
  await menu(player, {
    title: `${C.title}Shop`,
    body: empty
      ? `${C.dim}The shop is empty. Hold something and use "Sell your items here".`
      : `${C.dim}Balance: ${C.good}${money(balanceOf(profileOf(player)))}`,
    buttons: [
      ...list.map((category) => ({
        text: `${C.accent}${category}`,
        onClick: () => openShopCategory(player, category),
      })),
      { text: `${C.good}+ Sell your items here`, onClick: () => openSellForm(player) },
      { text: `${C.gold}My listings (${listingsOf(player.id).length})`, onClick: () => openMyListings(player) },
    ],
    back: () => openMemberMenu(player),
  });
}

/** Lists whatever the player is holding, at a price they choose. */
async function openSellForm(player: Player): Promise<void> {
  const held = player.getComponent('minecraft:equippable')?.getEquipment(EquipmentSlot.Mainhand);
  if (!held) return err(player, 'Hold the item you want to sell, then try again.');

  const known = categories().filter((c) => c !== 'Player Stalls');
  const options = ['Player Stalls', ...known];

  const values = await prompt(player, `Sell ${prettyItemName(held.typeId)}`, [
    { kind: 'text', label: 'Price per bundle', placeholder: '100' },
    { kind: 'slider', label: 'Items per bundle', min: 1, max: 64, step: 1, default: 1 },
    { kind: 'slider', label: 'Bundles to list', min: 1, max: 36, step: 1, default: 1 },
    { kind: 'dropdown', label: 'Category', options },
  ]);
  if (!values) return;

  const price = Number.parseInt(String(values[0]), 10);
  if (!Number.isFinite(price) || price <= 0) return err(player, 'Give a price above zero.');

  const problem = listForSale(player, price, Number(values[1]), Number(values[2]), options[Number(values[3])]);
  if (problem) return err(player, problem);
  ok(player, `Listed for ${money(price)} per bundle.`);
}

async function openMyListings(player: Player): Promise<void> {
  const mine = listingsOf(player.id);
  await paged(player, {
    title: `${C.title}My listings`,
    body: mine.length === 0 ? `${C.dim}You have nothing listed.` : `${C.dim}Tap a listing to take it down.`,
    items: mine,
    render: (entry) => ({
      text: `${C.white}${entry.amount}x ${entry.name}\n${C.dim}${money(entry.buyPrice)} each - ${entry.stock} left`,
    }),
    onPick: async (entry) => {
      const yes = await confirm(player, 'Take down listing', `Remove ${entry.name} and get the stock back?`, `${C.good}Take down`);
      if (!yes) return;
      const problem = unlist(player, entry);
      if (problem) err(player, problem);
      else ok(player, 'Listing removed and stock returned.');
    },
    back: () => openShopCategories(player),
  });
}

async function openShopCategory(player: Player, category: string): Promise<void> {
  await paged(player, {
    title: `${C.title}${category}`,
    body: `${C.dim}Balance: ${C.good}${money(balanceOf(profileOf(player)))}`,
    items: itemsIn(category),
    render: (entry) => ({
      text: entry.sellerId
        ? `${C.white}${entry.amount}x ${entry.name}\n${C.dim}${money(entry.buyPrice)} - ${entry.stock} left, from ${entry.sellerName}`
        : `${C.white}${entry.amount}x ${entry.name}\n${C.dim}${entry.buyPrice > 0 ? `Buy ${money(entry.buyPrice)}` : 'Not for sale'}${entry.sellPrice > 0 ? ` | Sell ${money(entry.sellPrice)}` : ''}`,
    }),
    onPick: (entry) => openShopItem(player, entry, category),
    back: () => openShopCategories(player),
  });
}

async function openShopItem(player: Player, entry: ShopEntry, category: string): Promise<void> {
  const buttons = [];
  if (entry.buyPrice > 0) {
    buttons.push({
      text: `${C.good}Buy ${entry.amount}x - ${money(entry.buyPrice)}`,
      onClick: async () => {
        const problem = buy(player, entry, 1);
        if (problem) err(player, problem);
        else ok(player, `Bought ${entry.amount}x ${entry.name}.`);
        await openShopItem(player, entry, category);
      },
    });
    buttons.push({
      text: `${C.good}Buy a custom amount`,
      onClick: async () => {
        const answer = await askText(player, `Buy ${entry.name}`, 'How many bundles?', '1', '1');
        const bundles = Number.parseInt(answer ?? '', 10);
        if (!Number.isFinite(bundles) || bundles < 1) return err(player, 'Give a valid number.');
        const problem = buy(player, entry, bundles);
        if (problem) err(player, problem);
        else ok(player, `Bought ${entry.amount * bundles}x ${entry.name}.`);
      },
    });
  }
  if (entry.sellPrice > 0) {
    buttons.push({
      text: `${C.warn}Sell ${entry.amount}x - ${money(entry.sellPrice)}`,
      onClick: async () => {
        const problem = sell(player, entry, 1);
        if (problem) err(player, problem);
        else ok(player, `Sold for ${money(entry.sellPrice)}.`);
        await openShopItem(player, entry, category);
      },
    });
  }

  await menu(player, {
    title: `${C.title}${entry.name}`,
    body: [
      `${C.dim}Item: ${C.white}${prettyItemName(entry.typeId)}`,
      `${C.dim}Bundle size: ${C.white}${entry.amount}`,
      `${C.dim}Your balance: ${C.good}${money(balanceOf(profileOf(player)))}`,
    ].join('\n'),
    buttons,
    back: () => openShopCategory(player, category),
  });
}

async function openAuction(player: Player): Promise<void> {
  const lots = auctions.values();
  await paged(player, {
    title: `${C.title}Auction House`,
    body: `${C.dim}Balance: ${C.good}${money(balanceOf(profileOf(player)))}`,
    items: lots,
    render: (lot) => ({
      text: `${C.white}${lot.amount}x ${prettyItemName(lot.typeId)}\n${C.dim}${money(lot.price)} - ${lot.sellerName}`,
    }),
    onPick: async (lot) => {
      const yes = await confirm(
        player,
        'Buy listing',
        `Buy ${lot.amount}x ${prettyItemName(lot.typeId)} for ${money(lot.price)}?`,
        `${C.good}Buy`,
      );
      if (!yes) return;
      tell(player, `${C.dim}Use !ah buy ${lot.id} to complete the purchase.`);
    },
    back: () => openMemberMenu(player),
  });
}

/* ---------------------------------------------------------------- teleports */

async function openHomes(player: Player): Promise<void> {
  const profile = profileOf(player);
  const names = Object.keys(profile.homes);

  await menu(player, {
    title: `${C.title}Homes`,
    body: `${C.dim}${names.length}/${cfg().homeLimitDefault} used`,
    buttons: [
      ...names.map((name) => ({
        text: `${C.accent}${name}\n${C.dim}${formatVec(profile.homes[name])}`,
        onClick: async () => {
          goTo(player, profile.homes[name]);
          ok(player, `Teleported home (${name}).`);
        },
      })),
      {
        text: `${C.good}+ Set a home here`,
        onClick: async () => {
          const name = (await askText(player, 'Set home', 'Home name', 'home', 'home'))?.toLowerCase();
          if (!name) return;
          if (!profile.homes[name] && names.length >= cfg().homeLimitDefault) {
            return err(player, 'You have reached your home limit.');
          }
          const { x, y, z } = player.location;
          profile.homes[name] = { x, y, z, dimension: player.dimension.id };
          profiles.markDirty();
          ok(player, `Home "${name}" set.`);
        },
      },
      {
        text: `${C.bad}- Delete a home`,
        onClick: async () => {
          if (names.length === 0) return err(player, 'You have no homes.');
          const values = await prompt(player, 'Delete home', [
            { kind: 'dropdown', label: 'Home', options: names },
          ]);
          if (!values) return;
          const name = names[Number(values[0])];
          delete profile.homes[name];
          profiles.markDirty();
          ok(player, `Home "${name}" deleted.`);
        },
      },
    ],
    back: () => openMemberMenu(player),
  });
}

async function openWarps(player: Player): Promise<void> {
  const list = warps.values();
  await paged(player, {
    title: `${C.title}Warps`,
    items: list,
    render: (warp) => ({
      text: `${C.accent}${warp.name}${warp.cost > 0 ? `\n${C.dim}${money(warp.cost)}` : ''}`,
    }),
    onPick: async (warp) => {
      goTo(player, warp);
      ok(player, `Warped to ${warp.name}.`);
    },
    back: () => openMemberMenu(player),
  });
}

/* --------------------------------------------------------------------- land */

async function openLand(player: Player): Promise<void> {
  const here = claimAt(player.dimension.id, player.location);
  const profile = profileOf(player);
  const mine = claims.values().filter((c) => c.ownerId === player.id);

  await menu(player, {
    title: `${C.title}Land`,
    body: [
      `${C.dim}Claim blocks: ${C.white}${profile.claimBlocks}`,
      `${C.dim}Your claims: ${C.white}${mine.length}`,
      here ? `${C.dim}Standing in: ${C.white}${here.name}` : `${C.dim}This land is unclaimed.`,
    ].join('\n'),
    buttons: [
      {
        text: `${C.good}Claim land here`,
        onClick: async () => {
          const answer = await askText(player, 'Claim land', 'Radius in blocks', '16', '16');
          if (!answer) return;
          tell(player, `${C.dim}Use !claim ${answer} to confirm.`);
        },
      },
      ...(here && here.ownerId === player.id
        ? [
            {
              text: `${C.warn}Toggle PvP (${here.allowPvp ? 'on' : 'off'})`,
              onClick: async () => {
                here.allowPvp = !here.allowPvp;
                claims.markDirty();
                ok(player, `PvP is now ${here.allowPvp ? 'allowed' : 'blocked'} here.`);
              },
            },
            {
              text: `${C.warn}Toggle shared containers (${here.allowContainers ? 'on' : 'off'})`,
              onClick: async () => {
                here.allowContainers = !here.allowContainers;
                claims.markDirty();
                ok(player, `Containers are now ${here.allowContainers ? 'shared' : 'private'}.`);
              },
            },
          ]
        : []),
      {
        text: `${C.accent}Random teleport`,
        onClick: async () => {
          tell(player, `${C.dim}Finding somewhere to drop you...`);
          if (await randomTeleport(player)) ok(player, 'Teleported to the wild.');
          else err(player, 'Could not find a safe spot.');
        },
      },
    ],
    back: () => openMemberMenu(player),
  });
}

/* ------------------------------------------------------------------ rewards */

async function openRewards(player: Player): Promise<void> {
  const profile = profileOf(player);
  await menu(player, {
    title: `${C.title}Rewards`,
    buttons: [
      {
        text: `${C.good}Daily Reward\n${C.dim}Streak: ${profile.dailyStreak}`,
        onClick: async () => {
          const DAY = 86_400_000;
          const elapsed = Date.now() - (profile.dailyLastClaim ?? 0);
          if (elapsed < DAY) return err(player, `Ready in ${formatDuration(DAY - elapsed)}.`);
          profile.dailyStreak = elapsed < DAY * 2 ? profile.dailyStreak + 1 : 1;
          profile.dailyLastClaim = Date.now();
          profiles.markDirty();
          ok(player, `Daily reward - day ${profile.dailyStreak}!`);
          grant(player, dailyReward(profile.dailyStreak));
        },
      },
      { text: `${C.accent}Kits`, onClick: () => openKits(player) },
      { text: `${C.gold}Cosmetics`, onClick: () => openCosmetics(player) },
      {
        text: `${C.gold}Redeem a code`,
        onClick: async () => {
          const code = (await askText(player, 'Redeem code', 'Enter your code', 'CODE'))?.toUpperCase();
          if (!code) return;
          const entry = codes.get(code);
          if (!entry) return err(player, 'That code is not valid.');
          if (entry.usedBy.includes(profile.id)) return err(player, 'You already redeemed that code.');
          if (entry.maxUses > 0 && entry.uses >= entry.maxUses) return err(player, 'That code is used up.');
          entry.uses++;
          entry.usedBy.push(profile.id);
          codes.markDirty();
          ok(player, `Code ${code} redeemed!`);
          grant(player, entry.reward);
        },
      },
    ],
    back: () => openMemberMenu(player),
  });
}

async function openCosmetics(player: Player): Promise<void> {
  const profile = profileOf(player);
  await paged(player, {
    title: `${C.title}Cosmetics`,
    body: `${C.dim}Balance: ${C.good}${money(balanceOf(profile))}`,
    items: [
      ...(profile.cosmeticEquipped ? [undefined] : []),
      ...cosmetics.values(),
    ],
    render: (cosmetic) =>
      cosmetic === undefined
        ? { text: `${C.bad}Remove current cosmetic` }
        : {
            text: `${profile.cosmeticEquipped === cosmetic.id ? C.good : ownsCosmetic(player, cosmetic) ? C.accent : C.dim}${cosmetic.name}\n${C.dim}${cosmetic.kind} - ${
              profile.cosmeticEquipped === cosmetic.id
                ? 'equipped'
                : ownsCosmetic(player, cosmetic)
                  ? 'owned'
                  : money(cosmetic.cost)
            }`,
          },
    onPick: async (cosmetic) => {
      if (cosmetic === undefined) {
        equipCosmetic(player, undefined);
        return ok(player, 'Cosmetic removed.');
      }
      if (!ownsCosmetic(player, cosmetic)) {
        const problem = purchaseCosmetic(player, cosmetic);
        if (problem) return err(player, problem);
        ok(player, `Bought ${cosmetic.name}.`);
      }
      equipCosmetic(player, cosmetic.id);
      ok(player, `Now wearing ${cosmetic.name}.`);
    },
    back: () => openRewards(player),
  });
}

async function openKits(player: Player): Promise<void> {
  await paged(player, {
    title: `${C.title}Kits`,
    items: kits.values(),
    render: (kit) => ({
      text: `${C.accent}${kit.name}\n${C.dim}${kit.cooldown === 0 ? 'One time' : `Every ${formatDuration(kit.cooldown * 1000)}`}`,
      ...(kit.icon ? { icon: kit.icon } : {}),
    }),
    onPick: async (kit) => {
      const problem = claimKit(player, kit);
      if (problem) err(player, problem);
      else ok(player, `Claimed ${kit.name}.`);
    },
    back: () => openRewards(player),
  });
}

/* -------------------------------------------------------------- progression */

async function openProgression(player: Player): Promise<void> {
  await menu(player, {
    title: `${C.title}Progression`,
    buttons: [
      { text: `${C.accent}Skills`, onClick: () => openSkills(player) },
      { text: `${C.gold}Ranks`, onClick: () => openRanks(player) },
      { text: `${C.good}Jobs`, onClick: () => openJobs(player) },
      { text: `${C.warn}Quests`, onClick: () => openQuests(player) },
    ],
    back: () => openMemberMenu(player),
  });
}

async function openSkills(player: Player): Promise<void> {
  const profile = profileOf(player);
  const lines = SKILLS.map((skill) => {
    const xp = profile.skills[skill.id] ?? 0;
    const [have, need] = levelProgress(xp);
    return `${C.accent}${skill.name} ${C.white}Lv.${levelOf(xp)} ${C.dim}(${have}/${need})`;
  }).join('\n');

  await menu(player, {
    title: `${C.title}Skills`,
    body: lines,
    buttons: SKILLS.map((skill) => ({
      text: `${C.accent}${skill.name}`,
      icon: skill.icon,
      onClick: async () => {
        const xp = profile.skills[skill.id] ?? 0;
        await menu(player, {
          title: `${C.title}${skill.name}`,
          body: `${C.dim}${skill.description}\n\n${C.white}Level ${levelOf(xp)}\n${C.dim}Perk unlocks at level ${skill.perkLevel}.`,
          buttons: [],
          back: () => openSkills(player),
        });
      },
    })),
    back: () => openProgression(player),
  });
}

async function openRanks(player: Player): Promise<void> {
  const profile = profileOf(player);
  const list = ladder();
  const lines = list
    .map((rank, index) => `${rank.color}${rank.name} ${C.dim}- ${describeRequirement(rank)}${index === profile.rankIndex ? `${C.good} <- you` : ''}`)
    .join('\n');

  await menu(player, {
    title: `${C.title}Ranks`,
    body: lines,
    buttons: [],
    back: () => openProgression(player),
  });
}

async function openJobs(player: Player): Promise<void> {
  const profile = profileOf(player);
  await paged(player, {
    title: `${C.title}Jobs`,
    body: profile.jobId ? `${C.dim}Current: ${C.white}${jobs.get(profile.jobId)?.name}` : `${C.dim}You have no job.`,
    items: jobs.values(),
    render: (job) => ({
      text: `${C.accent}${job.name}\n${C.dim}${job.description}`,
      ...(job.icon ? { icon: job.icon } : {}),
    }),
    onPick: async (job) => {
      profile.jobId = job.id;
      profiles.markDirty();
      ok(player, `You are now a ${job.name}.`);
    },
    back: () => openProgression(player),
  });
}

async function openQuests(player: Player): Promise<void> {
  await paged(player, {
    title: `${C.title}Quests`,
    items: quests.values(),
    render: (quest) => {
      const have = Math.min(progressFor(player, quest), quest.amount);
      const state = isClaimed(player, quest)
        ? `${C.dim}Completed`
        : have >= quest.amount
          ? `${C.good}Ready to claim`
          : `${C.warn}${have}/${quest.amount}`;
      return { text: `${C.accent}${quest.name}\n${C.dim}${quest.description} - ${state}` };
    },
    onPick: async (quest) => {
      if (!isComplete(player, quest)) return err(player, 'That quest is not finished yet.');
      const problem = claimQuest(player, quest);
      if (problem) err(player, problem);
      else ok(player, `Quest complete: ${quest.name}`);
    },
    back: () => openProgression(player),
  });
}

/* --------------------------------------------------------------------- clan */

async function openClan(player: Player): Promise<void> {
  const profile = profileOf(player);
  const clan = clanOf(profile.id);

  if (!clan) {
    await menu(player, {
      title: `${C.title}Clans`,
      body: `${C.dim}You are not in a clan.`,
      buttons: [
        {
          text: `${C.good}Create a clan`,
          onClick: async () => {
            const name = await askText(player, 'Create clan', 'Clan name', 'Wolves');
            if (!name) return;
            tell(player, `${C.dim}Use !clan create ${name} to confirm.`);
          },
        },
        {
          text: `${C.accent}Browse clans`,
          onClick: async () => {
            const lines = clans
              .values()
              .map((c) => `${C.accent}[${c.tag}] ${C.white}${c.name} ${C.dim}- ${c.members.length} members`)
              .join('\n');
            await menu(player, {
              title: `${C.title}Clans`,
              body: lines || `${C.dim}No clans yet.`,
              buttons: [],
              back: () => openClan(player),
            });
          },
        },
      ],
      back: () => openMemberMenu(player),
    });
    return;
  }

  const names = clan.members.map((id) => profiles.get(id)?.name ?? 'unknown').join(', ');
  await menu(player, {
    title: `${C.title}${clan.name} [${clan.tag}]`,
    body: [
      `${C.dim}Owner: ${C.white}${profiles.get(clan.ownerId)?.name ?? 'unknown'}`,
      `${C.dim}Members: ${C.white}${names}`,
      `${C.dim}Bank: ${C.good}${money(clan.bank)}`,
    ].join('\n'),
    buttons: [
      {
        text: `${C.good}Deposit to bank`,
        onClick: async () => {
          const answer = await askText(player, 'Deposit', 'Amount', '100');
          if (answer) tell(player, `${C.dim}Use !clan bank deposit ${answer} to confirm.`);
        },
      },
      {
        text: `${C.accent}Clan chat`,
        onClick: async () => {
          const message = await askText(player, 'Clan chat', 'Message', 'Hello!');
          if (message) tell(player, `${C.dim}Use !clan chat ${message}`);
        },
      },
    ],
    back: () => openMemberMenu(player),
  });
}

/* ----------------------------------------------------------------- settings */

async function openSettings(player: Player): Promise<void> {
  const profile = profileOf(player);
  await menu(player, {
    title: `${C.title}Settings`,
    buttons: [
      {
        text: `${C.accent}Duel challenges: ${profile.duelsOff ? `${C.bad}off` : `${C.good}on`}`,
        onClick: async () => {
          profile.duelsOff = !profile.duelsOff;
          profiles.markDirty();
          ok(player, `Duel challenges ${profile.duelsOff ? 'blocked' : 'allowed'}.`);
          await openSettings(player);
        },
      },
      {
        text: `${C.accent}Name colour`,
        onClick: async () => {
          const palette = ['§c red', '§6 gold', '§e yellow', '§a green', '§b aqua', '§9 blue', '§d pink', '§f white'];
          const values = await prompt(player, 'Name colour', [
            { kind: 'dropdown', label: 'Colour', options: palette },
          ]);
          if (!values) return;
          profile.nameColor = palette[Number(values[0])].slice(0, 2);
          profiles.markDirty();
          ok(player, `Your name colour is now ${profile.nameColor}this${C.reset}.`);
        },
      },
    ],
    back: () => openMemberMenu(player),
  });
}
