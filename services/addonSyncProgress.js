/**
 * Status sinkronisasi Add-on in-memory.
 *
 * Terpisah dari `syncProgress.js` agar sinkronisasi Add-on tidak mengganggu
 * progress bar Monitoring Jamaah. Tidak ada data pribadi di sini; hanya angka,
 * fase, dan pesan status.
 */

const ACTIVE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_PERCENT = 100;

function nowIso() {
  return new Date().toISOString();
}

function clampPercent(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_PERCENT, Math.round(number * 10) / 10));
}

function idleState() {
  return {
    id: '',
    active: false,
    success: null,
    percent: 0,
    phase: 'idle',
    message: '',
    detail: '',
    code: '',
    itemsDone: 0,
    itemsTotal: 0,
    batchesDone: 0,
    batchesTotal: 0,
    rows: 0,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    summary: null,
    error: '',
  };
}

let state = idleState();

function snapshot() {
  return {
    ...state,
    summary:
      state.summary && typeof state.summary === 'object'
        ? { ...state.summary }
        : state.summary,
  };
}

function isStale() {
  if (!state.active) return false;
  const started = Date.parse(state.startedAt || '');
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > ACTIVE_TIMEOUT_MS;
}

function newId() {
  return `addon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getAddonSyncProgress() {
  if (isStale()) {
    state = {
      ...state,
      active: false,
      success: false,
      phase: 'error',
      percent: 100,
      message: state.message || 'Sinkronisasi Add-on melewati batas waktu.',
      error: 'Sinkronisasi Add-on melewati batas waktu.',
      updatedAt: nowIso(),
      finishedAt: nowIso(),
    };
  }
  return snapshot();
}

export function isAddonProgressActive() {
  return Boolean(getAddonSyncProgress().active);
}

export function startAddonSyncProgress({
  message = 'Menyiapkan sinkronisasi Add-on...',
  percent = 1,
} = {}) {
  if (state.active && !isStale()) return snapshot();

  state = {
    ...idleState(),
    id: newId(),
    active: true,
    success: null,
    percent: clampPercent(percent, 1),
    phase: 'preparing',
    message,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  return snapshot();
}

export function updateAddonSyncProgress(patch = {}) {
  if (!state.active) return snapshot();
  if (isStale()) return getAddonSyncProgress();

  const next = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = value;
  }

  next.percent = clampPercent(
    Math.max(Number(state.percent) || 0, Number(patch.percent) || 0),
    state.percent,
  );
  next.updatedAt = nowIso();
  state = next;
  return snapshot();
}

export function finishAddonSyncProgress({
  message = 'Sinkronisasi Add-on selesai.',
  percent = 100,
  summary = null,
  ...patch
} = {}) {
  state = {
    ...state,
    ...patch,
    active: false,
    success: true,
    percent: clampPercent(Math.max(Number(state.percent) || 0, percent), 100),
    phase: 'done',
    message,
    summary:
      summary && typeof summary === 'object' ? { ...summary } : summary,
    code: '',
    error: '',
    updatedAt: nowIso(),
    finishedAt: nowIso(),
  };
  return snapshot();
}

export function failAddonSyncProgress(error = 'Sinkronisasi Add-on gagal.') {
  const message =
    typeof error === 'string'
      ? error
      : String(error?.message || 'Sinkronisasi Add-on gagal.');
  const code = typeof error === 'string' ? '' : String(error?.code || '');
  state = {
    ...state,
    active: false,
    success: false,
    percent: 100,
    phase: 'error',
    message,
    code,
    error: message,
    updatedAt: nowIso(),
    finishedAt: nowIso(),
  };
  return snapshot();
}

export function resetAddonSyncProgress() {
  state = idleState();
  return snapshot();
}

export default {
  getAddonSyncProgress,
  isAddonProgressActive,
  startAddonSyncProgress,
  updateAddonSyncProgress,
  finishAddonSyncProgress,
  failAddonSyncProgress,
  resetAddonSyncProgress,
};
