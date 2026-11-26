import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { crc32, createZip, readZip } from '../js/zip.js';
import {
  buildBackupPayload,
  buildCalendarMonth,
  countByCategory,
  defaultOutfitTitle,
  filterOutfits,
  formatDateKey,
  getAllOutfitPhotoIds,
  normalizeOutfit,
  validateBackupPayload,
} from '../js/store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('zip.js: STORE round-trip with UTF-8 Chinese filename, JSON, and binary payload', async () => {
  const jsonBytes = encoder.encode(JSON.stringify({ app: '穿搭本', count: 2 }));
  const binBytes = new Uint8Array(1024);
  for (let i = 0; i < binBytes.length; i++) binBytes[i] = (i * 31) & 0xff;

  const archive = createZip([
    { name: 'data.json', data: jsonBytes },
    { name: 'images/春季穿搭_01.jpg', data: binBytes },
  ]);

  const parsed = await readZip(archive);
  assert.equal(parsed.size, 2);
  assert.deepEqual(parsed.get('data.json'), jsonBytes);
  assert.deepEqual(parsed.get('images/春季穿搭_01.jpg'), binBytes);
});

test('zip.js: detects CRC-32 corruption', async () => {
  const archive = createZip([
    { name: 'data.json', data: encoder.encode('{"hello":"world"}') },
  ]);
  // Flip one byte inside the local file payload (after 30-byte header + 9-byte name = offset 39)
  archive[40] ^= 0xff;
  await assert.rejects(() => readZip(archive), /CRC/);
});

test('zip.js: supports DEFLATE (method 8) entries and ignores __MACOSX/', async () => {
  // Craft a minimal ZIP containing one DEFLATE entry and one __MACOSX entry
  const payloadText = 'Hello 穿搭本! '.repeat(20);
  const raw = Buffer.from(payloadText, 'utf8');
  const compressed = deflateRawSync(raw);
  const expectedCrc = crc32(new Uint8Array(raw));

  const name1 = Buffer.from('__MACOSX/._data.json', 'utf8');
  const name2 = Buffer.from('data.json', 'utf8');

  // Helper to build local + central entries
  function makeEntry(nameBuf, compBuf, uncompLen, method, crcVal, offset) {
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crcVal, 14);
    lh.writeUInt32LE(compBuf.length, 18);
    lh.writeUInt32LE(uncompLen, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    // Test differing local vs central extra lengths (4 bytes in local, 0 in central)
    lh.writeUInt16LE(4, 28);
    const localExtra = Buffer.from([1, 2, 3, 4]);
    nameBuf.copy(lh, 30);

    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crcVal, 16);
    ch.writeUInt32LE(compBuf.length, 20);
    ch.writeUInt32LE(uncompLen, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt32LE(offset, 42);
    nameBuf.copy(ch, 46);

    return { local: Buffer.concat([lh, localExtra, compBuf]), central: ch };
  }

  const macBytes = Buffer.from([1, 2, 3]);
  const e1 = makeEntry(name1, macBytes, macBytes.length, 0, crc32(new Uint8Array(macBytes)), 0);
  const e2 = makeEntry(name2, compressed, raw.length, 8, expectedCrc, e1.local.length);

  const cdOffset = e1.local.length + e2.local.length;
  const cdSize = e1.central.length + e2.central.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  const fullZip = Buffer.concat([e1.local, e2.local, e1.central, e2.central, eocd]);
  const parsed = await readZip(new Uint8Array(fullZip));
  assert.equal(parsed.size, 1);
  assert.equal(decoder.decode(parsed.get('data.json')), payloadText);
});

test('zip.js: rejects path traversal entries', async () => {
  const archive = createZip([{ name: 'safe.txt', data: encoder.encode('ok') }]);
  // Inject ../evil.txt directly into a crafted archive
  const badName = encoder.encode('../evil.txt');
  const data = encoder.encode('x');
  const lh = new Uint8Array(30 + badName.length);
  const lv = new DataView(lh.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint32(14, crc32(data), true);
  lv.setUint32(18, 1, true);
  lv.setUint32(22, 1, true);
  lv.setUint16(26, badName.length, true);
  lh.set(badName, 30);

  const ch = new Uint8Array(46 + badName.length);
  const cv = new DataView(ch.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint32(16, crc32(data), true);
  cv.setUint32(20, 1, true);
  cv.setUint32(24, 1, true);
  cv.setUint16(28, badName.length, true);
  ch.set(badName, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, ch.length, true);
  ev.setUint32(16, lh.length + data.length, true);

  const badZip = new Uint8Array(lh.length + data.length + ch.length + eocd.length);
  badZip.set(lh, 0);
  badZip.set(data, lh.length);
  badZip.set(ch, lh.length + data.length);
  badZip.set(eocd, lh.length + data.length + ch.length);

  assert.ok(archive.length > 0);
  await assert.rejects(() => readZip(badZip), /traversal/);
});

test('zip.js: compatible with Windows PowerShell Expand-Archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outfit-zip-test-'));
  try {
    const zipPath = join(dir, 'backup.zip');
    const outDir = join(dir, 'extracted');
    const jsonBytes = encoder.encode('{"app":"穿搭本","ok":true}');
    const imgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

    const archive = createZip([
      { name: 'data.json', data: jsonBytes },
      { name: 'images/p1.jpg', data: imgBytes },
    ]);
    writeFileSync(zipPath, archive);

    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ]);

    assert.equal(readFileSync(join(outDir, 'data.json'), 'utf8'), '{"app":"穿搭本","ok":true}');
    assert.deepEqual(new Uint8Array(readFileSync(join(outDir, 'images', 'p1.jpg'))), imgBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store.js: normalization, default title, filtering, and category counting', () => {
  const o1 = normalizeOutfit({
    id: 'o1',
    category: 'woman',
    title: '卡其风衣通勤装',
    seasons: ['秋', '春'],
    tags: ['通勤', '温柔'],
    items: { top: '白针织衫', outer: '卡其风衣' },
    photoIds: ['p1'],
    favorite: true,
    wearDates: ['2026-11-20'],
    createdAt: 1000,
  });

  const o2 = normalizeOutfit({
    id: 'o2',
    category: 'boy',
    title: '',
    seasons: ['冬'],
    tags: ['上学', '保暖'],
    note: '加绒卫衣配牛仔裤',
    photoIds: ['p2'],
    favorite: false,
    wearDates: ['2026-11-26'],
    createdAt: 2000,
  });

  assert.ok(o2.title.includes('男孩'));
  assert.equal(defaultOutfitTitle('girl', ['夏'], '2026-07-05'), '7月5日 女孩夏季穿搭');

  const all = [o1, o2];
  assert.deepEqual(countByCategory(all), { all: 2, woman: 1, girl: 0, boy: 1 });

  // Newest first when unfiltered
  assert.deepEqual(filterOutfits(all).map((o) => o.id), ['o2', 'o1']);
  // Filter by favorite
  assert.deepEqual(filterOutfits(all, { favoriteOnly: true }).map((o) => o.id), ['o1']);
  // Search matches items.outer
  assert.deepEqual(filterOutfits(all, { query: '卡其风衣' }).map((o) => o.id), ['o1']);
  // Search matches note
  assert.deepEqual(filterOutfits(all, { query: '卫衣' }).map((o) => o.id), ['o2']);
  // Filter by season & category
  assert.deepEqual(filterOutfits(all, { category: 'boy', season: '冬' }).map((o) => o.id), ['o2']);
});

test('store.js: calendar month mapping and backup payload validation', () => {
  const o1 = normalizeOutfit({
    id: 'o1',
    category: 'girl',
    title: '格子裙',
    seasons: ['秋'],
    photoIds: ['p1', 'p2'],
    wearDates: ['2026-11-05', '2026-11-20'],
    createdAt: 1000,
  });

  const cal = buildCalendarMonth(2026, 10, [o1], 'all'); // month 10 = Nov
  assert.equal(cal.byDate.get('2026-11-05')?.length, 1);
  const nov5Cell = cal.cells.find((c) => c && c.dateKey === '2026-11-05');
  assert.deepEqual(nov5Cell.categoriesPresent, ['girl']);
  assert.equal(formatDateKey(new Date(2026, 10, 5)), '2026-11-05');

  const payload = buildBackupPayload([o1], '2026-11-26T10:00:00Z');
  assert.deepEqual(payload.outfits[0].photos, ['images/p1.jpg', 'images/p2.jpg']);

  const validated = validateBackupPayload(payload);
  assert.equal(validated.outfits.length, 1);
  assert.deepEqual(validated.outfits[0].photoIds, ['p1', 'p2']);
  assert.equal(validated.photoPathMap.get('p1'), 'images/p1.jpg');

  // Tolerates missing optional fields
  const minimal = validateBackupPayload({
    outfits: [{ id: 'legacy1', category: 'woman', photos: ['images/a.jpg'] }],
  });
  assert.equal(minimal.outfits[0].tags.length, 0);
  assert.deepEqual(minimal.outfits[0].photoIds, ['a']);

  // Rejects invalid structure or future schemaVersion
  assert.throws(() => validateBackupPayload({}), /outfits/);
  assert.throws(() => validateBackupPayload({ schemaVersion: 99, outfits: [] }), /更新应用/);
});

test('store.js: itemPhotos normalization, getAllOutfitPhotoIds deduplication, and backup round-trip', () => {
  const o = normalizeOutfit({
    id: 'o_items',
    category: 'woman',
    title: '单品带图测试',
    photoIds: ['p_main', 'p_top'],
    items: { top: '白衬衫', outer: '西装外套' },
    itemPhotos: { top: 'p_top', outer: 'p_outer' },
  });

  assert.equal(o.itemPhotos.top, 'p_top');
  assert.equal(o.itemPhotos.outer, 'p_outer');
  assert.equal(o.itemPhotos.bottom, '');
  assert.deepEqual(getAllOutfitPhotoIds(o), ['p_main', 'p_top', 'p_outer']);

  const payload = buildBackupPayload([o], '2026-11-26T11:00:00Z');
  assert.equal(payload.outfits[0].itemPhotos.top, 'images/p_top.jpg');
  assert.equal(payload.outfits[0].itemPhotos.outer, 'images/p_outer.jpg');
  assert.equal(payload.outfits[0].itemPhotos.bottom, '');

  const validated = validateBackupPayload(payload);
  assert.equal(validated.outfits[0].itemPhotos.top, 'p_top');
  assert.equal(validated.outfits[0].itemPhotos.outer, 'p_outer');
  assert.equal(validated.photoPathMap.get('p_outer'), 'images/p_outer.jpg');

  // Backward compatibility when itemPhotos is absent
  const legacy = validateBackupPayload({
    outfits: [{ id: 'old1', category: 'boy', photos: ['images/p1.jpg'] }],
  });
  assert.deepEqual(legacy.outfits[0].itemPhotos, {
    top: '',
    bottom: '',
    outer: '',
    accessories: '',
  });
});
