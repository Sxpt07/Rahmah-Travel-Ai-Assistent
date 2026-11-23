/**
 * Modul frontend Add-on Per Batch.
 *
 * Sumber data: `/api/add-on` (cache SQLite hasil sinkronisasi SGO). Tampilan
 * default menampilkan rekap per jenis add-on + daftar batch. Pencarian angka
 * (RTB) membuka rincian batch, sedangkan nama / kode order / jenis add-on
 * menampilkan grup order beserta kartu jamaah.
 *
 * Progress sinkronisasi memakai endpoint terpisah agar tidak mengganggu
 * progress bar Monitoring Jamaah.
 */
(() => {
  const ENDPOINT = '/api/add-on';
  const PROGRESS_ENDPOINT = '/api/add-on/progress';
  const REFRESH_ENDPOINT = '/api/add-on/refresh';
  const POLL_MS = 1000;
  const SEARCH_DEBOUNCE_MS = 320;
  const GROUP_PAGE_SIZE = 40;
  const PROGRESS_HIDE_MS = 4200;

  const els = {
    section: document.getElementById('view-add-on'),
    syncBtn: document.getElementById('addon-sync-btn'),
    syncIcon: document.getElementById('addon-sync-icon'),
    sourceChip: document.getElementById('addon-source-chip'),
    sourceDot: document.getElementById('addon-source-dot'),
    sourceLabel: document.getElementById('addon-source-label'),
    warning: document.getElementById('addon-warning'),
    progress: document.getElementById('addon-progress'),
    progressTitle: document.getElementById('addon-progress-title'),
    progressPercent: document.getElementById('addon-progress-percent'),
    progressTrack: document.getElementById('addon-progress-track'),
    progressBar: document.getElementById('addon-progress-bar'),
    progressDetail: document.getElementById('addon-progress-detail'),
    statQty: document.getElementById('addon-stat-qty'),
    statQtySub: document.getElementById('addon-stat-qty-sub'),
    statPaid: document.getElementById('addon-stat-paid'),
    statPaidSub: document.getElementById('addon-stat-paid-sub'),
    statFree: document.getElementById('addon-stat-free'),
    statFreeSub: document.getElementById('addon-stat-free-sub'),
    statRevenue: document.getElementById('addon-stat-revenue'),
    statRevenueSub: document.getElementById('addon-stat-revenue-sub'),
    search: document.getElementById('addon-search'),
    searchClear: document.getElementById('addon-search-clear'),
    itemFilter: document.getElementById('addon-item-filter'),
    statusFilter: document.getElementById('addon-status-filter'),
    sort: document.getElementById('addon-sort'),
    reset: document.getElementById('addon-reset'),
    resultMeta: document.getElementById('addon-result-meta'),
    syncMeta: document.getElementById('addon-sync-meta'),
    loading: document.getElementById('addon-loading'),
    error: document.getElementById('addon-error'),
    errorText: document.getElementById('addon-error-text'),
    retry: document.getElementById('addon-retry'),
    empty: document.getElementById('addon-empty'),
    emptyTitle: document.getElementById('addon-empty-title'),
    emptyText: document.getElementById('addon-empty-text'),
    emptySync: document.getElementById('addon-empty-sync'),
    recapSection: document.getElementById('addon-recap-section'),
    recapTitle: document.getElementById('addon-recap-title'),
    recapMeta: document.getElementById('addon-recap-meta'),
    recapGrid: document.getElementById('addon-recap-grid'),
    batchSection: document.getElementById('addon-batch-section'),
    batchTitle: document.getElementById('addon-batch-title'),
    batchMeta: document.getElementById('addon-batch-meta'),
    batchGrid: document.getElementById('addon-batch-grid'),
    detailSection: document.getElementById('addon-detail-section'),
    detailTitle: document.getElementById('addon-detail-title'),
    detailSubtitle: document.getElementById('addon-detail-subtitle'),
    detailBack: document.getElementById('addon-detail-back'),
    groupList: document.getElementById('addon-group-list'),
    sidebarCount: document.getElementById('addon-sidebar-count'),
  };

  if (!els.section) return;

  const state = {
    loaded: false,
    loading: false,
    snapshot: null,
    query: '',
    item: '',
    status: 'all',
    sort: 'rtb-desc',
    groupLimit: GROUP_PAGE_SIZE,
    itemSignature: '',
    progress: null,
    progressPinned: false,
    progressHideTimer: null,
    pollTimer: null,
    searchTimer: null,
    requestSeq: 0,
    initialised: false,
    error: '',
  };

  /* ------------------------------------------------------------------------ */
  /* Utilitas                                                                 */
  /* ------------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('id-ID');
  }

  function formatRupiah(value) {
    return `Rp${formatNumber(value)}`;
  }

  function formatDateTime(value) {
    if (!value) return '';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return String(value);
    try {
      return new Intl.DateTimeFormat('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(parsed));
    } catch {
      return String(value);
    }
  }

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
  }

  function initials(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '?';
    return parts
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

  function statusChipClass(status) {
    switch (status) {
      case 'verified':
        return 'is-ok';
      case 'pending':
        return 'is-pending';
      case 'unpaid':
        return 'is-unpaid';
      default:
        return 'is-free';
    }
  }

  function paymentInfo(status) {
    const value = String(status || '').trim();
    const upper = value.toUpperCase();
    if (!value || value === '-' || upper === 'BELUM TERCATAT') {
      return { label: 'Pembayaran belum tercatat', tone: 'is-muted' };
    }
    if (/LUNAS|PAID|SELESAI|VERIFIED|SUCCESS|FULL/.test(upper)) {
      return { label: value, tone: 'is-ok' };
    }
    const percent = upper.match(/(\d{1,3})\s*%/);
    if (percent && Number(percent[1]) >= 100) {
      return { label: value, tone: 'is-ok' };
    }
    if (/BELUM|UNPAID|DP|CICIL|PARTIAL|TAGIH/.test(upper)) {
      return { label: value, tone: 'is-bad' };
    }
    return { label: value, tone: 'is-warn' };
  }

  function portalHref(group = {}) {
    const order = String(
      group.orderCode || group.portalOrder || group.orderShort || '',
    ).trim();
    if (!order) return '';
    return `/api/portal/login?order=${encodeURIComponent(order)}`;
  }

  function coverageNote(item = {}) {
    const qty = Number(item.qty || 0);
    const detailRows = Number(item.detailRows || 0);
    if (!qty || detailRows >= qty) return '';
    return `Rincian jamaah ${formatNumber(detailRows)} dari ${formatNumber(
      qty,
    )} qty — sisanya tidak tersedia di export SGO.`;
  }

  /* ------------------------------------------------------------------------ */
  /* Progress sinkronisasi                                                    */
  /* ------------------------------------------------------------------------ */

  function setSyncButton(active) {
    if (!els.syncBtn) return;
    els.syncBtn.disabled = Boolean(active);
    if (els.syncIcon) {
      els.syncIcon.classList.toggle('is-spinning', Boolean(active));
    }
    const label = els.syncBtn.querySelector('span');
    if (label) {
      label.textContent = active ? 'Menyinkronkan...' : 'Sinkronkan Add-on';
    }
  }

  function renderProgress() {
    if (!els.progress) return;
    const progress = state.progress;
    const active = Boolean(progress?.active);
    const failed =
      Boolean(progress) &&
      (progress.success === false || progress.phase === 'error');
    const visible = Boolean(progress) && (active || failed || state.progressPinned);

    els.progress.hidden = !visible;
    if (!visible) return;

    const percent = clampPercent(progress.percent);
    const isError = failed;
    els.progress.classList.toggle('is-error', isError);
    if (els.progressTitle) {
      els.progressTitle.textContent =
        progress.message ||
        (isError
          ? 'Sinkronisasi Add-on gagal.'
          : active
            ? 'Menyinkronkan Add-on...'
            : 'Sinkronisasi Add-on selesai.');
    }
    if (els.progressPercent) {
      els.progressPercent.textContent = `${Math.round(percent)}%`;
    }
    if (els.progressBar) els.progressBar.style.width = `${percent}%`;
    if (els.progressTrack) {
      els.progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
    }

    const detail = [];
    if (Number(progress.itemsTotal || 0) > 0) {
      detail.push(
        `Item ${formatNumber(progress.itemsDone)}/${formatNumber(
          progress.itemsTotal,
        )}`,
      );
    }
    if (Number(progress.batchesTotal || 0) > 0) {
      detail.push(
        `Batch ${formatNumber(progress.batchesDone)}/${formatNumber(
          progress.batchesTotal,
        )}`,
      );
    }
    if (Number(progress.rows || 0) > 0) {
      detail.push(`${formatNumber(progress.rows)} baris`);
    }
    if (progress.detail) detail.push(progress.detail);
    if (els.progressDetail) {
      els.progressDetail.textContent = detail.join(' • ');
    }

    renderSyncMeta();
  }

  function scheduleProgressHide() {
    if (state.progressHideTimer) {
      window.clearTimeout(state.progressHideTimer);
    }
    state.progressHideTimer = window.setTimeout(() => {
      state.progressHideTimer = null;
      if (!state.progress?.active) {
        state.progressPinned = false;
        renderProgress();
      }
    }, PROGRESS_HIDE_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollProgress() {
    try {
      const response = await fetch(PROGRESS_ENDPOINT, { cache: 'no-store' });
      const data = await response.json();
      if (!data.success || !data.progress) return;
      handleProgress(data.progress);
    } catch {
      /* polling berikutnya akan mencoba lagi */
    }
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = window.setInterval(pollProgress, POLL_MS);
    pollProgress();
  }

  function handleProgress(progress, { announce = false } = {}) {
    const wasActive = Boolean(state.progress?.active);
    const active = Boolean(progress?.active);
    state.progress = progress || null;

    setSyncButton(active);

    if (active) {
      state.progressPinned = false;
      if (state.progressHideTimer) {
        window.clearTimeout(state.progressHideTimer);
        state.progressHideTimer = null;
      }
      renderProgress();
      startPolling();
      return;
    }

    if (wasActive) {
      stopPolling();
      state.progressPinned = true;
      renderProgress();
      if (progress?.success) {
        if (typeof window.showToast === 'function') {
          window.showToast(
            'Success',
            progress.message || 'Sinkronisasi Add-on selesai.',
            'success',
          );
        }
        loadSnapshot({ silent: true });
        scheduleProgressHide();
      } else {
        if (typeof window.showToast === 'function') {
          window.showToast(
            'Error',
            progress?.error || progress?.message || 'Sinkronisasi Add-on gagal.',
            'error',
          );
        }
      }
      return;
    }

    if (progress && (progress.success === false || progress.phase === 'error')) {
      state.progressPinned = true;
      renderProgress();
      return;
    }

    if (announce && progress) {
      state.progressPinned = true;
      renderProgress();
      scheduleProgressHide();
      return;
    }

    renderProgress();
  }

  async function startSync() {
    if (state.progress?.active) {
      startPolling();
      return;
    }

    state.progressPinned = false;
    setSyncButton(true);
    renderProgress();

    try {
      const response = await fetch(REFRESH_ENDPOINT, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Gagal memulai sinkronisasi Add-on.');
      }

      if (data.progress) handleProgress(data.progress);
      startPolling();

      if (typeof window.showToast === 'function') {
        window.showToast(
          'Info',
          data.started
            ? 'Sinkronisasi Add-on dimulai. Progress berjalan real-time.'
            : data.busy
              ? 'Sinkronisasi Add-on sedang berjalan.'
              : 'Status sinkronisasi diperbarui.',
          'info',
        );
      }
    } catch (error) {
      setSyncButton(false);
      state.progressPinned = true;
      state.progress = {
        active: false,
        success: false,
        phase: 'error',
        percent: 100,
        message: error.message,
        error: error.message,
      };
      renderProgress();
      if (typeof window.showToast === 'function') {
        window.showToast('Error', error.message, 'error');
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Fetch snapshot                                                           */
  /* ------------------------------------------------------------------------ */

  function showError(message) {
    state.error = message;
    if (els.errorText) els.errorText.textContent = message;
    if (els.error) els.error.hidden = false;
    if (els.loading) els.loading.hidden = true;
    if (els.empty) els.empty.hidden = true;
    if (els.recapSection) els.recapSection.hidden = true;
    if (els.batchSection) els.batchSection.hidden = true;
    if (els.detailSection) els.detailSection.hidden = true;
  }

  async function loadSnapshot({ silent = false } = {}) {
    const seq = (state.requestSeq += 1);
    state.loading = true;
    state.error = '';

    if (!silent && !state.loaded) {
      if (els.loading) els.loading.hidden = false;
      if (els.error) els.error.hidden = true;
      if (els.empty) els.empty.hidden = true;
    }

    const params = new URLSearchParams();
    const query = state.query.trim();
    if (query) params.set('q', query);
    if (state.item) params.set('item', state.item);

    try {
      const response = await fetch(
        `${ENDPOINT}${params.toString() ? `?${params.toString()}` : ''}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (seq !== state.requestSeq) return;
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Gagal memuat data Add-on Per Batch.');
      }

      state.snapshot = data;
      state.loaded = true;
      state.loading = false;
      state.groupLimit = GROUP_PAGE_SIZE;
      if (els.loading) els.loading.hidden = true;
      if (els.error) els.error.hidden = true;

      if (data.progress) handleProgress(data.progress, { announce: false });
      else setSyncButton(Boolean(data.syncing));

      render();

      if (data.syncing) startPolling();
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.loading = false;
      showError(error.message || 'Gagal memuat data Add-on Per Batch.');
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Render: sumber, peringatan, statistik                                    */
  /* ------------------------------------------------------------------------ */

  function renderSource() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    let tone = 'is-loading';
    let label = 'Memuat cache SQLite...';
    let title = '';

    if (snapshot.error) {
      tone = 'is-offline';
      label = 'Cache bermasalah';
      title = snapshot.error;
    } else if (!snapshot.lastSyncedAt) {
      tone = 'is-loading';
      label = 'Belum ada cache • sinkronisasi disiapkan';
      title = 'Data akan diambil dari SGO Admin.';
    } else if (snapshot.stale) {
      tone = 'is-stale';
      label = `Cache perlu sinkron • ${formatDateTime(snapshot.lastSyncedAt)}`;
      title = 'Klik Sinkronkan Add-on untuk memperbarui data dari SGO.';
    } else {
      tone = 'is-online';
      label = `Cache SQLite • ${formatDateTime(snapshot.lastSyncedAt)}`;
      title = 'Data Add-on tersimpan lokal dari SGO Admin.';
    }

    if (state.progress?.active) {
      tone = 'is-loading';
      label = 'Sinkronisasi berjalan • progress real-time';
    }

    if (els.sourceDot) els.sourceDot.className = `ad-dot ${tone}`;
    if (els.sourceLabel) els.sourceLabel.textContent = label;
    if (els.sourceChip) els.sourceChip.title = title;
  }

  function renderWarning() {
    if (!els.warning) return;
    const snapshot = state.snapshot;
    const message = snapshot?.error || snapshot?.warning || '';
    if (!message) {
      els.warning.hidden = true;
      els.warning.textContent = '';
      return;
    }

    els.warning.hidden = false;
    els.warning.classList.toggle('is-error', Boolean(snapshot?.error));
    els.warning.innerHTML = `
      <i data-lucide="${snapshot?.error ? 'triangle-alert' : 'info'}" class="h-3.5 w-3.5 flex-shrink-0"></i>
      <span>${escapeHtml(message)}</span>
    `;
  }

  function applyStat(element, value, subElement, subValue) {
    if (element) element.textContent = value;
    if (subElement) subElement.textContent = subValue;
  }

  function renderStats() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    if (snapshot.mode === 'batch' && snapshot.batch) {
      const batch = snapshot.batch;
      applyStat(
        els.statQty,
        formatNumber(batch.qty),
        els.statQtySub,
        `RTB ${batch.rtb} • ${formatNumber(snapshot.items?.length)} jenis add-on`,
      );
      applyStat(
        els.statPaid,
        formatNumber(batch.paid),
        els.statPaidSub,
        `${formatNumber(batch.free)} gratis • ${formatNumber(snapshot.totalMatched)} rincian`,
      );
      applyStat(
        els.statFree,
        formatNumber(batch.free),
        els.statFreeSub,
        'Add-on tanpa biaya',
      );
      applyStat(
        els.statRevenue,
        formatRupiah(batch.revenue),
        els.statRevenueSub,
        `${formatNumber(batch.orderCount)} order • ${formatNumber(
          batch.jamaahCount,
        )} jamaah`,
      );
      return;
    }

    const summary = snapshot.summary || {};
    const totalQty = Number(summary.totalQty || 0);
    const totalPaid = Number(summary.totalPaid || 0);
    const totalFree = Number(summary.totalFree || 0);
    const paidPercent = totalQty
      ? Math.round((totalPaid / totalQty) * 100)
      : 0;

    applyStat(
      els.statQty,
      formatNumber(totalQty),
      els.statQtySub,
      `${formatNumber(summary.totalRows || 0)} rincian • ${formatNumber(
        summary.totalBatches || 0,
      )} batch`,
    );
    applyStat(
      els.statPaid,
      formatNumber(totalPaid),
      els.statPaidSub,
      `${paidPercent}% dari qty • ${formatNumber(totalFree)} gratis`,
    );
    applyStat(
      els.statFree,
      formatNumber(totalFree),
      els.statFreeSub,
      `${formatNumber(summary.totalItems || 0)} jenis add-on`,
    );
    applyStat(
      els.statRevenue,
      formatRupiah(summary.totalRevenue || 0),
      els.statRevenueSub,
      `${formatNumber(summary.totalOrders || 0)} order • ${formatNumber(
        summary.totalRows || 0,
      )} baris`,
    );
  }

  function renderFilters() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    const items =
      Array.isArray(snapshot.allItems) && snapshot.allItems.length
        ? snapshot.allItems
        : Array.isArray(snapshot.items)
          ? snapshot.items
          : [];
    const signature = items.map((item) => item.item).join('\u0001');

    if (els.itemFilter && signature !== state.itemSignature) {
      state.itemSignature = signature;
      const options = [
        '<option value="">Semua jenis add-on</option>',
        ...items.map(
          (item) =>
            `<option value="${escapeAttr(item.item)}">${escapeHtml(
              item.item,
            )}</option>`,
        ),
      ];
      els.itemFilter.innerHTML = options.join('');
      els.itemFilter.disabled = !items.length;
    }

    if (els.itemFilter) {
      const available = !state.item || items.some((item) => item.item === state.item);
      if (!available) state.item = '';
      els.itemFilter.value = state.item;
    }
    if (els.statusFilter) els.statusFilter.value = state.status;
    if (els.sort) els.sort.value = state.sort;
    if (els.searchClear) {
      els.searchClear.hidden = !els.search.value.trim();
    }

    if (els.sidebarCount) {
      const total = Number(snapshot.summary?.totalItems || items.length || 0);
      els.sidebarCount.textContent = total ? formatNumber(total) : '—';
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Render: rekap jenis add-on                                               */
  /* ------------------------------------------------------------------------ */

  function recapCard(item, { interactive = true, active = false } = {}) {
    const note = coverageNote(item);
    const inner = `
      <div class="ad-recap-card__top">
        <span class="ad-recap-card__name">${escapeHtml(item.item || 'Add-on')}</span>
        <span class="ad-recap-card__qty">${formatNumber(item.qty)}</span>
      </div>
      <span class="ad-recap-card__category">${escapeHtml(
        item.category || 'Tanpa kategori',
      )}</span>
      <div class="ad-recap-card__foot">
        <span>${formatNumber(item.paid)} bayar • ${formatNumber(
          item.free,
        )} gratis</span>
        <span class="ad-recap-card__revenue">${escapeHtml(
          formatRupiah(item.revenue),
        )}</span>
      </div>
      ${note ? `<span class="ad-recap-card__coverage">${escapeHtml(note)}</span>` : ''}
    `;

    if (!interactive) {
      return `<div class="ad-recap-card">${inner}</div>`;
    }

    return `
      <button type="button" class="ad-recap-card${active ? ' is-active' : ''}"
        data-addon-item="${escapeAttr(item.item || '')}"
        title="Tampilkan rincian jamaah untuk ${escapeAttr(item.item || 'add-on')}">
        ${inner}
      </button>
    `;
  }

  function renderRecap() {
    const snapshot = state.snapshot;
    if (!snapshot || !els.recapSection) return;

    const mode = snapshot.mode;
    const items =
      mode === 'batch'
        ? Array.isArray(snapshot.items)
          ? snapshot.items
          : []
        : Array.isArray(snapshot.allItems) && snapshot.allItems.length
          ? snapshot.allItems
          : Array.isArray(snapshot.items)
            ? snapshot.items
            : [];

    if (!items.length) {
      els.recapSection.hidden = true;
      return;
    }

    els.recapSection.hidden = false;
    if (els.recapTitle) {
      els.recapTitle.innerHTML =
        mode === 'batch'
          ? `Rekap add-on <span>RTB ${escapeHtml(snapshot.batch?.rtb || '')}</span>`
          : 'Rekap add-on <span>per jenis</span>';
    }
    if (els.recapMeta) {
      const qty = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
      const revenue = items.reduce(
        (sum, item) => sum + Number(item.revenue || 0),
        0,
      );
      els.recapMeta.textContent = `${formatNumber(
        items.length,
      )} jenis • ${formatNumber(qty)} qty • ${formatRupiah(revenue)}`;
    }

    const interactive = mode !== 'batch';
    els.recapGrid.innerHTML = items
      .map((item) =>
        recapCard(item, {
          interactive,
          active: state.item === item.item,
        }),
      )
      .join('');
  }

  /* ------------------------------------------------------------------------ */
  /* Render: daftar batch                                                     */
  /* ------------------------------------------------------------------------ */

  function sortBatches(batches = []) {
    const list = [...batches];
    switch (state.sort) {
      case 'revenue':
        return list.sort(
          (a, b) => Number(b.revenue || 0) - Number(a.revenue || 0),
        );
      case 'qty':
        return list.sort((a, b) => Number(b.qty || 0) - Number(a.qty || 0));
      case 'departure':
        return list.sort((a, b) => {
          const left = a.departureIso || '9999-99-99';
          const right = b.departureIso || '9999-99-99';
          return left.localeCompare(right);
        });
      default:
        return list.sort((a, b) => Number(b.rtb || 0) - Number(a.rtb || 0));
    }
  }

  function batchCard(batch) {
    const statusClass = ['akan', 'sedang', 'sudah'].includes(batch.status)
      ? `is-${batch.status}`
      : '';
    return `
      <button type="button" class="ad-batch-card" data-addon-rtb="${escapeAttr(
        batch.rtb,
      )}" title="Buka rincian RTB ${escapeAttr(batch.rtb)}">
        <div class="ad-batch-card__top">
          <span class="ad-batch-rtb">RTB ${escapeHtml(batch.rtb)}</span>
          <span class="ad-status-chip ${statusClass}">${escapeHtml(
            batch.statusLabel || 'Status belum tersedia',
          )}</span>
        </div>
        <p class="ad-batch-card__paket">${escapeHtml(
          batch.paket || 'Paket belum tercatat',
        )}</p>
        <div class="ad-batch-card__metrics">
          <span><i data-lucide="package" class="h-3 w-3"></i>${formatNumber(
            batch.qty,
          )} qty</span>
          <span><i data-lucide="badge-check" class="h-3 w-3"></i>${formatNumber(
            batch.paid,
          )} bayar</span>
          <span><i data-lucide="users" class="h-3 w-3"></i>${formatNumber(
            batch.jamaahCount,
          )} jamaah</span>
        </div>
        <div class="ad-batch-card__foot">
          <span class="ad-batch-card__revenue">${escapeHtml(
            formatRupiah(batch.revenue),
          )}</span>
          <span class="ad-batch-card__detail">
            ${escapeHtml(batch.departureLabel || 'Belum dijadwalkan')}
            <i data-lucide="chevron-right" class="h-3 w-3"></i>
          </span>
        </div>
      </button>
    `;
  }

  function renderBatches() {
    const snapshot = state.snapshot;
    if (!snapshot || !els.batchSection) return;

    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const mode = snapshot.mode;
    const batches = sortBatches(
      Array.isArray(snapshot.batches) ? snapshot.batches : [],
    );

    // Pencarian nama/order menampilkan grup jamaah lebih dulu. Daftar batch
    // hanya muncul jika memang tidak ada grup yang cocok.
    const shouldShow =
      mode === 'overview' ||
      mode === 'item' ||
      (mode === 'search' && !groups.length);

    if (!shouldShow || !batches.length) {
      els.batchSection.hidden = true;
      return;
    }

    els.batchSection.hidden = false;
    if (els.batchTitle) {
      els.batchTitle.innerHTML =
        mode === 'item'
          ? `Batch dengan add-on <span>${escapeHtml(state.item)}</span>`
          : mode === 'search'
            ? 'Batch yang <span>cocok</span>'
            : 'Daftar <span>batch RTB</span>';
    }
    if (els.batchMeta) {
      const sortLabel = {
        'rtb-desc': 'RTB tertinggi',
        revenue: 'pendapatan tertinggi',
        qty: 'qty terbesar',
        departure: 'keberangkatan terdekat',
      }[state.sort] || 'RTB tertinggi';
      els.batchMeta.textContent = `${formatNumber(
        batches.length,
      )} batch • urut ${sortLabel}`;
    }

    els.batchGrid.innerHTML = batches.map(batchCard).join('');
  }

  /* ------------------------------------------------------------------------ */
  /* Render: grup order & kartu jamaah                                        */
  /* ------------------------------------------------------------------------ */

  function filterGroupsByStatus(groups = []) {
    if (state.status === 'all') return groups;

    return groups
      .map((group) => {
        const jamaah = [];
        (group.jamaah || []).forEach((person) => {
          const addons = (person.addons || []).filter(
            (addon) => addon.status === state.status,
          );
          if (!addons.length) return;
          const total = addons.reduce(
            (sum, addon) => sum + Number(addon.price || 0),
            0,
          );
          jamaah.push({
            ...person,
            addons,
            totalPrice: total,
            totalPriceLabel: formatRupiah(total),
          });
        });

        if (!jamaah.length) return null;

        const addonCount = jamaah.reduce(
          (sum, person) => sum + person.addons.length,
          0,
        );
        const totalPrice = jamaah.reduce(
          (sum, person) => sum + Number(person.totalPrice || 0),
          0,
        );
        const count = (status) =>
          jamaah.reduce(
            (sum, person) =>
              sum +
              person.addons.filter((addon) => addon.status === status).length,
            0,
          );

        return {
          ...group,
          jamaah,
          jamaahCount: jamaah.length,
          addonCount,
          totalPrice,
          totalPriceLabel: formatRupiah(totalPrice),
          verifiedCount: count('verified'),
          pendingCount: count('pending'),
          freeCount: count('free'),
          unpaidCount: count('unpaid'),
        };
      })
      .filter(Boolean);
  }

  function sortGroups(groups = []) {
    const list = [...groups];
    if (state.sort === 'revenue') {
      return list.sort(
        (a, b) => Number(b.totalPrice || 0) - Number(a.totalPrice || 0),
      );
    }
    if (state.sort === 'qty') {
      return list.sort(
        (a, b) => Number(b.addonCount || 0) - Number(a.addonCount || 0),
      );
    }
    return list.sort((a, b) => {
      const left = String(a.pemesan || a.jamaah?.[0]?.name || '').toLowerCase();
      const right = String(b.pemesan || b.jamaah?.[0]?.name || '').toLowerCase();
      if (left && right && left !== right) return left.localeCompare(right);
      return String(a.orderDisplay || '').localeCompare(
        String(b.orderDisplay || ''),
      );
    });
  }

  function addonChip(addon) {
    return `
      <span class="ad-addon-chip ${statusChipClass(addon.status)}">
        <span class="ad-addon-chip__item">${escapeHtml(addon.item)}</span>
        ${
          Number(addon.price || 0) > 0
            ? `<span class="ad-addon-chip__price">${escapeHtml(
                addon.priceLabel || formatRupiah(addon.price),
              )}</span>`
            : ''
        }
        <span class="ad-addon-chip__status">${escapeHtml(
          addon.statusLabel || addon.status || 'Add-on',
        )}</span>
      </span>
    `;
  }

  function jamaahCard(person = {}) {
    const addons = Array.isArray(person.addons) ? person.addons : [];
    const total = Number(person.totalPrice || 0);
    return `
      <div class="ad-jamaah">
        <div class="ad-jamaah__head">
          <span class="ad-avatar" aria-hidden="true">${escapeHtml(
            initials(person.name),
          )}</span>
          <div class="ad-jamaah__identity">
            <p class="ad-jamaah__name">${escapeHtml(person.name || 'Jamaah')}</p>
            <p class="ad-jamaah__meta">${formatNumber(
              addons.length,
            )} add-on</p>
          </div>
          <span class="ad-jamaah__total">${escapeHtml(
            formatRupiah(total),
          )}</span>
        </div>
        <div class="ad-addon-chips">
          ${addons.map(addonChip).join('')}
        </div>
      </div>
    `;
  }

  function groupCard(group = {}) {
    const pay = paymentInfo(group.paymentStatus);
    const portal = portalHref(group);
    const orderDisplay =
      group.orderDisplay ||
      (group.orderShort
        ? `#${group.orderShort}`
        : group.orderCode || '');
    const jamaah = Array.isArray(group.jamaah) ? group.jamaah : [];
    const portalMarkup = portal
      ? `<a class="ad-portal-btn" href="${escapeAttr(
          portal,
        )}" target="_blank" rel="noopener noreferrer" title="Buka portal jamaah">
          <i data-lucide="external-link" class="h-3 w-3"></i>
          Login Portal
        </a>`
      : `<span class="ad-portal-btn is-disabled" title="Kode order belum tersedia untuk grup ini">
          <i data-lucide="external-link" class="h-3 w-3"></i>
          Login Portal
        </span>`;

    return `
      <article class="ad-group">
        <div class="ad-group__head">
          <div class="ad-order-block">
            <span class="ad-order-label">Kode order</span>
            <div class="ad-order-row">
              <span class="ad-order-code${
                group.orderCode ? '' : ' is-short'
              }">${escapeHtml(orderDisplay || 'Tanpa kode order')}</span>
              <span class="ad-pay-chip ${pay.tone}">${escapeHtml(
                pay.label,
              )}</span>
            </div>
            <p class="ad-pemesan">
              <i data-lucide="user-round" class="h-3 w-3"></i>
              <span>${escapeHtml(
                group.pemesan || 'Pemesan belum tercatat',
              )}</span>
            </p>
            <p class="ad-package-line">
              RTB ${escapeHtml(group.rtb || '—')}
              ${group.packageName ? ` • ${escapeHtml(group.packageName)}` : ''}
              ${
                group.departureLabel
                  ? ` • ${escapeHtml(group.departureLabel)}`
                  : ''
              }
            </p>
          </div>
          <div class="ad-group__actions">
            <span class="ad-group__summary">
              ${formatNumber(group.jamaahCount || jamaah.length)} jamaah •
              ${formatNumber(group.addonCount || 0)} add-on •
              <strong>${escapeHtml(
                group.totalPriceLabel || formatRupiah(group.totalPrice),
              )}</strong>
            </span>
            ${portalMarkup}
          </div>
        </div>
        <div class="ad-jamaah-list">
          ${jamaah.length ? jamaah.map(jamaahCard).join('') : ''}
        </div>
      </article>
    `;
  }

  function renderDetail() {
    const snapshot = state.snapshot;
    if (!snapshot || !els.detailSection) return;

    const mode = snapshot.mode;
    const allGroups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const visible = sortGroups(filterGroupsByStatus(allGroups));

    if (mode === 'overview') {
      els.detailSection.hidden = true;
      return;
    }

    if (mode === 'search' && !allGroups.length) {
      // Hasil batch yang cocok tetap ditampilkan di daftar batch; jangan
      // menampilkan panel rincian kosong yang menduplikasi pesan empty state.
      els.detailSection.hidden = true;
      return;
    }

    els.detailSection.hidden = false;

    if (els.detailTitle) {
      if (mode === 'batch' && snapshot.batch) {
        els.detailTitle.textContent = `Rincian jamaah RTB ${snapshot.batch.rtb}`;
      } else if (mode === 'search') {
        els.detailTitle.textContent = `Hasil pencarian “${snapshot.query}”`;
      } else if (mode === 'item') {
        els.detailTitle.textContent = `Add-on ${state.item}`;
      } else {
        els.detailTitle.textContent = 'Rincian add-on';
      }
    }

    if (els.detailSubtitle) {
      if (mode === 'batch' && snapshot.batch) {
        const batch = snapshot.batch;
        els.detailSubtitle.textContent = [
          batch.paket || 'Paket belum tercatat',
          batch.departureLabel || 'Belum dijadwalkan',
          `${formatNumber(allGroups.length)} order`,
          `${formatNumber(snapshot.totalMatched)} baris add-on`,
        ].join(' • ');
      } else if (mode === 'search') {
        els.detailSubtitle.textContent = `${formatNumber(
          snapshot.totalMatched,
        )} add-on cocok • ${formatNumber(
          allGroups.length,
        )} order • ${formatNumber(snapshot.returned)} rincian dimuat`;
      } else if (mode === 'item') {
        els.detailSubtitle.textContent = `${formatNumber(
          snapshot.totalMatched,
        )} add-on • ${formatNumber(
          snapshot.matchedBatchCount,
        )} batch • ${formatNumber(allGroups.length)} order`;
      } else {
        els.detailSubtitle.textContent = '';
      }
    }

    if (els.detailBack) {
      const label =
        mode === 'batch'
          ? 'Semua batch'
          : mode === 'item'
            ? 'Semua jenis'
            : 'Hapus pencarian';
      els.detailBack.innerHTML = `<i data-lucide="arrow-left" class="h-3 w-3"></i><span>${label}</span>`;
    }

    if (!visible.length) {
      const filterActive = state.status !== 'all';
      els.groupList.innerHTML = `
        <div class="ad-state">
          <i data-lucide="${filterActive ? 'filter-x' : 'inbox'}" class="ad-state__icon h-6 w-6"></i>
          <h4 class="ad-state__title">${
            filterActive
              ? 'Tidak ada add-on dengan status ini'
              : 'Rincian jamaah belum tersedia'
          }</h4>
          <p class="ad-state__text">${
            filterActive
              ? 'Ubah filter status atau reset untuk melihat seluruh add-on.'
              : 'SGO tidak menyertakan rincian jamaah untuk sebagian jenis add-on. Rekap qty dan pendapatan di atas tetap mengikuti data resmi SGO.'
          }</p>
        </div>
      `;
      return;
    }

    const shown = visible.slice(0, state.groupLimit);
    const remaining = visible.length - shown.length;
    els.groupList.innerHTML = `
      ${shown.map(groupCard).join('')}
      ${
        remaining > 0
          ? `<button type="button" class="ad-more-btn" data-addon-more>
              Tampilkan ${Math.min(
                GROUP_PAGE_SIZE,
                remaining,
              )} grup lagi • ${formatNumber(remaining)} tersisa
              <i data-lucide="chevron-down" class="h-3.5 w-3.5"></i>
            </button>`
          : ''
      }
    `;
  }

  /* ------------------------------------------------------------------------ */
  /* Render: result bar & state                                               */
  /* ------------------------------------------------------------------------ */

  function renderResultMeta() {
    const snapshot = state.snapshot;
    if (!snapshot || !els.resultMeta) return;
    const mode = snapshot.mode;
    let html = '';

    if (mode === 'batch' && snapshot.batch) {
      html = `<strong>RTB ${escapeHtml(snapshot.batch.rtb)}</strong> • ${formatNumber(
        snapshot.groups?.length,
      )} order • ${formatNumber(snapshot.totalMatched)} baris add-on`;
    } else if (mode === 'search') {
      html = `Pencarian <strong>“${escapeHtml(
        snapshot.query,
      )}”</strong> • ${formatNumber(snapshot.totalMatched)} add-on cocok`;
      if (snapshot.truncated) {
        html += ` • ${formatNumber(snapshot.returned)} rincian dimuat`;
      }
      if (snapshot.matchedBatchCount) {
        html += ` • ${formatNumber(snapshot.matchedBatchCount)} batch`;
      }
    } else if (mode === 'item') {
      html = `Jenis <strong>${escapeHtml(
        state.item,
      )}</strong> • ${formatNumber(snapshot.totalMatched)} add-on • ${formatNumber(
        snapshot.matchedBatchCount,
      )} batch`;
    } else {
      html = `<strong>${formatNumber(
        snapshot.batches?.length,
      )}</strong> batch • <strong>${formatNumber(
        snapshot.allItems?.length || snapshot.items?.length,
      )}</strong> jenis add-on`;
    }

    els.resultMeta.innerHTML = html;
  }

  function renderSyncMeta() {
    if (!els.syncMeta) return;
    const snapshot = state.snapshot;
    if (state.progress?.active) {
      els.syncMeta.textContent = 'Sinkronisasi SGO berjalan...';
      return;
    }
    if (!snapshot?.lastSyncedAt) {
      els.syncMeta.textContent = 'Belum pernah sinkron';
      return;
    }
    els.syncMeta.textContent = `Sinkron terakhir ${formatDateTime(
      snapshot.lastSyncedAt,
    )} • ${formatNumber(snapshot.summary?.totalRows)} rincian`;
  }

  function renderStates() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    const hasData =
      (Array.isArray(snapshot.batches) && snapshot.batches.length) ||
      (Array.isArray(snapshot.allItems) && snapshot.allItems.length);
    const noSearchResult =
      snapshot.mode === 'search' &&
      !(snapshot.groups || []).length &&
      !(snapshot.batches || []).length;

    if (els.loading) els.loading.hidden = true;
    if (els.error) els.error.hidden = true;

    if (!hasData && !snapshot.lastSyncedAt) {
      if (els.empty) {
        els.empty.hidden = false;
        if (els.emptyTitle) {
          els.emptyTitle.textContent = state.progress?.active
            ? 'Sinkronisasi Add-on sedang berjalan'
            : 'Belum ada data Add-on';
        }
        if (els.emptyText) {
          els.emptyText.textContent = state.progress?.active
            ? 'Data sedang diambil dari SGO. Progress akan tampil di atas.'
            : 'Klik Sinkronkan Add-on untuk menarik rekap add-on dari SGO Admin.';
        }
        if (els.emptySync) els.emptySync.hidden = Boolean(state.progress?.active);
      }
    } else if (els.empty) {
      els.empty.hidden = true;
    }

    if (noSearchResult && els.empty) {
      els.empty.hidden = false;
      if (els.emptyTitle) {
        els.emptyTitle.textContent = 'Tidak ada add-on yang cocok';
      }
      if (els.emptyText) {
        els.emptyText.textContent =
          'Coba nomor RTB, nama jamaah/pemesan, kode order, atau jenis add-on lain.';
      }
      if (els.emptySync) els.emptySync.hidden = true;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Render utama                                                             */
  /* ------------------------------------------------------------------------ */

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    renderSource();
    renderWarning();
    renderStats();
    renderFilters();
    renderResultMeta();
    renderSyncMeta();
    renderRecap();
    renderBatches();
    renderDetail();
    renderStates();
    renderProgress();
    setSyncButton(Boolean(state.progress?.active));

    if (window.lucide) window.lucide.createIcons();
  }

  /* ------------------------------------------------------------------------ */
  /* Event & pencarian                                                        */
  /* ------------------------------------------------------------------------ */

  function setSearchValue(value) {
    state.query = String(value || '').trim();
    if (els.search) els.search.value = state.query;
    if (els.searchClear) els.searchClear.hidden = !state.query;
  }

  function reload() {
    state.groupLimit = GROUP_PAGE_SIZE;
    loadSnapshot();
  }

  function scheduleSearch() {
    if (state.searchTimer) window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      state.searchTimer = null;
      state.query = String(els.search?.value || '').trim();
      if (els.searchClear) els.searchClear.hidden = !state.query;
      reload();
    }, SEARCH_DEBOUNCE_MS);
  }

  function resetFilters() {
    setSearchValue('');
    state.item = '';
    state.status = 'all';
    state.sort = 'rtb-desc';
    if (els.statusFilter) els.statusFilter.value = 'all';
    if (els.sort) els.sort.value = 'rtb-desc';
    reload();
  }

  function goBack() {
    const mode = state.snapshot?.mode;
    if (mode === 'batch') {
      setSearchValue('');
      reload();
      return;
    }
    if (mode === 'item') {
      state.item = '';
      reload();
      return;
    }
    setSearchValue('');
    state.item = '';
    reload();
  }

  function openRtb(rtb) {
    state.item = '';
    setSearchValue(`RTB ${rtb}`);
    reload();
  }

  function openItem(item) {
    if (!item) return;
    const next = state.item === item ? '' : item;
    state.item = next;
    if (next) setSearchValue('');
    reload();
  }

  function readInitialQuery() {
    if (window.location.pathname !== '/ops/add-on') return '';
    try {
      return String(new URLSearchParams(window.location.search).get('q') || '').trim();
    } catch {
      return '';
    }
  }

  function ensureLoaded() {
    if (state.initialised) {
      if (!state.loaded && !state.loading) loadSnapshot();
      return;
    }
    state.initialised = true;
    const initialQuery = readInitialQuery();
    if (initialQuery) {
      setSearchValue(initialQuery);
    } else if (els.search) {
      state.query = String(els.search.value || '').trim();
    }
    loadSnapshot();
  }

  function setupEvents() {
    if (els.syncBtn) {
      els.syncBtn.addEventListener('click', startSync);
    }
    if (els.retry) {
      els.retry.addEventListener('click', () => loadSnapshot());
    }
    if (els.emptySync) {
      els.emptySync.addEventListener('click', startSync);
    }
    if (els.reset) {
      els.reset.addEventListener('click', resetFilters);
    }
    if (els.detailBack) {
      els.detailBack.addEventListener('click', goBack);
    }

    if (els.search) {
      els.search.addEventListener('input', scheduleSearch);
      els.search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (state.searchTimer) {
            window.clearTimeout(state.searchTimer);
            state.searchTimer = null;
          }
          state.query = String(els.search.value || '').trim();
          reload();
        }
        if (event.key === 'Escape') {
          setSearchValue('');
          reload();
        }
      });
    }

    if (els.searchClear) {
      els.searchClear.addEventListener('click', () => {
        setSearchValue('');
        if (state.searchTimer) {
          window.clearTimeout(state.searchTimer);
          state.searchTimer = null;
        }
        reload();
        els.search?.focus();
      });
    }

    if (els.itemFilter) {
      els.itemFilter.addEventListener('change', () => {
        state.item = els.itemFilter.value;
        reload();
      });
    }

    if (els.statusFilter) {
      els.statusFilter.addEventListener('change', () => {
        state.status = els.statusFilter.value || 'all';
        state.groupLimit = GROUP_PAGE_SIZE;
        renderDetail();
        if (window.lucide) window.lucide.createIcons();
      });
    }

    if (els.sort) {
      els.sort.addEventListener('change', () => {
        state.sort = els.sort.value || 'rtb-desc';
        renderBatches();
        renderDetail();
        if (window.lucide) window.lucide.createIcons();
      });
    }

    if (els.recapGrid) {
      els.recapGrid.addEventListener('click', (event) => {
        const button = event.target.closest('[data-addon-item]');
        if (!button) return;
        openItem(button.dataset.addonItem || '');
      });
    }

    if (els.batchGrid) {
      els.batchGrid.addEventListener('click', (event) => {
        const button = event.target.closest('[data-addon-rtb]');
        if (!button) return;
        openRtb(button.dataset.addonRtb || '');
      });
    }

    if (els.groupList) {
      els.groupList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-addon-more]');
        if (!button) return;
        state.groupLimit += GROUP_PAGE_SIZE;
        renderDetail();
        if (window.lucide) window.lucide.createIcons();
      });
    }

    document.addEventListener('umrah:addon-refresh', () => {
      startSync();
    });

    document.addEventListener('umrah:view-change', (event) => {
      if (event.detail?.view === 'add-on') ensureLoaded();
    });

    document.addEventListener('umrah:module-change', (event) => {
      if (event.detail?.path === '/ops/add-on') ensureLoaded();
    });
  }

  setupEvents();

  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.activeView === 'add-on') {
      ensureLoaded();
      return;
    }
    window.setTimeout(() => {
      if (document.body.dataset.activeView === 'add-on') ensureLoaded();
    }, 120);
  });
})();
