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
  // sonner-js is loaded as an ES module by the inline script in the page
  // head, which assigns `window.toast` and fires `seedrpool:toast-ready`.
  // That module may resolve before or after this file runs, so we handle
  // both: check eagerly, and listen for the event.
  //
  // The module has a DEFAULT export, not a named `toast`. Importing it as
  // `{ toast }` (which the previous build did) throws a SyntaxError, leaves
  // `window.toast` undefined, and silently downgrades every toast in the
  // app to a console.log — which is why no action appeared to give feedback.
  // -------------------------------------------------------------------
  const toastState = { ready: false, fn: null };
  /** Messages that arrived before sonner finished loading. */
  const pending = [];

  function ensureToast() {
    if (toastState.ready) return toastState.fn;
    if (window.toast && typeof window.toast === 'function') {
      toastState.fn = window.toast;
      toastState.ready = true;
      try { window.toast.config?.({ position: 'bottom-right', duration: 4000, theme: 'dark' }); } catch (_) {}
      return toastState.fn;
    }
    return null;
  }

  function emit(t, kind, title, detail) {
    const opts = detail ? { description: detail } : undefined;
    try {
      if (kind === 'ok')        t.success(title, opts);
      else if (kind === 'bad')  t.error(title, opts);
      else if (kind === 'warn') t.warning(title, opts);
      else                      t(title, opts);
    } catch (e) { console.error('toast error', e); }
  }

  function showToast(kind, title, detail) {
    const t = ensureToast();
    if (!t) {
      // Queue rather than drop. A fast click on a cold page used to lose
      // its feedback entirely.
      pending.push([kind, title, detail]);
      console.log('[toast:queued]', kind, title, detail || '');
      return;
    }
    emit(t, kind, title, detail);
  }
  window.showToast = showToast;

  function drainPending() {
    const t = ensureToast();
    if (!t) return false;
    while (pending.length > 0) {
      const q = pending.shift();
      emit(t, q[0], q[1], q[2]);
    }
    return true;
  }

  window.addEventListener('seedrpool:toast-ready', drainPending);

  // The event may have fired before this script ran, so poll briefly as a
  // fallback. Stops as soon as sonner is available.
  if (!drainPending()) {
    let pollCount = 0;
    const toastWaiter = setInterval(() => {
      pollCount += 1;
      if (drainPending()) { clearInterval(toastWaiter); return; }
      if (pollCount > 100) { clearInterval(toastWaiter); } // 5s
    }, 50);
  }

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

    // HTTP status is authoritative. Action endpoints now return 4xx/5xx on
    // failure, so a proxy error or an auth challenge cannot be misread as
    // a successful action.
    const httpOk = xhr.status >= 200 && xhr.status < 300;

    if (httpOk && body && body.ok) {
      const data = body.data || {};
      if (data.results && Array.isArray(data.results)) {
        // Ingest response: one toast per magnet.
        for (const r of data.results) {
          const name = r.displayName || r.magnet.slice(0, 40) + '…';
          const detail = r.freeAfter !== null && r.freeAfter !== undefined
            ? name + ' · ' + formatBytes(r.freeAfter) + ' free'
            : name;
          showToast('ok', `Queued on ${r.accountId}`, detail);
        }
        if (data.failures && data.failures.length > 0) {
          for (const f of data.failures) showToast('bad', 'Ingest failed', f.error);
        }
        // Clear the textarea so a second paste does not re-queue the first.
        if (e.target && e.target.tagName === 'FORM') {
          try { e.target.reset(); } catch (_) {}
        }
        // Deliberately no page reload here. A reload would destroy the toast
        // the user is meant to read, which is the exact failure mode this
        // whole path replaced. The transfers table polls itself instead.
        refreshLiveRegions();
      } else if (data.reauthed) {
        showToast('ok', `Password updated for ${data.accountId}`, 'Verified against Seedr and saved');
      } else if (data.scope === 'account') {
        // Per-account reindex is awaited server-side, so it reports real counts.
        showToast(
          'ok',
          `Reindexed ${data.accountId}`,
          `${data.videos} video${data.videos === 1 ? '' : 's'}, ` +
          `${data.subtitles} subtitle${data.subtitles === 1 ? '' : 's'}` +
          (data.pruned > 0 ? `, ${data.pruned} pruned` : ''),
        );
        refreshLiveRegions();
      } else if (data.scope === 'all') {
        showToast('info', 'Reindex started', 'Scanning every account in the background');
      } else if (data.sourceDeleted !== undefined) {
        // Move: the source delete can fail independently of the copy.
        showToast(
          data.sourceDeleted ? 'ok' : 'warn',
          `Moved to ${data.accountId}`,
          data.sourceDeleted ? 'Source copy deleted' : `Source NOT deleted: ${data.sourceError || 'unknown'}`,
        );
        refreshLiveRegions();
      } else if (data.accountId && data.transferId && data.displayName) {
        showToast('ok', `Re-added to ${data.accountId}`, data.displayName);
        refreshLiveRegions();
      } else if (data.accountId) {
        // Account CRUD.
        const verb = (e.target && e.target.dataset && e.target.dataset.toastVerb) || 'Done';
        showToast('ok', `${verb} ${data.accountId}`, data.email || '');
      } else if (data.written !== undefined) {
        // A dump can succeed at writing files while those files are missing
        // sections, so the two counts are reported separately: "8 written"
        // with zeros in every file was the bug that hid a broken capture.
        const parts = [`${data.written} written`];
        if (data.incomplete > 0) parts.push(`${data.incomplete} incomplete`);
        if (data.errors > 0) parts.push(`${data.errors} failed`);
        showToast(
          data.errors > 0 ? 'bad' : data.incomplete > 0 ? 'warn' : 'ok',
          'Dump complete',
          parts.join(', '),
        );
      } else if (data.reloaded) {
        showToast('ok', 'Pool reloaded', `${data.accounts} account${data.accounts === 1 ? '' : 's'} probed`);
        refreshLiveRegions();
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
    } else {
      const msg = (body && body.error) || ('HTTP ' + xhr.status);
      showToast('bad', 'Action failed', msg);
    }
  });

  /** Mirrors the server's formatBytes so toasts read the same as the page. */
  function formatBytes(n) {
    // The server serializes its own implementation into the page before this
    // script runs, so this fallback only exists if that injection ever breaks.
    if (typeof window.formatBytes === 'function') return window.formatBytes(n);
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
  }

  // htmx transport errors.
  //
  // `htmx:responseError` fires for every non-2xx, and so does
  // `htmx:afterRequest`. Now that action endpoints return real 4xx/5xx,
  // both would fire for the same failure and the user would see two
  // toasts. The JSON case is already reported above with the server's own
  // message, so this handler only covers non-JSON failures (an HTML error
  // page, a proxy 502, an auth challenge).
  document.addEventListener('htmx:responseError', (e) => {
    const xhr = e.detail && e.detail.xhr;
    const ct = (xhr && xhr.getResponseHeader('content-type')) || '';
    if (ct.includes('application/json')) return;
    const status = xhr ? xhr.status : 0;
    showToast(
      'bad',
      'Request failed',
      status === 401 ? 'Not authorized — reload and sign in again' : 'HTTP ' + status,
    );
  });
  document.addEventListener('htmx:sendError', () => {
    showToast('bad', 'Network error', 'Could not reach the server');
  });

  // htmx after-swap: re-bind any Alpine-declared x-data and re-focus the
  // first input that lost focus on swap.
  document.addEventListener('htmx:afterSwap', () => {
    // Alpine processes new DOM on the next microtask; nothing to do here.
  });

  // -------------------------------------------------------------------
  // Live regions.
  //
  // Anything marked `data-live` re-fetches itself from the server on a
  // timer via htmx. The transfers table uses this: previously you added a
  // torrent, got a toast, and then had to refresh by hand to watch it
  // progress. Polling is cheap because the pool caches the transfer fanout
  // for 5s, so ten browser tabs still cost one Seedr round-trip.
  //
  // `refreshLiveRegions` forces an immediate poll, used right after an
  // action so the table reflects it without waiting for the next tick.
  // -------------------------------------------------------------------
  function refreshLiveRegions() {
    if (!window.htmx) return;
    document.querySelectorAll('[data-live]').forEach((el) => {
      try { window.htmx.trigger(el, 'seedrpool:refresh'); } catch (_) {}
    });
  }
  window.refreshLiveRegions = refreshLiveRegions;

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
  //
  // Registration timing is the subtle part. Alpine's CDN build ends with
  // `queueMicrotask(() => Alpine.start())`, and the microtask queue drains
  // between two deferred scripts. So when Alpine was loaded before this
  // file, `alpine:init` had ALREADY fired by the time the listener below
  // was added: the store never registered, `$store.modals` was undefined,
  // and every modal plus every confirm-gated destructive action silently
  // threw. The page load order now puts this file first, and the guard
  // below covers the case where Alpine somehow started anyway.
  // -------------------------------------------------------------------
  function registerAlpine() {
    const A = window.Alpine;
    if (!A || registerAlpine.done) return;
    registerAlpine.done = true;

    A.store('modals', {
      add: false,
      reauth: false,
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
          m.reauth = false;
          m.confirm = null;
          m.shortcuts = false;
        });
        document.addEventListener('seedrpool:shortcuts', () => {
          A.store('modals').shortcuts = true;
        });
      },
    }));
  }
  registerAlpine.done = false;

  document.addEventListener('alpine:init', registerAlpine);
  // Alpine may already have started (script order changes, cached bundles,
  // an extension injecting it early). Registering twice is guarded above,
  // and registering late still works because Alpine re-resolves stores on
  // access.
  if (window.Alpine) registerAlpine();

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
      .then((r) => r.json().then((body) => ({ status: r.status, ok: r.ok, body })))
      .then((res) => {
        const body = res.body || {};
        // Trust the HTTP status first. Failures now come back as real 4xx/5xx
        // instead of a 200 with `ok:false`, so a network proxy or an error
        // page can no longer be mistaken for success.
        if (!res.ok || body.ok === false) {
          showToast('bad', 'Action failed', body.error || ('HTTP ' + res.status));
          return;
        }
        const d = body.data || {};
        if (d.seedrDeleted !== undefined) {
          showToast(
            d.failed > 0 ? 'warn' : 'ok',
            `Purged ${d.accountId}`,
            `${d.seedrDeleted} Seedr item${d.seedrDeleted === 1 ? '' : 's'}, ` +
              `${d.transfersCancelled} transfer${d.transfersCancelled === 1 ? '' : 's'}, ` +
              `${d.libraryDeleted} library row${d.libraryDeleted === 1 ? '' : 's'}` +
              (d.failed > 0
                ? `, ${d.failed} failed: ${d.failureReasons ? d.failureReasons.join('; ') : 'unknown'}`
                : ''),
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
        // No page reload. Reloading destroyed the toast the user was meant
        // to read — the exact failure this whole JSON-action path was built
        // to fix. Live regions repoll instead, and the row the action
        // targeted is removed from the DOM directly.
        removeTargetRow(detail);
        refreshLiveRegions();
      })
      .catch((err) => showToast('bad', 'Request failed', err && err.message));
  };

  /**
   * Removes the row or card the confirmed action just destroyed.
   *
   * Without this the user sees a success toast next to a row that still
   * claims to exist, and has to refresh to believe it. Matching on the
   * data attributes the server renders keeps this independent of markup
   * nesting.
   */
  function removeTargetRow(detail) {
    const sel = [];
    if (detail.accountId && detail.fileId) {
      sel.push(`[data-file-row="${detail.accountId}/${detail.fileId}"]`);
    }
    if (detail.accountId && detail.transferId) {
      sel.push(`[data-transfer-row="${detail.accountId}/${detail.transferId}"]`);
    }
    if (detail.action === 'delete' && detail.accountId) {
      sel.push(`[data-account-row="${detail.accountId}"]`);
    }
    for (const s of sel) {
      document.querySelectorAll(s).forEach((el) => {
        el.style.transition = 'opacity 180ms ease-out';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 190);
      });
    }
  }

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
