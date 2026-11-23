/**
 * Modul frontend Worksheet Perlengkapan — konsol chat AI.
 *
 * Sumber data: SGO Admin -> cache SQLite lokal. Setiap pesan admin dicari
 * lintas tahap lewat /api/worksheet/perlengkapan/search, lalu hasilnya
 * dirender sebagai balasan asisten + kartu logistik di dalam thread chat.
 * Tidak ada tabel statis dan tidak ada reload halaman.
 */
(() => {
  const ENDPOINT = '/api/worksheet/perlengkapan';
  const SEARCH_ENDPOINT = '/api/worksheet/perlengkapan/search';
  const REFRESH_ENDPOINT = '/api/worksheet/perlengkapan/refresh';
  const DEFAULT_TAB = 'butuh_disiapkan';
  const AUTO_REFRESH_MS = 60 * 1000;
  const SEARCH_LIMIT = 80;
  const MAX_VISIBLE_ORDERS = 12;
  const DEFAULT_PLACEHOLDER =
    'Ketik kode order, nama pemesan, atau nama jamaah...';

  const els = {
    section: document.getElementById('view-worksheet'),
    refresh: document.getElementById('worksheet-refresh'),
    sourceChip: document.getElementById('worksheet-source-chip'),
    sourceDot: document.getElementById('worksheet-source-dot'),
    sourceLabel: document.getElementById('worksheet-source-label'),
    chatStatus: document.getElementById('worksheet-chat-status'),
    statusDot: document.getElementById('worksheet-status-dot'),
    messages: document.getElementById('worksheet-messages'),
    welcome: document.getElementById('worksheet-welcome'),
    chatInput: document.getElementById('worksheet-chat-input'),
    chatSend: document.getElementById('worksheet-chat-send'),
    chatClear: document.getElementById('worksheet-chat-clear'),
    chatPrompts: document.getElementById('worksheet-chat-prompts'),
    chatCount: document.getElementById('worksheet-chat-count'),
    warning: document.getElementById('worksheet-warning'),
    sgoModal: document.getElementById('worksheet-sgo-modal'),
    sgoBackdrop: document.getElementById('worksheet-sgo-backdrop'),
    sgoFrame: document.getElementById('worksheet-sgo-frame'),
    sgoTitle: document.getElementById('worksheet-sgo-title'),
    sgoSubtitle: document.getElementById('worksheet-sgo-subtitle'),
    sgoClose: document.getElementById('worksheet-sgo-close'),
    sgoOpenTab: document.getElementById('worksheet-sgo-open-tab'),
    sgoLoading: document.getElementById('worksheet-sgo-loading'),
    sgoLoadingText: document.getElementById('worksheet-sgo-loading-text'),
    sgoFallback: document.getElementById('worksheet-sgo-fallback'),
  };

  const state = {
    initialized: false,
    loading: false,
    searching: false,
    data: null,
    tabs: [],
    fallbackRows: [],
    lastLoadAt: 0,
    lastQuery: '',
    promptMode: '',
    requestId: 0,
    sgoAction: null,
    sgoDirty: false,
  };

  const orderShareRegistry = new Map();
  let welcomeTemplate = '';
  let sgoPollTimer = null;
  let sgoFallbackTimer = null;
  let shareSeq = 0;

  /* ------------------------------------------------------------------ */
  /* Utilitas                                                            */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('id-ID') : '0';
  }

  function digitsOnly(value = '') {
    return String(value ?? '').replace(/\D/g, '');
  }

  function normalize(value = '') {
    return String(value ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function phoneVariants(phone = '') {
    const digits = digitsOnly(phone);
    if (!digits) return [];

    const variants = new Set([digits]);
    if (digits.startsWith('62')) {
      variants.add(`0${digits.slice(2)}`);
    } else if (digits.startsWith('0')) {
      variants.add(`62${digits.slice(1)}`);
    }
    return [...variants];
  }

  function telHref(phone = '') {
    const digits = digitsOnly(phone);
    if (!digits) return '';
    if (digits.startsWith('0')) return `tel:+62${digits.slice(1)}`;
    return `tel:+${digits}`;
  }

  function whatsappHref(row) {
    const url = String(row?.waUrl || '');
    if (/^https:\/\/wa\.me\/\d+$/i.test(url)) return url;

    const digits = digitsOnly(row?.phone);
    if (!digits) return '';
    const normalized = digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
    return `https://wa.me/${normalized}`;
  }

  function formatDeparture(row) {
    const iso = String(row?.departureIso || '');
    if (iso) {
      const date = new Date(`${iso}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString('id-ID', {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });
      }
    }
    return String(row?.departureDate || '');
  }

  function portalHref(row = {}) {
    const explicit = String(row.portalUrl || '').trim();
    if (/^https?:\/\//i.test(explicit)) return explicit;

    const orderCode = String(row.orderCode || '').trim();
    if (!orderCode) return '';
    return `/api/portal/login?order=${encodeURIComponent(orderCode)}`;
  }

  function toast(title, message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, type);
    }
  }

  function createIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function plainText(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function absoluteUrl(value) {
    const raw = plainText(value);
    if (!raw) return '';
    try {
      return new URL(raw, window.location.origin).href;
    } catch {
      return raw;
    }
  }

  async function copyText(text) {
    const value = String(text ?? '');
    if (!value) throw new Error('Tidak ada teks untuk disalin.');

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        /* lanjut ke fallback */
      }
    }

    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.top = '-9999px';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    const copied = document.execCommand('copy');
    helper.remove();
    if (!copied) throw new Error('Clipboard tidak tersedia.');
  }

  function tabLabel(tabId) {
    const tab = (state.tabs || []).find((item) => item.id === tabId);
    if (tab?.label) return tab.label;
    if (tabId === DEFAULT_TAB) return 'Butuh Disiapkan';
    return tabId || 'Worksheet';
  }

  function uniqueOrderCount(rows) {
    const orders = new Set();
    rows.forEach((row) => {
      const key =
        row.orderNumber || row.orderCode || row.pemesan || row.jamaahName;
      if (key) orders.add(key);
    });
    return orders.size;
  }

  function buildSearchText(row) {
    return normalize(
      [
        row.orderNumber,
        row.orderCode,
        row.pemesan,
        row.phone,
        row.phoneDisplay,
        ...phoneVariants(row.phone),
        row.jamaahName,
        row.gender,
        row.genderTitle,
        row.jacketSize,
        row.attributeNote,
        row.packageName,
        row.rtb,
        row.departureDate,
        row.departureIso,
        row.deadline,
        row.priority,
        row.region,
        row.method,
        row.methodDetail,
        row.orderFlags,
        row.qcStatus,
        row.tabLabel,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  function matchesTerm(haystack, term) {
    // Kata alfabet 1–2 huruf (mis. "L" pada "Jaket L") harus cocok sebagai
    // token utuh supaya tidak ikut menangkap "XL" atau "XXL".
    if (term.length < 3 && /^[A-Z]+$/.test(term)) {
      return ` ${haystack} `.includes(` ${term} `);
    }
    return haystack.includes(term);
  }

  function filterLocalRows(query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    if (!terms.length) return [];

    return state.fallbackRows.filter((row) => {
      const haystack = row.__wsSearch || '';
      return terms.every((term) => matchesTerm(haystack, term));
    });
  }

  async function fetchJson(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        cache: 'no-store',
        signal: controller.signal,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      return { response, payload };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Permintaan melewati batas waktu. Coba lagi.');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Status & composer                                                   */
  /* ------------------------------------------------------------------ */

  function setChatStatus(mode = 'online') {
    const configs = {
      online: {
        dot: 'inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400',
        text: 'Online • siap membantu',
      },
      searching: {
        dot: 'inline-flex h-1.5 w-1.5 rounded-full bg-gold-400 animate-pulse',
        text: 'Mencari di cache SQLite...',
      },
      offline: {
        dot: 'inline-flex h-1.5 w-1.5 rounded-full bg-red-400',
        text: 'Cache belum siap • coba Refresh',
      },
    };
    const config = configs[mode] || configs.online;

    if (els.statusDot) els.statusDot.className = config.dot;
    if (els.chatStatus) els.chatStatus.textContent = config.text;
  }

  function autoResizeComposer() {
    const input = els.chatInput;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }

  function updateComposerUi() {
    const value = String(els.chatInput?.value || '');

    if (els.chatCount) {
      els.chatCount.textContent = `${value.length}/200`;
    }
    if (els.chatSend) {
      els.chatSend.disabled = !value.trim() || state.searching;
      els.chatSend.setAttribute('aria-busy', String(state.searching));
    }

    autoResizeComposer();
  }

  function resetPromptState() {
    state.promptMode = '';
    if (els.chatInput) els.chatInput.placeholder = DEFAULT_PLACEHOLDER;
    if (els.chatPrompts) {
      els.chatPrompts
        .querySelectorAll('[data-ws-prompt]')
        .forEach((button) => {
          button.classList.remove('is-active');
          button.setAttribute('aria-pressed', 'false');
        });
    }
  }

  function applyPrompt(kind) {
    const configs = {
      order: 'Ketik kode order, contoh: 5283',
      jamaah: 'Ketik nama jamaah atau nama pemesan...',
      size: 'Ketik nama jamaah untuk cek ukuran jaket...',
      package: 'Ketik nama paket, contoh: Umroh Plus Thoif...',
    };
    const placeholder = configs[kind];
    if (!placeholder || !els.chatInput) return;

    state.promptMode = kind;
    els.chatInput.placeholder = placeholder;
    els.chatInput.focus();

    if (els.chatPrompts) {
      els.chatPrompts
        .querySelectorAll('[data-ws-prompt]')
        .forEach((button) => {
          const active = button.dataset.wsPrompt === kind;
          button.classList.toggle('is-active', active);
          button.setAttribute('aria-pressed', String(active));
        });
    }
  }

  function setBusy(busy) {
    if (!els.refresh) return;
    els.refresh.disabled = busy;
    els.refresh.setAttribute('aria-busy', String(busy));
    const icon = els.refresh.querySelector('svg, i');
    if (icon) {
      icon.classList.toggle('animate-spin', busy);
      icon.classList.toggle('is-spinning', busy);
    }
  }

  function setSource(tone, label, title = '') {
    if (els.sourceDot) els.sourceDot.className = `ws-dot is-${tone}`;
    if (els.sourceLabel) els.sourceLabel.textContent = label;
    if (els.sourceChip) els.sourceChip.title = title || '';
  }

  function renderWarning(message) {
    if (!els.warning) return;

    if (!message) {
      els.warning.classList.add('hidden');
      els.warning.innerHTML = '';
      return;
    }

    els.warning.innerHTML = `
      <div class="flex items-start gap-2">
        <i data-lucide="alert-triangle"
          class="mt-[1px] h-3.5 w-3.5 flex-shrink-0 text-amber-400/80"></i>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
    els.warning.classList.remove('hidden');
    createIcons();
  }

  /* ------------------------------------------------------------------ */
  /* Thread chat                                                         */
  /* ------------------------------------------------------------------ */

  function scrollThread() {
    if (!els.messages) return;
    window.requestAnimationFrame(() => {
      els.messages.scrollTo({
        top: els.messages.scrollHeight,
        behavior: 'smooth',
      });
    });
  }

  /**
   * Posisikan awal satu balasan asisten di atas area percakapan.
   * Dipakai setelah hasil pencarian dirender supaya pengguna langsung melihat
   * ringkasan + kartu pertama, bukan dasar kartu yang tinggi (khusus mobile).
   */
  function scrollRowToTop(row, offset = 12) {
    if (!els.messages || !row) return;
    window.requestAnimationFrame(() => {
      const containerRect = els.messages.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const target =
        els.messages.scrollTop + (rowRect.top - containerRect.top) - offset;
      els.messages.scrollTo({
        top: Math.max(0, target),
        behavior: 'smooth',
      });
    });
  }

  function hideWelcome() {
    if (els.welcome) els.welcome.classList.add('hidden');
  }

  function showWelcome() {
    if (els.welcome) els.welcome.classList.remove('hidden');
  }

  function appendMessage(row, { scroll = 'bottom' } = {}) {
    if (!els.messages || !row) return;
    els.messages.appendChild(row);
    createIcons();
    if (scroll === 'bottom') scrollThread();
    else if (scroll === 'top') scrollRowToTop(row);
  }

  function createAssistantRow() {
    const row = document.createElement('div');
    row.className =
      'message-bubble message-enter mx-auto flex w-full max-w-4xl gap-3';
    row.innerHTML = `
      <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gold-400/30 bg-gradient-to-br from-gold-300 to-gold-600 shadow-[0_10px_26px_-14px_rgba(245,158,11,0.9)]">
        <i data-lucide="sparkles" class="h-3.5 w-3.5 text-[#1C1404]"></i>
      </div>
      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-center gap-2.5">
          <span class="text-[11px] font-semibold text-slate-400">Rahmah AI</span>
          <span class="text-[10px] text-slate-600">Asisten Logistik</span>
        </div>
        <div class="ws-ai-body"></div>
      </div>
    `;
    return row;
  }

  function appendAssistantBlock(html, options = {}) {
    const row = createAssistantRow();
    const body = row.querySelector('.ws-ai-body');
    if (body) body.innerHTML = html;
    appendMessage(row, options);
    if (typeof window.OrderAccess?.hydrate === 'function') {
      window.OrderAccess.hydrate(row);
    }
    return row;
  }

  function appendUserMessage(text) {
    const row = document.createElement('div');
    row.className =
      'message-bubble message-enter mx-auto flex w-full max-w-4xl flex-row-reverse gap-3';
    row.innerHTML = `
      <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gold-400/25 bg-gold-400/10">
        <i data-lucide="user" class="h-3.5 w-3.5 text-gold-200"></i>
      </div>
      <div class="flex min-w-0 max-w-[85%] flex-col items-end">
        <div class="rounded-2xl rounded-tr-md border border-gold-400/30 bg-gradient-to-br from-gold-500/[0.24] via-gold-500/[0.1] to-white/[0.03] px-4 py-2.5 shadow-[0_16px_40px_-24px_rgba(245,158,11,0.8)] backdrop-blur-md">
          <p class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gold-50">${escapeHtml(
            text,
          )}</p>
        </div>
        <span class="mt-1 text-[10px] text-slate-500">Anda</span>
      </div>
    `;
    appendMessage(row);
    return row;
  }

  function showTyping() {
    removeTyping();

    const row = createAssistantRow();
    row.id = 'worksheet-typing';
    const body = row.querySelector('.ws-ai-body');
    if (body) {
      body.innerHTML = `
        <div class="inline-block rounded-2xl rounded-tl-md border border-gold-400/18 bg-white/[0.04] px-4 py-3">
          <div class="flex items-center gap-1.5">
            <div class="typing-dot h-1.5 w-1.5 rounded-full"></div>
            <div class="typing-dot h-1.5 w-1.5 rounded-full"></div>
            <div class="typing-dot h-1.5 w-1.5 rounded-full"></div>
          </div>
        </div>
        <p class="mt-1 text-[10px] text-slate-600">Mencari di cache SQLite...</p>
      `;
    }
    appendMessage(row);
  }

  function removeTyping() {
    const typing = document.getElementById('worksheet-typing');
    if (typing) typing.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Render kartu logistik                                               */
  /* ------------------------------------------------------------------ */

  function renderPhone(row) {
    if (!row.phone) {
      return '<span class="ws-phone is-empty">Belum ada nomor</span>';
    }

    const display = escapeHtml(row.phoneDisplay || row.phone);
    const href = telHref(row.phone);
    const wa = whatsappHref(row);

    return `
      <span class="ws-phone-line">
        <a class="ws-phone" href="${escapeHtml(href)}"
          title="Telepon ${display}">${display}</a>
        ${
          wa
            ? `<a class="ws-wa-link" href="${escapeHtml(
                wa,
              )}" target="_blank" rel="noopener noreferrer"
                title="Chat WhatsApp">
                <i data-lucide="message-circle" class="h-3 w-3"></i>
                <span>WhatsApp</span>
              </a>`
            : ''
        }
      </span>
    `;
  }

  function deadlineToneClass(tone = '') {
    const value = String(tone || '').toLowerCase();
    if (/bad|danger|late|lewat|overdue/.test(value)) return 'is-danger';
    if (/warn|soon|urgent|kuning/.test(value)) return 'is-warn';
    return '';
  }

  function renderDeparture(row, { showDeadline = false } = {}) {
    const departure = formatDeparture(row);
    const deadline = String(row.deadline || '').trim();
    const tone = deadlineToneClass(row.deadlineTone);
    const title = deadline
      ? `Batas akhir perlengkapan: ${deadline}`
      : 'Jadwal keberangkatan';

    return `
      ${
        departure
          ? `<span class="ws-date" title="${escapeHtml(
              title,
            )}">${escapeHtml(departure)}</span>`
          : '<span class="ws-sub">Belum dijadwalkan</span>'
      }
      ${
        showDeadline && deadline
          ? `<span class="ws-sub ${tone}">${escapeHtml(deadline)}</span>`
          : ''
      }
    `;
  }

  function renderChatFact(label, valueHtml) {
    return `
      <div class="ws-logi-fact">
        <span class="ws-logi-fact-label">${escapeHtml(label)}</span>
        <span class="ws-logi-fact-value">${valueHtml}</span>
      </div>
    `;
  }

  function renderChatJamaah(row) {
    const size = String(row.jacketSize || '').trim();
    const note = String(row.attributeNote || '').trim();
    const gender = String(row.gender || '').trim() || '👤';
    const done = Number(row.qcDone);
    const total = Number(row.qcTotal);
    const qcLabel =
      Number.isFinite(done) && Number.isFinite(total) && total > 0
        ? `${done}/${total} item`
        : String(row.qcStatus || '').trim();

    return `
      <div class="ws-logi-person">
        <span class="ws-logi-person-icon" title="${escapeHtml(
          row.genderTitle || 'Jamaah',
        )}">${escapeHtml(gender)}</span>
        <div class="ws-logi-person-main">
          <p class="ws-logi-person-name">${escapeHtml(
            row.jamaahName || '—',
          )}</p>
          <div class="ws-logi-person-sub">
            <span class="ws-size${size ? '' : ' is-missing'}">${escapeHtml(
              size || 'Ukuran belum diisi',
            )}</span>
            ${
              note
                ? `<span class="ws-attr-note">${escapeHtml(note)}</span>`
                : ''
            }
          </div>
        </div>
        ${
          qcLabel
            ? `<span class="ws-logi-qc">${escapeHtml(qcLabel)}</span>`
            : ''
        }
      </div>
    `;
  }

  function stageLabel(group) {
    const labels = Array.isArray(group.tabLabels) ? group.tabLabels : [];
    if (!labels.length) return 'Worksheet';
    if (labels.length <= 2) return labels.join(' · ');
    return `${labels[0]} +${labels.length - 1}`;
  }

  function firstRowValue(rows, order, key) {
    const own = plainText(order?.[key]);
    if (own) return own;
    for (const row of rows) {
      const value = plainText(row?.[key]);
      if (value) return value;
    }
    return '';
  }

  function qcText(row) {
    const done = row?.qcDone == null ? NaN : Number(row.qcDone);
    const total = row?.qcTotal == null ? NaN : Number(row.qcTotal);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      return `${done}/${total} item`;
    }
    return plainText(row?.qcStatus);
  }

  /**
   * Susun rincian order sebagai teks polos yang siap ditempel di WhatsApp.
   * Fungsi ini hanya memakai data grup yang diberikan; pemanggil dapat
   * melengkapinya dulu lewat `loadFullOrderGroup` sebelum menyalin.
   */
  function buildOrderShareText(group = {}) {
    const rows = Array.isArray(group.rows) ? group.rows : [];
    const order = group.order || rows[0] || {};
    const pick = (key) => firstRowValue(rows, order, key);

    const orderNumber = pick('orderNumber');
    const orderCode = pick('orderCode');
    const accessCode = pick('portalCode');
    const pemesan = pick('pemesan');
    const phone =
      plainText(order.phoneDisplay) || pick('phoneDisplay') || pick('phone');
    const packageName = pick('packageName');
    const rtb = pick('rtb');
    const departure =
      formatDeparture(order) || pick('departureDate') || pick('departureIso');
    const deadline = pick('deadline');
    const priority = pick('priority');
    const stage = stageLabel(group);
    const portal = absoluteUrl(portalHref(order) || pick('portalUrl'));

    const lines = ['*RINCIAN ORDER PERLENGKAPAN*', ''];
    const summary = [];
    if (orderNumber) summary.push(`*Order:* #${orderNumber}`);
    if (orderCode && orderCode !== orderNumber) {
      summary.push(`*Kode Order:* ${orderCode}`);
    }
    if (pemesan) summary.push(`*Pemesan:* ${pemesan}`);
    if (phone) summary.push(`*Telepon:* ${phone}`);
    if (packageName) summary.push(`*Paket:* ${packageName}`);
    if (rtb) summary.push(`*Kode RTB:* ${rtb}`);
    if (departure) summary.push(`*Keberangkatan:* ${departure}`);
    if (deadline) summary.push(`*Batas Perlengkapan:* ${deadline}`);
    if (stage) summary.push(`*Tahap:* ${stage}`);
    if (priority) summary.push(`*Prioritas:* ${priority}`);
    summary.push(
      `*Jumlah Jamaah:* ${rows.length.toLocaleString('id-ID')} orang`,
    );
    lines.push(...summary);

    lines.push('', `*DAFTAR JAMAAH (${rows.length.toLocaleString('id-ID')})*`);
    if (!rows.length) {
      lines.push('Belum ada data jamaah pada hasil ini.');
    }

    rows.forEach((row, index) => {
      const name = plainText(row.jamaahName) || `Jamaah ${index + 1}`;
      const gender =
        plainText(row.genderTitle) || plainText(row.gender) || '';
      lines.push(`${index + 1}. *${name}*${gender ? ` (${gender})` : ''}`);

      const details = [];
      const size = plainText(row.jacketSize).replace(/^jaket\s+/i, '');
      details.push(`Ukuran jaket: ${size || 'belum diisi'}`);

      const note = plainText(row.attributeNote);
      if (note) details.push(`Catatan: ${note}`);

      const qc = qcText(row);
      if (qc) details.push(`QC: ${qc}`);

      const region = plainText(row.region);
      if (region) details.push(`Wilayah: ${region}`);

      const method = [plainText(row.method), plainText(row.methodDetail)]
        .filter(Boolean)
        .join(' — ');
      if (method) details.push(`Metode: ${method}`);

      const tab = plainText(row.tabLabel);
      if (tab) details.push(`Tahap: ${tab}`);

      details.forEach((detail) => lines.push(`   • ${detail}`));
    });

    const access = [];
    if (accessCode) access.push(`*Kode akses portal:* ${accessCode}`);
    if (portal) access.push(`*Login Portal:* ${portal}`);
    if (access.length) {
      lines.push('', '*AKSES PORTAL JAMAAH*', ...access);
    }

    lines.push('', '_Rahmah Travel_');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function loadFullOrderGroup(group) {
    const currentRows = Array.isArray(group.rows) ? group.rows : [];
    const order = group.order || currentRows[0] || {};
    const orderNumber = plainText(order.orderNumber);
    const orderCode = plainText(order.orderCode);
    const query = orderNumber || orderCode;
    if (!query) return group;

    try {
      const { response, payload } = await fetchJson(
        `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&limit=200`,
        { headers: { Accept: 'application/json' } },
        20000,
      );
      if (!response.ok || !payload?.success) return group;

      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const matches = rows.filter((row) => {
        if (orderNumber) {
          return plainText(row.orderNumber) === orderNumber;
        }
        return plainText(row.orderCode) === orderCode;
      });
      if (!matches.length) return group;

      return (
        groupByOrder(matches).find((item) => {
          if (orderNumber) {
            return plainText(item.order?.orderNumber) === orderNumber;
          }
          return plainText(item.order?.orderCode) === orderCode;
        }) || group
      );
    } catch {
      // Jaringan gagal: tetap salin data yang sudah tampil di kartu.
      return group;
    }
  }

  async function copyOrderDetails(shareId, button) {
    const key = String(shareId || '');
    const group = orderShareRegistry.get(key);
    if (!group) {
      toast(
        'Data tidak ditemukan',
        'Mulai pencarian ulang lalu klik Salin Rincian.',
        'error',
      );
      return;
    }

    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add('is-busy');

    try {
      const fullGroup = await loadFullOrderGroup(group);
      orderShareRegistry.set(key, fullGroup);

      const text = buildOrderShareText(fullGroup);
      if (!text) {
        toast('Data kosong', 'Tidak ada rincian yang bisa disalin.', 'error');
        return;
      }

      await copyText(text);
      button.classList.remove('is-busy');
      button.classList.add('is-copied');
      button.innerHTML =
        '<i data-lucide="check" class="h-3 w-3"></i><span>Tersalin!</span>';
      createIcons();

      const copiedRows = Array.isArray(fullGroup.rows) ? fullGroup.rows : [];
      const copiedNumber = plainText(fullGroup.order?.orderNumber);
      const copiedCode = plainText(fullGroup.order?.orderCode);
      const orderLabel = copiedNumber
        ? `Order #${copiedNumber}`
        : copiedCode
          ? `Order ${copiedCode}`
          : 'Rincian order';
      toast(
        'Rincian disalin',
        `${orderLabel} (${copiedRows.length.toLocaleString(
          'id-ID',
        )} jamaah) siap ditempel di WhatsApp atau chat.`,
        'success',
      );

      window.setTimeout(() => {
        button.classList.remove('is-copied');
        button.innerHTML = originalHtml;
        createIcons();
      }, 2200);
    } catch (error) {
      button.classList.remove('is-busy');
      button.classList.remove('is-copied');
      button.innerHTML = originalHtml;
      createIcons();
      toast(
        'Gagal menyalin',
        error.message || 'Clipboard tidak tersedia.',
        'error',
      );
    } finally {
      button.classList.remove('is-busy');
      button.disabled = false;
    }
  }

  function renderChatOrderCard(group = {}) {
    const order = group.order || {};
    const jamaahRows = Array.isArray(group.rows) ? group.rows : [];
    const orderNumber = String(order.orderNumber || '').trim();
    const orderCode = String(order.orderCode || '').trim();
    const canAct = /^\d+$/.test(orderNumber);
    const portal = portalHref(order);
    const stage = stageLabel(group);
    const tab = group.primaryTab || order.tab || DEFAULT_TAB;
    const priority = String(order.priority || '').trim();
    const priorityClass = /urgent/i.test(priority)
      ? ' is-urgent'
      : /high|very/i.test(priority)
        ? ' is-warn'
        : '';
    const pemesan = String(
      order.pemesan || jamaahRows[0]?.pemesan || '',
    ).trim();
    const accessCode = String(
      order.portalCode ||
        jamaahRows.find((row) => row.portalCode)?.portalCode ||
        '',
    ).trim();

    const packageHtml = order.packageName
      ? `<span class="ws-paket-nm">${escapeHtml(order.packageName)}</span>`
      : '<span class="ws-sub">Paket belum terisi</span>';
    const rtbHtml = order.rtb
      ? `<span class="ws-rtb">${escapeHtml(order.rtb)}</span>`
      : '<span class="ws-sub">—</span>';

    const disabledAttr = canAct
      ? ''
      : ' disabled title="Kode order tidak tersedia untuk aksi SGO"';
    const renderHeader = window.OrderAccess?.renderHeader;
    const header =
      typeof renderHeader === 'function'
        ? renderHeader({
            pemesan,
            orderCode: orderCode || orderNumber,
            accessCode,
            jamaahCount: jamaahRows.length,
            portalHref: portal,
            jamaahId: order.jamaahId,
          })
        : '';

    const shareId = `ws-share-${++shareSeq}`;
    orderShareRegistry.set(shareId, group);
    if (orderShareRegistry.size > 80) {
      const oldest = orderShareRegistry.keys().next().value;
      if (oldest) orderShareRegistry.delete(oldest);
    }

    return `
      <article class="ws-logi-card" data-ws-order-card="${escapeHtml(
        orderNumber || orderCode || '',
      )}">
        ${header}

        <div class="ws-logi-stagebar">
          <span class="ws-logi-stage">${escapeHtml(stage)}</span>
          ${
            priority
              ? `<span class="ws-logi-pill${priorityClass}">${escapeHtml(
                  priority,
                )}</span>`
              : ''
          }
        </div>

        <div class="ws-logi-facts">
          ${renderChatFact('Nomor Telepon / Call', renderPhone(order))}
          ${renderChatFact('Paket Umroh', packageHtml)}
          ${renderChatFact('Kode RTB', rtbHtml)}
          ${renderChatFact(
            'Tanggal Keberangkatan',
            renderDeparture(order, { showDeadline: true }),
          )}
        </div>

        <div class="ws-logi-jamaah">
          <div class="ws-logi-section-head">
            <span class="ws-logi-label">Nama Jamaah</span>
          </div>
          ${jamaahRows.map(renderChatJamaah).join('')}
        </div>

        <div class="ws-logi-actions">
          <button type="button" class="ws-logi-action is-primary"
            data-ws-action="prepare" data-ws-order="${escapeHtml(
              orderNumber,
            )}" data-ws-tab="${escapeHtml(tab)}"${disabledAttr}>
            <i data-lucide="check-check" class="h-3 w-3"></i>
            <span>Siapkan &amp; Submit</span>
          </button>
          <button type="button" class="ws-logi-action"
            data-ws-action="prepare-all" data-ws-order="${escapeHtml(
              orderNumber,
            )}" data-ws-tab="${escapeHtml(tab)}"${disabledAttr}>
            <i data-lucide="layers" class="h-3 w-3"></i>
            <span>Siapkan semua</span>
          </button>
          <button type="button" class="ws-logi-action is-gold"
            data-ws-action="copy-order" data-ws-share="${escapeHtml(shareId)}"
            title="Salin rincian order untuk dikirim ke teman"
            aria-label="Salin rincian order ${escapeHtml(
              orderNumber || orderCode || '',
            )}">
            <i data-lucide="copy" class="h-3 w-3"></i>
            <span>Salin Rincian</span>
          </button>
          <button type="button" class="ws-logi-action"
            data-ws-action="manage" data-ws-order="${escapeHtml(
              orderNumber,
            )}" data-ws-tab="${escapeHtml(
              tab,
            )}" title="Buka Kelola di tab SGO baru"${disabledAttr}>
            <i data-lucide="external-link" class="h-3 w-3"></i>
            <span>Kelola</span>
          </button>
        </div>
      </article>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Render balasan pencarian                                            */
  /* ------------------------------------------------------------------ */

  function groupByOrder(rows) {
    const groups = [];
    const map = new Map();

    rows.forEach((row) => {
      const key =
        row.orderNumber || row.orderCode || row.pemesan || row.jamaahName;
      if (!key) return;

      if (!map.has(key)) {
        const group = {
          key,
          order: row,
          rows: [],
          tabs: new Set(),
          primaryTab: row.tab || DEFAULT_TAB,
        };
        map.set(key, group);
        groups.push(group);
      }

      const group = map.get(key);
      const duplicate = group.rows.some((item) => {
        if (row.jamaahId && item.jamaahId) {
          return item.jamaahId === row.jamaahId;
        }
        return item.jamaahName === row.jamaahName;
      });

      if (!duplicate) group.rows.push(row);
      if (row.tabLabel) group.tabs.add(row.tabLabel);
    });

    groups.forEach((group) => {
      group.tabLabels = [...group.tabs];
      group.stageLabel = stageLabel(group);
    });

    return groups;
  }

  function renderEmptyState(query, result = {}) {
    const available = (result.tabs || state.tabs || []).filter(
      (tab) => tab && tab.supported !== false && Number(tab.rowsCount) > 0,
    );
    const stageText = available.length
      ? `Tahap yang tersedia di cache: ${available
          .map(
            (tab) =>
              `${escapeHtml(tab.label || tab.id)} (${formatNumber(
                tab.rowsCount,
              )})`,
          )
          .join(' • ')}.`
      : '';
    const localNote = result.local
      ? '<p class="ws-chat-empty-text text-amber-300/80">Pencarian lintas tahap sedang tidak tersedia, jadi hasil ini hanya mencakup cache tahap Butuh Disiapkan.</p>'
      : '';

    return `
      <div class="ws-chat-empty" role="status">
        <span class="ws-chat-empty-badge" aria-hidden="true">
          <i data-lucide="search-x" class="h-4 w-4"></i>
        </span>
        <p class="ws-chat-empty-title">Tidak ada data untuk '${escapeHtml(
          query,
        )}'.</p>
        <p class="ws-chat-empty-text">
          Saya sudah mencari di seluruh cache Worksheet — kode order, nama
          pemesan, nama jamaah, telepon, paket, RTB, dan ukuran jaket.
          ${stageText}
        </p>
        ${localNote}
        <div class="ws-chat-empty-actions">
          <button type="button" class="ws-chat-empty-action" data-ws-action="clear-chat">
            <i data-lucide="x" class="h-3 w-3"></i>
            <span>Bersihkan</span>
          </button>
          <button type="button" class="ws-chat-empty-action" data-ws-action="retry"
            data-ws-query="${escapeHtml(query)}">
            <i data-lucide="refresh-cw" class="h-3 w-3"></i>
            <span>Coba lagi</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderErrorState(message, query) {
    return `
      <div class="ws-chat-empty is-error" role="alert">
        <span class="ws-chat-empty-badge" aria-hidden="true">
          <i data-lucide="alert-triangle" class="h-4 w-4"></i>
        </span>
        <p class="ws-chat-empty-title">Gagal mencari data</p>
        <p class="ws-chat-empty-text">${escapeHtml(
          message || 'Pencarian Worksheet tidak berhasil.',
        )}</p>
        <div class="ws-chat-empty-actions">
          <button type="button" class="ws-chat-empty-action" data-ws-action="retry"
            data-ws-query="${escapeHtml(query)}">
            <i data-lucide="refresh-cw" class="h-3 w-3"></i>
            <span>Coba lagi</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderSearchResult(result, query) {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const groups = groupByOrder(rows);

    if (!groups.length) {
      appendAssistantBlock(renderEmptyState(query, result), { scroll: 'top' });
      return;
    }

    const visibleGroups = groups.slice(0, MAX_VISIBLE_ORDERS);
    const hiddenGroups = groups.length - visibleGroups.length;
    const totalRows = Number(result.total);
    const stages = [...new Set(groups.flatMap((group) => group.tabLabels))];
    const title =
      groups.length === 1
        ? `Saya menemukan 1 order untuk “${escapeHtml(query)}”.`
        : `Saya menemukan ${formatNumber(
            groups.length,
          )} order untuk “${escapeHtml(query)}”.`;

    const facts = [
      `${formatNumber(rows.length)} jamaah`,
      stages.length ? `tahap ${escapeHtml(stages.slice(0, 3).join(', '))}` : '',
      result.local ? 'cache lokal' : 'cache SQLite',
      Number.isFinite(totalRows) && totalRows > rows.length
        ? `${formatNumber(rows.length)} dari ${formatNumber(totalRows)} baris`
        : '',
    ].filter(Boolean);

    const localNote = result.local
      ? `<p class="mt-1.5 text-[10px] leading-relaxed text-amber-300/80">Pencarian lintas tahap sedang tidak tersedia; hasil berasal dari cache tahap Butuh Disiapkan.</p>`
      : '';

    const limitNote =
      hiddenGroups > 0
        ? `Menampilkan ${formatNumber(
            visibleGroups.length,
          )} order pertama. Persempit kata kunci untuk melihat ${formatNumber(
            hiddenGroups,
          )} order lainnya.`
        : result.truncated
          ? `Pencarian dibatasi ${formatNumber(
              rows.length,
            )} baris pertama dari ${formatNumber(totalRows)} hasil. Persempit kata kunci untuk hasil yang lebih presisi.`
          : '';

    appendAssistantBlock(
      `
      <div class="inline-block max-w-full rounded-2xl rounded-tl-md border border-gold-400/20 bg-white/[0.04] px-4 py-3 text-slate-100 shadow-[0_24px_60px_-45px_rgba(0,0,0,0.9)] backdrop-blur-md">
        <p class="text-[13px] font-semibold leading-relaxed">${title}</p>
        <p class="mt-1 text-[11px] leading-relaxed text-slate-400">${facts.join(
          ' • ',
        )}</p>
        ${localNote}
      </div>
      <div class="ws-chat-cards mt-3">
        ${visibleGroups.map(renderChatOrderCard).join('')}
      </div>
      ${
        limitNote
          ? `<p class="ws-chat-limit">${escapeHtml(limitNote)}</p>`
          : ''
      }
    `,
      { scroll: 'top' },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Pencarian                                                          */
  /* ------------------------------------------------------------------ */

  async function searchRows(query) {
    try {
      const { response, payload } = await fetchJson(
        `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`,
        { headers: { Accept: 'application/json' } },
        20000,
      );

      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.error || `Pencarian gagal (HTTP ${response.status}).`,
        );
      }

      return { ...payload, local: false };
    } catch (error) {
      if (state.fallbackRows.length) {
        const rows = filterLocalRows(query);
        return {
          success: true,
          query,
          rows,
          total: rows.length,
          limit: rows.length,
          truncated: false,
          tabs: state.tabs,
          lastSyncedAt: state.data?.lastSyncedAt || null,
          local: true,
          warning: `Pencarian lintas tahap tidak tersedia (${error.message}). Menampilkan cache ${tabLabel(
            DEFAULT_TAB,
          )}.`,
        };
      }
      throw error;
    }
  }

  function sendMessage(rawQuery) {
    const query = String(rawQuery ?? els.chatInput?.value ?? '').trim();
    if (!query || state.searching) return;

    state.lastQuery = query;
    state.searching = true;
    if (els.chatInput) els.chatInput.value = '';
    resetPromptState();
    updateComposerUi();
    setChatStatus('searching');
    hideWelcome();

    appendUserMessage(query);
    showTyping();
    scrollThread();

    const requestId = ++state.requestId;

    searchRows(query)
      .then((result) => {
        if (requestId !== state.requestId) return;
        removeTyping();
        renderSearchResult(result, query);
        if (result.warning) renderWarning(result.warning);
      })
      .catch((error) => {
        if (requestId !== state.requestId) return;
        removeTyping();
        appendAssistantBlock(renderErrorState(error.message, query), {
          scroll: 'top',
        });
      })
      .finally(() => {
        if (requestId !== state.requestId) return;
        state.searching = false;
        updateComposerUi();
        setChatStatus('online');
      });
  }

  function resetChat({ focus = true } = {}) {
    state.requestId += 1;
    state.searching = false;
    state.lastQuery = '';
    orderShareRegistry.clear();

    if (els.messages) {
      els.messages.innerHTML = welcomeTemplate || '';
      els.welcome = document.getElementById('worksheet-welcome');
      showWelcome();
      createIcons();
    }

    if (els.chatInput) els.chatInput.value = '';
    resetPromptState();
    updateComposerUi();
    setChatStatus('online');

    if (focus && els.chatInput) els.chatInput.focus();
    toast('Chat dibersihkan', 'Percakapan Worksheet dimulai dari awal.', 'success');
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot cache & sumber data                                        */
  /* ------------------------------------------------------------------ */

  function applySnapshot(payload) {
    state.data = payload;
    state.initialized = true;
    state.lastLoadAt = Date.now();

    const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
    if (tabs.length) state.tabs = tabs;

    const activeTabId = payload.tab?.id || DEFAULT_TAB;
    const activeTabLabel = payload.tab?.label || tabLabel(activeTabId);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];

    state.fallbackRows = rows.map((row) => ({
      ...row,
      tab: row.tab || activeTabId,
      tabLabel: row.tabLabel || activeTabLabel,
    }));
    state.fallbackRows.forEach((row) => {
      row.__wsSearch = buildSearchText(row);
    });

    const totalRows =
      state.tabs.reduce(
        (sum, tab) =>
          tab.supported === false ? sum : sum + Number(tab.rowsCount || 0),
        0,
      ) || Number(payload.totalAll || rows.length || 0);

    const syncedAt = payload.lastSyncedAt
      ? new Date(payload.lastSyncedAt)
      : null;
    const syncLabel =
      syncedAt && !Number.isNaN(syncedAt.getTime())
        ? `sinkron ${syncedAt.toLocaleString('id-ID')}`
        : 'cache lokal';

    setSource(
      payload.stale ? 'stale' : 'online',
      `SQLite • ${formatNumber(totalRows)} baris`,
      [
        `Sumber: SGO Admin ${payload.source?.module || '/ops/worksheet-perlengkapan'}`,
        `${formatNumber(totalRows)} baris di cache`,
        `${formatNumber(payload.summary?.totalOrders)} order pada tahap aktif`,
        syncLabel,
      ]
        .filter(Boolean)
        .join(' • '),
    );

    renderWarning(payload.warning);
    if (!state.searching) setChatStatus('online');
  }

  async function loadSnapshot({ force = false, silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;

    if (!silent) {
      setBusy(true);
      if (force) {
        setSource('loading', 'Menyegarkan cache...');
      } else if (!state.initialized) {
        setSource('loading', 'Memuat cache SQLite...');
      }
    }

    try {
      const options = force
        ? {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tab: DEFAULT_TAB }),
          }
        : { headers: { Accept: 'application/json' } };

      const url = force
        ? REFRESH_ENDPOINT
        : `${ENDPOINT}?tab=${encodeURIComponent(DEFAULT_TAB)}`;
      const { response, payload } = await fetchJson(url, options, 45000);

      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.error || `Worksheet gagal dimuat (HTTP ${response.status}).`,
        );
      }

      applySnapshot(payload);

      if (force && !silent) {
        toast(
          'Worksheet diperbarui',
          `${formatNumber(payload.rows?.length)} baris pada tahap aktif dimuat dari SGO.`,
          'success',
        );
      }
    } catch (error) {
      const message = error.message || 'Worksheet gagal dimuat.';
      if (state.initialized) {
        setSource(
          'stale',
          els.sourceLabel?.textContent || 'Cache lokal',
          message,
        );
        renderWarning(`${message} Menampilkan cache yang sudah dimuat.`);
      } else {
        setSource('offline', 'Cache SQLite belum siap', message);
        setChatStatus('offline');
      }
      if (force && !silent) toast('Gagal menyegarkan', message, 'error');
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function ensureLoaded() {
    if (state.loading) return;
    if (!state.initialized) {
      loadSnapshot();
      return;
    }
    if (Date.now() - state.lastLoadAt > AUTO_REFRESH_MS) {
      loadSnapshot({ silent: true });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Aksi SGO: checklist, kelola, dan siapkan semua                      */
  /* ------------------------------------------------------------------ */

  function setSgoLoading(visible, text = '') {
    if (els.sgoLoading) {
      els.sgoLoading.classList.toggle('hidden', !visible);
    }
    if (visible && text && els.sgoLoadingText) {
      els.sgoLoadingText.textContent = text;
    }
  }

  function showSgoFallback() {
    setSgoLoading(false);
    if (els.sgoFallback) els.sgoFallback.classList.remove('hidden');
  }

  function attachSgoFrameListeners(doc) {
    if (!doc || doc.__wsActionHooked) return;
    doc.__wsActionHooked = true;

    doc.addEventListener(
      'htmx:beforeRequest',
      (event) => {
        const verb = String(
          event.detail?.requestConfig?.verb ||
            event.detail?.requestConfig?.method ||
            'get',
        ).toLowerCase();
        if (verb !== 'get') state.sgoDirty = true;
      },
      true,
    );

    doc.addEventListener(
      'htmx:responseError',
      () => {
        showSgoFallback();
        toast(
          'Aksi SGO gagal',
          'SGO menolak permintaan. Periksa sesi admin lalu coba lagi.',
          'error',
        );
      },
      true,
    );
  }

  /**
   * Buka halaman SGO di tab browser baru untuk aksi Kelola.
   * Tab AI tetap terbuka, jadi admin bisa melihat worksheet SGO dan konsol AI
   * berdampingan. Proxy menyuntikkan skrip yang langsung membuka modal order.
   */
  function openSgoTab(orderNumber, tab = DEFAULT_TAB) {
    const order = String(orderNumber || '').trim();
    if (!/^\d+$/.test(order)) {
      toast(
        'Aksi tidak tersedia',
        'Kode order tidak valid untuk membuka SGO.',
        'error',
      );
      return;
    }

    const targetTab = tab || DEFAULT_TAB;
    const params = new URLSearchParams({
      tab: targetTab,
      manage_order: order,
    });
    const url = `/sgo-proxy/ops/worksheet-perlengkapan?${params.toString()}`;
    const popup = window.open(url, '_blank');

    if (!popup) {
      toast(
        'Tab baru diblokir',
        'Izinkan popup untuk membuka halaman Kelola SGO di tab baru.',
        'error',
      );
      return;
    }

    // Putus akses balik ke konsol AI; tab SGO berdiri sendiri.
    try {
      popup.opener = null;
    } catch {
      /* abaikan bila browser membatasi akses */
    }
  }

  function openSgoModal(mode, orderNumber, tab = DEFAULT_TAB) {
    const order = String(orderNumber || '').trim();
    if (!/^\d+$/.test(order)) {
      toast(
        'Aksi tidak tersedia',
        'Kode order tidak valid untuk membuka aksi SGO.',
        'error',
      );
      return;
    }
    if (!els.sgoModal || !els.sgoFrame) return;

    const targetTab = tab || DEFAULT_TAB;
    const manage = mode === 'manage';
    state.sgoAction = { mode, order, tab: targetTab, opened: false };
    state.sgoDirty = false;

    if (els.sgoTitle) {
      els.sgoTitle.textContent = manage
        ? 'Kelola Perlengkapan'
        : 'Siapkan & Submit';
    }
    if (els.sgoSubtitle) {
      els.sgoSubtitle.textContent = `Order #${order} • ${tabLabel(targetTab)}`;
    }

    const pageUrl = `/sgo-proxy/ops/worksheet-perlengkapan?tab=${encodeURIComponent(
      targetTab,
    )}`;
    if (els.sgoOpenTab) els.sgoOpenTab.href = pageUrl;
    if (els.sgoFallback) els.sgoFallback.classList.add('hidden');

    els.sgoModal.hidden = false;
    els.sgoModal.classList.add('flex');
    els.sgoModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('overflow-hidden');

    setSgoLoading(
      true,
      manage
        ? 'Membuka modal Kelola di SGO...'
        : 'Membuka checklist Siapkan & Submit...',
    );

    window.clearTimeout(sgoPollTimer);
    window.clearTimeout(sgoFallbackTimer);
    els.sgoFrame.src = pageUrl;

    window.setTimeout(() => els.sgoClose?.focus(), 80);
  }

  function handleSgoFrameLoad() {
    if (!state.sgoAction || !els.sgoFrame) return;

    const { mode, order } = state.sgoAction;
    let doc = null;
    let win = null;
    try {
      doc = els.sgoFrame.contentDocument;
      win = els.sgoFrame.contentWindow;
    } catch {
      showSgoFallback();
      return;
    }
    if (!doc || !win) {
      showSgoFallback();
      return;
    }

    attachSgoFrameListeners(doc);

    if (state.sgoAction.opened) {
      setSgoLoading(false);
      return;
    }

    const targetSelector =
      mode === 'manage' ? '#perlengkapan-modal' : '#qc-modal';
    const requestUrl =
      mode === 'manage'
        ? `/sgo-proxy/ops/monitoring-jamaah/perlengkapan/${order}`
        : `/sgo-proxy/ops/worksheet-perlengkapan/order/${order}/qc-modal`;

    let attempts = 0;
    const tryOpen = () => {
      if (!state.sgoAction || state.sgoAction.order !== order) return;

      const target = doc.querySelector(targetSelector);
      const htmx = win.htmx;

      if (htmx && target) {
        state.sgoAction.opened = true;
        try {
          htmx.ajax('GET', requestUrl, {
            target: targetSelector,
            swap: 'innerHTML',
          });
        } catch {
          showSgoFallback();
          return;
        }
        setSgoLoading(false);
        window.clearTimeout(sgoFallbackTimer);
        sgoFallbackTimer = window.setTimeout(() => {
          if (!state.sgoAction || state.sgoAction.order !== order) return;
          const currentTarget = doc.querySelector(targetSelector);
          if (!currentTarget || !currentTarget.children.length) {
            showSgoFallback();
          }
        }, 6000);
        return;
      }

      attempts += 1;
      if (attempts <= 30) {
        sgoPollTimer = window.setTimeout(tryOpen, 200);
      } else {
        showSgoFallback();
      }
    };

    tryOpen();
  }

  function closeSgoModal() {
    if (!els.sgoModal || els.sgoModal.hidden) return;

    const shouldRefresh = state.sgoDirty;
    state.sgoAction = null;
    state.sgoDirty = false;

    window.clearTimeout(sgoPollTimer);
    window.clearTimeout(sgoFallbackTimer);

    els.sgoModal.hidden = true;
    els.sgoModal.classList.remove('flex');
    els.sgoModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('overflow-hidden');

    if (els.sgoFrame) els.sgoFrame.src = 'about:blank';
    if (els.sgoFallback) els.sgoFallback.classList.add('hidden');

    if (shouldRefresh) {
      loadSnapshot({ force: true, silent: true });
    }
  }

  function findOrderCard(order) {
    return (
      [...document.querySelectorAll('.ws-logi-card')].find(
        (card) => card.dataset.wsOrderCard === String(order),
      ) || null
    );
  }

  function setOrderCardBusy(order, busy) {
    const card = findOrderCard(order);
    if (!card) return;
    card.classList.toggle('is-busy', busy);
    const button = card.querySelector('[data-ws-action="prepare-all"]');
    if (button) {
      button.classList.toggle('is-busy', busy);
      button.disabled = busy;
    }
  }

  async function prepareAllOrder(orderNumber) {
    const order = String(orderNumber || '').trim();
    if (!/^\d+$/.test(order)) {
      toast('Aksi tidak tersedia', 'Kode order tidak valid.', 'error');
      return;
    }

    const confirmed = window.confirm(
      `Tandai SEMUA jamaah di order #${order} sudah disiapkan?\n\n` +
        'Tindakan ini langsung mengubah status di SGO tanpa ceklis QC per barang. ' +
        'Lanjutkan?',
    );
    if (!confirmed) return;

    setOrderCardBusy(order, true);
    try {
      const { response, payload } = await fetchJson(
        `${ENDPOINT}/order/${encodeURIComponent(order)}/siapkan-all`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ confirm: true }),
        },
        30000,
      );

      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.error ||
            `Gagal menyiapkan order (HTTP ${response.status}).`,
        );
      }

      toast(
        'Order disiapkan',
        payload.message || `Order #${order} ditandai sudah disiapkan.`,
        'success',
      );
      await loadSnapshot({ force: true, silent: true });
    } catch (error) {
      toast(
        'Gagal menyiapkan order',
        error.message || 'Aksi Siapkan semua tidak berhasil.',
        'error',
      );
    } finally {
      setOrderCardBusy(order, false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Event                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    if (els.refresh) {
      els.refresh.addEventListener('click', () => {
        loadSnapshot({ force: true });
      });
    }

    if (els.chatClear) {
      els.chatClear.addEventListener('click', () => resetChat());
    }

    if (els.chatInput) {
      els.chatInput.addEventListener('input', updateComposerUi);

      els.chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendMessage();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          els.chatInput.value = '';
          resetPromptState();
          updateComposerUi();
        }
      });
    }

    if (els.chatSend) {
      els.chatSend.addEventListener('click', () => {
        if (!String(els.chatInput?.value || '').trim()) {
          els.chatInput?.focus();
          return;
        }
        sendMessage();
      });
    }

    if (els.chatPrompts) {
      els.chatPrompts.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ws-prompt]');
        if (!button) return;
        applyPrompt(button.dataset.wsPrompt);
      });
    }

    if (els.messages) {
      els.messages.addEventListener('click', (event) => {
        const actionEl = event.target.closest('[data-ws-action]');
        if (!actionEl) return;

        const action = actionEl.dataset.wsAction;
        if (action === 'clear-chat') {
          resetChat();
          return;
        }
        if (action === 'retry') {
          sendMessage(actionEl.dataset.wsQuery || state.lastQuery);
          return;
        }
        if (action === 'copy-order') {
          copyOrderDetails(actionEl.dataset.wsShare, actionEl);
          return;
        }

        const order = actionEl.dataset.wsOrder;
        const tab = actionEl.dataset.wsTab || DEFAULT_TAB;
        if (action === 'prepare') {
          openSgoModal('prepare', order, tab);
          return;
        }
        if (action === 'manage') {
          openSgoTab(order, tab);
          return;
        }
        if (action === 'prepare-all') {
          prepareAllOrder(order);
        }
      });
    }

    if (els.sgoClose) {
      els.sgoClose.addEventListener('click', closeSgoModal);
    }
    if (els.sgoBackdrop) {
      els.sgoBackdrop.addEventListener('click', closeSgoModal);
    }
    if (els.sgoFrame) {
      els.sgoFrame.addEventListener('load', handleSgoFrameLoad);
    }

    document.addEventListener('keydown', (event) => {
      if (
        event.key === 'Escape' &&
        els.sgoModal &&
        !els.sgoModal.hidden
      ) {
        event.preventDefault();
        closeSgoModal();
      }
    });

    document.addEventListener('umrah:view-change', (event) => {
      if (event.detail?.view === 'worksheet') {
        ensureLoaded();
        scrollThread();
      } else if (els.sgoModal && !els.sgoModal.hidden) {
        closeSgoModal();
      }
    });

    document.addEventListener('umrah:worksheet-refresh', () => {
      loadSnapshot({ force: true, silent: true });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    welcomeTemplate = els.welcome?.outerHTML || '';
    bindEvents();
    resetPromptState();
    updateComposerUi();
    setChatStatus('online');
    createIcons();

    if (els.section && !els.section.hidden) {
      ensureLoaded();
    }
  });

  window.WorksheetModule = {
    refresh: () => loadSnapshot({ force: true }),
    search: (query) => sendMessage(query),
    clear: () => resetChat({ focus: false }),
    load: loadSnapshot,
    state,
  };
})();
