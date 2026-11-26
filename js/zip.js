/**
 * Minimal, standards-compliant PKZIP writer and reader for browser and Node.
 * - Writer uses STORE (method 0), ideal for JPEG photos and compact JSON.
 * - Reader supports STORE (method 0) and DEFLATE (method 8 via DecompressionStream),
 *   verifies IEEE 802.3 CRC-32, handles UTF-8 filenames, ignores macOS metadata,
 *   and rejects path traversal entries.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Compute IEEE 802.3 CRC-32 for a byte array.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

function sanitizeZipPath(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error(`Invalid ZIP entry name: ${name}`);
  }
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`Unsafe ZIP path traversal entry: ${name}`);
  }
  return normalized;
}

/**
 * Create a PKZIP archive buffer using STORE (method 0).
 * @param {Array<{ name: string, data: Uint8Array, date?: Date }>} entries
 * @returns {Uint8Array}
 */
export function createZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = sanitizeZipPath(entry.name);
    const nameBytes = textEncoder.encode(cleanName);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);
    const { dosTime, dosDate } = toDosDateTime(entry.date instanceof Date ? entry.date : new Date());

    // Local File Header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // compression method: 0 (STORE)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, data);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 filename flag
    cv.setUint16(10, 0, true); // compression method: 0 (STORE)
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralChunks.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  let centralSize = 0;
  for (const chunk of centralChunks) {
    centralSize += chunk.length;
  }

  // End of Central Directory (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // start disk
  ev.setUint16(8, entries.length, true); // entries on disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central dir offset
  ev.setUint16(20, 0, true); // comment length

  const totalLength = offset + centralSize + eocd.length;
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of localChunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  for (const chunk of centralChunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  result.set(eocd, pos);
  return result;
}

async function inflateRaw(compressedBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持解压 DEFLATE 格式的 ZIP 文件');
  }
  const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Parse a PKZIP archive into a Map of clean relative paths -> Uint8Array.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22) {
    throw new Error('无效的 ZIP 文件（文件过小）');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minScan = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === bytes.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset < 0) {
    throw new Error('无法识别的 ZIP 文件格式');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (centralOffset + centralSize > eocdOffset) {
    throw new Error('ZIP 文件目录已损坏');
  }

  const files = new Map();
  let cursor = centralOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('ZIP 中央目录结构异常');
    }

    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compSize = view.getUint32(cursor + 20, true);
    const uncompSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const centralExtraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const rawName = textDecoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + centralExtraLen + commentLen;

    // Skip directories and macOS resource fork metadata
    if (rawName.endsWith('/') || rawName.startsWith('__MACOSX/')) {
      continue;
    }

    const cleanName = sanitizeZipPath(rawName);

    // Read Local File Header independently (do NOT reuse centralExtraLen)
    if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`ZIP 文件项头损坏: ${cleanName}`);
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;

    if (dataEnd > bytes.length) {
      throw new Error(`ZIP 文件内容截断: ${cleanName}`);
    }

    const payload = bytes.subarray(dataStart, dataEnd);
    let outBytes;
    if (method === 0) {
      outBytes = payload.slice();
    } else if (method === 8) {
      outBytes = await inflateRaw(payload);
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 (${method}): ${cleanName}`);
    }

    if (outBytes.length !== uncompSize) {
      throw new Error(`ZIP 文件大小校验失败: ${cleanName}`);
    }

    const actualCrc = crc32(outBytes);
    if (actualCrc !== expectedCrc) {
      throw new Error(`ZIP 文件 CRC 校验失败: ${cleanName}`);
    }

    files.set(cleanName, outBytes);
  }

  return files;
}
