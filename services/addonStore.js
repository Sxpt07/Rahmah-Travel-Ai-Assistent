/**
 * Store & sinkronisasi Add-on Per Batch.
 *
 * Sumber data SGO Admin:
 * - `?tab=perbatch`        : daftar 255 batch (RTB) + ringkasan per batch.
 * - `?tab=rekap`           : rekap global 62 jenis add-on.
 * - `?tab=rekap&batch=ID`  : rekap per jenis add-on untuk satu RTB.
 * - `export?label=...`     : rincian jamaah per jenis add-on (semua batch).
 * - `monitoring-jamaah/export-rtb` + `unduh?paket_id=` : pemesan, kode order,
 *   paket, dan tanggal berangkat per RTB (XLSX).
 *
 * Semua data disimpan ke SQLite agar pencarian RTB / nama / kode order cepat
 * dan tidak membebani SGO. Baris hasil export di-upsert dengan kunci tetap
 * sehingga sinkronisasi berulang memperbarui data, bukan menduplikasi.
 */

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import {
  SGO_BROWSER_HEADERS,
} from './sgoScraper.js';
import { getRequestSgoCookieHeader } from './sgoRequestContext.js';
import { getAllJamaah } from '../data/jamaahStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH =
  process.env.ADDON_DB_PATH || path.join(DATA_DIR, 'addon_per_batch.sqlite');
const SGO_BASE_URL = String(
  process.env.SGO_BASE_URL || 'https://sgo.rahmahgrup.id',
).replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Math.max(
  15_000,
  Number(process.env.ADDON_FETCH_TIMEOUT_MS || 60_000) || 60_000,
);
const CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.ADDON_CACHE_TTL_MS || 15 * 60 * 1000) || 15 * 60 * 1000,
);
const EXPORT_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.ADDON_EXPORT_CONCURRENCY || 4) || 4),
);
const BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(process.env.ADDON_BATCH_CONCURRENCY || 8) || 8),
);
const RTB_CONCURRENCY = Math.max(
  1,
  Math.min(10, Number(process.env.ADDON_RTB_CONCURRENCY || 6) || 6),
);

const ADDON_PATH = '/ops/add-on';
const RTB_PANEL_PATH = '/ops/monitoring-jamaah/export-rtb';
const MAX_SNAPSHOT_ROWS = 900;
const MAX_CHAT_ROWS = 8;

const MONTHS = new Map([
  ['jan', 1],
  ['januari', 1],
  ['feb', 2],
  ['februari', 2],
  ['mar', 3],
  ['maret', 3],
  ['apr', 4],
  ['april', 4],
  ['may', 5],
  ['mei', 5],
  ['jun', 6],
  ['juni', 6],
  ['jul', 7],
  ['juli', 7],
  ['aug', 8],
  ['agu', 8],
  ['agus', 8],
  ['agustus', 8],
  ['sep', 9],
  ['sept', 9],
  ['september', 9],
  ['oct', 10],
  ['okt', 10],
  ['oktober', 10],
  ['nov', 11],
  ['november', 11],
  ['dec', 12],
  ['des', 12],
  ['desember', 12],
]);

export class AddonStoreError extends Error {
  constructor(message, { code = 'ADDON_ERROR', statusCode = 502 } = {}) {
    super(message);
    this.name = 'AddonStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/* -------------------------------------------------------------------------- */
/* Utilitas                                                                   */
/* -------------------------------------------------------------------------- */

function clean(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function digits(value) {
  return clean(value).replace(/\D/g, '');
}

function rtbDigits(value) {
  const text = clean(value);
  const match = text.match(/RTB\s*[-\s]?\s*(\d{1,5})/i);
  if (match) return String(Number(match[1]));
  const only = text.replace(/\D/g, '');
  return only ? String(Number(only)) : '';
}

function orderShortCode(value) {
  const text = clean(value).toUpperCase();
  const match = text.match(/(\d{3,})\s*$/);
  if (match) return match[1].replace(/^0+(?=\d)/, '');
  return '';
}

function nameKey(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function normalizeSearch(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function parseNumber(value) {
  const text = clean(value);
  if (!text || text === '—' || text === '-') return 0;
  const only = text.replace(/[^\d]/g, '');
  return only ? Number(only) : 0;
}

function parseIsoDate(value) {
  const text = clean(value);
  if (!text) return '';

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return `${String(year).padStart(4, '0')}-${String(Number(slash[2])).padStart(
      2,
      '0',
    )}-${String(Number(slash[1])).padStart(2, '0')}`;
  }

  const named = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = MONTHS.get(named[2].toLowerCase());
    if (month) {
      return `${named[3]}-${String(month).padStart(2, '0')}-${String(
        Number(named[1]),
      ).padStart(2, '0')}`;
    }
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return '';
}

function formatRupiah(value) {
  const number = Number(value) || 0;
  return `Rp${number.toLocaleString('id-ID')}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function nowIso() {
  return new Date().toISOString();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function statusFromClass(className = '', text = '') {
  const cls = String(className || '').toLowerCase();
  const label = clean(text).toLowerCase();
  if (cls.includes('st-verified') || /verified|terverifikasi|valid/.test(label)) {
    return 'verified';
  }
  if (cls.includes('st-pending') || /pending|menunggu|proses/.test(label)) {
    return 'pending';
  }
  return 'none';
}

function stateFromStatus(status, price) {
  if (status === 'verified') return 'verified';
  if (status === 'pending') return 'pending';
  return Number(price) > 0 ? 'unpaid' : 'free';
}

function stateLabel(state) {
  switch (state) {
    case 'verified':
      return 'Terverifikasi';
    case 'pending':
      return 'Menunggu verifikasi';
    case 'unpaid':
      return 'Belum bayar';
    case 'free':
      return 'Gratis';
    default:
      return 'Belum diverifikasi';
  }
}

function departureLabel(iso) {
  if (!iso) return '';
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;

  async function run() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), list.length) }, run),
  );
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* SQLite                                                                     */
/* -------------------------------------------------------------------------- */

let db = null;
let schemaReady = false;
let inflightSync = null;

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sgo_addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_key TEXT NOT NULL UNIQUE,
      sync_id TEXT NOT NULL DEFAULT '',
      rtb_number TEXT NOT NULL DEFAULT '',
      order_code TEXT NOT NULL DEFAULT '',
      order_short TEXT NOT NULL DEFAULT '',
      pemesan_name TEXT NOT NULL DEFAULT '',
      jamaah_name TEXT NOT NULL DEFAULT '',
      addon_item TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 1,
      price INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'none',
      status_label TEXT NOT NULL DEFAULT '',
      bukti TEXT NOT NULL DEFAULT '',
      package_name TEXT NOT NULL DEFAULT '',
      departure_date TEXT NOT NULL DEFAULT '',
      departure_iso TEXT NOT NULL DEFAULT '',
      payment_status TEXT NOT NULL DEFAULT '',
      payment_percent INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_sgo_addons_rtb
      ON sgo_addons (rtb_number);
    CREATE INDEX IF NOT EXISTS idx_sgo_addons_order
      ON sgo_addons (order_short);
    CREATE INDEX IF NOT EXISTS idx_sgo_addons_item
      ON sgo_addons (addon_item);

    CREATE TABLE IF NOT EXISTS sgo_addon_batches (
      rtb_number TEXT PRIMARY KEY,
      sync_id TEXT NOT NULL DEFAULT '',
      paket_name TEXT NOT NULL DEFAULT '',
      departure_date TEXT NOT NULL DEFAULT '',
      departure_iso TEXT NOT NULL DEFAULT '',
      status_code TEXT NOT NULL DEFAULT '',
      status_label TEXT NOT NULL DEFAULT '',
      ref_qty INTEGER NOT NULL DEFAULT 0,
      ref_paid INTEGER NOT NULL DEFAULT 0,
      ref_revenue INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER NOT NULL DEFAULT 0,
      paid_qty INTEGER NOT NULL DEFAULT 0,
      free_qty INTEGER NOT NULL DEFAULT 0,
      revenue INTEGER NOT NULL DEFAULT 0,
      order_count INTEGER NOT NULL DEFAULT 0,
      jamaah_count INTEGER NOT NULL DEFAULT 0,
      package_id TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sgo_addon_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rtb_number TEXT NOT NULL,
      addon_item TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 0,
      free INTEGER NOT NULL DEFAULT 0,
      revenue INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE (rtb_number, addon_item)
    );

    CREATE INDEX IF NOT EXISTS idx_sgo_addon_batch_items_rtb
      ON sgo_addon_batch_items (rtb_number);

    CREATE TABLE IF NOT EXISTS sgo_addon_items (
      addon_item TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 0,
      free INTEGER NOT NULL DEFAULT 0,
      revenue INTEGER NOT NULL DEFAULT 0,
      detail_rows INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sgo_addon_meta (
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
  db.exec('PRAGMA busy_timeout = 8000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  if (!schemaReady) {
    createSchema(db);
    schemaReady = true;
  }
  return db;
}

function readMeta() {
  const rows = getDb().prepare('SELECT key, value FROM sgo_addon_meta').all();
  const meta = {};
  rows.forEach((row) => {
    meta[row.key] = row.value;
  });
  return meta;
}

function writeMeta(database, values = {}) {
  const statement = database.prepare(`
    INSERT INTO sgo_addon_meta (key, value)
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
    database.exec('BEGIN IMMEDIATE;');
    try {
      writeMeta(database, {
        last_error: clean(message).slice(0, 700),
        last_attempt_at: nowIso(),
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
  } catch {
    /* jangan menutupi error utama */
  }
}

function readItemLabelsFromDb() {
  return getDb()
    .prepare('SELECT addon_item FROM sgo_addon_items ORDER BY sort_order ASC')
    .all()
    .map((row) => row.addon_item)
    .filter(Boolean);
}

function isFresh(meta = {}) {
  if (!meta.last_synced_at) return false;
  const parsed = Date.parse(meta.last_synced_at);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed < CACHE_TTL_MS;
}

/* -------------------------------------------------------------------------- */
/* Parser halaman SGO                                                         */
/* -------------------------------------------------------------------------- */

function parsePerbatchHtml(html) {
  const $ = cheerio.load(html);
  const table = $('table.keu-tbl').first();
  const batches = [];
  let sortOrder = 0;

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 7) return;
    const rtb = rtbDigits(tds.eq(0).text());
    if (!rtb) return;

    const statusLabel = clean(tds.eq(3).text());
    const lower = statusLabel.toLowerCase();
    const statusCode = /akan/.test(lower)
      ? 'akan'
      : /sedang/.test(lower)
        ? 'sedang'
        : /sudah|selesai/.test(lower)
          ? 'sudah'
          : '';

    const departureDate = clean(tds.eq(2).text());
    batches.push({
      rtb,
      paketName: clean(tds.eq(1).text()),
      departureDate,
      departureIso: parseIsoDate(departureDate),
      statusCode,
      statusLabel,
      refQty: parseNumber(tds.eq(4).text()),
      refPaid: parseNumber(tds.eq(5).text()),
      refRevenue: parseNumber(tds.eq(6).text()),
      sortOrder: sortOrder++,
    });
  });

  return batches;
}

function parseExportLabels(html) {
  const $ = cheerio.load(html);
  const labels = [];
  $('input[name="label"]').each((_, el) => {
    const value = clean($(el).attr('value'));
    if (value && !labels.includes(value)) labels.push(value);
  });
  return labels;
}

function parseRekapHtml(html) {
  const $ = cheerio.load(html);
  const table = $('table.keu-tbl').first();
  const items = [];
  let category = '';
  let sortOrder = 0;

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length === 1) {
      const label = clean(tds.eq(0).text());
      if (label) category = label;
      return;
    }
    if (tds.length < 5) return;
    const item = clean(tds.eq(0).text());
    if (!item) return;
    items.push({
      item,
      category,
      qty: parseNumber(tds.eq(1).text()),
      paid: parseNumber(tds.eq(2).text()),
      free: parseNumber(tds.eq(3).text()),
      revenue: parseNumber(tds.eq(4).text()),
      sortOrder: sortOrder++,
    });
  });

  return items;
}

function parseGlobalExportHtml(html, label) {
  const $ = cheerio.load(html);
  const table = $('table.eh-table').first();
  const rows = [];
  let currentStatus = 'none';
  let currentStatusLabel = '';
  let currentBukti = '';
  let currentGroup = '';

  table.find('tbody tr').each((_, tr) => {
    const node = $(tr);
    const name = clean(node.attr('data-name') || node.find('.col-nama').text());
    if (!name) return;

    const groupRaw = clean(node.attr('data-grp') || '');
    if (groupRaw && groupRaw !== currentGroup) {
      currentGroup = groupRaw;
      currentStatus = 'none';
      currentStatusLabel = '';
      currentBukti = '';
    }

    const statusCell = node.find('.col-status');
    if (statusCell.length) {
      const badge = statusCell.find('.st-badge').first();
      const span = badge.length ? badge : statusCell.find('span').first();
      currentStatus = statusFromClass(
        badge.attr('class') || span.attr('class') || '',
        statusCell.text(),
      );
      currentStatusLabel = clean(statusCell.text());
    }

    const buktiCell = node.find('.col-bukti');
    if (buktiCell.length) {
      currentBukti = clean(buktiCell.text());
    }

    const rtb = rtbDigits(node.find('.col-rtb').text());
    if (!rtb) return;

    const price = parseNumber(node.find('.col-harga').text());
    const status = currentStatus === 'none' ? 'none' : currentStatus;
    const orderShort = orderShortCode(groupRaw);

    rows.push({
      rtb,
      orderShort,
      orderCode: '',
      pemesanName: '',
      jamaahName: name,
      item: label,
      price,
      status,
      statusLabel: currentStatusLabel || clean(statusCell.text()),
      bukti: currentBukti,
      state: stateFromStatus(status, price),
    });
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Pembaca XLSX (ZIP + XML)                                                   */
/* -------------------------------------------------------------------------- */

function unzipEntries(buffer) {
  const eocdOffset = buffer.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  );
  if (eocdOffset < 0) throw new Error('File XLSX tidak valid (EOCD).');

  const count = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Header ZIP tidak valid.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart =
      localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(
      dataStart,
      dataStart + compressedSize,
    );
    entries.set(
      name,
      method === 0 ? compressed : zlib.inflateRawSync(compressed),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXmlEntities(value = '') {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&');
}

function columnIndex(letters = '') {
  let value = 0;
  for (const char of String(letters).toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value - 1;
}

function parseXlsxRows(buffer) {
  const entries = unzipEntries(buffer);
  const sharedXml =
    entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [];
  for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [
      ...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g),
    ].map((item) => decodeXmlEntities(item[1]));
    shared.push(texts.join(''));
  }

  const sheetName =
    [...entries.keys()].find((name) =>
      /^xl\/worksheets\/sheet1\.xml$/.test(name),
    ) ||
    [...entries.keys()].find((name) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
    );
  if (!sheetName) throw new Error('Sheet XLSX tidak ditemukan.');
  const sheetXml = entries.get(sheetName).toString('utf8');
  const rows = [];

  for (const rowMatch of sheetXml.matchAll(
    /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g,
  )) {
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(
      /<c[^>]*r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g,
    )) {
      const column = columnIndex(cellMatch[1]);
      const attrs = cellMatch[3];
      const inner = cellMatch[4];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? '';
      let value = raw;
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((item) => decodeXmlEntities(item[1]))
          .join('');
      } else {
        value = decodeXmlEntities(raw);
      }
      cells[column] = value;
    }
    rows.push(cells);
  }

  return rows;
}

function xlsxToRecords(buffer) {
  const rows = parseXlsxRows(buffer);
  if (!rows.length) return [];
  const header = rows[0].map((value) => clean(value));
  const records = [];
  for (const cells of rows.slice(1)) {
    const record = {};
    header.forEach((name, index) => {
      if (name) record[name] = clean(cells[index]);
    });
    if (Object.values(record).some(Boolean)) records.push(record);
  }
  return records;
}

/* -------------------------------------------------------------------------- */
/* Pengambilan data SGO                                                       */
/* -------------------------------------------------------------------------- */

function ensureCookie() {
  const cookieHeader = getRequestSgoCookieHeader();
  if (!cookieHeader) {
    throw new AddonStoreError(
      'Cookie SGO belum diatur di perangkat ini. Buka tombol Cookie SGO di header untuk menyimpan sesi login.',
      { code: 'SGO_SESSION_MISSING', statusCode: 503 },
    );
  }
  return cookieHeader;
}

async function fetchSgo(pathname, { binary = false } = {}) {
  const cookieHeader = ensureCookie();
  const url = /^https?:\/\//i.test(pathname)
    ? pathname
    : `${SGO_BASE_URL}${pathname}`;
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
      throw new AddonStoreError(
        'Sesi SGO Admin ditolak. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }
    if (!response.ok) {
      throw new AddonStoreError(
        `SGO mengembalikan HTTP ${response.status} saat memuat ${pathname}.`,
        { code: 'SGO_HTTP_ERROR' },
      );
    }

    const finalUrl = String(response.url || '');
    if (/\/login(?:[?#/]|$)/i.test(finalUrl)) {
      throw new AddonStoreError(
        'Sesi SGO Admin kedaluwarsa dan diarahkan ke halaman login. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    if (binary) {
      return Buffer.from(await response.arrayBuffer());
    }

    const text = await response.text();
    if (/<title>\s*Login\b/i.test(text)) {
      throw new AddonStoreError(
        'Sesi SGO Admin kedaluwarsa. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }
    return text;
  } catch (error) {
    if (error instanceof AddonStoreError) throw error;
    if (error.name === 'AbortError') {
      throw new AddonStoreError(
        'Permintaan ke SGO melewati batas waktu. Coba lagi.',
        { code: 'SGO_TIMEOUT' },
      );
    }
    throw new AddonStoreError(
      `Gagal menghubungi SGO: ${error.message}`,
      { code: 'SGO_NETWORK_ERROR' },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(pathname, options = {}, attempt = 0) {
  try {
    return await fetchSgo(pathname, options);
  } catch (error) {
    const isAuth =
      error?.code === 'SGO_SESSION_EXPIRED' ||
      error?.code === 'SGO_SESSION_MISSING';
    if (isAuth || attempt >= 1) throw error;
    await sleep(450);
    return fetchWithRetry(pathname, options, attempt + 1);
  }
}

async function loadRtbPackageMap() {
  const html = await fetchWithRetry(RTB_PANEL_PATH);
  const $ = cheerio.load(html);
  const map = new Map();
  $('input[name="paket_id"]').each((_, el) => {
    const input = $(el);
    const label = clean(input.closest('label').text());
    const match = label.match(/RTB\s*[- ]?\s*(\d{1,5})/i);
    if (!match) return;
    const rtb = String(Number(match[1]));
    const value = clean(input.attr('value'));
    if (value && !map.has(rtb)) map.set(rtb, value);
  });
  return map;
}

async function loadRtbWorkbook(packageId) {
  const pathname = `${RTB_PANEL_PATH}/unduh?paket_id=${encodeURIComponent(
    packageId,
  )}&k=jamaah`;
  const buffer = await fetchWithRetry(pathname, { binary: true });
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new AddonStoreError(
      'SGO tidak mengembalikan berkas XLSX untuk export RTB.',
      { code: 'SGO_INVALID_XLSX' },
    );
  }
  return xlsxToRecords(buffer);
}

/* -------------------------------------------------------------------------- */
/* Pengayaan pemesan / kode order                                             */
/* -------------------------------------------------------------------------- */

function buildLocalJamaahLookup() {
  const byShort = new Map();
  const byRtbName = new Map();
  const byRtbOrderName = new Map();
  let rows = [];
  try {
    rows = getAllJamaah();
  } catch {
    rows = [];
  }

  rows.forEach((row) => {
    const rtb = rtbDigits(row.rtb || row.noRtb || row.batch || '');
    const short = orderShortCode(row.shortCode || row.orderShort || '');
    const order = clean(row.orderCode || row.kodeOrder || row.orderId || '');
    const name = nameKey(row.nama || '');
    const info = {
      orderCode: order,
      orderShort: short || orderShortCode(order),
      pemesanName: clean(row.pemesan || ''),
      packageName: clean(row.paket || ''),
      departureDate: clean(row.keberangkatan || ''),
      departureIso: parseIsoDate(row.keberangkatanIso || row.keberangkatan || ''),
      paymentStatus: clean(row.statusPembayaran || row.pembayaran || ''),
      paymentPercent: parseNumber(row.statusPembayaran || ''),
    };
    if (short && !byShort.has(short)) byShort.set(short, info);
    if (rtb && name) byRtbName.set(`${rtb}|${name}`, info);
    if (rtb && order && name) byRtbOrderName.set(`${rtb}|${order}|${name}`, info);
  });

  return { byShort, byRtbName, byRtbOrderName };
}

function buildRtbEnrichmentMaps(rowsByRtb) {
  const byRtbShort = new Map();
  const byRtbName = new Map();
  const byOrder = new Map();

  for (const [rtb, records] of rowsByRtb) {
    records.forEach((record) => {
      const orderCode = clean(record['Kode Order']);
      const short = orderShortCode(orderCode);
      const name = nameKey(record['Nama Jamaah']);
      const info = {
        orderCode,
        orderShort: short,
        pemesanName: clean(record.Pemesan),
        packageName: clean(record.Paket),
        departureDate: clean(record['Tgl Berangkat']),
        departureIso: parseIsoDate(record['Tgl Berangkat']),
        paymentStatus: '',
        paymentPercent: 0,
      };
      if (short) byRtbShort.set(`${rtb}|${short}`, info);
      if (name) byRtbName.set(`${rtb}|${name}`, info);
      if (orderCode) byOrder.set(orderCode, info);
    });
  }

  return { byRtbShort, byRtbName, byOrder };
}

function enrichRow(row, maps) {
  const { rtbEnrichment, local } = maps;
  const name = nameKey(row.jamaahName);
  let info = null;

  if (row.orderShort) {
    info =
      rtbEnrichment.byRtbShort.get(`${row.rtb}|${row.orderShort}`) || null;
    if (!info) info = local.byShort.get(row.orderShort) || null;
  }
  if (!info && name) {
    info = rtbEnrichment.byRtbName.get(`${row.rtb}|${name}`) || null;
  }
  if (!info && name) {
    info = local.byRtbName.get(`${row.rtb}|${name}`) || null;
  }
  if (!info && row.orderCode) {
    info = rtbEnrichment.byOrder.get(row.orderCode) || null;
  }

  const orderCode = info?.orderCode || row.orderCode || '';
  const orderShort = row.orderShort || info?.orderShort || orderShortCode(orderCode);
  const localInfo =
    (orderShort ? local.byShort.get(orderShort) : null) ||
    (name ? local.byRtbName.get(`${row.rtb}|${name}`) : null) ||
    null;

  return {
    ...row,
    orderCode,
    orderShort,
    pemesanName: info?.pemesanName || localInfo?.pemesanName || '',
    packageName: info?.packageName || localInfo?.packageName || '',
    departureDate: info?.departureDate || localInfo?.departureDate || '',
    departureIso: info?.departureIso || localInfo?.departureIso || '',
    paymentStatus: localInfo?.paymentStatus || '',
    paymentPercent: localInfo?.paymentPercent || 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Simpan hasil sinkronisasi                                                  */
/* -------------------------------------------------------------------------- */

function rowSearchText(row) {
  return normalizeSearch(
    [
      row.rtb,
      `RTB ${row.rtb}`,
      row.orderCode,
      row.orderShort,
      row.pemesanName,
      row.jamaahName,
      row.addonItem,
      row.category,
      row.packageName,
      row.paymentStatus,
      row.state === 'verified' ? 'terverifikasi verified lunas' : '',
      row.state === 'pending' ? 'pending menunggu' : '',
      row.state === 'unpaid' ? 'belum bayar unpaid' : '',
      row.state === 'free' ? 'gratis free' : '',
    ].join(' '),
  );
}

function saveSyncResult({
  syncId,
  rows,
  batches,
  batchItemsByRtb,
  items,
  panelMap,
  successfulLabels,
  successfulBatchRtbs,
  warning,
  meta,
}) {
  const database = getDb();
  const syncedAt = nowIso();

  const insertRow = database.prepare(`
    INSERT INTO sgo_addons (
      row_key, sync_id, rtb_number, order_code, order_short, pemesan_name,
      jamaah_name, addon_item, category, qty, price, status, status_label,
      bukti, package_name, departure_date, departure_iso, payment_status,
      payment_percent, source, updated_at, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(row_key) DO UPDATE SET
      sync_id = excluded.sync_id,
      rtb_number = excluded.rtb_number,
      order_code = excluded.order_code,
      order_short = excluded.order_short,
      pemesan_name = excluded.pemesan_name,
      jamaah_name = excluded.jamaah_name,
      addon_item = excluded.addon_item,
      category = excluded.category,
      qty = excluded.qty,
      price = excluded.price,
      status = excluded.status,
      status_label = excluded.status_label,
      bukti = excluded.bukti,
      package_name = excluded.package_name,
      departure_date = excluded.departure_date,
      departure_iso = excluded.departure_iso,
      payment_status = excluded.payment_status,
      payment_percent = excluded.payment_percent,
      source = excluded.source,
      updated_at = excluded.updated_at,
      search_text = excluded.search_text
  `);

  const upsertBatch = database.prepare(`
    INSERT INTO sgo_addon_batches (
      rtb_number, sync_id, paket_name, departure_date, departure_iso,
      status_code, status_label, ref_qty, ref_paid, ref_revenue,
      total_qty, paid_qty, free_qty, revenue, order_count, jamaah_count,
      package_id, sort_order, updated_at, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rtb_number) DO UPDATE SET
      sync_id = excluded.sync_id,
      paket_name = excluded.paket_name,
      departure_date = excluded.departure_date,
      departure_iso = excluded.departure_iso,
      status_code = excluded.status_code,
      status_label = excluded.status_label,
      ref_qty = excluded.ref_qty,
      ref_paid = excluded.ref_paid,
      ref_revenue = excluded.ref_revenue,
      package_id = excluded.package_id,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      search_text = excluded.search_text
  `);

  const insertBatchItem = database.prepare(`
    INSERT INTO sgo_addon_batch_items (
      rtb_number, addon_item, category, qty, paid, free, revenue,
      sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rtb_number, addon_item) DO UPDATE SET
      category = excluded.category,
      qty = excluded.qty,
      paid = excluded.paid,
      free = excluded.free,
      revenue = excluded.revenue,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `);

  const upsertItem = database.prepare(`
    INSERT INTO sgo_addon_items (
      addon_item, category, qty, paid, free, revenue, detail_rows,
      sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(addon_item) DO UPDATE SET
      category = excluded.category,
      qty = excluded.qty,
      paid = excluded.paid,
      free = excluded.free,
      revenue = excluded.revenue,
      detail_rows = excluded.detail_rows,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `);

  database.exec('BEGIN IMMEDIATE;');
  try {
    rows.forEach((row) => {
      insertRow.run(
        row.rowKey,
        syncId,
        row.rtb,
        row.orderCode,
        row.orderShort,
        row.pemesanName,
        row.jamaahName,
        row.addonItem,
        row.category,
        row.qty,
        row.price,
        row.state,
        stateLabel(row.state),
        row.bukti,
        row.packageName,
        row.departureDate,
        row.departureIso,
        row.paymentStatus,
        row.paymentPercent,
        row.source || 'export',
        syncedAt,
        row.searchText,
      );
    });

    if (successfulLabels.length) {
      const placeholders = successfulLabels.map(() => '?').join(', ');
      database
        .prepare(
          `DELETE FROM sgo_addons
           WHERE sync_id <> ?
             AND addon_item IN (${placeholders})`,
        )
        .run(syncId, ...successfulLabels);
    }

    if (items.length) {
      const itemPlaceholders = items.map(() => '?').join(', ');
      database
        .prepare(
          `DELETE FROM sgo_addons
           WHERE addon_item NOT IN (${itemPlaceholders})`,
        )
        .run(...items.map((item) => item.item));
    }

    if (batches.length) {
      const batchPlaceholders = batches.map(() => '?').join(', ');
      database
        .prepare(
          `DELETE FROM sgo_addons
           WHERE rtb_number NOT IN (${batchPlaceholders})`,
        )
        .run(...batches.map((batch) => batch.rtb));
      database
        .prepare(
          `DELETE FROM sgo_addon_batches
           WHERE rtb_number NOT IN (${batchPlaceholders})`,
        )
        .run(...batches.map((batch) => batch.rtb));
      database
        .prepare(
          `DELETE FROM sgo_addon_batch_items
           WHERE rtb_number NOT IN (${batchPlaceholders})`,
        )
        .run(...batches.map((batch) => batch.rtb));
    }

    batches.forEach((batch) => {
      upsertBatch.run(
        batch.rtb,
        syncId,
        batch.paketName,
        batch.departureDate,
        batch.departureIso,
        batch.statusCode,
        batch.statusLabel,
        batch.refQty,
        batch.refPaid,
        batch.refRevenue,
        batch.totalQty || 0,
        batch.paidQty || 0,
        batch.freeQty || 0,
        batch.revenue || 0,
        batch.orderCount || 0,
        batch.jamaahCount || 0,
        panelMap.get(batch.rtb) || '',
        batch.sortOrder,
        syncedAt,
        normalizeSearch(
          [batch.rtb, `RTB ${batch.rtb}`, batch.paketName, batch.statusLabel].join(
            ' ',
          ),
        ),
      );
    });

    successfulBatchRtbs.forEach((rtb) => {
      database
        .prepare('DELETE FROM sgo_addon_batch_items WHERE rtb_number = ?')
        .run(rtb);
    });

    for (const [rtb, batchItems] of batchItemsByRtb) {
      batchItems.forEach((item) => {
        insertBatchItem.run(
          rtb,
          item.item,
          item.category,
          item.qty,
          item.paid,
          item.free,
          item.revenue,
          item.sortOrder,
          syncedAt,
        );
      });
    }

    if (items.length) {
      const detailCounts = new Map();
      rows.forEach((row) => {
        detailCounts.set(
          row.addonItem,
          (detailCounts.get(row.addonItem) || 0) + 1,
        );
      });
      items.forEach((item) => {
        upsertItem.run(
          item.item,
          item.category,
          item.qty,
          item.paid,
          item.free,
          item.revenue,
          detailCounts.get(item.item) || 0,
          item.sortOrder,
          syncedAt,
        );
      });
    }

    writeMeta(database, {
      last_synced_at: syncedAt,
      last_attempt_at: syncedAt,
      last_error: '',
      last_warning: clean(warning),
      ...meta,
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

  return syncedAt;
}

/* -------------------------------------------------------------------------- */
/* Sinkronisasi                                                               */
/* -------------------------------------------------------------------------- */

function report(onProgress, patch) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(patch);
  } catch {
    /* progress tidak boleh menggagalkan sinkronisasi */
  }
}

function aggregateBatchFromItems(batch, items, rows) {
  const totalQty = items.reduce((sum, item) => sum + (item.qty || 0), 0);
  const paidQty = items.reduce((sum, item) => sum + (item.paid || 0), 0);
  const freeQty = items.reduce((sum, item) => sum + (item.free || 0), 0);
  const revenue = items.reduce((sum, item) => sum + (item.revenue || 0), 0);
  const orders = new Set();
  const jamaah = new Set();
  rows.forEach((row) => {
    const order = row.orderCode || row.orderShort || '';
    if (order) orders.add(order);
    if (row.jamaahName) jamaah.add(nameKey(row.jamaahName));
  });
  return {
    ...batch,
    totalQty,
    paidQty,
    freeQty,
    revenue,
    orderCount: orders.size,
    jamaahCount: jamaah.size,
  };
}

async function runSync(onProgress) {
  const syncId = `addon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const warnings = [];

  report(onProgress, {
    percent: 2,
    phase: 'preparing',
    message: 'Menyiapkan sinkronisasi Add-on...',
    detail: 'Menghubungi SGO Admin',
  });

  const [perbatchResult, rekapResult] = await Promise.allSettled([
    fetchWithRetry(`${ADDON_PATH}?tab=perbatch`),
    fetchWithRetry(`${ADDON_PATH}?tab=rekap`),
  ]);

  let batches = [];
  let itemRecap = [];
  let exportLabels = [];

  if (perbatchResult.status === 'fulfilled') {
    try {
      batches = parsePerbatchHtml(perbatchResult.value);
      exportLabels = parseExportLabels(perbatchResult.value);
    } catch (error) {
      warnings.push(`Daftar batch gagal dibaca: ${error.message}`);
    }
  } else {
    warnings.push(
      `Daftar batch gagal dimuat: ${perbatchResult.reason?.message || 'tidak diketahui'}`,
    );
  }

  if (rekapResult.status === 'fulfilled') {
    try {
      itemRecap = parseRekapHtml(rekapResult.value);
    } catch (error) {
      warnings.push(`Rekap add-on gagal dibaca: ${error.message}`);
    }
  } else {
    warnings.push(
      `Rekap add-on gagal dimuat: ${rekapResult.reason?.message || 'tidak diketahui'}`,
    );
  }

  if (!batches.length && !itemRecap.length) {
    const message =
      warnings.join(' ') || 'Gagal memuat daftar Add-on dari SGO.';
    throw new AddonStoreError(message, { code: 'ADDON_SYNC_ERROR' });
  }

  const itemLabels = exportLabels.length
    ? exportLabels
    : itemRecap.length
      ? itemRecap.map((item) => item.item)
      : readItemLabelsFromDb();

  if (!itemLabels.length) {
    throw new AddonStoreError(
      'Daftar jenis add-on tidak ditemukan pada halaman SGO.',
      { code: 'ADDON_LABELS_EMPTY' },
    );
  }

  report(onProgress, {
    percent: 6,
    phase: 'items',
    message: `Mengunduh rincian ${itemLabels.length} jenis add-on...`,
    detail: `0/${itemLabels.length}`,
    itemsDone: 0,
    itemsTotal: itemLabels.length,
    batchesTotal: batches.length,
  });

  const exportRows = [];
  const successfulLabels = [];
  let itemsDone = 0;

  await mapLimit(itemLabels, EXPORT_CONCURRENCY, async (label) => {
    try {
      const html = await fetchWithRetry(
        `${ADDON_PATH}/export?label=${encodeURIComponent(label)}`,
      );
      const rows = parseGlobalExportHtml(html, label);
      exportRows.push(...rows);
      successfulLabels.push(label);
    } catch (error) {
      warnings.push(`Export "${label}" gagal: ${error.message}`);
    } finally {
      itemsDone += 1;
      const percent = 6 + (itemsDone / itemLabels.length) * 34;
      report(onProgress, {
        percent,
        phase: 'items',
        message: `Mengunduh rincian add-on ${itemsDone}/${itemLabels.length}`,
        detail: label,
        itemsDone,
        itemsTotal: itemLabels.length,
        rows: exportRows.length,
      });
    }
  });

  if (!successfulLabels.length) {
    throw new AddonStoreError(
      warnings.join(' ') || 'Semua export add-on gagal dimuat.',
      { code: 'ADDON_EXPORT_ERROR' },
    );
  }

  report(onProgress, {
    percent: 41,
    phase: 'batches',
    message: 'Menyiapkan rekap per batch...',
    detail: `0/${batches.length}`,
    itemsDone,
    itemsTotal: itemLabels.length,
    rows: exportRows.length,
    batchesDone: 0,
    batchesTotal: batches.length,
  });

  const batchItemsByRtb = new Map();
  const successfulBatchRtbs = [];
  let batchesDone = 0;

  await mapLimit(batches, BATCH_CONCURRENCY, async (batch) => {
    try {
      const html = await fetchWithRetry(
        `${ADDON_PATH}?tab=rekap&batch=${encodeURIComponent(batch.rtb)}`,
      );
      const items = parseRekapHtml(html);
      if (items.length) {
        batchItemsByRtb.set(batch.rtb, items);
        successfulBatchRtbs.push(batch.rtb);
      }
    } catch (error) {
      warnings.push(`Rekap RTB ${batch.rtb} gagal: ${error.message}`);
    } finally {
      batchesDone += 1;
      if (batchesDone % 3 === 0 || batchesDone === batches.length) {
        report(onProgress, {
          percent: 41 + (batchesDone / Math.max(1, batches.length)) * 24,
          phase: 'batches',
          message: `Menyiapkan rekap batch ${batchesDone}/${batches.length}`,
          detail: `RTB ${batch.rtb}`,
          rows: exportRows.length,
          batchesDone,
          batchesTotal: batches.length,
        });
      }
    }
  });

  report(onProgress, {
    percent: 66,
    phase: 'owners',
    message: 'Mengambil data pemesan & kode order dari Monitoring Jamaah...',
    detail: 'Memetakan RTB ke paket SGO',
    rows: exportRows.length,
    batchesDone,
    batchesTotal: batches.length,
  });

  let panelMap = new Map();
  let rtbEnrichment = {
    byRtbShort: new Map(),
    byRtbName: new Map(),
    byOrder: new Map(),
  };

  try {
    panelMap = await loadRtbPackageMap();
  } catch (error) {
    warnings.push(
      `Panel Export per RTB gagal dimuat: ${error.message}. Pemesan memakai data lokal bila tersedia.`,
    );
  }

  const exportableBatches = batches.filter((batch) => panelMap.has(batch.rtb));
  const rowsByRtb = new Map();
  let rtbDone = 0;

  await mapLimit(exportableBatches, RTB_CONCURRENCY, async (batch) => {
    try {
      const records = await loadRtbWorkbook(panelMap.get(batch.rtb));
      if (records.length) rowsByRtb.set(batch.rtb, records);
    } catch (error) {
      warnings.push(`Export RTB ${batch.rtb} gagal: ${error.message}`);
    } finally {
      rtbDone += 1;
      if (rtbDone % 4 === 0 || rtbDone === exportableBatches.length) {
        report(onProgress, {
          percent:
            66 + (rtbDone / Math.max(1, exportableBatches.length)) * 26,
          phase: 'owners',
          message: `Mengambil pemesan RTB ${rtbDone}/${exportableBatches.length}`,
          detail: `RTB ${batch.rtb}`,
          rows: exportRows.length,
          batchesDone,
          batchesTotal: batches.length,
        });
      }
    }
  });

  rtbEnrichment = buildRtbEnrichmentMaps(rowsByRtb);
  const local = buildLocalJamaahLookup();
  const maps = { rtbEnrichment, local };

  report(onProgress, {
    percent: 93,
    phase: 'saving',
    message: 'Menggabungkan data jamaah, pemesan, dan status add-on...',
    detail: `${formatNumber(exportRows.length)} baris add-on`,
    rows: exportRows.length,
  });

  const itemCategories = new Map(
    itemRecap.map((item) => [item.item, item.category]),
  );
  const seenKeys = new Map();
  const mergedRows = exportRows.map((row) => {
    const enriched = enrichRow(row, maps);
    const keyBase = [
      enriched.rtb,
      enriched.orderShort || enriched.orderCode || 'nord',
      nameKey(enriched.jamaahName) || 'nnama',
      clean(enriched.item).toUpperCase(),
    ].join('|');
    const count = (seenKeys.get(keyBase) || 0) + 1;
    seenKeys.set(keyBase, count);
    const rowKey = count > 1 ? `${keyBase}|${count}` : keyBase;

    return {
      ...enriched,
      rowKey,
      addonItem: enriched.item,
      category: itemCategories.get(enriched.item) || '',
      qty: 1,
      state: stateFromStatus(enriched.status, enriched.price),
      searchText: '',
    };
  });

  mergedRows.forEach((row) => {
    row.searchText = rowSearchText(row);
  });

  const rowsByRtbForCounts = new Map();
  mergedRows.forEach((row) => {
    if (!rowsByRtbForCounts.has(row.rtb)) rowsByRtbForCounts.set(row.rtb, []);
    rowsByRtbForCounts.get(row.rtb).push(row);
  });

  const batchesWithTotals = batches.map((batch) => {
    const items = batchItemsByRtb.get(batch.rtb) || [];
    const rows = rowsByRtbForCounts.get(batch.rtb) || [];
    const aggregated = aggregateBatchFromItems(batch, items, rows);
    if (!items.length) {
      const derivedRevenue = rows.reduce((sum, row) => sum + row.price, 0);
      return {
        ...aggregated,
        totalQty: rows.length || batch.refQty,
        paidQty: rows.filter((row) => row.state === 'verified').length,
        freeQty: rows.filter((row) => row.state === 'free').length,
        revenue: derivedRevenue || batch.refRevenue,
      };
    }
    return aggregated;
  });

  const summaryQty = itemRecap.length
    ? itemRecap.reduce((sum, item) => sum + item.qty, 0)
    : mergedRows.length;
  const summaryPaid = itemRecap.length
    ? itemRecap.reduce((sum, item) => sum + item.paid, 0)
    : mergedRows.filter((row) => row.price > 0).length;
  const summaryFree = itemRecap.length
    ? itemRecap.reduce((sum, item) => sum + item.free, 0)
    : mergedRows.filter((row) => row.state === 'free').length;
  const summaryRevenue = itemRecap.length
    ? itemRecap.reduce((sum, item) => sum + item.revenue, 0)
    : mergedRows.reduce((sum, row) => sum + row.price, 0);

  const orderKeys = new Set();
  mergedRows.forEach((row) => {
    orderKeys.add(
      `${row.rtb}|${row.orderCode || row.orderShort || nameKey(row.jamaahName)}`,
    );
  });

  const warning = [...new Set(warnings)].join(' ');
  const syncedAt = saveSyncResult({
    syncId,
    rows: mergedRows,
    batches: batchesWithTotals,
    batchItemsByRtb,
    items: itemRecap,
    panelMap,
    successfulLabels,
    successfulBatchRtbs,
    warning,
    meta: {
      total_rows: mergedRows.length,
      total_orders: orderKeys.size,
      total_batches: batchesWithTotals.length,
      total_items: itemRecap.length || itemLabels.length,
      total_qty: summaryQty,
      total_paid: summaryPaid,
      total_free: summaryFree,
      total_revenue: summaryRevenue,
      verified_count: mergedRows.filter((row) => row.state === 'verified')
        .length,
      pending_count: mergedRows.filter((row) => row.state === 'pending').length,
      unpaid_count: mergedRows.filter((row) => row.state === 'unpaid').length,
      free_count: mergedRows.filter((row) => row.state === 'free').length,
    },
  });

  report(onProgress, {
    percent: 99,
    phase: 'saving',
    message: 'Menyimpan ke cache SQLite...',
    detail: `${formatNumber(mergedRows.length)} baris add-on`,
    rows: mergedRows.length,
  });

  return {
    syncedAt,
    rows: mergedRows.length,
    batches: batchesWithTotals.length,
    items: itemRecap.length || itemLabels.length,
    orders: orderKeys.size,
    revenue: summaryRevenue,
    warning: warning || null,
  };
}

/**
 * Jalankan sinkronisasi penuh. Pemanggilan ganda saat sinkronisasi aktif
 * mengembalikan promise yang sama agar SGO tidak dibanjiri request.
 */
export function syncAddons({ onProgress } = {}) {
  if (inflightSync) {
    report(onProgress, {
      percent: 1,
      phase: 'preparing',
      message: 'Sinkronisasi Add-on sedang berjalan...',
    });
    return inflightSync;
  }

  inflightSync = runSync(onProgress)
    .catch((error) => {
      markSyncError(error.message || 'Sinkronisasi Add-on gagal.');
      throw error;
    })
    .finally(() => {
      inflightSync = null;
    });

  return inflightSync;
}

export function isAddonSyncActive() {
  return Boolean(inflightSync);
}

/* -------------------------------------------------------------------------- */
/* Baca & pencarian                                                           */
/* -------------------------------------------------------------------------- */

function mapBatchRow(row) {
  return {
    rtb: row.rtb_number || '',
    label: `RTB ${row.rtb_number || ''}`.trim(),
    paket: row.paket_name || '',
    departureDate: row.departure_date || '',
    departureIso: row.departure_iso || '',
    departureLabel:
      departureLabel(row.departure_iso) || row.departure_date || '',
    status: row.status_code || '',
    statusLabel: row.status_label || '',
    qty: Number(row.total_qty || 0),
    paid: Number(row.paid_qty || 0),
    free: Number(row.free_qty || 0),
    revenue: Number(row.revenue || 0),
    refQty: Number(row.ref_qty || 0),
    refPaid: Number(row.ref_paid || 0),
    refRevenue: Number(row.ref_revenue || 0),
    orderCount: Number(row.order_count || 0),
    jamaahCount: Number(row.jamaah_count || 0),
    packageId: row.package_id || '',
    sortOrder: Number(row.sort_order || 0),
  };
}

function readBatches() {
  return getDb()
    .prepare('SELECT * FROM sgo_addon_batches ORDER BY sort_order ASC')
    .all()
    .map(mapBatchRow);
}

function readItems() {
  return getDb()
    .prepare('SELECT * FROM sgo_addon_items ORDER BY sort_order ASC')
    .all()
    .map((row) => ({
      item: row.addon_item,
      category: row.category || '',
      qty: Number(row.qty || 0),
      paid: Number(row.paid || 0),
      free: Number(row.free || 0),
      revenue: Number(row.revenue || 0),
      detailRows: Number(row.detail_rows || 0),
      sortOrder: Number(row.sort_order || 0),
    }));
}

function readBatchItems(rtb) {
  return getDb()
    .prepare(
      `SELECT * FROM sgo_addon_batch_items
       WHERE rtb_number = ?
       ORDER BY sort_order ASC`,
    )
    .all(rtb)
    .map((row) => ({
      item: row.addon_item,
      category: row.category || '',
      qty: Number(row.qty || 0),
      paid: Number(row.paid || 0),
      free: Number(row.free || 0),
      revenue: Number(row.revenue || 0),
      detailRows: 0,
      sortOrder: Number(row.sort_order || 0),
    }));
}

function mapAddonRow(row) {
  return {
    rtb: row.rtb_number || '',
    orderCode: row.order_code || '',
    orderShort: row.order_short || '',
    orderDisplay:
      row.order_code || (row.order_short ? `#${row.order_short}` : ''),
    pemesan: row.pemesan_name || '',
    jamaah: row.jamaah_name || '',
    item: row.addon_item || '',
    category: row.category || '',
    qty: Number(row.qty || 0),
    price: Number(row.price || 0),
    priceLabel: formatRupiah(row.price),
    status: row.status || 'free',
    bukti: row.bukti || '',
    packageName: row.package_name || '',
    departureDate: row.departure_date || '',
    departureIso: row.departure_iso || '',
    departureLabel:
      departureLabel(row.departure_iso) || row.departure_date || '',
    paymentStatus: row.payment_status || '',
    paymentPercent: Number(row.payment_percent || 0),
    source: row.source || '',
  };
}

function groupAddonRows(rows = []) {
  const groups = [];
  const byKey = new Map();

  rows.forEach((row) => {
    const orderValue = row.orderCode || row.orderShort || '';
    const groupKey = orderValue
      ? `${row.rtb}|${orderValue}`
      : `${row.rtb}|name:${nameKey(row.jamaah)}`;
    let group = byKey.get(groupKey);

    if (!group) {
      group = {
        key: groupKey,
        rtb: row.rtb,
        orderCode: row.orderCode,
        orderShort: row.orderShort,
        orderDisplay: row.orderDisplay,
        portalOrder: row.orderCode || row.orderShort || '',
        pemesan: row.pemesan || '',
        packageName: row.packageName || '',
        departureDate: row.departureDate || '',
        departureLabel: row.departureLabel || '',
        paymentStatus: row.paymentStatus || '',
        paymentPercent: row.paymentPercent || 0,
        jamaahCount: 0,
        addonCount: 0,
        totalPrice: 0,
        verifiedCount: 0,
        pendingCount: 0,
        freeCount: 0,
        unpaidCount: 0,
        jamaah: [],
        _jamaah: new Map(),
      };
      byKey.set(groupKey, group);
      groups.push(group);
    }

    if (!group.pemesan && row.pemesan) group.pemesan = row.pemesan;
    if (!group.packageName && row.packageName) {
      group.packageName = row.packageName;
    }
    if (!group.departureDate && row.departureDate) {
      group.departureDate = row.departureDate;
      group.departureLabel = row.departureLabel;
    }
    if (!group.paymentStatus && row.paymentStatus) {
      group.paymentStatus = row.paymentStatus;
      group.paymentPercent = row.paymentPercent;
    }

    const personKey = nameKey(row.jamaah) || `row-${group.addonCount}`;
    let person = group._jamaah.get(personKey);
    if (!person) {
      person = {
        name: row.jamaah,
        addons: [],
        totalPrice: 0,
      };
      group._jamaah.set(personKey, person);
      group.jamaah.push(person);
    }

    person.addons.push({
      item: row.item,
      category: row.category,
      price: row.price,
      priceLabel: row.priceLabel,
      status: row.status,
      statusLabel: stateLabel(row.status),
      bukti: row.bukti,
    });
    person.totalPrice += row.price;

    group.addonCount += 1;
    group.totalPrice += row.price;
    if (row.status === 'verified') group.verifiedCount += 1;
    else if (row.status === 'pending') group.pendingCount += 1;
    else if (row.status === 'free') group.freeCount += 1;
    else group.unpaidCount += 1;
  });

  groups.forEach((group) => {
    group.jamaahCount = group.jamaah.length;
    delete group._jamaah;
    group.totalPriceLabel = formatRupiah(group.totalPrice);
  });

  return groups;
}

function queryRows({ terms = [], rtb = '', item = '', limit = MAX_SNAPSHOT_ROWS }) {
  const where = [];
  const params = [];
  if (rtb) {
    where.push('rtb_number = ?');
    params.push(rtb);
  }
  if (item) {
    where.push('addon_item = ?');
    params.push(item);
  }
  terms.forEach((term) => {
    where.push('search_text LIKE ?');
    params.push(`%${term}%`);
  });

  const sql = `SELECT * FROM sgo_addons
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY rtb_number DESC, order_short ASC, jamaah_name ASC, addon_item ASC
    LIMIT ?`;
  const rows = getDb()
    .prepare(sql)
    .all(...params, limit)
    .map(mapAddonRow);

  const countSql = `SELECT COUNT(*) AS total FROM sgo_addons
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = Number(
    getDb()
      .prepare(countSql)
      .get(...params)?.total || 0,
  );

  return { rows, total };
}

function queryAllRowsForRtb(rtb, item = '') {
  return queryRows({ rtb, item, limit: 100_000 });
}

function mergeBatchItemsWithDetails(batchItems, rows) {
  const counts = new Map();
  rows.forEach((row) => {
    counts.set(row.item, (counts.get(row.item) || 0) + 1);
  });
  return batchItems.map((item) => ({
    ...item,
    detailRows: counts.get(item.item) || 0,
  }));
}

function buildGlobalSummary(meta, items, rows, batches) {
  const qty = Number(meta.total_qty || 0) || items.reduce((sum, item) => sum + item.qty, 0);
  const paid =
    Number(meta.total_paid || 0) || items.reduce((sum, item) => sum + item.paid, 0);
  const free =
    Number(meta.total_free || 0) || items.reduce((sum, item) => sum + item.free, 0);
  const revenue =
    Number(meta.total_revenue || 0) ||
    items.reduce((sum, item) => sum + item.revenue, 0);
  const jamaah = new Set();
  const orders = new Set();
  rows.forEach((row) => {
    if (row.jamaah) jamaah.add(`${row.rtb}|${nameKey(row.jamaah)}`);
    if (row.orderCode || row.orderShort) {
      orders.add(`${row.rtb}|${row.orderCode || row.orderShort}`);
    }
  });

  return {
    totalQty: qty,
    totalPaid: paid,
    totalFree: free,
    totalRevenue: revenue,
    totalRows: Number(meta.total_rows || rows.length || 0),
    totalOrders: Number(meta.total_orders || 0) || orders.size,
    totalBatches: batches.length || Number(meta.total_batches || 0),
    totalItems: items.length || Number(meta.total_items || 0),
    verifiedCount: Number(meta.verified_count || 0),
    pendingCount: Number(meta.pending_count || 0),
    unpaidCount: Number(meta.unpaid_count || 0),
    freeCount: Number(meta.free_count || 0),
  };
}

function buildBatchSummary(batch, batchItems, rows) {
  return {
    ...batch,
    totalQty: batch.qty,
    totalPaid: batch.paid,
    totalFree: batch.free,
    totalRevenue: batch.revenue,
    detailRows: rows.length,
    itemCount: batchItems.length,
  };
}

function computeStale(meta) {
  if (!meta.last_synced_at) return true;
  return !isFresh(meta);
}

/**
 * Snapshot siap pakai untuk UI/chat.
 *
 * - Tanpa query: daftar semua batch + rekap global per item.
 * - Query angka yang sama dengan nomor RTB: mode batch (rekap + kartu jamaah).
 * - Query nama/kode order/jenis add-on: hasil pencarian + grup kartu.
 */
export function getAddonSnapshot({
  query = '',
  rtb = '',
  item = '',
  limit = MAX_SNAPSHOT_ROWS,
} = {}) {
  const meta = readMeta();
  const batches = readBatches();
  const items = readItems();
  const batchByRtb = new Map(batches.map((batch) => [batch.rtb, batch]));
  const text = clean(query);
  const normalized = normalizeSearch(text);
  const terms = normalized.split(' ').filter(Boolean);
  const explicitRtb = rtbDigits(rtb);
  const numericQuery = /^\d{1,5}$/.test(text.replace(/^RTB\s*/i, '').trim())
    ? rtbDigits(text)
    : '';
  const requestedRtb = explicitRtb || numericQuery;
  const batch = requestedRtb ? batchByRtb.get(requestedRtb) || null : null;

  const base = {
    query: text,
    lastSyncedAt: meta.last_synced_at || null,
    lastAttemptAt: meta.last_attempt_at || null,
    stale: computeStale(meta),
    warning: meta.last_warning || null,
    error: meta.last_error || null,
    allItems: items,
    source: {
      type: 'sgo-sqlite',
      module: ADDON_PATH,
      database: 'sqlite',
    },
  };

  if (batch) {
    const { rows } = queryAllRowsForRtb(batch.rtb, item);
    const batchItems = mergeBatchItemsWithDetails(
      readBatchItems(batch.rtb),
      rows,
    );
    return {
      ...base,
      mode: 'batch',
      batch: buildBatchSummary(batch, batchItems, rows),
      batches: [batch],
      items: batchItems,
      groups: groupAddonRows(rows),
      totalMatched: rows.length,
      returned: rows.length,
      summary: buildGlobalSummary(meta, items, [], batches),
      batchSummary: {
        rtb: batch.rtb,
        qty: batch.qty,
        paid: batch.paid,
        free: batch.free,
        revenue: batch.revenue,
        itemCount: batchItems.length,
      },
    };
  }

  if (item && !terms.length) {
    const { rows, total } = queryRows({ item, limit });
    const batchRtbs = new Set(rows.map((row) => row.rtb));
    getDb()
      .prepare(
        'SELECT DISTINCT rtb_number FROM sgo_addon_batch_items WHERE addon_item = ?',
      )
      .all(item)
      .forEach((row) => {
        if (row.rtb_number) batchRtbs.add(row.rtb_number);
      });
    const matchedBatches = batches.filter((entry) =>
      batchRtbs.has(entry.rtb),
    );
    const selectedItem = items.find((entry) => entry.item === item) || null;
    return {
      ...base,
      mode: 'item',
      batch: null,
      batches: matchedBatches,
      matchedBatchCount: matchedBatches.length,
      items: selectedItem ? [selectedItem] : [],
      matchedItemCount: selectedItem ? 1 : 0,
      groups: groupAddonRows(rows),
      totalMatched: total,
      returned: rows.length,
      truncated: total > rows.length,
      summary: buildGlobalSummary(meta, items, [], batches),
    };
  }

  if (terms.length) {
    const { rows, total } = queryRows({ terms, item, limit });
    const matchedBatches = batches.filter((entry) => {
      const haystack = normalizeSearch(
        `${entry.rtb} RTB ${entry.rtb} ${entry.paket} ${entry.statusLabel}`,
      );
      return terms.every((term) => haystack.includes(term));
    });
    const matchedItems = items.filter((entry) =>
      terms.every((term) => normalizeSearch(entry.item).includes(term)),
    );
    return {
      ...base,
      mode: 'search',
      batch: null,
      batches: (matchedBatches.length ? matchedBatches : batches).slice(0, 80),
      matchedBatchCount: matchedBatches.length,
      items: matchedItems.length ? matchedItems : items,
      matchedItemCount: matchedItems.length,
      groups: groupAddonRows(rows),
      totalMatched: total,
      returned: rows.length,
      truncated: total > rows.length,
      summary: buildGlobalSummary(meta, items, rows, batches),
    };
  }

  return {
    ...base,
    mode: 'overview',
    batch: null,
    batches,
    items,
    groups: [],
    totalMatched: 0,
    returned: 0,
    summary: buildGlobalSummary(meta, items, [], batches),
  };
}

/* -------------------------------------------------------------------------- */
/* Integrasi chat                                                             */
/* -------------------------------------------------------------------------- */

function compactAddon(row) {
  return {
    item: row.item,
    price: row.price,
    priceLabel: row.priceLabel,
    status: row.status,
    statusLabel: stateLabel(row.status),
  };
}

function buildChatResultFromRows(rows, totalMatched, extra = {}) {
  const groups = groupAddonRows(rows.slice(0, MAX_CHAT_ROWS * 3)).slice(
    0,
    MAX_CHAT_ROWS,
  );
  const payload = groups.map((group) => ({
    rtb: group.rtb,
    orderCode: group.orderCode,
    orderShort: group.orderShort,
    orderDisplay: group.orderDisplay,
    portalOrder: group.portalOrder,
    pemesan: group.pemesan,
    packageName: group.packageName,
    departureLabel: group.departureLabel,
    paymentStatus: group.paymentStatus,
    jamaahCount: group.jamaahCount,
    addonCount: group.addonCount,
    totalPrice: group.totalPrice,
    totalPriceLabel: group.totalPriceLabel,
    verifiedCount: group.verifiedCount,
    pendingCount: group.pendingCount,
    freeCount: group.freeCount,
    unpaidCount: group.unpaidCount,
    jamaah: group.jamaah.slice(0, 6).map((person) => ({
      name: person.name,
      totalPrice: person.totalPrice,
      addons: person.addons.slice(0, 8).map(compactAddon),
    })),
  }));

  return {
    ...extra,
    totalMatched,
    returned: payload.length,
    truncated: totalMatched > payload.length,
    groups: payload,
  };
}

/**
 * Cari data add-on untuk pesan chat. Hanya dipanggil ketika pesan memang
 * meminta add-on atau berisi kode order/RTB yang relevan.
 */
export function searchAddonsForChat(message = '') {
  const raw = clean(message);
  if (!raw) return null;
  const meta = readMeta();
  if (!meta.last_synced_at) return null;

  const hasKeyword = /\b(add[\s-]?ons?|tambahan)\b/i.test(raw);
  const orderMatch = raw.match(/\bORD[- ]?\d{4}[- ]?[A-Z]{2,5}[- ]?\d{3,6}\b/i);
  const orderCode = orderMatch ? orderMatch[0].toUpperCase().replace(/\s+/g, '-') : '';
  const rtbMatch = raw.match(/\bRTB\s*[- ]?\s*(\d{1,5})\b/i);
  const bareNumber = raw.match(/^\s*(\d{1,5})\s*$/);
  const keywordNumber = raw.match(
    /\b(?:add[\s-]?ons?|tambahan)\s+(?:rtb\s*[- ]?\s*)?(\d{1,5})\b/i,
  );
  const rtb = rtbMatch
    ? rtbDigits(rtbMatch[1])
    : bareNumber
      ? rtbDigits(bareNumber[1])
      : keywordNumber
        ? rtbDigits(keywordNumber[1])
        : '';

  if (!hasKeyword && !orderCode && !rtb) return null;

  if (rtb) {
    const batch = readBatches().find((entry) => entry.rtb === rtb);
    if (!batch) return null;
    const { rows } = queryAllRowsForRtb(rtb);
    const batchItems = mergeBatchItemsWithDetails(readBatchItems(rtb), rows);
    return buildChatResultFromRows(rows, rows.length, {
      kind: 'rtb',
      rtb,
      batch,
      items: batchItems
        .filter((entry) => entry.qty > 0)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 12)
        .map((entry) => ({
          item: entry.item,
          qty: entry.qty,
          paid: entry.paid,
          free: entry.free,
          revenue: entry.revenue,
          revenueLabel: formatRupiah(entry.revenue),
          detailRows: entry.detailRows,
        })),
      summary: {
        qty: batch.qty,
        paid: batch.paid,
        free: batch.free,
        revenue: batch.revenue,
        revenueLabel: formatRupiah(batch.revenue),
      },
    });
  }

  if (orderCode) {
    const short = orderShortCode(orderCode);
    const { rows, total } = queryRows({
      terms: [normalizeSearch(orderCode)],
      limit: 200,
    });
    const fallback = rows.length
      ? { rows, total }
      : queryRows({ terms: [short], limit: 200 });
    if (!fallback.rows.length) return null;
    return buildChatResultFromRows(fallback.rows, fallback.total, {
      kind: 'order',
      orderCode,
    });
  }

  if (hasKeyword) {
    const stripped = raw
      .replace(/\b(add[\s-]?ons?|tambahan|cari|cek|lihat|data|untuk|dari|di|rtb)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!stripped || /^\d{0,2}$/.test(stripped)) {
      const batches = readBatches().slice(0, 6);
      const topItems = readItems()
        .slice()
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 10)
        .map((entry) => ({
          item: entry.item,
          qty: entry.qty,
          paid: entry.paid,
          free: entry.free,
          revenue: entry.revenue,
          revenueLabel: formatRupiah(entry.revenue),
          detailRows: entry.detailRows,
        }));
      return {
        kind: 'overview',
        totalMatched: readBatches().length,
        returned: batches.length,
        truncated: readBatches().length > batches.length,
        batches: batches.map((batch) => ({
          rtb: batch.rtb,
          paket: batch.paket,
          departureLabel: batch.departureLabel,
          qty: batch.qty,
          revenueLabel: formatRupiah(batch.revenue),
        })),
        items: topItems,
        groups: [],
      };
    }

    const { rows, total } = queryRows({
      terms: normalizeSearch(stripped).split(' ').filter(Boolean),
      limit: 200,
    });
    if (!rows.length) return null;
    return buildChatResultFromRows(rows, total, { kind: 'search' });
  }

  return null;
}

export function formatAddonChatReply(result) {
  if (!result) return '';
  if (result.kind === 'rtb' && result.batch) {
    const batch = result.batch;
    const lines = [
      `🎁 **Add-on RTB ${batch.rtb}** — ${batch.paket || 'Paket belum tersedia'}`,
      `- Keberangkatan: ${batch.departureLabel || 'Belum dijadwalkan'}`,
      `- Total add-on: ${formatNumber(batch.qty)} • Terbayar: ${formatNumber(batch.paid)} • Gratis: ${formatNumber(batch.free)}`,
      `- Pendapatan: ${formatRupiah(batch.revenue)}`,
    ];
    if (result.items?.length) {
      lines.push('', '**Rekap item:**');
      result.items.slice(0, 8).forEach((item) => {
        lines.push(
          `- ${item.item}: ${formatNumber(item.qty)} qty • ${item.revenueLabel}`,
        );
      });
    }
    if (result.groups?.length) {
      lines.push(
        '',
        `**${formatNumber(result.totalMatched)} baris add-on** dari ${
          result.groups.length
        } order yang ditampilkan:`,
      );
      result.groups.slice(0, 5).forEach((group) => {
        lines.push(
          `- ${group.pemesan || 'Pemesan belum tercatat'} (${group.orderDisplay || 'tanpa kode'}) — ${group.jamaahCount} jamaah, ${group.addonCount} add-on`,
        );
      });
    }
    return lines.join('\n');
  }

  if (result.kind === 'order') {
    const first = result.groups?.[0];
    if (!first) return '';
    const lines = [
      `🎁 **Add-on order ${first.orderDisplay || result.orderCode}**`,
      `- Pemesan: ${first.pemesan || 'Belum tercatat'}`,
      `- Paket: ${first.packageName || '-'}`,
      `- Total add-on: ${first.addonCount} • Nilai: ${first.totalPriceLabel}`,
    ];
    result.groups.slice(0, 5).forEach((group) => {
      group.jamaah.slice(0, 6).forEach((person) => {
        const addons = person.addons
          .map(
            (addon) =>
              `${addon.item} (${addon.statusLabel}${
                addon.price > 0 ? ` • ${addon.priceLabel}` : ''
              })`,
          )
          .join(', ');
        lines.push(`- **${person.name}**: ${addons || 'tidak ada add-on'}`);
      });
    });
    return lines.join('\n');
  }

  if (result.kind === 'overview') {
    const lines = [
      '🎁 **Ringkasan Add-on Per Batch**',
      `- Total batch: ${result.totalMatched || result.batches?.length || 0}`,
    ];
    (result.items || []).slice(0, 8).forEach((item) => {
      lines.push(
        `- ${item.item}: ${formatNumber(item.qty)} qty • ${item.revenueLabel}`,
      );
    });
    return lines.join('\n');
  }

  if (result.groups?.length) {
    const lines = [
      `🎁 Ditemukan ${result.totalMatched} add-on yang cocok:`,
    ];
    result.groups.slice(0, 6).forEach((group) => {
      lines.push(
        `- **${group.pemesan || group.jamaah?.[0]?.name || 'Jamaah'}** (${group.orderDisplay || '-'}) — RTB ${group.rtb}: ${group.addonCount} add-on, ${group.totalPriceLabel}`,
      );
    });
    return lines.join('\n');
  }

  return '';
}

export default {
  getAddonSnapshot,
  syncAddons,
  isAddonSyncActive,
  searchAddonsForChat,
  formatAddonChatReply,
  AddonStoreError,
};
