/**
 * Status sinkronisasi SGO in-memory.
 *
 * Modul ini sengaja tidak menyimpan data pribadi. UI hanya menerima angka
 * progres, nama modul, dan ringkasan agregat agar progress bar dapat berjalan
 * real-time tanpa membocorkan isi jamaah.
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
    label: '',
    modulePath: '',
    modules: [],
    pagesFetched: 0,
    totalPages: 0,
    rows: 0,
    totalJamaah: 0,
    rtb: 0,
    orders: 0,
    documentsUpdated: 0,
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
    modules: Array.isArray(state.modules) ? [...state.modules] : [],
    summary: state.summary && typeof state.summary === 'object'
      ? { ...state.summary }
      : state.summary,
  };
}

function isStale() {
  if (!state.active) return false;
  // Staleness diukur dari update terakhir, bukan waktu mulai: scrape penuh
  // dengan pagination + enrichment manifest bisa berjalan lebih dari 30 menit
  // dan tetap sehat selama progres terus diperbarui.
  const last = Date.parse(state.updatedAt || state.startedAt || '');
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > ACTIVE_TIMEOUT_MS;
}

function newId() {
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ambil status terakhir. Aman dipanggil kapan saja oleh endpoint progress. */
export function getSyncProgress() {
  if (isStale()) {
    state = {
      ...state,
      active: false,
      success: false,
      phase: 'error',
      percent: 100,
      message: state.message || 'Sinkronisasi melewati batas waktu.',
      error: 'Sinkronisasi melewati batas waktu.',
      updatedAt: nowIso(),
      finishedAt: nowIso(),
    };
  }
  return snapshot();
}

export function isSyncProgressActive() {
  const data = getSyncProgress();
  return Boolean(data.active);
}

/**
 * Mulai sesi baru. Jika masih ada sesi aktif yang belum kedaluwarsa, sesi
 * tersebut dipertahankan agar request ganda tidak menghapus progres berjalan.
 */
export function startSyncProgress({
  label = '',
  modulePath = '',
  modules = [],
  message = 'Menyiapkan sinkronisasi...',
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
    label,
    modulePath,
    modules: Array.isArray(modules) ? modules.filter(Boolean) : [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  return snapshot();
}

/** Perbarui status. Persentase dibuat monoton agar animasi tidak mundur. */
export function updateSyncProgress(patch = {}) {
  if (!state.active) return snapshot();
  if (isStale()) return getSyncProgress();

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

/** Tandai selesai 100% dan simpan ringkasan agregat. */
export function finishSyncProgress({
  message = 'Sinkronisasi selesai.',
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
    summary: summary && typeof summary === 'object' ? { ...summary } : summary,
    error: '',
    updatedAt: nowIso(),
    finishedAt: nowIso(),
  };
  return snapshot();
}

/** Tandai gagal. Bar tetap penuh dengan warna error agar mudah terlihat. */
export function failSyncProgress(error = 'Sinkronisasi gagal.') {
  const message =
    typeof error === 'string'
      ? error
      : String(error?.message || 'Sinkronisasi gagal.');
  state = {
    ...state,
    active: false,
    success: false,
    percent: 100,
    phase: 'error',
    message,
    error: message,
    updatedAt: nowIso(),
    finishedAt: nowIso(),
  };
  return snapshot();
}

/** Kembalikan ke idle, dipakai saat data dibersihkan manual. */
export function resetSyncProgress() {
  state = idleState();
  return snapshot();
}

/**
 * Ubah hitungan halaman menjadi persentase. Rentang default 5-80% dipakai
 * untuk pengambilan halaman, lalu tahap merge/enrichment/simpan mengisi
 * sisanya. Rentang bisa diatur agar beberapa modul yang berjalan paralel
 * tidak saling melompati.
 */
export function syncPercentFromPages(
  pagesFetched = 0,
  totalPages = 0,
  { start = 5, end = 80 } = {},
) {
  const fetched = Math.max(0, Number(pagesFetched) || 0);
  const total = Math.max(0, Number(totalPages) || 0);
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  if (!fetched) return from;
  if (total > 0) return Math.min(to, from + (fetched / total) * (to - from));
  return Math.min(to, from + fetched * 0.4);
}

export default {
  getSyncProgress,
  isSyncProgressActive,
  startSyncProgress,
  updateSyncProgress,
  finishSyncProgress,
  failSyncProgress,
  resetSyncProgress,
  syncPercentFromPages,
};
