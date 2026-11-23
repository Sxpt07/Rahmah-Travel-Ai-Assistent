// Umrah AI Assistant Dashboard - Frontend JavaScript
const API_BASE = window.location.origin;

// State
let activeContextUrl = null;
let isIndexing = false;
let isSending = false;
let welcomeTemplate = '';
let chatBaseStatus = { label: 'Online • siap membantu', tone: 'online' };
const CHAT_MAX_LENGTH = 2000;
const SGO_MODULES = [
  {
    path: '/ops/monitoring-jamaah',
    label: 'Monitoring Jamaah',
    hint: 'Data jamaah, NIK, paspor, RTB, dan manifest real-time.',
  },
  {
    path: '/ops/upload-documents',
    label: 'Upload Manifest',
    hint: 'Cek kelengkapan dokumen dan manifest jamaah.',
    cta: 'Sinkronkan Manifest',
  },
  {
    path: '/ops/worksheet-perlengkapan',
    label: 'Worksheet Perlengkapan',
    hint: 'Pemesan, jamaah, telepon, paket, RTB, keberangkatan, dan ukuran jaket.',
    cta: 'Muat Ulang Worksheet',
    viewOnly: true,
  },
  {
    path: '/ops/fu-pelunasan',
    label: 'FU Pelunasan',
    hint: 'Penagihan aging RED, sisa tagihan, link invoice, dan template WhatsApp.',
    cta: 'Muat Ulang FU Pelunasan',
    viewOnly: true,
    refreshEvent: 'umrah:fu-pelunasan-refresh',
  },
  {
    path: '/ops/add-on',
    label: 'Add-on Per Batch',
    hint: 'Rekap add-on per jenis, pencarian RTB/nama/order, dan rincian jamaah per batch.',
    cta: 'Sinkronkan Add-on',
    viewOnly: true,
    refreshEvent: 'umrah:addon-refresh',
  },
];
const SGO_MODULE_PATHS = SGO_MODULES.map((module) => module.path);
const DEFAULT_MODULE_PATH = SGO_MODULES[0].path;

function sgoModuleLabel(path) {
  return SGO_MODULES.find((module) => module.path === path)?.label || SGO_MODULES[0].label;
}

function sgoModuleHint(path) {
  return SGO_MODULES.find((module) => module.path === path)?.hint || SGO_MODULES[0].hint;
}

function sgoModuleCta(path) {
  const module = SGO_MODULES.find((item) => item.path === path);
  return module?.cta || `Sinkronkan ${module?.label || SGO_MODULES[0].label}`;
}

// Elements
const urlInput = document.getElementById('url-input');
const indexBtn = document.getElementById('index-btn');
const contextStatus = document.getElementById('context-status');
const indexedInfo = document.getElementById('indexed-info');
const indexedUrl = document.getElementById('indexed-url');
const indexedChars = document.getElementById('indexed-chars');
const indexedTime = document.getElementById('indexed-time');
const scrapingState = document.getElementById('scraping-state');

const messagesContainer = document.getElementById('messages-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const clearChatBtn = document.getElementById('clear-chat');
const charCountEl = document.getElementById('char-count');
const aiChatStatusEl = document.getElementById('ai-chat-status');
const chatModeChip = document.getElementById('chat-mode-chip');

const sidebarEl = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const sidebarCloseBtn = document.getElementById('sidebar-close');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const moduleHintEl = document.getElementById('module-hint');
const activeModuleChip = document.getElementById('active-module-chip');

const serverHealthEl = document.getElementById('server-health');
const aiProviderEl = document.getElementById('ai-provider');
const toastContainer = document.getElementById('toast-container');

const jamaahCookieBtn = document.getElementById('jamaah-cookie-btn');
const moduleSelectEl = document.getElementById('moduleSelect');
const jamaahClearReal = document.getElementById('jamaah-clear-real');
const jamaahStatusText = document.getElementById('jamaah-status-text');
const sgoLiveBadge = document.getElementById('sgo-live-badge');
const sgoLiveBadgeText = document.getElementById('sgo-live-badge-text');
const sgoScrapeProgress = document.getElementById('sgo-scrape-progress');
const sidebarDataCount = document.getElementById('sidebar-data-count');
const moduleMenuButtons = Array.from(document.querySelectorAll('[data-module-path]'));
const manifestDropzone = document.getElementById('manifest-dropzone');
const manifestFileInput = document.getElementById('manifest-file-input');
const manifestEmptyState = document.getElementById('manifest-empty-state');
const manifestFileChip = document.getElementById('manifest-file-chip');
const manifestFileName = document.getElementById('manifest-file-name');
const manifestFileClear = document.getElementById('manifest-file-clear');

const MANIFEST_ALLOWED_EXTENSIONS = ['pdf', 'xls', 'xlsx', 'csv', 'doc', 'docx'];
const MANIFEST_MAX_BYTES = 15 * 1024 * 1024;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const initialWelcome = document.getElementById('welcome-message');
  welcomeTemplate = initialWelcome ? initialWelcome.outerHTML : '';
  updateCharCount();
  autoResizeChatInput();
  checkHealth();
  setupSidebar();
  setupEventListeners();
  setupJamaahEvents();
  setupModuleMenu();
  setupManifestDropzone();
  restoreActiveFocus();
  updateModulePresentation();
  fetchJamaahStatus();
  if (window.lucide) lucide.createIcons();
});

// Sidebar drawer (mobile)
function openSidebarDrawer() {
  if (!sidebarEl) return;
  sidebarEl.classList.remove('-translate-x-full');
  if (sidebarBackdrop) sidebarBackdrop.classList.remove('hidden');
}

function closeSidebarDrawer() {
  if (!sidebarEl) return;
  sidebarEl.classList.add('-translate-x-full');
  if (sidebarBackdrop) sidebarBackdrop.classList.add('hidden');
}

function setupSidebar() {
  if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', openSidebarDrawer);
  if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebarDrawer);
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebarDrawer);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebarDrawer();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1024) closeSidebarDrawer();
  });
}

// Sidebar module menu — tetap tersinkron dengan elemen moduleSelect yang dipakai app.js.
function setupModuleMenu() {
  if (!moduleMenuButtons.length || !moduleSelectEl) return;

  moduleMenuButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const path = button.dataset.modulePath;
      if (!SGO_MODULE_PATHS.includes(path)) return;

      moduleSelectEl.value = path;
      moduleSelectEl.dispatchEvent(new Event('change', { bubbles: true }));
      closeSidebarDrawer();
    });
  });
}

function setModuleMenuDisabled(disabled) {
  moduleMenuButtons.forEach((button) => {
    button.disabled = Boolean(disabled);
  });
}

function syncModuleMenu() {
  const path = moduleSelectEl?.value || DEFAULT_MODULE_PATH;
  moduleMenuButtons.forEach((button) => {
    const isActive = button.dataset.modulePath === path;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

// Manifest dropzone — file ditinjau lokal, bukan diunggah ke server.
function setupManifestDropzone() {
  if (!manifestDropzone) return;

  const openPicker = () => {
    if (manifestFileInput) manifestFileInput.click();
  };

  manifestDropzone.addEventListener('click', (event) => {
    if (event.target.closest('#manifest-file-clear')) return;
    openPicker();
  });

  manifestDropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    manifestDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      manifestDropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    manifestDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      manifestDropzone.classList.remove('is-dragover');
    });
  });

  manifestDropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    handleManifestFile(file);
  });

  if (manifestFileInput) {
    manifestFileInput.addEventListener('change', () => {
      handleManifestFile(manifestFileInput.files?.[0]);
    });
  }

  if (manifestFileClear) {
    manifestFileClear.addEventListener('click', (event) => {
      event.stopPropagation();
      clearManifestFile();
    });
  }
}

function handleManifestFile(file) {
  if (!file) return;

  const extension = (file.name.split('.').pop() || '').toLowerCase();
  if (!MANIFEST_ALLOWED_EXTENSIONS.includes(extension)) {
    if (manifestFileInput) manifestFileInput.value = '';
    showToast('Warning', 'Format file harus PDF, XLSX, CSV, DOC, atau DOCX', 'warning');
    return;
  }

  if (file.size > MANIFEST_MAX_BYTES) {
    if (manifestFileInput) manifestFileInput.value = '';
    showToast('Warning', 'Ukuran file manifest maksimal 15 MB', 'warning');
    return;
  }

  if (manifestFileName) manifestFileName.textContent = file.name;
  if (manifestEmptyState) manifestEmptyState.classList.add('hidden');
  if (manifestFileChip) {
    manifestFileChip.classList.remove('hidden');
    manifestFileChip.classList.add('flex');
  }

  // Arahkan konteks modul ke Upload Manifest tanpa memicu scrape berat.
  if (moduleSelectEl) {
    moduleSelectEl.value = '/ops/upload-documents';
    moduleSelectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  showToast(
    'Info',
    'File dipilih untuk ditinjau. Data manifest tetap ditarik langsung dari SGO Admin.',
    'info',
  );
}

function clearManifestFile() {
  if (manifestFileInput) manifestFileInput.value = '';
  if (manifestFileName) manifestFileName.textContent = '';
  if (manifestFileChip) {
    manifestFileChip.classList.add('hidden');
    manifestFileChip.classList.remove('flex');
  }
  if (manifestEmptyState) manifestEmptyState.classList.remove('hidden');
}

// Event Listeners
function setupEventListeners() {
  if (indexBtn) indexBtn.addEventListener('click', handleIndexUrl);
  if (urlInput) {
    urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !isIndexing) {
        handleIndexUrl();
      }
    });
  }

  if (sendBtn) sendBtn.addEventListener('click', handleSendMessage);
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!isSending) handleSendMessage();
      }
    });
    chatInput.addEventListener('input', () => {
      autoResizeChatInput();
      updateCharCount();
    });
  }

  if (clearChatBtn) clearChatBtn.addEventListener('click', clearChat);

  // Delegasi untuk semua tombol prompt (welcome, chips, hasil clear chat).
  document.addEventListener('click', (event) => {
    const promptBtn = event.target.closest('[data-prompt]');
    if (promptBtn) {
      const prompt = promptBtn.getAttribute('data-prompt') || '';
      if (prompt && chatInput) {
        chatInput.value = prompt;
        autoResizeChatInput();
        updateCharCount();
        chatInput.focus();
        handleSendMessage();
      }
      return;
    }

    const polishBtn = event.target.closest('[data-polish-chat]');
    if (polishBtn) {
      polishChatReply(polishBtn);
      return;
    }

    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      copyMessageText(copyBtn);
    }
  });
}

// Composer helpers
function autoResizeChatInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 144)}px`;
}

function updateCharCount() {
  if (!charCountEl) return;
  const length = chatInput ? chatInput.value.length : 0;
  charCountEl.textContent = `${length}/${CHAT_MAX_LENGTH}`;
  charCountEl.classList.toggle('text-red-500', length >= CHAT_MAX_LENGTH);
  charCountEl.classList.toggle('text-amber-500', length > CHAT_MAX_LENGTH * 0.9 && length < CHAT_MAX_LENGTH);
}

function setChatStatus(label, tone = 'online', options = {}) {
  if (!options.temporary) {
    chatBaseStatus = { label, tone };
  }
  if (!aiChatStatusEl) return;
  const dotClass =
    tone === 'busy'
      ? 'bg-amber-500 animate-pulse'
      : tone === 'offline'
        ? 'bg-red-500'
        : 'bg-gold-400 shadow-[0_0_8px_rgba(245,158,11,0.8)]';
  aiChatStatusEl.innerHTML = `
    <span class="inline-flex w-1.5 h-1.5 rounded-full ${dotClass}"></span>
    ${escapeHtml(label)}
  `;
}

function restoreChatStatus() {
  setChatStatus(chatBaseStatus.label, chatBaseStatus.tone, { temporary: true });
}

function applyReplyMode(source) {
  if (source === 'gemini') {
    if (chatModeChip) {
      chatModeChip.className =
        'hidden sm:inline-flex items-center gap-1.5 rounded-full border border-gold-400/22 bg-gold-400/[0.08] px-2.5 py-1 text-[10px] font-semibold text-gold-200';
      chatModeChip.innerHTML = '<i data-lucide="sparkles" class="w-3 h-3"></i> AI Chat';
    }
    setChatStatus('Online • AI aktif', 'online');
  } else if (source === 'local-fallback') {
    if (chatModeChip) {
      chatModeChip.className =
        'hidden sm:inline-flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/[0.08] px-2.5 py-1 text-[10px] font-semibold text-amber-300';
      chatModeChip.innerHTML = '<i data-lucide="shield-check" class="w-3 h-3"></i> Mode Lokal';
    }
    setChatStatus('Mode lokal • Gemini belum tersedia', 'busy');
  }
  if (window.lucide) lucide.createIcons();
}

function updateModulePresentation() {
  const path = moduleSelectEl?.value || DEFAULT_MODULE_PATH;
  const label = sgoModuleLabel(path);

  if (moduleHintEl) moduleHintEl.textContent = sgoModuleHint(path);
  if (activeModuleChip) {
    const text = activeModuleChip.querySelector('span');
    if (text) text.textContent = label;
  }

  syncModuleMenu();
  updateScrapeButtonLabel();

  document.dispatchEvent(
    new CustomEvent('umrah:module-change', {
      detail: { path, label },
    }),
  );
}

function updateScrapeButtonLabel() {
  if (!jamaahCookieBtn || !moduleSelectEl) return;
  const path = moduleSelectEl.value || DEFAULT_MODULE_PATH;
  const text = jamaahCookieBtn.querySelector('span');
  if (text) text.textContent = sgoModuleCta(path);
}

function setupJamaahEvents() {
  if (jamaahCookieBtn) {
    jamaahCookieBtn.addEventListener('click', handleJamaahCookieScrape);
  }
  if (moduleSelectEl) {
    moduleSelectEl.addEventListener('change', updateModulePresentation);
  }
  if (jamaahClearReal) {
    jamaahClearReal.addEventListener('click', handleJamaahClear);
  }
}

function setJamaahStatus(text) {
  if (!jamaahStatusText) return;
  const label = jamaahStatusText.querySelector('span');
  if (label) label.textContent = text;
  else jamaahStatusText.textContent = text;
}

async function fetchJamaahStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/jamaah`);
    const data = await res.json();
    if (!data.success) return;

    const count = Number(data.count || 0);
    const source = data.source || null;
    const sourceType = source?.type || 'scrape';

    if (sidebarDataCount) {
      sidebarDataCount.textContent =
        data.hasReal && count > 0 ? `${count.toLocaleString('id-ID')} jamaah` : '0 data';
    }

    if (data.hasReal && count > 0) {
      setJamaahStatus(`${count.toLocaleString('id-ID')} data real tersimpan`);
      if (sgoLiveBadge && sgoLiveBadgeText) {
        sgoLiveBadgeText.textContent = `SGO Live • ${count.toLocaleString('id-ID')} jamaah`;
        sgoLiveBadge.classList.remove('hidden');
        sgoLiveBadge.title = `Sumber: ${sourceType}${Array.isArray(source?.modules) ? ` • ${source.modules.length} modul` : ''}`;
      }
    } else {
      setJamaahStatus('Belum ada data real');
      if (sgoLiveBadge) sgoLiveBadge.classList.add('hidden');
    }
  } catch (e) {}
}

function restoreActiveFocus() {
  if (!moduleSelectEl) return;
  let saved = '';
  try {
    saved = localStorage.getItem('umrah_active_focus_v2') || '';
    localStorage.removeItem('umrah_active_focus');
  } catch (e) {}
  const pathFromUrl = window.location.pathname;
  const initialPath = SGO_MODULE_PATHS.includes(pathFromUrl)
    ? pathFromUrl
    : SGO_MODULE_PATHS.includes(saved)
      ? saved
      : DEFAULT_MODULE_PATH;
  moduleSelectEl.value = initialPath;
  try {
    localStorage.setItem('umrah_active_focus_v2', initialPath);
  } catch (e) {}
  updateModulePresentation();
}

async function handleJamaahCookieScrape() {
  const focusModule = moduleSelectEl ? moduleSelectEl.value : DEFAULT_MODULE_PATH;
  const moduleLabel = sgoModuleLabel(focusModule);

  if (!SGO_MODULE_PATHS.includes(focusModule)) {
    showToast('Warning', 'Pilih modul yang tersedia', 'warning');
    return;
  }

  const focusMeta = SGO_MODULES.find((item) => item.path === focusModule);
  if (focusMeta?.viewOnly) {
    document.dispatchEvent(
      new CustomEvent(focusMeta.refreshEvent || 'umrah:worksheet-refresh', {
        detail: { path: focusModule, source: 'sidebar' },
      }),
    );
    return;
  }

  if (moduleSelectEl) moduleSelectEl.disabled = true;
  setModuleMenuDisabled(true);

  const isManifestFocus = focusModule === '/ops/upload-documents';
  const result = await window.SgoSync.run({
    panel: sgoScrapeProgress,
    button: jamaahCookieBtn,
    endpoint: `${API_BASE}/api/jamaah/scrape-cookie`,
    body: {
      js: true,
      focusModule,
      skipManifest: isManifestFocus,
    },
    label: moduleLabel,
    busyLabel: `Memuat ${moduleLabel}...`,
    onProgress: isManifestFocus
      ? (progress) => {
          document.dispatchEvent(
            new CustomEvent('umrah:sync-progress', {
              detail: { ...progress, module: focusModule },
            }),
          );
        }
      : undefined,
  });

  try {
    if (!result.ok) {
      if (!result.busy) {
        const errorData = result.data || {};
        if (
          errorData.code === 'SGO_COOKIE_MISSING' ||
          errorData.code === 'SGO_AUTH'
        ) {
          if (errorData.code === 'SGO_AUTH' && window.RahmahSgoCookie) {
            window.RahmahSgoCookie.markExpired(result.error || errorData.error);
          } else if (window.RahmahSgoCookie) {
            window.RahmahSgoCookie.markEmpty(result.error || errorData.error);
          }
          if (window.RahmahSgoCookie) window.RahmahSgoCookie.open();
        }
        showToast(
          'Error',
          result.error || 'Gagal sinkronisasi SGO',
          'error',
        );
      }
      return;
    }

    const data = result.data || {};

    // Request menyusul sinkronisasi yang sudah berjalan: server mengembalikan
    // status 409, lalu UI menunggu sesi tersebut selesai. Jangan tampilkan
    // error, cukup beri info dan segarkan status.
    if (result.busy) {
      showToast(
        'Info',
        data.message || 'Sinkronisasi SGO yang sedang berjalan telah selesai.',
        'info',
      );
      await fetchJamaahStatus();
      document.dispatchEvent(
        new CustomEvent('umrah:data-updated', {
          detail: {
            source: 'scrape',
            count: Number(data.totalJamaah || data.rows || 0),
            module: focusModule,
          },
        }),
      );
      return;
    }

    if (data.success) {
      const moduleLoaded = data.moduleLoaded === true;
      const count = Number(data.count || 0);
      const isEmpty = data.empty === true || (!moduleLoaded && count === 0);

      showToast(
        isEmpty ? 'Info' : 'Success',
        data.message ||
          (moduleLoaded
            ? `Modul ${moduleLabel} berhasil dimuat`
            : isEmpty
              ? 'SGO tidak mengembalikan data jamaah (0 data).'
              : `Berhasil memuat ${moduleLabel}`),
        isEmpty ? 'warning' : 'success',
      );

      try {
        localStorage.setItem('umrah_active_focus_v2', focusModule);
      } catch (e) {}

      if (!moduleLoaded && !isEmpty) {
        setJamaahStatus(`${count.toLocaleString('id-ID')} data jamaah • ${moduleLabel}`);
      }
      if (sgoLiveBadge && sgoLiveBadgeText) {
        sgoLiveBadgeText.textContent = moduleLoaded
          ? `SGO • ${moduleLabel}`
          : isEmpty
            ? `SGO • ${moduleLabel}: 0 data baru`
            : `SGO Live • ${count.toLocaleString('id-ID')} jamaah`;
        sgoLiveBadge.classList.remove('hidden');
      }

      await fetchJamaahStatus();

      document.dispatchEvent(
        new CustomEvent('umrah:data-updated', {
          detail: { source: 'scrape', count: Number(data.count || 0), module: focusModule },
        }),
      );

      if (isEmpty && !moduleLoaded) {
        const stored = Number(data.storedJamaahCount || 0);
        setJamaahStatus(
          stored
            ? `Scrape terakhir: 0 data baru • ${stored.toLocaleString('id-ID')} tersimpan`
            : 'Scrape terakhir: 0 data',
        );
      }
    } else {
      showToast('Error', data.error || 'Gagal sinkronisasi SGO', 'error');
    }
  } finally {
    if (moduleSelectEl) moduleSelectEl.disabled = false;
    setModuleMenuDisabled(false);
    updateScrapeButtonLabel();
    if (window.lucide) lucide.createIcons();
  }
}

async function handleJamaahClear() {
  try {
    await fetch(`${API_BASE}/api/jamaah/clear`, { method: 'POST' });
    showToast('Success', 'Data jamaah dihapus. Store kosong (0 data).', 'success');
    setJamaahStatus('Belum ada data real');
    if (sidebarDataCount) sidebarDataCount.textContent = '0 data';
    if (sgoLiveBadge) sgoLiveBadge.classList.add('hidden');
    document.dispatchEvent(
      new CustomEvent('umrah:data-updated', {
        detail: { source: 'clear', count: 0 },
      }),
    );
  } catch (e) {
    showToast('Error', 'Gagal clear data', 'error');
  }
}

// Health Check
async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();

    if (data.success !== false && (data.status === 'ok' || data.success === true)) {
      if (serverHealthEl) {
        serverHealthEl.innerHTML = `
          <div class="h-2 w-2 animate-pulse rounded-full bg-gold-400 shadow-[0_0_10px_rgba(245,158,11,0.8)]"></div>
          <span class="text-[11px] font-medium text-gold-100">Server & DB Online</span>
        `;
      }

      const model = data.aiModel || 'AI';
      const ready = Boolean(data.aiReady) && !data.aiFallback;

      if (aiProviderEl) {
        const providerLabel = `${(data.aiProvider || 'AI').toUpperCase()} • ${model}${ready ? '' : ' • fallback'}`;
        aiProviderEl.innerHTML = `
          <i data-lucide="${ready ? 'sparkles' : 'shield-alert'}" class="h-3.5 w-3.5 ${ready ? 'text-gold-400' : 'text-amber-400'}"></i>
          <span class="text-[11px] font-semibold ${ready ? 'text-gold-200' : 'text-amber-200'}">
            ${escapeHtml(providerLabel)}
          </span>
        `;
      }

      if (chatModeChip) {
        chatModeChip.innerHTML = `
          <i data-lucide="${ready ? 'sparkles' : 'shield-check'}" class="h-3 w-3"></i>
          ${ready ? 'AI Chat' : 'Mode Lokal'}
        `;
        chatModeChip.className = ready
          ? 'hidden items-center gap-1.5 rounded-full border border-gold-400/22 bg-gold-400/[0.08] px-2.5 py-1 text-[10px] font-semibold text-gold-200 sm:inline-flex'
          : 'hidden items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/[0.08] px-2.5 py-1 text-[10px] font-semibold text-amber-300 sm:inline-flex';
      }

      setChatStatus(
        ready ? `Online • ${model}` : 'Mode lokal • Gemini belum aktif',
        ready ? 'online' : 'busy',
      );

      if (data.activeContext) {
        updateContextUI(data.activeContext);
      }

      if (window.lucide) lucide.createIcons();
    }
  } catch (error) {
    if (serverHealthEl) {
      serverHealthEl.innerHTML = `
        <div class="h-2 w-2 rounded-full bg-red-400"></div>
        <span class="text-[11px] font-medium text-red-300">Server Offline</span>
      `;
    }
    if (aiProviderEl) {
      aiProviderEl.innerHTML = `
        <i data-lucide="wifi-off" class="h-3.5 w-3.5 text-red-400"></i>
        <span class="text-[11px] font-semibold text-red-300">Tidak terhubung</span>
      `;
    }
    setChatStatus('Offline • server tidak terhubung', 'offline');
    showToast('Error', 'Cannot connect to server', 'error');
  }
}

// Index URL
async function handleIndexUrl() {
  const url = urlInput ? urlInput.value.trim() : '';

  if (!url) {
    showToast('Warning', 'Please enter a website URL', 'warning');
    if (urlInput) urlInput.focus();
    return;
  }

  try {
    new URL(url);
  } catch {
    showToast('Error', 'Invalid URL format', 'error');
    return;
  }

  if (isIndexing) return;
  isIndexing = true;

  if (indexBtn) {
    indexBtn.disabled = true;
    indexBtn.innerHTML = `
      <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gold-300/40 border-t-gold-300"></div>
      <span>Indexing...</span>
    `;
  }
  if (scrapingState) scrapingState.classList.remove('hidden');
  if (contextStatus) contextStatus.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/index-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (data.success) {
      activeContextUrl = data.context.url;
      updateContextUI(data.context);
      showToast('Success', 'Website context indexed successfully!', 'success');
      if (urlInput) urlInput.value = '';
    } else {
      showToast('Error', data.error || 'Failed to index website', 'error');
      if (contextStatus) contextStatus.classList.remove('hidden');
    }
  } catch (error) {
    showToast('Error', 'Network error while indexing', 'error');
    if (contextStatus) contextStatus.classList.remove('hidden');
  } finally {
    isIndexing = false;
    if (indexBtn) {
      indexBtn.disabled = false;
      indexBtn.innerHTML = `
        <i data-lucide="download" class="h-3.5 w-3.5"></i>
        <span>Index Website</span>
      `;
    }
    if (scrapingState) scrapingState.classList.add('hidden');
    if (window.lucide) lucide.createIcons();
  }
}

// Update Context UI
function updateContextUI(context) {
  activeContextUrl = context.url;
  if (indexedUrl) indexedUrl.textContent = context.url;
  if (indexedChars) indexedChars.textContent = `${(context.characters || 0).toLocaleString()} characters`;
  
  if (context.indexedAt && indexedTime) {
    const date = new Date(context.indexedAt);
    indexedTime.textContent = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }

  if (contextStatus) contextStatus.classList.add('hidden');
  if (indexedInfo) indexedInfo.classList.remove('hidden');
}

// Send Message
async function handleSendMessage() {
  const message = chatInput ? chatInput.value.trim() : '';

  if (!message || isSending) return;

  if (message.length > CHAT_MAX_LENGTH) {
    showToast('Warning', `Pesan maksimal ${CHAT_MAX_LENGTH} karakter`, 'warning');
    return;
  }

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;

  const welcomeEl = document.getElementById('welcome-message');
  if (welcomeEl) welcomeEl.style.display = 'none';

  addMessage(message, 'user');

  if (chatInput) chatInput.value = '';
  autoResizeChatInput();
  updateCharCount();

  setChatStatus('Menyiapkan jawaban...', 'busy', { temporary: true });
  const typingId = addTypingIndicator();

  try {
    const payload = { message: message };
    if (activeContextUrl) payload.url = activeContextUrl;

    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    removeTypingIndicator(typingId);

    if (data.success) {
      addMessage(data.reply, 'ai', {
        intent: data.intent,
        source: data.source,
        provider: data.provider,
        model: data.model,
        usedJamaahLookup: data.usedJamaahLookup,
        matchedCount: data.matchedCount,
        jamaahResults: data.jamaahResults || null,
        addonResults: data.addonResults || null,
        latencyMs: data.latencyMs,
      });

      applyReplyMode(data.source);

      if (data.contextWarning) {
        showToast('Info', data.contextWarning, 'warning');
      }
    } else {
      const reply =
        data.reply ||
        data.response ||
        `Maaf, terjadi kesalahan: ${data.error || 'permintaan gagal diproses.'}`;
      addMessage(reply, 'ai', {
        intent: data.intent || 'error',
        source: data.source || 'error',
        error: true,
      });
      if (data.error) showToast('Error', data.error, 'error');
    }
  } catch (error) {
    removeTypingIndicator(typingId);
    addMessage(
      'Maaf, saya tidak dapat terhubung ke server saat ini. Pastikan backend berjalan, lalu coba lagi. 🙏',
      'ai',
      { source: 'error', intent: 'error', error: true },
    );
    showToast('Error', 'Network error', 'error');
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    restoreChatStatus();
    if (chatInput) chatInput.focus();
  }
}

// Source & intent presentation
const SOURCE_META = {
  'jamaah-data': {
    label: 'Data SGO',
    icon: 'database',
    className: 'border-gold-400/25 bg-gold-400/[0.08] text-gold-200',
  },
  'addon-data': {
    label: 'Add-on SGO',
    icon: 'gift',
    className: 'border-gold-400/25 bg-gold-400/[0.08] text-gold-200',
  },
  gemini: {
    label: 'Gemini',
    icon: 'sparkles',
    className: 'border-gold-300/20 bg-gold-300/[0.07] text-gold-100',
  },
  'local-fallback': {
    label: 'Mode lokal',
    icon: 'shield-check',
    className: 'border-amber-400/20 bg-amber-400/[0.08] text-amber-300',
  },
  local: {
    label: 'Lokal',
    icon: 'cpu',
    className: 'border-white/10 bg-white/[0.05] text-slate-300',
  },
  error: {
    label: 'Error',
    icon: 'alert-triangle',
    className: 'border-red-400/20 bg-red-400/[0.08] text-red-300',
  },
};

const INTENT_LABELS = {
  greeting: 'Sapaan',
  smalltalk: 'Obrolan',
  complaint: 'Keluhan',
  faq: 'FAQ',
  general: 'Umum',
  'data-list': 'Daftar jamaah',
  'data-count': 'Jumlah jamaah',
  'data-filter': 'Filter jamaah',
  'data-lookup': 'Cari jamaah',
  'addon-lookup': 'Cari add-on',
  'data-help': 'Panduan data',
  empty: 'Kosong',
  error: 'Error',
};

function renderSourceBadge(meta = {}) {
  const info = SOURCE_META[meta.source] || SOURCE_META.local;
  return `
    <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${info.className}">
      <i data-lucide="${info.icon}" class="h-3 w-3"></i>
      ${escapeHtml(info.label)}
    </span>
  `;
}

function renderIntentBadge(meta = {}) {
  const label = INTENT_LABELS[meta.intent];
  if (!label) return '';
  return `
    <span class="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-slate-400">
      <i data-lucide="tag" class="h-3 w-3"></i>
      ${escapeHtml(label)}
    </span>
  `;
}

function renderLookupBadge(meta = {}) {
  if (!meta.usedJamaahLookup) return '';
  const found = Number(meta.matchedCount || 0);
  const isAddon = meta.source === 'addon-data';
  const text =
    found > 0
      ? `${found} ${isAddon ? 'add-on' : 'data'} ditemukan`
      : isAddon
        ? 'Add-on tidak ditemukan'
        : 'Data tidak ditemukan';
  const tone =
    found > 0
      ? 'border-gold-400/25 bg-gold-400/[0.08] text-gold-200'
      : 'border-amber-400/20 bg-amber-400/[0.08] text-amber-300';
  return `
    <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}">
      <i data-lucide="${found > 0 ? (isAddon ? 'gift' : 'users') : 'search-x'}" class="h-3 w-3"></i>
      ${escapeHtml(text)}
    </span>
  `;
}

// Lightweight markdown renderer (input is escaped first, so it stays safe)
function renderMarkdown(text) {
  const lines = escapeHtml(text == null ? '' : String(text)).split(/\r?\n/);
  const blocks = [];
  const listLine = /^\s*(?:[-•*]|\d+\.)\s+/;
  const nestedLine = /^\s{2,}[-•*]\s+/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      if (blocks[blocks.length - 1] !== '<div class="ai-spacer"></div>') {
        blocks.push('<div class="ai-spacer"></div>');
      }
      i += 1;
      continue;
    }

    const heading = line.match(/^\s*#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push(`<p><strong>${inlineMarkdown(heading[1])}</strong></p>`);
      i += 1;
      continue;
    }

    if (listLine.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      let html = ordered ? '<ol>' : '<ul>';

      while (i < lines.length && listLine.test(lines[i])) {
        const match = lines[i].match(/^\s*(?:[-•*]|\d+\.)\s+(.*)$/);
        let inner = inlineMarkdown(match ? match[1] : '');
        i += 1;

        let nested = '';
        while (i < lines.length && nestedLine.test(lines[i])) {
          const nestedMatch = lines[i].match(/^\s{2,}[-•*]\s+(.*)$/);
          nested += `<div class="ai-indent">• ${inlineMarkdown(nestedMatch ? nestedMatch[1] : '')}</div>`;
          i += 1;
        }
        if (nested) inner += nested;
        html += `<li>${inner}</li>`;
      }

      html += ordered ? '</ol>' : '</ul>';
      blocks.push(html);
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !listLine.test(lines[i]) &&
      !/^\s*#{1,4}\s+/.test(lines[i])
    ) {
      paragraph.push(inlineMarkdown(lines[i].trim()));
      i += 1;
    }
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }

  return blocks.join('');
}

function inlineMarkdown(text) {
  return String(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderChatDocChip(documentItem = {}) {
  const stateName = ['complete', 'process', 'missing'].includes(documentItem.state)
    ? documentItem.state
    : 'missing';
  const mark = stateName === 'complete' ? '✓' : stateName === 'missing' ? '×' : '•';

  return `
    <span class="doc-chip chat-doc-chip is-${stateName}" title="${escapeAttr(documentItem.label)}: ${escapeAttr(documentItem.stateLabel)}">
      <span class="doc-mark" aria-hidden="true">${mark}</span>
      <span>${escapeHtml(documentItem.label)}</span>
    </span>
  `;
}

function renderChatJamaahCard(row = {}) {
  const total = Number(row.total || 0);
  const completed = Number(row.completed || 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const progressClass = row.isComplete
    ? 'is-complete'
    : percent >= 50
      ? 'is-partial'
      : 'is-low';
  const missingCount = Array.isArray(row.missing) ? row.missing.length : 0;
  const progressCount = Array.isArray(row.inProgress) ? row.inProgress.length : 0;
  const note = missingCount
    ? `× ${missingCount} dokumen belum lengkap`
    : progressCount
      ? `• ${progressCount} dokumen menunggu approval`
      : '✓ Semua dokumen lengkap';
  const noteClass = missingCount
    ? 'is-missing'
    : progressCount
      ? 'is-process'
      : 'is-complete';
  const jamaahId = String(row.id || '').trim();
  const manageButton = jamaahId && /^\d+$/.test(jamaahId)
    ? `
      <a href="/ops/monitoring_jamaah/${encodeURIComponent(jamaahId)}/edit"
        target="_blank" rel="noopener noreferrer"
        aria-label="Kelola dokumen untuk ${escapeAttr(row.nama || 'jamaah')} di tab baru"
        class="chat-manage-btn inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold">
        <i data-lucide="folder-open" class="h-3.5 w-3.5"></i>
        <span>Kelola Dokumen</span>
        <i data-lucide="arrow-up-right" class="h-3 w-3"></i>
      </a>
    `
    : '';
  const invoiceUrl = String(row.invoiceUrl || '').trim();
  const invoiceButton = /^https?:\/\//i.test(invoiceUrl)
    ? `
      <a href="${escapeAttr(invoiceUrl)}" target="_blank" rel="noopener noreferrer"
        aria-label="Lihat invoice jamaah di tab baru"
        class="chat-manage-btn inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold">
        <i data-lucide="receipt-text" class="h-3.5 w-3.5"></i>
        <span>Lihat Invoice</span>
        <i data-lucide="arrow-up-right" class="h-3 w-3"></i>
      </a>
    `
    : '';

  return `
    <article class="chat-jamaah-card"${jamaahId ? ` data-chat-jamaah-id="${escapeAttr(jamaahId)}"` : ''}>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <h4 class="truncate text-[12px] font-semibold text-white">${escapeHtml(row.nama || 'Jamaah')}</h4>
            <span class="manifest-status ${row.isComplete ? 'is-complete' : 'is-incomplete'}">
              ${row.isComplete ? '✓ Lengkap' : '× Belum lengkap'}
            </span>
          </div>
          <p class="mt-0.5 truncate text-[10px] text-slate-500">${escapeHtml(row.paket || 'Paket belum tercatat')}</p>
          <p class="mt-0.5 text-[9.5px] text-slate-600">Keberangkatan: ${escapeHtml(row.keberangkatan || 'Belum terjadwal')}</p>
        </div>
        <div class="flex flex-shrink-0 flex-wrap items-center gap-1 sm:flex-col sm:items-end">
          ${invoiceButton}
          ${manageButton}
        </div>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        ${(Array.isArray(row.documents) ? row.documents : []).map(renderChatDocChip).join('')}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <div class="h-1 min-w-[4rem] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div class="progress-fill ${progressClass}" style="width: ${percent}%"></div>
        </div>
        <span class="text-[9.5px] font-medium text-slate-500">${escapeHtml(row.progressLabel || `${completed}/${total}`)}</span>
        <span class="manifest-note text-[9.5px] ${noteClass}">${escapeHtml(note)}</span>
      </div>
    </article>
  `;
}

/** Kelompokkan hasil chat berdasarkan order agar header tidak berulang. */
function groupChatJamaahItems(items = []) {
  const groups = [];
  const byOrder = new Map();

  items.forEach((row) => {
    const orderCode = String(row.orderCode || '').trim().toUpperCase();
    const key = orderCode || `jamaah:${row.id || row.nama || groups.length}`;

    if (!byOrder.has(key)) {
      const group = {
        key,
        orderCode,
        pemesan: '',
        accessCode: '',
        jamaahCount: 0,
        rows: [],
      };
      byOrder.set(key, group);
      groups.push(group);
    }

    const group = byOrder.get(key);
    group.rows.push(row);
    if (!group.pemesan) group.pemesan = String(row.pemesan || row.nama || '').trim();
    if (!group.accessCode) group.accessCode = String(row.accessCode || '').trim();

    const rowCount = Number(row.jamaahCount);
    if (Number.isFinite(rowCount) && rowCount > group.jamaahCount) {
      group.jamaahCount = rowCount;
    }
  });

  groups.forEach((group) => {
    if (!group.jamaahCount) group.jamaahCount = group.rows.length;
  });

  return groups;
}

function renderChatOrderGroup(group = {}) {
  const rows = Array.isArray(group.rows) ? group.rows : [];
  const firstRow = rows[0] || {};
  const renderHeader = window.OrderAccess?.renderHeader;
  const header =
    typeof renderHeader === 'function'
      ? renderHeader({
          pemesan: group.pemesan || firstRow.pemesan || firstRow.nama || '',
          orderCode: group.orderCode,
          accessCode: group.accessCode,
          jamaahCount: group.jamaahCount || rows.length,
          jamaahId: firstRow.id,
        })
      : '';

  return `
    <section class="chat-order-group" data-chat-order="${escapeAttr(group.orderCode || group.key || '')}">
      ${header}
      <div class="chat-order-group__body">
        ${rows.map(renderChatJamaahCard).join('')}
      </div>
    </section>
  `;
}

function renderChatAddonResults(payload = null) {
  if (!payload) return '';

  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!groups.length && !items.length) return '';

  const kind = payload.kind || 'search';
  const totalMatched = Number(payload.totalMatched || 0);
  const badge =
    kind === 'overview'
      ? `${Number(payload.batches?.length || totalMatched).toLocaleString('id-ID')} batch`
      : `${(totalMatched || groups.length).toLocaleString('id-ID')} add-on`;
  const firstOrder =
    groups[0]?.orderDisplay ||
    groups[0]?.orderCode ||
    payload.orderCode ||
    '';
  const moduleQuery =
    kind === 'rtb' && payload.rtb
      ? `RTB ${payload.rtb}`
      : kind === 'order' && firstOrder
        ? firstOrder
        : '';
  const moduleHref = `/ops/add-on${
    moduleQuery ? `?q=${encodeURIComponent(moduleQuery)}` : ''
  }`;

  const body = groups.length
    ? groups
        .map((group) => {
          const orderDisplay =
            group.orderDisplay ||
            (group.orderShort ? `#${group.orderShort}` : '') ||
            group.orderCode ||
            'Tanpa kode order';
          const orderValue =
            group.orderCode || group.portalOrder || group.orderShort || '';
          const portal = orderValue
            ? `/api/portal/login?order=${encodeURIComponent(orderValue)}`
            : '';
          const portalMarkup = portal
            ? `<a href="${escapeAttr(portal)}" target="_blank" rel="noopener noreferrer"
                 class="inline-flex flex-shrink-0 items-center gap-1 rounded-lg border border-gold-400/30 bg-gold-400/[0.09] px-2 py-1 text-[9.5px] font-semibold text-gold-200 transition-colors hover:bg-gold-400/[0.16]">
                 <i data-lucide="external-link" class="h-2.5 w-2.5"></i>
                 Login Portal
               </a>`
            : '';
          const payment = String(group.paymentStatus || '').trim();
          const paymentUpper = payment.toUpperCase();
          const paymentTone =
            !payment || payment === '-'
              ? 'border-slate-400/15 bg-slate-400/[0.06] text-slate-400'
              : /LUNAS|PAID|SELESAI|VERIFIED|FULL/.test(paymentUpper) ||
                  (/(\d{1,3})\s*%/.test(paymentUpper) &&
                    Number(paymentUpper.match(/(\d{1,3})\s*%/)[1]) >= 100)
                ? 'border-emerald-400/25 bg-emerald-400/[0.09] text-emerald-200'
                : 'border-red-400/25 bg-red-400/[0.08] text-red-200';
          const jamaah = Array.isArray(group.jamaah) ? group.jamaah : [];

          return `
            <article class="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-[11px] font-semibold text-white">${escapeHtml(orderDisplay)}</span>
                    <span class="rounded-full border border-gold-400/20 bg-gold-400/[0.07] px-1.5 py-0.5 text-[9px] font-semibold text-gold-200">
                      RTB ${escapeHtml(group.rtb || '—')}
                    </span>
                    <span class="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${paymentTone}">
                      ${escapeHtml(payment || 'Pembayaran belum tercatat')}
                    </span>
                  </div>
                  <p class="mt-0.5 truncate text-[10px] text-slate-400">
                    ${escapeHtml(group.pemesan || jamaah[0]?.name || 'Pemesan belum tercatat')}
                  </p>
                  <p class="mt-0.5 text-[9.5px] text-slate-500">
                    ${escapeHtml(group.packageName || 'Paket belum tercatat')}${
                      group.departureLabel
                        ? ` • ${escapeHtml(group.departureLabel)}`
                        : ''
                    }
                  </p>
                </div>
                ${portalMarkup}
              </div>
              <div class="mt-2 space-y-1.5">
                ${jamaah
                  .slice(0, 6)
                  .map(
                    (person) => `
                  <div class="flex min-w-0 flex-wrap items-start justify-between gap-1.5 rounded-lg border border-white/[0.045] bg-black/10 px-2 py-1.5">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-[10.5px] font-semibold text-slate-200">${escapeHtml(
                        person.name || 'Jamaah',
                      )}</p>
                      <div class="mt-1 flex flex-wrap gap-1">
                        ${(Array.isArray(person.addons) ? person.addons : [])
                          .slice(0, 8)
                          .map((addon) => {
                            const tone =
                              addon.status === 'verified'
                                ? 'border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-200'
                                : addon.status === 'pending'
                                  ? 'border-amber-400/20 bg-amber-400/[0.08] text-amber-200'
                                  : addon.status === 'unpaid'
                                    ? 'border-red-400/20 bg-red-400/[0.08] text-red-200'
                                    : 'border-white/10 bg-white/[0.04] text-slate-300';
                            return `
                              <span class="inline-flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] ${tone}">
                                <span class="font-semibold">${escapeHtml(addon.item)}</span>
                                ${
                                  Number(addon.price || 0) > 0
                                    ? `<span class="opacity-80">${escapeHtml(
                                        addon.priceLabel || `Rp${Number(addon.price).toLocaleString('id-ID')}`,
                                      )}</span>`
                                    : ''
                                }
                                <span class="border-l border-current pl-1 opacity-70">${escapeHtml(
                                  addon.statusLabel || addon.status || 'Add-on',
                                )}</span>
                              </span>
                            `;
                          })
                          .join('')}
                      </div>
                    </div>
                    <span class="flex-shrink-0 text-[10px] font-semibold text-gold-200">
                      ${escapeHtml(
                        person.totalPriceLabel ||
                          `Rp${Number(person.totalPrice || 0).toLocaleString('id-ID')}`,
                      )}
                    </span>
                  </div>
                `,
                  )
                  .join('')}
              </div>
            </article>
          `;
        })
        .join('')
    : `
      <div class="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5">
        <p class="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-gold-300/90">
          Rekap add-on per jenis
        </p>
        <div class="mt-1.5 flex flex-wrap gap-1">
          ${items
            .slice(0, 12)
            .map(
              (item) => `
            <span class="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-slate-300">
              <span class="font-semibold">${escapeHtml(item.item)}</span>
              <span class="text-gold-200">${Number(item.qty || 0).toLocaleString('id-ID')} qty</span>
              <span class="opacity-70">${escapeHtml(item.revenueLabel || '')}</span>
            </span>
          `,
            )
            .join('')}
        </div>
      </div>
    `;

  return `
    <div class="chat-addon-results mt-2.5" data-chat-addon-results>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-1.5">
        <span class="inline-flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-gold-300/90">
          <i data-lucide="gift" class="h-3 w-3"></i>
          Add-on per batch
        </span>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="rounded-full border border-gold-500/20 bg-gold-500/[0.07] px-2 py-0.5 text-[9px] font-semibold text-gold-200">
            ${badge}
          </span>
          <a href="${escapeAttr(moduleHref)}"
            class="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-medium text-slate-400 transition-colors hover:border-gold-400/30 hover:text-gold-200">
            <i data-lucide="arrow-up-right" class="h-2.5 w-2.5"></i>
            Buka modul
          </a>
        </div>
      </div>
      <div class="space-y-2">${body}</div>
      ${
        payload.truncated
          ? `<p class="mt-2 text-[9.5px] text-slate-500">
              Menampilkan ${Number(payload.returned || groups.length).toLocaleString('id-ID')} dari
              ${totalMatched.toLocaleString('id-ID')} add-on. Persempit dengan RTB, nama, atau kode order.
            </p>`
          : ''
      }
    </div>
  `;
}

function renderChatJamaahResults(payload = null) {
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) return '';

  const totalMatched = Number(payload.totalMatched || payload.items.length);
  const returned = Number(payload.returned || payload.items.length);
  const groups = groupChatJamaahItems(payload.items);

  return `
    <div class="chat-jamaah-results mt-2.5" data-chat-jamaah-results>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-1.5">
        <span class="inline-flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-gold-300/90">
          <i data-lucide="folder-check" class="h-3 w-3"></i>
          Status dokumen jamaah
        </span>
        <span class="rounded-full border border-gold-500/20 bg-gold-500/[0.07] px-2 py-0.5 text-[9px] font-semibold text-gold-200">
          ${groups.length.toLocaleString('id-ID')} order • ${totalMatched.toLocaleString('id-ID')} data
        </span>
      </div>
      <div class="chat-order-groups">
        ${groups.map(renderChatOrderGroup).join('')}
      </div>
      ${payload.truncated ? `
        <p class="mt-2 text-[9.5px] text-slate-500">
          Menampilkan ${returned} dari ${totalMatched.toLocaleString('id-ID')} data. Persempit dengan nama lengkap atau kode order.
        </p>
      ` : ''}
    </div>
  `;
}

// Add Message
function addMessage(text, type, meta = {}) {
  if (!messagesContainer) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message-bubble message-enter mx-auto flex w-full max-w-4xl gap-3';
  messageDiv.dataset.rawText = String(text == null ? '' : text);

  if (type === 'user') {
    messageDiv.classList.add('flex-row-reverse');
    messageDiv.innerHTML = `
      <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gold-400/25 bg-gold-400/10">
        <i data-lucide="user" class="h-3.5 w-3.5 text-gold-200"></i>
      </div>
      <div class="flex min-w-0 max-w-[85%] flex-col items-end">
        <div class="rounded-2xl rounded-tr-md border border-gold-400/30 bg-gradient-to-br from-gold-500/[0.24] via-gold-500/[0.1] to-white/[0.03] px-4 py-2.5 shadow-[0_16px_40px_-24px_rgba(245,158,11,0.8)] backdrop-blur-md">
          <p class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gold-50">${escapeHtml(text)}</p>
        </div>
        <span class="mt-1 text-[10px] text-slate-500">Anda</span>
      </div>
    `;
  } else {
    const isError = Boolean(meta.error) || meta.source === 'error';
    const bubbleClass = isError
      ? 'border border-red-400/20 bg-red-500/[0.07] text-red-100'
      : 'border border-gold-400/20 bg-white/[0.04] text-slate-100 backdrop-blur-md';

    messageDiv.innerHTML = `
      <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gold-400/30 bg-gradient-to-br from-gold-300 to-gold-600 shadow-[0_10px_26px_-14px_rgba(245,158,11,0.9)]">
        <i data-lucide="${isError ? 'alert-triangle' : 'sparkles'}" class="h-3.5 w-3.5 ${isError ? 'text-white' : 'text-[#1C1404]'}"></i>
      </div>
      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-center gap-2.5">
          <span class="text-[11px] font-semibold text-slate-400">Rahmah AI</span>
          <button type="button" data-polish-chat title="Rapihin kata jawaban ini dengan Rahmah Style"
            aria-label="Rapihin kata jawaban ini dengan Rahmah Style"
            class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-gold-500/[0.08] hover:text-gold-300">
            <i data-lucide="sparkles" class="h-3 w-3"></i>
            <span class="hidden sm:inline">Rapihin Kata</span>
          </button>
          <button type="button" data-copy title="Salin jawaban"
            class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-gold-500/[0.08] hover:text-gold-300">
            <i data-lucide="copy" class="h-3 w-3"></i>
            <span class="hidden sm:inline">Salin</span>
          </button>
        </div>
        <div class="ai-markdown ${bubbleClass} inline-block max-w-full rounded-2xl rounded-tl-md px-4 py-3 text-[13px] shadow-[0_24px_60px_-45px_rgba(0,0,0,0.9)]">
          ${renderMarkdown(text)}
        </div>
        ${renderChatJamaahResults(meta.jamaahResults)}
        ${renderChatAddonResults(meta.addonResults)}
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
          ${meta.source ? renderSourceBadge(meta) : ''}
          ${meta.intent ? renderIntentBadge(meta) : ''}
          ${renderLookupBadge(meta)}
          ${meta.latencyMs ? `<span class="text-[10px] text-slate-600">${Math.round(Number(meta.latencyMs))} ms</span>` : ''}
        </div>
      </div>
    `;
  }

  messagesContainer.appendChild(messageDiv);
  if (window.lucide) lucide.createIcons();
  if (type !== 'user' && typeof window.OrderAccess?.hydrate === 'function') {
    window.OrderAccess.hydrate(messageDiv);
  }
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// Rapihin Kata untuk balasan chat operasional
function polishChatReply(button) {
  const bubble = button.closest('.message-bubble');
  const raw = String(bubble?.dataset.rawText || '').trim();
  if (!raw) {
    showToast('Info', 'Belum ada teks yang bisa dirapikan.', 'warning');
    return;
  }
  if (!window.RahmahPolish) {
    showToast(
      'Error',
      'Modal Rapihin Kata belum termuat. Muat ulang halaman.',
      'error',
    );
    return;
  }

  window.RahmahPolish.open({
    text: raw,
    mode: 'chat',
    subtitle: 'Balasan chat • Rahmah AI',
  });
}

// Copy AI answer
async function copyMessageText(button) {
  const bubble = button.closest('.message-bubble');
  const text = bubble ? bubble.dataset.rawText || '' : '';
  if (!text) return;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }

    const original = button.innerHTML;
    button.innerHTML = '<i data-lucide="check" class="h-3 w-3"></i><span class="hidden sm:inline">Tersalin</span>';
    button.classList.add('text-gold-300');
    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('text-gold-300');
      if (window.lucide) lucide.createIcons();
    }, 1600);
  } catch (error) {
    showToast('Error', 'Gagal menyalin jawaban', 'error');
  }
}

// Typing Indicator
function addTypingIndicator() {
  const id = 'typing-' + Date.now();
  const messageDiv = document.createElement('div');
  messageDiv.id = id;
  messageDiv.className = 'message-bubble message-enter mx-auto flex w-full max-w-4xl gap-3';
  messageDiv.innerHTML = `
    <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gold-400/30 bg-gradient-to-br from-gold-300 to-gold-600 shadow-[0_10px_26px_-14px_rgba(245,158,11,0.9)]">
      <i data-lucide="sparkles" class="h-3.5 w-3.5 text-[#1C1404]"></i>
    </div>
    <div class="min-w-0 flex-1">
      <div class="mb-1 flex items-center gap-2">
        <span class="text-[11px] font-semibold text-slate-400">Rahmah AI</span>
        <span class="inline-flex items-center gap-1 rounded-full border border-gold-400/22 bg-gold-400/[0.08] px-2 py-0.5 text-[10px] font-medium text-gold-200">
          <i data-lucide="loader-2" class="h-3 w-3 animate-spin"></i>
          Menyiapkan
        </span>
      </div>
      <div class="inline-block rounded-2xl rounded-tl-md border border-gold-400/18 bg-white/[0.04] px-4 py-3">
        <div class="flex items-center gap-1.5">
          <div class="typing-dot h-1.5 w-1.5 rounded-full"></div>
          <div class="typing-dot h-1.5 w-1.5 rounded-full"></div>
          <div class="typing-dot h-1.5 w-1.5 rounded-full"></div>
        </div>
      </div>
      <p class="mt-1 text-[10px] text-slate-600">Mencari jawaban terbaik untuk Anda...</p>
    </div>
  `;
  if (messagesContainer) {
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  if (window.lucide) lucide.createIcons();
  return id;
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// Clear Chat
function clearChat() {
  if (!messagesContainer) return;
  if (isSending) {
    showToast('Info', 'Tunggu jawaban selesai dulu ya', 'info');
    return;
  }

  messagesContainer.innerHTML = welcomeTemplate || '';

  if (chatInput) {
    chatInput.value = '';
    autoResizeChatInput();
    updateCharCount();
    chatInput.focus();
  }

  restoreChatStatus();
  if (window.lucide) lucide.createIcons();
  showToast('Success', 'Chat dibersihkan', 'success');
}

// Toast Notification
function showToast(title, message, type = 'info') {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast pointer-events-auto w-full max-w-sm overflow-hidden rounded-2xl';

  const tones = {
    success: { icon: 'check-circle-2', iconColor: 'text-gold-300', titleColor: 'text-gold-100', msgColor: 'text-gold-200/70' },
    error: { icon: 'x-circle', iconColor: 'text-red-300', titleColor: 'text-red-100', msgColor: 'text-red-200/70' },
    warning: { icon: 'alert-triangle', iconColor: 'text-amber-300', titleColor: 'text-amber-100', msgColor: 'text-amber-200/70' },
    info: { icon: 'info', iconColor: 'text-gold-400', titleColor: 'text-gold-100', msgColor: 'text-gold-200/60' },
  };

  const c = tones[type] || tones.info;

  toast.innerHTML = `
    <div class="p-3.5">
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 pt-0.5">
          <i data-lucide="${c.icon}" class="h-4 w-4 ${c.iconColor}"></i>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-[12px] font-semibold ${c.titleColor}">${escapeHtml(title)}</p>
          <p class="mt-0.5 text-[11px] leading-relaxed ${c.msgColor}">${escapeHtml(message)}</p>
        </div>
        <button type="button" aria-label="Tutup notifikasi"
          class="flex-shrink-0 rounded-md p-1 ${c.iconColor} transition-opacity hover:opacity-70" onclick="this.closest('.toast').remove()">
          <i data-lucide="x" class="h-3.5 w-3.5"></i>
        </button>
      </div>
    </div>
  `;

  toastContainer.appendChild(toast);
  if (window.lucide) lucide.createIcons();

  setTimeout(() => {
    if (toast.parentElement) {
      toast.remove();
    }
  }, 3000);
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

// Ekspos helper toast untuk modul frontend terpisah (monitoring/manifest).
window.showToast = showToast;
