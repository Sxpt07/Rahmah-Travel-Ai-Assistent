import { Router } from 'express';
import {
  getJamaahData,
  getJamaahSource,
  hasRealJamaahData,
} from '../data/jamaahStore.js';
import { buildMonitoringSummary } from '../services/documentStatus.js';

const router = Router();

/**
 * Ringkasan Monitoring Jamaah.
 * Hanya statistik agregat + metadata sumber yang sudah disanitasi.
 */
router.get('/summary', (req, res) => {
  try {
    const rows = getJamaahData();
    res.json({
      success: true,
      hasRealData: hasRealJamaahData(),
      ...buildMonitoringSummary(rows, getJamaahSource()),
    });
  } catch (error) {
    console.error('[monitoring] gagal memuat ringkasan:', error.message);
    res.status(500).json({
      success: false,
      error: 'Gagal memuat ringkasan monitoring jamaah.',
    });
  }
});

export default router;
