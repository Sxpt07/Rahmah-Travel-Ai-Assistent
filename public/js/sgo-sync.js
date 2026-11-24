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
  const VALIDATION_ENDPOINT = '/api/jamaah/validate-manifest';
  const POLL_MS = 700;
  const IDLE_TIMEOUT_MS = 45 * 60 * 1000;
  const HIDE_DELAY_MS = 15000;
  const RETRY_ATTEMPTS = 3;
  const RETRY_BASE_MS = 900;
  const MIN_VALIDATION_BATCH = 25;
  const MAX_VALIDATION_BATCH = 50;
  const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

  const running = new WeakMap();
  const batchRunning = new WeakMap();
  const validationRunning = new WeakMap();
  const fullRunning = new WeakMap();

  function isTransientFailure(response, data) {
    if (!response) return true;
    if (TRANSIENT_STATUS.has(Number(response.status))) return true;
    return ['SGO_DEADLINE', 'SGO_NETWORK', 'SGO_TIMEOUT'].includes(
      String(data?.code || ''),
    );
  }

  function jamaahRowKey(row = {}) {
    const manifestId = String(row?.manifestId || row?.jamaahId || '').trim();
    if (manifestId) return `m:${manifestId}`;
    const order = String(
      row?.orderCode || row?.kodeOrder || row?.orderId || '',
    ).trim().toUpperCase();
    const nik = String(row?.nik || row?.ktp || '').replace(/\D+/g, '');
    if (order && nik) return `on:${order}:${nik}`;
    const passport = String(
      row?.passport || row?.paspor || row?.noPaspor || '',
    ).trim().toUpperCase();
    if (order && passport) return `op:${order}:${passport}`;
    const name = String(row?.nama || row?.name || '').trim().toLowerCase();
    if (order && name) return `o:${order}:${name}`;
    if (nik) return `n:${nik}`;
    if (passport) return `p:${passport}`;
    if (order) return `order:${order}`;
    return name ? `name:${name}` : '';
  }

  function mergeJamaahRows(existing = [], incoming = []) {
    const merged = Array.isArray(existing) ? [...existing] : [];
    const index = new Map();
    merged.forEach((row, position) => {
      const key = jamaahRowKey(row);
      if (key) index.set(key, position);
    });
    for (const row of Array.isArray(incoming) ? incoming : []) {
      if (!row || typeof row !== 'object') continue;
      const key = jamaahRowKey(row);
      if (key && index.has(key)) {
        merged[index.get(key)] = { ...merged[index.get(key)], ...row };
        continue;
      }
      if (key) index.set(key, merged.length);
      merged.push(row);
    }
    return merged;
  }

  function overallPercent(pagesDone, totalPages, done = false) {
    if (done) return 100;
    const pages = Math.max(0, Number(pagesDone) || 0);
    const total = Math.max(0, Number(totalPages) || 0);
    if (total > 0) return Math.min(99, (pages / total) * 100);
    return Math.min(95, 95 * (1 - Math.exp(-pages / 45)));
  }

  function batchRangeLabel(startPage, processedPages) {
    const start = Math.max(1, Number(startPage) || 1);
    const processed = Math.max(0, Number(processedPages) || 0);
    if (processed <= 1) return `halaman ${start}`;
    return `halaman ${start}-${start + processed - 1}`;
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

  function validationBatchSize(value) {
    const requested = Math.trunc(Number(value) || MAX_VALIDATION_BATCH);
    return Math.max(MIN_VALIDATION_BATCH, Math.min(MAX_VALIDATION_BATCH, requested));
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

  function showPanel(
    panel,
    {
      label = '',
      message = '',
      detail = '',
      percent = 1,
      preservePercent = false,
    } = {},
  ) {
    if (!panel) return;
    panel.hidden = false;
    panel.classList.remove('hidden');
    setPanelState(panel, 'is-running');
    const previous = Number(panel.dataset.syncPercent || 0);
    setBar(
      panel,
      preservePercent
        ? Math.max(previous, clampPercent(percent))
        : clampPercent(percent),
    );
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

  async function pollOnce(
    panel,
    onProgress,
    requestStartedAt = 0,
    updatePercent = true,
  ) {
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
      renderProgress(panel, progress, { updatePercent });
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
    disableButton = true,
    retryAttempts = 1,
    retryBaseMs = RETRY_BASE_MS,
    progressMode = 'server',
    initialPercent = 1,
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
    const externalPercent = progressMode === 'external';
    const requestStartedAt = Date.now();
    let lastProgress = null;

    clearHideTimer(panel);
    showPanel(panel, {
      label,
      message: 'Menghubungi SGO Admin...',
      detail: 'Progress akan bertambah sesuai halaman yang selesai diproses.',
      percent: initialPercent,
      preservePercent: externalPercent,
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
              const progress = await pollOnce(
                panel,
                onProgress,
                requestStartedAt,
                !externalPercent,
              );
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

          const finalProgress = await pollOnce(
            panel,
            onProgress,
            requestStartedAt,
            !externalPercent,
          );
          if (finalProgress) lastProgress = finalProgress;
        } catch (error) {
          if (timer) clearInterval(timer);
          networkError = error;
        }

        if (!networkError && response) {
          if (response.status === 409 && data.busy) {
            const idle = await waitUntilIdle(
              panel,
              onProgress,
              requestStartedAt,
            );
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
              message:
                data.message || lastProgress?.message || 'Sinkronisasi selesai.',
              summary: data.syncSummary || lastProgress?.summary || null,
            };
            if (panel) {
              renderProgress(panel, done, { updatePercent: !externalPercent });
            }
            if (typeof onComplete === 'function') onComplete(data);
            if (!externalPercent && autoHideMs > 0) {
              scheduleHide(panel, autoHideMs);
            }
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
        const message =
          detailParts[0] || 'Sinkronisasi SGO gagal.';
        const detail = detailParts.slice(1).join(' • ');
        const transient = networkError
          ? true
          : isTransientFailure(response, data);

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
            `Batch gagal sementara. Mencoba ulang ${attempt + 1}/${attempts}...`,
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

  function batchRows(data = {}) {
    if (Array.isArray(data.records)) return data.records;
    if (Array.isArray(data.batchJamaahList)) return data.batchJamaahList;
    if (Array.isArray(data.jamaahList)) return data.jamaahList;
    return [];
  }

  function batchNumber(data = {}, name = '') {
    const direct = Number(data?.[name]);
    if (Number.isFinite(direct)) return direct;
    const nested = Number(data?.batch?.[name]);
    return Number.isFinite(nested) ? nested : 0;
  }

  async function runValidationBatched({
    panel,
    button,
    endpoint = VALIDATION_ENDPOINT,
    body = {},
    startIndex = 0,
    batchSize = MAX_VALIDATION_BATCH,
    label = 'Validasi NIK & Paspor',
    busyLabel = 'Memvalidasi...',
    autoHideMs = 0,
    disableButton = true,
    manageButton = false,
    retryAttempts = RETRY_ATTEMPTS,
    retryBaseMs = RETRY_BASE_MS,
    stopRequested,
    onProgress,
    onValidationProgress,
    onComplete,
    onError,
    onRetry,
  } = {}) {
    if (panel && (validationRunning.has(panel) || running.has(panel))) {
      return { ok: false, busy: true, error: 'Validasi masih berjalan.' };
    }

    const size = validationBatchSize(batchSize);
    let cursor = Math.max(0, Math.trunc(Number(startIndex) || 0));
    let total = Math.max(0, Math.trunc(Number(body?.total) || 0));
    let processed = 0;
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let batchesDone = 0;
    let lastData = null;

    clearHideTimer(panel);
    showPanel(panel, {
      label,
      message: 'Menyiapkan validasi NIK & paspor...',
      detail: `${formatNumber(cursor)} jamaah sudah divalidasi sebelumnya`,
      percent: 1,
    });
    if (manageButton) setButtonBusy(button, true, busyLabel, disableButton);
    if (panel) validationRunning.set(panel, true);

    const emit = (progress) => {
      if (panel) renderProgress(panel, progress);
      if (typeof onProgress === 'function') onProgress(progress);
      if (typeof onValidationProgress === 'function') {
        onValidationProgress(progress, lastData);
      }
    };

    try {
      while (true) {
        if (typeof stopRequested === 'function' && stopRequested()) {
          if (panel) {
            setPanelState(panel, 'is-running');
            setText(q(panel, 'message'), 'Validasi dihentikan sementara.');
            setText(
              q(panel, 'detail'),
              `${formatNumber(processed)}/${formatNumber(total)} tervalidasi • lanjut dari ${formatNumber(cursor)}`,
            );
          }
          if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
          return {
            ok: true,
            stopped: true,
            data: lastData,
            batches: batchesDone,
            validation: {
              processed,
              total,
              ok,
              failed,
              skipped,
              resume: { startIndex: cursor },
            },
          };
        }

        const result = await run({
          panel,
          button,
          endpoint,
          body: { ...body, startIndex: cursor, batchSize: size },
          label: `${label} • ${formatNumber(cursor + 1)}`,
          busyLabel,
          autoHideMs: 0,
          disableButton,
          retryAttempts,
          retryBaseMs,
          progressMode: 'external',
          keepButtonBusy: true,
          manageButton,
          onRetry,
        });

        if (!result.ok) {
          const resume = { startIndex: cursor };
          if (typeof onError === 'function') {
            onError(result.error, result.data, resume);
          }
          return {
            ok: false,
            busy: Boolean(result.busy),
            error: result.error,
            data: result.data,
            status: result.status,
            batches: batchesDone,
            validation: { processed, total, ok, failed, skipped, resume },
          };
        }

        if (result.busy) {
          if (typeof onComplete === 'function') onComplete(result.data, { processed, total });
          return {
            ok: true,
            busy: true,
            data: result.data,
            batches: batchesDone,
            validation: { processed, total, ok, failed, skipped },
          };
        }

        const data = result.data || {};
        const info = data.validation || {};
        lastData = data;
        batchesDone += 1;
        total = Math.max(total, Number(info.total) || 0);

        const next = Number(info.nextIndex);
        cursor = Number.isFinite(next) && next > cursor ? next : cursor + size;
        processed = Math.max(processed, Number(info.processed) || cursor);
        ok += Number(info.ok) || 0;
        failed += Number(info.failed) || 0;
        skipped += Number(info.skipped) || 0;

        const hasMore = Boolean(info.hasMore && total && cursor < total);
        const percent = total > 0 ? Math.min(99, (processed / total) * 100) : 99;
        const message = hasMore
          ? `Memvalidasi NIK & paspor ${formatNumber(processed)}/${formatNumber(total)}...`
          : `Validasi selesai: ${formatNumber(processed)}/${formatNumber(total)}.`;
        const detail =
          `${formatNumber(ok)} OK • ${formatNumber(failed)} gagal • ` +
          `${formatNumber(skipped)} tanpa manifest`;

        emit({
          active: hasMore,
          success: true,
          phase: hasMore ? 'validation' : 'done',
          percent,
          label,
          message,
          detail,
          rows: processed,
          totalJamaah: total,
          startIndex: cursor,
          nextIndex: cursor,
          hasMore,
          batchCount: batchesDone,
          validation: { ...info, processed, total, ok, failed, skipped },
        });

        if (!hasMore) {
          const summary = {
            processed,
            total,
            ok,
            failed,
            skipped,
            batches: batchesDone,
          };
          if (panel) {
            renderProgress(panel, {
              active: false,
              success: true,
              phase: 'done',
              percent: 100,
              label,
              message: data.message || message,
              detail,
              summary: data.syncSummary || null,
            });
          }
          if (typeof onComplete === 'function') onComplete(data, summary);
          if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
          return {
            ok: true,
            data,
            batches: batchesDone,
            validation: summary,
          };
        }
      }
    } finally {
      if (panel) validationRunning.delete(panel);
      if (manageButton) setButtonBusy(button, false);
    }
  }

  async function runBatched({
    panel,
    button,
    endpoint = DEFAULT_ENDPOINT,
    body = {},
    label = 'Sinkronisasi SGO',
    busyLabel = 'Menyinkronkan...',
    autoHideMs = HIDE_DELAY_MS,
    disableButton = true,
    startPage = 1,
    batchPages = 2,
    initialRows = [],
    retryAttempts = RETRY_ATTEMPTS,
    retryBaseMs = RETRY_BASE_MS,
    maxBatches = 4000,
    manageButton = true,
    stopRequested,
    onProgress,
    onBatch,
    onComplete,
    onError,
    onRetry,
  } = {}) {
    if (panel && (batchRunning.has(panel) || running.has(panel))) {
      return { ok: false, busy: true, error: 'Sinkronisasi masih berjalan.' };
    }

    const pagesPerBatch = Math.max(1, Math.min(2, Math.trunc(Number(batchPages) || 2)));
    const batchLimit = Math.max(1, Math.trunc(Number(maxBatches) || 4000));
    let page = Math.max(1, Math.trunc(Number(startPage) || 1));
    let aggregated = Array.isArray(initialRows) ? [...initialRows] : [];
    let batchesDone = 0;
    let lastData = null;
    let lastProgress = null;

    clearHideTimer(panel);
    showPanel(panel, {
      label,
      message: 'Menyiapkan sinkronisasi bertahap...',
      detail: `${formatNumber(aggregated.length)} jamaah tersimpan sementara`,
      percent: aggregated.length ? overallPercent(0, 0) : 1,
    });
    if (manageButton) setButtonBusy(button, true, busyLabel, disableButton);
    if (panel) batchRunning.set(panel, true);

    const emitProgress = (progress) => {
      lastProgress = progress;
      if (panel) renderProgress(panel, progress);
      if (typeof onProgress === 'function') onProgress(progress);
    };

    try {
      while (true) {
        if (typeof stopRequested === 'function' && stopRequested()) {
          if (panel) {
            setPanelState(panel, 'is-running');
            setText(q(panel, 'message'), 'Sinkronisasi dihentikan sementara.');
            setText(
              q(panel, 'detail'),
              `${formatNumber(aggregated.length)} jamaah terkumpul • mulai lagi dari halaman ${page}`,
            );
          }
          if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
          return {
            ok: true,
            stopped: true,
            data: lastData,
            rows: aggregated,
            batches: batchesDone,
            resume: {
              startPage: page,
              rows: aggregated,
              batches: batchesDone,
            },
          };
        }

        if (batchesDone >= batchLimit) {
          const message = `Batas ${batchLimit} batch tercapai. Klik sinkronisasi lagi untuk melanjutkan.`;
          if (panel) {
            setPanelState(panel, 'is-error');
            setText(q(panel, 'message'), message);
            setText(
              q(panel, 'detail'),
              `${formatNumber(aggregated.length)} jamaah • lanjut halaman ${page}`,
            );
          }
          if (typeof onError === 'function') onError(message, lastData);
          return {
            ok: false,
            error: message,
            data: lastData,
            rows: aggregated,
            batches: batchesDone,
            resume: {
              startPage: page,
              rows: aggregated,
              batches: batchesDone,
            },
          };
        }

        const result = await run({
          panel,
          button,
          endpoint,
          body: { ...body, startPage: page, batchPages: pagesPerBatch },
          label: `${label} • halaman ${page}`,
          busyLabel,
          autoHideMs: 0,
          disableButton,
          retryAttempts,
          retryBaseMs,
          progressMode: 'external',
          keepButtonBusy: true,
          manageButton,
          onRetry,
        });

        if (!result.ok) {
          const resume = {
            startPage: page,
            rows: aggregated,
            batches: batchesDone,
          };
          if (typeof onError === 'function') {
            onError(result.error, result.data, resume);
          }
          return {
            ok: false,
            busy: Boolean(result.busy),
            error: result.error,
            data: result.data,
            status: result.status,
            rows: aggregated,
            batches: batchesDone,
            resume,
          };
        }

        if (result.busy) {
          if (typeof onComplete === 'function') onComplete(result.data, aggregated);
          return {
            ok: true,
            busy: true,
            data: result.data,
            rows: aggregated,
            batches: batchesDone,
          };
        }

        const data = result.data || {};
        lastData = data;
        batchesDone += 1;

        const rows = batchRows(data);
        if (rows.length) aggregated = mergeJamaahRows(aggregated, rows);

        const processedPages =
          batchNumber(data, 'processedPages') ||
          batchNumber(data, 'pagesFetched') ||
          pagesPerBatch;
        const totalPages = batchNumber(data, 'totalPages');
        const nextCandidate = batchNumber(data, 'nextPage');
        const hasMore = Boolean(data.hasMore && nextCandidate);
        const nextPage = hasMore ? nextCandidate : null;
        const donePages = nextPage
          ? Math.max(page + processedPages - 1, nextPage - 1, page)
          : totalPages || page + processedPages - 1;
        const percent = overallPercent(donePages, totalPages, !hasMore);

        const range = batchRangeLabel(page, processedPages);
        const message = hasMore
          ? `Sinkronisasi ${range}${totalPages ? ` dari ${formatNumber(totalPages)} halaman` : ''}...`
          : `Sinkronisasi selesai pada ${range}.`;
        const detail = `${formatNumber(aggregated.length)} jamaah terkumpul${
          totalPages ? ` • halaman ${formatNumber(donePages)}/${formatNumber(totalPages)}` : ''
        }`;

        emitProgress({
          ...(lastProgress || {}),
          active: hasMore,
          success: true,
          phase: hasMore ? 'pages' : 'done',
          percent,
          label,
          message,
          detail,
          module: body?.focusModule || lastProgress?.module || '',
          startPage: page,
          nextPage,
          hasMore,
          processedPages,
          totalPages,
          batchCount: batchesDone,
          batchPages: pagesPerBatch,
          aggregatedCount: aggregated.length,
          rows: aggregated.length,
        });

        if (typeof onBatch === 'function') {
          onBatch({
            data,
            rows,
            aggregatedRows: aggregated,
            startPage: page,
            nextPage,
            hasMore,
            processedPages,
            totalPages,
            batchIndex: batchesDone,
          });
        }

        if (!hasMore) {
          const summaryData = {
            ...data,
            count: aggregated.length,
            batchCount: aggregated.length,
            storedJamaahCount: Number(data.storedJamaahCount ?? data.count) || aggregated.length,
            aggregatedCount: aggregated.length,
            jamaahList: aggregated,
            batchJamaahList: rows,
            hasMore: false,
            nextPage: null,
            totalPages,
          };
          if (panel) {
            renderProgress(panel, {
              active: false,
              success: true,
              phase: 'done',
              percent: 100,
              label,
              message: data.message || `Sinkronisasi selesai: ${formatNumber(aggregated.length)} jamaah.`,
              detail: `${formatNumber(aggregated.length)} jamaah dari ${formatNumber(donePages)} halaman`,
              summary: data.syncSummary || null,
            });
          }
          if (typeof onComplete === 'function') onComplete(summaryData, aggregated);
          if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
          return {
            ok: true,
            data: summaryData,
            rows: aggregated,
            batches: batchesDone,
          };
        }

        if (nextPage <= page) {
          const message = 'Server tidak memajukan nomor halaman; sinkronisasi dihentikan agar tidak berulang.';
          showError(panel, message);
          if (typeof onError === 'function') onError(message, data);
          return {
            ok: false,
            error: message,
            data,
            rows: aggregated,
            batches: batchesDone,
            resume: {
              startPage: nextPage || page,
              rows: aggregated,
              batches: batchesDone,
            },
          };
        }

        page = nextPage;
      }
    } finally {
      if (panel) batchRunning.delete(panel);
      if (manageButton) setButtonBusy(button, false);
    }
  }

  async function runFullSync({
    panel,
    button,
    endpoint = DEFAULT_ENDPOINT,
    validationEndpoint = VALIDATION_ENDPOINT,
    body = {},
    validationBody = {},
    label = 'Sinkronisasi SGO',
    busyLabel = 'Menyinkronkan...',
    autoHideMs = HIDE_DELAY_MS,
    disableButton = true,
    startPage = 1,
    batchPages = 2,
    initialRows = [],
    validationStartIndex = 0,
    validationBatchSize = MAX_VALIDATION_BATCH,
    skipScrape = false,
    skipValidation = false,
    retryAttempts = RETRY_ATTEMPTS,
    retryBaseMs = RETRY_BASE_MS,
    manageButton = true,
    stopRequested,
    onProgress,
    onBatch,
    onStage,
    onValidationProgress,
    onComplete,
    onError,
    onRetry,
  } = {}) {
    if (panel && fullRunning.has(panel)) {
      return { ok: false, busy: true, error: 'Sinkronisasi penuh masih berjalan.' };
    }

    clearHideTimer(panel);
    if (manageButton) setButtonBusy(button, true, busyLabel, disableButton);
    if (panel) fullRunning.set(panel, true);

    let scrapeResult = {
      ok: true,
      data: {},
      rows: Array.isArray(initialRows) ? [...initialRows] : [],
      batches: 0,
    };

    try {
      if (!skipScrape) {
        scrapeResult = await runBatched({
          panel,
          button,
          endpoint,
          body,
          label,
          busyLabel,
          autoHideMs: 0,
          disableButton,
          startPage,
          batchPages,
          initialRows,
          retryAttempts,
          retryBaseMs,
          manageButton: false,
          stopRequested,
          onProgress,
          onBatch,
          onRetry,
        });

        if (!scrapeResult.ok || scrapeResult.busy || scrapeResult.stopped) {
          if (typeof onComplete === 'function') onComplete(scrapeResult.data, scrapeResult.rows, 'scrape');
          return { ...scrapeResult, stage: 'scrape' };
        }
        if (typeof onStage === 'function') onStage('scrape', scrapeResult);
      }

      if (skipValidation) {
        if (typeof onComplete === 'function') onComplete(scrapeResult.data, scrapeResult.rows, 'scrape');
        if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
        return { ...scrapeResult, stage: 'scrape' };
      }

      const validationResult = await runValidationBatched({
        panel,
        button,
        endpoint: validationEndpoint,
        body: validationBody,
        startIndex: validationStartIndex,
        batchSize: validationBatchSize,
        label: 'Validasi NIK & Paspor',
        busyLabel: 'Memvalidasi...',
        autoHideMs: 0,
        disableButton,
        manageButton: false,
        retryAttempts,
        retryBaseMs,
        stopRequested,
        onProgress,
        onValidationProgress,
        onRetry,
      });

      if (!validationResult.ok || validationResult.busy || validationResult.stopped) {
        const resume =
          validationResult.validation?.resume || { startIndex: validationStartIndex };
        if (typeof onError === 'function' && !validationResult.ok) {
          onError(validationResult.error, validationResult.data, resume, 'validation');
        }
        if (typeof onComplete === 'function') {
          onComplete(validationResult.data, scrapeResult.rows, 'validation');
        }
        return {
          ...validationResult,
          stage: 'validation',
          rows: scrapeResult.rows,
          batches: scrapeResult.batches,
          scrape: scrapeResult,
          resume,
        };
      }

      if (typeof onStage === 'function') onStage('validation', validationResult);

      const scrapeData = scrapeResult.data || {};
      const validationData = validationResult.data || {};
      const validation = validationResult.validation || {};
      const scrapedCount = Number(
        scrapeData.aggregatedCount || scrapeData.count || scrapeResult.rows?.length || 0,
      );
      const count = skipScrape ? Number(validation.total || 0) : scrapedCount;
      const processed = Number(validation.processed || 0);
      const total = Number(validation.total || 0);
      const message = skipScrape
        ? `Validasi NIK & paspor selesai: ${formatNumber(processed)}/${formatNumber(total)}.`
        : `Sinkronisasi selesai: ${formatNumber(count)} jamaah • validasi ${formatNumber(processed)}/${formatNumber(total)}.`;
      const data = {
        ...scrapeData,
        ...(validationData.syncSummary ? { syncSummary: validationData.syncSummary } : {}),
        validation,
        validationResponse: validationData,
        message,
      };

      if (typeof onComplete === 'function') onComplete(data, scrapeResult.rows, 'validation');
      if (autoHideMs > 0) scheduleHide(panel, autoHideMs);
      return {
        ok: true,
        data,
        rows: scrapeResult.rows,
        batches: scrapeResult.batches + Number(validationResult.batches || 0),
        validation,
        stage: 'validation',
        scrape: scrapeResult,
        validationResult,
      };
    } finally {
      if (panel) fullRunning.delete(panel);
      if (manageButton) setButtonBusy(button, false);
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
    runBatched,
    runValidationBatched,
    runFullSync,
    attach,
    fetchProgress,
    showError,
    hide: (panel) => {
      if (panel) panel.classList.add('hidden');
    },
  };
})();
