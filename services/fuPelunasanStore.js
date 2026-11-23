import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import {
  SGO_BROWSER_HEADERS,
} from './sgoScraper.js';
import { getRequestSgoCookieHeader } from './sgoRequestContext.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH =
  process.env.FU_PELUNASAN_DB_PATH ||
  path.join(DATA_DIR, 'fu_pelunasan.sqlite');
const CACHE_TTL_MS = Math.max(
  30_000,
  Number(process.env.FU_PELUNASAN_CACHE_TTL_MS || 3 * 60 * 1000) ||
    3 * 60 * 1000,
);
const FETCH_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.FU_PELUNASAN_FETCH_TIMEOUT_MS || 45_000) || 45_000,
);
const SGO_BASE_URL = String(
  process.env.SGO_BASE_URL || 'https://sgo.rahmahgrup.id',
).replace(/\/+$/, '');
const PENAGIHAN_PATH = '/ops/penagihan-aging';

const MONTHS = new Map([
  ['jan', 1],
  ['januari', 1],
  ['feb', 2],
  ['februari', 2],
  ['mar', 3],
  ['maret', 3],
  ['apr', 4],
  ['april', 4],
  ['mei', 5],
  ['may', 5],
  ['jun', 6],
  ['juni', 6],
  ['jul', 7],
  ['juli', 7],
  ['agu', 8],
  ['agt', 8],
  ['aug', 8],
  ['agustus', 8],
  ['sep', 9],
  ['sept', 9],
  ['september', 9],
  ['okt', 10],
  ['oct', 10],
  ['oktober', 10],
  ['nov', 11],
  ['november', 11],
  ['des', 12],
  ['dec', 12],
  ['desember', 12],
]);

export class FuPelunasanError extends Error {
  constructor(message, { code = 'FU_PELUNASAN_ERROR', statusCode = 502 } = {}) {
    super(message);
    this.name = 'FuPelunasanError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

let db = null;
let schemaReady = false;
let inflightSync = null;

/* -------------------------------------------------------------------------- */
/* Utilitas teks & angka                                                      */
/* -------------------------------------------------------------------------- */

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitsOnly(value = '') {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * URL detail pembayaran SGO selalu dibangun dari nomor order kartu yang
 * sedang dirender. Dengan begitu klik "Detail SGO" atau kode order tidak
 * pernah membuka order lain, termasuk saat markup SGO mengirim path relatif
 * (`/ops/...`) atau URL absolut.
 */
function sgoDetailUrl(orderNumber = '') {
  const digits = digitsOnly(orderNumber).slice(0, 20);
  if (!digits) return '';
  return `/sgo-proxy/ops/tambah-pembayaran/order/${digits}`;
}

function normalizeSearch(value = '') {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRupiah(value = '') {
  const raw = cleanText(value).replace(/[^\d.,-]/g, '');
  if (!raw) return 0;

  // Format SGO/Indonesia: titik adalah pemisah ribuan, koma adalah desimal.
  // Jangan memakai digitsOnly karena "138.190.520,96" akan menjadi
  // 13.819.052.096 (harga melonjak 100x).
  const normalized = raw.replace(/\./g, '').replace(',', '.');
  const number = Number(normalized);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

function formatRupiah(value = 0) {
  const number = Math.round(Number(value));
  return `Rp ${(Number.isFinite(number) ? number : 0).toLocaleString('id-ID')}`;
}

function groupPhoneDigits(value = '') {
  const match = String(value).match(/^(\d{3})(\d{3,4})(\d+)$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function formatPhoneId(value = '') {
  const digits = digitsOnly(value);
  if (!digits) return '';

  if (digits.startsWith('62')) {
    return `+62 ${groupPhoneDigits(digits.slice(2))}`;
  }
  if (digits.startsWith('0')) {
    return `+62 ${groupPhoneDigits(digits.slice(1))}`;
  }
  return digits;
}

function whatsappUrl(value = '') {
  let digits = digitsOnly(value);
  if (!digits) return '';
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return `https://wa.me/${digits}`;
}

function phoneVariants(value = '') {
  const digits = digitsOnly(value);
  if (!digits) return [];

  const variants = new Set([digits]);
  if (digits.startsWith('62')) {
    variants.add(`0${digits.slice(2)}`);
  } else if (digits.startsWith('0')) {
    variants.add(`62${digits.slice(1)}`);
  }
  return [...variants];
}

function parseIndonesianDate(value = '') {
  const match = cleanText(value).match(
    /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/,
  );
  if (!match) return '';

  const day = Number(match[1]);
  const month = MONTHS.get(match[2].toLowerCase());
  const year = Number(match[3]);
  if (!day || !month || !year) return '';

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * `H+5 (lewat)` berarti keberangkatan sudah lewat 5 hari.
 * Nilai offset positif = sudah lewat; negatif = masih menuju H-0.
 */
function parseDepartureDays(value = '') {
  const label = cleanText(value);
  const match = label.match(/H\s*([+-])\s*(\d+)/i);
  const offset = match
    ? (match[1] === '+' ? 1 : -1) * Number(match[2])
    : null;

  return {
    label,
    offset: Number.isFinite(offset) ? offset : null,
  };
}

function toneFromClass(className = '') {
  const match = String(className || '').match(/ar-days--([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

function splitPackage(value = '') {
  const raw = cleanText(value);
  if (!raw) return { rtb: '', packageName: '' };

  const match = raw.match(
    /^RTB\s*([A-Za-z0-9-]+)\s*(?:[·•|]\s*)?(.*)$/i,
  );
  if (!match) {
    return { rtb: '', packageName: raw };
  }

  return {
    rtb: `RTB ${match[1]}`,
    packageName: cleanText(match[2]),
  };
}

function normalizeInvoiceUrl(value = '') {
  const raw = cleanText(value);
  if (!raw) return '';

  try {
    const url = new URL(raw, 'https://app.rahmahtravel.id');
    if (url.protocol !== 'https:') return '';
    if (!/(^|\.)rahmahtravel\.id$/i.test(url.hostname)) return '';
    if (!/^\/i\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function extractOrderNumber(href = '') {
  const match = String(href || '').match(/\/order\/(\d+)/i);
  return match ? match[1] : '';
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function pickNullableNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Parser halaman SGO                                                        */
/* -------------------------------------------------------------------------- */

function assertPenagihanPage($, kind = 'penagihan') {
  const title = cleanText($('title').text());
  if (/login/i.test(title)) {
    throw new FuPelunasanError(
      'Sesi SGO Admin tidak valid atau kedaluwarsa. Buka tombol Cookie SGO di header, tempel cookie baru, lalu simpan.',
      { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
    );
  }

  if (kind === 'kanban' && !$('.ar-kanban').length && !$('.ar-kcard').length) {
    throw new FuPelunasanError(
      'Struktur kanban Penagihan & Aging tidak ditemukan pada halaman SGO.',
      { code: 'FU_PELUNASAN_LAYOUT_ERROR' },
    );
  }

  if (kind === 'list' && !$('.ar-groups').length && !$('.ar-jamaah').length) {
    throw new FuPelunasanError(
      'Struktur daftar Penagihan & Aging tidak ditemukan pada halaman SGO.',
      { code: 'FU_PELUNASAN_LAYOUT_ERROR' },
    );
  }
}

function parseKanbanHtml(html = '') {
  const $ = cheerio.load(html);
  assertPenagihanPage($, 'kanban');

  const rows = [];

  $('.ar-kcard--RED').each((_, element) => {
    const card = $(element);
    const orderNumber = digitsOnly(card.attr('data-order'));
    if (!orderNumber) return;

    const paketText = cleanText(
      card.find('.ar-kcard__paket').first().text(),
    );
    const { rtb, packageName } = splitPackage(paketText);

    const daysEl = card.find('.ar-days').first();
    const days = parseDepartureDays(daysEl.text());
    const sisaFromText = parseRupiah(
      card.find('.ar-kcard__meta strong').first().text(),
    );
    const sisaAmount = firstFiniteNumber(
      card.attr('data-sisa'),
      sisaFromText,
    );

    const column = card.closest('.ar-kcol');
    const columnLabel =
      cleanText(column.find('.ar-kcol__hd span').first().text()) ||
      cleanText(column.attr('data-status'));

    rows.push({
      orderNumber,
      name: firstText(
        card.find('.ar-kcard__top strong').first().text(),
        card.find('strong').first().text(),
      ),
      packageName,
      rtb,
      departureDays: days.label,
      daysOffset: days.offset,
      departureTone: toneFromClass(daysEl.attr('class')),
      departureDate: '',
      departureIso: '',
      sisaAmount,
      invoiceUrl: '',
      phone: '',
      pax: 0,
      paidAmount: 0,
      totalAmount: 0,
      paidPercent: 0,
      lateLabel: '',
      nextAction: '',
      followUpStatus: columnLabel,
      sgoUrl: sgoDetailUrl(orderNumber),
    });
  });

  return rows;
}

function parseListHtml(html = '') {
  const $ = cheerio.load(html);
  assertPenagihanPage($, 'list');

  const rows = [];

  $('.ar-jamaah').each((_, element) => {
    const item = $(element);
    const risk =
      cleanText(item.find('.ar-risk-mini').first().text()).toUpperCase() ||
      (item.hasClass('ar-jamaah--RED') ? 'RED' : '');

    // Halaman sudah difilter `risk=RED`, tetapi tetap saring ulang supaya
    // modul tidak pernah menampilkan risiko lain bila markup berubah.
    if (risk && risk !== 'RED') return;

    const orderNumber =
      extractOrderNumber(item.find('.ar-act--detail').attr('href')) ||
      extractOrderNumber(item.find('.ar-act--pay').attr('href')) ||
      extractOrderNumber(item.find('.ar-act--fu').attr('hx-get')) ||
      digitsOnly(
        cleanText(item.attr('data-search'))
          .split(' ')
          .filter(Boolean)
          .pop() || '',
      );

    if (!orderNumber) return;

    const group = item.closest('.ar-group');
    const groupRtb = cleanText(group.find('.ar-group__rtb').first().text());
    const groupName = cleanText(group.find('.ar-group__name').first().text());
    const groupDaysEl = group.find('.ar-group__hd-right .ar-days').first();
    const groupDays = parseDepartureDays(groupDaysEl.text());
    const groupDate = cleanText(
      group.find('.ar-group__hd-right .muted.small').first().text(),
    ).replace(/^[^\p{L}\p{N}]+/u, '');

    const metaText = cleanText(
      item.find('.ar-jamaah__left .muted.small').first().text(),
    );
    const phoneMatch = metaText.match(/(\+?\d[\d\s-]{7,}\d)/);
    const phone = digitsOnly(phoneMatch?.[1] || '');
    const paxMatch = metaText.match(/(\d+)\s*pax/i);

    const progress = item.find('.ar-jamaah__progress').first();
    const paidText = cleanText(
      progress.find('.ar-jamaah__progress-row strong').first().text(),
    );
    const totalText = cleanText(
      progress
        .find('.ar-jamaah__progress-row span.small')
        .not('.muted')
        .first()
        .text(),
    );
    const totalFromRow = parseRupiah(
      totalText.match(/\/\s*Rp\s*([\d.,]+)/i)?.[1] || totalText,
    );
    const paidAmount = parseRupiah(paidText);
    const sisaText = cleanText(
      progress
        .find('.muted.small strong')
        .filter((_, element) => /Sisa/i.test($(element).parent().text()))
        .first()
        .text(),
    );
    const sisaFromText = parseRupiah(sisaText);
    const totalAmount = firstFiniteNumber(
      totalFromRow,
      paidAmount + sisaFromText,
    );

    const percentStyle = String(
      item.find('.ar-bar__fill').first().attr('style') || '',
    );
    const percentMatch = percentStyle.match(/width\s*:\s*(\d+(?:\.\d+)?)%/i);
    const paidPercent = percentMatch
      ? Math.max(0, Math.min(100, Math.round(Number(percentMatch[1]))))
      : totalAmount > 0
        ? Math.max(0, Math.min(100, Math.round((paidAmount / totalAmount) * 100)))
        : 0;

    const invoiceUrl = normalizeInvoiceUrl(
      item.find('a.ar-act--inv').attr('href') || '',
    );

    const lateLabel = [
      ...new Set(
        item
          .find('.ar-late')
          .map((__, el) => cleanText($(el).text()))
          .get()
          .filter(Boolean),
      ),
    ].join(' · ');

    const nextAction = [
      ...new Set(
        item
          .find('.ar-next-action')
          .map((__, el) => cleanText($(el).text()))
          .get()
          .filter(Boolean),
      ),
    ].join(' · ');

    rows.push({
      orderNumber,
      name: firstText(
        item.find('.ar-jamaah__name-row strong').first().text(),
        cleanText(item.attr('data-search')).split(' ').slice(0, 4).join(' '),
      ),
      packageName: groupName,
      rtb: groupRtb,
      departureDays: groupDays.label,
      daysOffset: groupDays.offset,
      departureTone: toneFromClass(groupDaysEl.attr('class')),
      departureDate: groupDate,
      departureIso: parseIndonesianDate(groupDate),
      sisaAmount: sisaText
        ? sisaFromText
        : totalAmount > paidAmount
          ? totalAmount - paidAmount
          : 0,
      invoiceUrl,
      phone,
      pax: paxMatch ? Number(paxMatch[1]) : 0,
      paidAmount,
      totalAmount,
      paidPercent,
      lateLabel,
      nextAction,
      followUpStatus: '',
      sgoUrl: sgoDetailUrl(orderNumber),
    });
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Penggabungan dua sumber                                                    */
/* -------------------------------------------------------------------------- */

function buildSearchText(row = {}) {
  return normalizeSearch(
    [
      row.orderNumber,
      row.name,
      row.packageName,
      row.rtb,
      row.departureDays,
      row.departureDate,
      row.departureIso,
      row.sisaLabel,
      row.invoiceUrl,
      row.phone,
      row.phoneDisplay,
      ...phoneVariants(row.phone),
      row.lateLabel,
      row.nextAction,
      row.followUpStatus,
      row.pax ? `${row.pax} pax` : '',
      row.risk,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function mergePenagihanRows({ kanbanRows = [], listRows = [], cacheRows = [] }) {
  const kanbanMap = new Map(
    kanbanRows.map((row) => [row.orderNumber, row]),
  );
  const listMap = new Map(listRows.map((row) => [row.orderNumber, row]));
  const cacheMap = new Map(cacheRows.map((row) => [row.orderNumber, row]));

  // Gabungan sumber yang berhasil. Cache hanya dipakai untuk melengkapi
  // field yang hilang pada order yang masih ada di sumber live.
  const orderNumbers = new Set([
    ...kanbanMap.keys(),
    ...listMap.keys(),
  ]);

  const merged = [];

  orderNumbers.forEach((orderNumber) => {
    const kanban = kanbanMap.get(orderNumber) || null;
    const list = listMap.get(orderNumber) || null;
    const cache = cacheMap.get(orderNumber) || null;

    if (!kanban && !list && !cache) return;

    const sisaAmount = firstFiniteNumber(
      kanban?.sisaAmount,
      list?.sisaAmount,
      cache?.sisaAmount,
    );
    const departureDays = firstText(
      kanban?.departureDays,
      list?.departureDays,
      cache?.departureDays,
    );
    const parsedDays = parseDepartureDays(departureDays);
    const daysOffset = pickNullableNumber(
      kanban?.daysOffset,
      list?.daysOffset,
      cache?.daysOffset,
      parsedDays.offset,
    );

    const row = {
      orderNumber,
      name: firstText(kanban?.name, list?.name, cache?.name),
      packageName: firstText(
        kanban?.packageName,
        list?.packageName,
        cache?.packageName,
      ),
      rtb: firstText(kanban?.rtb, list?.rtb, cache?.rtb),
      departureDays,
      daysOffset,
      departureTone: firstText(
        kanban?.departureTone,
        list?.departureTone,
        cache?.departureTone,
      ),
      departureDate: firstText(
        list?.departureDate,
        cache?.departureDate,
        kanban?.departureDate,
      ),
      departureIso: firstText(
        list?.departureIso,
        cache?.departureIso,
        kanban?.departureIso,
      ),
      sisaAmount,
      invoiceUrl: firstText(
        list?.invoiceUrl,
        cache?.invoiceUrl,
        kanban?.invoiceUrl,
      ),
      phone: firstText(list?.phone, cache?.phone, kanban?.phone),
      pax: firstFiniteNumber(list?.pax, cache?.pax, kanban?.pax),
      paidAmount: firstFiniteNumber(
        list?.paidAmount,
        cache?.paidAmount,
        kanban?.paidAmount,
      ),
      totalAmount: firstFiniteNumber(
        list?.totalAmount,
        cache?.totalAmount,
        kanban?.totalAmount,
      ),
      paidPercent: firstFiniteNumber(
        list?.paidPercent,
        cache?.paidPercent,
        kanban?.paidPercent,
      ),
      lateLabel: firstText(
        list?.lateLabel,
        cache?.lateLabel,
        kanban?.lateLabel,
      ),
      nextAction: firstText(
        list?.nextAction,
        cache?.nextAction,
        kanban?.nextAction,
      ),
      followUpStatus: firstText(
        kanban?.followUpStatus,
        cache?.followUpStatus,
        list?.followUpStatus,
      ),
      sgoUrl: sgoDetailUrl(orderNumber),
      risk: 'RED',
    };

    row.sisaLabel = formatRupiah(sisaAmount);
    row.phoneDisplay = formatPhoneId(row.phone);
    row.waUrl = whatsappUrl(row.phone);
    row.searchText = buildSearchText(row);

    merged.push(row);
  });

  merged.sort((left, right) => {
    const leftOffset = Number.isFinite(left.daysOffset)
      ? left.daysOffset
      : -Infinity;
    const rightOffset = Number.isFinite(right.daysOffset)
      ? right.daysOffset
      : -Infinity;

    if (leftOffset !== rightOffset) return rightOffset - leftOffset;
    if (right.sisaAmount !== left.sisaAmount) {
      return right.sisaAmount - left.sisaAmount;
    }
    return left.name.localeCompare(right.name, 'id');
  });

  return merged;
}

function buildSummary(rows = []) {
  const overdueCount = rows.filter(
    (row) =>
      String(row.departureDays || '').includes('+') ||
      row.departureTone === 'past' ||
      Number(row.daysOffset) > 0,
  ).length;

  const urgentCount = rows.filter((row) => {
    const offset = Number(row.daysOffset);
    return Number.isFinite(offset) && offset <= 0 && offset >= -7;
  }).length;

  const invoiceCount = rows.filter((row) => row.invoiceUrl).length;

  return {
    totalJamaah: rows.length,
    totalOrders: rows.length,
    totalPiutang: rows.reduce(
      (sum, row) => sum + (Number(row.sisaAmount) || 0),
      0,
    ),
    overdueCount,
    urgentCount,
    invoiceCount,
  };
}

/* -------------------------------------------------------------------------- */
/* SQLite                                                                     */
/* -------------------------------------------------------------------------- */

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fu_pelunasan_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_order INTEGER NOT NULL DEFAULT 0,
      order_number TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      package_name TEXT NOT NULL DEFAULT '',
      rtb TEXT NOT NULL DEFAULT '',
      departure_days TEXT NOT NULL DEFAULT '',
      days_offset INTEGER,
      departure_tone TEXT NOT NULL DEFAULT '',
      departure_date TEXT NOT NULL DEFAULT '',
      departure_iso TEXT NOT NULL DEFAULT '',
      sisa_amount INTEGER NOT NULL DEFAULT 0,
      invoice_url TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      pax INTEGER NOT NULL DEFAULT 0,
      paid_amount INTEGER NOT NULL DEFAULT 0,
      total_amount INTEGER NOT NULL DEFAULT 0,
      paid_percent INTEGER NOT NULL DEFAULT 0,
      late_label TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      follow_up_status TEXT NOT NULL DEFAULT '',
      sgo_url TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT 'RED',
      search_text TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_fu_pelunasan_rows_order
      ON fu_pelunasan_rows (row_order);

    CREATE TABLE IF NOT EXISTS fu_pelunasan_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
}

function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  if (!schemaReady) {
    createSchema(db);
    schemaReady = true;
  }

  return db;
}

function readMeta() {
  const rows = getDb().prepare('SELECT key, value FROM fu_pelunasan_meta').all();
  const meta = {};
  rows.forEach((row) => {
    meta[row.key] = row.value;
  });
  return meta;
}

function writeMeta(database, values = {}) {
  const statement = database.prepare(`
    INSERT INTO fu_pelunasan_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  Object.entries(values).forEach(([key, value]) => {
    statement.run(key, value == null ? '' : String(value));
  });
}

function markSyncError(message) {
  try {
    const database = getDb();
    const values = {
      last_error: cleanText(message).slice(0, 500),
      last_attempt_at: new Date().toISOString(),
    };
    database.exec('BEGIN IMMEDIATE;');
    try {
      writeMeta(database, values);
      database.exec('COMMIT;');
    } catch (error) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        /* transaksi mungkin sudah dibatalkan */
      }
      throw error;
    }
  } catch {
    /* kegagalan mencatat error tidak boleh menutupi error utama */
  }
}

function saveSnapshot(rows, warning = '') {
  const database = getDb();
  const syncedAt = new Date().toISOString();
  const summary = buildSummary(rows);

  const insert = database.prepare(`
    INSERT INTO fu_pelunasan_rows (
      row_order, order_number, name, package_name, rtb, departure_days,
      days_offset, departure_tone, departure_date, departure_iso,
      sisa_amount, invoice_url, phone, pax, paid_amount, total_amount,
      paid_percent, late_label, next_action, follow_up_status, sgo_url,
      risk, search_text
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `);

  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec('DELETE FROM fu_pelunasan_rows;');

    rows.forEach((row, index) => {
      insert.run(
        index,
        row.orderNumber,
        row.name,
        row.packageName,
        row.rtb,
        row.departureDays,
        row.daysOffset,
        row.departureTone,
        row.departureDate,
        row.departureIso,
        row.sisaAmount,
        row.invoiceUrl,
        row.phone,
        row.pax,
        row.paidAmount,
        row.totalAmount,
        row.paidPercent,
        row.lateLabel,
        row.nextAction,
        row.followUpStatus,
        row.sgoUrl,
        row.risk || 'RED',
        row.searchText,
      );
    });

    writeMeta(database, {
      last_synced_at: syncedAt,
      last_attempt_at: syncedAt,
      last_error: '',
      last_warning: cleanText(warning),
      total_jamaah: summary.totalJamaah,
      total_piutang: summary.totalPiutang,
      total_invoice: summary.invoiceCount,
      overdue_count: summary.overdueCount,
      urgent_count: summary.urgentCount,
    });

    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      /* transaksi mungkin sudah dibatalkan */
    }
    throw error;
  }

  return { syncedAt, summary };
}

function readAllRows() {
  return getDb()
    .prepare('SELECT * FROM fu_pelunasan_rows ORDER BY row_order ASC')
    .all();
}

function mapRow(row) {
  return {
    orderNumber: row.order_number || '',
    name: row.name || '',
    packageName: row.package_name || '',
    rtb: row.rtb || '',
    departureDays: row.departure_days || '',
    daysOffset:
      row.days_offset == null ? null : Number(row.days_offset),
    departureTone: row.departure_tone || '',
    departureDate: row.departure_date || '',
    departureIso: row.departure_iso || '',
    sisaAmount: Number(row.sisa_amount || 0),
    sisaLabel:
      formatRupiah(row.sisa_amount) || 'Rp 0',
    invoiceUrl: row.invoice_url || '',
    phone: row.phone || '',
    phoneDisplay: formatPhoneId(row.phone),
    waUrl: whatsappUrl(row.phone),
    pax: Number(row.pax || 0),
    paidAmount: Number(row.paid_amount || 0),
    totalAmount: Number(row.total_amount || 0),
    paidPercent: Number(row.paid_percent || 0),
    lateLabel: row.late_label || '',
    nextAction: row.next_action || '',
    followUpStatus: row.follow_up_status || '',
    sgoUrl: sgoDetailUrl(row.order_number) || row.sgo_url || '',
    risk: row.risk || 'RED',
  };
}

function readRowsFromDb(query = '') {
  const rows = readAllRows();
  const terms = normalizeSearch(query).split(' ').filter(Boolean);

  if (!terms.length) return rows.map(mapRow);

  return rows
    .filter((row) =>
      terms.every((term) =>
        String(row.search_text || '').includes(term),
      ),
    )
    .map(mapRow);
}

function isFresh(meta = {}) {
  if (!meta.last_synced_at) return false;

  const syncedAt = Date.parse(meta.last_synced_at);
  if (!Number.isFinite(syncedAt)) return false;

  return Date.now() - syncedAt < CACHE_TTL_MS;
}

/* -------------------------------------------------------------------------- */
/* Pengambilan halaman SGO                                                    */
/* -------------------------------------------------------------------------- */

async function fetchPenagihanPage(kind) {
  const cookieHeader = getRequestSgoCookieHeader();
  if (!cookieHeader) {
    throw new FuPelunasanError(
      'Cookie SGO belum diatur di perangkat ini. Buka tombol Cookie SGO di header untuk menyimpan sesi login.',
      { code: 'SGO_SESSION_MISSING', statusCode: 503 },
    );
  }

  const params = new URLSearchParams({ risk: 'RED' });
  if (kind === 'kanban') params.set('view', 'kanban');
  const url = `${SGO_BASE_URL}${PENAGIHAN_PATH}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        ...SGO_BROWSER_HEADERS,
        Cookie: cookieHeader,
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new FuPelunasanError(
        'Sesi SGO Admin ditolak. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    if (!response.ok) {
      throw new FuPelunasanError(
        `SGO mengembalikan HTTP ${response.status} saat memuat Penagihan & Aging.`,
        { code: 'SGO_HTTP_ERROR' },
      );
    }

    const finalUrl = String(response.url || '');
    const html = await response.text();

    if (/\/login(?:[?#/]|$)/i.test(finalUrl)) {
      throw new FuPelunasanError(
        'Sesi SGO Admin kedaluwarsa dan diarahkan ke halaman login. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    if (/<title>\s*Login\b/i.test(html)) {
      throw new FuPelunasanError(
        'Sesi SGO Admin kedaluwarsa. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    return html;
  } catch (error) {
    if (error instanceof FuPelunasanError) throw error;
    if (error.name === 'AbortError') {
      throw new FuPelunasanError(
        'Permintaan ke SGO melewati batas waktu. Coba muat ulang.',
        { code: 'SGO_TIMEOUT' },
      );
    }
    throw new FuPelunasanError(
      `Gagal menghubungi SGO: ${error.message}`,
      { code: 'SGO_NETWORK_ERROR' },
    );
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Sinkronisasi & snapshot                                                    */
/* -------------------------------------------------------------------------- */

async function syncSnapshot(meta) {
  const cacheRows = readAllRows();
  const [kanbanResult, listResult] = await Promise.allSettled([
    fetchPenagihanPage('kanban'),
    fetchPenagihanPage('list'),
  ]);

  const warnings = [];
  let kanbanRows = null;
  let listRows = null;

  if (kanbanResult.status === 'fulfilled') {
    try {
      kanbanRows = parseKanbanHtml(kanbanResult.value);
    } catch (error) {
      warnings.push(`Kanban SGO gagal dibaca: ${error.message}`);
    }
  } else {
    warnings.push(`Kanban SGO gagal dimuat: ${kanbanResult.reason?.message || 'tidak diketahui'}`);
  }

  if (listResult.status === 'fulfilled') {
    try {
      listRows = parseListHtml(listResult.value);
    } catch (error) {
      warnings.push(`Daftar SGO gagal dibaca: ${error.message}`);
    }
  } else {
    warnings.push(`Daftar SGO gagal dimuat: ${listResult.reason?.message || 'tidak diketahui'}`);
  }

  const hasKanban = Array.isArray(kanbanRows);
  const hasList = Array.isArray(listRows);

  if (!hasKanban && !hasList) {
    const message = warnings.join(' ') || 'Gagal memuat data Penagihan & Aging.';

    if (cacheRows.length) {
      markSyncError(message);
      return {
        syncedAt: meta.last_synced_at || null,
        stale: true,
        warning: `${message} Menampilkan cache SQLite terakhir.`.trim(),
      };
    }

    throw new FuPelunasanError(message, {
      code: 'FU_PELUNASAN_SYNC_ERROR',
    });
  }

  const merged = mergePenagihanRows({
    kanbanRows: hasKanban ? kanbanRows : [],
    listRows: hasList ? listRows : [],
    cacheRows,
  });

  if (hasKanban && hasList) {
    const missingInvoice = merged.filter((row) => !row.invoiceUrl).length;
    if (missingInvoice) {
      warnings.push(
        `${missingInvoice.toLocaleString('id-ID')} jamaah belum memiliki link invoice pada halaman SGO.`,
      );
    }
  } else if (!hasList) {
    const missingInvoice = merged.filter((row) => !row.invoiceUrl).length;
    if (missingInvoice) {
      warnings.push(
        `Link invoice belum dapat dimuat untuk ${missingInvoice.toLocaleString('id-ID')} jamaah. Gunakan cache invoice terakhir bila tersedia.`,
      );
    }
  }

  const warning = warnings.join(' ');
  const saved = saveSnapshot(merged, warning);

  return {
    syncedAt: saved.syncedAt,
    stale: !hasKanban || !hasList,
    warning,
  };
}

async function ensureSnapshot(force = false) {
  if (inflightSync) return inflightSync;

  const meta = readMeta();
  if (!force && isFresh(meta)) {
    return {
      syncedAt: meta.last_synced_at || null,
      stale: false,
      warning: meta.last_warning || '',
    };
  }

  const promise = syncSnapshot(meta).finally(() => {
    inflightSync = null;
  });
  inflightSync = promise;
  return promise;
}

/**
 * Snapshot FU Pelunasan dari cache SQLite.
 * Sumber live: kanban RED untuk nama/status H/sisa tagihan, lalu list RED
 * untuk link invoice, nomor HP, pax, dan progres pembayaran.
 */
export async function getFuPelunasanSnapshot({
  query = '',
  force = false,
} = {}) {
  const sync = await ensureSnapshot(Boolean(force));
  const meta = readMeta();
  const allRows = readAllRows();
  const mappedAll = allRows.map(mapRow);
  const summary = buildSummary(mappedAll);

  const rows = readRowsFromDb(query);

  const warnings = [];
  if (sync.warning) warnings.push(sync.warning);
  if (meta.last_error && sync.stale) {
    warnings.push(`Sinkronisasi terakhir gagal: ${meta.last_error}`);
  }

  return {
    rows,
    total: rows.length,
    totalAll: mappedAll.length,
    query: cleanText(query),
    summary,
    lastSyncedAt: meta.last_synced_at || sync.syncedAt || null,
    lastAttemptAt: meta.last_attempt_at || null,
    stale: Boolean(sync.stale),
    warning: [...new Set(warnings)].join(' ') || null,
    source: {
      type: 'sgo-sqlite',
      module: PENAGIHAN_PATH,
      database: 'sqlite',
      risk: 'RED',
    },
  };
}
