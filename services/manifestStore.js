/**
 * Cache SQLite modul Upload Manifest.
 *
 * Sumber data tetap `data/jamaah_data.json` melalui getJamaahData(). Setiap
 * perubahan data dinormalisasi ke tabel `manifest_rows` agar filter bulan,
 * status dokumen, dan pencarian bisa dilakukan tanpa memindai JSON berulang.
 *
 * Nomor telepon hanya disimpan untuk membentuk nomor tampilan dan tautan
 * WhatsApp. API tidak mengembalikan nomor mentah tanpa format.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabaseSync } from './sqliteCompat.js';

import { getJamaahData, getJamaahSource } from '../data/jamaahStore.js';
import {
  buildMonitoringSummary,
  parseDokumenDetail,
  summarizeDocuments,
} from './documentStatus.js';
import {
  formatDepartureDisplay,
  isPlaceholderDepartureIso,
  monthLabelFromKey,
  monthNumberFromName,
  parseDepartureDate,
} from './departureDate.js';
import { isReadOnlyFsError, resolveWritablePath } from './runtimeEnv.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = resolveWritablePath(
  process.env.MANIFEST_DB_PATH || path.join(DATA_DIR, 'manifest.sqlite'),
  'manifest.sqlite',
);

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;
const MAX_QUERY_LENGTH = 120;

const DOCUMENT_ORDER = [
  'ktp',
  'kk',
  'paspor',
  'vaksin',
  'foto',
  'vaksin-polio',
];

let db = null;
let schemaReady = false;

// Status sinkronisasi live per halaman. Selama sync penuh berjalan, baris
// Upload Manifest di-upsert ke SQLite dalam satu transaksi agar kartu di
// frontend bisa berubah merah -> hijau tanpa menunggu 144 halaman selesai.
let liveSync = null;

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

function canonicalPhone(value = '') {
  let digits = digitsOnly(value);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('62')) return `62${digits.slice(2).replace(/^0+/, '')}`;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}

function formatPhoneDisplay(value = '') {
  const digits = canonicalPhone(value);
  if (!digits) return '';

  const local = digits.startsWith('62') ? digits.slice(2) : digits;
  const grouped = local.replace(/^(\d{3})(\d{3,4})(\d+)$/, '$1-$2-$3');
  return `+62 ${grouped}`;
}

function whatsappUrl(value = '') {
  const digits = canonicalPhone(value);
  return digits ? `https://wa.me/${digits}` : '';
}

function formatCount(value = 0) {
  return Number(value || 0).toLocaleString('id-ID');
}

function normalizeStatus(value = '') {
  const status = cleanText(value).toLowerCase();
  if (status === 'complete' || status === 'lengkap') return 'complete';
  if (
    status === 'incomplete' ||
    status === 'missing' ||
    status === 'belum-lengkap'
  ) {
    return 'incomplete';
  }
  return 'all';
}

function normalizeMonth(value = '') {
  const raw = cleanText(value);
  if (!raw || /^(?:all|semua)$/i.test(raw)) return 'all';
  if (/^(?:unknown|none|tanpa-tanggal|belum)$/i.test(raw)) return 'unknown';

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) {
    const month = Number(isoMatch[2]);
    if (month >= 1 && month <= 12) {
      return `${isoMatch[1]}-${String(month).padStart(2, '0')}`;
    }
  }

  const labelMatch = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (labelMatch) {
    const probe = parseDepartureDate(`1 ${labelMatch[1]} ${labelMatch[2]}`);
    if (probe.monthKey) return probe.monthKey;
  }

  return 'all';
}

/**
 * Pencarian "Januari", "Jan 2027", atau "2027-01" diperlakukan sebagai filter
 * bulan agar tidak tercampur dengan pencarian nama/order.
 */
function resolveQueryMonth(query = '') {
  const raw = cleanText(query);
  if (!raw) return { query: '', month: null };

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) {
    const month = Number(isoMatch[2]);
    if (month >= 1 && month <= 12) {
      return {
        query: '',
        month: `${isoMatch[1]}-${String(month).padStart(2, '0')}`,
      };
    }
  }

  const labelMatch = raw.match(/^([A-Za-z]+)(?:\s+(\d{4}))?$/);
  if (labelMatch) {
    const month = monthNumberFromName(labelMatch[1]);
    if (month) {
      return {
        query: '',
        month: labelMatch[2]
          ? `${labelMatch[2]}-${String(month).padStart(2, '0')}`
          : String(month).padStart(2, '0'),
      };
    }
  }

  return { query: raw, month: null };
}

function normalizeId(row = {}, index = 0) {
  const manifestId = cleanText(row.manifestId || row.jamaahId);
  if (manifestId) return manifestId;

  const orderCode = cleanText(row.orderCode || row.kodeOrder || row.orderId);
  const nama = cleanText(row.nama).toUpperCase();
  const fallback = normalizeSearch(`${orderCode} ${nama}`).replace(/\s+/g, '-');
  return fallback ? `${fallback}-${index + 1}` : `jamaah-${index + 1}`;
}

function resolveDeparture(row = {}) {
  const candidates = [
    row.keberangkatanIso,
    row.departureIso,
    row.keberangkatan,
    row.departure,
    row.paket,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const detail = parseDepartureDate(candidate);
    if (detail.iso) {
      if (isPlaceholderDepartureIso(detail.iso)) break;
      return {
        ...detail,
        label: cleanText(row.keberangkatan || row.departure || detail.displayDate),
        display: formatDepartureDisplay(detail.iso, row.keberangkatan),
      };
    }
  }

  const rawLabel = cleanText(row.keberangkatan || row.departure);
  const rawDetail = parseDepartureDate(rawLabel);
  const placeholder = isPlaceholderDepartureIso(rawDetail.iso);

  return {
    iso: '',
    year: null,
    month: null,
    day: null,
    monthKey: '',
    monthLabel: '',
    monthShortLabel: '',
    displayDate: '',
    display: placeholder ? 'Belum ditentukan' : rawLabel || 'Belum terjadwal',
    label: rawLabel,
  };
}

function orderDocuments(documents = []) {
  return [...documents].sort((a, b) => {
    const indexA = DOCUMENT_ORDER.indexOf(a.key);
    const indexB = DOCUMENT_ORDER.indexOf(b.key);
    const orderA = indexA < 0 ? 99 : indexA;
    const orderB = indexB < 0 ? 99 : indexB;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.label).localeCompare(String(b.label), 'id');
  });
}

function normalizeManifestRow(row = {}, index = 0) {
  const summary = summarizeDocuments(row);
  const documents = orderDocuments(summary.documents);
  const departure = resolveDeparture(row);
  const id = normalizeId(row, index);
  const nama = cleanText(row.nama) || 'Jamaah tanpa nama';
  const orderCode = cleanText(
    row.orderCode || row.kodeOrder || row.orderId,
  ).toUpperCase();
  const shortCode = cleanText(row.shortCode || row.orderShort);
  const paket = cleanText(row.paket);
  const rtb = cleanText(row.rtb || row.noRtb);
  const pemesan = cleanText(row.pemesan) || nama;
  const phone = canonicalPhone(row.noHp || row.hp || row.telepon || '');
  const phoneDisplay = formatPhoneDisplay(phone);
  const waUrl = whatsappUrl(phone);
  const missingLabels = summary.missing;
  const processLabels = summary.inProgress;
  const docKeys = documents.map((document) => document.label).join(' ');
  const monthShort = departure.monthShortLabel || '';
  const localPhone = phone.startsWith('62') ? `0${phone.slice(2)}` : phone;
  const searchText = normalizeSearch(
    [
      nama,
      pemesan,
      orderCode,
      shortCode,
      paket,
      rtb,
      row.keberangkatan,
      departure.iso,
      departure.monthKey,
      departure.monthLabel,
      monthShort,
      phone,
      localPhone,
      phoneDisplay,
      docKeys,
      missingLabels.join(' '),
      processLabels.join(' '),
    ]
      .filter(Boolean)
      .join(' '),
  );

  return {
    rowOrder: index,
    id,
    jamaahId: cleanText(row.manifestId || row.jamaahId),
    name: nama,
    orderCode,
    shortCode,
    packageName: paket,
    rtb,
    departureLabel: cleanText(row.keberangkatan),
    departureIso: departure.iso,
    departureYear: departure.year,
    departureMonth: departure.month,
    departureDay: departure.day,
    monthKey: departure.monthKey,
    monthLabel: departure.monthLabel,
    departureDisplay: departure.display,
    pemesan,
    phone,
    phoneDisplay,
    waUrl,
    documents,
    dokumenDetail: cleanText(row.dokumenDetail),
    totalDocs: summary.total,
    completedDocs: summary.completed,
    missingDocs: missingLabels.length,
    processDocs: processLabels.length,
    missingLabels,
    inProgressLabels: processLabels,
    isComplete: summary.isComplete ? 1 : 0,
    status: summary.isComplete ? 'complete' : 'incomplete',
    searchText,
    sourceModule: cleanText(row.sourceModule) || '/ops/upload-documents',
  };
}

/* -------------------------------------------------------------------------- */
/* SQLite                                                                     */
/* -------------------------------------------------------------------------- */

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS manifest_rows (
      row_order INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,
      jamaah_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      order_code TEXT NOT NULL DEFAULT '',
      short_code TEXT NOT NULL DEFAULT '',
      package_name TEXT NOT NULL DEFAULT '',
      rtb TEXT NOT NULL DEFAULT '',
      departure_label TEXT NOT NULL DEFAULT '',
      departure_iso TEXT NOT NULL DEFAULT '',
      departure_year INTEGER,
      departure_month INTEGER,
      departure_day INTEGER,
      month_key TEXT NOT NULL DEFAULT '',
      month_label TEXT NOT NULL DEFAULT '',
      departure_display TEXT NOT NULL DEFAULT '',
      pemesan TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      phone_display TEXT NOT NULL DEFAULT '',
      wa_url TEXT NOT NULL DEFAULT '',
      documents_json TEXT NOT NULL DEFAULT '[]',
      dokumen_detail TEXT NOT NULL DEFAULT '',
      total_docs INTEGER NOT NULL DEFAULT 0,
      completed_docs INTEGER NOT NULL DEFAULT 0,
      missing_docs INTEGER NOT NULL DEFAULT 0,
      process_docs INTEGER NOT NULL DEFAULT 0,
      missing_labels TEXT NOT NULL DEFAULT '',
      process_labels TEXT NOT NULL DEFAULT '',
      is_complete INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'incomplete',
      search_text TEXT NOT NULL DEFAULT '',
      source_module TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_manifest_rows_month
      ON manifest_rows (month_key);
    CREATE INDEX IF NOT EXISTS idx_manifest_rows_status
      ON manifest_rows (is_complete);
    CREATE INDEX IF NOT EXISTS idx_manifest_rows_order
      ON manifest_rows (row_order);

    CREATE TABLE IF NOT EXISTS manifest_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    -- Kode unik Portal Jamaah per order. Dipakai agar tombol "Login Portal"
    -- selalu membuka order yang benar, bukan sesi order terakhir.
    CREATE TABLE IF NOT EXISTS portal_codes (
      order_code TEXT PRIMARY KEY,
      unique_code TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
}

function getDb() {
  if (db) return db;

  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = createDatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = NORMAL;');
  } catch (error) {
    db = createDatabaseSync(':memory:');
    db.exec('PRAGMA busy_timeout = 5000;');
    if (!isReadOnlyFsError(error)) {
      console.warn('[manifest] SQLite file tidak tersedia, memakai memori:', error.message);
    }
  }

  if (!schemaReady) {
    createSchema(db);
    schemaReady = true;
  }

  return db;
}

function readMeta() {
  const rows = getDb().prepare('SELECT key, value FROM manifest_meta').all();
  const meta = {};
  for (const row of rows) meta[row.key] = row.value;
  return meta;
}

function writeMeta(database, values = {}) {
  const statement = database.prepare(`
    INSERT INTO manifest_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  for (const [key, value] of Object.entries(values)) {
    statement.run(key, value == null ? '' : String(value));
  }
}

const CACHE_VERSION = 2; // naikkan saat logika status dokumen berubah

function dataSignature(rows = [], source = null) {
  const hash = createHash('sha1');
  hash.update(
    JSON.stringify({
      version: CACHE_VERSION,
      loadedAt: source?.loadedAt || '',
      count: source?.count || 0,
      rows: rows.length,
      first: rows[0]?.manifestId || '',
      last: rows[rows.length - 1]?.manifestId || '',
      namesLength: rows.reduce(
        (total, row) => total + String(row.nama || '').length,
        0,
      ),
    }),
  );
  return hash.digest('hex');
}

const MANIFEST_COLUMNS = [
  'row_order',
  'id',
  'jamaah_id',
  'name',
  'order_code',
  'short_code',
  'package_name',
  'rtb',
  'departure_label',
  'departure_iso',
  'departure_year',
  'departure_month',
  'departure_day',
  'month_key',
  'month_label',
  'departure_display',
  'pemesan',
  'phone',
  'phone_display',
  'wa_url',
  'documents_json',
  'dokumen_detail',
  'total_docs',
  'completed_docs',
  'missing_docs',
  'process_docs',
  'missing_labels',
  'process_labels',
  'is_complete',
  'status',
  'search_text',
  'source_module',
];

function manifestRowValues(row) {
  return [
    row.rowOrder,
    row.id,
    row.jamaahId,
    row.name,
    row.orderCode,
    row.shortCode,
    row.packageName,
    row.rtb,
    row.departureLabel,
    row.departureIso,
    row.departureYear,
    row.departureMonth,
    row.departureDay,
    row.monthKey,
    row.monthLabel,
    row.departureDisplay,
    row.pemesan,
    row.phone,
    row.phoneDisplay,
    row.waUrl,
    JSON.stringify(row.documents),
    row.dokumenDetail,
    row.totalDocs,
    row.completedDocs,
    row.missingDocs,
    row.processDocs,
    row.missingLabels.join(' | '),
    row.inProgressLabels.join(' | '),
    row.isComplete,
    row.status,
    row.searchText,
    row.sourceModule,
  ];
}

/**
 * Simpan snapshot dengan UPSERT per id.
 *
 * Baris yang sudah ada diperbarui di tempat (status dokumen, tautan file,
 * RTB, dan tanggal keberangkatan selalu memakai data SGO terbaru), baris baru
 * ditambahkan, dan baris yang tidak lagi ada di SGO dibersihkan. Dengan cara
 * ini cache SQLite tidak pernah mempertahankan status dokumen lama.
 */
function saveSnapshot(database, rows, signature) {
  const byId = new Map();
  rows.forEach((row, index) => {
    const normalized = normalizeManifestRow(row, index);
    if (!normalized?.id) return;
    byId.set(normalized.id, normalized);
  });
  const normalized = [...byId.values()];
  normalized.forEach((row, index) => {
    row.rowOrder = index;
  });
  const syncedAt = new Date().toISOString();

  const updateColumns = MANIFEST_COLUMNS.filter((column) => column !== 'id');
  const upsert = database.prepare(`
    INSERT INTO manifest_rows (${MANIFEST_COLUMNS.join(', ')})
    VALUES (${MANIFEST_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${updateColumns.map((column) => `${column} = excluded.${column}`).join(',\n      ')}
  `);

  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = new Map(
      database
        .prepare(
          'SELECT id, dokumen_detail, completed_docs, total_docs FROM manifest_rows',
        )
        .all()
        .map((row) => [row.id, row]),
    );

    let inserted = 0;
    let updated = 0;
    let documentsUpdated = 0;

    for (const row of normalized) {
      const previous = existing.get(row.id);
      if (!previous) {
        inserted += 1;
      } else {
        updated += 1;
        if (
          String(previous.dokumen_detail || '') !== row.dokumenDetail ||
          Number(previous.completed_docs || 0) !== row.completedDocs ||
          Number(previous.total_docs || 0) !== row.totalDocs
        ) {
          documentsUpdated += 1;
        }
      }
      upsert.run(...manifestRowValues(row));
    }

    // Bersihkan baris lama yang sudah tidak dikembalikan SGO.
    if (normalized.length) {
      const placeholders = normalized.map(() => '?').join(', ');
      database
        .prepare(`DELETE FROM manifest_rows WHERE id NOT IN (${placeholders})`)
        .run(...normalized.map((row) => row.id));
    } else {
      database.exec('DELETE FROM manifest_rows;');
    }

    writeMeta(database, {
      signature,
      last_synced_at: syncedAt,
      total_jamaah: normalized.length,
      total_complete: normalized.filter((row) => row.isComplete).length,
      last_inserted: inserted,
      last_updated: updated,
      last_documents_updated: documentsUpdated,
    });

    database.exec('COMMIT;');

    return {
      syncedAt,
      total: normalized.length,
      inserted,
      updated,
      documentsUpdated,
    };
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      /* transaksi mungkin sudah dibatalkan */
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Live sync per halaman                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mulai transaksi live. Semua halaman Upload Manifest yang masuk akan
 * di-upsert ke SQLite tanpa menunggu seluruh pagination selesai. Transaksi
 * di-commit tepat sebelum snapshot final ditulis, atau di-rollback bila scrape
 * gagal agar cache tidak tertinggal dalam kondisi parsial.
 */
export function beginLiveManifestSync() {
  if (liveSync) return false;

  const database = getDb();
  try {
    database.exec('BEGIN IMMEDIATE;');
  } catch (error) {
    console.warn(
      `[manifestStore] Transaksi live tidak dapat dimulai: ${error.message}`,
    );
    return false;
  }

  liveSync = {
    documentIds: new Set(),
    rows: 0,
    startedAt: Date.now(),
  };
  return true;
}

export function isLiveManifestSyncActive() {
  return Boolean(liveSync);
}

/**
 * Upsert satu halaman hasil parser SGO. ID yang status dokumennya berubah
 * dicatat agar ringkasan akhir tetap melaporkan jumlah dokumen yang berubah
 * meskipun snapshot final sudah melihat baris yang sama.
 */
export function upsertLiveManifestRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      updated: 0,
      documentsUpdated: liveSync?.documentIds.size || 0,
    };
  }

  const database = getDb();
  const normalized = list
    .map((row, index) => normalizeManifestRow(row, index))
    .filter((row) => row && row.id);

  if (!normalized.length) {
    return {
      updated: 0,
      documentsUpdated: liveSync?.documentIds.size || 0,
    };
  }

  const updateColumns = MANIFEST_COLUMNS.filter((column) => column !== 'id');
  const upsert = database.prepare(`
    INSERT INTO manifest_rows (${MANIFEST_COLUMNS.join(', ')})
    VALUES (${MANIFEST_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${updateColumns.map((column) => `${column} = excluded.${column}`).join(',\n      ')}
  `);
  const placeholders = normalized.map(() => '?').join(', ');
  const ownTransaction = !liveSync;

  if (ownTransaction) database.exec('BEGIN IMMEDIATE;');

  try {
    const previous = new Map(
      database
        .prepare(
          `SELECT id, dokumen_detail, completed_docs, total_docs FROM manifest_rows WHERE id IN (${placeholders})`,
        )
        .all(...normalized.map((row) => row.id))
        .map((row) => [row.id, row]),
    );

    for (const row of normalized) {
      const previousRow = previous.get(row.id);
      if (
        previousRow &&
        (String(previousRow.dokumen_detail || '') !== row.dokumenDetail ||
          Number(previousRow.completed_docs || 0) !== row.completedDocs ||
          Number(previousRow.total_docs || 0) !== row.totalDocs)
      ) {
        liveSync?.documentIds.add(row.id);
      }
      upsert.run(...manifestRowValues(row));
    }

    if (liveSync) liveSync.rows += normalized.length;
    if (ownTransaction) database.exec('COMMIT;');

    return {
      updated: normalized.length,
      documentsUpdated: liveSync?.documentIds.size || 0,
    };
  } catch (error) {
    if (ownTransaction) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        /* transaksi mungkin sudah dibatalkan */
      }
    }
    throw error;
  }
}

export function commitLiveManifestSync() {
  if (!liveSync) {
    return { committed: false, rows: 0, documentsUpdated: 0 };
  }

  const result = {
    committed: false,
    rows: liveSync.rows,
    documentsUpdated: liveSync.documentIds.size,
  };
  const database = getDb();

  try {
    database.exec('COMMIT;');
    result.committed = true;
  } catch (error) {
    console.warn(
      `[manifestStore] Gagal commit sinkronisasi live: ${error.message}`,
    );
    try {
      database.exec('ROLLBACK;');
    } catch {
      /* transaksi mungkin sudah dibatalkan */
    }
  } finally {
    liveSync = null;
  }

  return result;
}

export function rollbackLiveManifestSync() {
  if (!liveSync) return false;

  const database = getDb();
  try {
    database.exec('ROLLBACK;');
  } catch {
    /* transaksi mungkin sudah dibatalkan */
  } finally {
    liveSync = null;
  }
  return true;
}

/**
 * Ambil status dokumen terbaru hanya untuk kartu yang sedang terlihat.
 * Endpoint ini dipakai polling frontend saat sync penuh berjalan agar warna
 * badge berubah real-time tanpa mengacak urutan kartu.
 */
export function getManifestLiveStates(ids = []) {
  const list = [
    ...new Set(
      (Array.isArray(ids) ? ids : []).map((id) => cleanText(id)).filter(Boolean),
    ),
  ].slice(0, 800);

  if (!list.length) return [];

  ensureManifestCache();
  const placeholders = list.map(() => '?').join(', ');
  return getDb()
    .prepare(`SELECT * FROM manifest_rows WHERE id IN (${placeholders})`)
    .all(...list)
    .map(mapApiRow);
}

/**
 * Ambil seluruh jamaah untuk satu kode order, tanpa terpengaruh filter
 * daftar. Dipakai untuk menyusun pesan FU keluarga yang utuh.
 */
export function getManifestOrderRows(orderCode = '') {
  const code = cleanText(orderCode).toUpperCase().slice(0, 100);
  if (!code) return [];

  ensureManifestCache();
  return getDb()
    .prepare(
      `SELECT * FROM manifest_rows
        WHERE UPPER(order_code) = ?
        ORDER BY row_order ASC`,
    )
    .all(code)
    .map(mapApiRow);
}

/**
 * Kode unik Portal Jamaah tersimpan per order. Nilai ini bukan data pribadi
 * jamaah, tetapi tetap tidak dikembalikan lewat API publik; hanya dipakai
 * server untuk membentuk tautan login order yang tepat.
 */
export function getCachedPortalEntry(orderCode = '') {
  const code = cleanText(orderCode).toUpperCase();
  if (!code) return null;

  const database = getDb();
  const exact = /^[A-Z0-9]+(?:-[A-Z0-9]+){2,}$/.test(code)
    ? database
        .prepare(
          'SELECT order_code, unique_code FROM portal_codes WHERE order_code = ?',
        )
        .get(code)
    : null;
  if (exact?.unique_code) {
    return {
      orderCode: cleanText(exact.order_code).toUpperCase(),
      uniqueCode: cleanText(exact.unique_code).toUpperCase(),
    };
  }

  // Nomor order pendek (mis. 5107) dicocokkan ke kode lengkap tersimpan.
  if (/^\d{3,6}$/.test(code)) {
    const suffix = database
      .prepare(
        `SELECT order_code, unique_code
           FROM portal_codes
          WHERE order_code LIKE ?
            AND instr(order_code, '-') > 0
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(`%${code}`);
    if (suffix?.unique_code) {
      return {
        orderCode: cleanText(suffix.order_code).toUpperCase(),
        uniqueCode: cleanText(suffix.unique_code).toUpperCase(),
      };
    }
  }

  return null;
}

export function getCachedPortalCode(orderCode = '') {
  return getCachedPortalEntry(orderCode)?.uniqueCode || '';
}

export function savePortalCode(orderCode = '', uniqueCode = '', source = '') {
  const code = cleanText(orderCode).toUpperCase();
  const unique = cleanText(uniqueCode)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
  // Portal hanya bisa auto-login dengan kode order lengkap; jangan menyimpan
  // nomor order pendek sebagai kunci cache.
  if (!code || code.split('-').filter(Boolean).length < 3 || !unique) {
    return false;
  }

  getDb()
    .prepare(
      `INSERT INTO portal_codes (order_code, unique_code, source, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(order_code) DO UPDATE SET
         unique_code = excluded.unique_code,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .run(code, unique, cleanText(source), new Date().toISOString());
  return true;
}

/**
 * Selaraskan cache dengan data jamaah di memori. Signature berubah setiap
 * scrape sukses (sourceInfo.loadedAt) atau saat jumlah/isi nama berubah.
 */
export function ensureManifestCache({ force = false } = {}) {
  const database = getDb();
  const rows = getJamaahData();
  const source = getJamaahSource();
  const meta = readMeta();

  // Sinkronisasi live sedang menulis baris per halaman. Jangan memulai
  // transaksi snapshot lain; query tetap membaca perubahan yang belum
  // di-commit pada koneksi SQLite yang sama.
  if (liveSync) {
    return {
      syncedAt: meta.last_synced_at || null,
      total: Number(meta.total_jamaah || rows.length || 0),
      stale: false,
      warning: '',
      live: true,
    };
  }

  if (!rows.length) {
    if (Number(meta.total_jamaah || 0) > 0) {
      return {
        syncedAt: meta.last_synced_at || null,
        total: Number(meta.total_jamaah || 0),
        stale: true,
        warning:
          'Data jamaah di memori kosong. Menampilkan cache SQLite terakhir.',
      };
    }
    return {
      syncedAt: meta.last_synced_at || null,
      total: 0,
      stale: false,
      warning: '',
    };
  }

  const signature = dataSignature(rows, source);
  if (!force && meta.signature === signature) {
    return {
      syncedAt: meta.last_synced_at || null,
      total: Number(meta.total_jamaah || 0),
      stale: false,
      warning: '',
    };
  }

  const saved = saveSnapshot(database, rows, signature);
  console.log(
    `[manifestStore] Cache SQLite diperbarui: ${formatCount(saved.total)} jamaah | ` +
      `${formatCount(saved.inserted)} baru | ${formatCount(saved.updated)} diperbarui | ` +
      `${formatCount(saved.documentsUpdated)} status dokumen berubah.`,
  );

  return {
    syncedAt: saved.syncedAt,
    total: saved.total,
    inserted: saved.inserted,
    updated: saved.updated,
    documentsUpdated: saved.documentsUpdated,
    stale: false,
    warning: '',
  };
}

/* -------------------------------------------------------------------------- */
/* Query & payload                                                            */
/* -------------------------------------------------------------------------- */

function buildWhere({ query = '', month = 'all', status = 'all' } = {}) {
  const clauses = [];
  const params = [];

  if (month === 'unknown') {
    clauses.push("month_key = ''");
  } else if (/^\d{2}$/.test(month)) {
    clauses.push("month_key LIKE ?");
    params.push(`%-${month}`);
  } else if (month !== 'all') {
    clauses.push('month_key = ?');
    params.push(month);
  }

  if (status === 'complete') {
    clauses.push('is_complete = 1');
  } else if (status === 'incomplete') {
    clauses.push('is_complete = 0');
  }

  const terms = normalizeSearch(query)
    .slice(0, MAX_QUERY_LENGTH)
    .split(' ')
    .filter(Boolean);

  for (const term of terms) {
    clauses.push('search_text LIKE ?');
    params.push(`%${term}%`);
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function readRows(where = { sql: '', params: [] }, { limit = 0, offset = 0 } = {}) {
  let sql = `SELECT * FROM manifest_rows ${where.sql}`;
  const params = [...where.params];

  if (limit > 0) {
    sql +=
      " ORDER BY is_complete ASC, missing_docs DESC, CASE WHEN departure_iso = '' THEN 1 ELSE 0 END ASC, departure_iso ASC, name ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);
  } else {
    sql += ' ORDER BY row_order ASC';
  }

  return getDb().prepare(sql).all(...params);
}

function mapSummarySourceRow(row) {
  return {
    nama: row.name || '',
    orderCode: row.order_code || '',
    shortCode: row.short_code || '',
    paket: row.package_name || '',
    rtb: row.rtb || '',
    keberangkatan: row.departure_label || '',
    dokumenDetail: row.dokumen_detail || '',
  };
}

function parseJsonArray(value = '[]') {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapApiRow(row) {
  const documents = orderDocuments(parseJsonArray(row.documents_json));
  const jamaahId = cleanText(row.jamaah_id);
  const managementId = /^\d+$/.test(jamaahId) ? jamaahId : '';

  return {
    id: row.id || '',
    nama: row.name || '',
    orderCode: row.order_code || '',
    shortCode: row.short_code || '',
    paket: row.package_name || '',
    rtb: row.rtb || '',
    pemesan: row.pemesan || '',
    departureLabel: row.departure_label || '',
    departureIso: row.departure_iso || '',
    departureDisplay: row.departure_display || 'Belum terjadwal',
    departureMonthKey: row.month_key || '',
    departureMonthLabel: row.month_label || monthLabelFromKey(row.month_key),
    phoneDisplay: row.phone_display || '',
    waUrl: row.wa_url || '',
    documents,
    completed: Number(row.completed_docs || 0),
    total: Number(row.total_docs || 0),
    missing: cleanText(row.missing_labels)
      ? row.missing_labels.split(' | ').filter(Boolean)
      : [],
    inProgress: cleanText(row.process_labels)
      ? row.process_labels.split(' | ').filter(Boolean)
      : [],
    isComplete: Boolean(row.is_complete),
    status: row.status || (row.is_complete ? 'complete' : 'incomplete'),
    progressLabel: `${Number(row.completed_docs || 0)}/${Number(row.total_docs || 0)}`,
    manageUrl: managementId
      ? `/ops/monitoring_jamaah/${encodeURIComponent(managementId)}/edit`
      : '',
  };
}

/**
 * Gabungkan baris jamaah menjadi satu grup per kode order. Satu order bisa
 * berisi banyak jamaah; kartu FU dokumen harus tetap satu supaya kode order
 * tidak tampil berulang. Baris tanpa kode order tetap berdiri sendiri.
 */
function buildOrderGroups(items = []) {
  const groups = [];
  const groupMap = new Map();

  items.forEach((item) => {
    const orderCode = cleanText(item.orderCode).toUpperCase();
    const key = orderCode ? `order:${orderCode}` : `row:${item.id || groups.length}`;
    let group = groupMap.get(key);

    if (!group) {
      group = { key, orderCode, rows: [] };
      groupMap.set(key, group);
      groups.push(group);
    }

    group.rows.push(item);
  });

  groups.forEach((group) => {
    const rows = group.rows;
    const first = rows[0] || {};
    const completedDocs = rows.reduce(
      (sum, row) => sum + Number(row.completed || 0),
      0,
    );
    const totalDocs = rows.reduce(
      (sum, row) => sum + Number(row.total || 0),
      0,
    );
    const missingDocs = rows.reduce(
      (sum, row) => sum + (Array.isArray(row.missing) ? row.missing.length : 0),
      0,
    );
    const incompleteCount = rows.filter((row) => !row.isComplete).length;

    group.nama = first.nama || '';
    group.paket = first.paket || '';
    group.rtb = first.rtb || '';
    group.pemesan = first.pemesan || first.nama || '';
    group.departureDisplay = first.departureDisplay || 'Belum terjadwal';
    group.departureIso = first.departureIso || '';
    group.departureMonthLabel = first.departureMonthLabel || '';
    group.jamaahCount = rows.length;
    group.completeCount = rows.length - incompleteCount;
    group.incompleteCount = incompleteCount;
    group.completedDocs = completedDocs;
    group.totalDocs = totalDocs;
    group.missingDocs = missingDocs;
    group.percent = totalDocs
      ? Math.round((completedDocs / totalDocs) * 100)
      : 0;
    group.isComplete = incompleteCount === 0;
  });

  groups.sort((left, right) => {
    if (left.isComplete !== right.isComplete) return left.isComplete ? 1 : -1;
    if (right.incompleteCount !== left.incompleteCount) {
      return right.incompleteCount - left.incompleteCount;
    }
    if (right.missingDocs !== left.missingDocs) {
      return right.missingDocs - left.missingDocs;
    }

    const leftDeparture = left.departureIso || '9999-99-99';
    const rightDeparture = right.departureIso || '9999-99-99';
    if (leftDeparture !== rightDeparture) {
      return leftDeparture.localeCompare(rightDeparture);
    }

    return String(left.orderCode || left.nama).localeCompare(
      String(right.orderCode || right.nama),
      'id',
    );
  });

  return groups;
}

function buildMonthOptions() {
  const database = getDb();
  const totalAll = Number(
    database.prepare('SELECT COUNT(*) AS total FROM manifest_rows').get()?.total ||
      0,
  );
  const incompleteAll = Number(
    database
      .prepare(
        'SELECT COUNT(*) AS total FROM manifest_rows WHERE is_complete = 0',
      )
      .get()?.total || 0,
  );

  const rows = database
    .prepare(`
      SELECT
        month_key,
        month_label,
        COUNT(*) AS total,
        SUM(CASE WHEN is_complete = 0 THEN 1 ELSE 0 END) AS incomplete
      FROM manifest_rows
      WHERE month_key <> ''
      GROUP BY month_key, month_label
      ORDER BY month_key ASC
    `)
    .all();

  const options = [
    {
      value: 'all',
      label: 'Semua Bulan Keberangkatan',
      total: totalAll,
      incomplete: incompleteAll,
    },
    ...rows.map((row) => ({
      value: row.month_key,
      label: row.month_label || monthLabelFromKey(row.month_key),
      total: Number(row.total || 0),
      incomplete: Number(row.incomplete || 0),
    })),
  ];

  const unknown = database
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_complete = 0 THEN 1 ELSE 0 END) AS incomplete
      FROM manifest_rows
      WHERE month_key = ''
    `)
    .get();

  if (Number(unknown?.total || 0) > 0) {
    options.push({
      value: 'unknown',
      label: 'Tanggal Belum Ditentukan',
      total: Number(unknown.total || 0),
      incomplete: Number(unknown.incomplete || 0),
    });
  }

  return options;
}

/**
 * Query manifest terpadu dari SQLite.
 *
 * `limit` berlaku untuk jumlah grup order per halaman, bukan jumlah baris
 * jamaah, supaya satu order tidak terpecah ke halaman berbeda.
 *
 * @param {object} options
 * @param {string} [options.query] nama/order/HP/bulan
 * @param {'all'|'complete'|'incomplete'} [options.status]
 * @param {string} [options.month] `YYYY-MM`, `unknown`, atau `all`
 */
export function getManifestSnapshot(options = {}) {
  const sync = ensureManifestCache({ force: Boolean(options.force) });
  const rawQuery = cleanText(options.query).slice(0, MAX_QUERY_LENGTH);
  const queryMonth = resolveQueryMonth(rawQuery);
  const query = queryMonth.month ? '' : queryMonth.query;
  const month = queryMonth.month || normalizeMonth(options.month);
  const status = normalizeStatus(options.status);

  const requestedPage = Number(options.page);
  const requestedLimit = Number(options.limit);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const filteredWhere = buildWhere({ query, month, status: 'all' });
  const matchedWhere = buildWhere({ query, month, status });

  const filteredRows = readRows(filteredWhere);
  const summary = buildMonitoringSummary(
    filteredRows.map(mapSummarySourceRow),
    getJamaahSource(),
  );

  // Satu kartu FU dokumen mewakili satu kode order. Pagination dihitung per
  // grup order supaya jamaah dengan kode order sama tidak terpisah halaman.
  const matchedRows = readRows(matchedWhere).map(mapApiRow);
  const totalMatched = matchedRows.length;
  const groups = buildOrderGroups(matchedRows);
  const totalGroups = groups.length;
  const pages = Math.max(1, Math.ceil(totalGroups / limit));
  const page = Math.min(
    Math.max(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1, 1),
    pages,
  );
  const pageGroups = groups.slice((page - 1) * limit, page * limit);
  const items = pageGroups.flatMap((group) => group.rows);
  const pageJamaahCount = items.length;

  const totalAll = Number(
    getDb().prepare('SELECT COUNT(*) AS total FROM manifest_rows').get()?.total ||
      0,
  );
  const monthOptions = buildMonthOptions();
  let selectedMonth = null;

  if (month === 'unknown') {
    selectedMonth = monthOptions.find((option) => option.value === 'unknown') || {
      value: 'unknown',
      label: 'Tanggal Belum Ditentukan',
      total: 0,
      incomplete: 0,
    };
  } else if (/^\d{2}$/.test(month)) {
    const matching = monthOptions.filter((option) =>
      option.value.endsWith(`-${month}`),
    );
    const monthName = monthLabelFromKey(`2000-${month}`).replace(/\s+\d{4}$/, '');
    selectedMonth = {
      value: month,
      label: `${monthName} (semua tahun)`,
      total: matching.reduce((total, option) => total + option.total, 0),
      incomplete: matching.reduce(
        (total, option) => total + option.incomplete,
        0,
      ),
    };
  } else if (month !== 'all') {
    selectedMonth = monthOptions.find((option) => option.value === month) || {
      value: month,
      label: monthLabelFromKey(month) || 'Tanggal Belum Ditentukan',
      total: 0,
      incomplete: 0,
    };
  }

  const warnings = [];
  if (sync.warning) warnings.push(sync.warning);
  if (sync.stale) {
    warnings.push('Angka dapat berbeda dari kondisi live SGO.');
  }

  return {
    items,
    groups: pageGroups,
    page,
    limit,
    pages,
    totalMatched,
    totalGroups,
    pageJamaahCount,
    totalAll,
    totalFiltered: summary.totalJamaah,
    summary,
    monthOptions,
    selectedMonth,
    filter: {
      query: rawQuery,
      searchQuery: query,
      status,
      month,
      queryMonth: Boolean(queryMonth.month),
    },
    lastSyncedAt: sync.syncedAt,
    stale: Boolean(sync.stale),
    warning: [...new Set(warnings)].join(' ') || null,
    source: {
      type: 'sgo-sqlite',
      module: '/ops/upload-documents',
      database: 'sqlite',
    },
  };
}

export function getManifestDebugInfo() {
  const meta = readMeta();
  return {
    database: 'sqlite',
    path: DB_PATH,
    total: Number(meta.total_jamaah || 0),
    complete: Number(meta.total_complete || 0),
    lastSyncedAt: meta.last_synced_at || null,
  };
}

export default {
  ensureManifestCache,
  getManifestSnapshot,
  getManifestLiveStates,
  getManifestOrderRows,
  getManifestDebugInfo,
  beginLiveManifestSync,
  upsertLiveManifestRows,
  commitLiveManifestSync,
  rollbackLiveManifestSync,
};
