import { Router } from 'express';
import {
  getJamaahData,
  getJamaahSource,
  hasRealJamaahData,
} from '../data/jamaahStore.js';
import {
  buildManifestPage,
  buildMonitoringSummary,
  buildWhatsAppDraft,
} from '../services/documentStatus.js';

const router = Router();

function findRowById(id = '') {
  const target = String(id || '').trim();
  if (!target) return null;

  return (
    getJamaahData().find(
      (row) =>
        String(row.manifestId || '').trim() === target ||
        String(row.jamaahId || '').trim() === target,
    ) || null
  );
}

/**
 * Daftar dokumen jamaah dengan pencarian server-side:
 * nama, kode order (ORD-...), short code, atau nomor HP.
 * Nomor HP hanya dipakai untuk mencocokkan dan tidak ikut dikembalikan.
 */
router.get('/docs', (req, res) => {
  try {
    const rows = getJamaahData();
    const pageData = buildManifestPage(rows, {
      query: typeof req.query.q === 'string' ? req.query.q : '',
      status: typeof req.query.status === 'string' ? req.query.status : 'all',
      page: req.query.page,
      limit: req.query.limit,
    });
    const summary = buildMonitoringSummary(rows, getJamaahSource());

    res.json({
      success: true,
      hasRealData: hasRealJamaahData(),
      ...pageData,
      summary,
    });
  } catch (error) {
    console.error('[manifest] gagal memuat dokumen:', error.message);
    res.status(500).json({
      success: false,
      error: 'Gagal memuat data kelengkapan dokumen jamaah.',
    });
  }
});

/**
 * Generate draf WhatsApp untuk satu baris manifest.
 * Draf dibuat di server agar format dan data yang dipakai konsisten.
 */
router.get('/docs/:id/whatsapp', (req, res) => {
  try {
    const row = findRowById(req.params.id);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: 'Data jamaah tidak ditemukan.',
      });
    }

    res.json({
      success: true,
      ...buildWhatsAppDraft(row),
    });
  } catch (error) {
    console.error('[manifest] gagal membuat draf WhatsApp:', error.message);
    res.status(500).json({
      success: false,
      error: 'Gagal membuat draf pesan WhatsApp.',
    });
  }
});

export default router;
