/**
 * Resolver tautan Portal Jamaah per order.
 *
 * Portal Jamaah membutuhkan DUA parameter agar benar-benar membuka order yang
 * dicari: `code` (kode order) dan `unique_code` (kode portal order). Bila hanya
 * `code` yang dikirim, portal tidak melakukan auto-login dan bisa menampilkan
 * sesi order terakhir. Karena itu tautan "Login Portal" tidak boleh diarahkan
 * langsung ke `/dashboard`.
 *
 * Sumber kode unik, berurutan:
 * 1. data jamaah (`portalCode` dari Monitoring Jamaah),
 * 2. cache SQLite `portal_codes`,
 * 3. cache Worksheet (`portal_url`),
 * 4. pencarian on-demand ke SGO Monitoring Jamaah.
 *
 * Kode unik tidak pernah dikembalikan lewat API publik; server hanya
 * mengirim redirect ke halaman login portal.
 */

import {
  SGO_BROWSER_HEADERS,
  resolveSgoConfig,
} from './sgoScraper.js';
import { findJamaahById } from '../data/jamaahStore.js';
import {
  getCachedPortalEntry,
  savePortalCode,
} from './manifestStore.js';
import { findWorksheetPortalUrl } from './worksheetStore.js';

const PORTAL_LOGIN_URL = 'https://jamaah.rahmahtravel.id/login';
const SGO_MONITORING_PATH = '/ops/monitoring-jamaah';
const LOOKUP_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.PORTAL_LOOKUP_TIMEOUT_MS || 8_000) || 8_000,
);
const NEGATIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const negativeCache = new Map();

function normalizeOrderCode(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function cleanUniqueCode(value = '') {
  const code = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return code.length >= 4 && code.length <= 20 ? code : '';
}

function digitsOnly(value = '') {
  return String(value || '')
    .replace(/\D+/g, '')
    .replace(/^0+/, '');
}

/** Cocokkan kode order lengkap dengan nomor order pendek (mis. 5107). */
function ordersMatch(left = '', right = '') {
  const a = normalizeOrderCode(left);
  const b = normalizeOrderCode(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const digestA = digitsOnly(a);
  const digestB = digitsOnly(b);
  return Boolean(digestA && digestB && digestA === digestB);
}

function isFullOrderCode(value = '') {
  return normalizeOrderCode(value).split('-').filter(Boolean).length >= 3;
}

export function buildPortalLoginUrl(orderCode = '', uniqueCode = '') {
  const code = normalizeOrderCode(orderCode);
  const unique = cleanUniqueCode(uniqueCode);
  if (!code && !unique) return PORTAL_LOGIN_URL;

  const params = new URLSearchParams();
  if (code) params.set('code', code);
  if (unique) params.set('unique_code', unique);
  return `${PORTAL_LOGIN_URL}?${params.toString()}`;
}

export function extractPortalTargetFromUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return { orderCode: '', uniqueCode: '' };

  try {
    const parsed = new URL(raw);
    return {
      orderCode: normalizeOrderCode(parsed.searchParams.get('code') || ''),
      uniqueCode: cleanUniqueCode(
        parsed.searchParams.get('unique_code') ||
          parsed.searchParams.get('uniq_code') ||
          '',
      ),
    };
  } catch {
    const uniqueMatch = raw.match(
      /[?&](?:unique_code|uniq_code)=([A-Za-z0-9]+)/i,
    );
    const orderMatch = raw.match(/[?&]code=([^&\s]+)/i);
    return {
      orderCode: normalizeOrderCode(orderMatch?.[1] || ''),
      uniqueCode: cleanUniqueCode(uniqueMatch?.[1] || ''),
    };
  }
}

export function extractUniqueCodeFromUrl(url = '') {
  return extractPortalTargetFromUrl(url).uniqueCode;
}

/**
 * Ambil tautan portal yang cocok dari HTML Monitoring Jamaah SGO.
 * Hanya tautan untuk order yang diminta yang dipakai, sehingga order lain
 * tidak pernah bocor ke pengguna.
 */
function extractPortalTargetFromHtml(html = '', expectedOrder = '') {
  const hrefs = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match = hrefRe.exec(html);
  while (match) {
    const href = match[1]
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .trim();
    if (/jamaah\.rahmahtravel\.id\/login/i.test(href)) hrefs.push(href);
    match = hrefRe.exec(html);
  }

  for (const href of hrefs) {
    let parsed;
    try {
      parsed = new URL(href, PORTAL_LOGIN_URL);
    } catch {
      continue;
    }

    const linkOrder = normalizeOrderCode(parsed.searchParams.get('code') || '');
    const unique = cleanUniqueCode(
      parsed.searchParams.get('unique_code') ||
        parsed.searchParams.get('uniq_code') ||
        '',
    );
    if (!unique) continue;
    if (expectedOrder && !ordersMatch(expectedOrder, linkOrder)) continue;

    return { orderCode: linkOrder, uniqueCode: unique };
  }

  return { orderCode: '', uniqueCode: '' };
}

/** Pencarian langsung ke SGO untuk order yang belum ada di cache lokal. */
async function lookupSgoPortalTarget(orderCode = '') {
  const code = normalizeOrderCode(orderCode);
  if (!code) return { orderCode: '', uniqueCode: '' };

  const cachedAt = negativeCache.get(code);
  if (cachedAt && Date.now() - cachedAt < NEGATIVE_CACHE_TTL_MS) {
    return { orderCode: '', uniqueCode: '' };
  }

  const config = resolveSgoConfig({ useEnvCookie: true });
  if (!config.ok) {
    negativeCache.set(code, Date.now());
    return { orderCode: '', uniqueCode: '' };
  }

  const searchUrl = `${config.baseUrl}${SGO_MONITORING_PATH}?search=${encodeURIComponent(
    code,
  )}`;

  try {
    const response = await fetch(searchUrl, {
      headers: {
        ...SGO_BROWSER_HEADERS,
        Cookie: config.cookieHeader,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });

    if (!response.ok) {
      negativeCache.set(code, Date.now());
      return { orderCode: '', uniqueCode: '' };
    }

    const html = await response.text();
    const target = extractPortalTargetFromHtml(html, code);
    if (!target.uniqueCode) {
      negativeCache.set(code, Date.now());
      return { orderCode: '', uniqueCode: '' };
    }

    negativeCache.delete(code);
    return target;
  } catch (error) {
    negativeCache.set(code, Date.now());
    console.error(
      `[portal] pencarian kode portal ${code} gagal: ${error.message}`,
    );
    return { orderCode: '', uniqueCode: '' };
  }
}

/**
 * Tentukan tautan login portal yang tepat untuk satu jamaah/order.
 * Selalu mengembalikan `url` yang aman dipakai sebagai redirect.
 */
export async function resolvePortalLoginTarget({
  jamaahId = '',
  orderCode = '',
} = {}) {
  const jamaah = jamaahId ? findJamaahById(jamaahId) : null;
  const jamaahOrder = normalizeOrderCode(
    jamaah?.orderCode || jamaah?.kodeOrder || jamaah?.orderId || '',
  );
  let order = normalizeOrderCode(orderCode) || jamaahOrder;

  if (!order) {
    return {
      orderCode: '',
      uniqueCode: '',
      url: PORTAL_LOGIN_URL,
      source: 'none',
    };
  }

  // Kode portal hanya boleh dipakai bila memang milik order yang diminta.
  let unique = ordersMatch(jamaahOrder, order)
    ? cleanUniqueCode(jamaah?.portalCode)
    : '';
  let source = unique ? 'jamaah-data' : '';

  if (unique && isFullOrderCode(jamaahOrder) && !isFullOrderCode(order)) {
    order = jamaahOrder;
  }

  if (!unique) {
    const cached = getCachedPortalEntry(order);
    if (cached?.uniqueCode) {
      unique = cached.uniqueCode;
      source = 'cache';
      if (isFullOrderCode(cached.orderCode)) order = cached.orderCode;
    }
  }

  if (!unique) {
    const worksheetTarget = extractPortalTargetFromUrl(
      findWorksheetPortalUrl(order),
    );
    if (
      worksheetTarget.uniqueCode &&
      (!worksheetTarget.orderCode || ordersMatch(worksheetTarget.orderCode, order))
    ) {
      unique = worksheetTarget.uniqueCode;
      source = 'worksheet';
      if (isFullOrderCode(worksheetTarget.orderCode)) {
        order = worksheetTarget.orderCode;
      }
    }
  }

  if (!unique) {
    const target = await lookupSgoPortalTarget(order);
    if (target.uniqueCode) {
      unique = target.uniqueCode;
      source = 'sgo';
      if (target.orderCode) order = target.orderCode;
    }
  }

  if (unique) {
    savePortalCode(order, unique, source);
  }

  return {
    orderCode: order,
    uniqueCode: unique,
    url: buildPortalLoginUrl(order, unique),
    source: unique ? source : 'order-only',
  };
}
