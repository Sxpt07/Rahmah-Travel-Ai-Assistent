import { Router } from 'express';
import { polishRahmahMessage } from '../services/aiEngine.js';
import { RAHMAH_STYLE_MAX_LENGTH } from '../services/rahmahStyle.js';

const router = Router();
const MAX_FACTS = 60;

/**
 * Rapihin Kata (Rahmah Style).
 * Body: { text, mode?: 'fu'|'chat', facts?: string[] }
 *
 * Endpoint ini hanya mengembalikan teks yang sudah dirapikan. Tidak ada data
 * jamaah yang disimpan, dan fakta dari draf selalu dipertahankan.
 */
router.post('/rapihin', async (req, res) => {
  const text = String(req.body?.text == null ? '' : req.body.text).trim();
  const mode = req.body?.mode === 'chat' ? 'chat' : 'fu';
  const facts = Array.isArray(req.body?.facts)
    ? req.body.facts
        .map((value) => String(value == null ? '' : value).trim())
        .filter(Boolean)
        .slice(0, MAX_FACTS)
    : [];

  if (!text) {
    return res.status(400).json({
      success: false,
      error: 'Teks yang ingin dirapikan masih kosong.',
    });
  }
  if (text.length > RAHMAH_STYLE_MAX_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `Teks maksimal ${RAHMAH_STYLE_MAX_LENGTH.toLocaleString('id-ID')} karakter.`,
    });
  }

  try {
    const result = await polishRahmahMessage(text, { facts, mode });
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      text: result.text,
      source: result.source,
      model: result.model || null,
      reason: result.reason || '',
    });
  } catch (error) {
    console.error('[pesan] gagal merapikan kata:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Gagal merapikan teks. Silakan coba lagi.',
    });
  }
});

export default router;
