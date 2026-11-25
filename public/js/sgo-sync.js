(() => {
  const PROGRESS_ENDPOINT = '/api/jamaah/scrape-progress';
  const DEFAULT_ENDPOINT = '/api/jamaah/full-sync';
  const POLL_MS = 700;
  const IDLE_TIMEOUT_MS = 45 * 60 * 1000;
  const HIDE_DELAY_MS = 15000;
  const RETRY_ATTEMPTS = 3;
  const RETRY_BASE_MS = 900;
  const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

  const running = new WeakMap();

  function isTransientFailure(response, data) {
    if (!response) return true;
    if (TRANSIENT_STATUS.has(Number(response.status))) return true;
    return ['SGO_NETWORK', 'SGO_TIMEOUT'].includes(String(data?.code || ''));
  }

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

  function showPanel(panel, { label = '', message = '', detail = '', percent = 1 } = {}) {
    if (!panel) return;
    panel.hidden = false;
    panel.classList.remove('hidden');
    setPanelState(panel, 'is-running');
    setBar(panel, clampPercent(percent));
    setText(q(panel, 'label'), label || 'Sinkronisasi SGO');
    setText(q(panel, 'message'), message || 'Menyiapkan sinkronisasi...');
    setText(q(panel, 'detail'), detail || '');
    renderSummary(panel, null);
  }

  function renderProgress(panel, progress = {}, { updatePercent = true } = {}) {
    if (!panel) return;
    if (updatePercent) {
      const previous = Number(panel.dataset.syncPercent || 0);
      const percent = progress.active
        ? Math.max(previous, clampPercent(progress.percent))
        : clampPercent(progress.percent);
      setBar(panel, percent);
    }

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

  function setButtonBusy(button, busy, label = 'Menyinkronkan...', disableButton = true) {
    if (!button) return;

    if (busy) {
      if (!button.dataset.syncOriginal) {
        button.dataset.syncOriginal = button.innerHTML;
      }
      button.disabled = Boolean(disableButton);
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
    if (!progress.active && progress.phase === 'idle') return null;

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

  async function run({
    panel,
    button,
    endpoint = DEFAULT_ENDPOINT,
    body = {},
    label = 'Sinkronisasi SGO',
    busyLabel = 'Menyinkronkan...',
    autoHideMs = HIDE_DELAY_MS,
    disableButton = true,
    retryAttempts = 1,
    retryBaseMs = RETRY_BASE_MS,
    keepButtonBusy = false,
    manageButton = true,
    onProgress,
    onComplete,
    onError,
    onRetry,
  } = {}) {
    if (panel && running.has(panel)) {
      return { ok: false, busy: true, error: 'Sinkronisasi masih berjalan.' };
    }

    const attempts = Math.max(1, Math.trunc(Number(retryAttempts) || 1));
    const requestStartedAt = Date.now();
    let lastProgress = null;

    clearHideTimer(panel);
    showPanel(panel, {
      label,
      message: 'Menghubungi SGO Admin...',
      detail: 'Progress bertambah sesuai halaman yang selesai diproses.',
    });
    if (manageButton) setButtonBusy(button, true, busyLabel, disableButton);
    if (panel) running.set(panel, true);

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let timer = null;
        let response = null;
        let data = {};
        let networkError = null;

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

          response = await request;
          let rawText = '';
          try {
            rawText = await response.text();
            data = rawText ? JSON.parse(rawText) : {};
          } catch (error) {
            data = rawText ? { error: rawText.slice(0, 280) } : {};
          }

          if (timer) {
            clearInterval(timer);
            timer = null;
          }

          const finalProgress = await pollOnce(panel, onProgress, requestStartedAt);
          if (finalProgress) lastProgress = finalProgress;
        } catch (error) {
          if (timer) clearInterval(timer);
          networkError = error;
        }

        if (!networkError && response) {
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
            if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
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
            if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
            return { ok: true, data, progress: done, attempts: attempt };
          }
        }

        const networkMessage =
          networkError?.message === 'Failed to fetch'
            ? 'Koneksi ke server terputus saat sinkronisasi.'
            : networkError?.message || '';
        const detailParts = [
          data.error || data.message || networkMessage,
          data.code ? `Kode: ${data.code}` : '',
          data.detail && data.detail !== data.error ? data.detail : '',
          response && !response.ok ? `HTTP ${response.status}` : '',
        ].filter(Boolean);
        const message = detailParts[0] || 'Sinkronisasi SGO gagal.';
        const detail = detailParts.slice(1).join(' • ');
        const transient = networkError ? true : isTransientFailure(response, data);

        if (!transient || attempt >= attempts) {
          showError(panel, message);
          if (detail) setText(q(panel, 'detail'), detail);
          if (typeof onError === 'function') onError(message, data);
          return {
            ok: false,
            error: message,
            data,
            status: response?.status || 0,
            attempts: attempt,
          };
        }

        const waitMs = Math.max(0, Number(retryBaseMs) || 0) * 2 ** (attempt - 1);
        if (panel) {
          setPanelState(panel, 'is-running');
          setText(
            q(panel, 'message'),
            `Gagal sementara. Mencoba ulang ${attempt + 1}/${attempts}...`,
          );
          setText(
            q(panel, 'detail'),
            `${message}${detail ? ` • ${detail}` : ''} • jeda ${Math.round(waitMs)}ms`,
          );
        }
        if (typeof onRetry === 'function') {
          onRetry({ attempt, attempts, waitMs, error: message, data });
        }
        await delay(waitMs);
      }

      return { ok: false, error: 'Sinkronisasi SGO gagal.', data: null, attempts };
    } finally {
      if (panel) running.delete(panel);
      if (manageButton && !keepButtonBusy) setButtonBusy(button, false);
    }
  }

  async function runFullSync({
    panel,
    button,
    endpoint = DEFAULT_ENDPOINT,
    body = {},
    label = 'Sinkronisasi Penuh SGO',
    busyLabel = 'Menyinkronkan...',
    autoHideMs = HIDE_DELAY_MS,
    disableButton = true,
    retryAttempts = RETRY_ATTEMPTS,
    retryBaseMs = RETRY_BASE_MS,
    manageButton = true,
    keepButtonBusy = false,
    onProgress,
    onComplete,
    onError,
    onRetry,
  } = {}) {
    return run({
      panel,
      button,
      endpoint,
      body,
      label,
      busyLabel,
      autoHideMs,
      disableButton,
      retryAttempts,
      retryBaseMs,
      manageButton,
      keepButtonBusy,
      onProgress,
      onComplete,
      onError,
      onRetry,
    });
  }

  async function attach(panel, { onProgress } = {}) {
    if (!panel || running.has(panel)) return null;

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
    runFullSync,
    attach,
    fetchProgress,
    showError,
    hide: (panel) => {
      if (panel) panel.classList.add('hidden');
    },
  };
})();
