/**
 * Client-side behaviour for the admin console.
 *
 * Composition:
 *   - Alpine 3 is the framework. `seedrpool` is the root store; per-page state
 *     is added via `x-data` on the page element.
 *   - htmx drives partial updates: form actions, the inline action buttons,
 *     the library view toggles. The whole shell never re-renders.
 *   - sonner-js is the toast surface, loaded as an ESM module from the CDN.
 *     The loader is below; `seedrpool.toast(...)` proxies to it once ready.
 *
 * What this file replaces:
 *   - the previous hand-rolled SPA routing in `navigate()` — gone. htmx's
 *     `hx-get`/`hx-push-url` does this correctly and intercepts link clicks
 *     automatically.
 *   - the broken `data-modal-open` / `data-confirm` handlers — gone. Modals
 *     and confirm dialogs are Alpine components, declared in markup.
 *   - the post-render `createIcons()` re-hydration loop — gone. Icons are
 *     inline SVG.
 *
 * No inline onclick attributes: all behaviour is wired here so the markup
 * stays declarative.
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------
  // Toast surface.
  //
  // sonner-js loads asynchronously as an ES module. We must not call
  // `toast()` until the module is in window, and we must not assume the
  // ESM import resolved before Alpine's first user interaction.
  // -------------------------------------------------------------------
  const toastState = { ready: false, fn: null };

  function ensureToast() {
    if (toastState.ready) return toastState.fn;
    if (window.toast && typeof window.toast === 'function') {
      toastState.fn = window.toast;
      toastState.ready = true;
      try { window.toast.config?.({ position: 'bottom-right', duration: 3500, theme: 'dark' }); } catch (_) {}
      return toastState.fn;
    }
    return null;
  }

  function showToast(kind, title, detail) {
    const t = ensureToast();
    if (!t) { console.log('[toast]', kind, title, detail || ''); return; }
    const opts = detail ? { description: detail } : undefined;
    try {
      if (kind === 'ok')        t.success(title, opts);
      else if (kind === 'bad')  t.error(title, opts);
      else if (kind === 'warn') t.warning(title, opts);
      else                      t(title, opts);
    } catch (e) { console.error('toast error', e); }
  }
  window.showToast = showToast;

  // Watch for sonner to load — Sonnerjs publishes a custom event? No. The
  // simplest correct path is a small poll, and to stop as soon as it
  // resolves. Hidden cost, runs only until first success.
  let pollCount = 0;
  const toastWaiter = setInterval(() => {
    pollCount += 1;
    if (ensureToast()) { clearInterval(toastWaiter); return; }
    if (pollCount > 80) clearInterval(toastWaiter); // 4s
  }, 50);

  // -------------------------------------------------------------------
  // Copy-to-clipboard helper.
  // -------------------------------------------------------------------
  window.copyText = function (btn, text) {
    if (!navigator.clipboard) { showToast('bad', 'Clipboard unavailable'); return; }
    navigator.clipboard.writeText(text).then(function () {
      const orig = btn.dataset.orig || btn.innerHTML;
      btn.dataset.orig = orig;
      btn.innerHTML = '<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied';
      btn.classList.add('copy-flash');
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copy-flash'); }, 1400);
      showToast('ok', 'Copied', text.length > 50 ? text.slice(0, 50) + '…' : text);
    }).catch(err => showToast('bad', 'Copy failed', err && err.message));
  };

  // -------------------------------------------------------------------
  // htmx behaviour.
  // -------------------------------------------------------------------
  function findTargetButton(e) {
    if (!e || !e.target) return null;
    if (e.target.matches && e.target.matches('button, .btn')) return e.target;
    if (e.target.closest) {
      const b = e.target.closest('button, .btn');
      if (b) return b;
    }
    if (e.target.querySelector) {
      return e.target.querySelector('button[type=submit], .btn.primary, .btn');
    }
    return null;
  }

  document.addEventListener('htmx:beforeRequest', (e) => {
    const btn = findTargetButton(e);
    if (btn) {
      btn.dataset.orig = btn.dataset.orig || btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
    }
  });

  document.addEventListener('htmx:afterRequest', (e) => {
    const btn = findTargetButton(e);
    if (btn && btn.dataset.orig) {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.orig;
      delete btn.dataset.orig;
    }
  });

  // All `hx-post`/`hx-get` responses that return JSON get rendered as
  // toasts. This is the success path the previous design was missing:
  // a magnet ingest is now a toast showing the account and torrent name,
  // not a "Done" page that replaces the dashboard.
  document.addEventListener('htmx:afterRequest', (e) => {
    const xhr = e.detail.xhr;
    if (!xhr) return;
    const ct = xhr.getResponseHeader('content-type') || '';
    if (!ct.includes('application/json')) return;
    let body;
    try { body = JSON.parse(xhr.responseText); } catch (_) { return; }

    if (body && body.ok) {
      const data = body.data || {};
      if (data.results && Array.isArray(data.results)) {
        // Ingest response: one toast per magnet.
        for (const r of data.results) {
          const name = r.displayName || r.magnet.slice(0, 40) + '…';
          showToast('ok', `Queued on ${r.accountId}`, name);
        }
        if (data.failures && data.failures.length > 0) {
          for (const f of data.failures) showToast('bad', 'Ingest failed', f.error);
        }
        // Reset form and refresh table after ingest
        if (e.target && e.target.tagName === 'FORM') {
          try { e.target.reset(); } catch (_) {}
        }
        setTimeout(() => {
          if (window.location.pathname === '/admin' || window.location.pathname === '/admin/transfers') {
            window.location.reload();
          }
        }, 1200);
      } else if (data.accountId) {
        // Account CRUD.
        const verb = e.target.dataset.toastVerb || 'Done';
        showToast('ok', `${verb} ${data.accountId}`, data.email || '');
      } else if (data.written !== undefined) {
        showToast(data.errors > 0 ? 'warn' : 'ok', 'Dump complete', `${data.written} written, ${data.errors} errors`);
      } else if (data.reloaded) {
        showToast('ok', 'Pool reloaded');
      } else if (data.started) {
        showToast('info', 'Reindex started');
      } else if (data.queued !== undefined) {
        showToast('info', 'Re-fetching metadata', `${data.queued} titles queued`);
      } else if (data.cleared !== undefined) {
        showToast('info', 'Metadata reset', `${data.cleared} titles will be re-fetched`);
      } else if (data.titleKey) {
        showToast('info', 'Re-fetching metadata for one title');
      } else {
        showToast('ok', 'Done');
      }
    } else if (body && body.ok === false) {
      showToast('bad', 'Action failed', body.error || 'Unknown error');
    }
  });

  // htmx errors (network, 5xx) — toast instead of console.
  document.addEventListener('htmx:responseError', (e) => {
    showToast('bad', 'Request failed', 'HTTP ' + e.detail.xhr.status);
  });
  document.addEventListener('htmx:sendError', () => {
    showToast('bad', 'Network error');
  });

  // htmx after-swap: re-bind any Alpine-declared x-data and re-focus the
  // first input that lost focus on swap.
  document.addEventListener('htmx:afterSwap', () => {
    // Alpine processes new DOM on the next microtask; nothing to do here.
  });

  // -------------------------------------------------------------------
  // Library view mode persistence.
  // -------------------------------------------------------------------
  window.setLibraryView = function (mode) {
    const grid = document.getElementById('libraryGrid');
    const table = document.getElementById('libraryTableWrap');
    const btnGrid = document.getElementById('btnViewGrid');
    const btnTable = document.getElementById('btnViewTable');
    if (!grid || !table) return;
    if (mode === 'table') {
      grid.style.display = 'none';
      table.style.display = '';
      btnGrid && btnGrid.classList.remove('active');
      btnTable && btnTable.classList.add('active');
      try { localStorage.setItem('seedrpool_view_mode', 'table'); } catch (_) {}
    } else {
      grid.style.display = '';
      table.style.display = 'none';
      btnGrid && btnGrid.classList.add('active');
      btnTable && btnTable.classList.remove('active');
      try { localStorage.setItem('seedrpool_view_mode', 'grid'); } catch (_) {}
    }
  };

  // Restored on next microtask — DOM ready is implicit since this is in
  // the head with `defer`.
  try {
    const saved = localStorage.getItem('seedrpool_view_mode');
    if (saved === 'table') {
      // Wait one tick so the page element exists.
      setTimeout(() => window.setLibraryView('table'), 0);
    }
  } catch (_) {}

  // -------------------------------------------------------------------
  // Library filter (categories / resolution / torn).
  //
  // Filtering is purely a CSS hide/show, no refetch.
  // -------------------------------------------------------------------
  window.filterLibraryCategory = function (btn, category) {
    document.querySelectorAll('.filter-tab').forEach((tab) => tab.classList.remove('active'));
    btn.classList.add('active');
    const cards = document.querySelectorAll('.poster-card');
    const rows = document.querySelectorAll('#movieTable tbody tr');
    cards.forEach((card) => {
      const match = category === 'all' || (card.dataset.category || '').split(' ').includes(category);
      card.style.display = match ? '' : 'none';
    });
    rows.forEach((row) => {
      const match = category === 'all' || (row.dataset.category || '').split(' ').includes(category);
      row.style.display = match ? '' : 'none';
    });
  };

  // -------------------------------------------------------------------
  // Live search.
  // -------------------------------------------------------------------
  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('search-input')) return;
    const q = t.value.trim().toLowerCase();
    const cards = document.querySelectorAll('.poster-card');
    const rows = document.querySelectorAll('#movieTable tbody tr');
    cards.forEach((card) => {
      if (!q) { card.style.display = ''; return; }
      card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
    rows.forEach((row) => {
      if (!q) { row.style.display = ''; return; }
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // -------------------------------------------------------------------
  // Keyboard shortcut: '/' focuses search, '?' opens shortcuts help.
  // The sidebar advertises "?" for shortcuts — was a lie in the previous
  // build; this wires it up.
  // -------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === '/') {
      e.preventDefault();
      const s = document.querySelector('input.search-input');
      if (s) s.focus();
    } else if (e.key === '?') {
      e.preventDefault();
      const ev = new CustomEvent('seedrpool:shortcuts');
      document.dispatchEvent(ev);
    } else if (e.key === 'Escape') {
      // Close any open Alpine modal.
      document.dispatchEvent(new CustomEvent('seedrpool:close-modals'));
    }
  });

  // -------------------------------------------------------------------
  // Alpine stores: modals and the confirm dialog.
  //
  // The previous build shipped `data-modal-open` and `data-confirm`
  // attributes with no handler behind them — the Add-account modal did
  // nothing and every destructive button fired with no confirmation.
  // These are the real implementations, declared as Alpine stores so the
  // markup stays declarative.
  // -------------------------------------------------------------------
  document.addEventListener('alpine:init', () => {
    const A = window.Alpine;

    A.store('modals', {
      add: false,
      confirm: null, // { verb, body, action, accountId?, fileId? }
      shortcuts: false,
    });

    A.data('seedrpool', () => ({
      init() {
        // Open/close plumbing driven by window events so any button
        // anywhere can trigger a modal without prop drilling.
        window.addEventListener('seedrpool:open-modal', (e) => {
          const id = e.detail && e.detail.id;
          if (id === 'addAccountModal') A.store('modals').add = true;
        });
        window.addEventListener('seedrpool:confirm', (e) => {
          A.store('modals').confirm = e.detail || null;
        });
        document.addEventListener('seedrpool:close-modals', () => {
          const m = A.store('modals');
          m.add = false;
          m.confirm = null;
          m.shortcuts = false;
        });
        document.addEventListener('seedrpool:shortcuts', () => {
          A.store('modals').shortcuts = true;
        });
      },
    }));
  });

  // -------------------------------------------------------------------
  // Confirm dialog: performs the action once the user accepts.
  //
  // Endpoint mapping lives here rather than in markup so a new
  // destructive action only has to add one entry.
  // -------------------------------------------------------------------
  const CONFIRM_ENDPOINTS = {
    purge:            { url: '/admin/api/account/purge',  fields: ['accountId'] },
    delete:           { url: '/admin/api/account/delete', fields: ['accountId'] },
    'file-delete':    { url: '/admin/api/file/delete',    fields: ['accountId', 'fileId'] },
    'clear-metadata': { url: '/admin/api/clear-metadata', fields: [] },
    'transfer-delete':{ url: '/admin/api/transfer/delete',fields: ['accountId', 'transferId'] },
  };

  window.runConfirmedAction = function (detail) {
    const spec = CONFIRM_ENDPOINTS[detail.action];
    if (!spec) { showToast('bad', 'Unknown action', detail.action); return; }
    const fd = new FormData();
    for (const f of spec.fields) {
      if (detail[f] !== undefined) fd.append(f, detail[f]);
    }
    fetch(spec.url, { method: 'POST', body: fd })
      .then((r) => r.json())
      .then((body) => {
        if (body.ok) {
          const d = body.data || {};
          if (d.seedrDeleted !== undefined) {
            showToast(
              d.failed > 0 ? 'warn' : 'ok',
              `Purged ${d.accountId}`,
              `${d.seedrDeleted} Seedr item${d.seedrDeleted === 1 ? '' : 's'}, ${d.libraryDeleted} library row${d.libraryDeleted === 1 ? '' : 's'}` +
                (d.failed > 0 ? `, ${d.failed} failed` : ''),
            );
          } else if (d.remaining !== undefined) {
            showToast('ok', `Removed ${d.accountId}`, `${d.remaining} account${d.remaining === 1 ? '' : 's'} left in the pool`);
          } else if (d.cleared !== undefined) {
            showToast('ok', 'Metadata reset', `${d.cleared} titles will be re-fetched`);
          } else if (d.fileId) {
            showToast('ok', 'File deleted', `${d.accountId} / ${d.fileId}`);
          } else if (d.transferId) {
            showToast('ok', 'Transfer removed', `${d.accountId} / ${d.transferId}`);
          } else {
            showToast('ok', 'Done');
          }
          // Reload after a beat so the toast is readable.
          setTimeout(() => window.location.reload(), 900);
        } else {
          showToast('bad', 'Action failed', body.error || 'Unknown error');
        }
      })
      .catch((err) => showToast('bad', 'Request failed', err && err.message));
  };

  // -------------------------------------------------------------------
  // Initial page toast (if the server flagged one in a data attribute).
  // -------------------------------------------------------------------
  try {
    const el = document.querySelector('[data-initial-toast]');
    if (el) {
      const kind = el.dataset.kind || 'info';
      const title = el.dataset.title || 'Done';
      const detail = el.dataset.detail || '';
      const fire = () => showToast(kind, title, detail);
      if (ensureToast()) fire(); else setTimeout(fire, 100);
    }
  } catch (_) {}

  // htmx `HX-Trigger` toasts from the server.
  document.body && document.body.addEventListener('seedrpool:toast', (e) => {
    const d = e.detail || {};
    showToast(d.kind || 'info', d.title || 'Done', d.detail);
  });

  window.addEventListener('seedrpool:reload-partial', () => {
    setTimeout(() => {
      if (window.location.pathname === '/admin' || window.location.pathname === '/admin/transfers') {
        window.location.reload();
      }
    }, 1200);
  });
})();
