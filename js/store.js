/**
 * Pure domain constants, normalization, filtering, calendar helpers, and backup schema logic.
 * Free of DOM / IndexedDB dependencies so it can be unit tested directly in Node.
 */

export const SCHEMA_VERSION = 1;

export const CATEGORIES = [
  { id: 'woman', label: '女士', badgeClass: 'badge-woman' },
  { id: 'girl', label: '女孩', badgeClass: 'badge-girl' },
  { id: 'boy', label: '男孩', badgeClass: 'badge-boy' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

export const SEASONS = ['春', '夏', '秋', '冬'];

export const PRESET_TAGS = ['日常', '通勤', '上学', '出游', '聚会', '运动', '温柔', '保暖', '雨天'];

export const MAX_PHOTOS_PER_OUTFIT = 9;

export const ITEM_SLOTS = [
  { key: 'top', label: '上装', placeholder: '如：米白色高领打底' },
  { key: 'bottom', label: '下装 / 连衣裙', placeholder: '如：直筒牛仔裤' },
  { key: 'outer', label: '外套', placeholder: '如：卡其色风衣' },
  { key: 'accessories', label: '鞋帽 / 配饰', placeholder: '如：小白鞋、帆布包' },
];

/**
 * Collect all unique non-empty photo IDs referenced by an outfit (main photos + per-item photos).
 */
export function getAllOutfitPhotoIds(outfit) {
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    const clean = String(id || '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      ids.push(clean);
    }
  };
  for (const pid of outfit?.photoIds || []) push(pid);
  for (const slot of ITEM_SLOTS) push(outfit?.itemPhotos?.[slot.key]);
  return ids;
}

/**
 * Generate a collision-resistant short ID with prefix.
 * @param {string} prefix
 */
export function generateId(prefix = 'id') {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}_${rand}`;
}

/**
 * Format a Date (or timestamp) as local YYYY-MM-DD.
 * @param {Date | number} input
 */
export function formatDateKey(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format timestamp into friendly Chinese date/time label.
 * @param {number} ts
 */
export function formatDateTime(ts) {
  if (!ts) return '尚未备份';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '尚未备份';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/**
 * Build a friendly fallback title when the user leaves the title input blank.
 */
export function defaultOutfitTitle(category, seasons = [], dateKey = formatDateKey()) {
  const catLabel = CATEGORY_MAP[category]?.label || '女士';
  const seasonLabel = Array.isArray(seasons) && seasons.length > 0 ? `${seasons[0]}季` : '';
  const shortDate = dateKey && dateKey.length >= 10 ? `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日` : '';
  return `${shortDate ? `${shortDate} ` : ''}${catLabel}${seasonLabel}穿搭`.trim();
}

/**
 * Normalize an outfit record, filling safe defaults for optional fields.
 */
export function normalizeOutfit(raw) {
  const category = CATEGORY_MAP[raw?.category] ? raw.category : 'woman';
  const seasons = Array.isArray(raw?.seasons)
    ? [...new Set(raw.seasons.filter((s) => SEASONS.includes(s)))]
    : [];
  const tags = Array.isArray(raw?.tags)
    ? [...new Set(raw.tags.map((t) => String(t).trim()).filter(Boolean))]
    : [];
  const photoIds = Array.isArray(raw?.photoIds)
    ? raw.photoIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const wearDates = Array.isArray(raw?.wearDates)
    ? [...new Set(raw.wearDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))].sort().reverse()
    : [];
  const items = raw?.items && typeof raw.items === 'object' ? raw.items : {};
  const itemPhotos = raw?.itemPhotos && typeof raw.itemPhotos === 'object' ? raw.itemPhotos : {};
  const createdAt = Number(raw?.createdAt) || Date.now();
  const updatedAt = Number(raw?.updatedAt) || createdAt;
  const titleStr = String(raw?.title || '').trim();

  return {
    id: String(raw?.id || generateId('outfit')),
    category,
    title: titleStr || defaultOutfitTitle(category, seasons, wearDates[0] || formatDateKey(createdAt)),
    seasons,
    tags,
    items: {
      top: String(items.top || '').trim(),
      bottom: String(items.bottom || '').trim(),
      outer: String(items.outer || '').trim(),
      accessories: String(items.accessories || '').trim(),
    },
    itemPhotos: {
      top: String(itemPhotos.top || '').trim(),
      bottom: String(itemPhotos.bottom || '').trim(),
      outer: String(itemPhotos.outer || '').trim(),
      accessories: String(itemPhotos.accessories || '').trim(),
    },
    note: String(raw?.note || '').trim(),
    photoIds,
    favorite: Boolean(raw?.favorite),
    wearDates,
    createdAt,
    updatedAt,
  };
}

/**
 * Filter and sort outfits (newest first).
 */
export function filterOutfits(outfits, filters = {}) {
  const {
    category = 'all',
    season = 'all',
    tag = '',
    favoriteOnly = false,
    query = '',
  } = filters;

  const q = String(query || '').trim().toLowerCase();

  return outfits
    .filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (season !== 'all' && !(item.seasons || []).includes(season)) return false;
      if (tag && !(item.tags || []).includes(tag)) return false;
      if (favoriteOnly && !item.favorite) return false;

      if (q) {
        const haystack = [
          item.title,
          item.note,
          ...(item.tags || []),
          ...(item.seasons || []),
          CATEGORY_MAP[item.category]?.label || '',
          item.items?.top,
          item.items?.bottom,
          item.items?.outer,
          item.items?.accessories,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Count outfits across categories.
 */
export function countByCategory(outfits) {
  const counts = { all: outfits.length, woman: 0, girl: 0, boy: 0 };
  for (const item of outfits) {
    if (counts[item.category] !== undefined) {
      counts[item.category] += 1;
    }
  }
  return counts;
}

/**
 * Build a calendar month view (Monday-first grid) with outfits mapped per dateKey.
 * @param {number} year Full year e.g. 2026
 * @param {number} monthZeroBased 0..11
 * @param {Array} outfits
 * @param {string} category 'all' | 'woman' | 'girl' | 'boy'
 */
export function buildCalendarMonth(year, monthZeroBased, outfits, category = 'all') {
  const monthPrefix = `${year}-${String(monthZeroBased + 1).padStart(2, '0')}-`;
  const byDate = new Map();

  for (const outfit of outfits) {
    if (category !== 'all' && outfit.category !== category) continue;
    for (const dateKey of outfit.wearDates || []) {
      if (!dateKey.startsWith(monthPrefix)) continue;
      if (!byDate.has(dateKey)) byDate.set(dateKey, []);
      byDate.get(dateKey).push(outfit);
    }
  }

  const firstDay = new Date(year, monthZeroBased, 1);
  const daysInMonth = new Date(year, monthZeroBased + 1, 0).getDate();
  // Monday-first offset: Sun(0) -> 6, Mon(1) -> 0, ...
  const leadingEmpty = (firstDay.getDay() + 6) % 7;

  const cells = [];
  for (let i = 0; i < leadingEmpty; i++) {
    cells.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${monthPrefix}${String(day).padStart(2, '0')}`;
    const dayOutfits = byDate.get(dateKey) || [];
    const categoriesPresent = [...new Set(dayOutfits.map((o) => o.category))];
    cells.push({
      day,
      dateKey,
      outfits: dayOutfits,
      categoriesPresent,
    });
  }

  return {
    year,
    month: monthZeroBased,
    cells,
    byDate,
  };
}

/**
 * Build serializable backup data.json payload from outfits.
 */
export function buildBackupPayload(outfits, exportedAt = new Date().toISOString()) {
  const cleanOutfits = outfits.map((raw) => {
    const o = normalizeOutfit(raw);
    const itemPhotos = {};
    for (const slot of ITEM_SLOTS) {
      const pid = o.itemPhotos?.[slot.key];
      itemPhotos[slot.key] = pid ? `images/${pid}.jpg` : '';
    }
    return {
      id: o.id,
      category: o.category,
      title: o.title,
      seasons: o.seasons,
      tags: o.tags,
      items: o.items,
      itemPhotos,
      note: o.note,
      photos: o.photoIds.map((pid) => `images/${pid}.jpg`),
      favorite: o.favorite,
      wearDates: o.wearDates,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  });

  return {
    app: '穿搭本',
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    outfits: cleanOutfits,
  };
}

function parseZipPhotoRef(entryPath) {
  const cleanPath = String(entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..')) return null;
  const base = cleanPath.split('/').pop() || '';
  const photoId = base.replace(/\.(jpg|jpeg|png|webp)$/i, '');
  if (!photoId) return null;
  return { photoId, cleanPath };
}

/**
 * Validate and normalize parsed data.json from a backup ZIP.
 * Maps `"images/<id>.jpg"` back to internal `photoIds` and preserves photo file lookup paths.
 */
export function validateBackupPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备份文件格式无效：data.json 不是有效的 JSON 对象');
  }
  if (!Array.isArray(parsed.outfits)) {
    throw new Error('备份文件格式无效：缺少 outfits 列表');
  }
  if (parsed.schemaVersion !== undefined && Number(parsed.schemaVersion) > SCHEMA_VERSION) {
    throw new Error(`备份文件版本 (${parsed.schemaVersion}) 高于当前应用版本，请先更新应用`);
  }

  const normalizedOutfits = [];
  const photoPathMap = new Map(); // photoId -> zipEntryPath

  for (const raw of parsed.outfits) {
    if (!raw || typeof raw !== 'object') continue;

    // Support both `photos: ["images/xxx.jpg"]` and direct `photoIds: ["xxx"]`
    const rawPhotos = Array.isArray(raw.photos)
      ? raw.photos
      : Array.isArray(raw.photoIds)
        ? raw.photoIds.map((id) => `images/${id}.jpg`)
        : [];

    const photoIds = [];
    for (const entryPath of rawPhotos) {
      const ref = parseZipPhotoRef(entryPath);
      if (!ref) continue;
      photoIds.push(ref.photoId);
      photoPathMap.set(ref.photoId, ref.cleanPath);
    }

    const itemPhotos = {};
    if (raw.itemPhotos && typeof raw.itemPhotos === 'object') {
      for (const slot of ITEM_SLOTS) {
        const ref = parseZipPhotoRef(raw.itemPhotos[slot.key]);
        if (ref) {
          itemPhotos[slot.key] = ref.photoId;
          photoPathMap.set(ref.photoId, ref.cleanPath);
        } else {
          itemPhotos[slot.key] = '';
        }
      }
    }

    normalizedOutfits.push(normalizeOutfit({ ...raw, photoIds, itemPhotos }));
  }

  return {
    schemaVersion: Number(parsed.schemaVersion) || SCHEMA_VERSION,
    exportedAt: parsed.exportedAt || null,
    outfits: normalizedOutfits,
    photoPathMap,
  };
}

/**
 * Format byte sizes nicely for storage UI.
 */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Escape HTML special characters before template interpolation.
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
