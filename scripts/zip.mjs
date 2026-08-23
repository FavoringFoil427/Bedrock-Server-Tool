/**
 * Minimal ZIP writer.
 *
 * A `.mcaddon` is just a zip, and shelling out to the `zip` binary makes the
 * build depend on a tool that Windows machines and some CI images lack. This
 * writes the archive directly with Node's zlib instead: no dependencies, same
 * output everywhere.
 */
import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';

/** Node exposes crc32 from 20.15 onward; this keeps older runtimes working. */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Converts a Date into the DOS time/date pair the format requires. */
function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Builds a zip archive.
 *
 * @param {{ name: string, data: Buffer }[]} entries Paths use forward slashes.
 * @param {Date} [modified] Timestamp recorded for every entry.
 * @returns {Buffer}
 */
export function createZip(entries, modified = new Date()) {
  const { time, day } = dosStamp(modified);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const uncompressed = entry.data;
    const compressed = deflateRawSync(uncompressed, { level: 9 });
    // Storing is smaller than deflating for already-compressed data (PNGs).
    const useStore = compressed.length >= uncompressed.length;
    const payload = useStore ? uncompressed : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(uncompressed);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length

    chunks.push(local, nameBytes, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);         // version made by
    header.writeUInt16LE(20, 6);         // version needed
    header.writeUInt16LE(0, 8);          // flags
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(uncompressed.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);         // extra
    header.writeUInt16LE(0, 32);         // comment
    header.writeUInt16LE(0, 34);         // disk number
    header.writeUInt16LE(0, 36);         // internal attributes
    header.writeUInt32LE(0, 38);         // external attributes
    header.writeUInt32LE(offset, 42);    // local header offset
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                    // this disk
  end.writeUInt16LE(0, 6);                    // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                   // comment length

  return Buffer.concat([...chunks, centralBuffer, end]);
}
