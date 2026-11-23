/**
 * Proxy halaman edit manifest SGO Rahmah.
 *
 * Halaman asli berada di `https://sgo.rahmahgrup.id/ops/monitoring-jamaah/:id/edit`
 * dan membutuhkan sesi admin. Route lokal
 * `/ops/monitoring_jamaah/:id/edit` membaca cookie SGO perangkat dari cookie
 * HttpOnly lalu menyajikannya melalui origin konsol.
 *
 * Semua URL root-absolute di HTML/CSS/JS SGO ditulis ulang ke prefix
 * `/sgo-proxy` supaya aset, form, OCR, dan navigasi tetap bekerja. Cookie sesi
 * tidak pernah diekspos ke JavaScript konsol.
 */
import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { SGO_BROWSER_HEADERS } from '../services/sgoScraper.js';
import { getRequestSgoCookieHeader } from '../services/sgoRequestContext.js';
import { findJamaahById } from '../data/jamaahStore.js';

export const SGO_PROXY_PREFIX = '/sgo-proxy';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROXY_BODY = '30mb';

// Endpoint POST yang memang dibutuhkan halaman edit. Semua POST lain ditolak
// agar proxy tidak menjadi jalur bebas untuk mengubah data SGO dari modul lain.
const MUTATING_ALLOWLIST = [
  /^\/ops\/monitoring-jamaah\/[^/]+\/save$/i,
  /^\/ops\/monitoring-jamaah\/[^/]+\/ocr\/[^/]+$/i,
  // Modal Kelola Perlengkapan: simpan status/metode/resi dan upload bukti.
  /^\/ops\/monitoring-jamaah\/perlengkapan\/jamaah\/\d+\/save$/i,
  /^(?:\/ops)?\/monitoring-jamaah\/perlengkapan\/upload$/i,
  // Checklist Siapkan & Submit: ceklis per item, pilih semua, upload bukti.
  /^\/ops\/worksheet-perlengkapan\/jamaah\/\d+\/(?:qc|qc-all|qc-bukti|prioritas)$/i,
  /^\/ops\/worksheet-perlengkapan\/jamaah\/\d+\/qc\/[A-Za-z0-9_-]+$/i,
];

const runtimeSessions = new Map();

function getSgoBaseUrl() {
  return String(process.env.SGO_BASE_URL || 'https://sgo.rahmahgrup.id')
    .trim()
    .replace(/\/+$/, '');
}

function runtimeSessionKey(cookieHeader = '') {
  return createHash('sha256').update(String(cookieHeader)).digest('hex');
}

function getCookieHeader() {
  const baseCookie = getRequestSgoCookieHeader();
  if (!baseCookie) return '';
  return runtimeSessions.get(runtimeSessionKey(baseCookie)) || baseCookie;
}

function captureSessionCookie(response) {
  const baseCookie = getRequestSgoCookieHeader();
  if (!baseCookie) return;

  const key = runtimeSessionKey(baseCookie);
  let cookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    cookies = response.headers.getSetCookie();
  } else {
    const single = response.headers.get('set-cookie');
    if (single) cookies = [single];
  }

  for (const cookie of cookies) {
    const match = String(cookie).match(
      /(?:^|;\s*)sgo_admin_session=([^;]*)/i,
    );
    if (!match) continue;

    const value = decodeURIComponent(match[1].trim());
    const expired = /(?:^|;\s*)max-age=0(?:;|$)/i.test(cookie);
    if (!value || expired) {
      runtimeSessions.delete(key);
      continue;
    }

    runtimeSessions.set(key, `sgo_admin_session=${value}`);
    if (runtimeSessions.size > 100) {
      runtimeSessions.delete(runtimeSessions.keys().next().value);
    }
  }
}

function rewritePath(pathWithQuery = '/') {
  if (!pathWithQuery.startsWith('/')) return pathWithQuery;

  // Halaman edit selalu kembali ke route publik konsol (underscore), bukan ke
  // prefix proxy, supaya URL yang terlihat tetap route yang diminta.
  if (
    /^\/ops\/monitoring-jamaah\/[^/?#]+\/edit(?:[?#]|$)/i.test(pathWithQuery)
  ) {
    return pathWithQuery.replace(
      /^\/ops\/monitoring-jamaah\//i,
      '/ops/monitoring_jamaah/',
    );
  }

  if (
    pathWithQuery === SGO_PROXY_PREFIX ||
    pathWithQuery.startsWith(`${SGO_PROXY_PREFIX}/`)
  ) {
    return pathWithQuery;
  }

  return `${SGO_PROXY_PREFIX}${pathWithQuery}`;
}

function rewriteUrl(value = '') {
  const raw = String(value || '');
  if (!raw) return raw;
  if (raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const base = getSgoBaseUrl();
    if (raw === base) return SGO_PROXY_PREFIX;
    if (raw.startsWith(`${base}/`)) {
      return rewritePath(raw.slice(base.length));
    }
    return raw;
  }
  if (raw.startsWith('/')) return rewritePath(raw);
  return raw;
}

function rewriteCss(css = '') {
  let out = css.replace(
    /url\(\s*(['"]?)(\/(?!\/)[^)'"]*)\1\s*\)/gi,
    (match, quote, url) => `url(${quote}${rewriteUrl(url)}${quote})`,
  );
  out = out.replace(
    /(@import\s+)(['"])(\/(?!\/)[^'"]*)\2/gi,
    (match, prefix, quote, url) =>
      `${prefix}${quote}${rewriteUrl(url)}${quote}`,
  );
  return out;
}

/**
 * Tulis ulang string root-absolute di dalam JavaScript SGO.
 * Hanya prefix yang benar-benar dipakai SGO yang disentuh, jadi regex,
 * komentar, dan URL eksternal tidak ikut berubah.
 */
function rewriteJavaScript(js = '') {
  const roots = [
    '/ops/',
    '/api/',
    '/static/',
    '/admin/',
    '/media/',
    '/manifest-admin.webmanifest',
    '/version.json',
    '/sw.js',
  ];

  let out = js;
  for (const root of roots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(["'\`])${escaped}`, 'g'),
      `$1${SGO_PROXY_PREFIX}${root}`,
    );
  }
  out = out.replace(
    /(["'`])\/ops(?=["'`?#])/g,
    `$1${SGO_PROXY_PREFIX}/ops`,
  );

  // Service worker SGO tidak boleh aktif di origin konsol: scope-nya akan
  // bentrok dengan shell utama dan bisa menyajikan cache halaman SGO.
  out = out.replace(
    /navigator\.serviceWorker\.register\([^;]*?\)\s*\.then\(/g,
    'Promise.resolve(null).then(',
  );

  return out;
}

function buildAutoManageScript(order = '') {
  const safeOrder = String(order).replace(/\D/g, '');
  if (!safeOrder) return '';

  return `
<script>
(function () {
  var order = '${safeOrder}';
  var attempts = 0;

  function openManage() {
    var target = document.getElementById('perlengkapan-modal');
    if (window.htmx && target) {
      window.htmx.ajax('GET', '/sgo-proxy/ops/monitoring-jamaah/perlengkapan/' + order, {
        target: '#perlengkapan-modal',
        swap: 'innerHTML'
      });
      return;
    }
    attempts += 1;
    if (attempts <= 60) window.setTimeout(openManage, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', openManage, { once: true });
  } else {
    openManage();
  }
})();
</script>`;
}

function readAutoManageOrder(req, targetPath = '') {
  if (!/^\/ops\/worksheet-perlengkapan(?:[?#]|$)/i.test(targetPath)) {
    return '';
  }

  try {
    const url = new URL(req.originalUrl || '/', 'http://console.local');
    const order = String(url.searchParams.get('manage_order') || '').trim();
    return /^\d{1,20}$/.test(order) ? order : '';
  } catch {
    return '';
  }
}

function rewriteHtml(html = '', { autoManageOrder = '' } = {}) {
  let out = String(html);

  // Tombol Kembali/Batal pada halaman asli diarahkan ke konsol lokal, bukan ke
  // daftar SGO. Link lain tetap mengikuti alur SGO melalui proxy.
  out = out.replace(
    /<a\b[^>]*\bid=["']mj-back-(?:kembali|batal)["'][^>]*>/gi,
    (tag) =>
      tag.replace(
        /href=["']\/ops\/monitoring-jamaah["']/i,
        'href="__LOCAL_MONITORING__"',
      ),
  );

  const attrs = [
    'href',
    'src',
    'action',
    'formaction',
    'poster',
    'data-prefix',
    'data-search-url',
    'data-url',
    'data-href',
    'hx-get',
    'hx-post',
    'hx-put',
    'hx-patch',
    'hx-delete',
  ];
  const attrPattern = new RegExp(
    `(\\b(?:${attrs.join('|')})\\s*=\\s*)(["'])([^"']*)\\2`,
    'gi',
  );
  out = out.replace(
    attrPattern,
    (match, prefix, quote, value) =>
      `${prefix}${quote}${rewriteUrl(value)}${quote}`,
  );

  out = out.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix, quote, value) => {
      const rewritten = value
        .split(',')
        .map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return '';
          const [url, ...descriptors] = trimmed.split(/\s+/);
          return [rewriteUrl(url), ...descriptors].join(' ');
        })
        .filter(Boolean)
        .join(', ');
      return `${prefix}${quote}${rewritten}${quote}`;
    },
  );

  out = rewriteCss(out);

  out = out.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (match, open, code, close) =>
      `${open}${rewriteJavaScript(code)}${close}`,
  );

  // Tab SGO yang dibuka dari aksi Kelola langsung menampilkan modal order
  // tersebut. Injeksi hanya aktif bila query `manage_order` ada dan valid.
  if (autoManageOrder) {
    const script = buildAutoManageScript(autoManageOrder);
    if (script) {
      out = /<\/body>/i.test(out)
        ? out.replace(/<\/body>/i, `${script}</body>`)
        : `${out}${script}`;
    }
  }

  return out.replace(/__LOCAL_MONITORING__/g, '/ops/monitoring-jamaah');
}

function rewriteJson(json = '') {
  return String(json).replace(
    /"(\/(?:ops|api|static|admin|media)(?:\/[^"]*)?)"/g,
    (match, path) => `"${rewriteUrl(path)}"`,
  );
}

function isTextContentType(contentType = '') {
  return /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json)|image\/svg\+xml)/i.test(
    contentType,
  );
}

function rewriteContent(contentType = '', text = '', options = {}) {
  if (/text\/html/i.test(contentType)) return rewriteHtml(text, options);
  if (/text\/css/i.test(contentType)) return rewriteCss(text);
  if (/(?:java|ecma)script/i.test(contentType)) {
    return rewriteJavaScript(text);
  }
  if (/json/i.test(contentType)) return rewriteJson(text);
  if (/image\/svg\+xml/i.test(contentType)) return rewriteHtml(text);
  return text;
}

function sendSimplePage(
  res,
  status,
  title,
  message,
  { notifyAuth = false } = {},
) {
  const safeTitle = String(title || 'Kesalahan').replace(/[<>&]/g, '');
  const safeMessage = String(message || '').replace(
    /[<>&]/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char],
  );
  const authScript = notifyAuth
    ? `<script>try{parent.postMessage({type:'rahmah-sgo-auth-expired'},window.location.origin)}catch(error){}</script>`
    : '';
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(
      `<!doctype html><html lang="id"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${safeTitle}</title></head><body style="font-family:system-ui,sans-serif;padding:32px;line-height:1.6">` +
        `<h1 style="font-size:20px">${safeTitle}</h1><p>${safeMessage}</p>` +
        authScript +
        `<p><a href="/ops/monitoring-jamaah">Kembali ke Monitoring Jamaah</a></p>` +
        `</body></html>`,
    );
}

function sendAuthError(res, htmlPage = false) {
  const message =
    'Cookie SGO perangkat ini tidak valid atau sudah kedaluwarsa. ' +
    'Buka tombol Cookie SGO di header konsol, tempel cookie baru, lalu simpan.';
  if (!htmlPage) {
    return res.status(502).type('text').send(message);
  }
  return sendSimplePage(
    res,
    502,
    'Sesi SGO tidak valid',
    message,
    { notifyAuth: true },
  );
}

function isLoginPayload(status, finalUrl, contentType, text) {
  if (status === 401 || status === 403) return true;
  if (!/text\/html/i.test(contentType)) return false;
  if (/\/admin\/login(?:[?#]|$)/i.test(finalUrl)) return true;

  const title =
    (String(text).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return (
    /masuk admin|login/i.test(title) &&
    !/monitoring-jamaah|manifest jamaah/i.test(text)
  );
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function handleRedirect(res, status, location, targetUrl, htmlPage) {
  if (!location) {
    return sendSimplePage(
      res,
      502,
      'SGO mengembalikan redirect kosong',
      'Halaman SGO tidak memberikan tujuan redirect.',
    );
  }

  let next;
  try {
    next = new URL(location, targetUrl);
  } catch {
    return res.redirect(status, location);
  }

  const base = new URL(getSgoBaseUrl());
  if (next.origin !== base.origin) {
    return res.redirect(status, next.toString());
  }

  const path = `${next.pathname}${next.search}${next.hash}`;
  if (/^\/admin\/login(?:[?#]|$)/i.test(path)) {
    return sendAuthError(res, htmlPage);
  }
  if (/^\/ops\/logout(?:[?#]|$)/i.test(path)) {
    return res.redirect(303, '/ops/monitoring-jamaah');
  }

  // Manifest yang tidak ada di SGO dialihkan ke daftar Monitoring Jamaah.
  // Untuk route edit, tampilkan 404 yang jelas, bukan halaman daftar.
  if (
    htmlPage &&
    /^\/ops\/monitoring-jamaah\/?(?:[?#]|$)/i.test(path)
  ) {
    return sendSimplePage(
      res,
      404,
      'Data jamaah tidak ditemukan',
      'Manifest jamaah ini tidak ditemukan di SGO.',
    );
  }

  const browserStatus = status === 307 || status === 308 ? 303 : status;
  return res.redirect(browserStatus, rewritePath(path));
}

function buildUpstreamHeaders(req, targetUrl, htmlPage) {
  const headers = {
    ...SGO_BROWSER_HEADERS,
    Cookie: getCookieHeader(),
  };

  if (req.headers.accept) headers.Accept = req.headers.accept;
  if (req.headers['accept-language']) {
    headers['Accept-Language'] = req.headers['accept-language'];
  }
  if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }
  if (req.headers['x-requested-with']) {
    headers['X-Requested-With'] = req.headers['x-requested-with'];
  }
  if (req.headers['hx-request']) {
    headers['HX-Request'] = req.headers['hx-request'];
  }
  if (req.headers['hx-target']) {
    headers['HX-Target'] = req.headers['hx-target'];
  }
  if (req.headers['hx-trigger']) {
    headers['HX-Trigger'] = req.headers['hx-trigger'];
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers.Origin = getSgoBaseUrl();
    headers.Referer = targetUrl;
  }

  headers['Sec-Fetch-Dest'] =
    req.headers['sec-fetch-dest'] || (htmlPage ? 'document' : 'empty');
  headers['Sec-Fetch-Mode'] =
    req.headers['sec-fetch-mode'] || (htmlPage ? 'navigate' : 'no-cors');
  headers['Sec-Fetch-Site'] = 'same-origin';

  return headers;
}

function readRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (Buffer.isBuffer(req.body)) {
    return req.body.length ? req.body : undefined;
  }
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body));
  }
  return undefined;
}

function copyProxyHeaders(res, upstream, contentType, htmlPage) {
  const passThrough = ['content-disposition', 'content-language'];
  for (const name of passThrough) {
    const value = upstream.headers.get(name);
    if (value) res.set(name, value);
  }

  if (contentType) res.set('Content-Type', contentType);

  const isDynamic =
    htmlPage ||
    /text\/html|json|javascript|text\/css/i.test(contentType);
  res.set(
    'Cache-Control',
    isDynamic ? 'no-store, max-age=0' : 'private, max-age=300',
  );
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  if (htmlPage) res.set('X-Robots-Tag', 'noindex, nofollow');
}

async function proxyRequest(req, res, targetPath, { htmlPage = false } = {}) {
  const base = getSgoBaseUrl();
  const targetUrl = `${base}${targetPath}`;
  const method = String(req.method || 'GET').toUpperCase();

  if (!getCookieHeader()) {
    return sendAuthError(res, htmlPage);
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers: buildUpstreamHeaders(req, targetUrl, htmlPage),
      body: readRequestBody(req),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(
      `[sgo-proxy] ${method} ${targetPath} gagal: ${error.message}`,
    );
    return sendSimplePage(
      res,
      502,
      'SGO tidak dapat dihubungi',
      'Server SGO tidak merespons. Periksa koneksi internet lalu muat ulang.',
    );
  }

  captureSessionCookie(upstream);

  if (isRedirect(upstream.status)) {
    return handleRedirect(
      res,
      upstream.status,
      upstream.headers.get('location') || '',
      targetUrl,
      htmlPage,
    );
  }

  const contentType = upstream.headers.get('content-type') || '';
  const buffer = Buffer.from(await upstream.arrayBuffer());
  const isText = isTextContentType(contentType);
  const text = isText ? buffer.toString('utf8') : '';
  const autoManageOrder = readAutoManageOrder(req, targetPath);

  if (isLoginPayload(upstream.status, upstream.url || targetUrl, contentType, text)) {
    return sendAuthError(res, htmlPage);
  }

  copyProxyHeaders(res, upstream, contentType, htmlPage);
  res.status(upstream.status);

  if (
    method === 'HEAD' ||
    upstream.status === 204 ||
    upstream.status === 304 ||
    !buffer.length
  ) {
    return res.end();
  }

  return res.send(
    isText
      ? rewriteContent(contentType, text, { autoManageOrder })
      : buffer,
  );
}

/* ------------------------------------------------------------------ */
/* Halaman edit di origin konsol                                       */
/* ------------------------------------------------------------------ */

export const sgoEditRouter = Router();

function serveEditPage(req, res) {
  const id = String(req.params.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return sendSimplePage(
      res,
      404,
      'ID jamaah tidak valid',
      'ID manifest jamaah tidak dikenali.',
    );
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).type('text').send('Method Not Allowed');
  }

  // Cross-check lokal hanya untuk log; SGO tetap menjadi sumber data halaman
  // edit. Data baru yang belum masuk store lokal tidak boleh diblokir.
  if (!findJamaahById(id)) {
    console.warn(
      `[sgo-edit] Manifest ${id} belum ada di store lokal; tetap dimuat dari SGO.`,
    );
  }

  const queryIndex = req.originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  const targetPath =
    `/ops/monitoring-jamaah/${encodeURIComponent(id)}/edit` + query;

  return proxyRequest(req, res, targetPath, { htmlPage: true });
}

sgoEditRouter.get('/ops/monitoring_jamaah/:id/edit', serveEditPage);
sgoEditRouter.get('/ops/monitoring-jamaah/:id/edit', serveEditPage);

/* ------------------------------------------------------------------ */
/* Proxy aset, API, dan form SGO                                       */
/* ------------------------------------------------------------------ */

export const sgoProxyRouter = Router();

sgoProxyRouter.use(express.raw({ type: () => true, limit: MAX_PROXY_BODY }));

sgoProxyRouter.all('*', (req, res) => {
  const original = req.originalUrl || req.url || '/';
  let targetPath = original.startsWith(SGO_PROXY_PREFIX)
    ? original.slice(SGO_PROXY_PREFIX.length)
    : original;
  if (!targetPath.startsWith('/')) targetPath = `/${targetPath}`;

  const pathname = targetPath.split('?')[0].split('#')[0];

  // Logout SGO tidak boleh menghapus sesi yang dipakai server untuk scraping.
  if (/^\/ops\/logout(?:[?#]|$)/i.test(targetPath)) {
    return res.redirect(303, '/ops/monitoring-jamaah');
  }

  // Service worker SGO dinonaktifkan di origin konsol.
  if (pathname === '/sw.js') {
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript');
    return res.send('/* Service worker SGO dinonaktifkan di konsol lokal. */');
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const allowed = MUTATING_ALLOWLIST.some((pattern) =>
      pattern.test(pathname),
    );
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error:
          'Aksi ubah data SGO ini diblokir oleh proxy konsol. ' +
          'Hanya simpan manifest dan OCR halaman edit yang diizinkan.',
      });
    }
  }

  return proxyRequest(req, res, targetPath, { htmlPage: false });
});

// Body parser error (mis. upload > 30 MB) tidak boleh jatuh ke handler JSON
// global dengan pesan yang membingungkan.
sgoProxyRouter.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return sendSimplePage(
      res,
      413,
      'Berkas terlalu besar',
      'Ukuran berkas melebihi batas proxy 30 MB.',
    );
  }
  return next(error);
});
