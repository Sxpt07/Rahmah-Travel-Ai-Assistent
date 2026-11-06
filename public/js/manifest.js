/**
 * Modul frontend Upload Manifest & Cek Dokumen.
 *
 * Semua pencarian (nama, kode order, no HP) dan pembuatan draf WhatsApp
 * dilakukan di server. Modul ini hanya merender data aman yang dikirim API.
 */
(() => {
  const ENDPOINT = '/api/manifest/docs';
  const PAGE_SIZE = 10;

  const els = {
    total: document.getElementById('manifest-total'),
    complete: document.getElementById('manifest-complete'),
    incomplete: document.getElementById('manifest-incomplete'),
    orders: document.getElementById('manifest-orders'),
    search: document.getElementById('manifest-search'),
    filters: Array.from(
      document.querySelectorAll('[data-manifest-status]'),
    ),
    refresh: document.getElementById('manifest-refresh'),
    resultMeta: document.getElementById('manifest-result-meta'),
    pageMeta: document.getElementById('manifest-page-meta'),
    loading: document.getElementById('manifest-loading'),
    list: document.getElementById('manifest-list'),
    empty: document.getElementById('manifest-empty'),
    emptyTitle: document.getElementById('manifest-empty-title'),
    emptyText: document.getElementById('manifest-empty-text'),
    pagination: document.getElementById('manifest-pagination'),
    pageInfo: document.getElementById('manifest-page-info'),
    pageChip: document.getElementById('manifest-page-chip'),
    prev: document.getElementById('manifest-prev'),
    next: document.getElementById('manifest-next'),
    modal: document.getElementById('wa-modal'),
    modalRecipient: document.getElementById('wa-recipient'),
    draft: document.getElementById('wa-draft-text'),
    copy: document.getElementById('wa-copy-btn'),
    copyStatus: document.getElementById('wa-copy-status'),
    close: document.getElementById('wa-close-btn'),
    closeFooter: document.getElementById('wa-close-btn-footer'),
  };

  const state = {
    q: '',
    status: 'all',
    page: 1,
    limit: PAGE_SIZE,
    pages: 1,
    totalMatched: 0,
    loading: false,
    loaded: false,
    requestSeq: 0,
    draftText: '',
    lastFocus: null,
  };

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('id-ID');
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function toast(title, message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, type);
    }
  }

  function setText(element, value) {
    if (element) element.textContent = value;
  }

  function initials(name = '') {
    const parts = String(name)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    const letters = parts.map((part) => part.charAt(0)).join('');
    return (letters || 'J').toUpperCase();
  }

  function setLoading(show) {
    if (els.loading) els.loading.classList.toggle('hidden', !show);
    if (els.list && show) els.list.classList.add('hidden');
    if (els.empty && show) els.empty.classList.add('hidden');
    if (els.pagination && show) els.pagination.classList.add('hidden');
  }

  function setResultMeta(text) {
    setText(els.resultMeta, text);
  }

  function renderKpis(summary = {}) {
    setText(els.total, formatNumber(summary.totalJamaah));
    setText(els.complete, formatNumber(summary.complete));
    setText(els.incomplete, formatNumber(summary.incomplete));
    setText(els.orders, formatNumber(summary.totalOrders));
  }

  function renderPageMeta(data) {
    setText(
      els.pageMeta,
      data.totalMatched
        ? `Halaman ${data.page} dari ${data.pages}`
        : 'Tidak ada halaman',
    );
  }

  function docChip(documentItem = {}) {
    const stateName = ['complete', 'process', 'missing'].includes(
      documentItem.state,
    )
      ? documentItem.state
      : 'missing';
    const mark =
      stateName === 'complete' ? '✓' : stateName === 'missing' ? '×' : '•';

    return `
      <span class="doc-chip is-${stateName}" title="${esc(documentItem.label)}: ${esc(documentItem.stateLabel)}">
        <span class="doc-mark" aria-hidden="true">${mark}</span>
        <span>${esc(documentItem.label)}</span>
      </span>
    `;
  }

  function statusNote(row) {
    if (row.missing.length) {
      return {
        text: `× ${row.missing.length} dokumen belum lengkap`,
        className: 'is-missing',
      };
    }
    if (row.inProgress.length) {
      return {
        text: `• ${row.inProgress.length} dokumen dalam proses`,
        className: 'is-process',
      };
    }
    return { text: '✓ Semua dokumen lengkap', className: 'is-complete' };
  }

  function renderRow(row) {
    const totalDocs = Number(row.total || 0);
    const completedDocs = Number(row.completed || 0);
    const percent = totalDocs
      ? Math.min(100, Math.round((completedDocs / totalDocs) * 100))
      : 0;
    const progressClass = row.isComplete
      ? 'is-complete'
      : percent >= 50
        ? 'is-partial'
        : 'is-low';
    const note = statusNote(row);
    const paket = row.paket || 'Paket belum tercatat';
    const keberangkatan = row.keberangkatan || 'Belum terjadwal';

    return `
      <article class="manifest-row px-1 py-4 sm:px-2" data-manifest-row="${esc(row.id)}">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div class="min-w-0 flex-1">
            <div class="flex items-start gap-3">
              <div class="manifest-avatar flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-[10.5px] font-semibold">
                ${esc(initials(row.nama))}
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h3 class="truncate text-[13px] font-semibold text-white">${esc(row.nama)}</h3>
                  <span class="manifest-status ${row.isComplete ? 'is-complete' : 'is-incomplete'}">
                    ${row.isComplete ? '✓ Lengkap' : '× Belum lengkap'}
                  </span>
                </div>
                <p class="mt-1 text-[10.5px] tabular-nums text-slate-500">${esc(row.orderCode || 'Kode order belum tersedia')} <span class="text-slate-700">•</span> ${esc(paket)}</p>
                <p class="mt-0.5 text-[10px] text-slate-600">Keberangkatan: ${esc(keberangkatan)}</p>
                <div class="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  ${(row.documents || []).map(docChip).join('')}
                </div>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.04] pt-3 xl:flex-shrink-0 xl:border-0 xl:pt-0">
            <div class="min-w-[9rem]">
              <div class="flex items-center justify-between gap-2 text-[9.5px] text-slate-500">
                <span>Kelengkapan</span>
                <span class="tabular-nums">${esc(row.progressLabel)}</span>
              </div>
              <div class="manifest-progress-track mt-1.5 w-32">
                <div class="progress-fill ${progressClass}" style="width: ${percent}%"></div>
              </div>
              <p class="manifest-note mt-1.5 text-[9.5px] ${note.className}">${esc(note.text)}</p>
            </div>
            <button type="button" data-wa-id="${esc(row.id)}"
              aria-label="Generate pesan WhatsApp untuk ${esc(row.nama || 'jamaah')}"
              class="row-action ${row.isComplete ? '' : 'is-primary'}">
              <i data-lucide="message-circle" class="h-3.5 w-3.5"></i>
              <span>Draf WhatsApp</span>
            </button>
          </div>
        </div>
      </article>
    `;
  }

  function renderPagination(data) {
    if (!els.pagination) return;

    if (!data.totalMatched) {
      els.pagination.classList.add('hidden');
      return;
    }

    els.pagination.classList.remove('hidden');
    const start = (data.page - 1) * data.limit + 1;
    const end = Math.min(data.page * data.limit, data.totalMatched);

    setText(
      els.pageInfo,
      `Menampilkan ${formatNumber(start)}–${formatNumber(end)} dari ${formatNumber(data.totalMatched)} jamaah`,
    );
    setText(els.pageChip, `${data.page} / ${data.pages}`);

    if (els.prev) els.prev.disabled = data.page <= 1;
    if (els.next) els.next.disabled = data.page >= data.pages;
  }

  function showEmpty(title, text) {
    if (els.list) {
      els.list.innerHTML = '';
      els.list.classList.add('hidden');
    }
    if (els.empty) {
      els.empty.classList.remove('hidden');
      setText(els.emptyTitle, title);
      setText(els.emptyText, text);
    }
    if (els.pagination) els.pagination.classList.add('hidden');
  }

  function render(data) {
    state.page = Number(data.page || 1);
    state.pages = Number(data.pages || 1);
    state.totalMatched = Number(data.totalMatched || 0);
    state.loaded = true;

    renderKpis(data.summary || {});

    if (state.q) {
      setResultMeta(
        `Ditemukan ${formatNumber(data.totalMatched)} jamaah untuk pencarian Anda`,
      );
    } else {
      setResultMeta(
        `${formatNumber(data.totalAll)} jamaah • ${formatNumber(data.summary?.incomplete)} perlu dilengkapi`,
      );
    }

    renderPageMeta(data);
    setLoading(false);

    if (!data.items?.length) {
      showEmpty(
        'Tidak ada data yang cocok',
        'Coba kata kunci nama, kode order, atau nomor HP lain.',
      );
      renderPagination({ ...data, totalMatched: 0 });
      refreshIcons();
      return;
    }

    if (els.empty) els.empty.classList.add('hidden');
    if (els.list) {
      els.list.classList.remove('hidden');
      els.list.innerHTML = data.items.map(renderRow).join('');
    }

    renderPagination(data);
    refreshIcons();
  }

  async function loadPage(page = state.page) {
    const requestId = ++state.requestSeq;
    state.loading = true;

    if (els.refresh) {
      els.refresh.disabled = true;
      els.refresh.setAttribute('aria-busy', 'true');
    }
    setLoading(true);
    setResultMeta('Memuat data manifest...');

    const params = new URLSearchParams({
      q: state.q,
      status: state.status,
      page: String(page),
      limit: String(state.limit),
    });

    try {
      const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();

      if (requestId !== state.requestSeq) return;

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Data manifest gagal dimuat.');
      }

      render(data);
    } catch (error) {
      if (requestId !== state.requestSeq) return;
      state.loaded = false;
      setLoading(false);
      setResultMeta(error.message);
      showEmpty('Gagal memuat data', error.message);
      if (els.pagination) els.pagination.classList.add('hidden');
      toast('Error', error.message, 'error');
    } finally {
      if (requestId === state.requestSeq) {
        state.loading = false;
        if (els.refresh) {
          els.refresh.disabled = false;
          els.refresh.removeAttribute('aria-busy');
        }
      }
    }
  }

  function onShow() {
    if (!state.loaded) loadPage(state.page || 1);
  }

  let searchTimer = null;
  function queueSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = els.search ? els.search.value.trim() : '';
      state.page = 1;
      loadPage(1);
    }, 320);
  }

  function syncFilterButtons() {
    els.filters.forEach((button) => {
      const isActive = button.dataset.manifestStatus === state.status;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function setStatusFilter(status) {
    state.status = ['all', 'complete', 'incomplete'].includes(status)
      ? status
      : 'all';
    state.page = 1;
    state.loaded = false;

    syncFilterButtons();

    loadPage(1);
  }

  /**
   * Buka tab manifest dengan pencarian kode order yang sudah terisi.
   * Dipakai oleh tombol "Kelola Dokumen" pada hasil chat AI.
   */
  function openOrder(orderCode) {
    const value = String(orderCode || '').trim();
    if (!value) {
      toast('Info', 'Kode order tidak tersedia untuk data ini.', 'warning');
      return Promise.resolve();
    }

    clearTimeout(searchTimer);
    state.q = value;
    state.status = 'all';
    state.page = 1;
    // Cegah onShow() memuat dua kali saat view-change dipancarkan.
    state.loaded = true;

    if (els.search) els.search.value = value;
    syncFilterButtons();

    if (window.TabController?.show) {
      window.TabController.show('/ops/upload-documents');
    }

    const view = document.getElementById('view-manifest');
    if (view) view.scrollTop = 0;

    return loadPage(1).then(() => {
      if (view) {
        view.scrollTo({ top: 0, behavior: 'smooth' });
      }

      if (els.search) {
        els.search.classList.remove('is-target');
        void els.search.offsetWidth;
        els.search.classList.add('is-target');
        window.setTimeout(() => {
          els.search?.classList.remove('is-target');
        }, 1900);

        try {
          els.search.focus({ preventScroll: true });
        } catch (error) {
          els.search.focus();
        }
      }

      if (els.list) {
        els.list.classList.remove('results-enter');
        void els.list.offsetWidth;
        els.list.classList.add('results-enter');
      }
    });
  }

  function openModal() {
    if (!els.modal) return;
    state.lastFocus = document.activeElement;
    els.modal.hidden = false;
    els.modal.classList.add('flex');
    els.modal.setAttribute('aria-hidden', 'false');
    document.body.dataset.modalOpen = 'true';
    if (els.close) els.close.focus();
    refreshIcons();
  }

  function closeModal() {
    if (!els.modal) return;
    els.modal.hidden = true;
    els.modal.classList.remove('flex');
    els.modal.setAttribute('aria-hidden', 'true');
    delete document.body.dataset.modalOpen;
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus();
    }
    state.lastFocus = null;
  }

  async function openDraftFor(id, trigger) {
    if (!id) return;
    state.lastFocus = trigger || document.activeElement;
    state.draftText = '';

    openModal();
    if (els.modalRecipient) els.modalRecipient.textContent = 'Memuat data jamaah...';
    if (els.draft) els.draft.value = 'Menyiapkan draf pesan WhatsApp...';
    if (els.copy) els.copy.disabled = true;
    if (els.copyStatus) {
      els.copyStatus.textContent = 'Menyiapkan draf...';
      els.copyStatus.className = 'text-[10px] text-slate-500';
    }

    try {
      const response = await fetch(
        `${ENDPOINT}/${encodeURIComponent(id)}/whatsapp`,
        {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        },
      );
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Draf WhatsApp gagal dibuat.');
      }

      state.draftText = data.draft || '';
      if (els.draft) els.draft.value = state.draftText;
      if (els.modalRecipient) {
        els.modalRecipient.textContent = `${data.recipient?.nama || ''} • ${data.recipient?.orderCode || ''}`;
      }
      if (els.copy) els.copy.disabled = !state.draftText;

      if (els.copyStatus) {
        const missingCount = Array.isArray(data.missing)
          ? data.missing.length
          : 0;
        const progressCount = Array.isArray(data.inProgress)
          ? data.inProgress.length
          : 0;
        els.copyStatus.textContent = missingCount
          ? `${missingCount} dokumen perlu dilengkapi`
          : progressCount
            ? `${progressCount} dokumen dalam proses`
            : 'Semua dokumen lengkap';
        els.copyStatus.className = missingCount
          ? 'text-[10px] text-red-300'
          : progressCount
            ? 'text-[10px] text-amber-300'
            : 'text-[10px] text-emerald-300';
      }
    } catch (error) {
      if (els.draft) els.draft.value = error.message;
      if (els.copy) els.copy.disabled = true;
      if (els.copyStatus) {
        els.copyStatus.textContent = 'Gagal membuat draf';
        els.copyStatus.className = 'text-[10px] text-red-300';
      }
      toast('Error', error.message, 'error');
    }
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Lanjut ke fallback execCommand bila izin clipboard ditolak.
      }
    }

    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();

    if (!copied) throw new Error('Clipboard tidak tersedia.');
  }

  async function copyDraft() {
    if (!state.draftText || !els.copy) return;

    try {
      await copyText(state.draftText);

      els.copy.innerHTML =
        '<i data-lucide="check" class="h-3.5 w-3.5"></i><span>Tersalin</span>';
      refreshIcons();
      if (els.copyStatus) {
        els.copyStatus.textContent = 'Teks berhasil disalin ke clipboard';
        els.copyStatus.className = 'text-[10px] text-emerald-300';
      }
      toast('Success', 'Teks WhatsApp berhasil disalin.', 'success');

      setTimeout(() => {
        els.copy.innerHTML =
          '<i data-lucide="copy" class="h-3.5 w-3.5"></i><span>Copy Text</span>';
        refreshIcons();
      }, 1800);
    } catch (error) {
      if (els.copyStatus) {
        els.copyStatus.textContent = 'Gagal menyalin teks';
        els.copyStatus.className = 'text-[10px] text-red-300';
      }
      toast('Error', 'Gagal menyalin teks. Silakan salin manual.', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (els.search) {
      els.search.addEventListener('input', queueSearch);
      els.search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          clearTimeout(searchTimer);
          state.q = els.search.value.trim();
          state.page = 1;
          loadPage(1);
        }
      });
    }

    els.filters.forEach((button) => {
      button.addEventListener('click', () => {
        setStatusFilter(button.dataset.manifestStatus);
      });
    });

    if (els.refresh) {
      els.refresh.addEventListener('click', () => {
        state.loaded = false;
        loadPage(state.page || 1);
      });
    }

    if (els.prev) {
      els.prev.addEventListener('click', () => {
        if (state.page > 1) loadPage(state.page - 1);
      });
    }

    if (els.next) {
      els.next.addEventListener('click', () => {
        if (state.page < state.pages) loadPage(state.page + 1);
      });
    }

    if (els.list) {
      els.list.addEventListener('click', (event) => {
        const button = event.target.closest('[data-wa-id]');
        if (button) openDraftFor(button.dataset.waId, button);
      });
    }

    // Tombol "Kelola Dokumen" pada kartu hasil pencarian di chat AI.
    document.addEventListener('click', (event) => {
      const manageBtn = event.target.closest('[data-manage-order]');
      if (!manageBtn || manageBtn.disabled) return;

      event.preventDefault();
      manageBtn.disabled = true;
      openOrder(manageBtn.dataset.manageOrder).finally(() => {
        manageBtn.disabled = false;
      });
    });

    if (els.copy) els.copy.addEventListener('click', copyDraft);
    if (els.close) els.close.addEventListener('click', closeModal);
    if (els.closeFooter) els.closeFooter.addEventListener('click', closeModal);
    if (els.modal) {
      els.modal.addEventListener('click', (event) => {
        if (event.target === els.modal) closeModal();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.modal && !els.modal.hidden) {
        closeModal();
      }
    });

    document.addEventListener('umrah:view-change', (event) => {
      if (event.detail?.view === 'manifest') onShow();
    });

    document.addEventListener('umrah:data-updated', () => {
      state.loaded = false;
      if (document.getElementById('view-manifest')?.hidden === false) {
        loadPage(1);
      }
    });

    if (document.getElementById('view-manifest')?.hidden === false) {
      loadPage(1);
    }
  });

  window.ManifestModule = {
    refresh: () => {
      state.loaded = false;
      return loadPage(state.page || 1);
    },
    openOrder,
    onShow,
    state,
  };
})();
