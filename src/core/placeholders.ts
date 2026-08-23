import { Player, world } from '@minecraft/server';
import { cfg } from './config';
import { profileOf } from './profiles';
import { topRole } from './permissions';
import { formatDuration, formatNumber } from './util';
import { balanceOf } from '../modules/economy';
import { rankOf } from '../modules/ranks';

/**
 * Placeholder expansion shared by chat, nametags, the sidebar and holograms so
 * every surface understands the same `{tokens}`.
 */
export function expand(player: Player, template: string, extra: Record<string, string> = {}): string {
  const profile = profileOf(player);
  const role = topRole(profile);
  const rank = rankOf(profile);
  const config = cfg();

  const health = player.getComponent('minecraft:health');
  const clanName = profile.clanId ?? '';

  const tokens: Record<string, string> = {
    name: profile.name,
    namecolor: profile.nameColor ?? '§f',
    role: role?.prefix ?? '',
    rolecolor: role?.color ?? '§7',
    rank: rank?.prefix ?? role?.prefix ?? '',
    rankcolor: rank?.color ?? role?.color ?? '§7',
    rankname: rank?.name ?? '',
    balance: formatNumber(balanceOf(profile)),
    symbol: config.currencySymbol,
    currency: config.currencyName,
    online: String(world.getAllPlayers().length),
    playtime: formatDuration(profile.playtimeMs),
    kills: String(profile.stats.kills),
    deaths: String(profile.stats.deaths),
    mined: String(profile.stats.blocksMined),
    xp: String(profile.xp),
    clan: clanName,
    server: config.serverName,
    health: String(Math.ceil(health?.currentValue ?? 20)),
    maxhealth: String(Math.ceil(health?.effectiveMax ?? 20)),
    ...extra,
  };

  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in tokens ? tokens[key] : whole,
  );
}
