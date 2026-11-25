import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_FILE = process.env.JAMAAH_AI_INDEX_FILE
  ? path.resolve(process.env.JAMAAH_AI_INDEX_FILE)
  : path.join(__dirname, '..', 'data', 'jamaah_ai_index.json');
const INDEX_VERSION = 1;
const MAX_BREAKDOWN_ITEMS = 20;

let cachedIndex = null;

function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(value = '') {
  return clean(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function unique(values = []) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function counter(entries = [], limit = MAX_BREAKDOWN_ITEMS) {
  const counts = new Map();
  for (const entry of entries) {
    const key = clean(entry);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function parseMissingDocuments(row = {}) {
  const detail = clean(row.dokumenDetail);
  if (!detail) return [];
  return detail
    .split('|')
    .map((part) => {
      const [label, value = ''] = part.split(':').map((item) => clean(item));
      return value.toUpperCase() === 'BELUM' ? label : '';
    })
    .filter(Boolean);
}

function isComplete(row = {}) {
  const status = clean(row.statusDokumen || row.status || '').toLowerCase();
  if (/lengkap|complete/.test(status) && !/belum|tidak/.test(status)) return true;
  if (Number(row.orderMissingDocs) === 0 && Number(row.orderFilledDocs) > 0) {
    return true;
  }
  return parseMissingDocuments(row).length === 0 && Boolean(clean(row.dokumenDetail));
}

function compactRow(row = {}, index = 0) {
  const orderCode = clean(row.orderCode || row.kodeOrder || row.orderId);
  const shortCode = clean(row.shortCode || row.orderShort);
  const rtb = clean(row.rtb || row.noRtb);
  const nama = clean(row.nama || row.name);
  const paket = clean(row.paket);
  const keberangkatan = clean(
    row.keberangkatan || row.departureMonthLabel || row.departureIso,
  );
  const id = clean(row.manifestId || row.jamaahId) || `${orderCode || 'jamaah'}-${index + 1}`;
  const missing = parseMissingDocuments(row);

  return {
    id,
    nama,
    orderCode,
    shortCode,
    rtb,
    paket,
    keberangkatan,
    statusPembayaran: clean(row.statusPembayaran || row.status || row.pembayaran),
    statusDokumen: clean(row.statusDokumen || row.dokumen),
    missingDocuments: missing,
    manifestFetched: row.manifestFetched === true,
    tokens: normalize([nama, orderCode, shortCode, rtb, paket, keberangkatan].join(' ')),
  };
}

function addLookup(map, key, id) {
  if (!key || !id) return;
  const values = map[key] || [];
  if (!values.includes(id)) values.push(id);
  map[key] = values;
}

function orderKey(value = '') {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildIndex(rows = [], source = null) {
  const list = Array.isArray(rows) ? rows : [];
  const compact = list.map((row, index) => compactRow(row, index));
  const lookups = { order: {}, orderCounts: {}, rtb: {}, nama: {}, paket: {} };
  const missingNik = [];
  const missingPassport = [];
  let nikFilled = 0;
  let passportFilled = 0;
  let manifestFilled = 0;

  for (const [position, row] of list.entries()) {
    const entry = compact[position];
    const nik = clean(row?.nik || row?.ktp);
    const passport = clean(row?.passport || row?.paspor || row?.noPaspor);
    if (nik) nikFilled += 1;
    else missingNik.push(entry.id);
    if (passport) passportFilled += 1;
    else missingPassport.push(entry.id);
    if (clean(row?.manifestId)) manifestFilled += 1;

    for (const value of [entry.orderCode, entry.shortCode]) {
      addLookup(lookups.order, clean(value).toUpperCase(), entry.id);
    }
    const countKey = orderKey(entry.orderCode);
    if (countKey) {
      lookups.orderCounts[countKey] = (lookups.orderCounts[countKey] || 0) + 1;
    }
    addLookup(lookups.rtb, entry.rtb.toUpperCase(), entry.id);
    addLookup(lookups.nama, normalize(entry.nama), entry.id);
    addLookup(lookups.paket, normalize(entry.paket), entry.id);
  }

  const complete = list.filter((row) => isComplete(row)).length;
  const missingDocuments = list.reduce(
    (total, row) => total + parseMissingDocuments(row).length,
    0,
  );
  const summary = {
    total: list.length,
    orders: unique(list.map((row) => clean(row.orderCode || row.kodeOrder || row.orderId))).length,
    rtb: unique(list.map((row) => clean(row.rtb || row.noRtb))).length,
    complete,
    incomplete: Math.max(0, list.length - complete),
    missingDocuments,
    nikFilled,
    passportFilled,
    manifestFilled,
    missingNik: missingNik.length,
    missingPassport: missingPassport.length,
    departureBreakdown: counter(list.map((row) => clean(row.keberangkatan) || clean(row.departureMonthLabel))),
    rtbBreakdown: counter(list.map((row) => clean(row.rtb || row.noRtb))),
    packageBreakdown: counter(list.map((row) => clean(row.paket))),
    missingNikIds: missingNik,
    missingPassportIds: missingPassport,
  };

  const departureText = summary.departureBreakdown
    .slice(0, 5)
    .map((item) => `${item.label}: ${item.count}`)
    .join(', ');
  const summaryText =
    `Ringkasan data jamaah lokal: ${summary.total} jamaah, ${summary.orders} order, ` +
    `${summary.rtb} RTB, lengkap ${summary.complete}, belum lengkap ${summary.incomplete}, ` +
    `NIK ${nikFilled}/${list.length}, paspor ${passportFilled}/${list.length}` +
    (departureText ? `, keberangkatan ${departureText}` : '') +
    '.';

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    source: source && typeof source === 'object'
      ? {
          type: clean(source.type),
          count: Number(source.count) || list.length,
          loadedAt: clean(source.loadedAt),
          modules: Array.isArray(source.modules) ? source.modules : [],
        }
      : null,
    summary,
    summaryText,
    lookups,
    rows: compact,
  };
}

function writeIndex(index) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  const temporary = `${INDEX_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index), 'utf8');
  fs.renameSync(temporary, INDEX_FILE);
}

export function loadJamaahAiIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.rows)) {
      return null;
    }
    cachedIndex = parsed;
    return cachedIndex;
  } catch (error) {
    console.warn(`[jamaahAiIndex] Gagal memuat indeks: ${error.message}`);
    return null;
  }
}

export function getJamaahAiIndex() {
  if (!cachedIndex) loadJamaahAiIndex();
  return cachedIndex;
}

export function hasJamaahAiIndex() {
  return Boolean(getJamaahAiIndex());
}

export function refreshJamaahAiIndex(rows = [], source = null) {
  cachedIndex = buildIndex(rows, source);
  try {
    writeIndex(cachedIndex);
  } catch (error) {
    console.warn(`[jamaahAiIndex] Gagal menyimpan indeks: ${error.message}`);
  }
  return cachedIndex;
}

export function getJamaahAiSummary() {
  const index = getJamaahAiIndex();
  return index?.summaryText || '';
}

export function getJamaahAiIndexFilePath() {
  return INDEX_FILE;
}
