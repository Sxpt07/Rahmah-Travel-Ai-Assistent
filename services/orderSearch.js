/**
 * Resolver kode order yang ketat (exact match).
 *
 * Modul ini terpisah dari services/aiEngine.js dan hanya dipakai oleh lapisan
 * API (manifest & chat). Aturannya:
 * - Kode order penuh harus sama persis setelah pemisah dinormalisasi.
 * - Kode numerik pendek (mis. 004719 / 4719) dibandingkan dengan suffix order
 *   setelah leading zero dibuang. Tidak ada pencarian substring.
 *
 * Dengan begitu digit yang mirip (mis. paspor X4719728) tidak akan ikut
 * muncul saat admin mencari kode order 004719.
 */

import { getAllJamaah } from '../data/jamaahStore.js';

const FULL_ORDER_RE =
  /\b(?:ORD|ORDER|UMR)[-_/ ]?\d{4}[-_/ ]?[A-Z]{2,4}[-_/ ]?\d{4,6}\b/i;

const ORDER_CUE_RE =
  /\b(?:kode|order|booking|invoice|pendaftaran|no|nomor|cek|check|cari|carikan|tolong|mohon|silakan|tampilkan|lihat|data|jamaah|jamaahnya|peserta|pesertanya|nama|ord|umr)\b/gi;

function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function compact(value = '') {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function digitsOnly(value = '') {
  return safeText(value).replace(/\D+/g, '');
}

function normalizeShort(value = '') {
  const digits = digitsOnly(value);
  return digits.replace(/^0+/, '') || digits;
}

/** Ambil deretan angka terakhir dari kode order, mis. 004719. */
function trailingDigits(value = '') {
  const match = safeText(value).match(/(\d{4,6})\s*$/);
  return match ? match[1] : '';
}

function fullOrdersOf(row = {}) {
  return [
    row.orderCode,
    row.kodeOrder,
    row.orderId,
    row.order_id,
  ]
    .map((value) => compact(value))
    .filter(Boolean);
}

function shortCodesOf(row = {}) {
  const values = [row.shortCode, row.orderShort];
  for (const full of [
    row.orderCode,
    row.kodeOrder,
    row.orderId,
    row.order_id,
  ]) {
    const suffix = trailingDigits(full);
    if (suffix) values.push(suffix);
  }

  return [
    ...new Set(
      values
        .map((value) => normalizeShort(value))
        .filter(Boolean),
    ),
  ];
}

/**
 * Parse input admin menjadi kode order penuh atau kode numerik pendek.
 * Mengembalikan null bila input bukan kode order (mis. nama jamaah).
 *
 * @param {string} raw
 * @returns {null|{type:'full'|'short', value:string, compact?:string, normalized?:string}}
 */
export function parseOrderQuery(raw = '') {
  const text = safeText(raw).trim();
  if (!text) return null;

  const fullMatch = text.match(FULL_ORDER_RE);
  if (fullMatch) {
    const value = fullMatch[0].replace(/[-_/ ]+/g, '-').toUpperCase();
    return {
      type: 'full',
      value,
      compact: compact(value),
    };
  }

  const hasCue =
    /\b(?:kode|order|booking|invoice|pendaftaran|no|nomor|ord|umr)\b/i.test(
      text,
    );

  const remainder = text
    .replace(ORDER_CUE_RE, ' ')
    .replace(/[^0-9a-z]+/gi, ' ')
    .trim();

  if (!remainder || !/^[\d\s]+$/.test(remainder)) return null;

  const digits = remainder.replace(/\D+/g, '');
  if (!digits) return null;

  const normalized = digits.replace(/^0+/, '') || digits;
  // Keputusan "ini query order" memakai panjang digit asli, bukan panjang
  // setelah leading zero dibuang. Dengan begitu "00471" tetap diperlakukan
  // sebagai exact-order dan tidak jatuh ke substring lama.
  const minDigits = hasCue ? 3 : 4;

  // Kode short yang tersimpan saat ini 4 digit; kode penuh memakai suffix
  // 4-6 digit. Batas ini mencegah angka RTB 3 digit ikut dianggap order,
  // kecuali admin menyebut kata "order/kode" secara eksplisit.
  if (digits.length < minDigits || digits.length > 6) return null;

  return {
    type: 'short',
    value: digits,
    normalized,
  };
}

/**
 * Cocokkan satu baris jamaah dengan hasil parse order.
 *
 * @param {object} row
 * @param {ReturnType<typeof parseOrderQuery>} parsed
 */
export function rowMatchesExactOrder(row = {}, parsed = null) {
  if (!parsed) return false;

  if (parsed.type === 'full') {
    if (!parsed.compact) return false;
    return fullOrdersOf(row).some((full) => full === parsed.compact);
  }

  const target = parsed.normalized;
  if (!target) return false;
  return shortCodesOf(row).some((short) => short === target);
}

/**
 * Resolver utama. Mengembalikan null bila query bukan kode order, sehingga
 * pemanggil bisa melanjutkan pencarian nama/HP seperti biasa.
 *
 * @param {string} query
 * @param {object[]} [rows] Sumber baris; default seluruh data jamaah aktif.
 */
export function resolveOrderQuery(query = '', rows = undefined) {
  const parsed = parseOrderQuery(query);
  if (!parsed) return null;

  const source = Array.isArray(rows) ? rows : getAllJamaah();
  const matches = source.filter((row) => rowMatchesExactOrder(row, parsed));

  return {
    ...parsed,
    query: safeText(query).trim(),
    matches,
  };
}

export const isOrderQuery = (query = '') => Boolean(parseOrderQuery(query));

export default {
  parseOrderQuery,
  rowMatchesExactOrder,
  resolveOrderQuery,
  isOrderQuery,
};
