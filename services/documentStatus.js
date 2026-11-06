/**
 * Status dokumen & manifest jamaah.
 *
 * Modul ini terpisah dari services/aiEngine.js agar logika pencarian AI yang
 * sudah stabil tidak tersentuh. Data yang dikirim ke UI dibatasi pada field
 * operasional yang aman: nama, kode order, paket, keberangkatan, dan status
 * dokumen. NIK, paspor, serta nomor HP mentah tidak pernah dikembalikan.
 */

import { resolveOrderQuery } from './orderSearch.js';

const DEFAULT_DOCUMENT_LABELS = [
  'KTP',
  'KK',
  'Foto',
  'Paspor',
  'Vaksin',
  'Vaksin Polio',
];

const STATE_MAP = {
  ADA: 'complete',
  PROSES: 'process',
  BELUM: 'missing',
};

const STATE_LABEL = {
  complete: 'Lengkap',
  process: 'Proses',
  missing: 'Belum ada',
};

const MAX_QUERY_LENGTH = 120;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;

function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function cleanOneLine(value) {
  return safeText(value).replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return cleanOneLine(value).toLowerCase();
}

function digitsOnly(value) {
  return safeText(value).replace(/\D+/g, '');
}

/**
 * Bentuk kanonik nomor Indonesia agar "08...", "+62...", dan "62..." saling
 * cocok. Nomor hanya dipakai untuk pencarian di server, tidak untuk display.
 */
function canonicalPhone(value) {
  let digits = digitsOnly(value);
  if (digits.startsWith('62')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getOrderCode(row = {}) {
  return cleanOneLine(row.orderCode || row.kodeOrder || row.orderId);
}

function getShortCode(row = {}) {
  return cleanOneLine(row.shortCode || row.orderShort);
}

function getRowId(row = {}, index = 0) {
  const manifestId = cleanOneLine(row.manifestId);
  if (manifestId) return manifestId;

  const jamaahId = cleanOneLine(row.jamaahId);
  if (jamaahId) return jamaahId;

  const orderCode = getOrderCode(row);
  return orderCode ? `${orderCode}-${index + 1}` : `jamaah-${index + 1}`;
}

/**
 * Parse "KTP:ADA | KK:BELUM | Foto:PROSES | ..." menjadi array dokumen.
 */
export function parseDokumenDetail(detail = '') {
  const parts = safeText(detail)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  const documents = [];

  for (const part of parts) {
    const separator = part.indexOf(':');
    if (separator < 0) continue;

    const label = cleanOneLine(part.slice(0, separator));
    if (!label) continue;

    const rawState = cleanOneLine(part.slice(separator + 1)).toUpperCase();
    const state = STATE_MAP[rawState] || 'missing';

    documents.push({
      key: slugify(label) || `dokumen-${documents.length + 1}`,
      label,
      state,
      stateLabel: STATE_LABEL[state],
    });
  }

  return documents;
}

/**
 * Ringkasan dokumen satu jamaah, dihitung dari dokumenDetail (bukan dari
 * orderMissingDocs/orderFilledDocs yang merupakan agregat level order).
 */
export function summarizeDocuments(row = {}) {
  const documents = parseDokumenDetail(row?.dokumenDetail);
  const completed = documents.filter((doc) => doc.state === 'complete').length;
  const missing = documents
    .filter((doc) => doc.state === 'missing')
    .map((doc) => doc.label);
  const inProgress = documents
    .filter((doc) => doc.state === 'process')
    .map((doc) => doc.label);

  return {
    documents,
    total: documents.length,
    completed,
    missing,
    inProgress,
    isComplete: documents.length > 0 && completed === documents.length,
  };
}

/**
 * Payload aman untuk satu baris manifest. Tidak memuat NIK, paspor, atau
 * nomor HP mentah.
 */
export function buildSafeJamaahRow(row = {}, index = 0) {
  const summary = summarizeDocuments(row);
  const nama = cleanOneLine(row.nama) || 'Jamaah tanpa nama';
  const orderCode = getOrderCode(row);
  const paket = cleanOneLine(row.paket);
  const keberangkatan = cleanOneLine(row.keberangkatan);

  return {
    id: getRowId(row, index),
    nama,
    orderCode,
    shortCode: getShortCode(row),
    paket,
    keberangkatan,
    documents: summary.documents,
    completed: summary.completed,
    total: summary.total,
    missing: summary.missing,
    inProgress: summary.inProgress,
    isComplete: summary.isComplete,
    status: summary.isComplete ? 'complete' : 'incomplete',
    progressLabel: `${summary.completed}/${summary.total}`,
  };
}

function matchesQuery(row = {}, query = '') {
  const queryText = normalizeText(query).slice(0, MAX_QUERY_LENGTH);
  if (!queryText) return true;

  const compactQuery = queryText.replace(/\s+/g, '');
  const name = normalizeText(row.nama);
  const orderCode = normalizeText(getOrderCode(row));
  const shortCode = normalizeText(getShortCode(row));
  const phoneDigits = canonicalPhone(row.noHp || row.hp || row.telepon || '');
  const queryDigits = canonicalPhone(queryText);

  if (name.includes(queryText)) return true;
  if (orderCode.includes(queryText) || orderCode.includes(compactQuery)) return true;
  if (shortCode && shortCode.includes(compactQuery)) return true;

  // Nomor HP hanya dicocokkan di server dan tidak pernah ditampilkan.
  if (queryDigits.length >= 3 && phoneDigits.includes(queryDigits)) return true;

  return false;
}

export function searchJamaahRows(rows = [], query = '') {
  const list = Array.isArray(rows) ? rows : [];
  const trimmed = cleanOneLine(query).slice(0, MAX_QUERY_LENGTH);
  if (!trimmed) return list;

  // Kode order memakai exact match. Ini mencegah digit yang mirip (mis. nomor
  // paspor X4719728) ikut muncul saat admin mencari order 4719/004719.
  const orderResult = resolveOrderQuery(trimmed, list);
  if (orderResult) return orderResult.matches;

  return list.filter((row) => matchesQuery(row, trimmed));
}

export function buildMonitoringSummary(rows = [], source = null) {
  const list = Array.isArray(rows) ? rows : [];
  const orders = new Set();
  const documentMap = new Map();

  for (const label of DEFAULT_DOCUMENT_LABELS) {
    documentMap.set(slugify(label), {
      key: slugify(label),
      label,
      complete: 0,
      process: 0,
      missing: 0,
      total: 0,
    });
  }

  let complete = 0;
  let incomplete = 0;
  let missingDocs = 0;
  let processDocs = 0;

  for (const row of list) {
    const orderCode = getOrderCode(row);
    if (orderCode) orders.add(orderCode);

    const summary = summarizeDocuments(row);
    if (summary.isComplete) complete += 1;
    else incomplete += 1;

    missingDocs += summary.missing.length;
    processDocs += summary.inProgress.length;

    for (const doc of summary.documents) {
      if (!documentMap.has(doc.key)) {
        documentMap.set(doc.key, {
          key: doc.key,
          label: doc.label,
          complete: 0,
          process: 0,
          missing: 0,
          total: 0,
        });
      }

      const stat = documentMap.get(doc.key);
      stat[doc.state] += 1;
      stat.total += 1;
    }
  }

  const totalJamaah = list.length;

  return {
    totalJamaah,
    totalOrders: orders.size,
    complete,
    incomplete,
    completionRate:
      totalJamaah > 0
        ? Math.round((complete / totalJamaah) * 1000) / 10
        : 0,
    missingDocs,
    processDocs,
    documentStats: [...documentMap.values()],
    source: sanitizeSource(source),
    generatedAt: new Date().toISOString(),
  };
}

export function sanitizeSource(source = null) {
  if (!source || typeof source !== 'object') return null;

  const coverage = source.fieldCoverage || {};

  return {
    type: safeText(source.type) || null,
    url: safeText(source.url) || null,
    filename: safeText(source.filename) || null,
    modules: Array.isArray(source.modules)
      ? source.modules.map((item) => safeText(item)).filter(Boolean).slice(0, 12)
      : [],
    count: Number(source.count || 0),
    fieldCoverage: {
      nik: Number(coverage.nik || 0),
      passport: Number(coverage.passport || 0),
      manifestId: Number(coverage.manifestId || 0),
    },
    loadedAt: safeText(source.loadedAt) || null,
    storage: safeText(source.storage) || null,
  };
}

function sortManifestRows(a, b) {
  if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
  if (a.missing.length !== b.missing.length) {
    return b.missing.length - a.missing.length;
  }
  if (a.inProgress.length !== b.inProgress.length) {
    return b.inProgress.length - a.inProgress.length;
  }
  return a.nama.localeCompare(b.nama, 'id');
}

export function buildManifestPage(rows = [], options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const query = cleanOneLine(options.query).slice(0, MAX_QUERY_LENGTH);
  const allowedStatuses = ['all', 'complete', 'incomplete'];
  const status = allowedStatuses.includes(options.status)
    ? options.status
    : 'all';

  const parsedPage = Number(options.page);
  const parsedLimit = Number(options.limit);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  let safeRows = searchJamaahRows(list, query).map((row, index) =>
    buildSafeJamaahRow(row, index),
  );

  if (status === 'complete') {
    safeRows = safeRows.filter((row) => row.isComplete);
  } else if (status === 'incomplete') {
    safeRows = safeRows.filter((row) => !row.isComplete);
  }

  safeRows.sort(sortManifestRows);

  const totalMatched = safeRows.length;
  const pages = Math.max(1, Math.ceil(totalMatched / limit));
  const requestedPage = Number.isFinite(parsedPage) ? Math.floor(parsedPage) : 1;
  const page = Math.min(Math.max(requestedPage || 1, 1), pages);
  const start = (page - 1) * limit;
  const items = safeRows.slice(start, start + limit);

  return {
    status,
    page,
    limit,
    pages,
    totalMatched,
    totalAll: list.length,
    items,
  };
}

/**
 * Draf WhatsApp formal atas nama Rahmah Travel. Kekurangan dokumen diberi
 * tanda × agar mudah dibaca admin sebelum dikirim.
 */
export function buildWhatsAppDraft(row = {}) {
  const safe = buildSafeJamaahRow(row);
  const recipientName = safe.nama || 'Bapak/Ibu Jamaah';
  const orderCode = safe.orderCode || '—';
  const paket = safe.paket || '—';
  const keberangkatan = safe.keberangkatan || '—';

  const lines = [
    "Assalamu'alaikum Warahmatullahi Wabarakatuh,",
    '',
    `Yth. Bapak/Ibu ${recipientName},`,
    '',
    'Semoga Bapak/Ibu senantiasa dalam keadaan sehat dan dilindungi Allah SWT. Kami dari Rahmah Travel ingin menyampaikan informasi mengenai kelengkapan dokumen pendaftaran Umrah Bapak/Ibu.',
    '',
    'Rincian jamaah:',
    `Nama: ${recipientName}`,
    `Kode Order: ${orderCode}`,
    `Paket: ${paket}`,
    `Keberangkatan: ${keberangkatan}`,
  ];

  if (safe.missing.length) {
    lines.push('', 'Dokumen yang masih perlu dilengkapi:');
    for (const label of safe.missing) {
      lines.push(`× ${label}`);
    }
  } else if (safe.inProgress.length) {
    lines.push(
      '',
      'Saat ini tidak ada dokumen yang berstatus belum diunggah. Seluruh dokumen yang tersedia sudah kami terima.',
    );
  } else {
    lines.push(
      '',
      'Alhamdulillah, seluruh dokumen pendaftaran Bapak/Ibu telah lengkap. Tidak ada dokumen yang perlu dilengkapi saat ini.',
    );
  }

  if (safe.inProgress.length) {
    lines.push(
      '',
      `Dokumen yang sedang dalam proses: ${safe.inProgress.join(', ')}.`,
    );
  }

  lines.push(
    '',
    'Mohon kesediaan Bapak/Ibu untuk melengkapi dokumen tersebut dalam waktu dekat agar proses pendaftaran dan persiapan keberangkatan dapat berjalan lancar. Apabila ada pertanyaan, silakan menghubungi tim Rahmah Travel.',
    '',
    'Atas perhatian dan kerja sama Bapak/Ibu, kami ucapkan terima kasih.',
    '',
    "Wassalamu'alaikum Warahmatullahi Wabarakatuh,",
    '',
    'Rahmah Travel',
  );

  return {
    draft: lines.join('\n'),
    recipient: {
      nama: recipientName,
      orderCode,
    },
    missing: safe.missing,
    inProgress: safe.inProgress,
    isComplete: safe.isComplete,
    progressLabel: safe.progressLabel,
  };
}

export default {
  parseDokumenDetail,
  summarizeDocuments,
  buildSafeJamaahRow,
  searchJamaahRows,
  buildManifestPage,
  buildMonitoringSummary,
  sanitizeSource,
  buildWhatsAppDraft,
};
