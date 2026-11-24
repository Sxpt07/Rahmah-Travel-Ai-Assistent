/**
 * Modul frontend Upload Manifest & Cek Dokumen.
 *
 * Filter bulan/status, pencarian, dan pagination dilakukan di server melalui
 * cache SQLite manifest. Modul ini merender satu kartu FU dokumen per kode
 * order agar order dengan banyak jamaah tidak tampil berulang; setiap jamaah
 * tetap memiliki detail dokumen dan aksinya sendiri: copy nomor, copy teks
 * WhatsApp, serta kelola dokumen di SGO. Header order juga menyediakan
 * “Copy FU Keluarga” untuk menyalin satu pesan bagi seluruh jamaah order.
 */
(() => {
  const ENDPOINT = '/api/manifest/docs';
  const LIVE_ENDPOINT = '/api/manifest/docs/live';
  const PAGE_SIZE = 24;
  const LIVE_REFRESH_MS = 1800;
  const MONTH_NAMES = [
    'januari',
    'februari',
    'maret',
    'april',
    'mei',
    'juni',
    'juli',
    'agustus',
    'september',
    'oktober',
    'november',
    'desember',
    'jan',
    'feb',
    'mar',
    'apr',
    'jun',
    'jul',
    'agu',
    'agt',
    'aug',
    'sep',
    'sept',
    'okt',
    'oct',
    'nov',
    'des',
    'dec',
  ];

  const els = {
    total: document.getElementById('manifest-total'),
    complete: document.getElementById('manifest-complete'),
    incomplete: document.getElementById('manifest-incomplete'),
    orders: document.getElementById('manifest-orders'),
    search: document.getElementById('manifest-search'),
    month: document.getElementById('manifest-month'),
    filters: Array.from(
      document.querySelectorAll('[data-manifest-status]'),
    ),
    refresh: document.getElementById('manifest-refresh'),
    progress: document.getElementById('manifest-sync-progress'),
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
  };

  const state = {
    q: '',
    month: '',
    status: 'all',
    page: 1,
    limit: PAGE_SIZE,
    pages: 1,
    totalMatched: 0,
    totalGroups: 0,
    pageJamaahCount: 0,
    groups: [],
    rowsById: new Map(),
    loading: false,
    loaded: false,
    requestSeq: 0,
    selectedMonth: null,
    summary: null,
    monthOptionsSignature: '',
    liveLastAt: 0,
    liveInFlight: false,
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

  function renderMonthOptions(options = []) {
    if (!els.month || !Array.isArray(options) || !options.length) return;

    const signature = JSON.stringify(
      options.map((option) => [
        option.value,
        option.label,
        option.total,
        option.incomplete,
      ]),
    );
    if (signature === state.monthOptionsSignature) return;
    state.monthOptionsSignature = signature;

    els.month.innerHTML = options
      .map((option) => {
        const label =
          option.value === 'all'
            ? `${option.label} (${formatNumber(option.total)})`
            : `${option.label} (${formatNumber(option.total)})`;
        return `<option value="${esc(option.value)}">${esc(label)}</option>`;
      })
      .join('');

    const hasSelection = options.some(
      (option) => option.value === (state.month || ''),
    );
    if (!hasSelection) state.month = '';
    els.month.value = state.month || '';
  }

  function isMonthQuery(value = '') {
    const text = String(value).trim().toLowerCase();
    if (!text) return false;
    if (/^\d{4}-\d{1,2}$/.test(text)) return true;
    const parts = text.split(/\s+/);
    if (parts.length > 2) return false;
    return MONTH_NAMES.includes(parts[0]);
  }

  function docChip(documentItem = {}) {
    const stateName = ['complete', 'process', 'missing'].includes(
      documentItem.state,
    )
      ? documentItem.state
      : 'missing';
    const mark =
      stateName === 'complete' ? '✓' : stateName === 'missing' ? '×' : '•';
    const label = documentItem.label || 'Dokumen';
    const stateLabel =
      documentItem.stateLabel ||
      (stateName === 'complete'
        ? 'Lengkap'
        : stateName === 'process'
          ? 'Menunggu approval'
          : 'Belum ada');
    const docKey = documentItem.key || label;

    return `
      <span class="doc-chip is-${stateName}" data-doc-key="${esc(docKey)}" data-doc-state="${stateName}"
        title="${esc(label)}: ${esc(stateLabel)}"
        aria-label="${esc(label)}: ${esc(stateLabel)}">
        <span class="doc-mark" aria-hidden="true">${mark}</span>
        <span>${esc(label)}</span>
      </span>
    `;
  }

  /**
   * Signature kecil untuk menentukan apakah satu kartu perlu diganti saat
   * polling live. Perubahan dokumen, RTB, atau keberangkatan memicu render
   * ulang kartu di posisi yang sama tanpa mengacak seluruh grid.
   */
  function rowLiveSignature(row = {}) {
    return JSON.stringify({
      docs: (row.documents || []).map((doc) => [
        doc.key || '',
        doc.state || '',
      ]),
      completed: Number(row.completed || 0),
      total: Number(row.total || 0),
      complete: Boolean(row.isComplete),
      progress: row.progressLabel || '',
      rtb: row.rtb || '',
      departure: row.departureIso || row.departureLabel || '',
    });
  }

  function captureVisibleDocStates() {
    const snapshot = new Map();
    document
      .querySelectorAll('#manifest-list [data-manifest-row]')
      .forEach((card) => {
        const states = {};
        card.querySelectorAll('.doc-chip[data-doc-key]').forEach((chip) => {
          states[chip.dataset.docKey] = chip.dataset.docState;
        });
        snapshot.set(card.dataset.manifestRow, states);
      });
    return snapshot;
  }

  function markChangedChips(card, previousStates = {}) {
    if (!card) return;
    card.querySelectorAll('.doc-chip[data-doc-key]').forEach((chip) => {
      const key = chip.dataset.docKey;
      const before = previousStates[key];
      const after = chip.dataset.docState;
      if (!before || before === after) return;

      if (after === 'complete' || after === 'process') {
        chip.classList.add('is-just-filled');
      } else if (after === 'missing') {
        chip.classList.add('is-just-missing');
      }
    });
  }

  function flashChangedDocStates(previous = new Map()) {
    if (!(previous instanceof Map) || !previous.size) return;
    document
      .querySelectorAll('#manifest-list [data-manifest-row]')
      .forEach((card) => {
        const before = previous.get(card.dataset.manifestRow);
        if (before) markChangedChips(card, before);
      });
  }

  function visibleCardIds() {
    return Array.from(
      document.querySelectorAll('#manifest-list [data-manifest-row]'),
    )
      .map((card) => String(card.dataset.manifestRow || '').trim())
      .filter(Boolean)
      .slice(0, 800);
  }

  /**
   * Hitung ulang ringkasan kartu order setelah satu jamaah berubah karena
   * polling live, tanpa merender ulang seluruh grup.
   */
  function refreshOrderSummary(groupElement, key) {
    const group = state.groups.find((item) => item.key === key);
    if (!group) return;

    group.rows = (group.rows || []).map(
      (row) => state.rowsById.get(String(row.id || '').trim()) || row,
    );
    Object.assign(group, aggregateRows(group.rows));

    groupElement.classList.toggle('is-complete', group.isComplete);
    groupElement.classList.toggle('is-incomplete', !group.isComplete);

    const fill = groupElement.querySelector('[data-order-progress-fill]');
    if (fill) {
      fill.style.width = `${group.percent}%`;
      fill.classList.toggle('is-complete', group.isComplete);
      fill.classList.toggle(
        'is-partial',
        !group.isComplete && group.percent >= 50,
      );
    }

    const count = groupElement.querySelector('[data-order-docs-count]');
    if (count) {
      count.textContent = `${formatNumber(group.completedDocs)}/${formatNumber(group.totalDocs)} terisi`;
    }

    const countBadge = groupElement.querySelector('[data-order-count]');
    if (countBadge) {
      countBadge.textContent = `${formatNumber(group.jamaahCount)} jamaah`;
    }

    const statusBadge = groupElement.querySelector('[data-order-status]');
    if (statusBadge) {
      statusBadge.className = `manifest-badge ${group.isComplete ? 'is-complete' : 'is-incomplete'}`;
      statusBadge.textContent = group.isComplete
        ? '✓ Lengkap'
        : `× ${formatNumber(group.incompleteCount)} belum lengkap`;
    }

    const note = groupNote(group);
    const copy = groupElement.querySelector('[data-order-progress-copy]');
    if (copy) {
      copy.className = `manifest-progress-copy ${note.className}`;
      copy.innerHTML = `<strong>${esc(note.note)}</strong>`;
    }
  }

  function applyLiveRows(rows = []) {
    if (!Array.isArray(rows) || !rows.length || !els.list) return;

    const cards = new Map(
      Array.from(els.list.querySelectorAll('[data-manifest-row]')).map((card) => [
        card.dataset.manifestRow,
        card,
      ]),
    );

    const touchedGroups = new Map();
    let changed = 0;
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      const card = cards.get(id);
      if (!card) continue;

      const nextSignature = rowLiveSignature(row);
      if (card.dataset.liveSignature === nextSignature) continue;

      const previousStates = {};
      card.querySelectorAll('.doc-chip[data-doc-key]').forEach((chip) => {
        previousStates[chip.dataset.docKey] = chip.dataset.docState;
      });

      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderJamaah(row).trim();
      const nextCard = wrapper.firstElementChild;
      if (!nextCard) continue;

      const groupElement = card.closest('[data-manifest-order]');
      markChangedChips(nextCard, previousStates);
      card.replaceWith(nextCard);
      cards.set(id, nextCard);
      state.rowsById.set(id, row);
      if (groupElement) {
        touchedGroups.set(
          groupElement,
          groupElement.dataset.manifestOrder || '',
        );
      }
      changed += 1;
    }

    touchedGroups.forEach((key, element) => refreshOrderSummary(element, key));
    if (changed) refreshIcons();
  }

  async function refreshVisibleCards() {
    if (state.liveInFlight || document.visibilityState === 'hidden') return;
    const ids = visibleCardIds();
    if (!ids.length) return;

    state.liveInFlight = true;
    try {
      // Satu halaman sekarang berisi beberapa order (bisa ratusan jamaah),
      // jadi ID dikirim bertahap agar URL tetap pendek.
      for (let index = 0; index < ids.length; index += 150) {
        const chunk = ids.slice(index, index + 150);
        const response = await fetch(
          `${LIVE_ENDPOINT}?ids=${encodeURIComponent(chunk.join(','))}`,
          {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
          },
        );
        if (!response.ok) continue;
        const data = await response.json();
        if (data.success) applyLiveRows(data.items || []);
      }
    } catch (error) {
      // Polling berikutnya akan mencoba lagi; progress bar tetap berjalan.
    } finally {
      state.liveInFlight = false;
    }
  }

  function queueLiveRefresh(progress = {}) {
    if (!progress?.active) return;
    const view = document.getElementById('view-manifest');
    if (view && view.hidden) return;

    const now = Date.now();
    if (now - state.liveLastAt < LIVE_REFRESH_MS) return;
    state.liveLastAt = now;
    void refreshVisibleCards();
  }

  function statusNote(row) {
    const missingCount = Array.isArray(row.missing) ? row.missing.length : 0;
    const processCount = Array.isArray(row.inProgress)
      ? row.inProgress.length
      : 0;

    if (row.isComplete) {
      return {
        badge: '✓ Lengkap',
        note: processCount
          ? 'Semua dokumen terisi • sebagian menunggu approval'
          : 'Semua dokumen lengkap',
        className: 'is-complete',
      };
    }

    if (missingCount) {
      return {
        badge: `× ${missingCount} Missing`,
        note: `${missingCount} dokumen belum diunggah`,
        className: 'is-missing',
      };
    }
    if (processCount) {
      return {
        badge: `• ${processCount} Proses`,
        note: `${processCount} dokumen sedang diproses`,
        className: 'is-process',
      };
    }
    return {
      badge: '✓ Lengkap',
      note: 'Semua dokumen lengkap',
      className: 'is-complete',
    };
  }

  function phoneBlock(row) {
    const number = String(row.phoneDisplay || '').trim();
    const copyValue = number.replace(/\D/g, '');

    if (!number) {
      return `
        <div class="manifest-phone-copy is-empty" aria-label="Nomor telepon belum tersedia">
          <i data-lucide="phone-off"></i>
          <span class="manifest-phone-number">Nomor telepon belum tersedia</span>
        </div>
      `;
    }

    return `
      <div class="manifest-phone-copy">
        <i data-lucide="phone"></i>
        <span class="manifest-phone-number">${esc(number)}</span>
        <button type="button" class="manifest-phone-action"
          data-copy-phone="${esc(copyValue)}"
          aria-label="Copy nomor telepon ${esc(row.nama || 'jamaah')}">
          <i data-lucide="copy"></i>
          <span class="manifest-phone-label">Copy</span>
        </button>
      </div>
    `;
  }

  function manageAction(row) {
    const manageUrl = String(row.manageUrl || '').trim();
    if (!/^\/ops\/monitoring_jamaah\/\d+\/edit$/.test(manageUrl)) {
      return `
        <span class="manifest-action manifest-action--quiet opacity-45" aria-disabled="true">
          <i data-lucide="external-link"></i>
          <span>Kelola Dokumen</span>
        </span>
      `;
    }

    return `
      <a class="manifest-action manifest-action--quiet" href="${esc(manageUrl)}"
        target="_blank" rel="noopener noreferrer"
        aria-label="Kelola dokumen ${esc(row.nama || 'jamaah')} di SGO">
        <i data-lucide="external-link"></i>
        <span>Kelola Dokumen</span>
      </a>
    `;
  }

  function syncAction(row) {
    if (!row?.id) return '';
    return `
      <button type="button" class="manifest-action manifest-sync-action"
        data-sync-id="${esc(row.id)}"
        aria-label="Sinkronkan status dokumen ${esc(row.nama || 'jamaah')} dari SGO">
        <i data-lucide="refresh-cw"></i>
        <span>Sync</span>
      </button>
    `;
  }

  function aggregateRows(rows = []) {
    const completedDocs = rows.reduce(
      (sum, row) => sum + Number(row.completed || 0),
      0,
    );
    const totalDocs = rows.reduce(
      (sum, row) => sum + Number(row.total || 0),
      0,
    );
    const missingDocs = rows.reduce(
      (sum, row) => sum + (Array.isArray(row.missing) ? row.missing.length : 0),
      0,
    );
    const incompleteCount = rows.filter((row) => !row.isComplete).length;

    return {
      jamaahCount: rows.length,
      completeCount: rows.length - incompleteCount,
      incompleteCount,
      completedDocs,
      totalDocs,
      missingDocs,
      percent: totalDocs
        ? Math.min(100, Math.round((completedDocs / totalDocs) * 100))
        : 0,
      isComplete: incompleteCount === 0,
    };
  }

  function groupNote(group = {}) {
    const incomplete = Number(group.incompleteCount || 0);
    if (!incomplete) {
      return {
        note: 'Semua dokumen pada order ini lengkap',
        className: 'is-complete',
      };
    }
    return {
      note: `${incomplete} dari ${Number(group.jamaahCount || 0)} jamaah masih perlu melengkapi dokumen`,
      className: 'is-missing',
    };
  }

  /**
   * Susun satu pesan Follow-Up dokumen untuk seluruh jamaah dalam order.
   * Dokumen berstatus complete/process dianggap sudah terisi; hanya status
   * missing yang masuk daftar belum terisi.
   */
  function buildOrderFuMessage(group = {}) {
    const pemesan = String(group.pemesan || group.nama || '').trim();
    const orderCode = String(group.orderCode || '').trim();
    const departure =
      String(group.departureDisplay || '').trim() || 'yang akan datang';
    const lines = [
      pemesan
        ? `Assalamu'alaikum Bapak/Ibu *${pemesan}*,`
        : `Assalamu'alaikum Bapak/Ibu,`,
      `Berikut kami informasikan update kelengkapan dokumen untuk keberangkatan *${departure}*${orderCode ? ` (Kode Order: *${orderCode}*)` : ''}:`,
      '',
    ];

    (group.rows || []).forEach((row, index) => {
      const documents = Array.isArray(row.documents) ? row.documents : [];
      const filled = documents
        .filter((doc) => doc.state === 'complete' || doc.state === 'process')
        .map((doc) => String(doc.label || doc.key || '').trim())
        .filter(Boolean);
      const missing = documents
        .filter((doc) => doc.state === 'missing')
        .map((doc) => String(doc.label || doc.key || '').trim())
        .filter(Boolean);

      lines.push(
        `${index + 1}. *${String(row.nama || 'Jamaah').trim() || 'Jamaah'}*`,
      );

      if (!documents.length) {
        const total = Number(row.total || 0);
        const completed = Number(row.completed || 0);
        if (!row.isComplete && total > completed) {
          lines.push(
            `✅ Sudah terisi: ${completed}/${total} dokumen`,
          );
          lines.push(
            `❌ Belum terisi: ${Math.max(total - completed, 0)} dokumen`,
          );
        } else {
          lines.push('✅ Sudah lengkap semua');
        }
      } else if (!missing.length) {
        lines.push('✅ Sudah lengkap semua');
      } else {
        lines.push(
          `✅ Sudah terisi: ${filled.length ? filled.join(', ') : '-'}`,
        );
        lines.push(`❌ Belum terisi: ${missing.join(', ')}`);
      }

      lines.push('');
    });

    lines.push(
      'Mohon bantuannya untuk melengkapi dokumen yang masih kurang ya Bapak/Ibu. Terima kasih 🙏',
    );

    return lines.join('\n');
  }

  /**
   * Gabungkan baris jamaah per kode order di sisi klien. Dipakai sebagai
   * fallback bila respons API lama belum menyertakan `groups`.
   */
  function groupRows(rows = []) {
    const groups = [];
    const groupMap = new Map();

    rows.forEach((row) => {
      const orderCode = String(row.orderCode || '').trim().toUpperCase();
      const key = orderCode ? `order:${orderCode}` : `row:${row.id || groups.length}`;
      let group = groupMap.get(key);
      if (!group) {
        group = { key, orderCode, rows: [] };
        groupMap.set(key, group);
        groups.push(group);
      }
      group.rows.push(row);
    });

    groups.forEach((group) => {
      const first = group.rows[0] || {};
      Object.assign(group, {
        nama: first.nama || '',
        paket: first.paket || '',
        rtb: first.rtb || '',
        pemesan: first.pemesan || first.nama || '',
        departureDisplay: first.departureDisplay || 'Belum terjadwal',
        departureIso: first.departureIso || '',
        departureMonthLabel: first.departureMonthLabel || '',
        ...aggregateRows(group.rows),
      });
    });

    return groups;
  }

  function renderJamaah(row) {
    const totalDocs = Number(row.total || 0);
    const completedDocs = Number(row.completed || 0);
    const note = statusNote(row);
    const badgeClass = row.isComplete
      ? 'is-complete'
      : note.className === 'is-process'
        ? 'is-process'
        : 'is-incomplete';

    return `
      <div class="manifest-jamaah ${row.isComplete ? 'is-complete' : 'is-incomplete'}"
        data-manifest-row="${esc(row.id)}"
        data-live-signature="${esc(rowLiveSignature(row))}">
        <div class="manifest-jamaah__head">
          <div class="manifest-card__identity">
            <div class="manifest-card__avatar">${esc(initials(row.nama))}</div>
            <div class="manifest-card__titles">
              <div class="manifest-card__name-row">
                <h4 class="manifest-card__name" title="${esc(row.nama || '')}">${esc(row.nama || 'Jamaah tanpa nama')}</h4>
                <span class="manifest-badge ${badgeClass}">${esc(note.badge)}</span>
              </div>
              <p class="manifest-jamaah__sub">${esc(note.note)}</p>
            </div>
          </div>
        </div>

        ${phoneBlock(row)}

        <div class="manifest-docs">
          <div class="manifest-docs__head">
            <span>Kelengkapan Dokumen</span>
            <span class="manifest-docs__count">${esc(row.progressLabel || `${completedDocs}/${totalDocs}`)} terisi</span>
          </div>
          <div class="manifest-doc-grid">
            ${(row.documents || []).map(docChip).join('')}
          </div>
        </div>

        <div class="manifest-jamaah__footer">
          <div class="manifest-actions">
            <button type="button" data-polish-draft-id="${esc(row.id)}"
              class="manifest-action manifest-action--ghost manifest-action--polish"
              aria-label="Rapihin kata WhatsApp untuk ${esc(row.nama || 'jamaah')}">
              <i data-lucide="sparkles"></i>
              <span>Rapihin Kata</span>
            </button>
            <button type="button" data-copy-draft-id="${esc(row.id)}"
              class="manifest-action ${row.isComplete ? 'manifest-action--ghost' : 'manifest-action--primary'}"
              aria-label="Copy teks WhatsApp untuk ${esc(row.nama || 'jamaah')}">
              <i data-lucide="copy"></i>
              <span>Copy Text</span>
            </button>
            ${syncAction(row)}
            ${manageAction(row)}
          </div>
        </div>
      </div>
    `;
  }

  function renderOrderGroup(group) {
    const note = groupNote(group);
    const progressClass = group.isComplete
      ? 'is-complete'
      : Number(group.percent || 0) >= 50
        ? 'is-partial'
        : '';
    const paket = group.paket || 'Paket belum tercatat';
    const pemesan = group.pemesan || group.nama || '—';
    const rtb = group.rtb || 'RTB belum tercatat';
    const departure = group.departureDisplay || 'Belum terjadwal';
    const departureMonth = group.departureMonthLabel || '';
    const hasOrder = Boolean(group.orderCode);
    const badgeClass = group.isComplete ? 'manifest-badge is-complete' : 'manifest-badge is-incomplete';

    return `
      <article class="manifest-order ${group.isComplete ? 'is-complete' : 'is-incomplete'}"
        data-manifest-order="${esc(group.key)}">
        <div class="manifest-order__head">
          <div class="manifest-order__identity">
            <span class="manifest-order__avatar">
              <i data-lucide="${hasOrder ? 'package' : 'file-question'}"></i>
            </span>
            <div class="manifest-order__titles">
              <div class="manifest-order__title-row">
                <h3 class="manifest-order__code ${hasOrder ? '' : 'is-empty'}"
                  title="${esc(group.orderCode || '')}">
                  ${esc(group.orderCode || 'Tanpa kode order')}
                </h3>
                <span class="manifest-order__count" data-order-count>${formatNumber(group.jamaahCount)} jamaah</span>
                <span class="${badgeClass}" data-order-status>
                  ${group.isComplete ? '✓ Lengkap' : `× ${formatNumber(group.incompleteCount)} belum lengkap`}
                </span>
              </div>
              <p class="manifest-order__package">${esc(paket)}</p>
            </div>
          </div>
          <span class="manifest-card__rtb ${group.rtb ? '' : 'is-empty'}">${esc(rtb)}</span>
        </div>

        <div class="manifest-order__context">
          <span class="manifest-context-item">
            <i data-lucide="user-round"></i>
            Pemesan: <strong title="${esc(pemesan)}">${esc(pemesan)}</strong>
          </span>
          <span class="manifest-context-item" title="${esc(group.departureIso || departure)}">
            <i data-lucide="calendar-days"></i>
            <strong>${esc(departure)}</strong>
            ${departureMonth ? `<span class="text-slate-600">• ${esc(departureMonth)}</span>` : ''}
          </span>
        </div>

        <div class="manifest-order__summary">
          <div class="manifest-order__summary-head">
            <span class="manifest-order__summary-title">Kelengkapan Dokumen Order</span>
            <div class="manifest-order__summary-tools">
              <span class="manifest-order__docs-count" data-order-docs-count>${formatNumber(group.completedDocs)}/${formatNumber(group.totalDocs)} terisi</span>
              <button type="button" class="manifest-order__copy-all manifest-order__polish"
                data-polish-order="${esc(group.key)}"
                aria-label="Rapihin kata Follow-Up dokumen seluruh jamaah order ${esc(group.orderCode || '')}">
                <i data-lucide="sparkles"></i>
                <span>Rapihin Kata</span>
              </button>
              <button type="button" class="manifest-order__copy-all"
                data-copy-order="${esc(group.key)}"
                aria-label="Salin teks Follow-Up dokumen seluruh jamaah order ${esc(group.orderCode || '')}">
                <i data-lucide="copy"></i>
                <span>Copy FU Keluarga</span>
              </button>
            </div>
          </div>
          <div class="manifest-progress-line">
            <span class="manifest-progress-track">
              <span class="progress-fill ${progressClass}" data-order-progress-fill style="width: ${Number(group.percent || 0)}%"></span>
            </span>
            <span class="manifest-progress-copy ${note.className}" data-order-progress-copy>
              <strong>${esc(note.note)}</strong>
            </span>
          </div>
        </div>

        <div class="manifest-order__jamaah-list">
          ${(group.rows || []).map(renderJamaah).join('')}
        </div>
      </article>
    `;
  }

  function renderPagination(data) {
    if (!els.pagination) return;

    const totalGroups = Number(data.totalGroups || 0);
    if (!data.totalMatched || !totalGroups) {
      els.pagination.classList.add('hidden');
      return;
    }

    els.pagination.classList.remove('hidden');
    const groupCount = Array.isArray(data.groups) ? data.groups.length : 0;
    const start = (data.page - 1) * data.limit + 1;
    const end = Math.min(start + Math.max(groupCount - 1, 0), totalGroups);

    setText(
      els.pageInfo,
      `Menampilkan ${formatNumber(start)}–${formatNumber(end)} dari ${formatNumber(totalGroups)} order • ${formatNumber(data.totalMatched)} jamaah`,
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

  function renderResultMeta(data) {
    const summary = data.summary || {};
    const selected = data.selectedMonth;
    const missing = Number(summary.incomplete || 0);
    const matched = Number(data.totalMatched || 0);
    const orders = Number(data.totalGroups || 0);

    if (selected) {
      if (state.status === 'incomplete') {
        setResultMeta(
          `${selected.label} • ${formatNumber(matched)} jamaah dalam ${formatNumber(orders)} order dengan dokumen Missing`,
        );
        return;
      }
      if (state.status === 'complete') {
        setResultMeta(
          `${selected.label} • ${formatNumber(matched)} jamaah dalam ${formatNumber(orders)} order dengan dokumen lengkap`,
        );
        return;
      }
      setResultMeta(
        `${selected.label} • ${formatNumber(matched)} jamaah • ${formatNumber(orders)} order • ${formatNumber(missing)} perlu dilengkapi`,
      );
      return;
    }

    if (state.q) {
      const statusSuffix =
        state.status === 'incomplete'
          ? ' dengan dokumen Missing'
          : state.status === 'complete'
            ? ' dengan dokumen lengkap'
            : '';
      setResultMeta(
        `Ditemukan ${formatNumber(matched)} jamaah dalam ${formatNumber(orders)} order${statusSuffix} untuk “${state.q}”`,
      );
      return;
    }

    // Filter status tanpa bulan/pencarian tetap harus menampilkan jumlah hasil
    // filter, bukan total seluruh jamaah.
    if (state.status === 'incomplete') {
      setResultMeta(
        `${formatNumber(matched)} jamaah dalam ${formatNumber(orders)} order Missing dari ${formatNumber(data.totalAll)} jamaah`,
      );
      return;
    }

    if (state.status === 'complete') {
      setResultMeta(
        `${formatNumber(matched)} jamaah dalam ${formatNumber(orders)} order lengkap dari ${formatNumber(data.totalAll)} jamaah`,
      );
      return;
    }

    setResultMeta(
      `${formatNumber(data.totalAll)} jamaah • ${formatNumber(orders)} order • ${formatNumber(missing)} perlu dilengkapi`,
    );
  }

  function render(data) {
    state.page = Number(data.page || 1);
    state.pages = Number(data.pages || 1);
    state.totalMatched = Number(data.totalMatched || 0);
    state.selectedMonth = data.selectedMonth || null;
    state.summary = data.summary || null;
    state.loaded = true;

    const groups =
      Array.isArray(data.groups) && data.groups.length
        ? data.groups
        : groupRows(data.items || []);
    state.groups = groups;
    state.totalGroups = Number(data.totalGroups || groups.length || 0);
    state.pageJamaahCount = Number(
      data.pageJamaahCount || data.items?.length || 0,
    );
    state.rowsById = new Map();
    groups.forEach((group) => {
      (group.rows || []).forEach((row) => {
        const id = String(row.id || '').trim();
        if (id) state.rowsById.set(id, row);
      });
    });

    renderMonthOptions(data.monthOptions || []);
    renderKpis(data.summary || {});
    renderResultMeta(data);
    renderPageMeta(data);
    setLoading(false);

    if (!groups.length) {
      showEmpty(
        state.month || data.filter?.queryMonth
          ? 'Tidak ada jamaah pada bulan ini'
          : 'Tidak ada data yang cocok',
        state.month || data.filter?.queryMonth
          ? 'Coba pilih status “Semua”, ganti bulan keberangkatan, atau hapus kata kunci pencarian.'
          : 'Coba kata kunci nama, kode order, nomor HP, atau bulan keberangkatan lain.',
      );
      renderPagination({ ...data, totalMatched: 0, totalGroups: 0 });
      refreshIcons();
      return;
    }

    if (els.empty) els.empty.classList.add('hidden');
    if (els.list) {
      els.list.classList.remove('hidden');
      els.list.innerHTML = groups.map(renderOrderGroup).join('');
    }

    renderPagination(data);
    refreshIcons();
  }

  async function loadPage(page = state.page, { refresh = false } = {}) {
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
      month: state.month,
      status: state.status,
      page: String(page),
      limit: String(state.limit),
    });
    if (refresh) params.set('refresh', '1');

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

  function setMonthFilter(month) {
    state.month = String(month || '');
    state.page = 1;
    state.loaded = false;

    // Dropdown adalah filter eksplisit. Jika kotak pencarian berisi frasa
    // bulan, kosongkan agar dua filter bulan tidak saling bertabrakan.
    if (els.search && isMonthQuery(els.search.value)) {
      els.search.value = '';
      state.q = '';
    }

    loadPage(1);
  }

  async function copyDraftFor(id, button) {
    if (!id) return;

    const label = button?.querySelector('span');
    const originalLabel = label?.textContent || 'Copy Text';

    if (button) {
      button.disabled = true;
      if (label) label.textContent = 'Menyiapkan...';
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
        throw new Error(data.error || 'Teks WhatsApp gagal dibuat.');
      }

      const draft = String(data.draft || '').trim();
      if (!draft) throw new Error('Draf pesan kosong.');

      await copyText(draft);

      if (label) label.textContent = 'Tersalin';
      refreshIcons();

      const recipient = data.recipient?.nama
        ? ` untuk ${data.recipient.nama}`
        : '';
      const missingCount = Array.isArray(data.missing)
        ? data.missing.length
        : 0;
      const missingNote = missingCount
        ? ` ${missingCount} dokumen masih perlu dilengkapi.`
        : '';
      toast(
        'Success',
        `Teks WhatsApp${recipient} berhasil disalin.${missingNote}`,
        'success',
      );

      window.setTimeout(() => {
        if (label) label.textContent = originalLabel;
        refreshIcons();
      }, 1800);
    } catch (error) {
      if (label) label.textContent = originalLabel;
      toast('Error', error.message || 'Gagal menyalin teks WhatsApp.', 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * Buka draf WhatsApp satu jamaah di modal Rapihin Kata (Rahmah Style).
   * Draf diambil dari endpoint yang sama dengan Copy Text agar fakta dan
   * daftar dokumen yang dipakai selalu identik.
   */
  async function polishDraftFor(id, button) {
    if (!id) return;
    if (!window.RahmahPolish) {
      toast(
        'Error',
        'Modal Rapihin Kata belum termuat. Muat ulang halaman.',
        'error',
      );
      return;
    }

    const label = button?.querySelector('span');
    const originalLabel = label?.textContent || 'Rapihin Kata';
    if (button) {
      button.disabled = true;
      if (label) label.textContent = 'Menyiapkan...';
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
        throw new Error(data.error || 'Teks WhatsApp gagal dibuat.');
      }

      const draft = String(data.draft || '').trim();
      if (!draft) throw new Error('Draf pesan kosong.');

      const recipientName = String(data.recipient?.nama || '').trim();
      const orderCode = String(data.recipient?.orderCode || '').trim();
      const facts = [
        recipientName,
        orderCode,
        ...(Array.isArray(data.missing) ? data.missing : []),
        ...(Array.isArray(data.inProgress) ? data.inProgress : []),
      ].filter(Boolean);

      window.RahmahPolish.open({
        text: draft,
        mode: 'fu',
        facts,
        subtitle: [
          'FU Dokumen',
          recipientName || 'Jamaah',
          orderCode,
        ]
          .filter(Boolean)
          .join(' • '),
      });
    } catch (error) {
      toast(
        'Error',
        error.message || 'Gagal menyiapkan teks Rapihin Kata.',
        'error',
      );
    } finally {
      if (label) label.textContent = originalLabel;
      if (button) button.disabled = false;
      refreshIcons();
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

  /**
   * Saat filter/pencarian aktif, grup hanya memuat jamaah yang cocok.
   * Ambil seluruh jamaah order agar pesan FU keluarga tetap utuh.
   */
  async function fetchOrderRows(group) {
    const fallback = Array.isArray(group.rows) ? group.rows : [];
    if (!group.orderCode || (!state.q && state.status === 'all')) {
      return fallback;
    }

    try {
      const response = await fetch(
        `${ENDPOINT}/order/${encodeURIComponent(group.orderCode)}`,
        {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        },
      );
      const data = await response.json();
      if (
        response.ok &&
        data.success &&
        Array.isArray(data.rows) &&
        data.rows.length
      ) {
        return data.rows;
      }
    } catch (error) {
      // Endpoint gagal: tetap salin jamaah yang sedang tampil.
    }

    return fallback;
  }

  /**
   * Salin satu pesan Follow-Up untuk seluruh jamaah dalam kartu order.
   */
  async function copyOrderFor(button) {
    const key = String(button?.dataset.copyOrder || '').trim();
    const group = state.groups.find((item) => item.key === key);
    if (!group) {
      toast('Data tidak ditemukan', 'Muat ulang daftar lalu coba lagi.', 'error');
      return;
    }

    const originalHtml = button.innerHTML;
    button.disabled = true;

    try {
      const rows = await fetchOrderRows(group);
      const message = buildOrderFuMessage({
        ...group,
        rows,
        jamaahCount: rows.length,
      });
      if (!message) throw new Error('Teks FU keluarga gagal dibuat.');

      await copyText(message);
      button.classList.add('is-copied');
      button.innerHTML =
        '<i data-lucide="check"></i><span>✓ Tersalin!</span>';
      refreshIcons();
      toast(
        'Success',
        `FU keluarga ${group.orderCode || 'order ini'} (${formatNumber(rows.length)} jamaah) berhasil disalin.`,
        'success',
      );

      window.setTimeout(() => {
        button.classList.remove('is-copied');
        button.innerHTML = originalHtml;
        refreshIcons();
      }, 2000);
    } catch (error) {
      button.classList.remove('is-copied');
      button.innerHTML = originalHtml;
      refreshIcons();
      toast(
        'Error',
        error.message || 'Gagal menyalin teks FU keluarga.',
        'error',
      );
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Buka pesan FU keluarga (seluruh jamaah dalam order) di modal Rapihin Kata.
   * Saat filter/pencarian aktif, daftar jamaah tetap diambil lengkap lewat
   * fetchOrderRows supaya tidak ada jamaah yang terlewat.
   */
  async function polishOrderFor(button) {
    const key = String(button?.dataset.polishOrder || '').trim();
    const group = state.groups.find((item) => item.key === key);
    if (!group) {
      toast('Data tidak ditemukan', 'Muat ulang daftar lalu coba lagi.', 'error');
      return;
    }
    if (!window.RahmahPolish) {
      toast(
        'Error',
        'Modal Rapihin Kata belum termuat. Muat ulang halaman.',
        'error',
      );
      return;
    }

    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML =
      '<i data-lucide="loader-circle"></i><span>Menyiapkan...</span>';
    refreshIcons();

    try {
      const rows = await fetchOrderRows(group);
      const message = buildOrderFuMessage({
        ...group,
        rows,
        jamaahCount: rows.length,
      });
      if (!message) throw new Error('Teks FU keluarga gagal dibuat.');

      const facts = [
        String(group.pemesan || group.nama || '').trim(),
        String(group.orderCode || '').trim(),
        ...rows.map((row) => String(row.nama || '').trim()),
      ].filter(Boolean);

      window.RahmahPolish.open({
        text: message,
        mode: 'fu',
        facts,
        subtitle: [
          'FU Keluarga',
          group.orderCode || 'Tanpa kode order',
          `${formatNumber(rows.length)} jamaah`,
        ]
          .filter(Boolean)
          .join(' • '),
      });
    } catch (error) {
      toast(
        'Error',
        error.message || 'Gagal menyiapkan teks Rapihin Kata.',
        'error',
      );
    } finally {
      button.disabled = false;
      button.innerHTML = originalHtml;
      refreshIcons();
    }
  }

  async function copyPhone(button) {
    const value = String(button?.dataset.copyPhone || '').trim();
    if (!value) return;

    const row = button.closest('.manifest-phone-copy');
    const label = button.querySelector('.manifest-phone-label');

    try {
      await copyText(value);
      button.classList.add('is-copied');
      row?.classList.add('is-copied');
      if (label) {
        label.innerHTML = '<i data-lucide="check"></i> Tersalin';
      }
      refreshIcons();
      toast('Success', 'Nomor telepon berhasil disalin.', 'success');

      window.setTimeout(() => {
        button.classList.remove('is-copied');
        row?.classList.remove('is-copied');
        if (label) {
          label.innerHTML = '<i data-lucide="copy"></i> Copy';
        }
        refreshIcons();
      }, 1800);
    } catch (error) {
      toast('Error', 'Gagal menyalin nomor telepon.', 'error');
    }
  }

  /**
   * Sinkronkan satu kartu langsung dari SGO Upload Manifest. Progress bar
   * memakai status server yang sama dengan sinkronisasi penuh.
   */
  async function syncOne(button) {
    const id = String(button?.dataset.syncId || '').trim();
    if (!id) return;

    const card = button.closest('[data-manifest-row]');
    const name =
      card?.querySelector('.manifest-card__name')?.textContent?.trim() ||
      'Jamaah';
    const previousStates = captureVisibleDocStates();

    const result = await window.SgoSync.run({
      panel: els.progress,
      button,
      endpoint: '/api/jamaah/sync-one',
      body: { id },
      label: `Sinkronisasi ${name}`,
      busyLabel: 'Sync...',
      autoHideMs: 7000,
    });

    if (!result.ok) {
      if (!result.busy) {
        toast('Error', result.error || 'Sinkronisasi jamaah gagal.', 'error');
      }
      return;
    }

    const progress = result.data?.syncSummary?.target;
    toast(
      'Success',
      result.data?.message ||
        (progress
          ? `${progress.nama}: ${progress.progressLabel} dokumen terisi.`
          : 'Status dokumen diperbarui dari SGO.'),
      'success',
    );

    state.loaded = false;
    state.monthOptionsSignature = '';
    await loadPage(state.page || 1);
    flashChangedDocStates(previousStates);
    document.dispatchEvent(
      new CustomEvent('umrah:data-updated', {
        detail: { source: 'manifest-sync', count: 1, module: '/ops/upload-documents' },
      }),
    );
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

    if (els.month) {
      els.month.addEventListener('change', () => {
        setMonthFilter(els.month.value);
      });
    }

    els.filters.forEach((button) => {
      button.addEventListener('click', () => {
        setStatusFilter(button.dataset.manifestStatus);
      });
    });

    if (els.refresh) {
      els.refresh.addEventListener('click', async () => {
        const previousStates = captureVisibleDocStates();
        state.liveLastAt = 0;
        const result = await window.SgoSync.runFullSync({
          panel: els.progress,
          button: els.refresh,
          endpoint: '/api/jamaah/scrape-cookie',
          validationEndpoint: '/api/jamaah/validate-manifest',
          body: {
            focusModule: '/ops/upload-documents',
            skipManifest: true,
            js: true,
          },
          validationBody: { js: true },
          batchPages: 2,
          label: 'Upload Manifest',
          busyLabel: 'Sinkronkan...',
          retryAttempts: 3,
          onProgress: queueLiveRefresh,
          onValidationProgress: queueLiveRefresh,
        });

        if (!result.ok) {
          if (!result.busy) {
            toast(
              'Error',
              result.error || 'Sinkronisasi Upload Manifest gagal.',
              'error',
            );
            // Transaksi live sudah di-rollback oleh server; selaraskan kartu
            // dengan cache SQLite terakhir agar tidak menampilkan status parsial.
            state.loaded = false;
            state.monthOptionsSignature = '';
            await loadPage(state.page || 1);
          }
          return;
        }

        state.loaded = false;
        state.monthOptionsSignature = '';
        await loadPage(1);
        flashChangedDocStates(previousStates);
        const count = Number(
          result.data?.aggregatedCount || result.data?.count || result.rows?.length || 0,
        );
        toast(
          'Success',
          result.data?.message ||
            `Sinkronisasi Upload Manifest selesai: ${count.toLocaleString('id-ID')} jamaah.`,
          'success',
        );
        document.dispatchEvent(
          new CustomEvent('umrah:data-updated', {
            detail: {
              source: 'manifest-sync',
              count,
              module: '/ops/upload-documents',
            },
          }),
        );
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
        const polishOrderButton = event.target.closest('[data-polish-order]');
        if (polishOrderButton) {
          polishOrderFor(polishOrderButton);
          return;
        }

        const copyOrderButton = event.target.closest('[data-copy-order]');
        if (copyOrderButton) {
          copyOrderFor(copyOrderButton);
          return;
        }

        const polishDraftButton = event.target.closest('[data-polish-draft-id]');
        if (polishDraftButton) {
          polishDraftFor(polishDraftButton.dataset.polishDraftId, polishDraftButton);
          return;
        }

        const copyButton = event.target.closest('[data-copy-phone]');
        if (copyButton) {
          copyPhone(copyButton);
          return;
        }

        const syncButton = event.target.closest('[data-sync-id]');
        if (syncButton) {
          syncOne(syncButton);
          return;
        }

        const copyDraftButton = event.target.closest('[data-copy-draft-id]');
        if (copyDraftButton) {
          copyDraftFor(copyDraftButton.dataset.copyDraftId, copyDraftButton);
        }
      });
    }

    document.addEventListener('umrah:view-change', (event) => {
      if (event.detail?.view === 'manifest') onShow();
    });

    document.addEventListener('umrah:data-updated', (event) => {
      state.loaded = false;
      state.monthOptionsSignature = '';
      if (event.detail?.source === 'manifest-sync') return;
      if (document.getElementById('view-manifest')?.hidden === false) {
        loadPage(1);
      }
    });

    // Tombol sidebar "Sinkronkan Manifest" memakai panel progress global.
    // Event ini menjembatani progress tersebut ke kartu manifest agar badge
    // dokumen tetap berubah merah -> hijau secara real-time.
    document.addEventListener('umrah:sync-progress', (event) => {
      const progress = event.detail || {};
      if (progress.module && progress.module !== '/ops/upload-documents') return;
      queueLiveRefresh(progress);
    });

    // Saat halaman dibuka di tengah sinkronisasi (mis. dimulai dari sidebar
    // atau tab Monitoring), ikut tampilkan progress dan update kartu live.
    if (window.SgoSync?.attach) {
      window.SgoSync.attach(els.progress, { onProgress: queueLiveRefresh });
    }

    if (document.getElementById('view-manifest')?.hidden === false) {
      loadPage(1);
    }
  });

  window.ManifestModule = {
    refresh: () => {
      state.loaded = false;
      return loadPage(state.page || 1);
    },
    onShow,
    state,
  };
})();
