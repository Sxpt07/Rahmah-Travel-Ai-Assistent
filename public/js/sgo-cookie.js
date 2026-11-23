(function () {
  const STATUS_ENDPOINT = '/api/sgo/cookie';
  const TEST_ENDPOINT = '/api/sgo/cookie/test';
  const META_KEY = 'rahmah.sgo.cookieMeta';
  const AUTH_CODES = new Set([
    'SGO_AUTH',
    'SGO_COOKIE_MISSING',
    'SGO_SESSION_MISSING',
  ]);

  const STATE_VIEW = {
    unknown: {
      label: 'Memuat',
      title: 'Memeriksa cookie SGO perangkat ini',
      detail: 'Menghubungi server konsol...',
    },
    active: {
      label: 'Aktif',
      title: 'Cookie SGO tersimpan di perangkat ini',
      detail:
        'Semua modul SGO memakai sesi ini. Klik Tes Koneksi untuk memastikan sesi masih berlaku.',
    },
    empty: {
      label: 'Kosong',
      title: 'Cookie SGO belum diatur di perangkat ini',
      detail:
        'Tempel cookie sgo_admin_session dari SGO Admin, lalu simpan. Cookie hanya tersimpan di browser ini.',
    },
    expired: {
      label: 'Kedaluwarsa',
      title: 'Sesi SGO perlu diperbarui',
      detail:
        'Cookie tersimpan tetapi ditolak SGO. Tempel cookie baru dari SGO Admin, lalu simpan.',
    },
  };

  const elements = {
    button: document.getElementById('sgo-cookie-btn'),
    buttonState: document.getElementById('sgo-cookie-state'),
    modal: document.getElementById('sgo-cookie-modal'),
    backdrop: document.getElementById('sgo-cookie-backdrop'),
    close: document.getElementById('sgo-cookie-close'),
    modalState: document.getElementById('sgo-cookie-modal-state'),
    modalStateTitle: document.getElementById('sgo-cookie-status-title'),
    modalStateDetail: document.getElementById('sgo-cookie-status-detail'),
    input: document.getElementById('sgo-cookie-input'),
    feedback: document.getElementById('sgo-cookie-feedback'),
    save: document.getElementById('sgo-cookie-save'),
    test: document.getElementById('sgo-cookie-test'),
    reset: document.getElementById('sgo-cookie-reset'),
    sidebarOpen: document.getElementById('jamaah-cookie-open'),
    sidebarState: document.getElementById('jamaah-cookie-sidebar-state'),
  };

  let currentState = 'unknown';
  let savedActive = false;
  let busy = false;
  let lastFocused = null;

  function readMeta() {
    try {
      const parsed = JSON.parse(localStorage.getItem(META_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return null;
      if (!STATE_VIEW[parsed.state]) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function writeMeta(state, message) {
    try {
      localStorage.setItem(
        META_KEY,
        JSON.stringify({
          state,
          message: String(message || ''),
          checkedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {}
  }

  function applyState(state, { message = '' } = {}) {
    const nextState = STATE_VIEW[state] ? state : 'unknown';
    const view = STATE_VIEW[nextState];
    currentState = nextState;

    if (elements.button) {
      elements.button.classList.toggle('is-active', nextState === 'active');
      elements.button.classList.toggle('is-empty', nextState === 'empty');
      elements.button.classList.toggle('is-expired', nextState === 'expired');
      elements.button.dataset.state = nextState;
      elements.button.title = message || view.title;
      elements.button.setAttribute(
        'aria-label',
        `Cookie SGO: ${view.label}. ${message || view.title}`,
      );
    }

    if (elements.buttonState) elements.buttonState.textContent = view.label;

    if (elements.modalState) elements.modalState.dataset.state = nextState;
    if (elements.modalStateTitle) {
      elements.modalStateTitle.textContent = view.title;
    }
    if (elements.modalStateDetail) {
      elements.modalStateDetail.textContent = message || view.detail;
    }

    if (elements.sidebarState) {
      elements.sidebarState.dataset.state = nextState;
      elements.sidebarState.textContent = message
        ? `Status: ${view.label} — ${message}`
        : `Status: ${view.label}. ${view.detail}`;
    }

    if (nextState !== 'unknown') writeMeta(nextState, message);
  }

  function setFeedback(type, message) {
    if (!elements.feedback) return;
    const text = String(message || '').trim();
    elements.feedback.classList.toggle('hidden', !text);
    elements.feedback.classList.remove('is-info', 'is-success', 'is-error');
    if (!text) return;
    const tone =
      type === 'success' ? 'is-success' : type === 'error' ? 'is-error' : 'is-info';
    elements.feedback.classList.add(tone);
    elements.feedback.textContent = text;
  }

  function setBusy(value) {
    busy = Boolean(value);
    for (const element of [elements.save, elements.test, elements.reset]) {
      if (element) element.disabled = busy;
    }
    if (elements.button) {
      elements.button.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function notify(title, message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, type || 'info');
    }
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  async function refreshStatus() {
    try {
      const response = await fetch(STATUS_ENDPOINT, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const data = await response.json().catch(() => null);
      const active = Boolean(data && data.active);
      savedActive = active;

      if (!active) {
        applyState('empty', {
          message: data && data.message ? data.message : '',
        });
        return;
      }

      if (currentState === 'expired') {
        applyState('expired');
        return;
      }

      applyState('active', {
        message: data && data.message ? data.message : '',
      });
    } catch (error) {
      if (currentState === 'unknown') {
        applyState('empty', {
          message:
            'Status cookie belum dapat diperiksa. Klik tombol ini untuk mengatur cookie SGO.',
        });
      }
    }
  }

  function openModal() {
    if (!elements.modal) return;
    lastFocused = document.activeElement;
    elements.modal.classList.remove('hidden');
    elements.modal.classList.add('flex');
    elements.modal.setAttribute('aria-hidden', 'false');
    setFeedback('info', '');
    refreshStatus();
    refreshIcons();
    if (elements.input) {
      elements.input.value = '';
      window.setTimeout(() => elements.input.focus(), 60);
    }
  }

  function closeModal() {
    if (!elements.modal) return;
    elements.modal.classList.add('hidden');
    elements.modal.classList.remove('flex');
    elements.modal.setAttribute('aria-hidden', 'true');
    if (elements.input) elements.input.value = '';
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  async function saveCookie() {
    if (busy) return;
    const value = elements.input ? elements.input.value.trim() : '';
    if (!value) {
      setFeedback('error', 'Tempel cookie SGO terlebih dahulu sebelum menyimpan.');
      if (elements.input) elements.input.focus();
      return;
    }

    setBusy(true);
    setFeedback('info', 'Menyimpan cookie ke perangkat ini...');
    try {
      const response = await fetch(STATUS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ cookie: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        setFeedback(
          'error',
          data.error || 'Cookie SGO gagal disimpan. Periksa kembali nilai yang ditempel.',
        );
        return;
      }

      savedActive = true;
      applyState('active', {
        message: data.message || 'Cookie SGO tersimpan di perangkat ini.',
      });
      setFeedback(
        'success',
        `${data.message || 'Cookie SGO tersimpan di perangkat ini.'} Lanjutkan dengan Tes Koneksi.`,
      );
      if (elements.input) elements.input.value = '';
      notify('Cookie SGO', 'Cookie tersimpan di perangkat ini.', 'success');
    } catch (error) {
      setFeedback(
        'error',
        `Tidak dapat menyimpan cookie: ${error.message || 'jaringan gagal'}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function testCookie() {
    if (busy) return;
    const value = elements.input ? elements.input.value.trim() : '';
    setBusy(true);
    setFeedback(
      'info',
      value
        ? 'Menguji cookie yang ditempel ke SGO Admin...'
        : 'Menguji cookie tersimpan ke SGO Admin...',
    );

    try {
      const response = await fetch(TEST_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(value ? { cookie: value } : {}),
      });
      const data = await response.json().catch(() => ({}));
      const message =
        data.message ||
        data.error ||
        (response.ok
          ? 'Cookie SGO berhasil diverifikasi.'
          : 'Cookie SGO tidak dapat diverifikasi.');

      if (response.ok && data.success) {
        if (value) {
          setFeedback(
            'success',
            `${message} Klik Simpan Cookie agar perangkat ini memakai cookie tersebut.`,
          );
        } else {
          savedActive = true;
          applyState('active', { message });
          setFeedback('success', message);
        }
        notify('Tes Cookie SGO', message, 'success');
        return;
      }

      if (!value) {
        if (data.code === 'SGO_AUTH') {
          applyState('expired', { message });
        } else if (data.code === 'SGO_COOKIE_MISSING') {
          applyState('empty', { message });
        }
      }
      setFeedback('error', message);
    } catch (error) {
      setFeedback(
        'error',
        `Tes cookie gagal: ${error.message || 'jaringan tidak tersedia'}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function resetCookie() {
    if (busy) return;
    const confirmed = window.confirm(
      'Hapus cookie SGO dari perangkat ini? Modul SGO akan meminta cookie baru.',
    );
    if (!confirmed) return;

    setBusy(true);
    setFeedback('info', 'Menghapus cookie dari perangkat ini...');
    try {
      const response = await fetch(STATUS_ENDPOINT, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        setFeedback('error', data.error || 'Cookie SGO gagal dihapus.');
        return;
      }

      savedActive = false;
      applyState('empty', {
        message: data.message || 'Cookie SGO dihapus dari perangkat ini.',
      });
      setFeedback(
        'success',
        data.message || 'Cookie SGO dihapus dari perangkat ini.',
      );
      if (elements.input) elements.input.value = '';
      notify('Cookie SGO', 'Cookie dihapus dari perangkat ini.', 'info');
    } catch (error) {
      setFeedback(
        'error',
        `Tidak dapat menghapus cookie: ${error.message || 'jaringan gagal'}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  function markExpired(message) {
    const detail =
      String(message || '').trim() || STATE_VIEW.expired.detail;
    const changed = currentState !== 'expired';
    applyState('expired', { message: detail });
    if (changed && (!elements.modal || elements.modal.classList.contains('hidden'))) {
      notify(
        'Cookie SGO kedaluwarsa',
        'Buka tombol Cookie SGO di header untuk memperbarui sesi.',
        'warning',
      );
    }
  }

  function markEmpty(message) {
    const detail = String(message || '').trim() || STATE_VIEW.empty.detail;
    const changed = currentState !== 'empty';
    applyState('empty', { message: detail });
    if (changed && (!elements.modal || elements.modal.classList.contains('hidden'))) {
      notify(
        'Cookie SGO belum diatur',
        'Buka tombol Cookie SGO di header untuk menempelkan sesi.',
        'warning',
      );
    }
  }

  function handleApiError(data) {
    const code = String((data && data.code) || '').toUpperCase();
    if (!AUTH_CODES.has(code)) return;
    const message = String((data && data.error) || '').trim();
    if (code === 'SGO_AUTH') {
      markExpired(message);
      return;
    }
    markEmpty(message);
  }

  function installFetchObserver() {
    if (typeof window.fetch !== 'function' || window.fetch.__rahmahSgoObserved) {
      return;
    }
    const originalFetch = window.fetch.bind(window);
    const observedFetch = async function (...args) {
      const response = await originalFetch(...args);
      try {
        const requestUrl =
          typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (String(requestUrl).includes('/api/sgo/cookie')) return response;
        if (response.ok) return response;
        const contentType = response.headers && response.headers.get
          ? response.headers.get('content-type') || ''
          : '';
        if (!contentType.includes('application/json')) return response;
        response
          .clone()
          .json()
          .then(handleApiError)
          .catch(() => {});
      } catch (error) {}
      return response;
    };
    observedFetch.__rahmahSgoObserved = true;
    window.fetch = observedFetch;
  }

  function bindEvents() {
    if (elements.button) {
      elements.button.addEventListener('click', openModal);
    }
    if (elements.sidebarOpen) {
      elements.sidebarOpen.addEventListener('click', openModal);
    }
    if (elements.close) {
      elements.close.addEventListener('click', closeModal);
    }
    if (elements.backdrop) {
      elements.backdrop.addEventListener('click', closeModal);
    }
    if (elements.save) {
      elements.save.addEventListener('click', saveCookie);
    }
    if (elements.test) {
      elements.test.addEventListener('click', testCookie);
    }
    if (elements.reset) {
      elements.reset.addEventListener('click', resetCookie);
    }
    if (elements.input) {
      elements.input.addEventListener('input', () => {
        if (elements.feedback && !elements.feedback.classList.contains('hidden')) {
          setFeedback('info', '');
        }
      });
      elements.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          saveCookie();
        }
      });
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && elements.modal && !elements.modal.classList.contains('hidden')) {
        closeModal();
      }
    });
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === 'rahmah-sgo-auth-expired') {
        markExpired('Sesi SGO pada halaman proxy sudah tidak valid.');
      }
    });
  }

  function init() {
    const meta = readMeta();
    if (meta && (meta.state === 'expired' || meta.state === 'active' || meta.state === 'empty')) {
      applyState(meta.state, { message: meta.message || '' });
    }
    bindEvents();
    installFetchObserver();
    refreshStatus();
  }

  window.RahmahSgoCookie = {
    open: openModal,
    close: closeModal,
    refresh: refreshStatus,
    markExpired,
    markEmpty,
    getState: () => currentState,
    getSavedActive: () => savedActive,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
