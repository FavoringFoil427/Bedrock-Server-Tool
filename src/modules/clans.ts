import { world } from '@minecraft/server';
import { register } from '../core/commands';
import { Table } from '../core/storage';
import { onlinePlayer, profileByName, profileOf, profiles } from '../core/profiles';
import { C, err, ok, tell, uid } from '../core/util';
import { addMoney, balanceOf, charge, money } from './economy';

/** Player clans with a shared bank, invites and clan chat. */

export interface Clan {
  id: string;
  name: string;
  tag: string;
  ownerId: string;
  members: string[];
  bank: number;
  createdAt: number;
}

export const clans = new Table<Clan>('adm:clans');

const CREATE_COST = 5000;

/** Pending invites: profile id -> clan id. */
const invites = new Map<string, string>();

export function clanOf(profileId: string): Clan | undefined {
  const profile = profiles.get(profileId);
  if (!profile?.clanId) return undefined;
  return clans.get(profile.clanId);
}

function broadcastToClan(clan: Clan, message: string): void {
  for (const memberId of clan.members) {
    const member = profiles.get(memberId);
    if (!member) continue;
    const online = onlinePlayer(member);
    if (online) online.sendMessage(`${C.accent}[${clan.tag}] ${C.reset}${message}`);
  }
}

export function install(): void {
  register({
    name: 'clan',
    description: 'Clans: create, invite, join, leave, info, bank, disband',
    category: 'Social',
    permission: 'clan.use',
    greedy: true,
    args: [
      { name: 'action', type: 'string' },
      { name: 'value', type: 'string', optional: true },
    ],
    handler: ({ player, args }) => {
      const action = (args[0] ?? '').toLowerCase();
      const value = args[1] ?? '';
      const profile = profileOf(player);
      const current = clanOf(profile.id);

      switch (action) {
        case 'create': {
          if (current) return err(player, 'You are already in a clan.');
          if (!value) return err(player, 'Give your clan a name.');
          const tag = value.slice(0, 4).toUpperCase();
          if (clans.values().some((c) => c.tag === tag)) return err(player, 'That clan tag is taken.');
          if (!charge(profile, CREATE_COST)) return err(player, `Creating a clan costs ${money(CREATE_COST)}.`);

          const id = uid();
          clans.set(id, {
            id,
            name: value,
            tag,
            ownerId: profile.id,
            members: [profile.id],
            bank: 0,
            createdAt: Date.now(),
          });
          profile.clanId = id;
          profiles.markDirty();
          return ok(player, `Clan "${value}" [${tag}] created.`);
        }

        case 'invite': {
          if (!current) return err(player, 'You are not in a clan.');
          if (current.ownerId !== profile.id) return err(player, 'Only the clan owner can invite.');
          const target = profileByName(value);
          if (!target) return err(player, 'Player not found.');
          if (target.clanId) return err(player, `${target.name} is already in a clan.`);

          invites.set(target.id, current.id);
          ok(player, `Invited ${target.name}.`);
          const online = onlinePlayer(target);
          if (online) tell(online, `${C.good}${player.name} invited you to ${current.name}. Use !clan join ${current.tag}.`);
          return;
        }

        case 'join': {
          if (current) return err(player, 'Leave your current clan first.');
          const invited = invites.get(profile.id);
          const clan = invited ? clans.get(invited) : undefined;
          if (!clan) return err(player, 'You have no pending clan invite.');
          if (value && clan.tag.toLowerCase() !== value.toLowerCase()) {
            return err(player, 'That is not the clan you were invited to.');
          }
          clan.members.push(profile.id);
          clans.markDirty();
          profile.clanId = clan.id;
          profiles.markDirty();
          invites.delete(profile.id);
          broadcastToClan(clan, `${player.name} joined the clan.`);
          return;
        }

        case 'leave': {
          if (!current) return err(player, 'You are not in a clan.');
          if (current.ownerId === profile.id) return err(player, 'The owner must disband the clan instead.');
          current.members = current.members.filter((id) => id !== profile.id);
          clans.markDirty();
          delete profile.clanId;
          profiles.markDirty();
          broadcastToClan(current, `${player.name} left the clan.`);
          return ok(player, 'You left the clan.');
        }

        case 'disband': {
          if (!current) return err(player, 'You are not in a clan.');
          if (current.ownerId !== profile.id) return err(player, 'Only the owner can disband.');
          // Split whatever is in the bank between the members before closing.
          const share = Math.floor(current.bank / Math.max(1, current.members.length));
          for (const memberId of current.members) {
            const member = profiles.get(memberId);
            if (!member) continue;
            delete member.clanId;
            if (share > 0) addMoney(member, share);
          }
          profiles.markDirty();
          clans.delete(current.id);
          return ok(player, 'Clan disbanded and the bank shared out.');
        }

        case 'bank': {
          if (!current) return err(player, 'You are not in a clan.');
          const parts = value.split(/\s+/);
          const sub = (parts[0] ?? '').toLowerCase();
          const amount = Number.parseInt(parts[1] ?? '', 10);

          if (sub === 'deposit') {
            if (!Number.isFinite(amount) || amount <= 0) return err(player, 'Give an amount.');
            if (!charge(profile, amount)) return err(player, `You only have ${money(balanceOf(profile))}.`);
            current.bank += amount;
            clans.markDirty();
            broadcastToClan(current, `${player.name} deposited ${money(amount)}.`);
            return;
          }
          if (sub === 'withdraw') {
            if (current.ownerId !== profile.id) return err(player, 'Only the owner can withdraw.');
            if (!Number.isFinite(amount) || amount <= 0 || amount > current.bank) {
              return err(player, `The bank holds ${money(current.bank)}.`);
            }
            current.bank -= amount;
            clans.markDirty();
            addMoney(profile, amount);
            broadcastToClan(current, `${player.name} withdrew ${money(amount)}.`);
            return;
          }
          return tell(player, `Clan bank: ${C.good}${money(current.bank)}${C.reset} - use !clan bank deposit <amount>`);
        }

        case 'chat': {
          if (!current) return err(player, 'You are not in a clan.');
          if (!value) return err(player, 'Say something.');
          broadcastToClan(current, `${player.name}: ${value}`);
          return;
        }

        case 'info': {
          const clan = value
            ? clans.values().find((c) => c.tag.toLowerCase() === value.toLowerCase())
            : current;
          if (!clan) return err(player, 'No such clan.');
          const names = clan.members.map((id) => profiles.get(id)?.name ?? 'unknown');
          tell(player, `${C.title}${clan.name} [${clan.tag}]`);
          player.sendMessage(`  Owner: ${C.accent}${profiles.get(clan.ownerId)?.name ?? 'unknown'}`);
          player.sendMessage(`  Members (${names.length}): ${names.join(', ')}`);
          player.sendMessage(`  Bank: ${C.good}${money(clan.bank)}`);
          return;
        }

        case 'list': {
          const all = clans.values();
          if (all.length === 0) return tell(player, `${C.dim}No clans yet.`);
          tell(player, `${C.title}Clans (${all.length})`);
          for (const clan of all) {
            player.sendMessage(`  ${C.accent}[${clan.tag}] ${C.white}${clan.name} ${C.dim}- ${clan.members.length} members`);
          }
          return;
        }

        default:
          err(player, 'Use: create, invite, join, leave, disband, bank, chat, info, list');
      }
    },
  });

  // Clean up membership if a clan disappears while a player is offline.
  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    const profile = profileOf(event.player);
    if (profile.clanId && !clans.has(profile.clanId)) {
      delete profile.clanId;
      profiles.markDirty();
    }
  });
}
