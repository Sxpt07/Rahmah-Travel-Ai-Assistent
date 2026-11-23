/**
 * Modul frontend FU Pelunasan — papan follow-up penagihan aging SGO RED.
 *
 * Sumber data: /api/fu-pelunasan (cache SQLite yang diisi dari kanban dan
 * list `?risk=RED`). Filter status H, pencarian, dan filter bulan
 * keberangkatan dilakukan di browser. Setiap kartu menyediakan link invoice
 * publik dan tombol salin template WhatsApp personal. Tidak ada pesan yang
 * dikirim otomatis.
 */
(() => {
  const ENDPOINT = '/api/fu-pelunasan';
  const REFRESH_ENDPOINT = '/api/fu-pelunasan/refresh';
  const AUTO_REFRESH_MS = 3 * 60 * 1000;

  const els = {
    section: document.getElementById('view-fu-pelunasan'),
    refresh: document.getElementById('fu-refresh'),
    sourceChip: document.getElementById('fu-source-chip'),
    sourceDot: document.getElementById('fu-source-dot'),
    sourceLabel: document.getElementById('fu-source-label'),
    warning: document.getElementById('fu-warning'),
    totalPiutang: document.getElementById('fu-total-piutang'),
    totalPiutangSub: document.getElementById('fu-total-piutang-sub'),
    totalJamaah: document.getElementById('fu-total-jamaah'),
    totalJamaahSub: document.getElementById('fu-total-jamaah-sub'),
    totalOverdue: document.getElementById('fu-total-overdue'),
    totalOverdueSub: document.getElementById('fu-total-overdue-sub'),
    totalInvoice: document.getElementById('fu-total-invoice'),
    totalInvoiceSub: document.getElementById('fu-total-invoice-sub'),
    search: document.getElementById('fu-search'),
    month: document.getElementById('fu-month'),
    sort: document.getElementById('fu-sort'),
    filters: document.getElementById('fu-filters'),
    resultMeta: document.getElementById('fu-result-meta'),
    syncMeta: document.getElementById('fu-sync-meta'),
    loading: document.getElementById('fu-loading'),
    error: document.getElementById('fu-error'),
    errorTitle: document.getElementById('fu-error-title'),
    errorText: document.getElementById('fu-error-text'),
    retry: document.getElementById('fu-retry'),
    empty: document.getElementById('fu-empty'),
    emptyTitle: document.getElementById('fu-empty-title'),
    emptyText: document.getElementById('fu-empty-text'),
    list: document.getElementById('fu-list'),
    sidebarCount: document.getElementById('fu-sidebar-count'),
  };

  if (!els.section || !els.list) return;

  const state = {
    loading: false,
    data: null,
    rows: [],
    query: '',
    filter: 'all',
    month: 'all',
    sort: 'urgency',
    monthOptionsSignature: '',
    lastLoadAt: 0,
    searchTimer: null,
    copiedTimer: null,
    phoneCopiedTimer: null,
  };

  const FILTERS = [
    { id: 'all', label: 'Semua' },
    { id: 'overdue', label: 'Lewat H' },
    { id: 'week', label: '≤ H-7' },
    { id: 'month', label: 'H-8 – H-30' },
    { id: 'later', label: '> H-30' },
  ];

  const MONTH_NAMES = [
    'Januari',
    'Februari',
    'Maret',
    'April',
    'Mei',
    'Juni',
    'Juli',
    'Agustus',
    'September',
    'Oktober',
    'November',
    'Desember',
  ];

  /* ------------------------------------------------------------------ */
  /* Utilitas                                                           */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalize(value = '') {
    return String(value ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatNumber(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? number.toLocaleString('id-ID') : '0';
  }

  function formatRupiah(value) {
    return `Rp ${formatNumber(value)}`;
  }

  function formatSyncTime(value) {
    if (!value) return 'Belum disinkronkan';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    const dateLabel = date.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
    const timeLabel = date.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
    });

    return `Sinkron ${dateLabel} • ${timeLabel}`;
  }

  function initials(name = '') {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return 'FU';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  function createIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function toast(title, message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, type);
    }
  }

  function bucketOf(row) {
    const offset = Number(row.daysOffset);
    if (!Number.isFinite(offset)) return 'later';
    if (offset > 0 || row.departureTone === 'past') return 'overdue';
    if (offset >= -7) return 'week';
    if (offset >= -30) return 'month';
    return 'later';
  }

  function monthKeyOf(row = {}) {
    const iso = String(row.departureIso || '').trim();
    const isoMatch = iso.match(/^(\d{4})-(\d{1,2})(?:-|$)/);
    if (isoMatch) {
      const month = Number(isoMatch[2]);
      if (month >= 1 && month <= 12) {
        return `${isoMatch[1]}-${String(month).padStart(2, '0')}`;
      }
    }

    // Cadangan bila cache lama belum menyimpan departureIso.
    const label = String(row.departureDate || '').trim();
    const labelMatch = label.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!labelMatch) return '';

    const token = labelMatch[2].slice(0, 3).toLowerCase();
    const index = MONTH_NAMES.findIndex(
      (name) => name.slice(0, 3).toLowerCase() === token,
    );
    if (index < 0) return '';
    return `${labelMatch[3]}-${String(index + 1).padStart(2, '0')}`;
  }

  function monthLabelOf(key = '') {
    const match = String(key || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return 'Tanggal Belum Ditentukan';

    const index = Number(match[2]) - 1;
    if (index < 0 || index >= MONTH_NAMES.length) {
      return 'Tanggal Belum Ditentukan';
    }
    return `${MONTH_NAMES[index]} ${match[1]}`;
  }

  function buildMonthOptions() {
    const counts = new Map();
    let unknown = 0;

    state.rows.forEach((row) => {
      const key = monthKeyOf(row);
      if (!key) {
        unknown += 1;
        return;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const options = [
      {
        value: 'all',
        label: `Semua Bulan (${formatNumber(state.rows.length)})`,
      },
    ];

    [...counts.keys()].sort().forEach((key) => {
      options.push({
        value: key,
        label: `${monthLabelOf(key)} (${formatNumber(counts.get(key))})`,
      });
    });

    if (unknown > 0) {
      options.push({
        value: 'unknown',
        label: `Tanggal Belum Ditentukan (${formatNumber(unknown)})`,
      });
    }

    return options;
  }

  function renderMonthOptions() {
    if (!els.month) return;

    const options = buildMonthOptions();
    const signature = JSON.stringify(
      options.map((option) => [option.value, option.label]),
    );

    if (signature !== state.monthOptionsSignature) {
      state.monthOptionsSignature = signature;
      els.month.innerHTML = options
        .map(
          (option) =>
            `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
        )
        .join('');
    }

    const hasSelection = options.some(
      (option) => option.value === state.month,
    );
    if (!hasSelection) state.month = 'all';
    els.month.value = state.month;
  }

  function matchesMonth(row) {
    if (state.month === 'all') return true;
    const key = monthKeyOf(row);
    if (state.month === 'unknown') return !key;
    return key === state.month;
  }

  function daysTone(row) {
    const offset = Number(row.daysOffset);
    if (!Number.isFinite(offset)) return 'is-later';
    if (offset > 0 || row.departureTone === 'past') return 'is-past';
    if (offset >= -7) return 'is-urgent';
    if (offset >= -30) return 'is-soon';
    return 'is-normal';
  }

  /**
   * Tautan pembayaran SGO selalu memakai nomor order kartu ini. Path proxy
   * dinormalisasi agar baris lama yang masih menyimpan `/ops/...` atau URL
   * absolut tetap membuka order yang benar.
   */
  function sgoDetailHref(row) {
    const fromRow = String(row.orderNumber || '').replace(/\D/g, '');
    const fromUrl =
      (String(row.sgoUrl || '').match(/\/order\/(\d{1,20})/i) || [])[1] || '';
    const orderNumber = (fromRow || fromUrl).slice(0, 20);
    if (!orderNumber) return '';
    return `/sgo-proxy/ops/tambah-pembayaran/order/${orderNumber}`;
  }

  function matchesQuery(row, query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    if (!terms.length) return true;

    const haystack = normalize(
      [
        row.orderNumber,
        row.name,
        row.packageName,
        row.rtb,
        row.departureDays,
        row.departureDate,
        row.sisaLabel,
        row.phone,
        row.phoneDisplay,
        row.lateLabel,
        row.followUpStatus,
        row.nextAction,
        row.pax ? `${row.pax} pax` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );

    return terms.every((term) => haystack.includes(term));
  }

  function sortRows(rows) {
    const sorted = [...rows];

    if (state.sort === 'amount') {
      sorted.sort((left, right) => {
        if (right.sisaAmount !== left.sisaAmount) {
          return right.sisaAmount - left.sisaAmount;
        }
        return left.name.localeCompare(right.name, 'id');
      });
      return sorted;
    }

    if (state.sort === 'name') {
      sorted.sort((left, right) => left.name.localeCompare(right.name, 'id'));
      return sorted;
    }

    sorted.sort((left, right) => {
      const leftOffset = Number.isFinite(Number(left.daysOffset))
        ? Number(left.daysOffset)
        : -Infinity;
      const rightOffset = Number.isFinite(Number(right.daysOffset))
        ? Number(right.daysOffset)
        : -Infinity;

      if (leftOffset !== rightOffset) return rightOffset - leftOffset;
      if (right.sisaAmount !== left.sisaAmount) {
        return right.sisaAmount - left.sisaAmount;
      }
      return left.name.localeCompare(right.name, 'id');
    });

    return sorted;
  }

  function buildFuMessage(row) {
    const formatter = window.RahmahMessageFormat;
    if (!formatter || typeof formatter.buildFuPelunasanMessage !== 'function') {
      throw new Error(
        'Formatter FU belum siap. Muat ulang halaman lalu coba lagi.',
      );
    }
    return formatter.buildFuPelunasanMessage(row);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* jatuh ke fallback di bawah */
      }
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                             */
  /* ------------------------------------------------------------------ */

  function renderFilters() {
    if (!els.filters) return;

    const counts = { all: state.rows.length };
    FILTERS.forEach((filter) => {
      if (filter.id === 'all') return;
      counts[filter.id] = 0;
    });

    state.rows.forEach((row) => {
      const bucket = bucketOf(row);
      counts[bucket] = (counts[bucket] || 0) + 1;
    });

    els.filters.innerHTML = FILTERS.map((filter) => {
      const active = state.filter === filter.id;
      return `
        <button type="button" class="fu-filter${active ? ' is-active' : ''}"
          data-fu-filter="${filter.id}" aria-pressed="${active}">
          <span>${escapeHtml(filter.label)}</span>
          <span class="fu-filter__count">${formatNumber(counts[filter.id] || 0)}</span>
        </button>
      `;
    }).join('');
  }

  function renderStats(summary = {}) {
    const totalJamaah = Number(summary.totalJamaah || state.rows.length || 0);
    const invoiceCount = Number(summary.invoiceCount || 0);
    const overdueCount = Number(summary.overdueCount || 0);
    const totalPiutang = Number(summary.totalPiutang || 0);

    if (els.totalPiutang) {
      els.totalPiutang.textContent = formatRupiah(totalPiutang);
    }
    if (els.totalPiutangSub) {
      els.totalPiutangSub.textContent = `${formatNumber(totalJamaah)} order RED`;
    }
    if (els.totalJamaah) {
      els.totalJamaah.textContent = formatNumber(totalJamaah);
    }
    if (els.totalJamaahSub) {
      els.totalJamaahSub.textContent = 'Order perlu ditagih';
    }
    if (els.totalOverdue) {
      els.totalOverdue.textContent = formatNumber(overdueCount);
    }
    if (els.totalOverdueSub) {
      els.totalOverdueSub.textContent = overdueCount
        ? 'Prioritas utama'
        : 'Tidak ada yang lewat H';
    }
    if (els.totalInvoice) {
      els.totalInvoice.textContent = `${formatNumber(invoiceCount)}/${formatNumber(totalJamaah)}`;
    }
    if (els.totalInvoiceSub) {
      const missing = Math.max(0, totalJamaah - invoiceCount);
      els.totalInvoiceSub.textContent = missing
        ? `${formatNumber(missing)} belum ada link`
        : 'Siap dikirim';
    }
  }

  function renderCard(row) {
    const order = escapeHtml(row.orderNumber || '');
    const name = escapeHtml(row.name || 'Tanpa nama');
    const packageName = [row.rtb, row.packageName]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join(' · ');
    const daysLabel = escapeHtml(
      row.departureDays || row.departureDate || 'Belum dijadwalkan',
    );
    const tone = daysTone(row);
    const sisa = escapeHtml(row.sisaLabel || formatRupiah(row.sisaAmount));
    const late = String(row.lateLabel || '').trim();
    const followUp = String(row.followUpStatus || '').trim();
    const phone = String(row.phoneDisplay || '').trim();
    const phoneRaw = String(row.phone || '').trim();
    const pax = Number(row.pax || 0);
    const paidPercent = Math.max(0, Math.min(100, Number(row.paidPercent) || 0));
    const paidAmount = Number(row.paidAmount || 0);
    const totalAmount = Number(row.totalAmount || 0);
    const invoice = String(row.invoiceUrl || '').trim();
    const departureDate = String(row.departureDate || '').trim();
    const detailHref = sgoDetailHref(row);
    const priceTitle =
      totalAmount > 0
        ? `Sisa tagihan SGO. Terbayar ${formatRupiah(paidAmount)} dari total ${formatRupiah(totalAmount)}.`
        : `Sisa tagihan SGO ${formatRupiah(row.sisaAmount || 0)}.`;
    const copyDisabled = !invoice;

    const invoiceAction = invoice
      ? `<a class="fu-btn fu-btn--ghost" href="${escapeHtml(invoice)}"
            target="_blank" rel="noopener noreferrer"
            title="Buka invoice publik jamaah di tab baru">
            <i data-lucide="external-link"></i>
            <span>Invoice</span>
          </a>`
      : `<button type="button" class="fu-btn fu-btn--ghost" disabled
            title="Link invoice belum tersedia pada data SGO">
            <i data-lucide="file-x"></i>
            <span>Invoice</span>
          </button>`;

    const metaItems = [];
    if (order) {
      metaItems.push(
        detailHref
          ? `<a class="fu-order-link" href="${escapeHtml(detailHref)}"
              target="_blank" rel="noopener noreferrer"
              title="Buka pembayaran order ${order} di SGO">
              <i data-lucide="hash"></i>
              <span>#${order}</span>
            </a>`
          : `<span class="fu-meta-item">
              <i data-lucide="hash"></i>
              <span>#${order}</span>
            </span>`,
      );
    }
    if (phone) {
      metaItems.push(`
        <span class="fu-meta-item fu-meta-item--phone">
          <i data-lucide="phone"></i>
          <span>${escapeHtml(phone)}</span>
          ${
            phoneRaw
              ? `<button type="button" class="fu-copy-phone"
                  data-fu-copy-phone="${escapeHtml(phoneRaw)}"
                  title="Salin nomor telepon ${escapeHtml(phone)}"
                  aria-label="Salin nomor telepon ${name}">
                  <i data-lucide="copy"></i>
                </button>`
              : ''
          }
        </span>
      `);
    }
    if (pax > 0) {
      metaItems.push(`
        <span class="fu-meta-item">
          <i data-lucide="users"></i>
          <span>${formatNumber(pax)} pax</span>
        </span>
      `);
    }
    if (departureDate) {
      metaItems.push(`
        <span class="fu-meta-item" title="Tanggal keberangkatan">
          <i data-lucide="calendar-days"></i>
          <span>Berangkat ${escapeHtml(departureDate)}</span>
        </span>
      `);
    }
    if (late) {
      metaItems.push(`<span class="fu-late">${escapeHtml(late)}</span>`);
    }
    if (followUp) {
      metaItems.push(
        `<span class="fu-followup">${escapeHtml(followUp)}</span>`,
      );
    }
    if (detailHref) {
      metaItems.push(`
        <a class="fu-detail-link" href="${escapeHtml(detailHref)}"
          target="_blank" rel="noopener noreferrer" title="Buka detail order di SGO">
          <i data-lucide="arrow-up-right"></i>
          <span>Detail SGO</span>
        </a>
      `);
    }

    return `
      <article class="fu-card" data-order="${order}">
        <div class="fu-card__head">
          <div class="fu-card__identity">
            <span class="fu-avatar" aria-hidden="true">${escapeHtml(initials(row.name))}</span>
            <div class="fu-identity-copy">
              <div class="fu-name-row">
                <h3 class="fu-name" title="${name}">${name}</h3>
                <span class="fu-risk">RED</span>
              </div>
              <p class="fu-package">${escapeHtml(packageName || 'Paket belum tersedia')}</p>
            </div>
          </div>
          <span class="fu-days ${tone}">${daysLabel}</span>
        </div>

        <div class="fu-card__metrics">
          <div class="fu-amount-block">
            <span class="fu-amount-label">Sisa tagihan</span>
            <strong class="fu-amount" title="${escapeHtml(priceTitle)}">${sisa}</strong>
          </div>
          ${
            paidPercent > 0
              ? `<div class="fu-progress">
                  <div class="fu-progress__head">
                    <span>Progres bayar</span>
                    <strong>${formatNumber(paidPercent)}%</strong>
                  </div>
                  <div class="fu-progress__bar" role="presentation">
                    <span style="width:${paidPercent}%"></span>
                  </div>
                </div>`
              : ''
          }
        </div>

        ${
          metaItems.length
            ? `<div class="fu-card__meta">${metaItems.join('')}</div>`
            : ''
        }

        <div class="fu-card__actions">
          ${invoiceAction}
          <button type="button" class="fu-btn fu-btn--ghost"
            data-fu-wa="${order}"${copyDisabled ? ' disabled' : ''}
            title="${copyDisabled ? 'Link invoice belum tersedia pada data SGO' : 'Buka WhatsApp dengan pesan FU yang sudah terisi'}"
            aria-label="Buka WhatsApp dengan pesan FU untuk ${name}">
            <i data-lucide="message-circle"></i>
            <span>WhatsApp</span>
          </button>
          <button type="button" class="fu-btn fu-btn--polish"
            data-fu-polish="${order}"${copyDisabled ? ' disabled' : ''}
            title="${copyDisabled ? 'Link invoice belum tersedia pada data SGO' : 'Rapihin kata template FU dengan Rahmah Style'}"
            aria-label="Rapihin kata follow-up WhatsApp untuk ${name}">
            <i data-lucide="sparkles"></i>
            <span>Rapihin Kata</span>
          </button>
          <button type="button" class="fu-btn fu-btn--primary fu-btn--copy"
            data-fu-copy="${order}"${copyDisabled ? ' disabled' : ''}
            title="${copyDisabled ? 'Link invoice belum tersedia pada data SGO' : 'Salin template WhatsApp personal ke clipboard'}"
            aria-label="Salin teks follow-up WhatsApp untuk ${name}">
            <i data-lucide="copy"></i>
            <span>Salin Teks FU</span>
          </button>
        </div>
      </article>
    `;
  }

  function renderList() {
    if (!els.list) return;

    const filtered = state.rows
      .filter((row) => state.filter === 'all' || bucketOf(row) === state.filter)
      .filter(matchesMonth)
      .filter((row) => matchesQuery(row, state.query));
    const sorted = sortRows(filtered);

    els.list.innerHTML = sorted.map(renderCard).join('');

    if (els.empty) {
      const hasRows = state.rows.length > 0;
      const empty = sorted.length === 0;
      els.empty.hidden = !empty;

      if (empty && els.emptyTitle && els.emptyText) {
        if (!hasRows) {
          els.emptyTitle.textContent = 'Belum ada jamaah RED';
          els.emptyText.textContent =
            'SGO tidak mengembalikan data penagihan berstatus RED. Coba refresh beberapa saat lagi.';
        } else if (state.query.trim()) {
          els.emptyTitle.textContent = 'Tidak ada jamaah yang cocok';
          els.emptyText.textContent =
            state.month === 'all'
              ? 'Coba kata kunci lain, atau ubah filter status keberangkatan.'
              : 'Coba kata kunci lain, ganti bulan keberangkatan, atau ubah filter status.';
        } else if (state.month !== 'all') {
          els.emptyTitle.textContent = 'Tidak ada jamaah pada bulan ini';
          els.emptyText.textContent =
            'Pilih bulan lain, “Semua Bulan”, atau ubah filter status keberangkatan.';
        } else {
          els.emptyTitle.textContent = 'Tidak ada jamaah pada filter ini';
          els.emptyText.textContent =
            'Pilih filter “Semua” untuk melihat seluruh jamaah RED.';
        }
      }
    }

    if (els.resultMeta) {
      const total = state.rows.length;
      const shown = sorted.length;
      const monthActive = state.month !== 'all';
      const filteredActive =
        state.filter !== 'all' || monthActive || state.query.trim();
      const monthLabel = monthActive
        ? monthLabelOf(state.month === 'unknown' ? '' : state.month)
        : '';
      const summaryText = filteredActive
        ? `Menampilkan ${formatNumber(shown)} dari ${formatNumber(total)} jamaah RED`
        : `${formatNumber(total)} jamaah RED siap ditindaklanjuti`;
      els.resultMeta.textContent = monthLabel
        ? `${monthLabel} • ${summaryText}`
        : summaryText;
    }

    createIcons();
  }

  function render() {
    const data = state.data || {};
    const summary = data.summary || {};

    if (els.warning) {
      const warning = String(data.warning || '').trim();
      els.warning.hidden = !warning;
      els.warning.textContent = warning;
    }

    if (els.sourceDot) {
      els.sourceDot.className = `fu-dot ${
        state.loading ? 'is-loading' : data.stale ? 'is-stale' : 'is-online'
      }`;
    }
    if (els.sourceLabel) {
      if (state.loading && !state.rows.length) {
        els.sourceLabel.textContent = 'Menarik data SGO...';
      } else {
        els.sourceLabel.textContent = `${data.stale ? 'Cache SQLite' : 'SQLite'} • ${formatNumber(
          summary.totalJamaah || state.rows.length,
        )} jamaah RED`;
      }
    }
    if (els.syncMeta) {
      els.syncMeta.textContent = formatSyncTime(data.lastSyncedAt);
    }
    if (els.sidebarCount) {
      const total = Number(summary.totalJamaah || state.rows.length || 0);
      els.sidebarCount.textContent = total > 0 ? formatNumber(total) : 'RED';
      els.sidebarCount.title = `${formatNumber(total)} jamaah berisiko RED`;
    }

    renderStats(summary);
    renderMonthOptions();
    renderFilters();
    renderList();
  }

  function setBusy(busy) {
    state.loading = Boolean(busy);
    if (els.refresh) {
      els.refresh.disabled = busy;
      els.refresh.classList.toggle('is-busy', busy);
    }
    if (els.sourceDot && busy) {
      els.sourceDot.className = 'fu-dot is-loading';
    }
  }

  function showLoading() {
    if (els.loading) els.loading.hidden = false;
    if (els.error) els.error.hidden = true;
    if (els.empty) els.empty.hidden = true;
    if (els.list) els.list.innerHTML = '';
  }

  function showError(error) {
    if (els.error) els.error.hidden = false;
    if (els.loading) els.loading.hidden = true;
    if (els.empty) els.empty.hidden = true;

    if (els.errorTitle) {
      els.errorTitle.textContent = 'Gagal memuat FU Pelunasan';
    }
    if (els.errorText) {
      els.errorText.textContent =
        error?.message ||
        'Periksa sesi SGO Admin lalu coba lagi. Cache SQLite tetap aman.';
    }
    if (els.sourceDot) els.sourceDot.className = 'fu-dot is-offline';
    if (els.sourceLabel) els.sourceLabel.textContent = 'Sumber SGO tidak tersedia';
    createIcons();
  }

  /* ------------------------------------------------------------------ */
  /* Pemuatan data                                                      */
  /* ------------------------------------------------------------------ */

  async function load({ force = false, silent = false } = {}) {
    if (state.loading) return;

    const hadData = state.rows.length > 0;
    setBusy(true);
    if (!hadData) showLoading();

    try {
      const response = await fetch(force ? REFRESH_ENDPOINT : ENDPOINT, {
        method: force ? 'POST' : 'GET',
        cache: 'no-store',
        headers: force ? { 'Content-Type': 'application/json' } : undefined,
        body: force ? JSON.stringify({}) : undefined,
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.success !== true) {
        throw new Error(
          data?.error ||
            `Permintaan FU Pelunasan gagal (HTTP ${response.status}).`,
        );
      }

      state.data = data;
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.lastLoadAt = Date.now();

      if (els.loading) els.loading.hidden = true;
      if (els.error) els.error.hidden = true;
      render();

      if (force) {
        toast(
          'FU Pelunasan diperbarui',
          `${formatNumber(state.rows.length)} jamaah RED dimuat dari SGO.`,
          'success',
        );
      }
    } catch (error) {
      if (hadData) {
        if (els.warning) {
          els.warning.hidden = false;
          els.warning.textContent =
            `${error.message} Menampilkan data terakhir yang sudah dimuat.`.trim();
        }
        if (!silent) {
          toast('Gagal memperbarui FU Pelunasan', error.message, 'error');
        }
        render();
      } else {
        showError(error);
        if (!silent) {
          toast('Gagal memuat FU Pelunasan', error.message, 'error');
        }
      }
    } finally {
      setBusy(false);
      if (els.sourceDot) {
        const stale = Boolean(state.data?.stale);
        els.sourceDot.className = state.data
          ? `fu-dot ${stale ? 'is-stale' : 'is-online'}`
          : 'fu-dot is-offline';
      }
    }
  }

  function maybeLoad() {
    if (!state.data) {
      load();
      return;
    }
    if (Date.now() - state.lastLoadAt > AUTO_REFRESH_MS) {
      load({ silent: true });
    }
  }

  function handlePolish(button) {
    const order = String(button.dataset.fuPolish || '').trim();
    const row = state.rows.find(
      (item) => String(item.orderNumber) === order,
    );
    if (!row) {
      toast('Data tidak ditemukan', 'Muat ulang daftar lalu coba lagi.', 'error');
      return;
    }

    if (!String(row.invoiceUrl || '').trim()) {
      toast(
        'Link invoice belum tersedia',
        'Template FU membutuhkan link invoice. Muat ulang data SGO lalu coba lagi.',
        'warning',
      );
      return;
    }

    if (!window.RahmahPolish) {
      toast(
        'Rapihin Kata belum siap',
        'Modal belum termuat. Muat ulang halaman lalu coba lagi.',
        'error',
      );
      return;
    }

    const formatter = window.RahmahMessageFormat;
    if (!formatter || typeof formatter.canonicalizeFuPelunasanText !== 'function') {
      toast(
        'Formatter FU belum siap',
        'Muat ulang halaman lalu coba lagi.',
        'error',
      );
      return;
    }

    let message;
    try {
      message = buildFuMessage(row);
    } catch (error) {
      toast('Gagal menyiapkan teks FU', error.message, 'error');
      return;
    }

    const facts = [
      String(row.name || '').trim(),
      String(row.orderNumber || '').trim(),
      String(row.sisaLabel || formatRupiah(row.sisaAmount)).trim(),
      String(row.invoiceUrl || '').trim(),
    ].filter(Boolean);

    window.RahmahPolish.open({
      text: message,
      mode: 'fu',
      facts,
      format: 'fu-pelunasan',
      formatOptions: formatter.fuPelunasanFormatOptions(row),
      subtitle: [
        'FU Pelunasan',
        row.name || 'Jamaah',
        order ? `#${order}` : '',
      ]
        .filter(Boolean)
        .join(' • '),
    });
  }

  function handleWhatsApp(button) {
    const order = String(button.dataset.fuWa || '').trim();
    const row = state.rows.find(
      (item) => String(item.orderNumber) === order,
    );
    if (!row) {
      toast('Data tidak ditemukan', 'Muat ulang daftar lalu coba lagi.', 'error');
      return;
    }

    if (!String(row.invoiceUrl || '').trim()) {
      toast(
        'Link invoice belum tersedia',
        'Template FU membutuhkan link invoice. Muat ulang data SGO lalu coba lagi.',
        'warning',
      );
      return;
    }

    const formatter = window.RahmahMessageFormat;
    if (!formatter || typeof formatter.buildWhatsAppDeepLink !== 'function') {
      toast(
        'Formatter FU belum siap',
        'Muat ulang halaman lalu coba lagi.',
        'error',
      );
      return;
    }

    let href;
    try {
      href = formatter.buildWhatsAppDeepLink({
        phone: row.phone || row.phoneDisplay || '',
        text: buildFuMessage(row),
      });
    } catch (error) {
      toast('Gagal membuka WhatsApp', error.message, 'error');
      return;
    }

    window.open(href, '_blank', 'noopener,noreferrer');
    toast(
      'WhatsApp dibuka',
      row.phone
        ? `Pesan FU untuk ${row.name || 'jamaah'} sudah terisi otomatis.`
        : 'Pilih kontak jamaah di WhatsApp. Pesan FU sudah terisi otomatis.',
      'success',
    );
  }

  async function handleCopy(button) {
    const order = String(button.dataset.fuCopy || '').trim();
    const row = state.rows.find(
      (item) => String(item.orderNumber) === order,
    );
    if (!row) {
      toast('Data tidak ditemukan', 'Muat ulang daftar lalu coba lagi.', 'error');
      return;
    }

    if (!String(row.invoiceUrl || '').trim()) {
      toast(
        'Link invoice belum tersedia',
        'Template FU membutuhkan link invoice. Muat ulang data SGO lalu coba lagi.',
        'warning',
      );
      return;
    }

    let message;
    try {
      message = buildFuMessage(row);
    } catch (error) {
      toast('Gagal menyiapkan teks FU', error.message, 'error');
      return;
    }

    const ok = await copyText(message);

    if (!ok) {
      toast(
        'Gagal menyalin',
        'Browser menolak akses clipboard. Salin manual dari halaman ini.',
        'error',
      );
      return;
    }

    const original = button.innerHTML;
    button.classList.add('is-copied');
    button.innerHTML = `
      <i data-lucide="check"></i>
      <span>Tersalin</span>
    `;
    createIcons();

    window.clearTimeout(state.copiedTimer);
    state.copiedTimer = window.setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove('is-copied');
      button.innerHTML = original;
      createIcons();
    }, 1800);

    toast(
      'Teks FU tersalin',
      `Template WhatsApp ${row.name || 'jamaah'} siap ditempel.`,
      'success',
    );
  }

  async function handleCopyPhone(button) {
    const phone = String(button.dataset.fuCopyPhone || '').trim();
    if (!phone) {
      toast(
        'Nomor telepon tidak tersedia',
        'Data SGO belum memuat nomor telepon jamaah ini.',
        'warning',
      );
      return;
    }

    const ok = await copyText(phone);
    if (!ok) {
      toast(
        'Gagal menyalin nomor telepon',
        'Browser menolak akses clipboard. Salin manual dari kartu jamaah.',
        'error',
      );
      return;
    }

    const original = button.innerHTML;
    button.classList.add('is-copied');
    button.innerHTML = '<i data-lucide="check"></i>';
    createIcons();

    window.clearTimeout(state.phoneCopiedTimer);
    state.phoneCopiedTimer = window.setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove('is-copied');
      button.innerHTML = original;
      createIcons();
    }, 1500);

    toast('Nomor telepon tersalin', `${phone} siap ditempel.`, 'success');
  }

  /* ------------------------------------------------------------------ */
  /* Event                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    if (els.refresh) {
      els.refresh.addEventListener('click', () => load({ force: true }));
    }
    if (els.retry) {
      els.retry.addEventListener('click', () => load({ force: true }));
    }

    if (els.search) {
      els.search.addEventListener('input', () => {
        state.query = els.search.value || '';
        window.clearTimeout(state.searchTimer);
        state.searchTimer = window.setTimeout(() => {
          renderFilters();
          renderList();
        }, 140);
      });
    }

    if (els.month) {
      els.month.addEventListener('change', () => {
        const next = String(els.month.value || 'all');
        state.month =
          next === 'unknown' || /^\d{4}-\d{2}$/.test(next) ? next : 'all';
        renderList();
      });
    }

    if (els.sort) {
      els.sort.addEventListener('change', () => {
        state.sort = els.sort.value || 'urgency';
        renderList();
      });
    }

    if (els.filters) {
      els.filters.addEventListener('click', (event) => {
        const button = event.target.closest('[data-fu-filter]');
        if (!button) return;

        const next = String(button.dataset.fuFilter || 'all');
        if (!FILTERS.some((filter) => filter.id === next)) return;

        state.filter = next;
        renderFilters();
        renderList();
      });
    }

    els.list.addEventListener('click', (event) => {
      const phoneButton = event.target.closest('[data-fu-copy-phone]');
      if (phoneButton) {
        handleCopyPhone(phoneButton);
        return;
      }

      const waButton = event.target.closest('[data-fu-wa]');
      if (waButton) {
        handleWhatsApp(waButton);
        return;
      }

      const polishButton = event.target.closest('[data-fu-polish]');
      if (polishButton) {
        handlePolish(polishButton);
        return;
      }

      const button = event.target.closest('[data-fu-copy]');
      if (!button) return;
      handleCopy(button);
    });

    document.addEventListener('umrah:view-change', (event) => {
      if (event.detail?.view === 'fu-pelunasan') maybeLoad();
    });

    document.addEventListener('umrah:fu-pelunasan-refresh', (event) => {
      if (event.detail?.path && event.detail.path !== '/ops/fu-pelunasan') return;
      load({ force: true });
    });

    // Saat tab FU tetap terbuka, harga dan progres pembayaran ikut diperbarui
    // berkala. Jangan menarik data saat tab lain aktif atau browser di latar.
    window.setInterval(() => {
      if (document.hidden) return;
      if (document.body.dataset.activeView !== 'fu-pelunasan') return;
      maybeLoad();
    }, AUTO_REFRESH_MS + 5000);
  }

  function init() {
    bindEvents();
    renderFilters();
    if (document.body.dataset.activeView === 'fu-pelunasan') {
      maybeLoad();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
