import { Router } from 'express';
import { getFuPelunasanSnapshot } from '../services/fuPelunasanStore.js';

const router = Router();

function readQuery(value) {
  return typeof value === 'string' ? value : '';
}

function readForce(value) {
  return value === '1' || value === 'true' || value === true;
}

async function respondWithSnapshot(req, res, { query, force }) {
  res.set('Cache-Control', 'no-store');

  try {
    const snapshot = await getFuPelunasanSnapshot({ query, force });
    res.json({ success: true, ...snapshot });
  } catch (error) {
    console.error('[fu-pelunasan] gagal memuat data:', error.message);
    res.status(error.statusCode || 502).json({
      success: false,
      error:
        error.message ||
        'Gagal memuat data FU Pelunasan dari Penagihan & Aging SGO.',
      code: error.code || 'FU_PELUNASAN_ERROR',
    });
  }
}

/**
 * Snapshot FU Pelunasan (aging RED).
 * `q` mencari nama, kode order, RTB, paket, nomor HP, atau status H.
 * `refresh=1` memaksa tarik ulang dari SGO.
 */
router.get('/', async (req, res) => {
  await respondWithSnapshot(req, res, {
    query: readQuery(req.query.q),
    force: readForce(req.query.refresh),
  });
});

/**
 * Paksa sinkronisasi ulang kanban + list RED dari SGO ke SQLite.
 */
router.post('/refresh', async (req, res) => {
  await respondWithSnapshot(req, res, {
    query: readQuery(req.body?.q),
    force: true,
  });
});

export default router;
