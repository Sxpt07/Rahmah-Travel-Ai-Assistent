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
  process.env.WORKSHEET_DB_PATH || path.join(DATA_DIR, 'worksheet.sqlite');
const CACHE_TTL_MS = Math.max(
  30_000,
  Number(process.env.WORKSHEET_CACHE_TTL_MS || 3 * 60 * 1000) || 3 * 60 * 1000,
);
const FETCH_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.WORKSHEET_FETCH_TIMEOUT_MS || 45_000) ||
    45_000,
);
const SGO_BASE_URL = String(
  process.env.SGO_BASE_URL || 'https://sgo.rahmahgrup.id',
).replace(/\/+$/, '');

export const DEFAULT_WORKSHEET_TAB = 'butuh_disiapkan';

/**
 * Tab Worksheet yang memakai tabel `wk-table` dan memuat data pemesan,
 * jamaah, paket, RTB, keberangkatan, serta ukuran jaket.
 *
 * Tab pengiriman/kekurangan di SGO memakai tabel berbeda (pgt/mngt/wkot/kkt)
 * sehingga tidak dipaksakan ke bentuk data ini.
 */
export const WORKSHEET_TABS = Object.freeze([
  { id: 'belum_waktunya', label: 'Upcoming' },
  { id: 'sudah_disiapkan', label: 'Pilih Metode' },
  { id: 'butuh_disiapkan', label: 'Butuh Disiapkan' },
  { id: 'kloter_pengiriman', label: 'Kloter Pengiriman & Resi' },
  { id: 'hari_h', label: 'Diambil Hari H' },
  { id: 'selesai', label: 'Selesai' },
]);

const SUPPORTED_TAB_IDS = new Set(WORKSHEET_TABS.map((tab) => tab.id));

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

export class WorksheetError extends Error {
  constructor(message, { code = 'WORKSHEET_ERROR', statusCode = 502 } = {}) {
    super(message);
    this.name = 'WorksheetError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

let db = null;
let schemaReady = false;
const inflightTabs = new Map();

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitsOnly(value = '') {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeSearch(value = '') {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripEmoji(value = '') {
  return cleanText(value)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
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

function groupPhoneDigits(value = '') {
  const match = String(value).match(/^(\d{3})(\d{3,4})(\d+)$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function whatsappUrl(value = '') {
  let digits = digitsOnly(value);
  if (!digits) return '';
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return `https://wa.me/${digits}`;
}

function extractOrderCode(href = '') {
  if (!href) return '';
  try {
    const url = new URL(href, 'https://sgo.rahmahgrup.id');
    return cleanText(url.searchParams.get('code') || '');
  } catch {
    const match = String(href).match(/[?&]code=([^&]+)/i);
    return match ? cleanText(decodeURIComponent(match[1])) : '';
  }
}

function extractJamaahId($, row, jamaahCell) {
  const wqpId = cleanText(jamaahCell.find('.wqp').attr('id') || '');
  if (wqpId) return wqpId.replace(/^wqp-/, '');

  const hxPost = String(row.find('[hx-post*="/jamaah/"]').attr('hx-post') || '');
  const hxMatch = hxPost.match(/\/jamaah\/(\d+)\//);
  if (hxMatch) return hxMatch[1];

  const sorot = cleanText(row.attr('data-sorot') || '');
  if (sorot) return sorot.replace(/^od-/, '');

  return '';
}

function parseQc(row) {
  const progress = cleanText(row.find('.wqp__pcnt').first().text());
  const progressMatch = progress.match(/^(\d+)\s*\/\s*(\d+)$/);
  const qcDone = progressMatch ? Number(progressMatch[1]) : null;
  const qcTotal = progressMatch ? Number(progressMatch[2]) : null;

  const status =
    cleanText(row.find('.wqp__lbl').first().text()) ||
    cleanText(row.find('.wk-done').first().text());

  return { qcDone, qcTotal, qcStatus: status };
}

function parseWorksheetHtml(html = '', requestedTab = '') {
  const $ = cheerio.load(html);
  const table = $('table.wk-table').first();

  if (!table.length) {
    const title = cleanText($('title').text());
    if (/login/i.test(title)) {
      throw new WorksheetError(
        'Sesi SGO Admin tidak valid atau kedaluwarsa. Buka tombol Cookie SGO di header, tempel cookie baru, lalu simpan.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }
    throw new WorksheetError(
      'Tabel Worksheet Perlengkapan tidak ditemukan pada halaman SGO.',
      { code: 'WORKSHEET_LAYOUT_ERROR' },
    );
  }

  const parsedTabs = $('.wk-pchip')
    .map((index, element) => {
      const href = $(element).attr('href') || '';
      const tabId = cleanText(
        (() => {
          try {
            return new URL(href, 'https://sgo.rahmahgrup.id').searchParams.get(
              'tab',
            );
          } catch {
            return '';
          }
        })() || '',
      );
      if (!tabId) return null;

      const text = cleanText($(element).text());
      const countMatch = text.match(/(\d[\d.]*)\s*$/);
      const count = countMatch
        ? Number(countMatch[1].replace(/\./g, ''))
        : 0;
      const label = (countMatch ? text.slice(0, countMatch.index) : text)
        .replace(/^\d+\s*/, '')
        .replace(/^!\s*/, '')
        .trim();

      return {
        id: tabId,
        label: label || tabId,
        count: Number.isFinite(count) ? count : 0,
        position: index,
        active: $(element).hasClass('wk-pchip--on'),
      };
    })
    .get()
    .filter(Boolean);

  const rows = [];
  let current = null;
  let rowOrder = 0;

  table.find('tbody tr').each((_, element) => {
    const row = $(element);
    if (row.hasClass('wk-grp')) return;

    const orderCell = row.find('td.wk-td-order').first();
    if (orderCell.length) {
      const orderNumber = cleanText(
        orderCell.find('.wk-order__id span').first().text(),
      ).replace(/^#/, '');
      const portalUrl = row.find('a.wk-btn--portal').first().attr('href') || '';

      current = {
        orderNumber,
        orderCode: extractOrderCode(portalUrl),
        portalUrl: cleanText(portalUrl),
        pemesan: cleanText(orderCell.find('.wk-order__nm').first().text()),
        phone: digitsOnly(
          orderCell.find('.wk-order__tel').first().text(),
        ),
        orderFlags: orderCell
          .find('.wk-order__pills .wk-pill')
          .map((__, pill) => cleanText($(pill).text()))
          .get()
          .filter(Boolean)
          .join(' · '),
        packageName: '',
        rtb: '',
        departureDate: '',
        departureIso: '',
        deadline: '',
        deadlineIso: '',
        deadlineTone: '',
      };
    }

    const jamaahCell = row.find('td.wk-td-jamaah').first();
    if (!jamaahCell.length || !current) return;

    const paketCell = row.find('td.wk-td-paket').first();
    if (paketCell.length) {
      const departureDate = stripEmoji(
        paketCell.find('.wk-paket__go').first().text(),
      ).replace(/^🛫\s*/u, '');
      current.packageName = cleanText(
        paketCell.find('.wk-paket__nm').first().text(),
      );
      current.rtb = cleanText(paketCell.find('.wk-rtb').first().text());
      current.departureDate = cleanText(departureDate);
      current.departureIso = parseIndonesianDate(departureDate);
    }

    const deadlineCell = row.find('td.wk-td-deadline').first();
    if (deadlineCell.length) {
      const deadlineEl = deadlineCell.find('.wk-dl').first();
      current.deadline = cleanText(deadlineEl.text());
      current.deadlineIso = parseIndonesianDate(current.deadline);
      const toneMatch = String(deadlineEl.attr('class') || '').match(
        /wk-dl--([A-Za-z0-9_-]+)/,
      );
      current.deadlineTone = toneMatch ? toneMatch[1] : '';
    }

    const nameClone = jamaahCell.find('.wk-jm__nm').first().clone();
    const genderEl = nameClone.find('.wk-g').first();
    const genderSymbol = cleanText(genderEl.text());
    const genderTitle = cleanText(genderEl.attr('title') || '');
    nameClone.find('.wk-g').remove();
    const jamaahName = cleanText(nameClone.text());

    const jacketSize = stripEmoji(
      jamaahCell.find('.wk-size').first().text(),
    );
    const attributeNote = cleanText(
      jamaahCell.find('.wk-tanpapl').first().text(),
    );

    const priority = cleanText(
      row
        .find('td.wk-td-prio select.wk-prio option:selected')
        .first()
        .text(),
    );
    const wilayahEl = row.find('.wk-wilayah').first();
    const region = stripEmoji(wilayahEl.text());
    const method = cleanText(
      row.find('td.wk-td-metode .wk-pill').first().text(),
    );
    const methodDetail = [
      ...row
        .find('td.wk-td-metode .wk-jchip, td.wk-td-metode .wk-resi')
        .map((__, element) => cleanText($(element).text()))
        .get(),
    ]
      .filter(Boolean)
      .join(' · ');

    const { qcDone, qcTotal, qcStatus } = parseQc(row);
    const jamaahId = extractJamaahId($, row, jamaahCell);
    const searchText = normalizeSearch(
      [
        current.orderNumber,
        current.orderCode,
        current.pemesan,
        current.phone,
        ...phoneVariants(current.phone),
        jamaahName,
        genderTitle,
        jacketSize,
        attributeNote,
        current.packageName,
        current.rtb,
        current.departureDate,
        current.deadline,
        priority,
        region,
        method,
        methodDetail,
        qcStatus,
        current.orderFlags,
      ].join(' '),
    );

    rows.push({
      tab: requestedTab,
      rowOrder,
      orderNumber: current.orderNumber,
      orderCode: current.orderCode,
      portalUrl: current.portalUrl,
      pemesan: current.pemesan,
      phone: current.phone,
      jamaahId,
      jamaahName,
      genderSymbol,
      genderTitle,
      jacketSize,
      attributeNote,
      packageName: current.packageName,
      rtb: current.rtb,
      departureDate: current.departureDate,
      departureIso: current.departureIso,
      deadline: current.deadline,
      deadlineIso: current.deadlineIso,
      deadlineTone: current.deadlineTone,
      priority,
      region,
      qcStatus,
      qcDone,
      qcTotal,
      method,
      methodDetail,
      orderFlags: current.orderFlags,
      searchText,
    });
    rowOrder += 1;
  });

  if (!rows.length && !$('.wk-table').length) {
    throw new WorksheetError(
      'Worksheet Perlengkapan SGO tidak mengembalikan baris jamaah.',
      { code: 'WORKSHEET_EMPTY' },
    );
  }

  return { rows, tabs: parsedTabs };
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS worksheet_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tab TEXT NOT NULL,
      row_order INTEGER NOT NULL DEFAULT 0,
      order_number TEXT NOT NULL DEFAULT '',
      order_code TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      pemesan TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      jamaah_id TEXT NOT NULL DEFAULT '',
      jamaah_name TEXT NOT NULL DEFAULT '',
      gender_symbol TEXT NOT NULL DEFAULT '',
      gender_title TEXT NOT NULL DEFAULT '',
      jacket_size TEXT NOT NULL DEFAULT '',
      attribute_note TEXT NOT NULL DEFAULT '',
      package_name TEXT NOT NULL DEFAULT '',
      rtb TEXT NOT NULL DEFAULT '',
      departure_date TEXT NOT NULL DEFAULT '',
      departure_iso TEXT NOT NULL DEFAULT '',
      deadline_label TEXT NOT NULL DEFAULT '',
      deadline_iso TEXT NOT NULL DEFAULT '',
      deadline_tone TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      qc_status TEXT NOT NULL DEFAULT '',
      qc_done INTEGER,
      qc_total INTEGER,
      method TEXT NOT NULL DEFAULT '',
      method_detail TEXT NOT NULL DEFAULT '',
      order_flags TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_worksheet_rows_tab_order
      ON worksheet_rows (tab, row_order);

    CREATE TABLE IF NOT EXISTS worksheet_tab_state (
      tab TEXT PRIMARY KEY,
      rows_count INTEGER NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS worksheet_tabs (
      tab TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      supported INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS worksheet_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
}

function ensureWorksheetColumns(database) {
  const columns = database
    .prepare('PRAGMA table_info(worksheet_rows)')
    .all()
    .map((column) => column.name);

  if (!columns.includes('portal_url')) {
    database.exec(
      "ALTER TABLE worksheet_rows ADD COLUMN portal_url TEXT NOT NULL DEFAULT '';",
    );
  }
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
    ensureWorksheetColumns(db);
    schemaReady = true;
  }

  return db;
}

function getTabState(tab) {
  const database = getDb();
  return database
    .prepare(
      `SELECT tab, rows_count, orders_count, synced_at, error
         FROM worksheet_tab_state
        WHERE tab = ?`,
    )
    .get(tab);
}

function isFresh(state) {
  if (!state || !state.synced_at || !state.rows_count) return false;
  if (state.error) return false;
  const syncedAt = Date.parse(state.synced_at);
  if (!Number.isFinite(syncedAt)) return false;
  return Date.now() - syncedAt < CACHE_TTL_MS;
}

function upsertTabs(database, parsedTabs, requestedTab) {
  const statement = database.prepare(`
    INSERT INTO worksheet_tabs (tab, label, count, position, supported, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tab) DO UPDATE SET
      label = excluded.label,
      count = excluded.count,
      position = excluded.position,
      supported = excluded.supported,
      active = excluded.active
  `);

  const tabMap = new Map(parsedTabs.map((tab) => [tab.id, tab]));

  WORKSHEET_TABS.forEach((definition, index) => {
    const found = tabMap.get(definition.id);
    statement.run(
      definition.id,
      found?.label || definition.label,
      found?.count ?? 0,
      found?.position ?? index,
      1,
      definition.id === requestedTab ? 1 : 0,
    );
  });

  parsedTabs.forEach((tab) => {
    if (SUPPORTED_TAB_IDS.has(tab.id)) return;
    statement.run(
      tab.id,
      tab.label,
      tab.count,
      tab.position,
      0,
      tab.id === requestedTab ? 1 : 0,
    );
  });
}

function saveTabSnapshot(tab, parsed, requestedTab) {
  const database = getDb();
  const summary = buildSummary(parsed.rows);
  const syncedAt = new Date().toISOString();

  const insert = database.prepare(`
    INSERT INTO worksheet_rows (
      tab, row_order, order_number, order_code, portal_url, pemesan, phone,
      jamaah_id, jamaah_name, gender_symbol, gender_title, jacket_size,
      attribute_note, package_name, rtb, departure_date, departure_iso,
      deadline_label, deadline_iso, deadline_tone, priority, region,
      qc_status, qc_done, qc_total, method, method_detail, order_flags,
      search_text
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?
    )
  `);

  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare('DELETE FROM worksheet_rows WHERE tab = ?').run(tab);

    parsed.rows.forEach((row) => {
      insert.run(
        tab,
        row.rowOrder,
        row.orderNumber,
        row.orderCode,
        row.portalUrl,
        row.pemesan,
        row.phone,
        row.jamaahId,
        row.jamaahName,
        row.genderSymbol,
        row.genderTitle,
        row.jacketSize,
        row.attributeNote,
        row.packageName,
        row.rtb,
        row.departureDate,
        row.departureIso,
        row.deadline,
        row.deadlineIso,
        row.deadlineTone,
        row.priority,
        row.region,
        row.qcStatus,
        row.qcDone,
        row.qcTotal,
        row.method,
        row.methodDetail,
        row.orderFlags,
        row.searchText,
      );
    });

    database
      .prepare(
        `INSERT INTO worksheet_tab_state
           (tab, rows_count, orders_count, synced_at, error)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(tab) DO UPDATE SET
           rows_count = excluded.rows_count,
           orders_count = excluded.orders_count,
           synced_at = excluded.synced_at,
           error = NULL`,
      )
      .run(tab, parsed.rows.length, summary.totalOrders, syncedAt);

    upsertTabs(database, parsed.tabs, requestedTab);
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

function markTabError(tab, message) {
  try {
    const database = getDb();
    database
      .prepare(
        `INSERT INTO worksheet_tab_state
           (tab, rows_count, orders_count, synced_at, error)
         VALUES (?, 0, 0, NULL, ?)
         ON CONFLICT(tab) DO UPDATE SET error = excluded.error`,
      )
      .run(tab, cleanText(message).slice(0, 500));
  } catch {
    /* kegagalan mencatat error tidak boleh menutupi error utama */
  }
}

const ACTION_TIMEOUT_MS = 20_000;

function assertWorksheetOrderNumber(orderNumber) {
  const order = String(orderNumber ?? '').trim();
  if (!/^\d{1,12}$/.test(order)) {
    throw new WorksheetError('Kode order tidak valid.', {
      code: 'WORKSHEET_ORDER_INVALID',
      statusCode: 400,
    });
  }
  return order;
}

async function requestSgoWorksheetAction(
  path,
  { method = 'GET', htmxTarget = '' } = {},
) {
  const cookieHeader = getRequestSgoCookieHeader();
  if (!cookieHeader) {
    throw new WorksheetError(
      'Cookie SGO belum diatur di perangkat ini. Buka tombol Cookie SGO di header untuk menyimpan sesi login.',
      { code: 'SGO_SESSION_MISSING', statusCode: 503 },
    );
  }

  const headers = {
    ...SGO_BROWSER_HEADERS,
    Cookie: cookieHeader,
    Accept: 'text/html, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'HX-Request': 'true',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  delete headers['Sec-Fetch-User'];

  if (htmxTarget) headers['HX-Target'] = htmxTarget;
  if (method !== 'GET' && method !== 'HEAD') {
    headers.Origin = SGO_BASE_URL;
    headers.Referer = `${SGO_BASE_URL}/ops/worksheet-perlengkapan`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);

  try {
    const response = await fetch(`${SGO_BASE_URL}${path}`, {
      method,
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    const finalUrl = String(response.url || '');
    const text = await response.text();

    if (
      response.status === 401 ||
      response.status === 403 ||
      /\/login(?:[?#/]|$)/i.test(finalUrl) ||
      /<title>\s*Login\b/i.test(text)
    ) {
      throw new WorksheetError(
        'Sesi SGO Admin kedaluwarsa. Perbarui cookie lewat tombol Cookie SGO di header, lalu coba lagi.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    if (!response.ok) {
      throw new WorksheetError(
        `SGO mengembalikan HTTP ${response.status} saat menjalankan aksi Worksheet.`,
        { code: 'SGO_ACTION_ERROR', statusCode: 502 },
      );
    }

    return { text, status: response.status };
  } catch (error) {
    if (error instanceof WorksheetError) throw error;
    if (error.name === 'AbortError') {
      throw new WorksheetError('Aksi ke SGO melewati batas waktu. Coba lagi.', {
        code: 'SGO_TIMEOUT',
        statusCode: 504,
      });
    }
    throw new WorksheetError(`Gagal menghubungi SGO: ${error.message}`, {
      code: 'SGO_NETWORK_ERROR',
      statusCode: 502,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tandai semua jamaah pada satu order sudah disiapkan.
 * Aksi ini mengubah data live SGO, jadi route wajib meminta konfirmasi eksplisit
 * dari UI sebelum fungsi ini dipanggil.
 */
export async function prepareAllWorksheetOrder(orderNumber) {
  const order = assertWorksheetOrderNumber(orderNumber);
  await requestSgoWorksheetAction(
    `/ops/worksheet-perlengkapan/order/${order}/siapkan-all`,
    { method: 'POST' },
  );
  return { order };
}

async function fetchWorksheetHtml(tab) {
  const cookieHeader = getRequestSgoCookieHeader();
  if (!cookieHeader) {
    throw new WorksheetError(
      'Cookie SGO belum diatur di perangkat ini. Buka tombol Cookie SGO di header untuk menyimpan sesi login.',
      { code: 'SGO_SESSION_MISSING', statusCode: 503 },
    );
  }

  const url = `${SGO_BASE_URL}/ops/worksheet-perlengkapan?tab=${encodeURIComponent(tab)}`;
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
      throw new WorksheetError(
        'Sesi SGO Admin ditolak. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    if (!response.ok) {
      throw new WorksheetError(
        `SGO mengembalikan HTTP ${response.status} saat memuat Worksheet Perlengkapan.`,
        { code: 'SGO_HTTP_ERROR' },
      );
    }

    const finalUrl = String(response.url || '');
    const html = await response.text();

    if (/\/login(?:[?#/]|$)/i.test(finalUrl)) {
      throw new WorksheetError(
        'Sesi SGO Admin kedaluwarsa dan diarahkan ke halaman login. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    if (/<title>\s*Login\b/i.test(html)) {
      throw new WorksheetError(
        'Sesi SGO Admin kedaluwarsa. Perbarui cookie lewat tombol Cookie SGO di header.',
        { code: 'SGO_SESSION_EXPIRED', statusCode: 401 },
      );
    }

    return html;
  } catch (error) {
    if (error instanceof WorksheetError) throw error;
    if (error.name === 'AbortError') {
      throw new WorksheetError(
        'Permintaan ke SGO melewati batas waktu. Coba muat ulang.',
        { code: 'SGO_TIMEOUT' },
      );
    }
    throw new WorksheetError(
      `Gagal menghubungi SGO: ${error.message}`,
      { code: 'SGO_NETWORK_ERROR' },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function syncTab(tab, force = false) {
  const existing = getTabState(tab);
  if (!force && isFresh(existing)) {
    return { syncedAt: existing.synced_at, stale: false, warning: '' };
  }

  try {
    const html = await fetchWorksheetHtml(tab);
    const parsed = parseWorksheetHtml(html, tab);
    const saved = saveTabSnapshot(tab, parsed, tab);
    return { syncedAt: saved.syncedAt, stale: false, warning: '' };
  } catch (error) {
    const hasCache = Boolean(existing?.rows_count);
    if (hasCache) {
      markTabError(tab, error.message);
      return {
        syncedAt: existing.synced_at,
        stale: true,
        warning: `${error.message} Menampilkan cache SQLite terakhir.`,
      };
    }
    markTabError(tab, error.message);
    throw error;
  }
}

async function ensureTabReady(tab, force = false) {
  if (inflightTabs.has(tab)) return inflightTabs.get(tab);

  const promise = syncTab(tab, force).finally(() => {
    inflightTabs.delete(tab);
  });
  inflightTabs.set(tab, promise);
  return promise;
}

function buildSummary(rows = []) {
  const orders = new Set();
  let jacketCount = 0;
  let missingJacket = 0;
  let urgentCount = 0;
  let readyCount = 0;

  rows.forEach((row) => {
    const orderKey =
      row.orderNumber || row.orderCode || row.jamaahId || row.jamaahName;
    if (orderKey) orders.add(orderKey);

    if (row.jacketSize) jacketCount += 1;
    else missingJacket += 1;

    if (/urgent/i.test(row.priority || '')) urgentCount += 1;

    const done =
      Number.isFinite(row.qcDone) &&
      Number.isFinite(row.qcTotal) &&
      row.qcTotal > 0 &&
      row.qcDone >= row.qcTotal;
    if (done || /sudah disiapkan|diterima/i.test(row.qcStatus || '')) {
      readyCount += 1;
    }
  });

  return {
    totalOrders: orders.size,
    totalJamaah: rows.length,
    jacketCount,
    missingJacket,
    urgentCount,
    readyCount,
  };
}

function readTabs() {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT t.tab, t.label, t.count, t.position, t.supported, t.active,
              s.rows_count, s.orders_count, s.synced_at, s.error
         FROM worksheet_tabs t
         LEFT JOIN worksheet_tab_state s ON s.tab = t.tab
        ORDER BY t.position ASC, t.label ASC`,
    )
    .all();

  if (!rows.length) {
    return WORKSHEET_TABS.map((tab, index) => ({
      id: tab.id,
      label: tab.label,
      count: 0,
      position: index,
      supported: true,
      active: tab.id === DEFAULT_WORKSHEET_TAB,
      rowsCount: 0,
      ordersCount: 0,
      lastSyncedAt: null,
      error: null,
    }));
  }

  return rows.map((row) => ({
    id: row.tab,
    label: row.label,
    count: Number(row.count || 0),
    position: Number(row.position || 0),
    supported: Boolean(row.supported),
    active: Boolean(row.active),
    rowsCount: Number(row.rows_count || 0),
    ordersCount: Number(row.orders_count || 0),
    lastSyncedAt: row.synced_at || null,
    error: row.error || null,
  }));
}

function extractPortalCode(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    return String(
      parsed.searchParams.get('unique_code') ||
        parsed.searchParams.get('uniq_code') ||
        '',
    )
      .trim()
      .toUpperCase();
  } catch {
    const match = raw.match(/[?&](?:unique_code|uniq_code)=([A-Za-z0-9]+)/i);
    return String(match?.[1] || '').trim().toUpperCase();
  }
}

function mapRow(row) {
  return {
    orderNumber: row.order_number || '',
    orderCode: row.order_code || '',
    portalUrl: row.portal_url || '',
    portalCode: extractPortalCode(row.portal_url),
    pemesan: row.pemesan || '',
    phone: row.phone || '',
    phoneDisplay: formatPhoneId(row.phone),
    waUrl: whatsappUrl(row.phone),
    jamaahId: row.jamaah_id || '',
    jamaahName: row.jamaah_name || '',
    gender: row.gender_symbol || '',
    genderTitle: row.gender_title || '',
    jacketSize: row.jacket_size || '',
    attributeNote: row.attribute_note || '',
    packageName: row.package_name || '',
    rtb: row.rtb || '',
    departureDate: row.departure_date || '',
    departureIso: row.departure_iso || '',
    deadline: row.deadline_label || '',
    deadlineIso: row.deadline_iso || '',
    deadlineTone: row.deadline_tone || '',
    priority: row.priority || '',
    region: row.region || '',
    qcStatus: row.qc_status || '',
    qcDone: row.qc_done == null ? null : Number(row.qc_done),
    qcTotal: row.qc_total == null ? null : Number(row.qc_total),
    method: row.method || '',
    methodDetail: row.method_detail || '',
    orderFlags: row.order_flags || '',
  };
}

function readRows(tab, query = '') {
  const database = getDb();
  const terms = normalizeSearch(query).split(' ').filter(Boolean);

  const baseSelect = `SELECT * FROM worksheet_rows WHERE tab = ?`;
  const condition = terms.length
    ? ` AND ${terms.map(() => 'instr(search_text, ?) > 0').join(' AND ')}`
    : '';

  const statement = database.prepare(
    `${baseSelect}${condition} ORDER BY row_order ASC`,
  );

  const rows = terms.length
    ? statement.all(tab, ...terms)
    : statement.all(tab);

  return rows.map(mapRow);
}

function readLatestSync(database = getDb()) {
  const row = database
    .prepare('SELECT MAX(synced_at) AS synced_at FROM worksheet_tab_state')
    .get();
  return row?.synced_at || null;
}

/**
 * Cari baris Worksheet lintas tab dari cache SQLite.
 *
 * Pencarian memakai `search_text` yang sudah dinormalisasi saat sinkronisasi,
 * jadi kode order, nama pemesan, nama jamaah, telepon, paket, RTB, ukuran
 * jaket, dan tahap dapat ditemukan dalam satu query tanpa memuat seluruh tab
 * ke browser.
 */
export function searchWorksheetRows(query = '', { limit = 60 } = {}) {
  const rawQuery = cleanText(query);
  const terms = normalizeSearch(rawQuery).split(' ').filter(Boolean);
  const database = getDb();
  const tabs = readTabs();
  const max = Math.min(Math.max(Number(limit) || 60, 1), 200);

  const source = {
    type: 'sgo-sqlite',
    module: '/ops/worksheet-perlengkapan',
    database: 'sqlite',
  };

  if (!terms.length) {
    return {
      query: rawQuery,
      rows: [],
      total: 0,
      limit: max,
      truncated: false,
      tabs,
      lastSyncedAt: readLatestSync(database),
      summary: buildSummary([]),
      source,
    };
  }

  const conditions = terms.map((term) =>
    term.length < 3 && /^[A-Z]+$/.test(term)
      ? "instr(' ' || r.search_text || ' ', ?) > 0"
      : 'instr(r.search_text, ?) > 0',
  );
  const params = terms.map((term) =>
    term.length < 3 && /^[A-Z]+$/.test(term) ? ` ${term} ` : term,
  );
  const where = conditions.join(' AND ');

  const total = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS total FROM worksheet_rows r WHERE ${where}`,
      )
      .get(...params)?.total || 0,
  );

  if (!total) {
    return {
      query: rawQuery,
      rows: [],
      total: 0,
      limit: max,
      truncated: false,
      tabs,
      lastSyncedAt: readLatestSync(database),
      summary: buildSummary([]),
      source,
    };
  }

  const exactOrder = digitsOnly(rawQuery);
  const orderBoost = exactOrder
    ? 'CASE WHEN r.order_number = ? OR r.order_code = ? THEN 0 ELSE 1 END,'
    : '';
  const orderParams = exactOrder ? [exactOrder, exactOrder] : [];

  const rows = database
    .prepare(
      `SELECT r.*, COALESCE(t.label, '') AS tab_label
         FROM worksheet_rows r
         LEFT JOIN worksheet_tabs t ON t.tab = r.tab
        WHERE ${where}
        ORDER BY ${orderBoost}
                 CASE WHEN r.departure_iso = '' THEN 1 ELSE 0 END,
                 r.departure_iso ASC,
                 r.tab ASC,
                 r.row_order ASC
        LIMIT ?`,
    )
    .all(...params, ...orderParams, max);

  const mapped = rows.map((row) => ({
    ...mapRow(row),
    tab: row.tab,
    tabLabel:
      row.tab_label || tabDefinition(row.tab)?.label || row.tab || 'Worksheet',
  }));

  return {
    query: rawQuery,
    rows: mapped,
    total,
    limit: max,
    truncated: total > mapped.length,
    tabs,
    lastSyncedAt: readLatestSync(database),
    summary: { ...buildSummary(mapped), totalMatches: total },
    source,
  };
}

/**
 * Tautan Portal Jamaah dari cache Worksheet untuk satu order.
 *
 * Dipakai resolver login portal agar kode unik order bisa dipakai ulang tanpa
 * scraping SGO. Menerima kode order lengkap maupun nomor order saja.
 */
export function findWorksheetPortalUrl(orderCode = '') {
  const code = cleanText(orderCode).toUpperCase();
  if (!code) return '';

  const shortCode =
    String(code.match(/(\d{4,6})$/)?.[1] || '').replace(/^0+/, '') || '';
  const row = getDb()
    .prepare(
      `SELECT portal_url
         FROM worksheet_rows
        WHERE portal_url <> ''
          AND (order_code = ? OR (? <> '' AND order_number = ?))
        ORDER BY row_order ASC
        LIMIT 1`,
    )
    .get(code, shortCode, shortCode);

  return cleanText(row?.portal_url || '');
}

function tabDefinition(tabId) {
  return WORKSHEET_TABS.find((tab) => tab.id === tabId) || null;
}

export function isSupportedWorksheetTab(tabId = '') {
  return SUPPORTED_TAB_IDS.has(String(tabId || '').trim());
}

export function getWorksheetTabDefinitions() {
  return WORKSHEET_TABS.map((tab) => ({ ...tab }));
}

/**
 * Snapshot Worksheet dari cache SQLite.
 * Jika cache kedaluwarsa, ambil ulang tab aktif dari SGO terlebih dahulu.
 */
export async function getWorksheetSnapshot({
  tab = DEFAULT_WORKSHEET_TAB,
  query = '',
  force = false,
} = {}) {
  const requestedTab = cleanText(tab) || DEFAULT_WORKSHEET_TAB;
  const definition = tabDefinition(requestedTab);

  if (!definition) {
    throw new WorksheetError(
      `Tab Worksheet "${requestedTab}" belum didukung oleh console.`,
      { code: 'WORKSHEET_TAB_UNSUPPORTED', statusCode: 400 },
    );
  }

  const syncState = await ensureTabReady(requestedTab, Boolean(force));
  const rows = readRows(requestedTab, query);
  const tabs = readTabs();
  const state = getTabState(requestedTab);
  const activeTab = tabs.find((item) => item.id === requestedTab) || null;
  const summary = buildSummary(rows);

  const warnings = [];
  if (syncState.warning) warnings.push(syncState.warning);

  if (!query && activeTab?.count && activeTab.count > rows.length) {
    warnings.push(
      `SGO menampilkan ${rows.length.toLocaleString('id-ID')} baris pertama dari ${activeTab.count.toLocaleString('id-ID')} jamaah pada tab ini.`,
    );
  }

  return {
    tab: {
      id: requestedTab,
      label: definition.label,
      count: activeTab?.count || rows.length,
      rowsCount: state?.rows_count || rows.length,
      ordersCount: state?.orders_count || summary.totalOrders,
      lastSyncedAt: state?.synced_at || syncState.syncedAt || null,
    },
    tabs,
    rows,
    total: rows.length,
    totalAll: state?.rows_count || rows.length,
    query: cleanText(query),
    summary,
    lastSyncedAt: state?.synced_at || syncState.syncedAt || null,
    stale: Boolean(syncState.stale),
    warning: warnings.join(' ') || null,
    source: {
      type: 'sgo-sqlite',
      module: '/ops/worksheet-perlengkapan',
      database: 'sqlite',
    },
  };
}

export function getWorksheetTabs() {
  return readTabs();
}
