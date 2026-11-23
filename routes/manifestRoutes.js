import { Router } from 'express';
import {
  getJamaahData,
  hasRealJamaahData,
} from '../data/jamaahStore.js';
import { buildWhatsAppDraft } from '../services/documentStatus.js';
import {
  getManifestLiveStates,
  getManifestOrderRows,
  getManifestSnapshot,
} from '../services/manifestStore.js';

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
 * Daftar dokumen jamaah dengan filter bulan/status dan pencarian server-side:
 * nama, kode order, short code, RTB, atau nomor HP. Data dibaca dari cache
 * SQLite manifest yang disinkronkan dari getJamaahData().
 */
router.get('/docs', (req, res) => {
  try {
    const pageData = getManifestSnapshot({
      query: typeof req.query.q === 'string' ? req.query.q : '',
      status: typeof req.query.status === 'string' ? req.query.status : 'all',
      month: typeof req.query.month === 'string' ? req.query.month : 'all',
      page: req.query.page,
      limit: req.query.limit,
      force: req.query.refresh === '1',
    });

    res.json({
      success: true,
      hasRealData: hasRealJamaahData(),
      ...pageData,
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
 * Status dokumen terbaru untuk kartu yang sedang terlihat. Dipakai polling
 * frontend saat sync penuh berjalan agar badge berubah merah -> hijau secara
 * real-time tanpa memuat ulang seluruh halaman dan mengacak urutan kartu.
 */
router.get('/docs/live', (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      items: getManifestLiveStates(ids),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[manifest] gagal memuat status live:', error.message);
    res.status(500).json({
      success: false,
      error: 'Gagal memuat status dokumen terbaru.',
    });
  }
});

/**
 * Seluruh jamaah dalam satu kode order. Dipakai tombol “Copy FU Keluarga”
 * agar pesan tetap mencakup semua jamaah meskipun daftar sedang difilter.
 */
router.get('/docs/order/:orderCode', (req, res) => {
  try {
    const orderCode = String(req.params.orderCode || '').trim();
    const rows = getManifestOrderRows(orderCode);
    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: 'Order tidak ditemukan.',
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      orderCode: rows[0].orderCode || orderCode,
      rows,
    });
  } catch (error) {
    console.error('[manifest] gagal memuat jamaah order:', error.message);
    res.status(500).json({
      success: false,
      error: 'Gagal memuat seluruh jamaah pada order.',
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
