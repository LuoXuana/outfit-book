import { getPhoto } from './db.js';
import {
  buildCalendarMonth,
  CATEGORIES,
  CATEGORY_MAP,
  countByCategory,
  escapeHtml,
  formatBytes,
  formatDateKey,
  formatDateTime,
  ITEM_SLOTS,
  PRESET_TAGS,
  SEASONS,
} from './store.js';

/**
 * Cache blob URLs by `${photoId}:${thumb|full}` so re-renders never leak memory.
 */
const urlCache = new Map();

export async function getPhotoUrl(photoId, useThumb = true) {
  if (!photoId) return '';
  const key = `${photoId}:${useThumb ? 'thumb' : 'full'}`;
  if (urlCache.has(key)) return urlCache.get(key);

  const rec = await getPhoto(photoId);
  if (!rec) return '';
  const targetBlob = useThumb ? (rec.thumbBlob || rec.blob) : (rec.blob || rec.thumbBlob);
  if (!targetBlob) return '';

  const url = URL.createObjectURL(targetBlob);
  urlCache.set(key, url);
  return url;
}

export function revokePhotoUrls(photoIds = []) {
  for (const id of photoIds) {
    for (const suffix of ['thumb', 'full']) {
      const key = `${id}:${suffix}`;
      const url = urlCache.get(key);
      if (url) {
        URL.revokeObjectURL(url);
        urlCache.delete(key);
      }
    }
  }
}

export function clearAllPhotoUrls() {
  for (const url of urlCache.values()) {
    URL.revokeObjectURL(url);
  }
  urlCache.clear();
}

export function showToast(message, durationMs = 2600) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, durationMs);
}

/**
 * Hydrate `<img data-photo-id="..." data-thumb="1|0">` elements asynchronously.
 */
export function hydratePhotoElements(root) {
  const imgs = root.querySelectorAll('img[data-photo-id]');
  for (const img of imgs) {
    const pid = img.dataset.photoId;
    const useThumb = img.dataset.thumb !== '0';
    getPhotoUrl(pid, useThumb).then((url) => {
      if (url && img.isConnected) {
        img.src = url;
      }
    });
  }
}

export function renderCategoryTabs(container, outfits, activeCategory) {
  const counts = countByCategory(outfits);
  const tabs = [
    { id: 'all', label: '全部' },
    ...CATEGORIES,
  ];

  container.innerHTML = tabs
    .map(
      (t) => `
      <button type="button" class="cat-pill ${activeCategory === t.id ? 'active' : ''}" data-category="${t.id}">
        <span>${escapeHtml(t.label)}</span>
        <span class="count">${counts[t.id] ?? 0}</span>
      </button>`,
    )
    .join('');
}

export function renderFilterChips(container, { season, favoriteOnly, tag }) {
  const chips = [
    `<button type="button" class="chip-btn ${season === 'all' ? 'active' : ''}" data-season="all">全部季节</button>`,
    ...SEASONS.map(
      (s) => `<button type="button" class="chip-btn ${season === s ? 'active' : ''}" data-season="${s}">${s}</button>`,
    ),
    `<button type="button" class="chip-btn ${favoriteOnly ? 'active' : ''}" data-action="toggle-fav-filter">${favoriteOnly ? '★ 已收藏' : '☆ 收藏'}</button>`,
  ];

  if (tag) {
    chips.push(
      `<button type="button" class="chip-btn tag-active" data-action="clear-tag">#${escapeHtml(tag)} ×</button>`,
    );
  }

  container.innerHTML = chips.join('');
}

export function renderOutfitGrid(gridEl, emptyEl, filteredOutfits, hasActiveFilters) {
  if (filteredOutfits.length === 0) {
    gridEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    const titleEl = document.getElementById('empty-title');
    const descEl = document.getElementById('empty-desc');
    const ctaBtn = document.getElementById('btn-empty-add');
    if (hasActiveFilters) {
      titleEl.textContent = '没有找到匹配的穿搭';
      descEl.textContent = '试试切换分类、季节，或清空搜索关键词。';
      ctaBtn.textContent = '+ 记一套新穿搭';
    } else {
      titleEl.textContent = '还没有记录穿搭';
      descEl.textContent = '拍下女士、女孩或男孩的日常搭配，选好分类和季节，随时翻看灵感。';
      ctaBtn.textContent = '+ 记第一套穿搭';
    }
    return;
  }

  emptyEl.classList.add('hidden');
  gridEl.innerHTML = filteredOutfits
    .map((o) => {
      const cat = CATEGORY_MAP[o.category] || CATEGORY_MAP.woman;
      const coverId = o.photoIds[0];
      const photoCount = o.photoIds.length;
      const seasonsText = o.seasons.length > 0 ? o.seasons.join('·') : '';
      const visibleTags = o.tags.slice(0, 2);

      return `
        <article class="outfit-card" data-outfit-id="${escapeHtml(o.id)}">
          <div class="card-cover">
            ${
              coverId
                ? `<img data-photo-id="${escapeHtml(coverId)}" data-thumb="1" alt="${escapeHtml(o.title)}" loading="lazy" />`
                : `<div class="card-no-photo"><span>👗</span><span>暂无照片</span></div>`
            }
            ${photoCount > 1 ? `<span class="card-photo-badge">${photoCount} 张</span>` : ''}
            <button type="button" class="card-fav-btn ${o.favorite ? 'active' : ''}" data-fav-id="${escapeHtml(o.id)}" aria-label="收藏">
              ${o.favorite ? '♥' : '♡'}
            </button>
          </div>
          <div class="card-body">
            <div class="card-meta-row">
              <span class="cat-badge ${cat.badgeClass}">${escapeHtml(cat.label)}</span>
              <span class="season-text">${escapeHtml(seasonsText)}</span>
            </div>
            <h3 class="card-title">${escapeHtml(o.title)}</h3>
            ${
              visibleTags.length > 0
                ? `<div class="card-tags">${visibleTags.map((t) => `<span class="tag-mini">#${escapeHtml(t)}</span>`).join('')}</div>`
                : ''
            }
          </div>
        </article>`;
    })
    .join('');

  hydratePhotoElements(gridEl);
}

export function renderCalendarView({ year, month, selectedDateKey, calCategory, outfits }) {
  const monthLabel = document.getElementById('cal-month-label');
  monthLabel.textContent = `${year}年${month + 1}月`;

  const catTabsEl = document.getElementById('cal-category-tabs');
  const tabs = [{ id: 'all', label: '全部' }, ...CATEGORIES];
  catTabsEl.innerHTML = tabs
    .map(
      (t) => `<button type="button" class="chip-btn ${calCategory === t.id ? 'active' : ''}" data-cal-category="${t.id}">${escapeHtml(t.label)}</button>`,
    )
    .join('');

  const { cells, byDate } = buildCalendarMonth(year, month, outfits, calCategory);
  const todayKey = formatDateKey();
  const gridEl = document.getElementById('calendar-grid');

  gridEl.innerHTML = cells
    .map((cell) => {
      if (!cell) return '<div class="cal-cell empty"></div>';
      const isToday = cell.dateKey === todayKey;
      const isSelected = cell.dateKey === selectedDateKey;
      const dots = cell.categoriesPresent
        .slice(0, 3)
        .map((c) => `<span class="cal-dot ${c}"></span>`)
        .join('');

      return `
        <button type="button" class="cal-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${cell.dateKey}">
          <span>${cell.day}</span>
          <span class="cal-dots">${dots}</span>
        </button>`;
    })
    .join('');

  const selectedLabel = document.getElementById('cal-selected-label');
  const dayOutfits = byDate.get(selectedDateKey) || [];
  selectedLabel.textContent = `${selectedDateKey} 穿搭记录 (${dayOutfits.length})`;

  const dayListEl = document.getElementById('cal-day-list');
  if (dayOutfits.length === 0) {
    dayListEl.innerHTML = `<div class="panel-card"><p class="panel-desc" style="margin:0;">这一天还没有登记穿搭，点击上方「+ 记录这天穿搭」或去穿搭详情页点「今天穿这套」。</p></div>`;
    return;
  }

  dayListEl.innerHTML = dayOutfits
    .map((o) => {
      const cat = CATEGORY_MAP[o.category] || CATEGORY_MAP.woman;
      const coverId = o.photoIds[0];
      return `
        <button type="button" class="cal-outfit-row" data-outfit-id="${escapeHtml(o.id)}">
          ${
            coverId
              ? `<img class="cal-thumb" data-photo-id="${escapeHtml(coverId)}" data-thumb="1" alt="" />`
              : `<div class="cal-thumb" style="display:flex;align-items:center;justify-content:center;">👗</div>`
          }
          <div class="cal-row-info">
            <span class="cat-badge ${cat.badgeClass}">${escapeHtml(cat.label)}</span>
            <div class="cal-row-title">${escapeHtml(o.title)}</div>
            <div class="cal-row-meta">${escapeHtml(o.seasons.join('·') || '日常')} ${o.tags.slice(0, 2).map((t) => `#${escapeHtml(t)}`).join(' ')}</div>
          </div>
        </button>`;
    })
    .join('');

  hydratePhotoElements(dayListEl);
}

export function renderBackupStats(container, stats) {
  const c = stats.categoryCounts || {};
  container.innerHTML = `
    <div class="stat-box">
      <div class="stat-value">${stats.outfitCount} 套</div>
      <div class="stat-label">总穿搭（女${c.woman || 0} / 女孩${c.girl || 0} / 男孩${c.boy || 0}）</div>
    </div>
    <div class="stat-box">
      <div class="stat-value">${stats.photoCount} 张</div>
      <div class="stat-label">本地 JPEG 照片</div>
    </div>
    <div class="stat-box">
      <div class="stat-value">${formatBytes(stats.totalBytes)}</div>
      <div class="stat-label">占用手机空间</div>
    </div>
    <div class="stat-box">
      <div class="stat-value" style="font-size:14px;line-height:1.6;">${escapeHtml(formatDateTime(stats.lastBackupAt))}</div>
      <div class="stat-label">最近导出备份</div>
    </div>
  `;
}

export function renderEditorControls(draft) {
  // Categories
  const catEl = document.getElementById('editor-category');
  catEl.innerHTML = CATEGORIES.map(
    (c) => `<button type="button" class="segment-btn ${draft.category === c.id ? 'active' : ''}" data-editor-cat="${c.id}">${escapeHtml(c.label)}</button>`,
  ).join('');

  // Seasons
  const seasonEl = document.getElementById('editor-seasons');
  seasonEl.innerHTML = SEASONS.map(
    (s) => `<button type="button" class="select-pill ${draft.seasons.includes(s) ? 'active' : ''}" data-editor-season="${s}">${s}</button>`,
  ).join('');

  // Tags (union of presets and custom tags in draft)
  const allTags = [...new Set([...PRESET_TAGS, ...draft.tags])];
  const tagsEl = document.getElementById('editor-tags');
  tagsEl.innerHTML = allTags
    .map(
      (t) => `<button type="button" class="select-pill ${draft.tags.includes(t) ? 'active' : ''}" data-editor-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`,
    )
    .join('');

  // Photos
  const countEl = document.getElementById('editor-photo-count');
  countEl.textContent = `${draft.photos.length} / 9 张`;

  const listEl = document.getElementById('editor-photo-list');
  listEl.innerHTML = draft.photos
    .map(
      (p, idx) => `
      <div class="editor-photo-item">
        <img src="${escapeHtml(p.previewUrl)}" alt="穿搭照片 ${idx + 1}" />
        <button type="button" class="photo-remove-btn" data-remove-photo="${idx}" aria-label="删除照片">×</button>
        ${
          idx === 0
            ? `<span class="photo-cover-tag">封面</span>`
            : `<button type="button" class="photo-set-cover-btn" data-cover-photo="${idx}">设封面</button>`
        }
      </div>`,
    )
    .join('');

  // Per-item photo slots (updates only photo slot without re-rendering text inputs)
  for (const slot of ITEM_SLOTS) {
    const slotEl = document.querySelector(`[data-item-photo-slot="${slot.key}"]`);
    if (!slotEl) continue;
    const itemPhoto = draft.itemPhotos?.[slot.key];
    if (itemPhoto) {
      slotEl.classList.add('has-photo');
      slotEl.innerHTML = `
        <img src="${escapeHtml(itemPhoto.previewUrl)}" alt="${escapeHtml(slot.label)}照片" />
        <button type="button" class="item-photo-remove" data-remove-item-photo="${slot.key}" aria-label="删除${escapeHtml(slot.label)}照片">×</button>
      `;
    } else {
      slotEl.classList.remove('has-photo');
      slotEl.innerHTML = `
        <button type="button" class="item-photo-add-btn" data-pick-item-gallery="${slot.key}">
          <span>+</span>
          <span>单品图</span>
        </button>
      `;
    }
  }
}

export function renderDetailContent(container, outfit, slideIndex) {
  const cat = CATEGORY_MAP[outfit.category] || CATEGORY_MAP.woman;
  const photos = outfit.photoIds;
  const safeIndex = Math.max(0, Math.min(slideIndex, Math.max(0, photos.length - 1)));
  const currentPhotoId = photos[safeIndex];
  const todayKey = formatDateKey();
  const wornToday = outfit.wearDates.includes(todayKey);

  const itemEntries = ITEM_SLOTS
    .map((slot) => ({
      key: slot.key,
      label: slot.label,
      text: outfit.items?.[slot.key] || '',
      photoId: outfit.itemPhotos?.[slot.key] || '',
    }))
    .filter((entry) => Boolean(entry.text || entry.photoId));

  container.innerHTML = `
    ${
      photos.length > 0
        ? `
      <div class="detail-carousel" id="detail-carousel">
        <img class="detail-slide-img" data-photo-id="${escapeHtml(currentPhotoId)}" data-thumb="0" data-lightbox-index="${safeIndex}" alt="${escapeHtml(outfit.title)}" />
        ${
          photos.length > 1
            ? `
          <button type="button" class="carousel-arrow left" data-slide-dir="-1" aria-label="上一张">‹</button>
          <button type="button" class="carousel-arrow right" data-slide-dir="1" aria-label="下一张">›</button>
          <div class="carousel-dots">
            ${photos.map((_, i) => `<button type="button" class="carousel-dot ${i === safeIndex ? 'active' : ''}" data-slide-to="${i}" aria-label="第${i + 1}张"></button>`).join('')}
          </div>`
            : ''
        }
      </div>`
        : ''
    }

    <div class="detail-meta-bar">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="cat-badge ${cat.badgeClass}">${escapeHtml(cat.label)}</span>
        ${outfit.seasons.map((s) => `<span class="tag-mini">${escapeHtml(s)}季</span>`).join('')}
      </div>
      <button type="button" id="btn-detail-wear-today" class="btn btn-sm ${wornToday ? 'btn-primary' : 'btn-soft'}">
        ${wornToday ? '✓ 今天已穿' : '今天穿这套'}
      </button>
    </div>

    <h2 id="detail-title" class="detail-title">${escapeHtml(outfit.title)}</h2>

    ${
      outfit.tags.length > 0
        ? `<div class="detail-tags">${outfit.tags.map((t) => `<button type="button" class="tag-clickable" data-filter-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}</div>`
        : ''
    }

    ${
      itemEntries.length > 0
        ? `
      <div class="detail-block">
        <h3 class="detail-block-title">单品拆解</h3>
        <div class="detail-items-grid">
          ${itemEntries
            .map(
              (item) => `
            <div class="detail-item-card">
              ${
                item.photoId
                  ? `<img class="detail-item-thumb" data-photo-id="${escapeHtml(item.photoId)}" data-thumb="1" data-item-lightbox-id="${escapeHtml(item.photoId)}" alt="${escapeHtml(item.label)}" />`
                  : ''
              }
              <div class="detail-item-text">
                <div class="detail-item-label">${escapeHtml(item.label)}</div>
                <div class="detail-item-value">${escapeHtml(item.text || '已附单品图')}</div>
              </div>
            </div>`,
            )
            .join('')}
        </div>
      </div>`
        : ''
    }

    ${
      outfit.note
        ? `
      <div class="detail-block">
        <h3 class="detail-block-title">搭配备注</h3>
        <p class="detail-note">${escapeHtml(outfit.note)}</p>
      </div>`
        : ''
    }

    <div class="detail-block">
      <h3 class="detail-block-title">穿着记录 (${outfit.wearDates.length} 次)</h3>
      ${
        outfit.wearDates.length > 0
          ? `<div class="wear-dates-list">${outfit.wearDates.map((d) => `<span class="wear-date-chip">${escapeHtml(d)}</span>`).join('')}</div>`
          : `<p class="panel-desc" style="margin:0;">暂无穿着日期，点上方「今天穿这套」即可打卡到日历。</p>`
      }
    </div>
  `;

  hydratePhotoElements(container);
}
