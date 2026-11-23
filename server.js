import 'dotenv/config';

import { isVercelRuntime } from './services/runtimeEnv.js';

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeWebContext } from './services/scraper.js';
import { processChat, getAIStatus } from './services/aiEngine.js';
import { buildChatJamaahResults } from './services/consoleJamaahBridge.js';
import {
  setJamaahData,
  upsertJamaahRows,
  findJamaahById,
  getActiveJamaah,
  getJamaahData,
  getJamaahSource,
  getJamaahDataFilePath,
  clearJamaahData,
  hasRealJamaahData,
} from './data/jamaahStore.js';
import {
  SGO_MODULES,
  SGO_MODULE_OPTIONS,
  fetchSingleJamaahFromSgo,
  formatJamaahList,
  getEnvSession,
  getSgoModuleMeta,
  isJamaahModule,
  resolveSgoModule,
  scrapeSgoModules,
  scrapeSgoWithBrowser,
  verifySgoCookie,
} from './services/sgoScraper.js';
import {
  SGO_DEVICE_COOKIE_NAME,
  readSgoDeviceCookie,
  sgoDeviceCookieOptions,
  toSgoSessionCookieHeader,
} from './services/sgoCookie.js';
import {
  getRequestSgoCookieHeader,
  runWithSgoCookie,
} from './services/sgoRequestContext.js';
import {
  buildMonitoringSummary,
  buildSafeJamaahRow,
} from './services/documentStatus.js';
import {
  beginLiveManifestSync,
  commitLiveManifestSync,
  ensureManifestCache,
  rollbackLiveManifestSync,
  upsertLiveManifestRows,
} from './services/manifestStore.js';
import {
  failSyncProgress,
  finishSyncProgress,
  getSyncProgress,
  resetSyncProgress,
  startSyncProgress,
  updateSyncProgress,
} from './services/syncProgress.js';
import {
  SGO_RAW_MODULES,
  getSgoRawStatus,
  getSgoRawStatusFor,
} from './data/sgoRawStore.js';
import monitoringRoutes from './routes/monitoringRoutes.js';
import manifestRoutes from './routes/manifestRoutes.js';
import worksheetRoutes from './routes/worksheetRoutes.js';
import portalRoutes from './routes/portalRoutes.js';
import fuPelunasanRoutes from './routes/fuPelunasanRoutes.js';
import addonRoutes from './routes/addonRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import {
  formatAddonChatReply,
  searchAddonsForChat,
} from './services/addonStore.js';
import {
  sgoEditRouter,
  sgoProxyRouter,
} from './routes/sgoEditRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim() || 'development';
const parsedPort = Number(process.env.PORT || 3000);
const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : 3000;

app.use(cors());
app.use((req, res, next) => {
  runWithSgoCookie(readSgoDeviceCookie(req), next);
});
// Proxy aset/form SGO harus menerima body mentah (multipart) sebelum
// express.json memproses request lain.
app.use('/sgo-proxy', sgoProxyRouter);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/manifest', manifestRoutes);
app.use('/api/worksheet', worksheetRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/fu-pelunasan', fuPelunasanRoutes);
app.use('/api/add-on', addonRoutes);
app.use('/api/message', messageRoutes);
app.use(sgoEditRouter);

// Deep link modul console. Tab controller tetap menentukan tampilan aktif di
// sisi klien, tetapi refresh langsung pada URL modul tidak lagi 404.
const PUBLIC_DIR = path.join(__dirname, 'public');
for (const routePath of [
  '/ops/monitoring-jamaah',
  '/ops/upload-documents',
  '/ops/worksheet-perlengkapan',
  '/ops/fu-pelunasan',
  '/ops/add-on',
]) {
  app.get(routePath, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

// Beacon Cloudflare RUM yang terbawa halaman SGO memanggil /cdn-cgi/rum di
// origin konsol. Tidak ada data yang perlu dikirim; jawab 204 agar console
// browser tetap bersih.
app.all('/cdn-cgi/rum', (req, res) => res.status(204).end());

function supportedModulesPayload() {
  return SGO_MODULE_OPTIONS.map(({ path, label, jamaahSource }) => ({
    path,
    label,
    jamaahSource,
  }));
}

function sgoCookieStatusPayload(active, message = '') {
  const isActive = Boolean(active);
  return {
    success: true,
    active: isActive,
    state: isActive ? 'active' : 'empty',
    message:
      message ||
      (isActive
        ? 'Cookie SGO tersimpan di perangkat ini.'
        : 'Cookie SGO belum diatur di perangkat ini. Klik tombol Cookie SGO untuk menempelkan cookie.'),
  };
}

function rawResponseFields(focusModule = '') {
  return focusModule
    ? { rawResponse: getSgoRawStatusFor(focusModule), rawResponses: [] }
    : { rawResponse: null, rawResponses: getSgoRawStatus() };
}

/**
 * Respons untuk modul operasional yang tidak berisi tabel jamaah.
 * Data jamaah yang sudah ada tidak dihapus dan tetap dipakai pencarian AI.
 */
function buildModuleLoadedPayload(result, focusModule) {
  const meta =
    SGO_MODULE_OPTIONS.find((module) => module.path === focusModule) || null;
  const summary = Array.isArray(result.summaries)
    ? result.summaries.find((item) => item.modulePath === focusModule)
    : null;
  const storedCount = getActiveJamaah().length;
  const label = meta?.label || focusModule;
  const jamaahNote = storedCount
    ? `Modul ini tidak memiliki tabel jamaah; pencarian tetap memakai ${storedCount} data Monitoring Jamaah yang tersimpan.`
    : 'Modul ini tidak memiliki tabel jamaah dan store jamaah masih kosong (0 data).';

  return {
    success: true,
    fallback: false,
    empty: false,
    moduleLoaded: true,
    jamaahSource: false,
    cookieSource: result.config?.cookieSource || null,
    usedEnvCookie: Boolean(result.usedEnvCookie),
    requestCookieError: result.requestCookieError || null,
    warning: result.usedEnvCookie
      ? 'Cookie dari UI tidak menghasilkan data; berhasil memakai cookie SGO_ADMIN_SESSION dari .env.'
      : null,
    message: `Modul ${label} berhasil dimuat. ${jamaahNote}`,
    count: storedCount,
    jamaahCount: storedCount,
    storedJamaahCount: storedCount,
    source: getJamaahSource(),
    modules: result.modulesVisited,
    modulesFailed: result.modulesFailed,
    totalModules: SGO_MODULES.length,
    focusModule,
    moduleSummary: summary,
    jamaahList: [],
    sample: [],
    rawResponse: getSgoRawStatusFor(focusModule),
  };
}

/**
 * Respons jujur saat SGO tidak bisa diakses. Tidak ada data lokal yang
 * dikirim sebagai pengganti; count selalu 0 dan daftar selalu kosong.
 */
function buildScrapeFailurePayload({
  error = '',
  detail = '',
  modulesVisited = [],
  modulesFailed = [],
  focusModule = '',
  errors = [],
} = {}) {
  const storedCount = getActiveJamaah().length;
  const message = error || 'Gagal mengambil data dari SGO.';
  return {
    success: false,
    fallback: false,
    empty: true,
    error: message,
    detail: detail || message,
    message: storedCount
      ? `Tidak ada data baru dari SGO. Data real yang tersimpan tetap ${storedCount} dan tidak ditampilkan sebagai hasil scrape ini.`
      : 'Tidak ada data dari SGO. Store jamaah tetap kosong (0 data).',
    count: 0,
    jamaahCount: 0,
    storedJamaahCount: storedCount,
    source: null,
    storedSource: getJamaahSource(),
    modules: modulesVisited,
    modulesVisited,
    modulesFailed,
    totalModules: focusModule ? 1 : SGO_MODULES.length,
    focusModule: focusModule || null,
    jamaahList: [],
    sample: [],
    errors,
    ...rawResponseFields(focusModule),
  };
}

/**
 * SGO berhasil diakses, tetapi modul tidak memuat baris jamaah. Ini bukan
 * kegagalan koneksi dan bukan alasan untuk menampilkan data pengganti.
 */
function buildEmptyScrapePayload({ result = {}, focusModule = '' } = {}) {
  const storedCount = getActiveJamaah().length;
  const label = focusModule
    ? getSgoModuleMeta(focusModule)?.label || focusModule
    : 'Semua Modul';
  const summary = Array.isArray(result.summaries)
    ? result.summaries.find((item) => item.modulePath === focusModule)
    : null;

  return {
    success: true,
    fallback: false,
    empty: true,
    moduleLoaded: false,
    cookieSource: result.config?.cookieSource || null,
    usedEnvCookie: Boolean(result.usedEnvCookie),
    requestCookieError: result.requestCookieError || null,
    warning: result.usedEnvCookie
      ? 'Cookie dari UI tidak menghasilkan data; berhasil memakai cookie SGO_ADMIN_SESSION dari .env.'
      : null,
    message: `SGO berhasil diakses, tetapi tidak ada baris jamaah pada ${focusModule ? `modul ${label}` : 'scrape ini'}. Tidak ada data pengganti yang ditampilkan.`,
    count: 0,
    jamaahCount: 0,
    storedJamaahCount: storedCount,
    source: null,
    storedSource: getJamaahSource(),
    modules: result.modulesVisited || [],
    modulesVisited: result.modulesVisited || [],
    modulesFailed: result.modulesFailed || [],
    totalModules: focusModule ? 1 : SGO_MODULES.length,
    focusModule: focusModule || null,
    moduleSummary: summary,
    jamaahList: [],
    sample: [],
    errors: result.errors || [],
    manifest: result.manifestEnrichment || null,
    ...rawResponseFields(focusModule),
  };
}

function focusModuleLoaded(result = {}, focusModule = '') {
  const visited = Array.isArray(result.modulesVisited) ? result.modulesVisited : [];
  if (focusModule) return visited.includes(focusModule);
  return visited.includes('/ops/monitoring-jamaah');
}

function paginationPageCount(result = {}) {
  const entries = Array.isArray(result.pagination) ? result.pagination : [];
  return entries.reduce(
    (total, entry) => total + (Number(entry.pagesFetched) || 0),
    0,
  );
}

function countUniqueRows(rows = [], pick) {
  const set = new Set();
  for (const row of rows) {
    const value = String(pick(row) || '').trim().toUpperCase();
    if (value) set.add(value);
  }
  return set.size;
}

/**
 * Ringkasan agregat sinkronisasi. Tidak berisi NIK/paspor/nomor HP, hanya
 * angka yang aman ditampilkan di UI dan ditulis ke log server.
 */
function buildSyncSummary({
  rows = [],
  stored = [],
  pagination = [],
  manifest = null,
  source = null,
  cache = null,
  modules = [],
  startedAt = 0,
  extra = {},
} = {}) {
  const monitoring = buildMonitoringSummary(stored, source);
  const pagesFetched = pagination.reduce(
    (total, entry) => total + (Number(entry.pagesFetched) || 0),
    0,
  );
  const totalPages = pagination.reduce(
    (total, entry) =>
      total +
      (Number(entry.totalPagesReported) || Number(entry.totalPages) || 0),
    0,
  );
  const manifestOk =
    Number(manifest?.fetched || 0) + Number(manifest?.cacheHits || 0);

  return {
    totalJamaah: stored.length,
    syncedJamaah: rows.length,
    inserted: Number(cache?.inserted || 0),
    updated: Number(cache?.updated || 0),
    documentsUpdated: Number(cache?.documentsUpdated || 0),
    pagesFetched,
    totalPages,
    orders: countUniqueRows(
      stored,
      (row) => row.orderCode || row.kodeOrder || row.orderId,
    ),
    rtb: countUniqueRows(stored, (row) => row.rtb || row.noRtb),
    syncedOrders: countUniqueRows(
      rows,
      (row) => row.orderCode || row.kodeOrder || row.orderId,
    ),
    syncedRtb: countUniqueRows(rows, (row) => row.rtb || row.noRtb),
    complete: monitoring.complete,
    missing: monitoring.incomplete,
    completionRate: monitoring.completionRate,
    manifestOk,
    manifestFailed: Number(manifest?.failed || 0),
    modules: [...new Set((modules || []).filter(Boolean))],
    durationMs: startedAt ? Date.now() - startedAt : 0,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

function formatSyncSummary(summary = {}) {
  return (
    `${Number(summary.totalJamaah || 0).toLocaleString('id-ID')} jamaah tersimpan ` +
    `(${Number(summary.syncedJamaah || 0).toLocaleString('id-ID')} baris sinkron) | ` +
    `dokumen ${Number(summary.documentsUpdated || 0).toLocaleString('id-ID')} diperbarui | ` +
    `${Number(summary.pagesFetched || 0).toLocaleString('id-ID')} halaman | ` +
    `${Number(summary.orders || 0).toLocaleString('id-ID')} order | ` +
    `RTB ${Number(summary.rtb || 0).toLocaleString('id-ID')} | ` +
    `lengkap ${Number(summary.complete || 0).toLocaleString('id-ID')} / ` +
    `missing ${Number(summary.missing || 0).toLocaleString('id-ID')}`
  );
}

function logSyncSummary(summary = {}) {
  console.log(`[SGO] Ringkasan sinkronisasi: ${formatSyncSummary(summary)}`);
}

function beginSyncOrConflict(res, options = {}) {
  const current = getSyncProgress();
  if (current.active) {
    res.status(409).json({
      success: false,
      busy: true,
      error: 'Sinkronisasi SGO sedang berjalan. Tunggu hingga selesai.',
      progress: current,
    });
    return null;
  }
  return startSyncProgress(options);
}

app.post('/api/jamaah/upload', (req, res) => {
  return res.status(410).json({
    success: false,
    error:
      'Upload/paste data dinonaktifkan. Data jamaah hanya boleh berasal dari scrape real-time SGO Admin.',
  });
});

app.post('/api/jamaah/paste', (req, res) => {
  return res.status(410).json({
    success: false,
    error:
      'Paste data dinonaktifkan. Data jamaah hanya boleh berasal dari scrape real-time SGO Admin.',
  });
});

app.post('/api/jamaah/scrape-cookie', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const cookie = String(req.body?.cookie || req.body?.cookies || '').trim();
  const requestedFocus = String(req.body?.focusModule || '').trim();
  const enrichManifest = req.body?.skipManifest !== true;

  let focusModule;
  try {
    focusModule = resolveSgoModule(requestedFocus);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
      supportedModules: supportedModulesPayload(),
    });
  }

  const startedAt = Date.now();
  const started = beginSyncOrConflict(res, {
    label: focusModule
      ? getSgoModuleMeta(focusModule)?.label || focusModule
      : 'Semua Modul SGO',
    modulePath: focusModule || '',
    modules: focusModule ? [focusModule] : SGO_MODULES,
    message: 'Menyiapkan koneksi ke SGO Admin...',
  });
  if (!started) return;

  // Upload Manifest adalah sumber otoritatif dokumen. Saat sync berjalan,
  // setiap halaman langsung di-upsert ke SQLite agar kartu di UI bisa
  // berubah merah -> hijau tanpa menunggu seluruh pagination selesai.
  const trackLiveManifest = !focusModule || isJamaahModule(focusModule);
  let liveSettled = false;
  let liveResult = null;
  const settleLiveManifest = (commit = false) => {
    if (!trackLiveManifest || liveSettled) return liveResult;
    liveSettled = true;
    if (commit) {
      liveResult = commitLiveManifestSync();
    } else {
      rollbackLiveManifestSync();
      liveResult = null;
    }
    return liveResult;
  };
  if (trackLiveManifest) beginLiveManifestSync();

  let fast;
  try {
    fast = await scrapeSgoModules({
      url,
      cookie,
      focusModule,
      enrichManifest,
      onUploadPage: trackLiveManifest
        ? (page) => {
            upsertLiveManifestRows(page?.rows || []);
          }
        : undefined,
    });
  } catch (error) {
    settleLiveManifest(false);
    const message = error.message || 'Gagal scrape SGO Admin';
    console.error(`[SGO] Scrape dibatalkan: ${message}`);
    failSyncProgress(message);
    const status =
      error.code === 'SGO_COOKIE_MISSING'
        ? 428
        : error.code === 'SGO_CONFIG' || error.code === 'SGO_MODULE'
          ? 400
          : 502;
    return res.status(status).json({
      ...buildScrapeFailurePayload({
        error: message,
        detail: message,
        focusModule,
      }),
      code: error.code || 'SGO_ERROR',
      supportedModules: supportedModulesPayload(),
    });
  }

  if (fast.rows.length > 0) {
    // Tutup transaksi live sebelum snapshot final menulis cache penuh.
    const live = settleLiveManifest(true);
    const stored = setJamaahData(fast.rows, {
      type: fast.focus ? 'focused' : 'unified',
      // Modul non-jamaah tidak boleh menimpa data Monitoring Jamaah.
      merge: Boolean(focusModule && !isJamaahModule(focusModule)),
      url: fast.config.baseUrl,
      modules: fast.modulesVisited,
    });
    const jamaahList = formatJamaahList(stored);
    const fieldCoverage = getJamaahSource()?.fieldCoverage || {};
    const pagesFetched = paginationPageCount(fast) || 1;
    const moduleLabel = fast.focus
      ? getSgoModuleMeta(fast.focus)?.label || fast.focus
      : '';
    updateSyncProgress({
      phase: 'saving',
      percent: 95,
      message: 'Menyimpan data jamaah & cache SQLite...',
      detail: `${jamaahList.length.toLocaleString('id-ID')} jamaah`,
      rows: jamaahList.length,
    });
    const cache = ensureManifestCache({ force: true });
    const summary = buildSyncSummary({
      rows: fast.rows,
      stored,
      pagination: fast.pagination || [],
      manifest: fast.manifestEnrichment,
      source: getJamaahSource(),
      cache,
      modules: fast.modulesVisited,
      startedAt,
      extra: live?.documentsUpdated
        ? { documentsUpdated: live.documentsUpdated }
        : {},
    });
    console.log(
      `[SGO] Data jamaah berhasil dimuat: ${jamaahList.length} jamaah | ` +
        `NIK ${fieldCoverage.nik || 0} | Paspor ${fieldCoverage.passport || 0} | ` +
        `Manifest ${fieldCoverage.manifestId || 0} | ` +
        `modul ${fast.modulesVisited.length}/${fast.modulePaths.length} | ` +
        `${pagesFetched} halaman.`,
    );
    console.log(`[SGO] Total jamaah tersimpan: ${jamaahList.length}`);
    logSyncSummary(summary);
    finishSyncProgress({
      message:
        `Sinkronisasi selesai: ${jamaahList.length.toLocaleString('id-ID')} jamaah, ` +
        `${summary.documentsUpdated.toLocaleString('id-ID')} status dokumen diperbarui.`,
      detail:
        `${Number(summary.manifestOk || 0).toLocaleString('id-ID')} manifest OK • ` +
        `${Number(summary.manifestFailed || 0).toLocaleString('id-ID')} gagal`,
      summary,
      rows: jamaahList.length,
      documentsUpdated: summary.documentsUpdated,
      pagesFetched: summary.pagesFetched,
      totalPages: summary.totalPages,
    });

    return res.json({
      success: true,
      fallback: false,
      empty: false,
      cookieSource: fast.config.cookieSource,
      usedEnvCookie: fast.usedEnvCookie,
      requestCookieError: fast.requestCookieError || null,
      warning: fast.usedEnvCookie
        ? 'Cookie dari UI tidak menghasilkan data; berhasil memakai cookie SGO_ADMIN_SESSION dari .env.'
        : null,
      message: fast.focus
        ? `Berhasil memuat ${moduleLabel} — ${jamaahList.length.toLocaleString('id-ID')} jamaah tersimpan dari ${pagesFetched} halaman SGO.`
        : `Berhasil mengindeks ${fast.modulesVisited.length}/${SGO_MODULES.length} modul SGO Admin — ${jamaahList.length.toLocaleString('id-ID')} jamaah tersimpan dari ${pagesFetched} halaman.`,
      count: jamaahList.length,
      storedJamaahCount: jamaahList.length,
      source: getJamaahSource(),
      fieldCoverage,
      manifest: fast.manifestEnrichment || null,
      pagination: fast.pagination || null,
      syncSummary: summary,
      cache: {
        total: cache.total,
        inserted: cache.inserted || 0,
        updated: cache.updated || 0,
        documentsUpdated: cache.documentsUpdated || 0,
        syncedAt: cache.syncedAt,
      },
      modules: fast.modulesVisited,
      modulesFailed: fast.modulesFailed,
      totalModules: fast.focus ? fast.modulePaths.length : SGO_MODULES.length,
      focusModule: fast.focus || null,
      jamaahList,
      sample: jamaahList.slice(0, 3),
      errors: fast.errors,
      ...rawResponseFields(fast.focus || ''),
    });
  }

  // Tidak ada baris jamaah: buang perubahan live agar cache tidak parsial.
  settleLiveManifest(false);

  // Halaman operasional (Hotel, Stock, Travel Docs, Upload Documents) tetap
  // dianggap berhasil dimuat walau tidak memiliki tabel jamaah.
  if (
    focusModule &&
    !isJamaahModule(focusModule) &&
    fast.modulesVisited.includes(focusModule)
  ) {
    console.log(`[SGO] Modul ${focusModule} dimuat tanpa tabel jamaah.`);
    const summary = buildSyncSummary({
      rows: fast.rows,
      stored: getActiveJamaah(),
      pagination: fast.pagination || [],
      source: getJamaahSource(),
      modules: fast.modulesVisited,
      startedAt,
      extra: { moduleLoaded: true },
    });
    finishSyncProgress({
      message: `Modul ${getSgoModuleMeta(focusModule)?.label || focusModule} dimuat.`,
      summary,
    });
    return res.json({
      ...buildModuleLoadedPayload(fast, focusModule),
      syncSummary: summary,
    });
  }

  const failureReason =
    fast.authError?.message ||
    (fast.errors.length ? fast.errors[0].message : 'Tidak ada baris jamaah pada modul yang dipilih.');
  console.error(`[SGO] Fetch cepat tidak menghasilkan data: ${failureReason}`);

  // Fallback Puppeteer hanya untuk satu modul fokus. Untuk unified 16 modul,
  // jalur fetch paralel sudah cukup dan Puppeteer bisa memakan waktu lama.
  if (!fast.authError && fast.focus) {
    try {
      console.log('[SGO] Menjalankan fallback Puppeteer untuk mengambil ulang data real...');
      updateSyncProgress({
        phase: 'browser',
        percent: 70,
        message: 'Mencoba jalur browser SGO (Puppeteer)...',
        detail: 'Fetch cepat tidak menghasilkan data',
      });
      const browserResult = await scrapeSgoWithBrowser({ url, cookie, focusModule });
      if (browserResult.rows.length > 0) {
        const stored = setJamaahData(browserResult.rows, {
          type: 'focused',
          url: fast.config.baseUrl,
          modules: browserResult.modulesVisited,
        });
        const jamaahList = formatJamaahList(stored);
        const fieldCoverage = getJamaahSource()?.fieldCoverage || {};
        const cache = ensureManifestCache({ force: true });
        const summary = buildSyncSummary({
          rows: browserResult.rows,
          stored,
          pagination: browserResult.pagination || [],
          manifest: browserResult.manifestEnrichment,
          source: getJamaahSource(),
          cache,
          modules: browserResult.modulesVisited,
          startedAt,
          extra: { fallback: 'puppeteer' },
        });
        console.log(
          `[SGO] Data jamaah berhasil dimuat (Puppeteer): ${jamaahList.length} jamaah | ` +
            `NIK ${fieldCoverage.nik || 0} | Paspor ${fieldCoverage.passport || 0}.`,
        );
        console.log(`[SGO] Puppeteer berhasil: ${jamaahList.length} jamaah.`);
        logSyncSummary(summary);
        finishSyncProgress({
          message: `Sinkronisasi selesai (browser): ${jamaahList.length.toLocaleString('id-ID')} jamaah.`,
          summary,
        });
        return res.json({
          success: true,
          fallback: false,
          empty: false,
          cookieSource: fast.config.cookieSource,
          usedEnvCookie: fast.usedEnvCookie,
          requestCookieError: fast.requestCookieError || null,
          warning: fast.usedEnvCookie
            ? 'Cookie dari UI tidak menghasilkan data; berhasil memakai cookie SGO_ADMIN_SESSION dari .env.'
            : null,
          message: `Berhasil memuat modul ${fast.focus} (${jamaahList.length} data jamaah)`,
          count: jamaahList.length,
          storedJamaahCount: jamaahList.length,
          source: getJamaahSource(),
          fieldCoverage,
          manifest: browserResult.manifestEnrichment || null,
          syncSummary: summary,
          cache: {
            total: cache.total,
            inserted: cache.inserted || 0,
            updated: cache.updated || 0,
            documentsUpdated: cache.documentsUpdated || 0,
            syncedAt: cache.syncedAt,
          },
          modules: browserResult.modulesVisited,
          modulesFailed: [...new Set([...fast.modulesFailed, ...browserResult.modulesFailed])],
          totalModules: 1,
          focusModule: fast.focus,
          jamaahList,
          sample: jamaahList.slice(0, 3),
          errors: fast.errors,
          ...rawResponseFields(fast.focus),
        });
      }
      console.error('[SGO] Puppeteer juga tidak menemukan data jamaah.');
    } catch (error) {
      console.error(`[SGO] Puppeteer gagal: ${error.message}`);
    }
  }

  // Modul benar-benar terbuka tetapi tidak berisi baris jamaah: kembalikan
  // hasil kosong yang jujur, bukan data lama atau data karangan.
  if (!fast.authError && focusModuleLoaded(fast, focusModule)) {
    console.warn('[SGO] SGO diakses tetapi tidak ada baris jamaah pada hasil scrape.');
    const summary = buildSyncSummary({
      rows: fast.rows,
      stored: getActiveJamaah(),
      pagination: fast.pagination || [],
      source: getJamaahSource(),
      modules: fast.modulesVisited,
      startedAt,
      extra: { empty: true },
    });
    finishSyncProgress({
      message: 'SGO berhasil diakses, tetapi tidak ada baris jamaah.',
      summary,
    });
    return res.json({
      ...buildEmptyScrapePayload({ result: fast, focusModule }),
      syncSummary: summary,
    });
  }

  failSyncProgress(failureReason);
  const status = fast.authError ? 401 : 502;
  return res.status(status).json({
    ...buildScrapeFailurePayload({
      error: fast.authError?.message || failureReason,
      detail: failureReason,
      modulesVisited: fast.modulesVisited,
      modulesFailed: fast.modulesFailed,
      focusModule,
      errors: fast.errors,
    }),
    code: fast.authError?.code || 'SGO_ERROR',
    supportedModules: supportedModulesPayload(),
  });
});

/**
 * Status sinkronisasi SGO in-memory untuk progress bar real-time.
 * Polling ringan; tidak memuat data pribadi.
 */
app.get('/api/jamaah/scrape-progress', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, progress: getSyncProgress() });
});

/**
 * Sinkronisasi ulang satu jamaah langsung dari Upload Manifest SGO.
 * Body: { id, query?, url?, cookie? }. `id` adalah manifestId/jamaahId yang
 * dipakai kartu manifest. Status dokumen, RTB, dan keberangkatan selalu
 * ditimpa data SGO terbaru.
 */
app.post('/api/jamaah/sync-one', async (req, res) => {
  const id = String(
    req.body?.id || req.body?.manifestId || req.body?.jamaahId || '',
  ).trim();
  const url = String(req.body?.url || '').trim();
  const cookie = String(req.body?.cookie || '').trim();

  if (!id) {
    return res.status(400).json({
      success: false,
      error: 'ID jamaah wajib diisi.',
    });
  }

  const existing = findJamaahById(id);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error:
        'Jamaah tidak ditemukan di cache lokal. Jalankan sinkronisasi penuh terlebih dahulu.',
    });
  }

  const startedAt = Date.now();
  const started = beginSyncOrConflict(res, {
    label: `Sinkronisasi ${existing.nama || 'Jamaah'}`,
    modulePath: '/ops/upload-documents',
    modules: ['/ops/upload-documents'],
    message: `Mencari ${existing.nama || 'jamaah'} di SGO...`,
  });
  if (!started) return;

  const query =
    String(req.body?.query || '').trim() ||
    existing.orderCode ||
    existing.kodeOrder ||
    existing.orderId ||
    existing.nama;

  try {
    const result = await fetchSingleJamaahFromSgo({
      url,
      cookie,
      query,
      hints: {
        manifestId: existing.manifestId || existing.jamaahId || id,
        orderCode: existing.orderCode || existing.kodeOrder || existing.orderId,
        nama: existing.nama,
      },
      maxPages: 4,
    });

    if (!result.match) {
      const message =
        `SGO tidak menemukan ${existing.nama || 'jamaah'} ` +
        `(kata kunci: ${query}). Status lama tidak diubah.`;
      failSyncProgress(message);
      return res.status(404).json({
        success: false,
        error: message,
        progress: getSyncProgress(),
      });
    }

    updateSyncProgress({
      phase: 'saving',
      percent: 95,
      message: `Menyimpan status dokumen ${existing.nama || 'jamaah'}...`,
      detail: result.match.dokumen || 'Upload Manifest',
    });

    const upsert = upsertJamaahRows([result.match], {
      type: 'single-sync',
      replaceDocuments: true,
      modules: ['/ops/upload-documents'],
      url: result.config.baseUrl,
    });
    const cache = ensureManifestCache({ force: true });
    const stored = getJamaahData();
    const updated =
      findJamaahById(result.match.manifestId || id) ||
      stored.find(
        (row) =>
          String(row.orderCode || '').toUpperCase() ===
            String(result.match.orderCode || '').toUpperCase() &&
          String(row.nama || '').toLowerCase() ===
            String(result.match.nama || '').toLowerCase(),
      ) ||
      existing;

    const safe = buildSafeJamaahRow(updated, 0);
    const summary = buildSyncSummary({
      rows: [result.match],
      stored,
      pagination: [result.pagination].filter(Boolean),
      source: getJamaahSource(),
      cache,
      modules: ['/ops/upload-documents'],
      startedAt,
      extra: {
        target: {
          id: updated.manifestId || updated.jamaahId || id,
          nama: safe.nama,
          orderCode: safe.orderCode,
          progressLabel: safe.progressLabel,
          isComplete: safe.isComplete,
        },
      },
    });
    logSyncSummary(summary);
    finishSyncProgress({
      message:
        `${safe.nama}: ${safe.progressLabel} dokumen terisi` +
        (safe.isComplete ? ' (lengkap).' : `, ${safe.missing.length} belum ada.`),
      summary,
    });

    return res.json({
      success: true,
      message: `Status dokumen ${safe.nama} diperbarui dari SGO.`,
      jamaah: {
        ...safe,
        id: updated.manifestId || updated.jamaahId || safe.id,
        manifestId: updated.manifestId || '',
        jamaahId: updated.jamaahId || '',
      },
      upsert,
      cache: {
        total: cache.total,
        inserted: cache.inserted || 0,
        updated: cache.updated || 0,
        documentsUpdated: cache.documentsUpdated || 0,
        syncedAt: cache.syncedAt,
      },
      syncSummary: summary,
      pagination: result.pagination || null,
    });
  } catch (error) {
    const message = error.message || 'Sinkronisasi satu jamaah gagal.';
    console.error(`[SGO] Sync satu jamaah gagal: ${message}`);
    failSyncProgress(message);
    const status = error.code === 'SGO_COOKIE_MISSING' ? 428 : 502;
    return res.status(status).json({
      success: false,
      code: error.code || 'SGO_ERROR',
      error: message,
    });
  }
});

/**
 * Fetch ringan (tanpa Puppeteer) memakai cookie SGO perangkat.
 * Body opsional: { modulePath, url }
 */
app.post('/api/jamaah/fetch-env', async (req, res) => {
  const requestedModule = String(req.body?.modulePath || '/ops/monitoring-jamaah').trim();
  const url = String(req.body?.url || '').trim();
  const cookie = String(req.body?.cookie || '').trim();

  let modulePath;
  try {
    modulePath = resolveSgoModule(requestedModule) || SGO_MODULES[0];
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
      supportedModules: supportedModulesPayload(),
    });
  }

  try {
    const result = await scrapeSgoModules({ url, cookie, focusModule: modulePath });

    if (result.rows.length > 0) {
      const stored = setJamaahData(result.rows, {
        type: isJamaahModule(modulePath) ? 'focused' : 'fetch-env',
        merge: !isJamaahModule(modulePath),
        url: result.config.baseUrl,
        modules: result.modulesVisited,
      });
      const jamaahList = formatJamaahList(stored);
      const fieldCoverage = getJamaahSource()?.fieldCoverage || {};
      ensureManifestCache({ force: true });
      console.log(
        `[SGO] Data jamaah berhasil dimuat (fetch-env ${modulePath}): ` +
          `${jamaahList.length} jamaah | NIK ${fieldCoverage.nik || 0} | ` +
          `Paspor ${fieldCoverage.passport || 0}.`,
      );

      return res.json({
        success: true,
        fallback: false,
        empty: false,
        cookieSource: result.config.cookieSource,
        usedEnvCookie: result.usedEnvCookie,
        requestCookieError: result.requestCookieError || null,
        warning: result.usedEnvCookie
          ? 'Cookie dari UI tidak menghasilkan data; berhasil memakai cookie SGO_ADMIN_SESSION dari .env.'
          : null,
        message: `Berhasil memuat ${jamaahList.length} data jamaah dari ${modulePath}`,
        count: jamaahList.length,
        storedJamaahCount: jamaahList.length,
        modules: result.modulesVisited,
        modulesFailed: result.modulesFailed,
        source: getJamaahSource(),
        fieldCoverage,
        manifest: result.manifestEnrichment || null,
        pagination: result.pagination || null,
        jamaahList,
        sample: jamaahList.slice(0, 3),
        ...rawResponseFields(modulePath),
      });
    }

    if (
      !isJamaahModule(modulePath) &&
      result.modulesVisited.includes(modulePath)
    ) {
      console.log(`[SGO] fetch-env ${modulePath} dimuat tanpa tabel jamaah.`);
      return res.json(buildModuleLoadedPayload(result, modulePath));
    }

    const reason =
      result.authError?.message ||
      'Tidak ada tabel data pada halaman. Pastikan cookie valid dan modul dapat diakses.';
    console.error(`[SGO] fetch-env ${modulePath} gagal: ${reason}`);

    if (!result.authError && focusModuleLoaded(result, modulePath)) {
      return res.json(buildEmptyScrapePayload({ result, focusModule: modulePath }));
    }

    return res.status(result.authError ? 401 : 502).json({
      ...buildScrapeFailurePayload({
        error: result.authError?.message || reason,
        detail: reason,
        modulesVisited: result.modulesVisited,
        modulesFailed: result.modulesFailed,
        focusModule: modulePath,
        errors: result.errors,
      }),
      targetUrl: `${result.config.baseUrl}${modulePath}`,
      code: result.authError?.code || 'SGO_ERROR',
      supportedModules: supportedModulesPayload(),
    });
  } catch (error) {
    console.error('[jamaah/fetch-env]', error.message);
    const status =
      error.code === 'SGO_COOKIE_MISSING'
        ? 428
        : error.code === 'SGO_CONFIG' || error.code === 'SGO_MODULE'
          ? 400
          : 502;
    return res.status(status).json({
      ...buildScrapeFailurePayload({
        error: error.message || 'Gagal fetch SGO Admin',
        detail: error.message || 'Gagal fetch SGO Admin',
        focusModule: modulePath,
      }),
      code: error.code || 'SGO_ERROR',
      supportedModules: supportedModulesPayload(),
    });
  }
});

app.post('/api/jamaah/clear', (req, res) => {
  clearJamaahData('POST /api/jamaah/clear');
  resetSyncProgress();
  res.json({
    success: true,
    count: 0,
    message:
      'Data jamaah real dihapus. Store sekarang kosong (0 data); jalankan scrape Monitoring Jamaah untuk mengisi ulang.',
  });
});

app.get('/api/health', (req, res) => {
  const ai = getAIStatus();
  const rawStatus = getSgoRawStatus();
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    aiProvider: ai.provider,
    aiModel: ai.activeModel,
    aiReady: ai.ready,
    aiFallback: ai.fallbackActive,
    aiKeyConfigured: ai.keyConfigured,
    aiTimeoutMs: ai.timeoutMs,
    sgoModules: SGO_MODULES,
    sgoRawResponses: rawStatus.filter((item) => item?.response).length,
    sgoRawModules: rawStatus.length,
  });
});

app.get('/api/sgo/modules', (req, res) => {
  res.json({
    success: true,
    total: SGO_MODULE_OPTIONS.length,
    modules: supportedModulesPayload(),
  });
});

app.get('/api/sgo/cookie', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const active = Boolean(getRequestSgoCookieHeader());
  return res.json(sgoCookieStatusPayload(active));
});

app.post('/api/sgo/cookie', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const raw = String(req.body?.cookie ?? req.body?.cookies ?? '').trim();
  const sessionCookie = toSgoSessionCookieHeader(raw);

  if (!sessionCookie) {
    return res.status(400).json({
      success: false,
      code: 'SGO_COOKIE_INVALID',
      error:
        'Cookie SGO tidak valid. Tempel nilai sgo_admin_session=... atau token sesi dari SGO Admin.',
    });
  }

  if (sessionCookie.length > 4096) {
    return res.status(400).json({
      success: false,
      code: 'SGO_COOKIE_TOO_LARGE',
      error: 'Cookie SGO terlalu panjang. Tempel hanya pasangan sgo_admin_session.',
    });
  }

  res.cookie(
    SGO_DEVICE_COOKIE_NAME,
    sessionCookie,
    sgoDeviceCookieOptions({ secure: req.secure }),
  );
  return res.json(
    sgoCookieStatusPayload(true, 'Cookie SGO tersimpan di perangkat ini.'),
  );
});

app.delete('/api/sgo/cookie', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.clearCookie(SGO_DEVICE_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure),
    path: '/',
  });
  return res.json(
    sgoCookieStatusPayload(false, 'Cookie SGO dihapus dari perangkat ini.'),
  );
});

app.post('/api/sgo/cookie/test', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const raw = String(req.body?.cookie ?? req.body?.cookies ?? '').trim();
  const candidate = raw ? toSgoSessionCookieHeader(raw) : '';
  const saved = getRequestSgoCookieHeader();

  if (raw && !candidate) {
    return res.status(400).json({
      success: false,
      active: Boolean(saved),
      state: saved ? 'active' : 'empty',
      code: 'SGO_COOKIE_INVALID',
      error:
        'Cookie SGO tidak valid. Tempel nilai sgo_admin_session=... atau token sesi dari SGO Admin.',
    });
  }

  const cookie = candidate || saved;
  if (!cookie) {
    return res.status(428).json({
      success: false,
      active: false,
      state: 'empty',
      tested: 'saved',
      code: 'SGO_COOKIE_MISSING',
      error:
        'Cookie SGO belum diatur di perangkat ini. Tempel cookie lalu klik Simpan Cookie.',
    });
  }

  const result = await verifySgoCookie({ url: req.body?.url, cookie });
  const tested = candidate ? 'candidate' : 'saved';

  if (!result.ok) {
    const status =
      result.code === 'SGO_AUTH' || result.code === 'SGO_COOKIE_MISSING'
        ? 401
        : result.code === 'SGO_TIMEOUT'
          ? 504
          : 502;
    return res.status(status).json({
      success: false,
      active: Boolean(saved),
      state:
        !candidate && result.code === 'SGO_AUTH'
          ? 'expired'
          : saved
            ? 'active'
            : 'empty',
      tested,
      code: result.code,
      error: result.message,
    });
  }

  return res.json({
    success: true,
    active: Boolean(saved),
    state: saved ? 'active' : 'empty',
    tested,
    message: result.message,
    status: result.status,
  });
});

/**
 * Status respons mentah SGO. HTML tidak pernah dikirim ke klien karena file
 * tersebut memuat PII jamaah. Hanya metadata dan ringkasan halaman.
 */
app.get('/api/sgo/responses', (req, res) => {
  const requested = String(req.query.modulePath || '').trim();
  if (requested) {
    let modulePath;
    try {
      modulePath = resolveSgoModule(requested);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
        supportedModules: supportedModulesPayload(),
      });
    }
    const meta = getSgoRawStatusFor(modulePath);
    if (!meta) {
      return res.status(404).json({
        success: false,
        error: `Respons mentah untuk ${modulePath} tidak dipersistensikan.`,
        persistedModules: SGO_RAW_MODULES,
      });
    }
    return res.json({
      success: true,
      module: {
        ...meta,
        label: getSgoModuleMeta(modulePath)?.label || modulePath,
      },
    });
  }

  const modules = getSgoRawStatus().map((meta) => ({
    ...meta,
    label: getSgoModuleMeta(meta.modulePath)?.label || meta.modulePath,
  }));
  return res.json({
    success: true,
    total: modules.length,
    withResponse: modules.filter((item) => item.response).length,
    modules,
  });
});

app.get('/api/ai/status', (req, res) => {
  try {
    res.json({ success: true, ...getAIStatus(), hasRealJamaah: hasRealJamaahData() });
  } catch (error) {
    res.json({ success: true, ready: false, provider: 'gemini', error: error.message });
  }
});

app.get('/api/jamaah/status', (req, res) => {
  try {
    const count = Array.isArray(getActiveJamaah()) ? getActiveJamaah().length : 0;
    res.json({
      success: true,
      hasRealData: hasRealJamaahData(),
      empty: count === 0,
      source: getJamaahSource(),
      count,
      rawResponses: getSgoRawStatus(),
    });
  } catch (e) {
    res.json({
      success: true,
      hasRealData: false,
      empty: true,
      source: null,
      count: 0,
      rawResponses: [],
    });
  }
});

app.get('/api/jamaah', (req, res) => {
  try {
    const raw = typeof getJamaahData === 'function' ? getJamaahData() : getActiveJamaah();
    const data = Array.isArray(raw) ? raw : [];
    const jamaahList = formatJamaahList(data);
    res.json({
      success: true,
      hasReal: hasRealJamaahData(),
      empty: jamaahList.length === 0,
      source: getJamaahSource(),
      count: jamaahList.length,
      data,
      jamaahList,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      hasReal: false,
      empty: true,
      count: 0,
      data: [],
      jamaahList: [],
      error: error.message,
    });
  }
});

app.post('/api/index-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL wajib diisi' });
    const result = await scrapeWebContext(url);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      const reply = 'Pesan wajib diisi.';
      return res.status(400).json({
        success: false,
        reply,
        response: reply,
        message: reply,
        source: 'error',
        intent: 'empty',
      });
    }

    const result = await processChat(message);
    const aiReply =
      String(result?.reply || '').trim() ||
      'Maaf, saya belum bisa menjawab pesan itu. Silakan coba lagi.';
    const bridgeResult = buildChatJamaahResults(message, result);
    const addonResult = searchAddonsForChat(message);
    const addonReply = formatAddonChatReply(addonResult);
    const addonPreferred =
      Boolean(addonReply) && /\b(add[\s-]?ons?|tambahan)\b/i.test(message);
    const exactOrder = bridgeResult?.exactOrder === true;
    const bridgeReply =
      exactOrder && bridgeResult.reply ? bridgeResult.reply : aiReply;
    const reply = addonPreferred ? addonReply : bridgeReply;

    let jamaahResults = null;
    if (bridgeResult) {
      // `reply` hanya dipakai untuk override teks; payload ke UI cukup field
      // hasil pencarian yang aman.
      const { reply: _exactReply, ...safePayload } = bridgeResult;
      jamaahResults = safePayload;
    }

    res.json({
      success: true,
      reply,
      response: reply,
      message: reply,
      intent: addonPreferred
        ? 'addon-lookup'
        : exactOrder
          ? 'data-lookup'
          : result.intent,
      source: addonPreferred
        ? 'addon-data'
        : exactOrder
          ? 'jamaah-data'
          : result.source,
      provider: addonPreferred
        ? 'sgo'
        : exactOrder
          ? 'sgo'
          : result.source === 'gemini'
            ? 'gemini'
            : result.source === 'jamaah-data'
              ? 'sgo'
              : 'local',
      model: result.model || null,
      usedJamaahLookup:
        addonPreferred || exactOrder
          ? true
          : Boolean(result.usedJamaahLookup),
      matchedCount: addonPreferred
        ? addonResult?.totalMatched ?? null
        : exactOrder
          ? bridgeResult.totalMatched
          : result.matchedCount ?? null,
      jamaahResults,
      addonResults: addonResult || null,
      latencyMs: result.latencyMs ?? null,
    });
  } catch (error) {
    console.error('[chat]', error.message);
    const reply = 'Maaf, terjadi kendala pada server. Silakan coba lagi.';
    res.status(500).json({
      success: false,
      reply,
      response: reply,
      message: reply,
      source: 'error',
      intent: 'error',
    });
  }
});

app.get('/api/seats', (req, res) => {
  // Tidak ada sumber seat real yang terhubung. Jangan pernah mengisi angka
  // seat dari database mock; tampilkan kosong secara jujur.
  res.json({
    success: true,
    available: false,
    source: null,
    count: 0,
    message:
      'Belum ada integrasi sumber data seat real. Data seat tidak ditampilkan agar tidak menampilkan angka fiktif.',
    seats: [],
  });
});

app.get('/api/runtime', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const vercel = isVercelRuntime();
  const ai = getAIStatus();
  const missing = [];
  if (!ai.keyConfigured) missing.push('GEMINI_API_KEY');
  if (!process.env.SGO_BASE_URL) missing.push('SGO_BASE_URL(optional)');
  res.json({
    success: true,
    runtime: vercel ? 'vercel' : 'node',
    vercel,
    nodeEnv: NODE_ENV,
    aiReady: ai.ready,
    aiKeyConfigured: ai.keyConfigured,
    missingEnv: missing.filter((item) => !item.endsWith('(optional)')),
    optionalEnv: missing.filter((item) => item.endsWith('(optional)')).map((item) => item.replace('(optional)', '')),
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found.`,
    code: 'ROUTE_NOT_FOUND',
  });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON body.',
      code: 'INVALID_JSON',
    });
  }
  console.error('[server]', error);
  const message = isVercelRuntime()
    ? 'Internal server error.'
    : error?.message || 'Internal server error.';
  return res.status(500).json({
    success: false,
    error: message,
    code: 'INTERNAL_SERVER_ERROR',
  });
});

if (!isVercelRuntime()) {
  const server = app.listen(PORT, () => {
    const ai = getAIStatus();
    console.log(`\n🕌 Umrah & Hajj AI Assistant`);
    console.log(`   Server   : http://localhost:${PORT}`);
    console.log(`   AI       : gemini ${ai.ready ? `[READY] -> ${ai.activeModel}` : '[NO KEY]'}`);
    console.log(`   Models   : ${ai.models.join(' | ')}`);
    const envSessionLength = getEnvSession().length;
    const jamaahCount = getActiveJamaah().length;
    const coverage = getJamaahSource()?.fieldCoverage || {};
    const rawStored = getSgoRawStatus().filter((item) => item?.response).length;
    console.log(
      `   Jamaah   : ${jamaahCount} data permanen | NIK ${coverage.nik || 0} | Paspor ${coverage.passport || 0} | Manifest ${coverage.manifestId || 0}`,
    );
    console.log(`   Data     : ${getJamaahDataFilePath()}`);
    console.log(
      `   SGO Raw  : ${rawStored}/${SGO_RAW_MODULES.length} respons modul tersimpan`,
    );
    console.log(
      `   SGO Cookie: per perangkat via tombol Cookie SGO${envSessionLength ? ` | .env portal tersedia (${envSessionLength} karakter)` : ''}`,
    );
    console.log(
      `   Endpoints: POST /api/chat | POST /api/message/rapihin | GET /api/jamaah | GET /api/monitoring/summary | GET /api/manifest/docs | POST /api/jamaah/scrape-cookie`,
    );
    console.log(`   Health   : GET /api/health\n`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Change PORT in .env or stop the other process.`);
    } else {
      console.error('❌ Server error:', error.message);
    }
    process.exit(1);
  });
}

export default app;
