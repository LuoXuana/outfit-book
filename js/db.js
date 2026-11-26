import { generateThumbnailFromBlob } from './image.js';
import {
  buildBackupPayload,
  countByCategory,
  formatDateKey,
  getAllOutfitPhotoIds,
  normalizeOutfit,
  validateBackupPayload,
} from './store.js';
import { createZip, readZip } from './zip.js';

const DB_NAME = 'outfit_book_db';
const DB_VERSION = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

let dbPromise = null;
let persistRequested = false;

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 操作失败'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务已中止'));
  });
}

async function requestPersistentStorageOnce() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // Best-effort only
  }
}

/**
 * Open and initialize IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outfits')) {
        const outfitStore = db.createObjectStore('outfits', { keyPath: 'id' });
        outfitStore.createIndex('by_category', 'category', { unique: false });
        outfitStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('无法打开本地数据库'));
    };
  });

  return dbPromise;
}

export async function getAllOutfits() {
  const db = await initDB();
  const tx = db.transaction('outfits', 'readonly');
  const rawList = await requestToPromise(tx.objectStore('outfits').getAll());
  return rawList.map(normalizeOutfit).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Save or update an outfit along with newly added photo blobs and deleted photo IDs.
 * @param {object} outfitRaw
 * @param {Map<string, object>} newPhotosMap photoId -> { blob, thumbBlob, width, height, size, mimeType }
 * @param {string[]} removedPhotoIds
 */
export async function saveOutfit(outfitRaw, newPhotosMap = new Map(), removedPhotoIds = []) {
  await requestPersistentStorageOnce();
  const db = await initDB();
  const outfit = normalizeOutfit(outfitRaw);

  const tx = db.transaction(['outfits', 'photos'], 'readwrite');
  const outfitStore = tx.objectStore('outfits');
  const photoStore = tx.objectStore('photos');

  for (const [photoId, photoData] of newPhotosMap.entries()) {
    photoStore.put({
      id: photoId,
      blob: photoData.blob,
      thumbBlob: photoData.thumbBlob,
      width: photoData.width || 0,
      height: photoData.height || 0,
      size: photoData.size || photoData.blob?.size || 0,
      mimeType: photoData.mimeType || 'image/jpeg',
      createdAt: Date.now(),
    });
  }

  for (const oldId of removedPhotoIds) {
    if (oldId && !newPhotosMap.has(oldId)) {
      photoStore.delete(oldId);
    }
  }

  outfitStore.put(outfit);
  await transactionDone(tx);
  return outfit;
}

export async function deleteOutfit(id) {
  const db = await initDB();
  const readTx = db.transaction('outfits', 'readonly');
  const existing = await requestToPromise(readTx.objectStore('outfits').get(id));
  const deletedPhotoIds = existing ? getAllOutfitPhotoIds(existing) : [];

  const tx = db.transaction(['outfits', 'photos'], 'readwrite');
  tx.objectStore('outfits').delete(id);
  const photoStore = tx.objectStore('photos');
  for (const photoId of deletedPhotoIds) {
    photoStore.delete(photoId);
  }
  await transactionDone(tx);
  return deletedPhotoIds;
}

export async function toggleFavorite(id) {
  const db = await initDB();
  const tx = db.transaction('outfits', 'readwrite');
  const store = tx.objectStore('outfits');
  const existing = await requestToPromise(store.get(id));
  if (!existing) return null;

  const updated = normalizeOutfit({
    ...existing,
    favorite: !existing.favorite,
    updatedAt: Date.now(),
  });
  store.put(updated);
  await transactionDone(tx);
  return updated;
}

export async function toggleWearDate(id, dateKey = formatDateKey()) {
  const db = await initDB();
  const tx = db.transaction('outfits', 'readwrite');
  const store = tx.objectStore('outfits');
  const existing = await requestToPromise(store.get(id));
  if (!existing) return null;

  const dates = new Set(existing.wearDates || []);
  if (dates.has(dateKey)) {
    dates.delete(dateKey);
  } else {
    dates.add(dateKey);
  }

  const updated = normalizeOutfit({
    ...existing,
    wearDates: [...dates],
    updatedAt: Date.now(),
  });
  store.put(updated);
  await transactionDone(tx);
  return updated;
}

export async function getPhoto(id) {
  const db = await initDB();
  const tx = db.transaction('photos', 'readonly');
  return requestToPromise(tx.objectStore('photos').get(id));
}

export async function getMeta(key) {
  const db = await initDB();
  const tx = db.transaction('meta', 'readonly');
  const record = await requestToPromise(tx.objectStore('meta').get(key));
  return record ? record.value : null;
}

export async function setMeta(key, value) {
  const db = await initDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await transactionDone(tx);
}

export async function getStorageStats() {
  const db = await initDB();
  const tx = db.transaction(['outfits', 'photos', 'meta'], 'readonly');
  const [outfitsRaw, photosRaw, lastBackupRecord] = await Promise.all([
    requestToPromise(tx.objectStore('outfits').getAll()),
    requestToPromise(tx.objectStore('photos').getAll()),
    requestToPromise(tx.objectStore('meta').get('lastBackupAt')),
  ]);

  const outfits = outfitsRaw.map(normalizeOutfit);
  const categoryCounts = countByCategory(outfits);
  let totalBytes = 0;
  for (const p of photosRaw) {
    totalBytes += (p.blob?.size || p.size || 0) + (p.thumbBlob?.size || 0);
  }

  return {
    outfitCount: outfits.length,
    categoryCounts,
    photoCount: photosRaw.length,
    totalBytes,
    lastBackupAt: lastBackupRecord?.value || null,
  };
}

/**
 * Export all outfits and JPEG photos as a standard .zip Blob (`data.json` + `images/<id>.jpg`).
 */
export async function exportBackupZip(onProgress = () => {}) {
  const db = await initDB();
  onProgress({ percent: 10, message: '正在读取穿搭记录…' });

  const outfits = await getAllOutfits();
  const payload = buildBackupPayload(outfits);
  const jsonBytes = textEncoder.encode(JSON.stringify(payload, null, 2));

  const entries = [{ name: 'data.json', data: jsonBytes }];

  const tx = db.transaction('photos', 'readonly');
  const allPhotos = await requestToPromise(tx.objectStore('photos').getAll());
  const photoMap = new Map(allPhotos.map((p) => [p.id, p]));

  const exportedPhotoIds = new Set();
  const outfitPhotoIdLists = outfits.map((o) => getAllOutfitPhotoIds(o));
  const totalPhotos = outfitPhotoIdLists.reduce((sum, list) => sum + list.length, 0);
  let processed = 0;

  for (const photoIds of outfitPhotoIdLists) {
    for (const pid of photoIds) {
      if (exportedPhotoIds.has(pid)) continue;
      exportedPhotoIds.add(pid);

      const photoRec = photoMap.get(pid);
      if (photoRec?.blob) {
        const ab = await photoRec.blob.arrayBuffer();
        entries.push({
          name: `images/${pid}.jpg`,
          data: new Uint8Array(ab),
        });
      }
      processed += 1;
      const pct = totalPhotos > 0 ? 15 + Math.round((processed / totalPhotos) * 70) : 85;
      onProgress({ percent: pct, message: `正在打包照片 (${processed}/${Math.max(processed, totalPhotos)})…` });
    }
  }

  onProgress({ percent: 90, message: '正在生成 ZIP 压缩包…' });
  const zipBytes = createZip(entries);
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const now = Date.now();
  await setMeta('lastBackupAt', now);

  onProgress({ percent: 100, message: '备份文件已就绪' });
  const dateTag = formatDateKey(now).replace(/-/g, '');
  return {
    filename: `穿搭本备份-${dateTag}.zip`,
    blob,
    outfitCount: outfits.length,
    photoCount: exportedPhotoIds.size,
  };
}

/**
 * Import a .zip backup into IndexedDB.
 * @param {File | Blob} file
 * @param {'merge' | 'replace'} mode
 */
export async function importBackupZip(file, mode = 'merge', onProgress = () => {}) {
  await requestPersistentStorageOnce();
  onProgress({ percent: 10, message: '正在解析 ZIP 压缩包…' });

  const buffer = await file.arrayBuffer();
  const zipEntries = await readZip(buffer);

  // Locate data.json (either at root or one level deep)
  let dataBytes = zipEntries.get('data.json');
  let rootPrefix = '';
  if (!dataBytes) {
    for (const [entryName, bytes] of zipEntries.entries()) {
      if (entryName.endsWith('/data.json')) {
        dataBytes = bytes;
        rootPrefix = entryName.slice(0, -'data.json'.length);
        break;
      }
    }
  }

  if (!dataBytes) {
    throw new Error('压缩包内缺少 data.json，无法恢复穿搭记录');
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(textDecoder.decode(dataBytes));
  } catch {
    throw new Error('data.json 文件损坏，无法解析 JSON');
  }

  const { outfits, photoPathMap } = validateBackupPayload(parsedJson);
  const db = await initDB();

  let existingIds = new Set();
  if (mode === 'merge') {
    const existing = await getAllOutfits();
    existingIds = new Set(existing.map((o) => o.id));
  }

  const outfitsToImport = mode === 'replace'
    ? outfits
    : outfits.filter((o) => !existingIds.has(o.id));
  const skippedCount = outfits.length - outfitsToImport.length;

  // Collect photo records needed for imported outfits (main + per-item photos)
  const neededPhotoIds = new Set();
  for (const o of outfitsToImport) {
    for (const pid of getAllOutfitPhotoIds(o)) neededPhotoIds.add(pid);
  }

  const preparedPhotos = [];
  let missingPhotoCount = 0;
  let processed = 0;
  const totalNeeded = neededPhotoIds.size;

  for (const pid of neededPhotoIds) {
    const relPath = photoPathMap.get(pid) || `images/${pid}.jpg`;
    const photoBytes = zipEntries.get(relPath) || zipEntries.get(`${rootPrefix}${relPath}`);
    processed += 1;
    const pct = totalNeeded > 0 ? 20 + Math.round((processed / totalNeeded) * 65) : 85;
    onProgress({ percent: pct, message: `正在处理照片 (${processed}/${totalNeeded})…` });

    if (!photoBytes) {
      missingPhotoCount += 1;
      continue;
    }

    const blob = new Blob([photoBytes], { type: 'image/jpeg' });
    let thumbBlob = blob;
    let width = 0;
    let height = 0;
    try {
      const thumbResult = await generateThumbnailFromBlob(blob);
      thumbBlob = thumbResult.thumbBlob;
      width = thumbResult.width;
      height = thumbResult.height;
    } catch {
      // If thumbnail generation fails on an unusual image, keep main blob as fallback
    }

    preparedPhotos.push({
      id: pid,
      blob,
      thumbBlob,
      width,
      height,
      size: blob.size,
      mimeType: 'image/jpeg',
      createdAt: Date.now(),
    });
  }

  onProgress({ percent: 90, message: '正在写入本地数据库…' });
  const tx = db.transaction(['outfits', 'photos'], 'readwrite');
  const outfitStore = tx.objectStore('outfits');
  const photoStore = tx.objectStore('photos');

  if (mode === 'replace') {
    outfitStore.clear();
    photoStore.clear();
  }

  for (const p of preparedPhotos) {
    photoStore.put(p);
  }
  for (const o of outfitsToImport) {
    outfitStore.put(o);
  }

  await transactionDone(tx);
  onProgress({ percent: 100, message: '导入完成' });

  return {
    importedCount: outfitsToImport.length,
    skippedCount,
    photoCount: preparedPhotos.length,
    missingPhotoCount,
  };
}
