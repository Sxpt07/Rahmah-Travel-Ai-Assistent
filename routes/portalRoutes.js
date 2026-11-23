import { Router } from 'express';
import { resolvePortalLoginTarget } from '../services/portalLogin.js';

const router = Router();

/**
 * Ambil kode akses/PIN Portal Jamaah untuk header kartu order.
 *
 * Parameter `orders` menerima maksimal 12 kode order dipisahkan koma. Endpoint
 * ini hanya mengembalikan kode akses, bukan URL login; tautan login tetap
 * dibuat oleh `/login` agar sesi portal tidak terbuka tanpa aksi pengguna.
 */
router.get('/access', async (req, res) => {
  const raw = String(req.query.orders || req.query.order || '');
  const orders = [
    ...new Set(
      raw
        .split(',')
        .map((order) => order.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 12);

  res.set('Cache-Control', 'no-store');

  if (!orders.length) {
    res.status(400).json({
      success: false,
      error: 'Parameter orders wajib diisi.',
    });
    return;
  }

  const results = await Promise.allSettled(
    orders.map(async (orderCode) => {
      const target = await resolvePortalLoginTarget({ orderCode });
      return {
        orderCode: target.orderCode || orderCode,
        accessCode: target.uniqueCode || '',
      };
    }),
  );

  const items = results.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : { orderCode: orders[index], accessCode: '' },
  );

  res.json({ success: true, items });
});

/**
 * Redirect ke halaman login Portal Jamaah untuk order yang diminta.
 *
 * Parameter:
 * - `id`    : ID jamaah/manifest (opsional, sumber kode order)
 * - `order` : kode order lengkap atau nomor order (opsional)
 *
 * Endpoint ini hanya mengirim redirect; kode akses untuk tampilan header
 * disediakan terpisah lewat `/access`.
 */
router.get('/login', async (req, res) => {
  const jamaahId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  const orderCode =
    typeof req.query.order === 'string' ? req.query.order.trim() : '';

  let target = null;
  try {
    target = await resolvePortalLoginTarget({ jamaahId, orderCode });
  } catch (error) {
    console.error('[portal] gagal menentukan login portal:', error.message);
  }

  res.set('Cache-Control', 'no-store');

  if (target?.url) {
    res.redirect(302, target.url);
    return;
  }

  const fallback = orderCode
    ? `https://jamaah.rahmahtravel.id/login?code=${encodeURIComponent(
        orderCode,
      )}`
    : 'https://jamaah.rahmahtravel.id/login';
  res.redirect(302, fallback);
});

export default router;
