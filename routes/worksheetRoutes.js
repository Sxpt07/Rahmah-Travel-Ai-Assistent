import { Router } from 'express';
import {
  DEFAULT_WORKSHEET_TAB,
  getWorksheetSnapshot,
  getWorksheetTabs,
  prepareAllWorksheetOrder,
  searchWorksheetRows,
} from '../services/worksheetStore.js';

const router = Router();

function readTab(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_WORKSHEET_TAB;
}

function readQuery(value) {
  return typeof value === 'string' ? value : '';
}

function readForce(value) {
  return value === '1' || value === 'true' || value === true;
}

async function respondWithSnapshot(req, res, { tab, query, force }) {
  try {
    const snapshot = await getWorksheetSnapshot({ tab, query, force });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...snapshot });
  } catch (error) {
    console.error('[worksheet] gagal memuat data:', error.message);
    res.set('Cache-Control', 'no-store');

    let tabs = [];
    try {
      tabs = getWorksheetTabs();
    } catch {
      tabs = [];
    }

    res.status(error.statusCode || 502).json({
      success: false,
      error:
        error.message ||
        'Gagal memuat Worksheet Perlengkapan dari SGO.',
      code: error.code || 'WORKSHEET_ERROR',
      tabs,
    });
  }
}

/**
 * Pencarian lintas tahap dari cache SQLite.
 * Dipakai konsol chat Worksheet supaya satu kata kunci dapat menemukan
 * data dari semua tab, bukan hanya tab yang sedang aktif.
 */
router.get('/perlengkapan/search', (req, res) => {
  const query = readQuery(req.query.q);

  res.set('Cache-Control', 'no-store');

  if (!query.trim()) {
    return res.status(400).json({
      success: false,
      code: 'WORKSHEET_QUERY_EMPTY',
      error: 'Kata kunci pencarian wajib diisi.',
    });
  }

  try {
    const result = searchWorksheetRows(query, {
      limit: req.query.limit,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[worksheet] gagal mencari data:', error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Gagal mencari data Worksheet.',
      code: error.code || 'WORKSHEET_SEARCH_ERROR',
    });
  }
});

/**
 * Snapshot Worksheet Perlengkapan dari cache SQLite.
 * Query `q` disediakan untuk pencarian server-side; UI memakai endpoint
 * `/search` untuk pencarian lintas tab.
 */
router.get('/perlengkapan', async (req, res) => {
  await respondWithSnapshot(req, res, {
    tab: readTab(req.query.tab),
    query: readQuery(req.query.q),
    force: readForce(req.query.refresh),
  });
});

/**
 * Tandai semua jamaah pada satu order sudah disiapkan.
 * Body wajib `{ confirm: true }` supaya aksi live tidak pernah berjalan
 * karena klik tidak sengaja atau request tanpa konfirmasi.
 */
router.post('/perlengkapan/order/:order/siapkan-all', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (req.body?.confirm !== true) {
    return res.status(400).json({
      success: false,
      code: 'WORKSHEET_CONFIRM_REQUIRED',
      error:
        'Aksi “Siapkan semua” memerlukan konfirmasi eksplisit sebelum dijalankan.',
    });
  }

  try {
    const result = await prepareAllWorksheetOrder(req.params.order);
    return res.json({
      success: true,
      order: result.order,
      message: `Order #${result.order} ditandai sudah disiapkan di SGO.`,
    });
  } catch (error) {
    console.error(
      '[worksheet] gagal menjalankan siapkan-all:',
      error.message,
    );
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message || 'Gagal menjalankan aksi Siapkan semua.',
      code: error.code || 'WORKSHEET_ACTION_ERROR',
    });
  }
});

/**
 * Paksa sinkronisasi ulang satu tab dari SGO ke SQLite.
 */
router.post('/perlengkapan/refresh', async (req, res) => {
  await respondWithSnapshot(req, res, {
    tab: readTab(req.body?.tab),
    query: readQuery(req.body?.q),
    force: true,
  });
});

export default router;
