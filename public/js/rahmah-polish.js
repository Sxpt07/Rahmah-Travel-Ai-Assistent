/**
 * Modal "Rapihin Kata" (Rahmah Style).
 *
 * Dipakai bersama oleh FU dokumen, FU Pelunasan, dan balasan chat operasional.
 * Alur: buka -> teks langsung dirapikan -> admin bisa edit -> salin 1 klik.
 * Bila endpoint AI gagal, teks tetap dirapikan dengan gaya lokal di browser.
 */
(function () {
  'use strict';

  const ENDPOINT = '/api/message/rapihin';
  const MAX_LENGTH = 6000;
  const COPY_FEEDBACK_MS = 1900;
  const REQUEST_TIMEOUT_MS = 50000;

  let els = null;
  let state = {
    trigger: null,
    facts: [],
    mode: 'fu',
    requestId: 0,
    busy: false,
    lastSource: '',
    controller: null,
    format: '',
    formatOptions: {},
  };

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function toast(title, message, type = 'success') {
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, type);
    }
  }

  function normalizeNewlines(value = '') {
    return String(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+$/gm, '')
      .replace(/[\t ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function sanitizeForWhatsApp(value = '') {
    let text = normalizeNewlines(value);
    text = text.replace(/^```[a-z0-9-]*[ \t]*$/gim, '');
    text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, (_, title) => {
      const clean = String(title).trim();
      return clean ? `*${clean}*` : '';
    });
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi,
      (_, label, url) => `${String(label).trim()}: ${url}`,
    );
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
    text = text.replace(/`([^`]+)`/g, '$1');
    return normalizeNewlines(text);
  }

  function applyOutputFormat(value = '') {
    const output = String(value == null ? '' : value);
    if (state.format !== 'fu-pelunasan') return output;

    const formatter = window.RahmahMessageFormat;
    if (!formatter || typeof formatter.canonicalizeFuPelunasanText !== 'function') {
      return output;
    }

    return formatter.canonicalizeFuPelunasanText(
      output,
      state.formatOptions || {},
    );
  }

  function localPolish(value = '', mode = 'fu') {
    const urls = [];
    let text = String(value).replace(/https?:\/\/[^\s)>\]]+/gi, (url) => {
      const token = `__RP_URL_${urls.length}__`;
      urls.push(url);
      return token;
    });

    const replacements = [
      [/\bharus\b/gi, 'perlu'],
      [/\bwajib\b/gi, 'perlu'],
      [/\bmenunggak\b/gi, 'masih memiliki sisa pembayaran'],
      [/\bnunggak\b/gi, 'masih memiliki sisa pembayaran'],
      [/\bterlambat\b/gi, 'melewati jadwal'],
      [/\btelat\b/gi, 'melewati jadwal'],
      [/\bmenagih\b/gi, 'mengingatkan dengan santun'],
      [/\baku\b/gi, (match) => (match[0] === 'A' ? 'Kami' : 'kami')],
      [/\bkakak\b/gi, 'Bapak/Ibu'],
      [/\bkak\b/gi, 'Bapak/Ibu'],
    ];
    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement);
    }

    text = sanitizeForWhatsApp(text).replace(
      /__RP_URL_(\d+)__/g,
      (_, index) => urls[Number(index)] || '',
    );

    if (!/assalamu['’]?alaikum/i.test(text.slice(0, 240))) {
      text = `Assalamu'alaikum warahmatullahi wabarakatuh.\n\n${text}`;
    }

    const tail = text.slice(-220);
    if (mode === 'fu') {
      if (!/(wassalamu|terima kasih|salam hangat)/i.test(tail)) {
        text += '\n\nTerima kasih banyak atas perhatian dan kerja sama Bapak/Ibu. 🙏';
      }
      if (!/rahmah travel/i.test(text)) {
        text += '\n\nSalam hangat,\nRahmah Travel';
      }
    } else if (!/(terima kasih|semoga|salam hangat)/i.test(tail)) {
      text += '\n\nSemoga informasinya membantu, Bapak/Ibu. 🙏';
    }

    return normalizeNewlines(text);
  }

  async function copyText(text = '') {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        /* lanjut ke fallback */
      }
    }

    const helper = document.createElement('textarea');
    helper.value = text;
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

  function setStatus(text, tone = 'busy') {
    if (!els) return;
    els.statusText.textContent = text;
    els.status.classList.remove('is-busy', 'is-ready', 'is-warn');
    els.status.classList.add(`is-${tone}`);
  }

  function setBusy(busy) {
    state.busy = busy;
    if (!els) return;
    els.textarea.disabled = busy;
    els.retry.disabled = busy;
    els.copy.disabled = busy || !els.textarea.value.trim();
    els.status.setAttribute('aria-busy', String(busy));
  }

  function updateCount() {
    if (!els) return;
    const length = els.textarea.value.length;
    els.count.textContent = `${length.toLocaleString('id-ID')}/${MAX_LENGTH.toLocaleString('id-ID')}`;
    els.copy.disabled = state.busy || !els.textarea.value.trim();
  }

  function showError(message = '') {
    if (!els) return;
    const text = String(message || '').trim();
    els.error.hidden = !text;
    els.error.textContent = text;
  }

  async function refine() {
    if (!els) return;
    const text = els.textarea.value.trim();
    if (!text) {
      showError('Teks yang ingin dirapikan masih kosong.');
      return;
    }

    const requestId = state.requestId + 1;
    state.requestId = requestId;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const timeoutTimer = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    showError('');
    setBusy(true);
    setStatus('Menghaluskan dengan Rahmah Style...', 'busy');

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          text,
          mode: state.mode,
          facts: state.facts,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.text) {
        throw new Error(data.error || 'Gagal merapikan teks.');
      }
      if (requestId !== state.requestId) return;

      els.textarea.value = applyOutputFormat(String(data.text)).trim();
      state.lastSource = String(data.source || '');
      if (data.source === 'gemini') {
        setStatus(
          data.model
            ? `Dirapikan dengan AI Rahmah Style • ${data.model}`
            : 'Dirapikan dengan AI Rahmah Style',
          'ready',
        );
      } else {
        setStatus('Dirapikan dengan gaya lokal Rahmah Style', 'ready');
      }
      updateCount();
    } catch (error) {
      if (requestId !== state.requestId) return;
      // Jaringan/server gagal: tetap berikan hasil rapi versi lokal.
      els.textarea.value = applyOutputFormat(
        localPolish(text, state.mode),
      ).trim();
      state.lastSource = 'local-fallback';
      setStatus('Server belum merespons — memakai gaya lokal', 'warn');
      updateCount();
    } finally {
      window.clearTimeout(timeoutTimer);
      if (state.controller === controller) state.controller = null;
      if (requestId === state.requestId) {
        setBusy(false);
        if (els && !els.overlay.hidden) {
          els.textarea.focus({ preventScroll: true });
        }
      }
    }
  }

  async function copyResult() {
    if (!els) return;
    const text = els.textarea.value.trim();
    if (!text) {
      showError('Belum ada teks untuk disalin.');
      return;
    }

    const originalHtml = els.copy.innerHTML;
    try {
      await copyText(text);
      els.copy.classList.add('is-copied');
      els.copy.innerHTML = '<span>✓ Tersalin!</span>';
      refreshIcons();
      toast('Tersalin', 'Teks Rahmah Style siap ditempel di WhatsApp.', 'success');

      window.setTimeout(() => {
        if (!els) return;
        els.copy.classList.remove('is-copied');
        els.copy.innerHTML = originalHtml;
        refreshIcons();
      }, COPY_FEEDBACK_MS);
    } catch (error) {
      showError('Browser menolak akses clipboard. Salin manual dari kotak teks.');
      toast('Gagal menyalin', 'Salin manual dari kotak teks.', 'error');
    }
  }

  function close() {
    if (!els || els.overlay.hidden) return;
    state.requestId += 1;
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }
    els.overlay.hidden = true;
    document.body.classList.remove('rp-open');
    const trigger = state.trigger;
    state.trigger = null;
    if (trigger && typeof trigger.focus === 'function') {
      window.setTimeout(() => trigger.focus(), 30);
    }
  }

  function ensure() {
    if (els) return els;

    const overlay = document.createElement('div');
    overlay.id = 'rahmah-polish';
    overlay.className = 'rp-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="rp-backdrop" data-rp-close></div>
      <section class="rp-panel" role="dialog" aria-modal="true"
        aria-labelledby="rp-title" aria-describedby="rp-subtitle">
        <header class="rp-head">
          <span class="rp-mark" aria-hidden="true">
            <i data-lucide="sparkles"></i>
          </span>
          <div class="rp-heading">
            <p class="rp-kicker">Rahmah Style</p>
            <h2 id="rp-title" class="rp-title">Rapihin Kata</h2>
            <p id="rp-subtitle" class="rp-subtitle" data-rp-subtitle></p>
          </div>
          <button type="button" class="rp-close" data-rp-close aria-label="Tutup Rapihin Kata">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="rp-body">
          <div class="rp-status is-busy" data-rp-status aria-live="polite">
            <span class="rp-status__dot" aria-hidden="true"></span>
            <span data-rp-status-text>Menghaluskan dengan Rahmah Style...</span>
          </div>

          <label class="rp-label" for="rp-text">Hasil rapi — bisa diedit sebelum disalin</label>
          <textarea id="rp-text" class="rp-textarea" maxlength="${MAX_LENGTH}"
            spellcheck="true" placeholder="Teks hasil rapi akan muncul di sini..."></textarea>

          <div class="rp-meta">
            <span data-rp-count>0/${MAX_LENGTH.toLocaleString('id-ID')}</span>
            <span>Periksa kembali sebelum dikirim ke jamaah</span>
          </div>

          <details class="rp-original">
            <summary>Lihat draf asli</summary>
            <pre data-rp-original></pre>
          </details>

          <p class="rp-error" data-rp-error hidden></p>
        </div>

        <footer class="rp-foot">
          <button type="button" class="rp-btn rp-btn--ghost" data-rp-retry>
            <i data-lucide="sparkles"></i>
            <span>Rapihin Lagi</span>
          </button>
          <button type="button" class="rp-btn rp-btn--primary" data-rp-copy>
            <i data-lucide="copy"></i>
            <span>Salin Teks</span>
          </button>
        </footer>
      </section>
    `;

    document.body.appendChild(overlay);

    els = {
      overlay,
      panel: overlay.querySelector('.rp-panel'),
      subtitle: overlay.querySelector('[data-rp-subtitle]'),
      status: overlay.querySelector('[data-rp-status]'),
      statusText: overlay.querySelector('[data-rp-status-text]'),
      textarea: overlay.querySelector('#rp-text'),
      count: overlay.querySelector('[data-rp-count]'),
      original: overlay.querySelector('[data-rp-original]'),
      error: overlay.querySelector('[data-rp-error]'),
      retry: overlay.querySelector('[data-rp-retry]'),
      copy: overlay.querySelector('[data-rp-copy]'),
    };

    overlay.querySelectorAll('[data-rp-close]').forEach((button) => {
      button.addEventListener('click', close);
    });
    els.retry.addEventListener('click', refine);
    els.copy.addEventListener('click', copyResult);
    els.textarea.addEventListener('input', () => {
      showError('');
      updateCount();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els && !els.overlay.hidden) {
        event.preventDefault();
        close();
      }
    });

    refreshIcons();
    return els;
  }

  function open(options = {}) {
    const text = String(options.text == null ? '' : options.text).trim();
    if (!text) {
      toast('Info', 'Draf pesan masih kosong.', 'warning');
      return;
    }

    const api = ensure();
    state = {
      ...state,
      trigger: document.activeElement,
      facts: Array.isArray(options.facts)
        ? options.facts.map((item) => String(item == null ? '' : item).trim()).filter(Boolean)
        : [],
      mode: options.mode === 'chat' ? 'chat' : 'fu',
      requestId: state.requestId + 1,
      busy: false,
      lastSource: '',
      format: options.format === 'fu-pelunasan' ? 'fu-pelunasan' : '',
      formatOptions:
        options.formatOptions && typeof options.formatOptions === 'object'
          ? options.formatOptions
          : {},
    };

    api.subtitle.textContent =
      String(options.subtitle || '').trim() ||
      'Pesan follow-up yang hangat, santun, dan siap dikirim.';
    api.original.textContent = text;
    api.textarea.value = applyOutputFormat(text);
    api.error.hidden = true;
    api.error.textContent = '';
    api.overlay.hidden = false;
    document.body.classList.add('rp-open');
    updateCount();
    refreshIcons();
    api.overlay.querySelector('.rp-panel')?.focus?.();

    window.requestAnimationFrame(() => {
      api.textarea.focus();
      api.textarea.setSelectionRange(api.textarea.value.length, api.textarea.value.length);
    });

    refine();
  }

  window.RahmahPolish = { open, close };
})();
