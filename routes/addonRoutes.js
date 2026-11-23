import { Router } from 'express';
import {
  AddonStoreError,
  getAddonSnapshot,
  isAddonSyncActive,
  syncAddons,
} from '../services/addonStore.js';
import {
  failAddonSyncProgress,
  finishAddonSyncProgress,
  getAddonSyncProgress,
  isAddonProgressActive,
  startAddonSyncProgress,
  updateAddonSyncProgress,
} from '../services/addonSyncProgress.js';

const router = Router();

function readQuery(value) {
  return typeof value === 'string' ? value : '';
}

function readLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(2_000, Math.round(number));
}

/**
 * Mulai sinkronisasi di latar belakang. Jika sudah ada sesi aktif, kembalikan
 * progress yang sedang berjalan agar klik ganda tidak membuat dua sync.
 */
function launchAddonSync() {
  if (isAddonProgressActive() || isAddonSyncActive()) {
    return { started: false, progress: getAddonSyncProgress() };
  }

  const progress = startAddonSyncProgress({
    message: 'Menyiapkan sinkronisasi Add-on...',
    percent: 1,
  });

  syncAddons({
    onProgress: (patch) => updateAddonSyncProgress(patch),
  })
    .then((summary) => {
      finishAddonSyncProgress({
        message: `Sinkronisasi selesai • ${Number(
          summary.rows || 0,
        ).toLocaleString('id-ID')} add-on dari ${Number(
          summary.batches || 0,
        ).toLocaleString('id-ID')} batch.`,
        summary: {
          rows: summary.rows,
          batches: summary.batches,
          items: summary.items,
          orders: summary.orders,
          revenue: summary.revenue,
          warning: summary.warning,
        },
      });
    })
    .catch((error) => {
      console.error('[addon] sinkronisasi gagal:', error.message);
      failAddonSyncProgress(error);
    });

  return { started: true, progress: getAddonSyncProgress() };
}

function respondError(res, error) {
  const status =
    error instanceof AddonStoreError ? error.statusCode || 502 : 500;
  console.error('[addon]', error.message);
  res.status(status).json({
    success: false,
    error:
      error.message || 'Gagal memuat data Add-on Per Batch dari SGO.',
    code: error.code || 'ADDON_ERROR',
  });
}

/**
 * Snapshot Add-on Per Batch.
 * `q` mencari RTB, nama jamaah/pemesan, kode order, paket, atau jenis add-on.
 * `rtb` memaksa tampilan satu batch; `item` memfilter jenis add-on.
 */
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const snapshot = getAddonSnapshot({
      query: readQuery(req.query.q || req.query.query),
      rtb: readQuery(req.query.rtb),
      item: readQuery(req.query.item),
      limit: readLimit(req.query.limit),
    });

    let progress = getAddonSyncProgress();
    let autoStarted = false;

    // Halaman pertama tanpa cache: mulai sinkronisasi otomatis agar UI tidak
    // kosong melompong. Data tetap dikembalikan segera; progress dipoll.
    if (!snapshot.lastSyncedAt && !progress.active) {
      const started = launchAddonSync();
      autoStarted = started.started;
      progress = started.progress;
    }

    res.json({
      success: true,
      ...snapshot,
      syncing: Boolean(progress.active),
      autoStarted,
      progress,
    });
  } catch (error) {
    respondError(res, error);
  }
});

/** Status sinkronisasi real-time untuk progress bar 0–100%. */
router.get('/progress', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, progress: getAddonSyncProgress() });
});

/** Paksa tarik ulang seluruh data add-on dari SGO. */
router.post('/refresh', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = launchAddonSync();
    res.status(result.started ? 202 : 200).json({
      success: true,
      started: result.started,
      busy: !result.started,
      progress: result.progress,
    });
  } catch (error) {
    respondError(res, error);
  }
});

/** Snapshot satu batch; dipakai deep link dan tombol "Lihat detail". */
router.get('/batch/:rtb', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const snapshot = getAddonSnapshot({
      rtb: readQuery(req.params.rtb),
      item: readQuery(req.query.item),
      limit: readLimit(req.query.limit),
    });
    if (!snapshot.batch) {
      return res.status(404).json({
        success: false,
        error: 'RTB tidak ditemukan pada data Add-on.',
        code: 'ADDON_BATCH_NOT_FOUND',
      });
    }
    res.json({ success: true, ...snapshot });
  } catch (error) {
    respondError(res, error);
  }
});

/** Snapshot untuk kebutuhan integrasi chat (tanpa progress). */
router.get('/lookup', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const snapshot = getAddonSnapshot({
      query: readQuery(req.query.q || req.query.query),
      rtb: readQuery(req.query.rtb),
      item: readQuery(req.query.item),
      limit: 200,
    });
    res.json({ success: true, ...snapshot });
  } catch (error) {
    respondError(res, error);
  }
});

export default router;
