/**
 * Progress sinkronisasi SGO real-time.
 *
 * Server menyimpan status sinkronisasi di memori dan UI melakukan polling
 * ringan ke /api/jamaah/scrape-progress. Tidak ada timer palsu: persentase
 * berasal dari halaman SGO yang benar-benar selesai diproses.
 */
(() => {
  const PROGRESS_ENDPOINT = '/api/jamaah/scrape-progress';
  const DEFAULT_ENDPOINT = '/api/jamaah/scrape-cookie';
  const POLL_MS = 700;
  const IDLE_TIMEOUT_MS = 45 * 60 * 1000;
  const HIDE_DELAY_MS = 15000;

  const running = new WeakMap();

  function q(panel, name) {
    return panel ? panel.querySelector(`[data-sync-${name}]`) : null;
  }

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('id-ID');
  }

  function setText(node, value) {
    if (node) node.textContent = String(value == null ? '' : value);
  }

  function setBar(panel, percent) {
    const value = clampPercent(percent);
    const rounded = Math.round(value);
    const bar = q(panel, 'bar');
    if (bar) bar.style.width = `${value}%`;
    const track = panel ? panel.querySelector('[role="progressbar"]') : null;
    if (track) track.setAttribute('aria-valuenow', String(rounded));
    setText(q(panel, 'percent'), `${rounded}%`);
    if (panel) panel.dataset.syncPercent = String(value);
  }

  function renderSummary(panel, summary) {
    const box = q(panel, 'summary');
    if (!box) return;

    if (!summary || typeof summary !== 'object') {
      box.replaceChildren();
      box.hidden = true;
      return;
    }

    const items = [
      { label: 'jamaah', value: summary.totalJamaah },
      { label: 'dokumen diperbarui', value: summary.documentsUpdated },
      { label: 'halaman', value: summary.pagesFetched },
      { label: 'order', value: summary.orders },
      { label: 'RTB', value: summary.rtb },
      { label: 'lengkap', value: summary.complete, tone: 'is-good' },
      {
        label: 'missing',
        value: summary.missing,
        tone: Number(summary.missing || 0) > 0 ? 'is-warn' : 'is-good',
      },
    ];

    const nodes = items.map((item) => {
      const chip = document.createElement('span');
      chip.className = `sync-chip${item.tone ? ` ${item.tone}` : ''}`;
      const strong = document.createElement('strong');
      strong.textContent = formatNumber(item.value);
      chip.append(strong, document.createTextNode(` ${item.label}`));
      return chip;
    });

    box.replaceChildren(...nodes);
    box.hidden = false;
  }

  function setPanelState(panel, state) {
    if (!panel) return;
    panel.classList.remove('is-running', 'is-done', 'is-error');
    if (state) panel.classList.add(state);
  }

  function showPanel(panel, { label = '', message = '', detail = '' } = {}) {
    if (!panel) return;
    panel.hidden = false;
    panel.classList.remove('hidden');
    setPanelState(panel, 'is-running');
    setBar(panel, 1);
    setText(q(panel, 'label'), label || 'Sinkronisasi SGO');
    setText(q(panel, 'message'), message || 'Menyiapkan sinkronisasi...');
    setText(q(panel, 'detail'), detail || '');
    renderSummary(panel, null);
  }

  function renderProgress(panel, progress = {}) {
    if (!panel) return;
    const previous = Number(panel.dataset.syncPercent || 0);
    const percent = progress.active
      ? Math.max(previous, clampPercent(progress.percent))
      : clampPercent(progress.percent);
    setBar(panel, percent);

    if (progress.label) setText(q(panel, 'label'), progress.label);
    if (progress.message) setText(q(panel, 'message'), progress.message);
    setText(q(panel, 'detail'), progress.detail || '');

    if (!progress.active) {
      if (progress.success === false || progress.phase === 'error') {
        setPanelState(panel, 'is-error');
      } else {
        setPanelState(panel, 'is-done');
      }
      renderSummary(panel, progress.summary);
    }
  }

  function showError(panel, message) {
    if (!panel) return;
    panel.hidden = false;
    panel.classList.remove('hidden');
    setPanelState(panel, 'is-error');
    setBar(panel, 100);
    setText(q(panel, 'message'), message || 'Sinkronisasi gagal.');
    setText(q(panel, 'detail'), 'Periksa koneksi SGO lalu coba lagi.');
  }

  function clearHideTimer(panel) {
    if (!panel) return;
    const timer = panel.dataset.syncHideTimer;
    if (timer) {
      clearTimeout(Number(timer));
      delete panel.dataset.syncHideTimer;
    }
  }

  function scheduleHide(panel, delay = HIDE_DELAY_MS) {
    if (!panel) return;
    clearHideTimer(panel);
    const timer = window.setTimeout(() => {
      panel.classList.add('hidden');
      delete panel.dataset.syncHideTimer;
    }, delay);
    panel.dataset.syncHideTimer = String(timer);
  }

  function setButtonBusy(button, busy, label = 'Menyinkronkan...') {
    if (!button) return;

    if (busy) {
      if (!button.dataset.syncOriginal) {
        button.dataset.syncOriginal = button.innerHTML;
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');

      const spinner = document.createElement('span');
      spinner.className = 'sync-btn-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = label;
      button.replaceChildren(spinner, text);
      return;
    }

    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.syncOriginal) {
      button.innerHTML = button.dataset.syncOriginal;
      delete button.dataset.syncOriginal;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  async function fetchProgress() {
    try {
      const response = await fetch(PROGRESS_ENDPOINT, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data?.progress || null;
    } catch (error) {
      return null;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function pollOnce(panel, onProgress, requestStartedAt = 0) {
    const progress = await fetchProgress();
    if (!progress) return null;

    // Status kosong sebelum server memulai sesi baru tidak boleh menimpa
    // panel "Menghubungi SGO Admin...".
    if (!progress.active && progress.phase === 'idle') return null;

    // Abaikan status lama yang sudah selesai sebelum request ini dimulai,
    // agar bar tidak sempat melompat ke 100% lalu mundur.
    if (!progress.active && requestStartedAt) {
      const started = Date.parse(progress.startedAt || '');
      if (Number.isFinite(started) && started < requestStartedAt - 1500) {
        return null;
      }
    }

    if (panel) {
      panel.hidden = false;
      panel.classList.remove('hidden');
      renderProgress(panel, progress);
    }
    if (typeof onProgress === 'function') onProgress(progress);
    return progress;
  }

  async function waitUntilIdle(panel, onProgress, requestStartedAt) {
    const startedAt = Date.now();
    let last = null;

    while (Date.now() - startedAt < IDLE_TIMEOUT_MS) {
      const progress = await pollOnce(panel, onProgress, requestStartedAt);
      if (progress) last = progress;
      if (progress && !progress.active) return progress;
      await delay(POLL_MS);
    }

    return last;
  }

  /**
   * Jalankan aksi sinkronisasi dan tampilkan progress bar sampai selesai.
   * POST berjalan bersamaan dengan polling; respons akhir tetap dipakai
   * sebagai sumber ringkasan resmi.
   */
  async function run({
    panel,
    button,
    endpoint = DEFAULT_ENDPOINT,
    body = {},
    label = 'Sinkronisasi SGO',
    busyLabel = 'Menyinkronkan...',
    autoHideMs = HIDE_DELAY_MS,
    onProgress,
    onComplete,
    onError,
  } = {}) {
    if (panel && running.has(panel)) {
      return { ok: false, busy: true, error: 'Sinkronisasi masih berjalan.' };
    }

    clearHideTimer(panel);
    showPanel(panel, {
      label,
      message: 'Menghubungi SGO Admin...',
      detail: 'Progress akan bertambah sesuai halaman yang selesai diproses.',
    });
    setButtonBusy(button, true, busyLabel);

    const requestStartedAt = Date.now();
    let lastProgress = null;
    let timer = null;

    if (panel) running.set(panel, true);

    try {
      const request = fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });

      if (panel) {
        const poll = async () => {
          const progress = await pollOnce(panel, onProgress, requestStartedAt);
          if (progress) lastProgress = progress;
        };
        timer = window.setInterval(poll, POLL_MS);
      }

      const response = await request;
      let data = {};
      try {
        data = await response.json();
      } catch (error) {
        data = {};
      }

      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (panel) running.delete(panel);

      const finalProgress = await pollOnce(panel, onProgress, requestStartedAt);
      if (finalProgress) lastProgress = finalProgress;

      if (response.status === 409 && data.busy) {
        const idle = await waitUntilIdle(panel, onProgress, requestStartedAt);
        if (idle) lastProgress = idle;
        if (lastProgress) renderProgress(panel, lastProgress);
        if (typeof onComplete === 'function') {
          onComplete({
            success: lastProgress ? lastProgress.success !== false : true,
            busy: true,
            message: lastProgress?.message || 'Sinkronisasi selesai.',
            syncSummary: lastProgress?.summary || null,
          });
        }
        scheduleHide(panel, autoHideMs);
        return { ok: true, busy: true, data: lastProgress || data };
      }

      if (response.ok && data.success) {
        const done = {
          ...(lastProgress || {}),
          active: false,
          success: true,
          phase: 'done',
          percent: 100,
          message: data.message || lastProgress?.message || 'Sinkronisasi selesai.',
          summary: data.syncSummary || lastProgress?.summary || null,
        };
        if (panel) renderProgress(panel, done);
        if (typeof onComplete === 'function') onComplete(data);
        scheduleHide(panel, autoHideMs);
        return { ok: true, data, progress: done };
      }

      const message = data.error || 'Sinkronisasi SGO gagal.';
      showError(panel, message);
      if (typeof onError === 'function') onError(message, data);
      return { ok: false, error: message, data };
    } catch (error) {
      if (timer) clearInterval(timer);
      if (panel) running.delete(panel);
      const message =
        error.message === 'Failed to fetch'
          ? 'Koneksi ke server terputus saat sinkronisasi.'
          : error.message || 'Sinkronisasi SGO gagal.';
      showError(panel, message);
      if (typeof onError === 'function') onError(message, null);
      return { ok: false, error: message, data: null };
    } finally {
      setButtonBusy(button, false);
    }
  }

  /**
   * Tampilkan progress yang sudah berjalan (mis. halaman baru dimuat saat
   * admin menjalankan sinkronisasi dari tab lain).
   */
  async function attach(panel, { onProgress } = {}) {
    if (!panel || running.has(panel)) return null;

    // Jangan tampilkan panel dari sesi yang sudah selesai saat halaman baru
    // dibuka. Panel hanya perlu muncul jika sync memang masih berjalan.
    const progress = await fetchProgress();
    if (!progress || (!progress.active && progress.phase === 'idle')) {
      return progress || null;
    }
    if (!progress.active) return progress;
    if (typeof onProgress === 'function') onProgress(progress);

    panel.hidden = false;
    panel.classList.remove('hidden');
    renderProgress(panel, progress);

    running.set(panel, true);
    const startedAt = Date.now();
    const poll = async () => {
      const latest = await pollOnce(panel, onProgress);
      if (!latest || !latest.active) {
        running.delete(panel);
        clearInterval(timer);
        if (latest) scheduleHide(panel, HIDE_DELAY_MS);
        return;
      }
      if (Date.now() - startedAt > IDLE_TIMEOUT_MS) {
        running.delete(panel);
        clearInterval(timer);
      }
    };
    const timer = window.setInterval(poll, POLL_MS * 2);
    return progress;
  }

  window.SgoSync = {
    run,
    attach,
    fetchProgress,
    showError,
    hide: (panel) => {
      if (panel) panel.classList.add('hidden');
    },
  };
})();
