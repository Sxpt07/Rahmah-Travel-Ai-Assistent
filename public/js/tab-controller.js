/**
 * Tab controller "Umrah AI Console".
 *
 * Tugasnya hanya mengisolasi tampilan modul. Logika chat, scraping, dan
 * pencarian AI tetap berada di public/app.js dan tidak diubah oleh modul ini.
 */
(() => {
  const MODULE_VIEWS = {
    '/ops/monitoring-jamaah': {
      view: 'monitoring',
      label: 'Monitoring Jamaah',
      title: 'Monitoring Jamaah • Rahmah Travel AI Console',
    },
    '/ops/upload-documents': {
      view: 'manifest',
      label: 'Upload Manifest & Cek Dokumen',
      title: 'Upload Manifest & Cek Dokumen • Rahmah Travel AI Console',
    },
  };

  const DEFAULT_PATH = '/ops/monitoring-jamaah';
  let currentPath = DEFAULT_PATH;
  let currentView = MODULE_VIEWS[DEFAULT_PATH].view;

  function viewSections() {
    return Array.from(document.querySelectorAll('[data-view]'));
  }

  function syncTopSwitch(path) {
    document
      .querySelectorAll('#top-view-switch [data-view-path]')
      .forEach((button) => {
        const isActive = button.dataset.viewPath === path;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', String(isActive));
        button.tabIndex = isActive ? 0 : -1;
      });
  }

  function activateView(path) {
    const resolvedPath = MODULE_VIEWS[path] ? path : DEFAULT_PATH;
    const meta = MODULE_VIEWS[resolvedPath];
    const changed =
      currentPath !== resolvedPath || currentView !== meta.view;

    currentPath = resolvedPath;
    currentView = meta.view;

    let activeSection = null;
    viewSections().forEach((section) => {
      const isActive = section.dataset.view === meta.view;
      section.hidden = !isActive;
      section.setAttribute('aria-hidden', String(!isActive));
      section.classList.toggle('is-active', isActive);
      if (isActive) activeSection = section;
    });

    syncTopSwitch(resolvedPath);
    document.body.dataset.activeView = meta.view;
    document.title = meta.title;

    if (activeSection) {
      activeSection.scrollTop = 0;

      if (changed) {
        activeSection.classList.remove('view-enter');
        void activeSection.offsetWidth;
        activeSection.classList.add('view-enter');
        window.setTimeout(() => {
          activeSection.classList.remove('view-enter');
        }, 260);
      }
    }

    if (changed) {
      document.dispatchEvent(
        new CustomEvent('umrah:view-change', {
          detail: {
            path: resolvedPath,
            view: meta.view,
            label: meta.label,
          },
        }),
      );
    }
  }

  /**
   * Minta app.js mengganti modul lewat moduleSelect agar state, label, dan
   * localStorage tetap sinkron. Tampilan langsung diaktifkan agar tetap
   * responsif mesin jika event app.js belum siap.
   */
  function requestView(path) {
    if (!MODULE_VIEWS[path]) return;

    activateView(path);

    const select = document.getElementById('moduleSelect');
    if (select && select.value !== path) {
      select.value = path;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document
      .querySelectorAll('#top-view-switch [data-view-path]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          requestView(button.dataset.viewPath);
        });
      });

    // app.js memancarkan event ini setelah label modul diperbarui.
    document.addEventListener('umrah:module-change', (event) => {
      const path = event.detail?.path;
      if (path) activateView(path);
    });

    const select = document.getElementById('moduleSelect');
    activateView(select?.value || DEFAULT_PATH);
  });

  window.TabController = {
    show: requestView,
    activate: activateView,
    current: () => ({ path: currentPath, view: currentView }),
  };
})();
