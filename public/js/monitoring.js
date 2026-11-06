/**
 * Modul frontend Monitoring Jamaah.
 * Hanya mengambil ringkasan agregat; chat & pencarian AI tetap di app.js.
 */
(() => {
  const ENDPOINT = '/api/monitoring/summary';

  const els = {
    total: document.getElementById('monitoring-total'),
    complete: document.getElementById('monitoring-complete'),
    incomplete: document.getElementById('monitoring-incomplete'),
    orders: document.getElementById('monitoring-orders'),
    syncChip: document.getElementById('monitoring-sync-chip'),
    syncDot: document.getElementById('monitoring-sync-dot'),
    syncLabel: document.getElementById('monitoring-sync-label'),
    refresh: document.getElementById('monitoring-refresh'),
  };

  let loaded = false;
  let loading = false;
  let lastData = null;

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('id-ID');
  }

  function toast(title, message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, type);
    }
  }

  function setChip(label, tone = 'online') {
    if (els.syncLabel) els.syncLabel.textContent = label;
    if (!els.syncDot) return;

    els.syncDot.className = 'h-1.5 w-1.5 rounded-full';
    if (tone === 'loading') {
      els.syncDot.classList.add('bg-amber-400', 'animate-pulse');
    } else if (tone === 'offline') {
      els.syncDot.classList.add('bg-red-400');
    } else {
      els.syncDot.classList.add(
        'bg-gold-400',
        'shadow-[0_0_8px_rgba(245,158,11,0.8)]',
      );
    }
  }

  function setValues(values) {
    Object.entries(values).forEach(([key, value]) => {
      if (els[key]) els[key].textContent = formatNumber(value);
    });
  }

  function sourceLabel(source) {
    if (!source) return 'SGO Admin';
    const moduleCount = Array.isArray(source.modules) ? source.modules.length : 0;
    const type =
      source.type === 'focused'
        ? 'SGO Admin'
        : source.type === 'local-json'
          ? 'Local store'
          : 'SGO Admin';
    return moduleCount ? `${type} • ${moduleCount} modul` : type;
  }

  function renderChip(data) {
    const total = Number(data.totalJamaah || 0);
    if (!total) {
      setChip('Belum ada data jamaah', 'offline');
      return;
    }

    const rate = Number(data.completionRate || 0);
    const compact = window.matchMedia('(max-width: 639px)').matches;
    const label = compact
      ? `${formatNumber(total)} jamaah`
      : `${formatNumber(total)} jamaah • ${rate.toLocaleString('id-ID')}% lengkap`;
    setChip(label, 'online');
  }

  function render(data) {
    lastData = data;
    const total = Number(data.totalJamaah || 0);
    setValues({
      total,
      complete: data.complete,
      incomplete: data.incomplete,
      orders: data.totalOrders,
    });

    renderChip(data);

    if (!total) return;

    if (els.syncChip) {
      const source = data.source || null;
      const updatedAt = data.generatedAt
        ? new Date(data.generatedAt).toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      els.syncChip.title = [sourceLabel(source), updatedAt ? `diperbarui ${updatedAt}` : '']
        .filter(Boolean)
        .join(' • ');
    }
  }

  async function load({ force = false } = {}) {
    if (loading) return;
    if (loaded && !force) return;

    loading = true;
    if (els.refresh) {
      els.refresh.disabled = true;
      els.refresh.setAttribute('aria-busy', 'true');
    }
    setChip(force ? 'Menyegarkan ringkasan...' : 'Memuat ringkasan...', 'loading');

    try {
      const response = await fetch(ENDPOINT, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Ringkasan monitoring gagal dimuat.');
      }

      render(data);
      loaded = true;
    } catch (error) {
      setChip('Gagal memuat ringkasan', 'offline');
      if (force) toast('Error', error.message, 'error');
    } finally {
      loading = false;
      if (els.refresh) {
        els.refresh.disabled = false;
        els.refresh.removeAttribute('aria-busy');
      }
    }
  }

  function onShow() {
    if (!loaded) load();
  }

  function refresh() {
    return load({ force: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (els.refresh) {
      els.refresh.addEventListener('click', refresh);
    }

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (lastData) renderChip(lastData);
      }, 160);
    });

    document.addEventListener('umrah:view-change', (event) => {
      if (event.detail?.view === 'monitoring') onShow();
    });

    document.addEventListener('umrah:data-updated', () => {
      loaded = false;
      onShow();
    });

    if (document.getElementById('view-monitoring')?.hidden === false) {
      onShow();
    }
  });

  window.MonitoringModule = { refresh, onShow };
})();
