import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Penyimpanan respons mentah SGO.
 *
 * Hanya lima modul operasional yang diminta yang dipersistensikan. File berisi
 * HTML asli dari SGO, sehingga tidak boleh di-commit dan tidak boleh dicetak
 * ke log karena dapat memuat data pribadi jamaah.
 */
const RAW_DIR = process.env.SGO_RAW_DIR
  ? path.resolve(process.env.SGO_RAW_DIR)
  : path.join(__dirname, '..', 'sgo_raw');

export const SGO_RAW_MODULES = Object.freeze([
  '/ops/monitoring-jamaah',
  '/ops/upload-documents',
  '/ops/travel-docs',
  '/ops/stock-perlengkapan',
  '/ops/hotel',
]);

const RAW_MODULE_SET = new Set(SGO_RAW_MODULES.map((item) => item.toLowerCase()));
const memory = new Map();

function normalizeModulePath(value = '') {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      raw = `${parsed.pathname}${parsed.search}`;
    } catch {
      return '';
    }
  }
  raw = raw.split('#')[0];
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const trimmed = raw.replace(/\/+$/, '');
  return (trimmed || '/').toLowerCase();
}

function moduleSlug(modulePath = '') {
  return (
    normalizeModulePath(modulePath)
      .replace(/^\/+/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'module'
  );
}

function rawFilePath(modulePath = '') {
  return path.join(RAW_DIR, `${moduleSlug(modulePath)}.json`);
}

function emptyRecord(modulePath = '') {
  return {
    modulePath: normalizeModulePath(modulePath),
    updatedAt: null,
    lastAttempt: null,
    response: null,
  };
}

function readRecord(modulePath = '') {
  const normalized = normalizeModulePath(modulePath);
  if (!normalized) return null;
  if (memory.has(normalized)) return memory.get(normalized);

  const file = rawFilePath(normalized);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const record = {
        ...emptyRecord(normalized),
        ...parsed,
        modulePath: normalized,
      };
      memory.set(normalized, record);
      return record;
    }
  } catch (error) {
    console.warn(
      `[sgoRawStore] Gagal membaca ${file}: ${error.message}. Respons mentah dianggap belum ada.`,
    );
  }

  const record = emptyRecord(normalized);
  memory.set(normalized, record);
  return record;
}

function writeRecord(record) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = rawFilePath(record.modulePath);
  const json = JSON.stringify(record, null, 2);
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tmpFile, json, 'utf8');
  try {
    fs.renameSync(tmpFile, file);
  } catch {
    try {
      fs.copyFileSync(tmpFile, file);
      fs.unlinkSync(tmpFile);
    } catch {
      try {
        fs.writeFileSync(file, json, 'utf8');
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // File sementara mungkin sudah tidak ada.
        }
      }
    }
  }
  return file;
}

function responseMeta(record) {
  const response = record?.response || null;
  return response
    ? {
        fetchedAt: response.fetchedAt || null,
        targetUrl: response.targetUrl || null,
        finalUrl: response.finalUrl || null,
        status: response.status ?? null,
        contentType: response.contentType || null,
        htmlLength: response.htmlLength ?? 0,
        pageOk: Boolean(response.pageOk),
        rows: response.rows ?? 0,
        summary: response.summary || null,
      }
    : null;
}

function recordMeta(record) {
  if (!record) return null;
  return {
    modulePath: record.modulePath,
    file: path.basename(rawFilePath(record.modulePath)),
    updatedAt: record.updatedAt || null,
    lastAttempt: record.lastAttempt || null,
    response: responseMeta(record),
  };
}

export function isPersistedSgoModule(modulePath = '') {
  return RAW_MODULE_SET.has(normalizeModulePath(modulePath));
}

/**
 * Simpan respons HTTP asli yang berhasil dibaca dari SGO.
 * Fungsi ini tidak pernah melempar error agar kegagalan tulis tidak
 * menggagalkan scrape utama.
 */
export function saveSgoRawResponse(page = {}) {
  const modulePath = normalizeModulePath(page.modulePath);
  if (!modulePath || !isPersistedSgoModule(modulePath)) return null;

  try {
    const record = readRecord(modulePath) || emptyRecord(modulePath);
    const fetchedAt = page.fetchedAt || new Date().toISOString();
    const html = typeof page.html === 'string' ? page.html : String(page.html || '');

    record.updatedAt = fetchedAt;
    record.lastAttempt = {
      at: fetchedAt,
      ok: true,
      code: '',
      status: page.status ?? null,
      targetUrl: page.targetUrl || null,
      finalUrl: page.finalUrl || null,
      rows: Number(page.rowsCount || 0),
      ms: Number(page.ms || 0),
      error: '',
    };
    record.response = {
      fetchedAt,
      targetUrl: page.targetUrl || null,
      finalUrl: page.finalUrl || null,
      status: page.status ?? null,
      contentType: page.contentType || 'text/html',
      htmlLength: html.length,
      pageOk: Boolean(page.pageOk),
      rows: Number(page.rowsCount || 0),
      summary: page.summary || null,
      html,
    };

    memory.set(modulePath, record);
    writeRecord(record);
    return recordMeta(record);
  } catch (error) {
    console.warn(
      `[sgoRawStore] Gagal menyimpan respons ${modulePath}: ${error.message}. ` +
        'Scrape tetap dilanjutkan tanpa persistensi respons mentah.',
    );
    return null;
  }
}

/**
 * Catat kegagalan attempt terakhir tanpa menghapus respons sukses terakhir.
 * Dengan begitu status API tetap jujur: ada error terbaru, tetapi data mentah
 * terakhir yang benar-benar diterima dari SGO tidak hilang.
 */
export function saveSgoRawError({
  modulePath,
  code = 'SGO_ERROR',
  message = '',
  status = null,
  targetUrl = null,
  finalUrl = null,
  ms = 0,
} = {}) {
  const normalized = normalizeModulePath(modulePath);
  if (!normalized || !isPersistedSgoModule(normalized)) return null;

  try {
    const record = readRecord(normalized) || emptyRecord(normalized);
    record.updatedAt = new Date().toISOString();
    record.lastAttempt = {
      at: record.updatedAt,
      ok: false,
      code,
      status: status ?? null,
      targetUrl: targetUrl || null,
      finalUrl: finalUrl || null,
      rows: 0,
      ms: Number(ms || 0),
      error: String(message || code || 'Gagal mengambil respons SGO.'),
    };
    memory.set(normalized, record);
    writeRecord(record);
    return recordMeta(record);
  } catch (error) {
    console.warn(
      `[sgoRawStore] Gagal mencatat error ${normalized}: ${error.message}.`,
    );
    return null;
  }
}

/** Metadata semua modul yang dipersistensikan, tanpa HTML mentah. */
export function getSgoRawStatus() {
  return SGO_RAW_MODULES.map((modulePath) => recordMeta(readRecord(modulePath)));
}

/** Metadata satu modul, tanpa HTML mentah. */
export function getSgoRawStatusFor(modulePath = '') {
  const normalized = normalizeModulePath(modulePath);
  if (!normalized || !isPersistedSgoModule(normalized)) return null;
  return recordMeta(readRecord(normalized));
}

/**
 * Ambil record mentah lengkap. Hanya untuk keperluan internal/diagnostik.
 * Jangan pernah mengirim html ke klien tanpa otorisasi dan masking PII.
 */
export function getSgoRawResponse(modulePath = '', { includeHtml = false } = {}) {
  const normalized = normalizeModulePath(modulePath);
  if (!normalized || !isPersistedSgoModule(normalized)) return null;
  const record = readRecord(normalized);
  if (!record) return null;
  if (includeHtml) return { ...record, response: record.response ? { ...record.response } : null };
  return recordMeta(record);
}

export function getSgoRawDirectory() {
  return RAW_DIR;
}
