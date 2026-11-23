(function () {
  const OVERLAY_ID = 'screen-protection-overlay';
  const WATERMARK_ID = 'screen-protection-watermark';
  const IDENTITY_KEYS = [
    'rahmah_sgo_cookie_meta',
    'sgo_cookie_meta',
    'rahmah_console_identity',
  ];
  const SENSITIVE_KEY_CODES = new Set(['PrintScreen', 'F12']);
  const SENSITIVE_CTRL_SHIFT_KEYS = new Set(['I', 'J', 'C', 'S']);
  const SENSITIVE_META_SHIFT_KEYS = new Set(['S']);

  let overlay;
  let watermark;
  let watermarkGrid;
  let watermarkTimer;
  let overlayActive = false;

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function normalizeIdentityText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function readIdentity() {
    for (const key of IDENTITY_KEYS) {
      let raw = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        raw = null;
      }
      if (!raw) continue;
      const parsed = safeJsonParse(raw);
      if (parsed && typeof parsed === 'object') {
        const candidate =
          parsed.username ||
          parsed.user ||
          parsed.name ||
          parsed.label ||
          parsed.identity ||
          parsed.email;
        const normalized = normalizeIdentityText(candidate);
        if (normalized) return normalized;
      }
      const plain = normalizeIdentityText(raw);
      if (plain && plain[0] !== '{' && plain[0] !== '[') return plain;
    }
    return 'Operator';
  }

  function formatTimestamp(date) {
    try {
      return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'Asia/Jakarta',
      }).format(date) + ' WIB';
    } catch {
      return date.toLocaleString('id-ID');
    }
  }

  function watermarkText() {
    return [
      'CONFIDENTIAL - RAHMAH TRAVEL',
      readIdentity(),
      formatTimestamp(new Date()),
    ].join('\n');
  }

  function createOverlay() {
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className = 'screen-protection-overlay';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = [
      '<div class="screen-protection-overlay__content">',
      '<div class="screen-protection-overlay__title">Layar Dilindungi</div>',
      '<div class="screen-protection-overlay__text">Konten sensitif disembunyikan saat jendela tidak aktif atau terdeteksi aksi tangkapan layar. Klik layar untuk melanjutkan.</div>',
      '</div>',
    ].join('');
    el.addEventListener('click', handleOverlayDismiss);
    document.body.appendChild(el);
    return el;
  }

  function createWatermark() {
    const el = document.createElement('div');
    el.id = WATERMARK_ID;
    el.className = 'screen-protection-watermark';
    el.setAttribute('aria-hidden', 'true');
    const grid = document.createElement('div');
    grid.className = 'screen-protection-watermark__grid';
    el.appendChild(grid);
    document.body.appendChild(el);
    return { el, grid };
  }

  function renderWatermark() {
    if (!watermarkGrid) return;
    const text = watermarkText();
    const items = [];
    for (let i = 0; i < 24; i += 1) {
      items.push('<div class="screen-protection-watermark__item"></div>');
    }
    watermarkGrid.innerHTML = items.join('');
    watermarkGrid.querySelectorAll('.screen-protection-watermark__item').forEach((item) => {
      item.textContent = text;
    });
  }

  function showOverlay() {
    if (!overlay) return;
    overlayActive = true;
    overlay.classList.add('is-active');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function hideOverlay() {
    if (!overlay) return;
    overlayActive = false;
    overlay.classList.remove('is-active');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function handleOverlayDismiss() {
    if (document.visibilityState === 'hidden') return;
    if (!document.hasFocus()) {
      try {
        window.focus();
      } catch {}
    }
    if (document.visibilityState === 'visible') {
      hideOverlay();
    }
  }

  function isEditableTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .screen-protect-allow')) return true;
    return false;
  }

  function isSensitiveShortcut(event) {
    const key = String(event.key || '');
    const upper = key.toUpperCase();
    const ctrlOrMeta = event.ctrlKey || event.metaKey;
    if (SENSITIVE_KEY_CODES.has(key)) return true;
    if (ctrlOrMeta && upper === 'P') return true;
    if (ctrlOrMeta && upper === 'S') return true;
    if (event.ctrlKey && event.shiftKey && SENSITIVE_CTRL_SHIFT_KEYS.has(upper)) return true;
    if (event.metaKey && event.shiftKey && SENSITIVE_META_SHIFT_KEYS.has(upper)) return true;
    return false;
  }

  function handleSensitiveAction(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    showOverlay();
  }

  function handleKeyDown(event) {
    if (!isSensitiveShortcut(event)) return;
    handleSensitiveAction(event);
  }

  function handleKeyUp(event) {
    if (String(event.key || '') !== 'PrintScreen') return;
    handleSensitiveAction(event);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      showOverlay();
      return;
    }
    if (document.hasFocus()) {
      hideOverlay();
    }
  }

  function handleWindowBlur() {
    showOverlay();
  }

  function handleWindowFocus() {
    if (document.visibilityState === 'visible') {
      hideOverlay();
    }
  }

  function handleContextMenu(event) {
    event.preventDefault();
  }

  function handleCopyCut(event) {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  }

  function handleSelectStart(event) {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  }

  function handleDragStart(event) {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  }

  function handleBeforePrint() {
    showOverlay();
  }

  function handleAfterPrint() {
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      hideOverlay();
    }
  }

  function bindEvents() {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('copy', handleCopyCut, true);
    document.addEventListener('cut', handleCopyCut, true);
    document.addEventListener('selectstart', handleSelectStart, true);
    document.addEventListener('dragstart', handleDragStart, true);
    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);
  }

  function init() {
    if (!document.body) return;
    if (document.getElementById(OVERLAY_ID)) return;
    document.body.classList.add('screen-protection-guard');
    overlay = createOverlay();
    const watermarkParts = createWatermark();
    watermark = watermarkParts.el;
    watermarkGrid = watermarkParts.grid;
    renderWatermark();
    watermarkTimer = window.setInterval(renderWatermark, 30000);
    bindEvents();
    if (document.visibilityState === 'hidden' || !document.hasFocus()) {
      showOverlay();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.RahmahScreenProtection = {
    showOverlay,
    hideOverlay,
    refreshWatermark: renderWatermark,
  };
})();
