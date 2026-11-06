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
  formatJamaahList,
  getEnvSession,
  getSgoModuleMeta,
  isJamaahModule,
  resolveSgoModule,
  scrapeSgoModules,
  scrapeSgoWithBrowser,
  validateSgoEnv,
} from './services/sgoScraper.js';
import {
  SGO_RAW_MODULES,
  getSgoRawStatus,
  getSgoRawStatusFor,
} from './data/sgoRawStore.js';
import monitoringRoutes from './routes/monitoringRoutes.js';
import manifestRoutes from './routes/manifestRoutes.js';

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
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/manifest', manifestRoutes);

function supportedModulesPayload() {
  return SGO_MODULE_OPTIONS.map(({ path, label, jamaahSource }) => ({
    path,
    label,
    jamaahSource,
  }));
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

  let fast;
  try {
    fast = await scrapeSgoModules({ url, cookie, focusModule });
  } catch (error) {
    const message = error.message || 'Gagal scrape SGO Admin';
    console.error(`[SGO] Scrape dibatalkan: ${message}`);
    const status = error.code === 'SGO_CONFIG' || error.code === 'SGO_MODULE' ? 400 : 502;
    return res.status(status).json({
      ...buildScrapeFailurePayload({
        error: message,
        detail: message,
        focusModule,
      }),
      supportedModules: supportedModulesPayload(),
    });
  }

  if (fast.rows.length > 0) {
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
    console.log(
      `[SGO] Data jamaah berhasil dimuat: ${jamaahList.length} jamaah | ` +
        `NIK ${fieldCoverage.nik || 0} | Paspor ${fieldCoverage.passport || 0} | ` +
        `Manifest ${fieldCoverage.manifestId || 0} | ` +
        `modul ${fast.modulesVisited.length}/${fast.modulePaths.length} | ` +
        `${pagesFetched} halaman.`,
    );
    console.log(`[SGO] Total jamaah tersimpan: ${jamaahList.length}`);

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

  // Halaman operasional (Hotel, Stock, Travel Docs, Upload Documents) tetap
  // dianggap berhasil dimuat walau tidak memiliki tabel jamaah.
  if (
    focusModule &&
    !isJamaahModule(focusModule) &&
    fast.modulesVisited.includes(focusModule)
  ) {
    console.log(`[SGO] Modul ${focusModule} dimuat tanpa tabel jamaah.`);
    return res.json(buildModuleLoadedPayload(fast, focusModule));
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
      const browserResult = await scrapeSgoWithBrowser({ url, cookie, focusModule });
      if (browserResult.rows.length > 0) {
        const stored = setJamaahData(browserResult.rows, {
          type: 'focused',
          url: fast.config.baseUrl,
          modules: browserResult.modulesVisited,
        });
        const jamaahList = formatJamaahList(stored);
        const fieldCoverage = getJamaahSource()?.fieldCoverage || {};
        console.log(
          `[SGO] Data jamaah berhasil dimuat (Puppeteer): ${jamaahList.length} jamaah | ` +
            `NIK ${fieldCoverage.nik || 0} | Paspor ${fieldCoverage.passport || 0}.`,
        );
        console.log(`[SGO] Puppeteer berhasil: ${jamaahList.length} jamaah.`);
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
    return res.json(buildEmptyScrapePayload({ result: fast, focusModule }));
  }

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
    supportedModules: supportedModulesPayload(),
  });
});

/**
 * Fetch ringan (tanpa Puppeteer) memakai cookie dari process.env.SGO_ADMIN_SESSION.
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
      supportedModules: supportedModulesPayload(),
    });
  } catch (error) {
    console.error('[jamaah/fetch-env]', error.message);
    const status = error.code === 'SGO_CONFIG' || error.code === 'SGO_MODULE' ? 400 : 502;
    return res.status(status).json({
      ...buildScrapeFailurePayload({
        error: error.message || 'Gagal fetch SGO Admin',
        detail: error.message || 'Gagal fetch SGO Admin',
        focusModule: modulePath,
      }),
      supportedModules: supportedModulesPayload(),
    });
  }
});

app.post('/api/jamaah/clear', (req, res) => {
  clearJamaahData('POST /api/jamaah/clear');
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
    const exactOrder = bridgeResult?.exactOrder === true;
    const reply = exactOrder && bridgeResult.reply ? bridgeResult.reply : aiReply;

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
      intent: exactOrder ? 'data-lookup' : result.intent,
      source: exactOrder ? 'jamaah-data' : result.source,
      provider: exactOrder
        ? 'sgo'
        : result.source === 'gemini'
          ? 'gemini'
          : result.source === 'jamaah-data'
            ? 'sgo'
            : 'local',
      model: result.model || null,
      usedJamaahLookup: exactOrder ? true : Boolean(result.usedJamaahLookup),
      matchedCount: exactOrder
        ? bridgeResult.totalMatched
        : result.matchedCount ?? null,
      jamaahResults,
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

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.originalUrl} not found.` });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ success: false, error: 'Invalid JSON body.' });
  }
  console.error('[server]', error);
  return res.status(500).json({ success: false, error: 'Internal server error.' });
});

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
    `   SGO Cookie: ${envSessionLength ? `SET (.env, ${envSessionLength} karakter)` : 'NOT SET (.env)'}`,
  );
  if (!envSessionLength) validateSgoEnv();
  console.log(
    `   Endpoints: POST /api/chat | GET /api/jamaah | GET /api/monitoring/summary | GET /api/manifest/docs | POST /api/jamaah/scrape-cookie`,
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

export default app;
