import {
  deleteOutfit,
  exportBackupZip,
  getAllOutfits,
  getMeta,
  getPhoto,
  getStorageStats,
  importBackupZip,
  initDB,
  saveOutfit,
  setMeta,
  toggleFavorite,
  toggleWearDate,
} from './db.js';
import { processPhotoFile } from './image.js';
import {
  filterOutfits,
  formatDateKey,
  generateId,
  getAllOutfitPhotoIds,
  ITEM_SLOTS,
  MAX_PHOTOS_PER_OUTFIT,
} from './store.js';
import {
  clearAllPhotoUrls,
  getPhotoUrl,
  renderBackupStats,
  renderCalendarView,
  renderCategoryTabs,
  renderDetailContent,
  renderEditorControls,
  renderFilterChips,
  renderOutfitGrid,
  revokePhotoUrls,
  showToast,
} from './ui.js';

const state = {
  tab: 'lookbook', // 'lookbook' | 'calendar' | 'backup'
  outfits: [],
  filters: {
    category: 'all',
    season: 'all',
    tag: '',
    favoriteOnly: false,
    query: '',
  },
  calendar: {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    selectedDateKey: formatDateKey(),
    category: 'all',
  },
  detail: {
    outfitId: null,
    slideIndex: 0,
  },
  lightbox: {
    photoIds: [],
    index: 0,
  },
  editor: null,
};

function registerServiceWorker() {
  if (window.location.protocol === 'file:') {
    document.getElementById('file-protocol-notice')?.classList.remove('hidden');
    return;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Non-fatal if SW registration fails in private browsing
    });
  }
}

function updateHeaderAndView() {
  document.getElementById('header-count').textContent = `共 ${state.outfits.length} 套穿搭`;

  const views = ['lookbook', 'calendar', 'backup'];
  for (const v of views) {
    const el = document.getElementById(`view-${v}`);
    el.classList.toggle('hidden', state.tab !== v);
    el.classList.toggle('active', state.tab === v);
  }

  for (const btn of document.querySelectorAll('.nav-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  }

  document.getElementById('btn-toggle-search').classList.toggle('hidden', state.tab !== 'lookbook');

  if (state.tab === 'lookbook') {
    renderCategoryTabs(document.getElementById('category-tabs'), state.outfits, state.filters.category);
    renderFilterChips(document.getElementById('filter-chips'), state.filters);
    const filtered = filterOutfits(state.outfits, state.filters);
    const hasFilters = Boolean(
      state.filters.category !== 'all' ||
      state.filters.season !== 'all' ||
      state.filters.tag ||
      state.filters.favoriteOnly ||
      state.filters.query.trim(),
    );
    renderOutfitGrid(
      document.getElementById('outfit-grid'),
      document.getElementById('lookbook-empty'),
      filtered,
      hasFilters,
    );
  } else if (state.tab === 'calendar') {
    renderCalendarView({
      year: state.calendar.year,
      month: state.calendar.month,
      selectedDateKey: state.calendar.selectedDateKey,
      calCategory: state.calendar.category,
      outfits: state.outfits,
    });
  } else if (state.tab === 'backup') {
    getStorageStats().then((stats) => {
      renderBackupStats(document.getElementById('backup-stats'), stats);
    });
  }
}

function switchTab(tab) {
  state.tab = tab;
  updateHeaderAndView();
}

async function reloadOutfits() {
  state.outfits = await getAllOutfits();
  updateHeaderAndView();
}

// Custom Confirm Dialog
function askConfirm(title, message, okText = '确认') {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    okBtn.textContent = okText;
    modal.classList.remove('hidden');

    const cleanup = (result) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Editor Sheet Logic
function cleanupEditorTempUrls() {
  if (!state.editor) return;
  for (const p of state.editor.photos) {
    if (p.isNew && p.previewUrl) {
      URL.revokeObjectURL(p.previewUrl);
    }
  }
  for (const slot of ITEM_SLOTS) {
    const ip = state.editor.itemPhotos?.[slot.key];
    if (ip?.isNew && ip.previewUrl) {
      URL.revokeObjectURL(ip.previewUrl);
    }
  }
}

async function openEditor({ outfit = null, defaultCategory = null, defaultWearDate = '' } = {}) {
  const savedLastCategory = await getMeta('lastCategory');
  const initialCategory = outfit?.category
    || (defaultCategory && defaultCategory !== 'all' ? defaultCategory : null)
    || savedLastCategory
    || 'woman';

  const photos = [];
  if (outfit) {
    for (const pid of outfit.photoIds) {
      const previewUrl = await getPhotoUrl(pid, true);
      photos.push({ id: pid, previewUrl, isNew: false });
    }
  }

  const itemPhotos = { top: null, bottom: null, outer: null, accessories: null };
  if (outfit?.itemPhotos) {
    for (const slot of ITEM_SLOTS) {
      const pid = outfit.itemPhotos[slot.key];
      if (pid) {
        const previewUrl = await getPhotoUrl(pid, true);
        itemPhotos[slot.key] = { id: pid, previewUrl, isNew: false };
      }
    }
  }

  state.editor = {
    id: outfit ? outfit.id : generateId('outfit'),
    isEdit: Boolean(outfit),
    createdAt: outfit ? outfit.createdAt : Date.now(),
    category: initialCategory,
    title: outfit ? outfit.title : '',
    seasons: outfit ? [...outfit.seasons] : [],
    tags: outfit ? [...outfit.tags] : [],
    items: {
      top: outfit?.items?.top || '',
      bottom: outfit?.items?.bottom || '',
      outer: outfit?.items?.outer || '',
      accessories: outfit?.items?.accessories || '',
    },
    itemPhotos,
    pendingItemSlot: null,
    note: outfit?.note || '',
    wearDates: outfit ? [...outfit.wearDates] : (defaultWearDate ? [defaultWearDate] : []),
    favorite: outfit ? outfit.favorite : false,
    photos,
    newPhotosMap: new Map(),
    originalPhotoIds: outfit ? getAllOutfitPhotoIds(outfit) : [],
  };

  document.getElementById('editor-title').textContent = outfit ? '编辑穿搭' : '记一套穿搭';
  document.getElementById('editor-title-input').value = outfit ? outfit.title : '';
  document.getElementById('item-top').value = state.editor.items.top;
  document.getElementById('item-bottom').value = state.editor.items.bottom;
  document.getElementById('item-outer').value = state.editor.items.outer;
  document.getElementById('item-accessories').value = state.editor.items.accessories;
  document.getElementById('editor-note').value = state.editor.note;
  document.getElementById('editor-custom-tag').value = '';
  document.getElementById('editor-wear-date').value = state.editor.wearDates[0] || '';

  const hasAnyItem =
    Object.values(state.editor.items).some(Boolean) ||
    Object.values(state.editor.itemPhotos).some(Boolean);
  document.getElementById('editor-items-details').open = hasAnyItem;

  renderEditorControls(state.editor);
  const sheetBody = document.querySelector('#modal-editor .sheet-body');
  if (sheetBody) sheetBody.scrollTop = 0;
  document.getElementById('modal-editor').classList.remove('hidden');
}

function closeEditor() {
  cleanupEditorTempUrls();
  state.editor = null;
  document.getElementById('modal-editor').classList.add('hidden');
  document.getElementById('photo-processing-hint').classList.add('hidden');
}

async function handleSelectedPhotoFiles(fileList) {
  if (!state.editor || !fileList?.length) return;

  const remaining = MAX_PHOTOS_PER_OUTFIT - state.editor.photos.length;
  if (remaining <= 0) {
    showToast(`每套穿搭最多添加 ${MAX_PHOTOS_PER_OUTFIT} 张照片`);
    return;
  }

  const files = Array.from(fileList).slice(0, remaining);
  if (fileList.length > remaining) {
    showToast(`最多还能再选 ${remaining} 张照片，多余的已忽略`);
  }

  const hintEl = document.getElementById('photo-processing-hint');
  hintEl.classList.remove('hidden');

  try {
    // Process sequentially to keep iOS/Huawei memory usage low
    for (let i = 0; i < files.length; i++) {
      hintEl.textContent = `正在压缩第 ${i + 1}/${files.length} 张照片…`;
      const processed = await processPhotoFile(files[i]);
      const photoId = generateId('img');
      const previewUrl = URL.createObjectURL(processed.thumbBlob);
      state.editor.newPhotosMap.set(photoId, processed);
      state.editor.photos.push({ id: photoId, previewUrl, isNew: true });
      renderEditorControls(state.editor);
    }
  } catch (err) {
    showToast(err?.message || '照片处理失败，请重试');
  } finally {
    hintEl.classList.add('hidden');
  }
}

async function handleSelectedItemPhoto(file, slotKey) {
  if (!state.editor || !file || !slotKey) return;
  try {
    const processed = await processPhotoFile(file);
    const photoId = generateId('img');
    const previewUrl = URL.createObjectURL(processed.thumbBlob);

    const prev = state.editor.itemPhotos[slotKey];
    if (prev?.isNew && prev.previewUrl) {
      URL.revokeObjectURL(prev.previewUrl);
      state.editor.newPhotosMap.delete(prev.id);
    }

    state.editor.newPhotosMap.set(photoId, processed);
    state.editor.itemPhotos[slotKey] = { id: photoId, previewUrl, isNew: true };
    renderEditorControls(state.editor);
  } catch (err) {
    showToast(err?.message || '单品照片处理失败，请重试');
  }
}

async function handleSaveEditor() {
  if (!state.editor) return;

  const titleInput = document.getElementById('editor-title-input').value.trim();
  const noteInput = document.getElementById('editor-note').value.trim();
  const wearDateInput = document.getElementById('editor-wear-date').value.trim();
  const hasAnyItemPhoto = Object.values(state.editor.itemPhotos || {}).some(Boolean);

  if (state.editor.photos.length === 0 && !hasAnyItemPhoto && !titleInput && !noteInput) {
    showToast('请至少添加 1 张照片或填写穿搭标题');
    return;
  }

  const wearDatesSet = new Set(state.editor.wearDates);
  if (wearDateInput) {
    wearDatesSet.add(wearDateInput);
  }

  const finalPhotoIds = state.editor.photos.map((p) => p.id);
  const finalItemPhotos = {
    top: state.editor.itemPhotos?.top?.id || '',
    bottom: state.editor.itemPhotos?.bottom?.id || '',
    outer: state.editor.itemPhotos?.outer?.id || '',
    accessories: state.editor.itemPhotos?.accessories?.id || '',
  };
  const allFinalIds = new Set([...finalPhotoIds, ...Object.values(finalItemPhotos).filter(Boolean)]);
  const removedPhotoIds = state.editor.originalPhotoIds.filter((id) => !allFinalIds.has(id));

  const saveBtn = document.getElementById('btn-editor-save');
  saveBtn.disabled = true;
  saveBtn.textContent = '保存中…';

  try {
    const saved = await saveOutfit(
      {
        id: state.editor.id,
        category: state.editor.category,
        title: titleInput,
        seasons: state.editor.seasons,
        tags: state.editor.tags,
        items: {
          top: document.getElementById('item-top').value.trim(),
          bottom: document.getElementById('item-bottom').value.trim(),
          outer: document.getElementById('item-outer').value.trim(),
          accessories: document.getElementById('item-accessories').value.trim(),
        },
        itemPhotos: finalItemPhotos,
        note: noteInput,
        photoIds: finalPhotoIds,
        favorite: state.editor.favorite,
        wearDates: [...wearDatesSet],
        createdAt: state.editor.createdAt,
        updatedAt: Date.now(),
      },
      state.editor.newPhotosMap,
      removedPhotoIds,
    );

    await setMeta('lastCategory', saved.category);
    revokePhotoUrls(removedPhotoIds);

    const wasDetailOpen = state.detail.outfitId === saved.id;
    closeEditor();
    await reloadOutfits();
    if (wasDetailOpen) {
      openDetail(saved.id);
    }
    showToast('穿搭已保存');
  } catch (err) {
    showToast(err?.message || '保存失败，请检查存储空间');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存穿搭';
  }
}

// Detail Modal & Lightbox
function openDetail(outfitId, slideIndex = 0) {
  const outfit = state.outfits.find((o) => o.id === outfitId);
  if (!outfit) return;
  state.detail.outfitId = outfitId;
  state.detail.slideIndex = slideIndex;

  const favBtn = document.getElementById('btn-detail-fav');
  favBtn.textContent = outfit.favorite ? '♥' : '♡';
  favBtn.style.color = outfit.favorite ? 'var(--accent)' : 'var(--ink)';

  renderDetailContent(document.getElementById('detail-body'), outfit, slideIndex);
  document.getElementById('modal-detail').classList.remove('hidden');
}

function closeDetail() {
  state.detail.outfitId = null;
  document.getElementById('modal-detail').classList.add('hidden');
}

async function openLightbox(photoIds, index = 0) {
  if (!photoIds.length) return;
  state.lightbox = {
    photoIds,
    index: Math.max(0, Math.min(index, photoIds.length - 1)),
  };
  await refreshLightbox();
  document.getElementById('modal-lightbox').classList.remove('hidden');
}

async function refreshLightbox() {
  const { photoIds, index } = state.lightbox;
  const pid = photoIds[index];
  const url = await getPhotoUrl(pid, false);
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox-counter').textContent = `${index + 1} / ${photoIds.length}`;
  const showArrows = photoIds.length > 1;
  document.getElementById('btn-lightbox-prev').classList.toggle('hidden', !showArrows);
  document.getElementById('btn-lightbox-next').classList.toggle('hidden', !showArrows);
}

function closeLightbox() {
  document.getElementById('modal-lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function setBackupProgress(visible, percent = 0, message = '') {
  const wrap = document.getElementById('backup-progress');
  wrap.classList.toggle('hidden', !visible);
  document.getElementById('backup-progress-pct').textContent = `${percent}%`;
  document.getElementById('backup-progress-text').textContent = message;
  document.getElementById('backup-progress-bar').style.width = `${percent}%`;
}

// Event Listeners
function bindEvents() {
  // Bottom navigation tabs
  for (const btn of document.querySelectorAll('.nav-tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  document.getElementById('btn-header-backup').addEventListener('click', () => switchTab('backup'));
  document.getElementById('btn-fab-add').addEventListener('click', () =>
    openEditor({
      defaultCategory: state.tab === 'lookbook' ? state.filters.category : state.calendar.category,
    }),
  );
  document.getElementById('btn-empty-add').addEventListener('click', () =>
    openEditor({ defaultCategory: state.filters.category }),
  );

  // Search toggle & input
  document.getElementById('btn-toggle-search').addEventListener('click', () => {
    const bar = document.getElementById('search-bar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) {
      document.getElementById('search-input').focus();
    }
  });

  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('btn-clear-search');
  searchInput.addEventListener('input', (e) => {
    state.filters.query = e.target.value;
    clearSearchBtn.classList.toggle('hidden', !state.filters.query);
    updateHeaderAndView();
  });
  clearSearchBtn.addEventListener('click', () => {
    state.filters.query = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    updateHeaderAndView();
  });

  // Lookbook category & filter clicks
  document.getElementById('category-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    state.filters.category = btn.dataset.category;
    updateHeaderAndView();
  });

  document.getElementById('filter-chips').addEventListener('click', (e) => {
    const seasonBtn = e.target.closest('[data-season]');
    if (seasonBtn) {
      state.filters.season = seasonBtn.dataset.season;
      updateHeaderAndView();
      return;
    }
    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    if (actionBtn.dataset.action === 'toggle-fav-filter') {
      state.filters.favoriteOnly = !state.filters.favoriteOnly;
      updateHeaderAndView();
    } else if (actionBtn.dataset.action === 'clear-tag') {
      state.filters.tag = '';
      updateHeaderAndView();
    }
  });

  // Outfit grid card clicks & favorite button
  document.getElementById('outfit-grid').addEventListener('click', async (e) => {
    const favBtn = e.target.closest('[data-fav-id]');
    if (favBtn) {
      e.stopPropagation();
      await toggleFavorite(favBtn.dataset.favId);
      await reloadOutfits();
      return;
    }
    const card = e.target.closest('[data-outfit-id]');
    if (card) {
      openDetail(card.dataset.outfitId);
    }
  });

  // Calendar interactions
  document.getElementById('btn-cal-prev').addEventListener('click', () => {
    if (state.calendar.month === 0) {
      state.calendar.month = 11;
      state.calendar.year -= 1;
    } else {
      state.calendar.month -= 1;
    }
    updateHeaderAndView();
  });
  document.getElementById('btn-cal-next').addEventListener('click', () => {
    if (state.calendar.month === 11) {
      state.calendar.month = 0;
      state.calendar.year += 1;
    } else {
      state.calendar.month += 1;
    }
    updateHeaderAndView();
  });
  document.getElementById('btn-cal-today').addEventListener('click', () => {
    const now = new Date();
    state.calendar.year = now.getFullYear();
    state.calendar.month = now.getMonth();
    state.calendar.selectedDateKey = formatDateKey(now);
    updateHeaderAndView();
  });
  document.getElementById('cal-category-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cal-category]');
    if (!btn) return;
    state.calendar.category = btn.dataset.calCategory;
    updateHeaderAndView();
  });
  document.getElementById('calendar-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-date]');
    if (!cell) return;
    state.calendar.selectedDateKey = cell.dataset.date;
    updateHeaderAndView();
  });
  document.getElementById('cal-day-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-outfit-id]');
    if (row) openDetail(row.dataset.outfitId);
  });
  document.getElementById('btn-cal-add-day').addEventListener('click', () =>
    openEditor({
      defaultCategory: state.calendar.category,
      defaultWearDate: state.calendar.selectedDateKey,
    }),
  );

  // Editor interactions
  document.getElementById('btn-editor-close').addEventListener('click', closeEditor);
  document.getElementById('btn-editor-cancel').addEventListener('click', closeEditor);
  document.getElementById('btn-editor-save').addEventListener('click', handleSaveEditor);

  document.getElementById('btn-take-photo').addEventListener('click', () =>
    document.getElementById('input-camera').click(),
  );
  document.getElementById('btn-pick-photos').addEventListener('click', () =>
    document.getElementById('input-gallery').click(),
  );
  document.getElementById('input-camera').addEventListener('change', async (e) => {
    await handleSelectedPhotoFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('input-gallery').addEventListener('change', async (e) => {
    await handleSelectedPhotoFiles(e.target.files);
    e.target.value = '';
  });

  // Per-item photo picker & removal inside 单品拆解
  document.getElementById('editor-items-details').addEventListener('click', (e) => {
    if (!state.editor) return;
    const camBtn = e.target.closest('[data-pick-item-camera]');
    if (camBtn) {
      state.editor.pendingItemSlot = camBtn.dataset.pickItemCamera;
      document.getElementById('input-item-camera').click();
      return;
    }
    const galBtn = e.target.closest('[data-pick-item-gallery]');
    if (galBtn) {
      state.editor.pendingItemSlot = galBtn.dataset.pickItemGallery;
      document.getElementById('input-item-gallery').click();
      return;
    }
    const remBtn = e.target.closest('[data-remove-item-photo]');
    if (remBtn) {
      const slotKey = remBtn.dataset.removeItemPhoto;
      const existing = state.editor.itemPhotos[slotKey];
      if (existing?.isNew && existing.previewUrl) {
        URL.revokeObjectURL(existing.previewUrl);
        state.editor.newPhotosMap.delete(existing.id);
      }
      state.editor.itemPhotos[slotKey] = null;
      renderEditorControls(state.editor);
    }
  });
  document.getElementById('input-item-camera').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const slotKey = state.editor?.pendingItemSlot;
    e.target.value = '';
    if (file && slotKey) await handleSelectedItemPhoto(file, slotKey);
  });
  document.getElementById('input-item-gallery').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const slotKey = state.editor?.pendingItemSlot;
    e.target.value = '';
    if (file && slotKey) await handleSelectedItemPhoto(file, slotKey);
  });

  document.getElementById('editor-photo-list').addEventListener('click', (e) => {
    if (!state.editor) return;
    const removeBtn = e.target.closest('[data-remove-photo]');
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.removePhoto);
      const [removed] = state.editor.photos.splice(idx, 1);
      if (removed?.isNew && removed.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        state.editor.newPhotosMap.delete(removed.id);
      }
      renderEditorControls(state.editor);
      return;
    }
    const coverBtn = e.target.closest('[data-cover-photo]');
    if (coverBtn) {
      const idx = Number(coverBtn.dataset.coverPhoto);
      const [chosen] = state.editor.photos.splice(idx, 1);
      state.editor.photos.unshift(chosen);
      renderEditorControls(state.editor);
    }
  });

  document.getElementById('editor-category').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-editor-cat]');
    if (!btn || !state.editor) return;
    state.editor.category = btn.dataset.editorCat;
    renderEditorControls(state.editor);
  });

  document.getElementById('editor-seasons').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-editor-season]');
    if (!btn || !state.editor) return;
    const s = btn.dataset.editorSeason;
    const idx = state.editor.seasons.indexOf(s);
    if (idx >= 0) state.editor.seasons.splice(idx, 1);
    else state.editor.seasons.push(s);
    renderEditorControls(state.editor);
  });

  document.getElementById('editor-tags').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-editor-tag]');
    if (!btn || !state.editor) return;
    const t = btn.dataset.editorTag;
    const idx = state.editor.tags.indexOf(t);
    if (idx >= 0) state.editor.tags.splice(idx, 1);
    else state.editor.tags.push(t);
    renderEditorControls(state.editor);
  });

  document.getElementById('btn-add-tag').addEventListener('click', () => {
    if (!state.editor) return;
    const input = document.getElementById('editor-custom-tag');
    const val = input.value.trim().replace(/^#/, '');
    if (!val) return;
    if (!state.editor.tags.includes(val)) {
      state.editor.tags.push(val);
    }
    input.value = '';
    renderEditorControls(state.editor);
  });

  document.getElementById('btn-date-today').addEventListener('click', () => {
    document.getElementById('editor-wear-date').value = formatDateKey();
  });
  document.getElementById('btn-date-clear').addEventListener('click', () => {
    document.getElementById('editor-wear-date').value = '';
    if (state.editor) state.editor.wearDates = [];
  });

  // Detail modal interactions
  document.getElementById('btn-detail-close').addEventListener('click', closeDetail);
  document.getElementById('btn-detail-fav').addEventListener('click', async () => {
    if (!state.detail.outfitId) return;
    await toggleFavorite(state.detail.outfitId);
    await reloadOutfits();
    openDetail(state.detail.outfitId, state.detail.slideIndex);
  });
  document.getElementById('btn-detail-edit').addEventListener('click', () => {
    const outfit = state.outfits.find((o) => o.id === state.detail.outfitId);
    if (outfit) openEditor({ outfit });
  });
  document.getElementById('btn-detail-delete').addEventListener('click', async () => {
    const outfit = state.outfits.find((o) => o.id === state.detail.outfitId);
    if (!outfit) return;
    const ok = await askConfirm('删除穿搭', `确定要删除「${outfit.title}」及其照片吗？此操作无法撤销。`, '删除');
    if (!ok) return;
    const removedPhotoIds = await deleteOutfit(outfit.id);
    revokePhotoUrls(removedPhotoIds);
    closeDetail();
    await reloadOutfits();
    showToast('已删除穿搭');
  });

  const detailBody = document.getElementById('detail-body');
  detailBody.addEventListener('click', async (e) => {
    const outfit = state.outfits.find((o) => o.id === state.detail.outfitId);
    if (!outfit) return;

    if (e.target.closest('#btn-detail-wear-today')) {
      await toggleWearDate(outfit.id, formatDateKey());
      await reloadOutfits();
      openDetail(outfit.id, state.detail.slideIndex);
      showToast('已更新今日穿搭打卡');
      return;
    }

    const dirBtn = e.target.closest('[data-slide-dir]');
    if (dirBtn) {
      const len = outfit.photoIds.length;
      if (len > 1) {
        const nextIdx = (state.detail.slideIndex + Number(dirBtn.dataset.slideDir) + len) % len;
        openDetail(outfit.id, nextIdx);
      }
      return;
    }

    const dotBtn = e.target.closest('[data-slide-to]');
    if (dotBtn) {
      openDetail(outfit.id, Number(dotBtn.dataset.slideTo));
      return;
    }

    const tagBtn = e.target.closest('[data-filter-tag]');
    if (tagBtn) {
      state.filters.tag = tagBtn.dataset.filterTag;
      closeDetail();
      switchTab('lookbook');
      return;
    }

    const imgEl = e.target.closest('[data-lightbox-index]');
    if (imgEl) {
      openLightbox(outfit.photoIds, Number(imgEl.dataset.lightboxIndex));
      return;
    }

    const itemImgEl = e.target.closest('[data-item-lightbox-id]');
    if (itemImgEl) {
      const itemPhotoIds = ITEM_SLOTS
        .map((s) => outfit.itemPhotos?.[s.key])
        .filter(Boolean);
      const targetId = itemImgEl.dataset.itemLightboxId;
      const idx = Math.max(0, itemPhotoIds.indexOf(targetId));
      openLightbox(itemPhotoIds, idx);
    }
  });

  // Touch swipe in detail carousel
  let touchStartX = 0;
  detailBody.addEventListener('touchstart', (e) => {
    if (e.target.closest('#detail-carousel')) {
      touchStartX = e.touches[0].clientX;
    } else {
      touchStartX = 0;
    }
  }, { passive: true });
  detailBody.addEventListener('touchend', (e) => {
    if (!touchStartX) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = 0;
    if (Math.abs(dx) < 40) return;
    const outfit = state.outfits.find((o) => o.id === state.detail.outfitId);
    if (!outfit || outfit.photoIds.length <= 1) return;
    const len = outfit.photoIds.length;
    const step = dx < 0 ? 1 : -1;
    openDetail(outfit.id, (state.detail.slideIndex + step + len) % len);
  }, { passive: true });

  // Lightbox controls
  document.getElementById('btn-lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('btn-lightbox-prev').addEventListener('click', () => {
    const len = state.lightbox.photoIds.length;
    state.lightbox.index = (state.lightbox.index - 1 + len) % len;
    refreshLightbox();
  });
  document.getElementById('btn-lightbox-next').addEventListener('click', () => {
    const len = state.lightbox.photoIds.length;
    state.lightbox.index = (state.lightbox.index + 1) % len;
    refreshLightbox();
  });
  document.getElementById('btn-lightbox-download').addEventListener('click', async () => {
    const pid = state.lightbox.photoIds[state.lightbox.index];
    const rec = await getPhoto(pid);
    if (rec?.blob) {
      triggerDownload(rec.blob, `${pid}.jpg`);
      showToast('已开始保存照片');
    }
  });

  // Backup Export / Share / Import
  if ('share' in navigator && 'canShare' in navigator) {
    document.getElementById('btn-share-zip').classList.remove('hidden');
  }

  document.getElementById('btn-export-zip').addEventListener('click', async () => {
    try {
      setBackupProgress(true, 5, '正在准备备份…');
      const res = await exportBackupZip(({ percent, message }) => setBackupProgress(true, percent, message));
      triggerDownload(res.blob, res.filename);
      showToast(`已导出 ${res.outfitCount} 套穿搭、${res.photoCount} 张照片`);
      const stats = await getStorageStats();
      renderBackupStats(document.getElementById('backup-stats'), stats);
    } catch (err) {
      showToast(err?.message || '导出备份失败');
    } finally {
      setTimeout(() => setBackupProgress(false), 1200);
    }
  });

  document.getElementById('btn-share-zip').addEventListener('click', async () => {
    try {
      setBackupProgress(true, 5, '正在生成备份文件…');
      const res = await exportBackupZip(({ percent, message }) => setBackupProgress(true, percent, message));
      const file = new File([res.blob], res.filename, { type: 'application/zip' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: '穿搭本备份',
          text: `共 ${res.outfitCount} 套穿搭、${res.photoCount} 张照片`,
        });
      } else {
        triggerDownload(res.blob, res.filename);
      }
      const stats = await getStorageStats();
      renderBackupStats(document.getElementById('backup-stats'), stats);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        showToast(err?.message || '分享失败，已为您尝试直接下载');
      }
    } finally {
      setTimeout(() => setBackupProgress(false), 1200);
    }
  });

  document.getElementById('btn-import-zip').addEventListener('click', () =>
    document.getElementById('input-import-zip').click(),
  );

  document.getElementById('input-import-zip').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';
    if (mode === 'replace') {
      const ok = await askConfirm(
        '确认覆盖恢复？',
        '覆盖恢复会先清空当前手机里的全部穿搭和照片，再替换为备份包内容，确定继续吗？',
        '确认覆盖',
      );
      if (!ok) return;
    }

    try {
      setBackupProgress(true, 5, '正在读取备份文件…');
      const result = await importBackupZip(file, mode, ({ percent, message }) =>
        setBackupProgress(true, percent, message),
      );
      if (mode === 'replace') {
        clearAllPhotoUrls();
      }
      await reloadOutfits();
      const missingNote = result.missingPhotoCount > 0 ? `（另有 ${result.missingPhotoCount} 张缺失图片已跳过）` : '';
      showToast(`导入 ${result.importedCount} 套穿搭，恢复 ${result.photoCount} 张照片${missingNote}`);
    } catch (err) {
      showToast(err?.message || '导入失败，请确认选择的是有效的穿搭备份 ZIP');
    } finally {
      setTimeout(() => setBackupProgress(false), 1200);
    }
  });
}

async function bootstrap() {
  registerServiceWorker();
  await initDB();
  bindEvents();
  await reloadOutfits();
}

bootstrap().catch((err) => {
  console.error(err);
  showToast('初始化本地数据库失败，请刷新重试');
});
