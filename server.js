import 'dotenv/config';

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
import { getJamaahAiIndex } from './services/jamaahAiIndex.js';
import {
  SGO_MODULES,
  SGO_MODULE_OPTIONS,
  fetchSingleJamaahFromSgo,
  formatJamaahList,
  getSgoModuleMeta,
  isJamaahModule,
  resolveSgoModule,
  scrapeSgoLocal,
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
const UPLOAD_DOCUMENTS_PATH = '/ops/upload-documents';
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

app.post('/api/jamaah/full-sync', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const requestedFocus = String(req.body?.focusModule || '').trim();
  let focusModule = '';
  try {
    focusModule = resolveSgoModule(requestedFocus);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: error.code || 'SGO_MODULE',
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

  let result;
  try {
    result = await scrapeSgoLocal({
      url,
      focusModule,
      enrichManifest: true,
      onProgress: (patch) => updateSyncProgress(patch),
      onUploadPage: trackLiveManifest
        ? (page) => upsertLiveManifestRows(page?.rows || [])
        : undefined,
    });
  } catch (error) {
    settleLiveManifest(false);
    const message = error.message || 'Gagal scrape SGO Admin';
    console.error(`[SGO] Sinkronisasi penuh dibatalkan: ${message}`);
    failSyncProgress(message);
    const status =
      error.code === 'SGO_COOKIE_MISSING'
        ? 428
        : error.code === 'SGO_CONFIG' || error.code === 'SGO_MODULE'
          ? 400
          : error.code === 'SGO_AUTH'
            ? 401
            : 502;
    return res.status(status).json({
      success: false,
      error: message,
      code: error.code || 'SGO_ERROR',
      detail: message,
      focusModule: focusModule || null,
      supportedModules: supportedModulesPayload(),
    });
  }

  if (result.rows.length === 0) {
    settleLiveManifest(false);
    const reason =
      result.errors.find((entry) => entry.message)?.message ||
      'Tidak ada baris jamaah pada modul yang dipilih.';

    if (
      focusModule &&
      !isJamaahModule(focusModule) &&
      result.modulesVisited.includes(focusModule)
    ) {
      const summary = buildSyncSummary({
        rows: [],
        stored: getActiveJamaah(),
        pagination: result.pagination || [],
        source: getJamaahSource(),
        modules: result.modulesVisited,
        startedAt,
        extra: { moduleLoaded: true },
      });
      finishSyncProgress({
        message: `Modul ${getSgoModuleMeta(focusModule)?.label || focusModule} dimuat.`,
        summary,
      });
      return res.json({
        ...buildModuleLoadedPayload(result, focusModule),
        syncSummary: summary,
      });
    }

    if (focusModuleLoaded(result, focusModule)) {
      const summary = buildSyncSummary({
        rows: [],
        stored: getActiveJamaah(),
        pagination: result.pagination || [],
        source: getJamaahSource(),
        modules: result.modulesVisited,
        startedAt,
        extra: { empty: true },
      });
      finishSyncProgress({
        message: 'SGO berhasil diakses, tetapi tidak ada baris jamaah.',
        summary,
      });
      return res.json({
        ...buildEmptyScrapePayload({ result, focusModule }),
        syncSummary: summary,
      });
    }

    failSyncProgress(reason);
    return res.status(502).json({
      success: false,
      error: reason,
      code: 'SGO_EMPTY',
      detail: reason,
      focusModule: focusModule || null,
      errors: result.errors,
      supportedModules: supportedModulesPayload(),
    });
  }

  const live = settleLiveManifest(true);
  const stored = setJamaahData(result.rows, {
    type: focusModule ? 'focused' : 'full-sync',
    merge: Boolean(focusModule && !isJamaahModule(focusModule)),
    url: result.config.baseUrl,
    modules: result.modulesVisited,
  });
  const jamaahList = formatJamaahList(stored);
  const fieldCoverage = getJamaahSource()?.fieldCoverage || {};
  updateSyncProgress({
    phase: 'saving',
    percent: 98,
    message: 'Menyimpan data jamaah, cache, dan indeks AI...',
    detail: `${stored.length.toLocaleString('id-ID')} jamaah tersimpan`,
    rows: stored.length,
  });

  const cache = ensureManifestCache({ force: true });
  const aiIndex = getJamaahAiIndex();
  const manifest = result.manifestEnrichment || null;
  const validation = {
    total: Number(manifest?.eligible) || 0,
    processed: Number(manifest?.selected) || 0,
    ok: Number(manifest?.fetched || 0) + Number(manifest?.cacheHits || 0),
    failed: Number(manifest?.failed) || 0,
    skipped: Number(manifest?.skipped) || 0,
    recovered: Number(manifest?.recovered) || 0,
    cacheHits: Number(manifest?.cacheHits) || 0,
    withNik: Number(manifest?.withNik) || 0,
    withPassport: Number(manifest?.withPassport) || 0,
    failures: Array.isArray(manifest?.failures) ? manifest.failures : [],
  };
  const summary = buildSyncSummary({
    rows: result.rows,
    stored,
    pagination: result.pagination || [],
    manifest,
    source: getJamaahSource(),
    cache,
    modules: result.modulesVisited,
    startedAt,
    extra: {
      ...(live?.documentsUpdated ? { documentsUpdated: live.documentsUpdated } : {}),
      validationProcessed: validation.processed,
      validationTotal: validation.total,
      validationFailed: validation.failed,
      validationSkipped: validation.skipped,
      aiIndexLoaded: Boolean(aiIndex),
    },
  });

  console.log(
    `[SGO] Full sync selesai: ${result.rows.length} baris sinkron | ` +
      `${stored.length} total tersimpan | NIK ${fieldCoverage.nik || 0} | ` +
      `Paspor ${fieldCoverage.passport || 0} | Manifest ${fieldCoverage.manifestId || 0} | ` +
      `${result.stats?.pagesFetched || 0} halaman.`,
  );
  logSyncSummary(summary);
  finishSyncProgress({
    message: `Sinkronisasi penuh selesai: ${stored.length.toLocaleString('id-ID')} jamaah • validasi ${validation.processed.toLocaleString('id-ID')}/${validation.total.toLocaleString('id-ID')}.`,
    detail:
      `${validation.ok.toLocaleString('id-ID')} manifest OK • ` +
      `${validation.failed.toLocaleString('id-ID')} gagal`,
    summary,
    rows: stored.length,
    documentsUpdated: summary.documentsUpdated,
    pagesFetched: summary.pagesFetched,
    totalPages: summary.totalPages,
  });

  return res.json({
    success: true,
    message: focusModule
      ? `Sinkronisasi ${getSgoModuleMeta(focusModule)?.label || focusModule} selesai: ${stored.length.toLocaleString('id-ID')} jamaah tersimpan.`
      : `Sinkronisasi penuh selesai: ${stored.length.toLocaleString('id-ID')} jamaah dari ${result.stats?.pagesFetched || 0} halaman.`,
    count: stored.length,
    syncedJamaah: result.rows.length,
    storedJamaahCount: stored.length,
    records: jamaahList,
    jamaahList,
    sample: jamaahList.slice(0, 3),
    source: getJamaahSource(),
    fieldCoverage,
    manifest,
    pagination: result.pagination || [],
    syncSummary: summary,
    validation,
    aiIndex: aiIndex
      ? {
          version: aiIndex.version,
          generatedAt: aiIndex.generatedAt,
          summary: aiIndex.summary,
          summaryText: aiIndex.summaryText,
        }
      : null,
    cache: {
      total: cache.total,
      inserted: cache.inserted || 0,
      updated: cache.updated || 0,
      documentsUpdated: cache.documentsUpdated || 0,
      syncedAt: cache.syncedAt,
    },
    modules: result.modulesVisited,
    modulesFailed: result.modulesFailed,
    totalModules: focusModule ? result.modulePaths.length : SGO_MODULES.length,
    focusModule: focusModule || null,
    errors: result.errors,
    ...rawResponseFields(focusModule),
  });
});

app.get('/api/jamaah/scrape-progress', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, progress: getSyncProgress() });
});


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
    const aiIndex = getJamaahAiIndex();
    res.json({
      success: true,
      ...getAIStatus(),
      hasRealJamaah: hasRealJamaahData(),
      aiIndex: aiIndex
        ? {
            version: aiIndex.version,
            generatedAt: aiIndex.generatedAt,
            summary: aiIndex.summary,
            summaryText: aiIndex.summaryText,
          }
        : null,
    });
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
      aiIndex: getJamaahAiIndex()
        ? {
            generatedAt: getJamaahAiIndex().generatedAt,
            summary: getJamaahAiIndex().summary,
            summaryText: getJamaahAiIndex().summaryText,
          }
        : null,
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
  const ai = getAIStatus();
  const missing = [];
  if (!ai.keyConfigured) missing.push('GEMINI_API_KEY');
  if (!process.env.SGO_BASE_URL) missing.push('SGO_BASE_URL(optional)');
  res.json({
    success: true,
    runtime: 'node',
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
  const message = error?.message || 'Internal server error.';
  return res.status(500).json({
    success: false,
    error: message,
    code: 'INTERNAL_SERVER_ERROR',
  });
});

{
  const server = app.listen(PORT, () => {
    const ai = getAIStatus();
    console.log(`\n🕌 Umrah & Hajj AI Assistant`);
    console.log(`   Server   : http://localhost:${PORT}`);
    console.log(`   AI       : gemini ${ai.ready ? `[READY] -> ${ai.activeModel}` : '[NO KEY]'}`);
    console.log(`   Models   : ${ai.models.join(' | ')}`);
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
    console.log('   SGO Cookie: per perangkat via tombol Cookie SGO');
    console.log(
      '   Endpoints: POST /api/chat | GET /api/jamaah | POST /api/jamaah/full-sync | GET /api/jamaah/scrape-progress | GET /api/health',
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
