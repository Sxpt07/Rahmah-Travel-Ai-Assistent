/**
 * Jembatan hasil pencarian chat ke data dokumen yang aman.
 *
 * File ini TIDAK mengubah services/aiEngine.js. Ia hanya memakai API yang
 * sudah diekspor (classifyIntent) dan fungsi pencarian stabil dari
 * data/jamaahStore.js, lalu memproyeksikan hasilnya lewat documentStatus.js.
 *
 * Tujuannya: pesan chat yang berisi nama atau kode order dapat menampilkan
 * kartu status dokumen dan tombol "Kelola Dokumen" tanpa membocorkan NIK,
 * paspor, atau nomor HP.
 */

import { classifyIntent } from './aiEngine.js';
import { findJamaah } from '../data/jamaahStore.js';
import { buildSafeJamaahRow } from './documentStatus.js';
import { resolveOrderQuery } from './orderSearch.js';

const MAX_CHAT_ROWS = 10;

function statusLabel(row = {}) {
  return row.isComplete
    ? `Lengkap (${row.progressLabel})`
    : `Belum lengkap (${row.progressLabel})`;
}

function buildExactOrderReply(orderResult = {}, items = []) {
  const total = Number(orderResult.matches?.length || 0);
  const display =
    orderResult.type === 'full'
      ? orderResult.value
      : items[0]?.orderCode || orderResult.value;

  if (!total) {
    return `📌 Tidak ada jamaah dengan kode order **${display}**. Pastikan kode order sudah benar.`;
  }

  if (total === 1 && items[0]) {
    const row = items[0];
    return [
      '📌 **Data Jamaah Ditemukan:**',
      `- **Nama Lengkap:** ${row.nama}`,
      `- **Kode Order:** ${row.orderCode || display}`,
      `- **Paket:** ${row.paket || '-'}`,
      `- **Keberangkatan:** ${row.keberangkatan || '-'}`,
      `- **Status Dokumen:** ${statusLabel(row)}`,
    ].join('\n');
  }

  const lines = [
    `📌 Ditemukan ${total} jamaah dengan kode order **${items[0]?.orderCode || display}**:`,
  ];

  items.forEach((row, index) => {
    lines.push(`${index + 1}. **${row.nama}**`);
    lines.push(`   - Kode Order: ${row.orderCode || '-'}`);
    lines.push(`   - Paket: ${row.paket || '-'}`);
    lines.push(`   - Keberangkatan: ${row.keberangkatan || '-'}`);
    lines.push(`   - Status Dokumen: ${statusLabel(row)}`);
  });

  if (total > items.length) {
    lines.push(`…dan ${total - items.length} jamaah lainnya.`);
  }

  return lines.join('\n');
}

/**
 * Bangun hasil pencarian dokumen untuk pesan chat.
 *
 * Input yang berbentuk kode order selalu memakai exact match. Input nama
 * tetap memakai pencarian universal yang sudah ada.
 *
 * @param {string} message Pesan asli pengguna.
 * @param {object} chatResult Hasil processChat dari aiEngine.
 * @returns {null|{
 *   exactOrder?:boolean,
 *   reply?:string,
 *   totalMatched:number,
 *   returned:number,
 *   truncated:boolean,
 *   items:object[]
 * }}
 */
export function buildChatJamaahResults(message, chatResult = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  // Exact order diprioritaskan sebelum pencarian universal. Ini mencegah
  // kode order yang mirip (atau digit paspor) ikut masuk ke hasil chat.
  const orderResult = resolveOrderQuery(text);
  if (orderResult) {
    const shown = orderResult.matches.slice(0, MAX_CHAT_ROWS);
    const items = shown.map((row, index) => buildSafeJamaahRow(row, index));

    return {
      exactOrder: true,
      reply: buildExactOrderReply(orderResult, items),
      totalMatched: orderResult.matches.length,
      returned: items.length,
      truncated: orderResult.matches.length > items.length,
      items,
    };
  }

  if (!chatResult?.usedJamaahLookup) return null;
  if (chatResult?.intent !== 'data-lookup') return null;

  let intent = null;
  try {
    intent = classifyIntent(text);
  } catch (error) {
    console.error('[console-bridge] gagal klasifikasi pesan:', error.message);
    return null;
  }

  if (intent?.type !== 'data-lookup' || !intent.query) return null;

  // Query yang berbentuk kode order sudah ditangani di atas. Di sini hanya
  // pencarian nama/universal yang boleh memakai findJamaah.
  if (resolveOrderQuery(intent.query)) return null;

  let result = null;
  try {
    result = findJamaah(intent.query);
  } catch (error) {
    console.error('[console-bridge] gagal mencari jamaah:', error.message);
    return null;
  }

  if (!result?.found || !Array.isArray(result.matches) || !result.matches.length) {
    return null;
  }

  const matches = result.matches.slice(0, MAX_CHAT_ROWS);

  return {
    totalMatched: result.matches.length,
    returned: matches.length,
    truncated: result.matches.length > matches.length,
    items: matches.map((row, index) => buildSafeJamaahRow(row, index)),
  };
}

export default { buildChatJamaahResults };
