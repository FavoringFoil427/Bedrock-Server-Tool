import { cfg } from './config';

/**
 * Lightweight message catalogue. English is the complete reference set; other
 * locales override the keys they translate and fall back to English for the
 * rest, so a partial translation is always safe to ship.
 */

type Catalog = Record<string, string>;

const en: Catalog = {
  'err.noPermission': 'You do not have permission to do that.',
  'err.playerNotFound': 'Player not found.',
  'err.unknownCommand': 'Unknown command. Use {prefix}info for a command list.',
  'err.usage': 'Usage: {usage}',
  'err.number': 'That value must be a number.',
  'err.selfTarget': 'You cannot target yourself.',
  'err.cooldown': 'Please wait {time} before doing that again.',
  'err.notRegistered': 'You must register before playing. Use {prefix}register <password>.',

  'ok.saved': 'Saved.',
  'ok.deleted': 'Deleted.',

  'economy.balance': 'Balance: {symbol}{amount}',
  'economy.insufficient': 'You need {symbol}{amount} to do that.',
  'economy.paid': 'You paid {symbol}{amount} to {player}.',
  'economy.received': 'You received {symbol}{amount} from {player}.',

  'tpa.sent': 'Teleport request sent to {player}.',
  'tpa.received': '{player} wants to teleport to you. Use {prefix}tpaccept or {prefix}tpdeny.',
  'tpa.accepted': 'Teleport request accepted.',
  'tpa.denied': 'Teleport request denied.',
  'tpa.expired': 'That teleport request expired.',
  'tpa.none': 'You have no pending teleport requests.',
  'tpa.warmup': 'Teleporting in {seconds}s - do not move.',
  'tpa.cancelled': 'Teleport cancelled because you moved.',

  'home.set': 'Home "{name}" set.',
  'home.deleted': 'Home "{name}" deleted.',
  'home.missing': 'You have no home called "{name}".',
  'home.limit': 'You have reached your home limit ({limit}).',

  'land.claimed': 'Land claimed ({size} blocks).',
  'land.protected': 'This land belongs to {owner}.',
  'land.overlap': 'That area overlaps an existing claim.',
  'land.notOwner': 'You do not own this land.',

  'mod.banned': 'You are banned. Reason: {reason}',
  'mod.bannedUntil': 'You are banned until {until}. Reason: {reason}',
  'mod.muted': 'You are muted and cannot chat.',
  'mod.frozen': 'You are frozen and cannot move.',
  'mod.kicked': 'You were kicked: {reason}',
};

const id: Catalog = {
  'err.noPermission': 'Kamu tidak punya izin untuk melakukan itu.',
  'err.playerNotFound': 'Pemain tidak ditemukan.',
  'err.unknownCommand': 'Perintah tidak dikenal. Gunakan {prefix}info untuk daftar perintah.',
  'err.usage': 'Penggunaan: {usage}',
  'err.cooldown': 'Tunggu {time} sebelum melakukannya lagi.',
  'ok.saved': 'Tersimpan.',
  'ok.deleted': 'Dihapus.',
  'economy.balance': 'Saldo: {symbol}{amount}',
  'economy.insufficient': 'Kamu butuh {symbol}{amount} untuk melakukan itu.',
  'economy.paid': 'Kamu membayar {symbol}{amount} kepada {player}.',
  'tpa.sent': 'Permintaan teleport dikirim ke {player}.',
  'mod.muted': 'Kamu dibisukan dan tidak bisa mengobrol.',
  'mod.frozen': 'Kamu dibekukan dan tidak bisa bergerak.',
};

const es: Catalog = {
  'err.noPermission': 'No tienes permiso para hacer eso.',
  'err.playerNotFound': 'Jugador no encontrado.',
  'err.unknownCommand': 'Comando desconocido. Usa {prefix}info para ver la lista.',
  'err.usage': 'Uso: {usage}',
  'err.cooldown': 'Espera {time} antes de volver a hacer eso.',
  'ok.saved': 'Guardado.',
  'ok.deleted': 'Eliminado.',
  'economy.balance': 'Saldo: {symbol}{amount}',
  'economy.insufficient': 'Necesitas {symbol}{amount} para hacer eso.',
  'economy.paid': 'Pagaste {symbol}{amount} a {player}.',
  'tpa.sent': 'Solicitud de teletransporte enviada a {player}.',
  'mod.muted': 'Estás silenciado y no puedes chatear.',
  'mod.frozen': 'Estás congelado y no puedes moverte.',
};

const catalogs: Record<string, Catalog> = { en, id, es };

/** Registers or extends a locale at runtime. */
export function registerLocale(code: string, catalog: Catalog): void {
  catalogs[code] = { ...(catalogs[code] ?? {}), ...catalog };
}

export function availableLocales(): string[] {
  return Object.keys(catalogs);
}

/** Translates `key`, interpolating `{placeholders}` from `params`. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const locale = catalogs[cfg().language] ?? en;
  const template = locale[key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
