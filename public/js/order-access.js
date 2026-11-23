/**
 * Header order bersama + hidrasi kode akses Portal Jamaah.
 *
 * Header kartu chat dan Worksheet memakai markup yang sama supaya posisi nama
 * pemesan, kode order, PIN, tautan portal, dan jumlah jamaah konsisten.
 *
 * PIN yang sudah diketahui dari data jamaah/Worksheet langsung ditampilkan.
 * PIN yang belum ada diambil sekali lewat `/api/portal/access`, lalu disimpan
 * di cache sesi browser. Permintaan untuk order yang sama digabung agar tidak
 * menembak server berulang kali.
 */
(() => {
  const ENDPOINT = '/api/portal/access';
  const STORAGE_KEY = 'rahmah.portalAccess.v1';
  const MAX_BATCH = 12;
  const MAX_CACHE_ENTRIES = 200;

  const cache = new Map();
  const queue = new Map();
  const active = new Map();
  let flushScheduled = false;

  function text(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCode(value) {
    return text(value).toUpperCase();
  }

  function digitsOnly(value) {
    return normalizeCode(value).replace(/\D/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readSessionCache() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      Object.entries(parsed).forEach(([key, value]) => {
        const code = normalizeCode(key);
        const access = normalizeCode(value);
        if (code && access) cache.set(code, access);
      });
    } catch {
      /* Cache sesi opsional; abaikan bila browser memblokir storage. */
    }
  }

  function writeSessionCache() {
    try {
      const entries = [...cache.entries()].slice(-MAX_CACHE_ENTRIES);
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(Object.fromEntries(entries)),
      );
    } catch {
      /* Tidak masalah bila storage penuh atau diblokir. */
    }
  }

  function cacheGet(orderCode = '') {
    const code = normalizeCode(orderCode);
    if (!code) return '';

    if (cache.has(code)) return cache.get(code);

    // Nomor pendek (mis. 5107) boleh memakai PIN dari kode order lengkap.
    if (/^\d{3,6}$/.test(code)) {
      const match = [...cache.keys()].find((key) => key.endsWith(code));
      if (match) return cache.get(match) || '';
    }

    return '';
  }

  function remember(orderCode = '', accessCode = '', canonicalCode = '') {
    const code = normalizeCode(orderCode);
    const access = normalizeCode(accessCode);
    const canonical = normalizeCode(canonicalCode);
    if (!access) return;

    if (code) cache.set(code, access);
    if (canonical) cache.set(canonical, access);

    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    writeSessionCache();
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    window.setTimeout(flushQueue, 0);
  }

  function requestAccess(orderCode = '') {
    const code = normalizeCode(orderCode);
    if (!code) return Promise.resolve('');

    const cached = cacheGet(code);
    if (cached) return Promise.resolve(cached);

    if (active.has(code)) return active.get(code);
    if (queue.has(code)) return queue.get(code).promise;

    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    queue.set(code, { promise, resolve });
    scheduleFlush();
    return promise;
  }

  async function fetchBatch(batch = []) {
    const codes = batch.map(([code]) => code);

    try {
      const response = await fetch(
        `${ENDPOINT}?orders=${encodeURIComponent(codes.join(','))}`,
        {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const items = Array.isArray(payload?.items) ? payload.items : [];

      return batch.map(([code], index) => {
        const exact = items.find(
          (item) => normalizeCode(item?.orderCode) === code,
        );
        const item = exact || items[index] || null;
        return {
          code,
          accessCode: normalizeCode(item?.accessCode),
          canonicalCode: normalizeCode(item?.orderCode),
        };
      });
    } catch {
      return batch.map(([code]) => ({
        code,
        accessCode: '',
        canonicalCode: '',
      }));
    }
  }

  async function flushQueue() {
    flushScheduled = false;
    if (!queue.size) return;

    const batch = [...queue.entries()].slice(0, MAX_BATCH);
    batch.forEach(([code]) => queue.delete(code));

    batch.forEach(([code, entry]) => active.set(code, entry.promise));

    const results = await fetchBatch(batch);

    results.forEach((result) => {
      if (result.accessCode) {
        remember(result.code, result.accessCode, result.canonicalCode);
      }
      const entry = batch.find(([code]) => code === result.code)?.[1];
      if (entry) entry.resolve(result.accessCode);
      active.delete(result.code);
    });

    if (queue.size) scheduleFlush();
  }

  function setNode(node, accessCode = '') {
    if (!node) return;

    const access = normalizeCode(accessCode);
    node.dataset.orderAccessResolved = access ? '1' : '0';
    node.dataset.orderAccessState = access ? 'ready' : 'missing';
    node.dataset.orderAccessAt = String(Date.now());
    node.classList.toggle('is-loading', false);
    node.classList.toggle('is-missing', !access);
    node.setAttribute('aria-busy', 'false');

    const valueEl = node.querySelector('[data-order-access-value]');
    if (valueEl) valueEl.textContent = access || '—';

    if (access) {
      node.dataset.orderAccessCode = access;
      node.setAttribute('aria-label', `Kode akses Portal Jamaah ${access}`);
      node.setAttribute('title', `Kode akses Portal Jamaah: ${access}`);
    } else {
      delete node.dataset.orderAccessCode;
      node.setAttribute('aria-label', 'Kode akses Portal Jamaah belum tersedia');
      node.setAttribute('title', 'Kode akses Portal Jamaah belum tersedia');
    }
  }

  function setLoading(node) {
    if (!node) return;
    node.classList.add('is-loading');
    node.classList.remove('is-missing');
    node.setAttribute('aria-busy', 'true');
    const valueEl = node.querySelector('[data-order-access-value]');
    if (valueEl && !valueEl.textContent.trim()) valueEl.textContent = '••••••';
  }

  function collectNodes(root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const nodes = [...scope.querySelectorAll('[data-order-access]')];
    if (
      root &&
      root.nodeType === 1 &&
      typeof root.matches === 'function' &&
      root.matches('[data-order-access]')
    ) {
      nodes.unshift(root);
    }
    return nodes;
  }

  /**
   * Isi semua chip PIN di dalam `root` dari cache atau `/api/portal/access`.
   * Aman dipanggil berulang; node yang sudah selesai tidak diminta ulang.
   */
  function hydrate(root = document) {
    const nodes = collectNodes(root);
    const pending = [];

    nodes.forEach((node) => {
      const orderCode = normalizeCode(node.dataset.orderAccess);
      const preloaded = normalizeCode(node.dataset.orderAccessCode);
      if (preloaded) {
        if (orderCode) remember(orderCode, preloaded);
        setNode(node, preloaded);
        return;
      }

      if (!orderCode) {
        setNode(node, '');
        return;
      }

      if (
        node.dataset.orderAccessResolved === '1' &&
        node.dataset.orderAccessCode
      ) {
        return;
      }

      if (node.dataset.orderAccessState === 'missing') return;

      const cached = cacheGet(orderCode);
      if (cached) {
        setNode(node, cached);
        return;
      }

      setLoading(node);
      pending.push(
        requestAccess(orderCode).then((accessCode) => {
          setNode(node, accessCode);
        }),
      );
    });

    return Promise.allSettled(pending);
  }

  function extractAccessCodeFromUrl(url = '') {
    const raw = text(url);
    if (!raw) return '';

    try {
      const parsed = new URL(raw);
      return normalizeCode(
        parsed.searchParams.get('unique_code') ||
          parsed.searchParams.get('uniq_code') ||
          parsed.searchParams.get('access') ||
          '',
      );
    } catch {
      const match = raw.match(
        /[?&](?:unique_code|uniq_code|access)=([A-Za-z0-9]+)/i,
      );
      return normalizeCode(match?.[1] || '');
    }
  }

  function resolvePortalHref(order = {}) {
    const explicit = text(order.portalHref || order.portalUrl);
    if (
      /^https?:\/\//i.test(explicit) ||
      (explicit.startsWith('/') && !explicit.startsWith('//'))
    ) {
      return explicit;
    }

    const orderCode = normalizeCode(
      order.orderCode || order.order_code || order.orderNumber,
    );
    const jamaahId = text(order.jamaahId || order.id);

    if (orderCode) {
      return `/api/portal/login?order=${encodeURIComponent(orderCode)}`;
    }
    if (jamaahId) {
      return `/api/portal/login?id=${encodeURIComponent(jamaahId)}`;
    }
    return '';
  }

  /**
   * Markup header order. Dipakai oleh chat AI Console dan kartu Worksheet agar
   * tata letaknya identik dengan ringkasan order di SGO.
   */
  function renderHeader(order = {}) {
    const pemesan =
      text(order.pemesan || order.namaPemesan || order.name) ||
      'Pemesan belum tercatat';
    const orderCode = normalizeCode(
      order.orderCode || order.order_code || order.orderNumber,
    );
    const accessCode = normalizeCode(
      order.accessCode || order.portalCode || order.uniqueCode,
    );
    const jamaahCount = Number(order.jamaahCount);
    const countLabel = Number.isFinite(jamaahCount)
      ? `${Math.max(0, Math.trunc(jamaahCount)).toLocaleString('id-ID')} jamaah`
      : '';
    const portalHref = resolvePortalHref(order);

    const codeChip = orderCode
      ? `
        <span class="order-chip order-chip--code"
          title="Kode order ${escapeHtml(orderCode)}"
          aria-label="Kode order ${escapeHtml(orderCode)}">
          <i data-lucide="clipboard-list" aria-hidden="true"></i>
          <span>${escapeHtml(orderCode)}</span>
        </span>
      `
      : '';

    const accessChip = `
      <span class="order-chip order-chip--access${accessCode ? '' : ' is-loading'}"
        data-order-access="${escapeHtml(orderCode)}"
        ${accessCode ? `data-order-access-code="${escapeHtml(accessCode)}"` : ''}
        ${accessCode ? 'data-order-access-state="ready" data-order-access-resolved="1"' : ''}
        title="Kode akses Portal Jamaah${accessCode ? `: ${escapeHtml(accessCode)}` : ''}"
        aria-label="Kode akses Portal Jamaah${accessCode ? ` ${escapeHtml(accessCode)}` : ''}">
        <i data-lucide="key-round" aria-hidden="true"></i>
        <span class="order-access-value" data-order-access-value>${escapeHtml(
          accessCode || '••••••',
        )}</span>
      </span>
    `;

    const portalLink = portalHref
      ? `
        <a class="order-portal-link" href="${escapeHtml(portalHref)}"
          target="_blank" rel="noopener noreferrer"
          title="Buka Login Portal order ${escapeHtml(orderCode || pemesan)} di tab baru"
          aria-label="Buka Login Portal order ${escapeHtml(orderCode || pemesan)} di tab baru">
          <i data-lucide="log-in" aria-hidden="true"></i>
          <span>Login Portal</span>
          <i data-lucide="arrow-up-right" class="order-portal-arrow" aria-hidden="true"></i>
        </a>
      `
      : `
        <span class="order-portal-link is-disabled" aria-disabled="true"
          title="Login Portal belum tersedia untuk order ini">
          <i data-lucide="log-in" aria-hidden="true"></i>
          <span>Login Portal</span>
        </span>
      `;

    const countChip = countLabel
      ? `
        <span class="order-chip order-chip--count" title="${escapeHtml(countLabel)}">
          <i data-lucide="users" aria-hidden="true"></i>
          <span>${escapeHtml(countLabel)}</span>
        </span>
      `
      : '';

    return `
      <header class="order-result-head">
        <div class="order-result-identity">
          <span class="order-result-kicker">Nama Pemesan</span>
          <p class="order-result-name" title="${escapeHtml(pemesan)}">${escapeHtml(pemesan)}</p>
        </div>
        <div class="order-result-meta">
          ${codeChip}
          ${accessChip}
          ${portalLink}
          ${countChip}
        </div>
      </header>
    `;
  }

  readSessionCache();

  window.OrderAccess = {
    hydrate,
    prime: remember,
    get: cacheGet,
    extractAccessCodeFromUrl,
    renderHeader,
  };
})();
