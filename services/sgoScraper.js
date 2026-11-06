// `dotenv` WAJIB dimuat paling awal supaya SGO_ADMIN_SESSION dan SGO_BASE_URL
// sudah tersedia sebelum modul ini dipakai.
import dotenv from 'dotenv';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import {
  isPersistedSgoModule,
  saveSgoRawError,
  saveSgoRawResponse,
} from '../data/sgoRawStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Muat .env dari root proyek secara eksplisit (tidak bergantung pada cwd),
// lalu jalankan dotenv.config() default sebagai cadangan.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

// User-Agent Chrome/Windows lengkap. Server SGO menolak UA pendek/headless.
export const SGO_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Header browser yang konsisten untuk semua request HTML (halaman modul dan
// manifest). Cookie tetap ditambahkan per request.
export const SGO_BROWSER_HEADERS = Object.freeze({
  'User-Agent': SGO_USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
});

// Daftar lengkap modul SGO Admin (dikembalikan ke 16 modul).
// Hanya Monitoring Jamaah yang menjadi sumber data jamaah; modul lain tetap
// bisa dibuka/di-scrape untuk ringkasan halamannya.
export const SGO_MODULE_OPTIONS = [
  { path: '/ops/monitoring-jamaah', label: 'Monitoring Jamaah', jamaahSource: true },
  { path: '/ops/invoice-manual', label: 'Invoice Manual', jamaahSource: false },
  { path: '/ops/b2b-rahmah', label: 'B2B Rahmah', jamaahSource: false },
  { path: '/ops/penagihan-aging', label: 'Penagihan & Aging', jamaahSource: false },
  { path: '/ops/add-on?tab=perbatch', label: 'Add On Perbatch', jamaahSource: false },
  { path: '/ops/rahmah-miles', label: 'Rahmah Miles', jamaahSource: false },
  { path: '/ops/nusuk-mutamer', label: 'Nusuk Mutamer', jamaahSource: false },
  { path: '/ops/upload-documents', label: 'Upload Manifest', jamaahSource: true },
  { path: '/ops/approval-dokumen', label: 'Approval Dokumen', jamaahSource: false },
  { path: '/ops/itinerary', label: 'Itinerary', jamaahSource: false },
  { path: '/ops/bus-addon/visa', label: 'Bus Addon / Visa', jamaahSource: false },
  { path: '/ops/hotel', label: 'Hotel', jamaahSource: false },
  { path: '/ops/travel-dokumen-detail', label: 'Travel Dokumen Detail', jamaahSource: false },
  { path: '/ops/travel-docs', label: 'Travel Docs', jamaahSource: false },
  { path: '/ops/satgas-bandara', label: 'Satgas Bandara', jamaahSource: false },
  { path: '/ops/stock-perlengkapan', label: 'Stock Perlengkapan', jamaahSource: false },
];

export const SGO_MODULES = SGO_MODULE_OPTIONS.map((module) => module.path);

export function getSgoModuleMeta(value = '') {
  const normalized = normalizeModulePath(value);
  return (
    SGO_MODULE_OPTIONS.find(
      (module) => module.path.toLowerCase() === normalized.toLowerCase(),
    ) || null
  );
}

export function isJamaahModule(value = '') {
  return Boolean(getSgoModuleMeta(value)?.jamaahSource);
}

const SGO_ORDER_RE = /ORD-\d{4}-[A-Z]{2,5}-\d{4,6}/i;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Timeout request halaman SGO. Default 20 detik sesuai kebutuhan produksi;
// nilai env tetap dihormati dan dibatasi agar tidak terlalu cepat/lama.
const REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Math.min(envNumber('SGO_REQUEST_TIMEOUT_MS', 20000), 60000),
);

// Enrichment NIK/paspor diambil dari halaman manifest per jamaah
// (/ops/monitoring-jamaah/{id}/edit?embed=1). Request dibatasi agar server
// SGO tidak dibanjiri saat scrape 400+ jamaah.
const MANIFEST_TIMEOUT_MS = Math.max(
  5000,
  Math.min(envNumber('SGO_MANIFEST_TIMEOUT_MS', 20000), 60000),
);
const MANIFEST_CONCURRENCY = Math.max(
  1,
  Math.min(envNumber('SGO_MANIFEST_CONCURRENCY', 4), 20),
);
const MANIFEST_MAX_ENRICH = Math.max(
  0,
  Math.min(envNumber('SGO_MANIFEST_MAX', 3500), 10000),
);
const MANIFEST_CACHE_TTL_MS = Math.max(
  0,
  envNumber('SGO_MANIFEST_CACHE_MS', 5 * 60 * 1000),
);
const manifestFieldCache = new Map();

// Pagination hanya dipakai untuk modul sumber jamaah. Halaman 2 dan seterusnya
// diminta berurutan dengan jeda agar tidak memicu rate-limit SGO.
const PAGINATION_ENABLED = !/^(0|false|no|off)$/i.test(
  String(process.env.SGO_PAGINATION_ENABLED ?? 'true').trim(),
);
const rawPaginationDelay = Number(process.env.SGO_PAGINATION_DELAY_MS);
const PAGINATION_DELAY_MS = Math.max(
  0,
  Math.min(
    Number.isFinite(rawPaginationDelay) ? rawPaginationDelay : 500,
    10000,
  ),
);
const PAGINATION_MAX_PAGES = Math.max(
  1,
  Math.min(envNumber('SGO_PAGINATION_MAX_PAGES', 250), 500),
);
const PAGINATION_PAGE_PARAM =
  String(process.env.SGO_PAGE_PARAM || 'page').trim() || 'page';

// Retry + backoff untuk error transien SGO (HTTP 500/502/503/504/429/timeout).
// Pagination tidak boleh berhenti permanen hanya karena satu halaman 502.
const SGO_HTTP_RETRY_ATTEMPTS = Math.max(
  1,
  Math.min(envNumber('SGO_HTTP_RETRY_ATTEMPTS', 4), 6),
);
const SGO_HTTP_RETRY_BASE_MS = Math.max(
  250,
  Math.min(envNumber('SGO_HTTP_RETRY_BASE_MS', 1200), 15000),
);
const SGO_HTTP_RETRY_MAX_MS = Math.max(
  SGO_HTTP_RETRY_BASE_MS,
  Math.min(envNumber('SGO_HTTP_RETRY_MAX_MS', 10000), 60000),
);
const SGO_PAGE_FAILURE_COOLDOWN_MS = Math.max(
  0,
  Math.min(envNumber('SGO_PAGE_FAILURE_COOLDOWN_MS', 2500), 30000),
);
const SGO_MAX_CONSECUTIVE_PAGE_FAILURES = Math.max(
  1,
  Math.min(envNumber('SGO_MAX_CONSECUTIVE_PAGE_FAILURES', 6), 20),
);
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Upload Manifest adalah sumber data jamaah paling lengkap: SGO membatasi
// Monitoring Jamaah ke 400 baris dan mengabaikan ?page, sedangkan Upload
// Manifest benar-benar mendukung pagination (sekitar 3.000 jamaah/144 halaman).
const MONITORING_JAMAAH_PATH = '/ops/monitoring-jamaah';
const UPLOAD_DOCUMENTS_PATH = '/ops/upload-documents';
const UPLOAD_DOCUMENTS_SEARCH = String(
  process.env.SGO_UPLOAD_SEARCH ?? 'ORD',
).trim();
const UPLOAD_DOCUMENTS_MAX_PAGES = Math.max(
  1,
  Math.min(envNumber('SGO_UPLOAD_MAX_PAGES', 250), 500),
);

/** Token sesi SGO dari .env, tanpa prefix `sgo_admin_session=`. */
export function getEnvSession() {
  return String(process.env.SGO_ADMIN_SESSION || '')
    .trim()
    .replace(/^sgo_admin_session\s*=\s*/i, '');
}

/** Header Cookie siap pakai dari SGO_ADMIN_SESSION (.env). */
export function getEnvCookieHeader() {
  const session = getEnvSession();
  return session ? `sgo_admin_session=${session}` : '';
}

/** Validasi env + log error yang jelas bila cookie belum diset. */
export function validateSgoEnv() {
  const session = getEnvSession();
  if (!session) {
    console.error(
      '[SGO] ERROR: SGO_ADMIN_SESSION kosong atau tidak ditemukan di .env. ' +
        'Isi SGO_ADMIN_SESSION di .env (atau tempel cookie di UI) sebelum scrape.',
    );
    return false;
  }
  console.log(`[SGO] SGO_ADMIN_SESSION terbaca dari .env (${session.length} karakter).`);
  return true;
}

export const cleanCell = (value = '') => String(value).replace(/\s+/g, ' ').trim();

export function normalizeModulePath(value = '') {
  let raw = cleanCell(value);
  if (!raw) return '';

  // Terima URL lengkap, lalu pertahankan query string (mis. ?tab=perbatch).
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      raw = `${parsed.pathname}${parsed.search}`;
    } catch (error) {
      raw = '';
    }
  }
  if (!raw) return '';

  raw = raw.split('#')[0];
  if (!raw.startsWith('/')) raw = `/${raw}`;

  const queryIndex = raw.indexOf('?');
  const pathname = (
    queryIndex >= 0 ? raw.slice(0, queryIndex) : raw
  ).replace(/\/+$/, '') || '/';
  const query = queryIndex >= 0 ? raw.slice(queryIndex) : '';

  // Samakan variasi underscore (penyebab 404) ke endpoint resmi ber-hyphen.
  const aliases = {
    '/ops/monitoring_jamaah': '/ops/monitoring-jamaah',
    '/ops/upload_documents': '/ops/upload-documents',
    '/ops/travel_docs': '/ops/travel-docs',
    '/ops/stock_perlengkapan': '/ops/stock-perlengkapan',
    '/ops/travel_dokumen_detail': '/ops/travel-dokumen-detail',
    '/ops/approval_dokumen': '/ops/approval-dokumen',
    '/ops/satgas_bandara': '/ops/satgas-bandara',
    '/ops/rahmah_miles': '/ops/rahmah-miles',
    '/ops/nusuk_mutamer': '/ops/nusuk-mutamer',
    '/ops/invoice_manual': '/ops/invoice-manual',
    '/ops/penagihan_aging': '/ops/penagihan-aging',
    '/ops/b2b_rahmah': '/ops/b2b-rahmah',
    '/ops/bus_addon/visa': '/ops/bus-addon/visa',
  };

  const normalizedPath = aliases[pathname.toLowerCase()] || pathname;
  return `${normalizedPath}${query}`;
}

/** Normalisasi + validasi modul terhadap 16 endpoint yang didukung. */
export function resolveSgoModule(value = '') {
  const normalized = normalizeModulePath(value);
  if (!normalized) return '';
  const match = SGO_MODULES.find(
    (module) => module.toLowerCase() === normalized.toLowerCase(),
  );
  if (!match) {
    throw buildError(
      `Modul SGO "${normalized}" tidak didukung. Pilihan: ${SGO_MODULES.join(', ')}.`,
      'SGO_MODULE',
    );
  }
  return match;
}

/**
 * Terima beberapa bentuk input cookie:
 * - token sesi mentah: `a16bd2...`
 * - pasangan lengkap: `sgo_admin_session=a16bd2...`
 * - header lengkap: `foo=bar; sgo_admin_session=a16bd2...`
 */
export function normalizeCookieHeader(value = '') {
  const raw = String(value || '')
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/\s*\r?\n\s*/g, '; ')
    .trim();

  if (!raw) return '';
  if (/(?:^|;\s*)sgo_admin_session\s*=/i.test(raw)) return raw;
  if (/^[A-Za-z0-9_-]{1,40}=/.test(raw)) return raw; // sudah berupa header cookie
  return `sgo_admin_session=${raw}`;
}

export function resolveSgoConfig({ url, cookie, useEnvCookie = false } = {}) {
  // Sesuai kebutuhan produksi: tanpa override, request selalu diarahkan ke
  // SGO Rahmah Grup. Cookie tetap wajib berasal dari .env atau UI.
  const rawUrl = String(
    url || process.env.SGO_BASE_URL || 'https://sgo.rahmahgrup.id',
  ).trim();
  const requestCookie = String(cookie || '').trim();
  const envCookie = getEnvCookieHeader();
  const normalizedRequestCookie = normalizeCookieHeader(requestCookie);
  const cookieHeader = useEnvCookie
    ? envCookie
    : normalizedRequestCookie || envCookie;
  const cookieSource = useEnvCookie || !normalizedRequestCookie ? 'env' : 'request';

  let baseUrl = '';
  let urlError = '';
  if (!rawUrl) {
    urlError = 'URL SGO Admin belum diisi. Set SGO_BASE_URL di .env atau isi Base URL di UI.';
  } else {
    try {
      const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error('protokol harus http/https');
      }
      if (!/^[a-z0-9.-]+$/i.test(parsed.hostname)) {
        throw new Error(`hostname tidak valid: "${parsed.hostname}"`);
      }
      baseUrl = parsed.origin;
    } catch (error) {
      urlError = `URL SGO Admin tidak valid: "${rawUrl}" (${error.message})`;
    }
  }

  const cookieError = cookieHeader
    ? ''
    : 'Cookie sesi SGO belum tersedia. Set SGO_ADMIN_SESSION di .env atau isi Cookie di UI.';

  return {
    baseUrl,
    cookieHeader,
    cookieSource,
    envCookie,
    urlError,
    cookieError,
    ok: !urlError && !cookieError,
  };
}

function maskCookie(cookieHeader = '') {
  const match = String(cookieHeader).match(/sgo_admin_session=([^;]+)/i);
  const token = match ? match[1] : String(cookieHeader);
  // Jangan pernah mencetak potongan token sesi, sekecil apa pun.
  return token ? `terisi (${token.length} char)` : '(kosong)';
}

function looksLikeLoginPage(html = '', finalUrl = '') {
  const hasOrder = SGO_ORDER_RE.test(html);
  if (/\/login(\b|\/|\?|$)/i.test(finalUrl) && !hasOrder) return true;

  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1];
  if (/login|masuk/i.test(title) && !hasOrder) return true;

  // Halaman modul yang valid tidak punya input password. Jika ada dan tidak
  // ada kode order sama sekali, hampir pasti ini halaman login.
  if (/type=["']password["']/i.test(html) && !hasOrder) return true;
  return false;
}

function getCellTexts($, tr) {
  return $(tr)
    .find('th,td')
    .map((_, cell) => cleanCell($(cell).text()))
    .get();
}

/**
 * Nama jamaah pada baris detail SGO ada di:
 * <div style="font-weight:600"><span class="mjg">♀</span><span>NAMA</span></div>
 */
function getSgoPersonName($, tr, fallbackText = '') {
  const nameDiv = $(tr)
    .find('div')
    .filter((_, div) => {
      const style = String($(div).attr('style') || '');
      return /font-weight\s*:\s*600/i.test(style) && $(div).find('span.mjg').length > 0;
    })
    .first();

  if (nameDiv.length) {
    const nameSpan = nameDiv
      .find('span')
      .filter((_, span) => !$(span).hasClass('mjg'))
      .last();
    const name = cleanCell(nameSpan.text());
    if (name) return name;
  }

  const match = String(fallbackText || '').match(/[♂♀]\s*([^💬]+?)(?=💬|$)/);
  return match ? cleanCell(match[1]) : '';
}

function parseSgoMeta(text = '') {
  const raw = cleanCell(text);
  const paketPart = raw.split('🛫')[0].replace(/^🏷️\s*/, '').trim();
  const rtbMatch = paketPart.match(/RTB[-\s]?(\d{1,4})/i);
  const rtb = rtbMatch ? `RTB ${rtbMatch[1]}` : '';
  const paket = paketPart.replace(/RTB[-\s]?\d{1,4}\s*/i, '').trim();
  const keberangkatan = (raw.split('🛫')[1] || '').split('🏨')[0].trim();
  const hotel = (raw.split('🏨')[1] || '').split('🧾')[0].trim();
  const tglOrder = (raw.match(/Order dibuat\s*([0-9]{2}\s+[A-Za-z]{3}\s+[0-9]{4})/i) || ['', ''])[1];
  const closing = (raw.match(/Closing by\s*([A-Za-z .]+)/i) || ['', ''])[1].trim();

  return { rtb, paket, keberangkatan, hotel, tglOrder, closing };
}

function parseSgoPayment(cell = '') {
  const match = String(cell || '').match(/(\d{1,3})\s*%/);
  if (!match) return { persen: '', status: '' };
  const persen = Number(match[1]);
  return {
    persen: `${persen}%`,
    status: persen >= 100 ? 'LUNAS' : persen === 0 ? 'BELUM LUNAS' : `DP ${persen}%`,
  };
}

function parseSgoDocument(cell = '') {
  const match = String(cell || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return { dokumen: '', status: '' };
  return {
    dokumen: `${match[1]}/${match[2]}`,
    status: match[1] === match[2] ? 'LENGKAP' : 'BELUM LENGKAP',
  };
}

/**
 * Parser tabel Monitoring Jamaah SGO Admin.
 *
 * Struktur asli: satu order terdiri dari 1 baris pembuka (1 sel) + beberapa
 * baris jamaah (class mjm-grp-row). Baris jamaah pertama punya 7 sel dan
 * membawa metadata order (RTB, paket, hotel, closing, keuangan), baris
 * berikutnya 4 sel (nama + formulir + edukasi + dokumen).
 */
function extractSgoOrders($) {
  const results = [];

  $('table').each((_, table) => {
    const trs = $(table).find('tr').toArray();
    let current = null;

    const flush = () => {
      if (!current) return;
      if (current.people.length === 0) {
        current = null;
        return;
      }

      for (const person of current.people) {
        const orderCode = current.orderCode;
        const shortMatch = orderCode.match(/(\d{4})$/);
        results.push({
          orderId: orderCode,
          kodeOrder: orderCode,
          orderCode,
          shortCode: shortMatch ? shortMatch[1] : '',
          portalCode: current.portalCode,
          nama: person.nama,
          manifestId: person.manifestId,
          jamaahId: person.manifestId,
          rtb: current.meta.rtb,
          noRtb: current.meta.rtb,
          paket: current.meta.paket,
          keberangkatan: current.meta.keberangkatan,
          hotel: current.meta.hotel,
          tglOrder: current.meta.tglOrder,
          closing: current.meta.closing,
          jumlahJamaah: current.jumlahJamaah,
          pemesan: current.pemesan,
          statusPembayaran: person.statusPembayaran,
          status: person.statusPembayaran,
          dokumen: person.dokumen,
          statusDokumen: person.statusDokumen,
          formulir: person.formulir,
          edukasi: person.edukasi,
          sourceModule: MONITORING_JAMAAH_PATH,
          rawScrapedText: cleanCell(
            `${current.headerText} | ${current.metaText} | ${person.nama}`,
          ).slice(0, 2200),
        });
      }
      current = null;
    };

    for (const tr of trs) {
      const cells = getCellTexts($, tr);
      if (!cells.length) continue;

      const first = cells[0] || '';
      if (cells.length === 1 && SGO_ORDER_RE.test(first)) {
        flush();
        const orderMatch = first.match(SGO_ORDER_RE);
        const orderCode = orderMatch ? orderMatch[0].toUpperCase() : '';
        const portalMatch = first.match(/🔑\s*([A-Z0-9]{4,10})/i);
        const countMatch = first.match(/(\d+)\s*jamaah/i);

        current = {
          orderCode,
          portalCode: portalMatch ? portalMatch[1] : '',
          jumlahJamaah: countMatch ? Number(countMatch[1]) : 0,
          pemesan: first.replace(/^🛒\s*/, '').split('📋')[0].trim(),
          headerText: first,
          metaText: '',
          meta: { rtb: '', paket: '', keberangkatan: '', hotel: '', tglOrder: '', closing: '' },
          keuanganText: '',
          people: [],
        };
        continue;
      }

      if (!current) continue;

      const rowClass = String($(tr).attr('class') || '');
      const isDetailRow =
        /mjm-grp-row|grp-row/i.test(rowClass) ||
        (cells.length >= 4 && /RTB|♂|♀/i.test(first));
      if (!isDetailRow) continue;

      // Baris pertama tiap order membawa metadata + keuangan (7 sel).
      if (cells.length >= 6) {
        current.meta = parseSgoMeta(first);
        current.metaText = first;
        current.keuanganText = cells[2] || '';
      }

      const nama = getSgoPersonName($, tr, first);
      if (!nama) continue;

      // Tombol manifest menyimpan ID jamaah (bukan ID order). ID inilah yang
      // dipakai untuk mengambil NIK/paspor dari form edit manifest.
      const manifestId = cleanCell(
        $(tr).find('[data-mj-open]').first().attr('data-mj-open') || '',
      );

      const payment = parseSgoPayment(current.keuanganText);
      const docCell = cells.length >= 6 ? cells[5] : cells[3] || '';
      const document = parseSgoDocument(docCell);

      current.people.push({
        nama,
        manifestId,
        statusPembayaran: payment.status,
        dokumen: document.dokumen,
        statusDokumen: document.status,
        formulir: cells.length >= 6 ? cells[1] || '' : '',
        edukasi: cells.length >= 6 ? cells[3] || '' : '',
      });
    }

    flush();
  });

  return results;
}

/**
 * Fallback untuk tabel HTML biasa (non-SGO), misalnya hasil paste manual.
 */
function extractGenericTableRows($) {
  const rows = [];
  $('table').each((_, tbl) => {
    const trs = $(tbl).find('tr');
    if (trs.length < 2) return;
    const headers = $(trs[0]).find('th,td').map((__, c) => cleanCell($(c).text()).toLowerCase()).get();
    for (let i = 1; i < trs.length; i++) {
      const cells = $(trs[i]).find('td,th').map((__, c) => cleanCell($(c).text())).get();
      if (cells.length < 2) continue;
      const obj = {};
      headers.forEach((h, idx) => { if (h && cells[idx]) obj[h] = cells[idx]; });
      obj.nama = obj.nama || obj['nama jamaah'] || obj.jamaah || obj['nama lengkap'] || cells.find((c) => /^[A-Z][A-Z\s\.]{4,}$/.test(c)) || cells[1] || cells[0] || '';
      obj.noRtb = obj['no rtb'] || obj.rtb || obj['nomor rtb'] || cells.find((c) => /rtb/i.test(c)) || '';
      obj.paket = obj.paket || obj['nama paket'] || obj.program || '';
      obj.keberangkatan = obj['tgl berangkat'] || obj['tanggal berangkat'] || obj.keberangkatan || '';
      obj.statusPembayaran = obj['status bayar'] || obj['status pembayaran'] || '';
      obj.statusBerangkat = obj['status berangkat'] || obj.status || '';
      if (obj.nama || obj.noRtb) rows.push(obj);
    }
  });
  return rows;
}

export function extractFromHtml(html = '') {
  const $ = cheerio.load(html);
  const sgoRows = extractSgoOrders($);
  if (sgoRows.length > 0) return sgoRows;
  return extractGenericTableRows($);
}

/** Ringkasan halaman modul untuk modul non-jamaah (hotel, stok, dokumen). */
export function extractPageSummary(html = '') {
  const $ = cheerio.load(html);
  const title = cleanCell($('title').first().text());
  const heading =
    cleanCell($('h1').first().text()) || cleanCell($('h2').first().text());
  const stats = [];

  $('.opsdoc-card, .hotel-stat').each((_, el) => {
    const $el = $(el);
    const label = cleanCell(
      $el.find('.opsdoc-card__lbl, .hotel-stat__lbl').first().text(),
    );
    const value = cleanCell(
      $el.find('.opsdoc-card__val, .hotel-stat__val').first().text(),
    );
    if (label && value) stats.push({ label, value });
  });

  const main = $('main').length ? $('main') : $('body');
  const preview = cleanCell(main.text()).slice(0, 600);

  return { title, heading, stats: stats.slice(0, 12), preview };
}

/**
 * Parser Upload Manifest (/ops/upload-documents).
 *
 * Struktur SGO: satu header order (`.opsdoc-grouphd`) diikuti tabel jamaah.
 * Header memuat kode order, RTB/paket/departure, sedangkan baris jamaah
 * memuat nama, ID manifest, progres dokumen (x/6), dan chip KTP/KK/Foto/
 * Paspor/Vaksin. NIK/paspor tidak ada di sini dan diambil lewat manifest.
 */
export function extractUploadDocumentsRows(html = '') {
  const $ = cheerio.load(html);
  const rows = [];

  $('.opsdoc-grouphd').each((_, headerEl) => {
    const $header = $(headerEl);
    const orderCode = cleanCell(
      $header.find('.opsdoc-grouphd__code').first().text(),
    ).toUpperCase();
    if (!orderCode || !SGO_ORDER_RE.test(orderCode)) return;

    const metaSpans = $header
      .find('.opsdoc-grouphd__meta span')
      .map((__, span) => cleanCell($(span).text()))
      .get();
    const packageText = metaSpans.find((text) => /^📦/u.test(text)) || '';
    const pemesanText = metaSpans.find((text) => /^🧍/u.test(text)) || '';
    const departureText = metaSpans.find((text) => /^🗓/u.test(text)) || '';

    const rtbMatch = packageText.match(/RTB[-\s]?(\d{1,4})/i);
    const rtb = rtbMatch ? `RTB ${rtbMatch[1]}` : '';
    const batchMatch = packageText.match(/Batch\s*(\d+)/i);
    const batch = batchMatch ? batchMatch[1] : '';
    const paket = cleanCell(
      packageText
        .replace(/^📦\s*/u, '')
        .replace(/RTB[-\s]?\d{1,4}\s*·?\s*/i, '')
        .replace(/\s*·\s*Batch\s*\d+\s*$/i, '')
        .replace(/^\[CLOSE\]\s*/i, ''),
    );
    const keberangkatan = cleanCell(
      departureText.replace(/^🗓️?\s*/u, '').replace(/^Berangkat\s*/i, ''),
    );
    const pemesan = cleanCell(pemesanText.replace(/^🧍\s*/u, ''));

    const badges = $header
      .find('.opsdoc-grouphd__badges .opsdoc-badge')
      .map((__, badge) => cleanCell($(badge).text()))
      .get();
    const readBadge = (word) => {
      const text = badges.find((badge) => new RegExp(`\\b${word}\\b`, 'i').test(badge)) || '';
      const match = text.match(/(\d+)/);
      return match ? Number(match[1]) : 0;
    };
    const jumlahJamaah = readBadge('Jamaah');
    const orderMissingDocs = readBadge('Missing');
    const orderFilledDocs = readBadge('Terisi');

    const $table = $header.nextUntil('.opsdoc-grouphd').find('table').first();
    if (!$table.length) return;

    $table.find('tr').each((__, tr) => {
      const $tr = $(tr);
      const $cells = $tr.find('td');
      if ($cells.length < 4) return;

      const nameCell = $cells.eq(0);
      const nameDiv = nameCell
        .find('div')
        .filter((___, div) =>
          /font-weight\s*:\s*[67]00/i.test(String($(div).attr('style') || '')),
        )
        .first();
      const rawName = (nameDiv.length ? nameDiv : nameCell.find('div').first()).text();
      const nama = cleanCell(rawName.replace(/[♂♀]/gu, ' '));
      if (!nama || /^nama(?:\s+jamaah)?$/i.test(nama)) return;

      const cellText = cleanCell(nameCell.text());
      const idMatch = cellText.match(/\bID\s*:\s*(\d{3,})/i);
      const editHref =
        $tr.find('a[href*="/monitoring-jamaah/"]').first().attr('href') || '';
      const hrefId =
        (editHref.match(/\/monitoring-jamaah\/(\d+)\/edit/i) || [])[1] || '';
      const manifestId = cleanCell(idMatch ? idMatch[1] : hrefId);

      const docText = cleanCell($cells.eq(2).text());
      const docMatch = docText.match(/(\d+)\s*\/\s*(\d+)/);
      const $chips = $tr.find('.opsdoc-chips .opsdoc-chip');
      const chipOn = $chips.filter('.opsdoc-chip--on').length;
      const chipPending = $chips.filter('.opsdoc-chip--pending').length;
      const totalDocs = $chips.length || (docMatch ? Number(docMatch[2]) : 6);
      const filledDocs = docMatch ? Number(docMatch[1]) : chipOn;
      const statusDokumen =
        totalDocs > 0 && filledDocs >= totalDocs
          ? 'LENGKAP'
          : 'BELUM LENGKAP';
      const dokumen = totalDocs > 0 ? `${filledDocs}/${totalDocs}` : '';
      const dokumenDetail = $chips
        .map((___, chip) => {
          const $chip = $(chip);
          const label = cleanCell($chip.text())
            .replace(/[↑↓🕓⏳✓✔]/gu, '')
            .trim();
          const state = $chip.hasClass('opsdoc-chip--on')
            ? 'ADA'
            : $chip.hasClass('opsdoc-chip--pending')
              ? 'PROSES'
              : 'BELUM';
          return label ? `${label}:${state}` : '';
        })
        .get()
        .filter(Boolean)
        .join(' | ');

      const shortCode = (orderCode.match(/(\d{4,6})$/) || [])[1] || '';
      rows.push({
        orderId: orderCode,
        kodeOrder: orderCode,
        orderCode,
        shortCode,
        orderShort: shortCode,
        nama,
        manifestId,
        jamaahId: manifestId,
        rtb,
        noRtb: rtb,
        paket,
        batch,
        keberangkatan,
        jumlahJamaah,
        pemesan,
        orderMissingDocs,
        orderFilledDocs,
        dokumen,
        statusDokumen,
        dokumenDetail,
        sourceModule: UPLOAD_DOCUMENTS_PATH,
        rawScrapedText: cleanCell(`${orderCode} | ${paket} | ${nama}`).slice(0, 500),
      });
    });
  });

  return rows;
}

/** Ringkasan pagination Upload Manifest tanpa menyimpan data pribadi. */
export function extractUploadPageInfo(html = '') {
  const $ = cheerio.load(html);
  const pageText = cleanCell($('body').text());
  const pageMatch = pageText.match(/Halaman\s+(\d+)\s+dari\s+(\d+)/i);
  const totalMatch = pageText.match(/Total Jamaah\s*:\s*([0-9.]+)/i);
  const nextLink = $('a')
    .filter((_, anchor) => /Berikutnya|Next/i.test($(anchor).text()))
    .first();
  const nextHref = nextLink.length ? nextLink.attr('href') || '' : '';
  const totalPages = pageMatch ? Number(pageMatch[2]) : 0;
  const currentPage = pageMatch ? Number(pageMatch[1]) : 1;

  return {
    currentPage,
    totalPages,
    totalJamaah: totalMatch ? Number(totalMatch[1].replace(/\./g, '')) : 0,
    nextHref,
    hasNext: Boolean(nextHref) || (totalPages > 0 && currentPage < totalPages),
    hasEmptyState: /Tidak ada hasil|Tidak ada jamaah/i.test(pageText),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ekstrak NIK/paspor dari form manifest jamaah SGO.
 * - no_identitas berisi NIK jika identity_type = nik.
 * - no_paspor berisi nomor paspor.
 * - identity_type = kitas/kitap tidak boleh dianggap NIK.
 */
export function extractManifestFields(html = '') {
  const $ = cheerio.load(html);
  const readValue = (name) => {
    const field = $(`[name="${name}"]`).first();
    if (!field.length) return '';
    if (field.is('select')) return cleanCell(field.val() || '');
    const value = field.attr('value');
    if (value !== undefined) return cleanCell(value);
    return cleanCell(field.val() || '');
  };

  const pageOk =
    $('input[name="nama_jamaah"], input[name="no_identitas"], input[name="no_paspor"]')
      .length > 0;
  const identityType = readValue('identity_type').toLowerCase();
  const rawIdentity = readValue('no_identitas');
  const rawPassport = readValue('no_paspor');

  const compactDocument = (value = '') =>
    cleanCell(value).replace(/[\s-]+/g, '').trim();
  const passportNumber = compactDocument(rawPassport).toUpperCase();
  let identityNumber = compactDocument(rawIdentity).toUpperCase();
  if (identityType === 'nik') identityNumber = identityNumber.replace(/\D/g, '');

  let nik = '';
  if (identityType === 'nik') nik = identityNumber;
  else if (!identityType && /^\d{16}$/.test(identityNumber)) nik = identityNumber;

  let passport = passportNumber;
  if (!passport && identityType === 'paspor') passport = identityNumber;

  return {
    pageOk,
    manifestNama: readValue('nama_jamaah'),
    identityType,
    nik,
    passport,
    paspor: passport,
    noPaspor: passport,
    noHp: readValue('no_hp'),
    tempatLahir: readValue('tempat_lahir'),
    tanggalLahir: readValue('tanggal_lahir'),
    kotaPaspor: readValue('kota_paspor'),
    tanggalExpiredPaspor: readValue('tanggal_expired'),
    alamat: readValue('alamat'),
    namaAyah: readValue('nama_ayah'),
  };
}

async function fetchManifestFields(manifestId, config) {
  const id = cleanCell(manifestId);
  if (!id) {
    throw buildError('ID manifest jamaah kosong.', 'SGO_MANIFEST_ID');
  }

  const cached = manifestFieldCache.get(id);
  if (cached && Date.now() - cached.fetchedAt <= MANIFEST_CACHE_TTL_MS) {
    return { fields: cached.fields, cached: true };
  }

  const targetUrl = `${config.baseUrl}/ops/monitoring-jamaah/${encodeURIComponent(id)}/edit?embed=1`;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          ...SGO_BROWSER_HEADERS,
          // Wajib: setiap request ke SGO membawa sesi admin.
          Cookie: config.cookieHeader,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
      const html = await response.text();

      if (looksLikeLoginPage(html, response.url || targetUrl)) {
        throw buildError(
          'Sesi login habis saat mengambil manifest jamaah. Perbarui SGO_ADMIN_SESSION.',
          'SGO_AUTH',
          { manifestId: id },
        );
      }
      if (!response.ok) {
        throw buildError(
          `Manifest ${id} mengembalikan HTTP ${response.status}.`,
          'SGO_HTTP',
          { manifestId: id, status: response.status },
        );
      }

      const fields = extractManifestFields(html);
      if (!fields.pageOk) {
        throw buildError(
          `Halaman manifest ${id} tidak dikenali.`,
          'SGO_MANIFEST_PARSE',
          { manifestId: id },
        );
      }

      manifestFieldCache.set(id, { fields, fetchedAt: Date.now() });
      return { fields, cached: false };
    } catch (error) {
      lastError = error;
      if (error?.code === 'SGO_AUTH') break;
      if (attempt === 0) await delay(250);
    }
  }

  throw lastError || buildError(`Gagal mengambil manifest ${id}.`, 'SGO_MANIFEST');
}

async function mapWithConcurrency(items = [], limit = 1, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, list.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= list.length) return;
        results[index] = await worker(list[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Lengkapi setiap baris jamaah dengan NIK/paspor dari halaman manifest.
 * Hanya baris yang punya manifestId yang di-fetch. Kegagalan satu manifest
 * tidak menggagalkan scrape; field lama (jika ada) dipertahankan oleh store.
 */
export async function enrichJamaahWithManifest(rows = [], config, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const log = options.log !== false;
  const concurrency = Math.max(
    1,
    Math.min(Number(options.concurrency) || MANIFEST_CONCURRENCY, 20),
  );
  const configuredMax = Number.isFinite(Number(options.max))
    ? Number(options.max)
    : MANIFEST_MAX_ENRICH;
  const maxRows = Math.max(0, Math.min(configuredMax, 10000));
  const stats = {
    total: list.length,
    eligible: 0,
    selected: 0,
    limited: 0,
    fetched: 0,
    cacheHits: 0,
    failed: 0,
    skipped: 0,
    withNik: 0,
    withPassport: 0,
    withBoth: 0,
    ms: 0,
  };

  for (const row of list) {
    if (row && typeof row === 'object') row.manifestFetched = false;
  }

  const eligible = list.filter((row) => row && cleanCell(row.manifestId));
  stats.eligible = eligible.length;
  const selected = eligible.slice(0, maxRows);
  stats.selected = selected.length;
  stats.limited = Math.max(0, eligible.length - selected.length);
  if (!eligible.length) {
    if (log && list.length) {
      console.warn(
        '[SGO] Manifest tidak bisa diperkaya: tidak ada data-mj-open pada baris jamaah.',
      );
    }
    return { rows: list, stats };
  }

  if (!selected.length) {
    if (log) {
      console.warn(
        `[SGO] Manifest dilewati: SGO_MANIFEST_MAX=${maxRows} membatasi enrichment.`,
      );
    }
    return { rows: list, stats };
  }

  if (!config?.baseUrl || !config?.cookieHeader) {
    stats.failed = selected.length;
    if (log) {
      console.warn('[SGO] Manifest dilewati: konfigurasi URL/cookie SGO tidak lengkap.');
    }
    return { rows: list, stats };
  }

  const started = Date.now();
  let done = 0;
  let authError = null;
  if (log) {
    console.log(
      `[SGO] Mengambil NIK/paspor dari ${selected.length}/${eligible.length} manifest jamaah ` +
        `(concurrency ${concurrency})...`,
    );
  }

  await mapWithConcurrency(selected, concurrency, async (row) => {
    if (authError) {
      stats.skipped += 1;
      done += 1;
      return;
    }

    try {
      const result = await fetchManifestFields(row.manifestId, config);
      const fields = result.fields;
      row.manifestFetched = true;
      if (result.cached) stats.cacheHits += 1;
      else stats.fetched += 1;

      if (fields.nik) {
        row.nik = fields.nik;
        row.ktp = row.ktp || fields.nik;
      }
      if (fields.passport) {
        row.passport = fields.passport;
        row.paspor = fields.passport;
        row.noPaspor = fields.passport;
      }
      if (fields.identityType) row.identityType = fields.identityType;
      if (fields.noHp && !row.noHp) row.noHp = fields.noHp;
      if (fields.tempatLahir && !row.tempatLahir) row.tempatLahir = fields.tempatLahir;
      if (fields.tanggalLahir && !row.tanggalLahir) row.tanggalLahir = fields.tanggalLahir;
      if (fields.kotaPaspor && !row.kotaPaspor) row.kotaPaspor = fields.kotaPaspor;
      if (fields.tanggalExpiredPaspor && !row.tanggalExpiredPaspor) {
        row.tanggalExpiredPaspor = fields.tanggalExpiredPaspor;
      }
    } catch (error) {
      stats.failed += 1;
      if (error?.code === 'SGO_AUTH') authError = error;
      if (stats.failed <= 5) {
        console.warn(
          `[SGO] Manifest ${row.manifestId} gagal (${error?.code || 'SGO_MANIFEST'}): ${error.message}`,
        );
      }
    } finally {
      done += 1;
      if (log && (done % 50 === 0 || done === selected.length)) {
        console.log(
          `[SGO] Progress manifest ${done}/${selected.length} | OK ${stats.fetched + stats.cacheHits} | gagal ${stats.failed}`,
        );
      }
    }
  });

  for (const row of list) {
    if (!row) continue;
    const nik = cleanCell(row.nik || row.ktp || '');
    const passport = cleanCell(
      row.passport || row.paspor || row.noPaspor || row.nomorPaspor || '',
    );
    if (nik) stats.withNik += 1;
    if (passport) stats.withPassport += 1;
    if (nik && passport) stats.withBoth += 1;
  }
  stats.ms = Date.now() - started;

  if (authError) {
    console.error(`[SGO] Enrichment manifest dihentikan: ${authError.message}`);
  }
  if (log) {
    console.log(
      `[SGO] Manifest selesai: ${stats.fetched} fetch + ${stats.cacheHits} cache = ` +
        `${stats.fetched + stats.cacheHits}/${stats.selected} OK | ${stats.failed} gagal | ` +
        `${stats.limited} dilewati batas | ` +
        `NIK ${stats.withNik}/${stats.total} | Paspor ${stats.withPassport}/${stats.total} | ` +
        `${stats.ms}ms`,
    );
  }

  return { rows: list, stats, authError };
}

/**
 * Hanya simpan baris yang benar-benar data jamaah/order.
 * Baris kartu kontak, navigasi, atau tabel non-jamaah dibuang.
 */
export function isCleanJamaahRow(row = {}) {
  const nama = cleanCell(row.nama || row.name || '');
  if (!nama || nama.length < 3) return false;
  if (/[✉📱@]|https?:\/\/|WA Jamaah|WA Pemesan|Login Portal|Invoice|Worksheet|Feedback/i.test(nama)) return false;

  const hasOrder = Boolean(row.orderCode || row.orderId || row.kodeOrder || row.shortCode || row.orderShort);
  return hasOrder;
}

function jamaahRowKey(row = {}) {
  return [
    row.orderCode || row.orderId || row.kodeOrder || '',
    row.nama || '',
    row.rtb || row.noRtb || '',
  ]
    .join('|')
    .toLowerCase()
    .trim();
}

export function dedupeJamaahRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = jamaahRowKey(row);
    if (!key.replace(/\|/g, '').trim()) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedJamaahName(value = '') {
  return cleanCell(value)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedJamaahOrder(value = '') {
  return cleanCell(value).toUpperCase().replace(/\s+/g, '');
}

function rtbNumberOf(value = '') {
  const match = String(value || '').match(/\d{1,4}/);
  if (!match) return '';
  return String(Number(match[0]));
}

function jamaahIdentityKeys(row = {}) {
  const keys = [];
  const manifestId = cleanCell(row.manifestId || row.jamaahId || '');
  if (manifestId) keys.push(`m:${manifestId}`);

  const order = normalizedJamaahOrder(
    row.orderCode || row.orderId || row.kodeOrder || '',
  );
  const nama = normalizedJamaahName(row.nama || row.name || '');
  if (order && nama) keys.push(`o:${order}|${nama}`);

  // RTB+name hanya fallback saat order tidak tersedia. Ini mencegah dua orang
  // berbeda dengan nama sama dalam satu RTB ikut tergabung.
  const rtb = rtbNumberOf(row.rtb || row.noRtb || '');
  if (!order && rtb && nama) keys.push(`r:${rtb}|${nama}`);
  return keys;
}

function mergeMissingJamaahFields(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null || value === '') continue;
    const current = target[key];
    if (current === undefined || current === null || current === '') {
      target[key] = value;
      continue;
    }
    if (
      typeof current === 'number' &&
      current === 0 &&
      typeof value === 'number' &&
      value > 0
    ) {
      target[key] = value;
    }
  }
}

/**
 * Gabungkan baris dari beberapa sumber (Monitoring Jamaah + Upload Manifest).
 * Baris pertama menang untuk field yang sudah terisi; field kosong diisi dari
 * baris berikutnya. Pencocokan memakai manifestId, lalu kode order + nama.
 */
export function mergeJamaahRows(rows = []) {
  const merged = [];
  const index = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const keys = jamaahIdentityKeys(row);
    let target = null;
    for (const key of keys) {
      if (index.has(key)) {
        target = index.get(key);
        break;
      }
    }

    if (!target) {
      target = { ...row };
      merged.push(target);
    } else {
      mergeMissingJamaahFields(target, row);
    }

    for (const key of [...keys, ...jamaahIdentityKeys(target)]) {
      index.set(key, target);
    }
  }

  return merged;
}

/**
 * Bangun URL halaman SGO. Halaman 1 memakai URL asli tanpa parameter agar
 * perilakunya identik dengan scrape lama; halaman berikutnya menambahkan
 * `?page=N` (nama parameter bisa diatur lewat SGO_PAGE_PARAM).
 */
export function buildSgoPageUrl(baseUrl, modulePath, page = 1) {
  const normalizedPath = normalizeModulePath(modulePath);
  if (!Number.isFinite(Number(page)) || Number(page) <= 1) {
    return `${baseUrl}${normalizedPath}`;
  }

  const pageNumber = Math.trunc(Number(page));
  try {
    const url = new URL(`${baseUrl}${normalizedPath}`);
    url.searchParams.set(PAGINATION_PAGE_PARAM, String(pageNumber));
    return url.toString();
  } catch (error) {
    const joiner = normalizedPath.includes('?') ? '&' : '?';
    return (
      `${baseUrl}${normalizedPath}${joiner}` +
      `${encodeURIComponent(PAGINATION_PAGE_PARAM)}=${pageNumber}`
    );
  }
}

/**
 * URL Upload Manifest. `search=ORD` wajib dipakai agar SGO menampilkan
 * seluruh order (bukan hanya hasil default) dan pagination tetap konsisten.
 */
export function buildUploadDocumentsUrl(baseUrl, page = 1) {
  const url = new URL(`${baseUrl}${UPLOAD_DOCUMENTS_PATH}`);
  if (UPLOAD_DOCUMENTS_SEARCH) {
    url.searchParams.set('search', UPLOAD_DOCUMENTS_SEARCH);
  }
  const pageNumber = Math.trunc(Number(page) || 1);
  if (pageNumber > 1) {
    url.searchParams.set(PAGINATION_PAGE_PARAM, String(pageNumber));
  }
  return url.toString();
}

function buildError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function isRetryableSgoError(error) {
  if (!error) return false;
  if (error.code === 'SGO_NETWORK') return true;
  if (error.code === 'SGO_HTTP') {
    return RETRYABLE_HTTP_STATUS.has(Number(error.status));
  }
  return false;
}

function retryWaitMs(attempt, error) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, SGO_HTTP_RETRY_MAX_MS);
  }
  const backoff = SGO_HTTP_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(backoff + jitter, SGO_HTTP_RETRY_MAX_MS);
}

/**
 * Request satu halaman HTML ke SGO dengan Cookie eksplisit.
 * Error transien (timeout, HTTP 500/502/503/504/429) di-retry dengan
 * exponential backoff agar pagination tidak terputus di tengah jalan.
 * Error auth tidak di-retry karena cookie harus diperbarui manual.
 */
async function fetchSgoHtml(targetUrl, config, options = {}) {
  const { modulePath = '', page = 1, persistRawPage = false } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= SGO_HTTP_RETRY_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    let response;

    try {
      response = await fetch(targetUrl, {
        headers: {
          ...SGO_BROWSER_HEADERS,
          // Wajib: setiap request ke SGO membawa sesi admin.
          Cookie: config.cookieHeader,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = error?.cause?.code || error?.cause?.message || '';
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const reason = isTimeout
        ? `Timeout ${REQUEST_TIMEOUT_MS}ms`
        : `${error.message || 'fetch failed'}${cause ? ` (${cause})` : ''}`;
      const wrapped = buildError(
        `Request ${modulePath || targetUrl} gagal: ${reason}`,
        'SGO_NETWORK',
        { modulePath, targetUrl, page },
      );
      lastError = wrapped;

      if (attempt < SGO_HTTP_RETRY_ATTEMPTS && isRetryableSgoError(wrapped)) {
        const waitMs = retryWaitMs(attempt, wrapped);
        console.warn(
          `[SGO Retry] ${modulePath || targetUrl} hal. ${page} gagal ` +
            `(${wrapped.code}) attempt ${attempt}/${SGO_HTTP_RETRY_ATTEMPTS}. ` +
            `Coba lagi dalam ${waitMs}ms...`,
        );
        await delay(waitMs);
        continue;
      }

      if (persistRawPage) {
        saveSgoRawError({
          modulePath,
          code: wrapped.code,
          message: wrapped.message,
          targetUrl,
          ms: Date.now() - started,
        });
      }
      throw wrapped;
    }

    let html;
    try {
      html = await response.text();
    } catch (error) {
      const wrapped = buildError(
        `Membaca respons ${modulePath || targetUrl} gagal: ${error.message || error}`,
        'SGO_NETWORK',
        { modulePath, targetUrl, page },
      );
      lastError = wrapped;

      if (attempt < SGO_HTTP_RETRY_ATTEMPTS && isRetryableSgoError(wrapped)) {
        const waitMs = retryWaitMs(attempt, wrapped);
        console.warn(
          `[SGO Retry] ${modulePath || targetUrl} hal. ${page} gagal membaca body ` +
            `attempt ${attempt}/${SGO_HTTP_RETRY_ATTEMPTS}. Coba lagi dalam ${waitMs}ms...`,
        );
        await delay(waitMs);
        continue;
      }

      if (persistRawPage) {
        saveSgoRawError({
          modulePath,
          code: wrapped.code,
          message: wrapped.message,
          targetUrl,
          ms: Date.now() - started,
        });
      }
      throw wrapped;
    }

    const finalUrl = response.url || targetUrl;
    const contentType = response.headers.get('content-type') || 'text/html';

    if (looksLikeLoginPage(html, finalUrl)) {
      const authError = buildError(
        `Cookie kedaluwarsa / sesi login habis saat mengakses ${modulePath || targetUrl}. Perbarui SGO_ADMIN_SESSION di .env.`,
        'SGO_AUTH',
        { modulePath, targetUrl, page, status: response.status },
      );
      if (persistRawPage) {
        saveSgoRawError({
          modulePath,
          code: authError.code,
          message: authError.message,
          status: response.status,
          targetUrl,
          finalUrl,
          ms: Date.now() - started,
        });
      }
      throw authError;
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const httpError = buildError(
        `Modul ${modulePath || targetUrl} mengembalikan HTTP ${response.status}.`,
        'SGO_HTTP',
        {
          modulePath,
          targetUrl,
          page,
          status: response.status,
          retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0,
        },
      );
      lastError = httpError;

      if (attempt < SGO_HTTP_RETRY_ATTEMPTS && isRetryableSgoError(httpError)) {
        const waitMs = retryWaitMs(attempt, httpError);
        console.warn(
          `[SGO Retry] ${modulePath || targetUrl} hal. ${page} HTTP ${response.status} ` +
            `attempt ${attempt}/${SGO_HTTP_RETRY_ATTEMPTS}. Coba lagi dalam ${waitMs}ms...`,
        );
        await delay(waitMs);
        continue;
      }

      if (persistRawPage) {
        saveSgoRawError({
          modulePath,
          code: httpError.code,
          message: httpError.message,
          status: response.status,
          targetUrl,
          finalUrl,
          ms: Date.now() - started,
        });
      }
      throw httpError;
    }

    return {
      response,
      html,
      finalUrl,
      contentType,
      started,
      ms: Date.now() - started,
    };
  }

  throw (
    lastError ||
    buildError(
      `Request ${modulePath || targetUrl} gagal setelah ${SGO_HTTP_RETRY_ATTEMPTS} percobaan.`,
      'SGO_NETWORK',
      { modulePath, targetUrl, page },
    )
  );
}

/**
 * Ambil satu modul SGO dengan header Cookie eksplisit.
 */
export async function fetchSgoModule(modulePath, config, options = {}) {
  const normalizedPath = normalizeModulePath(modulePath);
  const { page = 1, persistRaw = true } = options;
  const persistRawPage = Boolean(persistRaw && Number(page) <= 1);
  const targetUrl = buildSgoPageUrl(config.baseUrl, normalizedPath, page);
  const { response, html, finalUrl, contentType, ms } = await fetchSgoHtml(
    targetUrl,
    config,
    { modulePath: normalizedPath, page, persistRawPage },
  );

  const rows = extractFromHtml(html).filter(isCleanJamaahRow);
  const summary = extractPageSummary(html);
  const pageOk = html.length > 500;
  const fetchedAt = new Date().toISOString();

  // Persistensikan HTML asli hanya untuk halaman pertama lima modul yang
  // diminta. Halaman pagination berikutnya tidak menimpa raw page 1.
  if (persistRawPage && isPersistedSgoModule(normalizedPath)) {
    saveSgoRawResponse({
      modulePath: normalizedPath,
      targetUrl,
      finalUrl,
      status: response.status,
      contentType,
      html,
      pageOk,
      rowsCount: rows.length,
      summary,
      fetchedAt,
      ms,
    });
  }

  return {
    modulePath: normalizedPath,
    page: Number(page) || 1,
    targetUrl,
    finalUrl,
    status: response.status,
    contentType,
    fetchedAt,
    htmlLength: html.length,
    htmlHash: createHash('sha1').update(html).digest('hex'),
    pageOk,
    rows,
    summary,
    ms,
  };
}

/**
 * Ambil modul sumber jamaah dari halaman 1 sampai halaman terakhir.
 *
 * Halaman 1 memakai URL asli (tanpa `page`) agar perilaku dan raw response
 * tetap sama. Halaman 2+ diminta berurutan dengan jeda `SGO_PAGINATION_DELAY_MS`.
 * Loop berhenti saat halaman kosong, HTML/baris berulang, error, atau batas
 * `SGO_PAGINATION_MAX_PAGES` tercapai. Semua baris digabung dan di-dedupe.
 */
export async function fetchSgoModulePaginated(modulePath, config, options = {}) {
  const normalizedPath = normalizeModulePath(modulePath);
  const { persistRaw = true } = options;
  const started = Date.now();
  console.log(`[SGO] Scraping page 1... (${normalizedPath})`);
  const firstPage = await fetchSgoModule(normalizedPath, config, {
    page: 1,
    persistRaw,
  });

  const pagination = {
    enabled: PAGINATION_ENABLED,
    pageParam: PAGINATION_PAGE_PARAM,
    delayMs: PAGINATION_DELAY_MS,
    maxPages: PAGINATION_MAX_PAGES,
    pagesFetched: 1,
    pagesWithRows: firstPage.rows.length ? 1 : 0,
    rowsOnFirstPage: firstPage.rows.length,
    rows: 0,
    stopReason: 'single-page',
    errors: [],
    ms: 0,
  };

  const seenKeys = new Set();
  const seenHashes = new Set([firstPage.htmlHash]);
  const combinedRows = [];

  const addPageRows = (rows = []) => {
    let added = 0;
    for (const row of rows) {
      const key = jamaahRowKey(row);
      if (!key.replace(/\|/g, '').trim()) continue;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      combinedRows.push(row);
      added += 1;
    }
    return added;
  };

  addPageRows(firstPage.rows);

  const finish = (stopReason) => {
    pagination.stopReason = stopReason;
    pagination.rows = combinedRows.length;
    pagination.ms = Date.now() - started;
    return pagination;
  };

  if (!PAGINATION_ENABLED) {
    return { ...firstPage, rows: combinedRows, pagination: finish('disabled') };
  }

  if (PAGINATION_MAX_PAGES <= 1) {
    return { ...firstPage, rows: combinedRows, pagination: finish('max-pages') };
  }

  if (!firstPage.rows.length) {
    return {
      ...firstPage,
      rows: combinedRows,
      pagination: finish('page-1-empty'),
    };
  }

  let lastPage = firstPage;
  let stopReason = 'max-pages';
  let page = 2;

  while (page <= PAGINATION_MAX_PAGES) {
    if (PAGINATION_DELAY_MS > 0) await delay(PAGINATION_DELAY_MS);
    console.log(`[SGO] Scraping page ${page}... (${normalizedPath})`);

    let currentPage;
    try {
      currentPage = await fetchSgoModule(normalizedPath, config, {
        page,
        persistRaw: false,
      });
    } catch (error) {
      stopReason = error?.code === 'SGO_AUTH' ? 'auth-error' : 'fetch-error';
      pagination.errors.push({
        page,
        code: error?.code || 'SGO_ERROR',
        status: error?.status || 0,
        message: error?.message || String(error),
      });
      console.warn(
        `[SGO Pagination] ${normalizedPath} halaman ${page} gagal ` +
          `(${error?.code || 'SGO_ERROR'}): ${error?.message || error}`,
      );
      break;
    }

    pagination.pagesFetched += 1;
    lastPage = currentPage;

    if (!currentPage.pageOk) {
      stopReason = 'page-not-ok';
      break;
    }

    // Server yang mengabaikan parameter `page` akan mengembalikan HTML identik.
    if (seenHashes.has(currentPage.htmlHash)) {
      stopReason = 'duplicate-page';
      break;
    }
    seenHashes.add(currentPage.htmlHash);

    if (!currentPage.rows.length) {
      stopReason = 'empty-page';
      break;
    }

    pagination.pagesWithRows += 1;
    const added = addPageRows(currentPage.rows);
    if (added === 0) {
      stopReason = 'no-new-rows';
      break;
    }

    console.log(
      `[SGO Pagination] ${normalizedPath} halaman ${page}: +${added} jamaah baru ` +
        `(total ${combinedRows.length}).`,
    );
    page += 1;
  }

  const stats = finish(stopReason);
  console.log(
    `[SGO Pagination] ${normalizedPath}: ${stats.pagesFetched} halaman diminta, ` +
      `${stats.pagesWithRows} berisi data, ${stats.rows} jamaah unik ` +
      `(${stats.ms}ms, stop=${stats.stopReason}).`,
  );

  return {
    ...firstPage,
    finalUrl: lastPage.finalUrl,
    fetchedAt: lastPage.fetchedAt,
    rows: combinedRows,
    pagination: stats,
    ms: Date.now() - started,
  };
}

/**
 * Ambil satu halaman Upload Manifest dan parsing baris jamaahnya.
 */
export async function fetchUploadDocumentsPage(config, page = 1, options = {}) {
  const pageNumber = Math.max(1, Math.trunc(Number(page) || 1));
  const targetUrl = buildUploadDocumentsUrl(config.baseUrl, pageNumber);
  const persistRawPage = Boolean(options.persistRaw && pageNumber === 1);
  const { response, html, finalUrl, contentType, ms } = await fetchSgoHtml(
    targetUrl,
    config,
    {
      modulePath: UPLOAD_DOCUMENTS_PATH,
      page: pageNumber,
      persistRawPage,
    },
  );

  const rows = extractUploadDocumentsRows(html).filter(isCleanJamaahRow);
  const summary = extractPageSummary(html);
  const pageInfo = extractUploadPageInfo(html);
  const pageOk = html.length > 500;
  const fetchedAt = new Date().toISOString();

  if (persistRawPage && isPersistedSgoModule(UPLOAD_DOCUMENTS_PATH)) {
    saveSgoRawResponse({
      modulePath: UPLOAD_DOCUMENTS_PATH,
      targetUrl,
      finalUrl,
      status: response.status,
      contentType,
      html,
      pageOk,
      rowsCount: rows.length,
      summary,
      fetchedAt,
      ms,
    });
  }

  return {
    modulePath: UPLOAD_DOCUMENTS_PATH,
    page: pageNumber,
    targetUrl,
    finalUrl,
    status: response.status,
    contentType,
    fetchedAt,
    htmlLength: html.length,
    htmlHash: createHash('sha1').update(html).digest('hex'),
    pageOk,
    rows,
    summary,
    pageInfo,
    ms,
  };
}

/**
 * Full multi-page auto-pagination untuk Upload Manifest.
 *
 * Ketahanan:
 * - retry/backoff per request ditangani `fetchSgoHtml` (HTTP 500/502/503/504/429/timeout),
 * - halaman yang tetap gagal dicatat lalu dilewati, bukan menghentikan seluruh siklus,
 * - setelah loop utama, halaman yang gagal dicoba ulang (recovery pass),
 * - loop berhenti saat halaman terakhir yang dilaporkan SGO tercapai, bukan saat satu
 *   request kebetulan gagal.
 */
export async function fetchUploadDocumentsPaginated(config, options = {}) {
  const started = Date.now();
  const maxPages = Math.max(
    1,
    Math.min(
      Number(options.maxPages) || UPLOAD_DOCUMENTS_MAX_PAGES,
      500,
    ),
  );
  const effectiveMaxPages = PAGINATION_ENABLED ? maxPages : 1;
  const stats = {
    enabled: PAGINATION_ENABLED,
    mode: 'upload-documents',
    search: UPLOAD_DOCUMENTS_SEARCH,
    pageParam: PAGINATION_PAGE_PARAM,
    delayMs: PAGINATION_DELAY_MS,
    maxPages: effectiveMaxPages,
    retryAttempts: SGO_HTTP_RETRY_ATTEMPTS,
    retryBaseMs: SGO_HTTP_RETRY_BASE_MS,
    failureCooldownMs: SGO_PAGE_FAILURE_COOLDOWN_MS,
    pagesFetched: 0,
    pagesWithRows: 0,
    rowsOnFirstPage: 0,
    rows: 0,
    totalJamaahReported: 0,
    totalPagesReported: 0,
    failedPages: [],
    recoveredPages: 0,
    unrecoveredPages: [],
    stopReason: 'max-pages',
    errors: [],
    ms: 0,
  };

  const combined = [];
  const seen = new Set();
  const seenHashes = new Set();
  let firstPage = null;
  let lastPage = null;
  let page = 1;
  let stopReason = 'max-pages';
  let consecutiveFailures = 0;

  const ingestPage = (current) => {
    let added = 0;
    for (const row of current.rows) {
      const identity = cleanCell(row.manifestId)
        ? `m:${row.manifestId}`
        : jamaahRowKey(row);
      if (!identity.replace(/\|/g, '').trim()) continue;
      if (seen.has(identity)) continue;
      seen.add(identity);
      combined.push(row);
      added += 1;
    }
    stats.rows = combined.length;
    return added;
  };

  const recordFailure = (pageNumber, error, phase = 'pagination') => {
    stats.errors.push({
      page: pageNumber,
      phase,
      code: error?.code || 'SGO_ERROR',
      status: error?.status || 0,
      message: error?.message || String(error),
    });
  };

  const noteFailedPage = (pageNumber) => {
    if (!stats.failedPages.includes(pageNumber)) {
      stats.failedPages.push(pageNumber);
    }
  };

  while (page <= effectiveMaxPages) {
    if (page > 1 && PAGINATION_DELAY_MS > 0) {
      await delay(PAGINATION_DELAY_MS);
    }
    const searchLabel = UPLOAD_DOCUMENTS_SEARCH
      ? `?search=${UPLOAD_DOCUMENTS_SEARCH}`
      : '';
    console.log(
      `[SGO] Scraping page ${page}... (${UPLOAD_DOCUMENTS_PATH}${searchLabel})`,
    );

    let current;
    try {
      current = await fetchUploadDocumentsPage(config, page, {
        persistRaw: options.persistRaw !== false,
      });
    } catch (error) {
      recordFailure(page, error, 'pagination');
      console.warn(
        `[SGO Upload] Halaman ${page} gagal ` +
          `(${error?.code || 'SGO_ERROR'}): ${error?.message || error}. ` +
          `Melanjutkan ke halaman berikutnya...`,
      );

      if (error?.code === 'SGO_AUTH') {
        stopReason = 'auth-error';
        break;
      }

      noteFailedPage(page);
      consecutiveFailures += 1;

      if (consecutiveFailures >= SGO_MAX_CONSECUTIVE_PAGE_FAILURES) {
        stopReason = 'fetch-error';
        console.error(
          `[SGO Upload] ${consecutiveFailures} halaman berturut-turut gagal; ` +
            `siklus dijeda agar server SGO tidak dibanjiri.`,
        );
        break;
      }

      if (stats.totalPagesReported && page >= stats.totalPagesReported) {
        stopReason = 'last-page';
        break;
      }

      if (SGO_PAGE_FAILURE_COOLDOWN_MS > 0) {
        await delay(SGO_PAGE_FAILURE_COOLDOWN_MS);
      }
      page += 1;
      continue;
    }

    consecutiveFailures = 0;
    if (!firstPage) firstPage = current;
    lastPage = current;
    stats.pagesFetched += 1;
    stats.totalJamaahReported =
      current.pageInfo.totalJamaah || stats.totalJamaahReported;
    stats.totalPagesReported =
      current.pageInfo.totalPages || stats.totalPagesReported;

    if (!current.pageOk) {
      recordFailure(
        page,
        buildError(
          `Halaman ${page} tidak valid (${current.htmlLength} byte).`,
          'SGO_PAGE_INVALID',
        ),
        'pagination',
      );
      noteFailedPage(page);
      consecutiveFailures += 1;
      if (consecutiveFailures >= SGO_MAX_CONSECUTIVE_PAGE_FAILURES) {
        stopReason = 'page-not-ok';
        break;
      }
      if (stats.totalPagesReported && page >= stats.totalPagesReported) {
        stopReason = 'last-page';
        break;
      }
      if (SGO_PAGE_FAILURE_COOLDOWN_MS > 0) {
        await delay(SGO_PAGE_FAILURE_COOLDOWN_MS);
      }
      page += 1;
      continue;
    }

    // Server yang mengabaikan parameter `page` akan mengembalikan HTML identik.
    // Jangan langsung menghentikan seluruh scrape; catat lalu lanjutkan.
    if (seenHashes.has(current.htmlHash)) {
      recordFailure(
        page,
        buildError(
          `Halaman ${page} mengulang HTML halaman sebelumnya.`,
          'SGO_DUPLICATE_PAGE',
        ),
        'pagination',
      );
      noteFailedPage(page);
      consecutiveFailures += 1;
      if (consecutiveFailures >= SGO_MAX_CONSECUTIVE_PAGE_FAILURES) {
        stopReason = 'duplicate-page';
        break;
      }
      if (stats.totalPagesReported && page >= stats.totalPagesReported) {
        stopReason = 'last-page';
        break;
      }
      if (SGO_PAGE_FAILURE_COOLDOWN_MS > 0) {
        await delay(SGO_PAGE_FAILURE_COOLDOWN_MS);
      }
      page += 1;
      continue;
    }
    seenHashes.add(current.htmlHash);

    if (!current.rows.length) {
      const expectedMore =
        stats.totalPagesReported && page < stats.totalPagesReported;

      // Halaman kosong di tengah pagination biasanya respons transien SGO.
      // Catat sebagai gap dan lanjut ke halaman berikutnya.
      if (expectedMore) {
        recordFailure(
          page,
          buildError(
            `Halaman ${page} kosong padahal SGO melaporkan ${stats.totalPagesReported} halaman.`,
            'SGO_EMPTY_PAGE',
          ),
          'pagination',
        );
        noteFailedPage(page);
        consecutiveFailures += 1;
        if (consecutiveFailures >= SGO_MAX_CONSECUTIVE_PAGE_FAILURES) {
          stopReason = 'empty-page';
          break;
        }
        if (SGO_PAGE_FAILURE_COOLDOWN_MS > 0) {
          await delay(SGO_PAGE_FAILURE_COOLDOWN_MS);
        }
        page += 1;
        continue;
      }

      stopReason = current.pageInfo.hasEmptyState ? 'no-results' : 'empty-page';
      break;
    }

    stats.pagesWithRows += 1;
    if (page === 1) stats.rowsOnFirstPage = current.rows.length;

    const added = ingestPage(current);
    console.log(
      `[SGO] Scraping page ${page} selesai: +${added} jamaah ` +
        `(total ${combined.length}).`,
    );

    if (stats.totalPagesReported && page >= stats.totalPagesReported) {
      stopReason = 'last-page';
      break;
    }

    // Jika SGO melaporkan masih ada halaman berikutnya, teruskan meskipun
    // tautan "Berikutnya" tidak terdeteksi pada HTML halaman ini.
    if (
      !current.pageInfo.hasNext &&
      !(stats.totalPagesReported && page < stats.totalPagesReported)
    ) {
      stopReason = 'no-next-page';
      break;
    }

    page += 1;
  }

  // Recovery pass: halaman yang gagal di loop utama dicoba ulang setelah jeda.
  // Baris yang berhasil dipulihkan digabung tanpa duplikasi.
  if (stopReason !== 'auth-error' && stats.failedPages.length) {
    for (const failedPage of [...stats.failedPages]) {
      if (SGO_PAGE_FAILURE_COOLDOWN_MS > 0) {
        await delay(SGO_PAGE_FAILURE_COOLDOWN_MS);
      }
      console.log(`[SGO Upload] Recovery halaman ${failedPage}...`);

      try {
        const recovered = await fetchUploadDocumentsPage(config, failedPage, {
          persistRaw: false,
        });

        if (!recovered.pageOk) {
          throw buildError(
            `Halaman recovery ${failedPage} tidak valid.`,
            'SGO_PAGE_INVALID',
          );
        }
        if (!recovered.rows.length) {
          throw buildError(
            `Halaman recovery ${failedPage} tidak berisi data.`,
            'SGO_EMPTY_PAGE',
          );
        }

        stats.pagesFetched += 1;
        stats.pagesWithRows += 1;
        stats.recoveredPages += 1;
        stats.totalJamaahReported =
          recovered.pageInfo.totalJamaah || stats.totalJamaahReported;
        stats.totalPagesReported =
          recovered.pageInfo.totalPages || stats.totalPagesReported;

        const added = ingestPage(recovered);
        if (recovered.page === 1 && !firstPage) firstPage = recovered;
        if (!lastPage || recovered.page >= lastPage.page) lastPage = recovered;

        console.log(
          `[SGO Upload] Recovery halaman ${failedPage} berhasil: ` +
            `+${added} jamaah (total ${combined.length}).`,
        );
      } catch (error) {
        if (!stats.unrecoveredPages.includes(failedPage)) {
          stats.unrecoveredPages.push(failedPage);
        }
        recordFailure(failedPage, error, 'recovery');
        console.warn(
          `[SGO Upload] Recovery halaman ${failedPage} gagal ` +
            `(${error?.code || 'SGO_ERROR'}): ${error?.message || error}`,
        );
        if (error?.code === 'SGO_AUTH') {
          stopReason = 'auth-error';
          break;
        }
      }
    }
  }

  if (stats.unrecoveredPages.length && stopReason !== 'auth-error') {
    stopReason = 'completed-with-gaps';
  } else if (
    stats.recoveredPages > 0 &&
    !stats.unrecoveredPages.length &&
    stopReason === 'fetch-error'
  ) {
    stopReason = 'recovered';
  }

  stats.stopReason = stopReason;
  stats.rows = combined.length;
  stats.ms = Date.now() - started;
  console.log(
    `[SGO Upload] Selesai: ${stats.pagesFetched} halaman, ` +
      `${stats.rows} jamaah unik, ${stats.recoveredPages} halaman dipulihkan, ` +
      `${stats.unrecoveredPages.length} gap, stop=${stats.stopReason}, ${stats.ms}ms.`,
  );

  return {
    modulePath: UPLOAD_DOCUMENTS_PATH,
    page: lastPage?.page || 1,
    targetUrl:
      lastPage?.targetUrl || buildUploadDocumentsUrl(config.baseUrl, 1),
    finalUrl: lastPage?.finalUrl || '',
    status: lastPage?.status || 0,
    contentType: lastPage?.contentType || 'text/html',
    fetchedAt: lastPage?.fetchedAt || new Date().toISOString(),
    htmlLength: lastPage?.htmlLength || 0,
    htmlHash: lastPage?.htmlHash || '',
    pageOk: Boolean(firstPage?.pageOk),
    rows: combined,
    summary: firstPage?.summary || null,
    pagination: stats,
    ms: Date.now() - started,
  };
}

/**
 * Jalankan satu putaran fetch paralel memakai satu config cookie.
 * Tidak pernah throw untuk kegagalan modul; semua error dikumpulkan di
 * `errors` agar pemanggil bisa memutuskan fallback.
 */
async function runSgoAttempt({ config, modulePaths }) {
  const settled = await Promise.allSettled(
    modulePaths.map((modulePath) => {
      const normalizedPath = normalizeModulePath(modulePath);
      if (normalizedPath === UPLOAD_DOCUMENTS_PATH) {
        return fetchUploadDocumentsPaginated(config);
      }
      return isJamaahModule(normalizedPath)
        ? fetchSgoModulePaginated(normalizedPath, config)
        : fetchSgoModule(normalizedPath, config);
    }),
  );

  const pages = [];
  const errors = [];
  let authError = null;

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      pages.push(result.value);
      return;
    }

    const reason = result.reason || {};
    const info = {
      modulePath: modulePaths[index],
      code: reason.code || 'SGO_ERROR',
      status: reason.status || 0,
      message: reason.message || String(reason),
    };
    errors.push(info);
    if (info.code === 'SGO_AUTH' && !authError) authError = reason;
    console.error(`[SGO] ${info.modulePath} gagal (${info.code}${info.status ? ` ${info.status}` : ''}): ${info.message}`);
  });

  for (const page of pages) {
    if (!page.pageOk) {
      console.error(`[SGO] ${page.modulePath} mengembalikan halaman kosong (${page.htmlLength} byte).`);
    } else if (!page.rows.length) {
      console.warn(`[SGO] ${page.modulePath} OK (${page.htmlLength} byte) tetapi tidak ada baris jamaah.`);
    }
  }

  // Hanya modul sumber jamaah (Monitoring Jamaah + Upload Manifest) yang
  // boleh mengisi store. Baris digabung agar RTB/pembayaran dari Monitoring
  // melengkapi NIK/paspor/status dokumen dari Upload Manifest.
  const jamaahSourcePaths = new Set(
    SGO_MODULE_OPTIONS.filter((module) => module.jamaahSource).map(
      (module) => module.path,
    ),
  );
  const rows = mergeJamaahRows(
    pages
      .filter((page) => jamaahSourcePaths.has(page.modulePath))
      .flatMap((page) => page.rows),
  );
  const modulesVisited = pages.filter((page) => page.pageOk).map((page) => page.modulePath);
  const failedSet = new Set([
    ...errors.map((error) => error.modulePath),
    ...pages.filter((page) => !page.pageOk).map((page) => page.modulePath),
  ]);

  console.log(
    `[SGO] Hasil: ${rows.length} jamaah bersih | ${modulesVisited.length}/${modulePaths.length} modul OK | ${errors.length} error`,
  );

  return {
    rows,
    pages,
    errors,
    authError,
    modulesVisited,
    modulesFailed: [...failedSet],
    pagination: pages
      .filter((page) => page.pagination)
      .map((page) => ({ modulePath: page.modulePath, ...page.pagination })),
    summaries: pages
      .filter((page) => page.pageOk && page.summary)
      .map((page) => ({ modulePath: page.modulePath, ...page.summary })),
  };
}

/**
 * Scrape cepat (fetch paralel) untuk satu modul fokus atau seluruh 16 modul.
 *
 * Jika cookie dari UI/request tidak menghasilkan data, otomatis retry SEKALI
 * memakai SGO_ADMIN_SESSION dari .env. Hasil akhir menandai `usedEnvCookie`
 * dan `requestCookieError` agar route bisa memberi warning ke UI.
 */
export async function scrapeSgoModules({ url, cookie, focusModule } = {}) {
  const envSession = getEnvSession();
  if (!envSession) {
    console.error(
      '[SGO] ERROR: SGO_ADMIN_SESSION kosong atau tidak ditemukan di .env. ' +
        'Scrape hanya bisa memakai cookie dari UI.',
    );
  }

  const requestConfig = resolveSgoConfig({ url, cookie });
  if (!requestConfig.ok) {
    throw buildError(requestConfig.urlError || requestConfig.cookieError, 'SGO_CONFIG', {
      config: requestConfig,
    });
  }

  const focus = resolveSgoModule(focusModule);
  const modulePaths = focus ? [focus] : [...SGO_MODULES];
  // Modul jamaah selalu berpasangan: Monitoring memberi pembayaran/RTB,
  // Upload Manifest memberi cakupan penuh lewat pagination.
  if (focus && isJamaahModule(focus)) {
    for (const required of [MONITORING_JAMAAH_PATH, UPLOAD_DOCUMENTS_PATH]) {
      if (!modulePaths.includes(required)) modulePaths.push(required);
    }
  }

  console.log(
    `[SGO] Scrape ${focus ? `modul ${modulePaths.join(', ')}` : `${modulePaths.length} modul`} | cookie dari ${requestConfig.cookieSource} (${maskCookie(requestConfig.cookieHeader)}) | base ${requestConfig.baseUrl}`,
  );

  let config = requestConfig;
  let attempt = await runSgoAttempt({ config, modulePaths });
  let usedEnvCookie = false;
  let requestCookieError = '';

  const focusLoadsWithoutRows =
    Boolean(focus) &&
    !isJamaahModule(focus) &&
    attempt.modulesVisited.includes(focus);

  const canRetryWithEnv =
    attempt.rows.length === 0 &&
    !focusLoadsWithoutRows &&
    requestConfig.cookieSource === 'request' &&
    Boolean(envSession) &&
    requestConfig.cookieHeader !== requestConfig.envCookie;

  if (canRetryWithEnv) {
    requestCookieError =
      attempt.authError?.message ||
      attempt.errors[0]?.message ||
      'Tidak ada baris jamaah pada cookie yang dikirim dari UI.';
    console.warn(`[SGO] Cookie dari UI gagal: ${requestCookieError}`);
    console.warn('[SGO] Mencoba ulang dengan cookie SGO_ADMIN_SESSION dari .env...');

    const envConfig = resolveSgoConfig({ url, cookie: '', useEnvCookie: true });
    const retry = await runSgoAttempt({ config: envConfig, modulePaths });
    config = envConfig;
    attempt = retry;

    if (retry.rows.length > 0) {
      usedEnvCookie = true;
      console.log(`[SGO] Retry cookie .env berhasil: ${retry.rows.length} jamaah.`);
    } else {
      console.error('[SGO] Retry dengan cookie .env juga tidak menghasilkan data.');
    }
  }

  // Enrichment dijalankan sekali pada hasil final (setelah retry cookie),
  // supaya tidak ada request manifest ganda.
  if (attempt.rows.length > 0) {
    const enriched = await enrichJamaahWithManifest(attempt.rows, config, {
      max: MANIFEST_MAX_ENRICH,
    });
    attempt = {
      ...attempt,
      rows: enriched.rows,
      manifestEnrichment: enriched.stats,
    };
  }

  return {
    config,
    focus: focus || null,
    modulePaths,
    usedEnvCookie,
    requestCookieError,
    ...attempt,
  };
}

/**
 * Fallback Puppeteer. Dipakai hanya jika fetch cepat tidak menghasilkan data.
 */
export async function scrapeSgoWithBrowser({ url, cookie, focusModule } = {}) {
  const config = resolveSgoConfig({ url, cookie });
  if (!config.ok) {
    throw buildError(config.urlError || config.cookieError, 'SGO_CONFIG', { config });
  }

  const focus = resolveSgoModule(focusModule);
  const modulePaths = focus ? [focus] : [...SGO_MODULES];

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(SGO_USER_AGENT);

    // Header Cookie eksplisit untuk SETIAP request halaman & aset.
    await page.setExtraHTTPHeaders({
      Cookie: config.cookieHeader,
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    });

    const cookies = config.cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf('=');
        if (index < 0) return null;
        return {
          name: pair.slice(0, index).trim(),
          value: pair.slice(index + 1).trim(),
          domain: new URL(config.baseUrl).hostname,
          path: '/',
        };
      })
      .filter(Boolean);
    if (cookies.length) await page.setCookie(...cookies).catch(() => {});

    const rows = [];
    const modulesVisited = [];
    const modulesFailed = [];

    for (const modulePath of modulePaths) {
      const targetUrl = `${config.baseUrl}${modulePath}`;
      const started = Date.now();
      try {
        const navigation = await page.goto(targetUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        const status = navigation?.status?.() ?? null;
        const finalUrl = page.url() || targetUrl;
        const initialHtml = await page.content();

        if (looksLikeLoginPage(initialHtml, finalUrl)) {
          const authError = buildError(
            `Cookie kedaluwarsa / sesi login habis saat mengakses ${modulePath}.`,
            'SGO_AUTH',
            { modulePath, status },
          );
          saveSgoRawError({
            modulePath,
            code: authError.code,
            message: authError.message,
            status,
            targetUrl,
            finalUrl,
            ms: Date.now() - started,
          });
          throw authError;
        }

        await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const html = await page.content();
        const parsed = extractFromHtml(html).filter(isCleanJamaahRow);
        const summary = extractPageSummary(html);
        const pageOk = html.length > 500;
        const fetchedAt = new Date().toISOString();

        if (isPersistedSgoModule(modulePath)) {
          saveSgoRawResponse({
            modulePath,
            targetUrl,
            finalUrl,
            status,
            contentType:
              navigation?.headers?.()?.['content-type'] || 'text/html',
            html,
            pageOk,
            rowsCount: parsed.length,
            summary,
            fetchedAt,
            ms: Date.now() - started,
          });
        }

        if (parsed.length) {
          rows.push(...parsed);
          modulesVisited.push(modulePath);
        } else if (pageOk) {
          // Halaman berhasil dibuka tetapi tidak punya tabel jamaah. Ini bukan
          // kegagalan koneksi; modul operasional tetap dianggap termuat.
          modulesVisited.push(modulePath);
        } else {
          modulesFailed.push(modulePath);
        }
      } catch (error) {
        if (error?.code === 'SGO_AUTH') {
          error.modulesVisited = modulesVisited;
          throw error;
        }
        saveSgoRawError({
          modulePath,
          code: error?.code || 'SGO_BROWSER',
          message: error.message,
          targetUrl,
          ms: Date.now() - started,
        });
        console.error(`[SGO][Puppeteer] ${modulePath} gagal: ${error.message}`);
        modulesFailed.push(modulePath);
      }
    }

    const mergedRows = dedupeJamaahRows(rows);
    const enriched = mergedRows.length
      ? await enrichJamaahWithManifest(mergedRows, config)
      : { rows: mergedRows, stats: null };
    return {
      rows: enriched.rows,
      modulesVisited,
      modulesFailed,
      manifestEnrichment: enriched.stats,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function extractShortCode(orderId = '') {
  const match = String(orderId).match(/(\d{4,6})$/);
  if (!match) return '';
  return match[1].slice(-4);
}

/**
 * Format data jamaah agar siap dikirim ke UI / AI:
 * hanya field penting, tanpa teks navigasi atau HTML mentah.
 */
export function formatJamaahList(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const output = [];
  const seen = new Set();

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;

    const nama = cleanCell(raw.nama || raw.name || '');
    if (!nama || nama.length < 3) continue;
    if (/[✉📱@]|https?:\/\/|WA Jamaah|WA Pemesan|Login Portal/i.test(nama)) continue;

    const orderId = cleanCell(raw.orderId || raw.kodeOrder || raw.orderCode || '');
    const shortCode = cleanCell(raw.shortCode || raw.orderShort || '') || extractShortCode(orderId);
    const rtb = cleanCell(raw.rtb || raw.noRtb || '');
    const statusPembayaran = cleanCell(
      raw.statusPembayaran || raw.status || raw.pembayaran || '',
    );
    const nik = cleanCell(raw.nik || raw.ktp || raw.noKtp || '');
    const passport = cleanCell(
      raw.passport || raw.paspor || raw.noPaspor || raw.nomorPaspor || '',
    );
    const manifestId = cleanCell(raw.manifestId || raw.jamaahId || '');
    const noHp = cleanCell(raw.noHp || raw.hp || raw.telepon || '');
    const tempatLahir = cleanCell(raw.tempatLahir || '');
    const tanggalLahir = cleanCell(raw.tanggalLahir || '');
    const identityType = cleanCell(raw.identityType || '');

    const key = `${orderId}|${nama}|${rtb}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({
      nama,
      orderId,
      kodeOrder: orderId,
      shortCode,
      orderShort: shortCode,
      portalCode: cleanCell(raw.portalCode || ''),
      rtb,
      noRtb: rtb,
      paket: cleanCell(raw.paket || ''),
      keberangkatan: cleanCell(raw.keberangkatan || ''),
      hotel: cleanCell(raw.hotel || ''),
      dokumen: cleanCell(raw.dokumen || ''),
      statusDokumen: cleanCell(raw.statusDokumen || raw.dokumen || ''),
      statusPembayaran,
      status: statusPembayaran,
      pembayaran: cleanCell(raw.pembayaran || statusPembayaran),
      pemesan: cleanCell(raw.pemesan || ''),
      jumlahJamaah: Number(raw.jumlahJamaah || 0),
      ...(nik ? { nik } : {}),
      ...(passport
        ? { passport, paspor: passport, noPaspor: passport }
        : {}),
      ...(manifestId ? { manifestId } : {}),
      ...(identityType ? { identityType } : {}),
      ...(raw.manifestFetched === true ? { manifestFetched: true } : {}),
      ...(noHp ? { noHp } : {}),
      ...(tempatLahir ? { tempatLahir } : {}),
      ...(tanggalLahir ? { tanggalLahir } : {}),
      ...(cleanCell(raw.kotaPaspor || '')
        ? { kotaPaspor: cleanCell(raw.kotaPaspor) }
        : {}),
      ...(cleanCell(raw.tanggalExpiredPaspor || '')
        ? { tanggalExpiredPaspor: cleanCell(raw.tanggalExpiredPaspor) }
        : {}),
    });
  }

  return output;
}

export function formatJamaahSample(rows = [], limit = 3) {
  return formatJamaahList(rows).slice(0, limit);
}
