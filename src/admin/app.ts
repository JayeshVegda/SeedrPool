/**
 * Admin interface.
 *
 * Server-rendered HTML with the htmx + Alpine layer for interactivity.
 * The page is a thin renderer: every page handler builds the body string and
 * hands it to `layout()`. JSON for actions lives in `core/admin-actions.ts`;
 * this file never returns full HTML for an action endpoint.
 *
 * Pages:
 *   /admin                       overview: fleet cards, KPIs, ingest, storage headroom
 *   /admin/library               library grid + table view
 *   /admin/transfers             in-flight transfers across all accounts
 *   /admin/accounts              fleet: add / re-probe / dump
 *   /admin/accounts/:id          per-account detail: info, library, history, CRUD
 *   /admin/activity              transaction log with filters
 *   /admin/dumps                 latest dump per account
 */

import type { AccountPool, AccountStatus } from '../core/account-pool.ts';
import type { Transfer } from '../core/types.ts';
import type { Config } from '../core/config.ts';
import type { CredentialFile } from '../core/credentials.ts';
import { esc, formatBytes, html, layout, raw, icon } from './html.ts';
import { iconMarkup } from './icons.ts';
import { htmlResponse, type RouteContext } from '../core/router.ts';
import type { LibraryStore, TitleSummary } from '../library/store.ts';
import { AdminViews, type AccountCard, type AccountDetail, type LibraryCard } from '../core/admin-views.ts';
import { AdminActions, type DumpResult } from '../core/admin-actions.ts';
import { magnetDisplayName } from './magnet-name.ts';
import { SeedrV1Provider } from '../providers/seedr-v1.ts';
import type { Indexer } from '../library/indexer.ts';
import type { MetadataEnricher } from '../library/metadata-enricher.ts';
import type { AdminAssets } from '../core/assets.ts';

const RAW = Symbol('raw');
interface RawBody { [RAW]: string }
function isRaw(value: unknown): value is RawBody {
  return typeof value === 'object' && value !== null && RAW in value;
}

/** How many activity rows the overview timeline shows. */
const RECENT_ACTIVITY = 24;

export class AdminApp {
  #getPool: () => AccountPool;
  #config: Config;
  #credentials: CredentialFile;
  #onAccountsChanged: () => Promise<void>;
  #library: LibraryStore;
  #views: AdminViews;
  #healthReport: () => import('../core/health.ts').HealthReport;
  #actions: AdminActions;
  #indexer: Indexer;
  #enricher: MetadataEnricher;
  #assets: AdminAssets;
  #runDump: () => Promise<DumpResult>;

  constructor(deps: {
    getPool: () => AccountPool;
    config: Config;
    credentials: CredentialFile;
    onAccountsChanged: () => Promise<void>;
    library: LibraryStore;
    indexer: Indexer;
    enricher: MetadataEnricher;
    actions: AdminActions;
    views: AdminViews;
    /** Builds a fresh health report; see core/health.ts. */
    healthReport: () => import('../core/health.ts').HealthReport;
    assets: AdminAssets;
    runDump: () => Promise<DumpResult>;
  }) {
    this.#getPool = deps.getPool;
    this.#config = deps.config;
    this.#credentials = deps.credentials;
    this.#onAccountsChanged = deps.onAccountsChanged;
    this.#library = deps.library;
    this.#indexer = deps.indexer;
    this.#enricher = deps.enricher;
    this.#actions = deps.actions;
    this.#views = deps.views;
    this.#healthReport = deps.healthReport;
    this.#assets = deps.assets;
    this.#runDump = deps.runDump;
  }

  setCredentials(credentials: CredentialFile): void {
    this.#credentials = credentials;
  }

  /** Wraps a body string in the standard layout. */
  #page(title: string, activeNav: string, body: string | RawBody, pageInit?: string): Response {
    const bodyStr = isRaw(body) ? body[RAW] : body;
    return htmlResponse(layout({
      title,
      activeNav,
      body: bodyStr,
      cssPath: this.#assets.css.path,
      jsPath: this.#assets.js.path,
      htmxPath: this.#assets.htmx.path,
      alpinePath: this.#assets.alpine.path,
      sonnerPath: this.#assets.sonner.path,
      pageInit: pageInit ?? '',
    }));
  }

  /**
   * Returns a small toast payload encoded as an htmx response header.
   * htmx triggers the `seedrpool:toast` window event which `client.js`
   * listens to. Used by the action endpoints that fire-and-redirect, so the
   * caller sees a success toast with the action's outcome even after a 303.
   */
  #toastResponse(kind: 'ok' | 'bad' | 'warn' | 'info', title: string, detail?: string): Response {
    const body = JSON.stringify({ kind, title, ...(detail !== undefined ? { detail } : {}) });
    return new Response(null, {
      status: 200,
      headers: {
        'HX-Trigger': `seedrpool:toast`,
        'HX-Trigger-Event-Header': body,
      },
    });
  }

  // --------------------------------------------------------------------
  // Overview
  // --------------------------------------------------------------------

  async overview(): Promise<Response> {
    // Trigger the pool refresh in the background so the next request lands
    // on warm data; the current request uses whatever the cache holds.
    void this.#getPool().refresh();
    const kpis = await this.#views.overview();
    const cards = await this.#views.accountCards();
    const activity = this.#library.recentActivity(RECENT_ACTIVITY);
    const manifestUrl = `${this.#config.publicUrl}/${this.#config.addonSecret}/manifest.json`;
    const stremioDeepLink = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;
    const issues = this.#credentials.problems;

    const headroomFill = (kpis.storage.max > 0 ? kpis.storage.used / kpis.storage.max : 0);
    const headroomClass = headroomFill > 0.85 ? 'warn' : '';

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('radio', { size: 11 })} Operator Console</div>
          <h1>Command Deck <span class="num">· ${kpis.nodes.total} nodes · ${formatBytes(kpis.storage.used)} allocated</span></h1>
          <p class="lede">
            ${kpis.nodes.cdnBroken > 0
              ? html`<strong style="color:var(--warn);">${kpis.nodes.cdnBroken} account${kpis.nodes.cdnBroken === 1 ? '' : 's'} on a torn reel</strong> — pool is routing around broken CDN downloads. Existing files play via HLS fallback.`
              : html`All reels intact and healthy. Magnets auto-route to the node with the highest headroom.`}
            ${kpis.nodes.offline > 0
              ? html` <strong style="color:var(--bad);">${kpis.nodes.offline} offline.</strong>`
              : ''}
          </p>
        </div>
        <div class="actions">
          <button class="btn" hx-post="/admin/api/reload" hx-swap="none" data-toast-verb="Pool reloaded">
            ${icon('refresh-cw', { size: 13 })} Re-probe fleet
          </button>
          <button class="btn" hx-post="/admin/api/reindex" hx-swap="none">
            ${icon('database', { size: 13 })} Reindex
          </button>
        </div>
      </div>

      <div class="headroom-card">
        <div class="headroom-header">
          <div class="headroom-title">${icon('hard-drive', { size: 14 })} Master Pool Storage Headroom</div>
          <div class="headroom-stats">
            <strong>${formatBytes(kpis.storage.free)}</strong> free of <strong>${formatBytes(kpis.storage.max)}</strong>
            (${(headroomFill * 100).toFixed(0)}% used)
          </div>
        </div>
        <div class="headroom-meter">
          <div class="headroom-fill ${headroomClass}" style="--fill: ${headroomFill.toFixed(4)}"></div>
        </div>
        <div class="headroom-meta">
          <span>${kpis.nodes.healthy} / ${kpis.nodes.total} nodes online</span>
          <span>${kpis.transfers.active} transfer${kpis.transfers.active === 1 ? '' : 's'} in progress</span>
          ${issues.length > 0 ? html`<span style="color:var(--bad);">${issues.length} credential issue${issues.length === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>

      <div class="bento-grid">
        <div class="card col-7">
          <div class="card-head">
            <div class="card-title">${icon('plus-circle', { size: 14 })} Quick Ingest</div>
            <span class="pill muted">Auto-routed</span>
          </div>
          <form hx-post="/admin/api/magnet" hx-swap="none" hx-on::after-request="window.dispatchEvent(new CustomEvent('seedrpool:reload-partial'))">
            <textarea name="magnet" rows="2" placeholder="Paste magnet URI (magnet:?xt=urn:btih:…) or hash…" required style="min-height: 4.5rem;"></textarea>
            <div style="display:flex; justify-content:space-between; align-items:center; gap: 0.5rem; flex-wrap:wrap; margin-top: 0.65rem;">
              <span class="muted" style="font-size: 0.74rem;">Routes to the node with the most headroom.</span>
              <div style="display:flex; gap: 0.4rem;">
                <button class="btn" type="button" onclick="navigator.clipboard.readText().then(t=>{var ta=document.querySelector('textarea[name=magnet]'); if(ta){ta.value=t; ta.focus();}}).catch(()=>{})">${icon('clipboard-paste', { size: 13 })} Paste</button>
                <button class="primary" type="submit">${icon('arrow-down-circle', { size: 13 })} Ingest Magnet</button>
              </div>
            </div>
          </form>
        </div>

        <div class="card col-5">
          <div class="card-head">
            <div class="card-title">${icon('tv', { size: 14 })} Stremio Addon</div>
            <span class="pill ok live"><span class="dot"></span>Live</span>
          </div>
          <p class="muted" style="font-size: 0.8rem; margin-bottom: 0.75rem; line-height: 1.5;">
            Personal addon endpoint. Install into Stremio on Android, TV, iOS, or Desktop.
          </p>
          <div class="input-group" style="margin-bottom: 0.65rem;">
            <input type="text" readonly value="${esc(manifestUrl)}" onclick="this.select()" />
            <button class="btn" type="button" onclick="copyText(this, '${esc(manifestUrl)}')">${icon('copy', { size: 13 })} Copy</button>
          </div>
          <div style="display:flex; justify-content:flex-end;">
            <a class="btn primary btn-sm" href="${esc(stremioDeepLink)}" target="_blank" rel="noreferrer">${icon('external-link', { size: 13 })} Open in Stremio</a>
          </div>
        </div>

        <div class="kpi col-3">
          <div class="label">${icon('film', { size: 11 })} Movies</div>
          <div class="value">${kpis.library.titles}</div>
          <div class="sub">${kpis.library.needsLookup > 0
            ? html`<strong style="color:var(--warn);">${kpis.library.needsLookup} need metadata</strong>`
            : 'All matched & enriched'}</div>
        </div>

        <div class="kpi col-3">
          <div class="label">${icon('video', { size: 11 })} Files</div>
          <div class="value">${kpis.library.files}</div>
          <div class="sub">${kpis.library.subtitles} subtitle${kpis.library.subtitles === 1 ? '' : 's'}</div>
        </div>

        <div class="kpi col-3">
          <div class="label">${icon('arrow-down-up', { size: 11 })} Transfers</div>
          <div class="value">${kpis.transfers.active}</div>
          <div class="sub">${kpis.transfers.total} total active/queued</div>
        </div>

        <div class="kpi col-3">
          <div class="label">${icon('server', { size: 11 })} Fleet</div>
          <div class="value">${kpis.nodes.healthy} <span style="font-size:0.9rem; font-weight:400; color:var(--text-dim);">/ ${kpis.nodes.total}</span></div>
          <div class="sub">${kpis.nodes.cdnBroken > 0
            ? html`<strong style="color:var(--warn);">${kpis.nodes.cdnBroken} degraded</strong>`
            : '100% operational'}</div>
        </div>

        <div class="card col-6">
          <div class="card-head">
            <div class="card-title">${icon('pie-chart', { size: 14 })} Node Space Distribution</div>
            <span class="pill muted">${formatBytes(kpis.storage.max)} total</span>
          </div>
          ${raw(this.#storageDonut(kpis.storageBreakdown))}
        </div>

        <div class="card col-6">
          <div class="card-head">
            <div class="card-title">${icon('bar-chart-3', { size: 14 })} Media Quality</div>
            <span class="pill purple">${kpis.quality.uhd} 4K UHD</span>
          </div>
          ${raw(this.#qualityBars(kpis.quality))}
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>${icon('server', { size: 12 })} Fleet Nodes <span class="count">${cards.length} accounts</span></h2>
          <a class="btn btn-sm" href="/admin/accounts">Manage accounts →</a>
        </div>
        <div class="fleet-row">${raw(cards.map((c) => this.#accountCard(c)).join(''))}</div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>${icon('activity', { size: 12 })} Recent Activity <span class="count">last ${activity.length} events</span></h2>
          <a class="btn btn-sm" href="/admin/activity">Full log →</a>
        </div>
        ${activity.length === 0
          ? raw(html`
              <div class="empty">
                <h3>No events yet</h3>
                <p>Activity timeline fills automatically as transfers complete and the pool rebalances.</p>
              </div>
            `)
          : raw(html`
              <div class="card" style="padding: 0.85rem 1rem;">
                <ul class="timeline">
                  ${raw(
                    activity
                      .map(
                        (a) =>
                          `<li class="${esc(a.kind)}"><span class="ts">${formatRelative(Date.now() - a.at)} ago</span><span>${esc(a.message)}</span>${a.detail ? ` <span class="detail">— ${esc(a.detail)}</span>` : ''}</li>`,
                      )
                      .join(''),
                  )}
                </ul>
              </div>
            `)}
      </div>
    `;
    return this.#page('Overview', '/admin', body);
  }

  // --------------------------------------------------------------------
  // Account detail page
  // --------------------------------------------------------------------

  async accountDetailPage(ctx: RouteContext): Promise<Response> {
    const accountId = ctx.params['accountId'] ?? '';
    const detail = await this.#views.accountDetail(accountId);
    if (detail === null) {
      return this.#page('Unknown', '/admin/accounts', html`
        <div class="page-head"><div class="lead"><h1>Account not found</h1></div></div>
        <a class="btn" href="/admin/accounts">Back to fleet</a>
      `);
    }
    const cdnBroken = detail.status.cdnHealthy === false;
    const statePill = detail.status.needsReauth
      ? '<span class="pill bad"><span class="dot"></span>Bad password</span>'
      : cdnBroken
        ? '<span class="pill warn"><span class="dot"></span>Torn reel</span>'
        : detail.status.healthy
          ? '<span class="pill ok live"><span class="dot"></span>Healthy</span>'
          : '<span class="pill off"><span class="dot"></span>Offline</span>';

    const titlesRows = detail.titles.slice(0, 50).map((t) => {
      const initial = (t.name[0] ?? '?').toUpperCase();
      const poster = t.imdbId
        ? `https://images.metahub.space/poster/small/${esc(t.imdbId)}/img.jpg`
        : null;
      return `<tr>
        <td>
          <div class="movie-cell">
            <div class="poster-thumb"><span class="poster-thumb-fallback">${initial}</span>${poster ? `<img src="${poster}" alt="" onerror="this.remove();">` : ''}</div>
            <div class="meta">
              <div class="title">${esc(t.name)}</div>
              <div class="sub">
                ${t.imdbId ? `<a href="https://www.imdb.com/title/${esc(t.imdbId)}/" target="_blank" rel="noreferrer">${esc(t.imdbId)}</a>` : '<span class="dim">awaiting metadata</span>'}
                · ${t.fileCount} file${t.fileCount === 1 ? '' : 's'} · ${formatBytes(t.totalSize)}
              </div>
            </div>
          </div>
        </td>
        <td class="mono dim">${t.kind === 'series' ? '<span class="pill muted">TV</span>' : '<span class="pill muted">Movie</span>'}</td>
        <td class="mono dim">${t.year ?? '—'}</td>
        <td class="mono">${t.bestResolution !== null ? `${t.bestResolution}p` : '—'}</td>
        <td class="mono dim">${formatRelative(Date.now() - t.addedAt)} ago</td>
      </tr>`;
    }).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('server', { size: 11 })} ${esc(detail.email)}</div>
          <h1>${esc(detail.accountId)} ${raw(statePill)}</h1>
          <p class="lede">Per-account overview. Library rows are direct from the local index; quota is live; transfers are cached for 5 s.</p>
        </div>
        <div class="actions">
          <a class="btn" href="/admin/accounts">${icon('arrow-left', { size: 13 })} Fleet</a>
        </div>
      </div>

      ${detail.status.needsReauth
        ? raw(html`
            <div class="notice bad">
              <span>
                <strong>Seedr rejected this account's password.</strong>
                Nothing will download or play until it is corrected. The pool has
                stopped retrying to avoid burning the login endpoint's budget.
              </span>
              <button class="btn danger" x-data x-on:click="$store.modals.reauth = true">
                ${icon('rotate-ccw', { size: 13 })} Update password
              </button>
            </div>
          `)
        : ''}

      ${detail.status.cdnHealthy === false
        ? raw(html`
            <div class="notice warn">
              <span>
                <strong>Torn reel.</strong>
                Seedr's CDN is returning 404 for this account's direct downloads
                (${esc(detail.status.cdnReason ?? 'ff_get 404s')}). Existing files
                still play via the HLS fallback, and the pool is routing new
                content elsewhere. It clears itself once Seedr recovers.
              </span>
            </div>
          `)
        : ''}

      <div class="detail-grid">
        <div class="section">
          <div class="section-head"><h2>${icon('database', { size: 12 })} Library <span class="count">${detail.library.titles} titles · ${formatBytes(detail.library.bytes)}</span></h2></div>
          ${detail.titles.length === 0
            ? raw(html`
                <div class="empty">
                  <h3>No titles on this account yet</h3>
                  <p>Add a magnet from the overview. The indexer catalogs completed downloads in real time.</p>
                </div>
              `)
            : raw(html`
                <div class="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Title</th><th>Type</th><th>Year</th><th>Quality</th><th>Added</th>
                    </tr></thead>
                    <tbody>${raw(titlesRows)}</tbody>
                  </table>
                </div>
              `)}
        </div>

        <div class="section">
          <div class="section-head"><h2>${icon('server', { size: 12 })} Account</h2></div>
          <div class="card">
            <div class="kv-list">
              <div class="kv"><span class="k">Email</span><span class="v">${esc(detail.email)}</span></div>
              <div class="kv"><span class="k">Status</span><span class="v">${raw(statePill)}</span></div>
              <div class="kv"><span class="k">Quota</span><span class="v">${detail.status.quota ? `${formatBytes(detail.status.quota.used)} / ${formatBytes(detail.status.quota.max)}` : '—'}</span></div>
              <div class="kv"><span class="k">Active streams</span><span class="v">${detail.status.activeStreams}</span></div>
              <div class="kv"><span class="k">CDN</span><span class="v">${raw(detail.status.cdnHealthy ? '<span style="color:var(--ok);">OK</span>' : `<span style="color:var(--warn);">${esc(detail.status.cdnReason ?? 'torn')}</span>`)}</span></div>
              ${detail.status.cdnBrokenAt !== undefined ? html`<div class="kv"><span class="k">Quarantine</span><span class="v">${formatRelative(Date.now() - detail.status.cdnBrokenAt)} ago</span></div>` : ''}
              ${detail.ageDays !== null ? html`<div class="kv"><span class="k">Last file</span><span class="v">${detail.ageDays} day${detail.ageDays === 1 ? '' : 's'} ago</span></div>` : ''}
            </div>
          </div>

          <div class="section-head" style="margin-top: 1.25rem;"><h2>${icon('arrow-right-left', { size: 12 })} Actions</h2></div>
          <div class="card action-cluster">
            <div class="row">
              <button class="btn" hx-post="/admin/api/reload" hx-swap="none">${icon('refresh-cw', { size: 13 })} Re-probe fleet</button>
              <button class="btn" hx-post="/admin/api/reindex/${esc(detail.accountId)}" hx-swap="none">${icon('database', { size: 13 })} Reindex this account</button>
            </div>
            <div class="row">
              <button class="btn" hx-post="/admin/api/dump" hx-swap="none">${icon('archive', { size: 13 })} Dump now</button>
              <button class="btn" x-data x-on:click="$store.modals.reauth = true">${icon('rotate-ccw', { size: 13 })} Update password</button>
            </div>
            <div class="row" style="margin-top: 0.5rem; border-top: 1px solid var(--border); padding-top: 0.65rem;">
              <button class="btn danger" x-data x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:confirm', { detail: { verb: 'Purge', body: 'Delete every file on this account from both Seedr and the local library. Cannot be undone.', action: 'purge', accountId: '${esc(detail.accountId)}' } }))">${icon('eraser', { size: 13 })} Purge all files</button>
              <button class="btn danger" x-data x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:confirm', { detail: { verb: 'Remove', body: 'Drop this account from the pool. Library rows for it are kept. You can re-add the credentials later.', action: 'delete', accountId: '${esc(detail.accountId)}' } }))">${icon('x', { size: 13 })} Remove from pool</button>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>${icon('activity', { size: 12 })} History <span class="count">${detail.activity.length} events</span></h2></div>
        ${detail.activity.length === 0
          ? raw(html`
              <div class="empty">
                <h3>No activity recorded for this account</h3>
                <p>Actions on this account will appear here as they happen.</p>
              </div>
            `)
          : raw(html`
              <div class="card" style="padding: 0.85rem 1rem;">
                <ul class="timeline">
                  ${raw(
                    detail.activity
                      .map(
                        (a) =>
                          `<li class="${esc(a.kind)}"><span class="ts">${formatRelative(Date.now() - a.at)} ago</span><span>${esc(a.message)}</span>${a.detail ? ` <span class="detail">— ${esc(a.detail)}</span>` : ''}</li>`,
                      )
                      .join(''),
                  )}
                </ul>
              </div>
            `)}
      </div>

      <!-- Update-password modal. This is the recovery path for an account
           whose credentials went bad; before this, the only fix was editing
           the credentials file on the host by hand. The password is verified
           against Seedr before anything is written, and replaced in place so
           the positional account ids (and the library rows keyed on them)
           are never renumbered. -->
      <div class="modal-backdrop" x-data
           x-bind:class="$store.modals.reauth ? 'open' : ''"
           x-on:keydown.escape.window="$store.modals.reauth = false"
           x-on:click.self="$store.modals.reauth = false">
        <div class="modal" x-on:click.stop x-show="$store.modals.reauth">
          <div class="modal-head">
            <div class="modal-title">${icon('rotate-ccw', { size: 14 })} Update password</div>
            <button class="modal-close" x-on:click="$store.modals.reauth = false">${icon('x', { size: 14 })}</button>
          </div>
          <form hx-post="/admin/api/account/reauth" hx-swap="none"
                hx-on::after-request="if (event.detail.xhr.status === 200) { $store.modals.reauth = false; setTimeout(()=>window.location.reload(), 900); }">
            <input type="hidden" name="accountId" value="${esc(detail.accountId)}" />
            <div class="modal-body">
              <div class="kv-list">
                <div class="kv"><span class="k">Account</span><span class="v">${esc(detail.accountId)}</span></div>
                <div class="kv"><span class="k">Email</span><span class="v">${esc(detail.email)}</span></div>
              </div>
              <label class="field">
                New password
                <input type="password" name="password" required minlength="6" class="field-input" autocomplete="off" />
                <span class="hint">
                  Verified against Seedr before it is saved, so a typo cannot
                  make things worse. The email stays as-is — to change that,
                  remove the account and add it again.
                </span>
              </label>
            </div>
            <div class="modal-foot">
              <button type="button" class="btn" x-on:click="$store.modals.reauth = false">Cancel</button>
              <button type="submit" class="primary">${icon('check', { size: 13 })} Verify &amp; save</button>
            </div>
          </form>
        </div>
      </div>
    `;
    return this.#page(detail.accountId, '/admin/accounts', body);
  }

  // --------------------------------------------------------------------
  // Library
  // --------------------------------------------------------------------

  library(): Response {
    const view = this.#views.libraryView();
    const cdnBroken = new Set(
      this.#getPool().statuses().filter((s) => s.cdnHealthy === false).map((s) => s.accountId),
    );
    const duplicates = this.#library.duplicateGroups();
    const storedMagnets = this.#library.listMagnets();

    const cards = view.cards.map((c) => this.#libraryPosterCard(c, cdnBroken)).join('');
    const rows = view.cards.map((c) => this.#libraryTableRow(c, cdnBroken)).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('film', { size: 11 })} Media Catalog</div>
          <h1>Library <span class="num">· ${view.kpis.total} titles</span></h1>
          <p class="lede">Synchronized across the pool. Click a card to play in Stremio; hover for per-title actions.</p>
        </div>
        <div class="actions">
          <button class="btn" hx-post="/admin/api/reindex" hx-swap="none">${icon('refresh-cw', { size: 13 })} Reindex</button>
          <button class="btn" hx-post="/admin/api/enrich-all" hx-swap="none">${icon('search', { size: 13 })} Re-fetch all metadata</button>
          <button class="btn" type="button"
            x-data
            x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:confirm', { detail: { verb: 'Reset', body: 'Clear IMDb and TMDB ids for every title. The enricher will re-fetch them on the next tick.', action: 'clear-metadata' } }))">${icon('rotate-ccw', { size: 13 })} Reset all metadata</button>
          <a class="btn" href="/admin">${icon('arrow-left', { size: 13 })} Overview</a>
        </div>
      </div>

      <div class="view-toolbar">
        <div class="filter-tabs">
          <button class="filter-tab active" onclick="filterLibraryCategory(this, 'all')">All (${view.kpis.total})</button>
          <button class="filter-tab" onclick="filterLibraryCategory(this, 'movie')">Movies (${view.kpis.movies})</button>
          <button class="filter-tab" onclick="filterLibraryCategory(this, 'series')">Series (${view.kpis.series})</button>
          <button class="filter-tab" onclick="filterLibraryCategory(this, 'res-4k')">4K UHD (${view.kpis.uhd})</button>
          <button class="filter-tab" onclick="filterLibraryCategory(this, 'res-1080p')">1080p (${view.kpis.fhd})</button>
          ${view.kpis.torn > 0 ? html`<button class="filter-tab" onclick="filterLibraryCategory(this, 'torn')">Torn (${view.kpis.torn})</button>` : ''}
        </div>

        <div style="display:flex; align-items:center; gap: 0.65rem; flex-wrap:wrap;">
          <div class="search-bar">
            ${icon('search', { size: 14, className: 'search-icon' })}
            <input type="text" class="search-input" placeholder="Search titles, IMDb…" />
          </div>
          <div class="view-toggle">
            <button class="view-toggle-btn active" id="btnViewGrid" onclick="setLibraryView('grid')" title="Poster grid">${icon('layout-grid', { size: 13 })} Grid</button>
            <button class="view-toggle-btn" id="btnViewTable" onclick="setLibraryView('table')" title="Table">${icon('list', { size: 13 })} Table</button>
          </div>
        </div>
      </div>

      ${view.kpis.total === 0
        ? raw(html`
            <div class="empty">
              <h3>No media indexed yet</h3>
              <p>Add a magnet from the overview. The indexer catalogs completed downloads in real time.</p>
              <a class="btn primary" href="/admin">Ingest a magnet</a>
            </div>
          `)
        : raw(html`
            <div class="poster-grid" id="libraryGrid">${raw(cards)}</div>
            <div class="table-wrap" id="libraryTableWrap" style="display:none; margin-bottom: 1.5rem;">
              <table id="movieTable">
                <thead><tr>
                  <th>Title &amp; Metadata</th><th>Type</th><th>Year</th><th>Quality</th><th>Playback</th>
                  <th>Files</th><th>Size</th><th>Nodes</th><th>Actions</th>
                </tr></thead>
                <tbody>${raw(rows)}</tbody>
              </table>
            </div>
          `)}

      ${duplicates.length > 0
        ? raw(html`
            <div class="section">
              <div class="section-head">
                <h2>${icon('copy', { size: 12 })} Duplicates <span class="count">${duplicates.length} groups</span></h2>
                <span class="muted" style="font-size: 0.78rem;">Byte-identical files across accounts. Use the source account to free space.</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>SHA-1</th><th>Copies</th><th>Distribution</th></tr></thead>
                  <tbody>
                    ${raw(duplicates.map((d) => `<tr>
                      <td class="mono" style="color:var(--warn);">${esc(d.hash.slice(0, 14))}…</td>
                      <td><span class="pill warn">${d.files.length} copies</span></td>
                      <td class="mono">${esc(d.files.map((f) => f.accountId).join(', '))}</td>
                    </tr>`).join(''))}
                  </tbody>
                </table>
              </div>
            </div>
          `)
        : ''}

      ${storedMagnets.length > 0
        ? raw(html`
            <div class="section">
              <div class="section-head"><h2>${icon('magnet', { size: 12 })} Stored Magnets <span class="count">${storedMagnets.length}</span></h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Folder</th><th>Landing</th><th>Added</th><th></th></tr></thead>
                  <tbody>
                    ${raw(storedMagnets.map((m) => `<tr>
                      <td style="font-weight:500;">${esc(m.displayName)}</td>
                      <td class="mono" style="color:var(--accent); font-weight:600;">${esc(m.accountId)}</td>
                      <td class="muted">${formatRelative(Date.now() - m.addedAt)} ago</td>
                      <td>
                        <button class="btn btn-sm" hx-post="/admin/api/readd" hx-vals='{"displayName":"${esc(m.displayName)}"}' hx-swap="none">${icon('refresh-cw', { size: 12 })} Re-add</button>
                      </td>
                    </tr>`).join(''))}
                  </tbody>
                </table>
              </div>
            </div>
          `)
        : ''}
    `;
    return this.#page('Library', '/admin/library', body);
  }

  // --------------------------------------------------------------------
  // Transfers
  // --------------------------------------------------------------------

  async transfers(): Promise<Response> {
    await this.#getPool().refresh();
    const transfers = await this.#getPool().listAllTransfers({ force: true });
    const active = transfers.filter((t) => t.state !== 'finished' && t.state !== 'failed').length;

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('arrow-down-up', { size: 11 })} Transfers</div>
          <h1>${active} <span class="accent">in flight</span> <span class="num">· ${transfers.length} total</span></h1>
          <p class="lede">
            Per-account view of every magnet currently in flight. This table
            refreshes itself every 4 s, so a download's progress moves without
            you touching anything. "No seeders" means the swarm is dead — remove
            it to free the slot.
          </p>
        </div>
        <div class="actions">
          <a class="btn" href="/admin">${icon('arrow-left', { size: 13 })} Overview</a>
        </div>
      </div>

      <div class="section">
        <div class="view-toolbar">
          <div class="search-bar">
            ${icon('search', { size: 14, className: 'search-icon' })}
            <input type="text" class="search-input" placeholder="Search…" />
          </div>
          <span class="pill ok live"><span class="dot"></span>Live</span>
        </div>

        <!-- Polled fragment. hx-trigger fires on a timer and on the
             seedrpool:refresh event that client.js dispatches after an
             action, so the table catches up immediately rather than
             waiting out the interval. The pool caches the fanout for 5 s,
             so the poll is nearly free. -->
        <div id="transfersLive"
             data-live
             hx-get="/admin/transfers/table"
             hx-trigger="every 4s, seedrpool:refresh"
             hx-swap="innerHTML">
          ${raw(this.#transfersTable(transfers))}
        </div>
      </div>
    `;
    return this.#page('Transfers', '/admin/transfers', body);
  }

  /**
   * The transfers table on its own, for the polled fragment.
   *
   * Returns just the table markup so htmx can swap it into the live region
   * without re-rendering the page shell.
   */
  async transfersTable(): Promise<Response> {
    // Not forced: the 5 s pool cache is what makes polling cheap. A forced
    // refresh here would defeat that and hit Seedr once per poll per tab.
    const transfers = await this.#getPool().listAllTransfers();
    return htmlResponse(this.#transfersTable(transfers));
  }

  #transfersTable(transfers: Array<Transfer & { accountId: string }>): string {
    if (transfers.length === 0) {
      return `
        <div class="empty">
          <h3>No transfers</h3>
          <p>Add a magnet from the overview to start one. This view will pick it up within a few seconds.</p>
          <a class="btn primary" href="/admin">Back to overview</a>
        </div>`;
    }

    const rows = transfers.map((t) => {
      const dead = isDeadTransfer(t, 999);
      const pill = t.state === 'finished'
        ? '<span class="pill ok"><span class="dot"></span>Finished</span>'
        : dead
          ? '<span class="pill bad"><span class="dot"></span>No seeders</span>'
          : t.state === 'failed'
            ? '<span class="pill bad"><span class="dot"></span>Failed</span>'
            : `<span class="pill warn"><span class="dot"></span>${esc(t.state)}</span>`;
      return `<tr data-transfer-row="${esc(t.accountId)}/${esc(t.id)}">
        <td class="mono"><a href="/admin/accounts/${esc(t.accountId)}">${esc(t.accountId)}</a></td>
        <td>${esc(t.name ?? '(resolving…)')}</td>
        <td>${pill}</td>
        <td>
          <div class="bar-inline">
            <div class="bar${dead ? ' warn' : ''}"><div class="fill" style="--fill: ${(t.progress / 100).toFixed(4)}"></div></div>
            <span class="pct">${t.progress}%</span>
          </div>
        </td>
        <td class="mono">${formatBytes(t.size)}</td>
        <td class="mono" style="color: ${t.seeders > 0 ? 'var(--ok)' : 'var(--text-dim)'};">${t.seeders}</td>
        <td>
          <button class="btn btn-sm danger"
                  hx-post="/admin/api/transfer/delete"
                  hx-vals='{"accountId":"${esc(t.accountId)}","transferId":"${esc(t.id)}"}'
                  hx-swap="none">${iconMarkup('trash-2', { size: 12 })}</button>
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Account</th><th>Torrent</th><th>State</th><th>Progress</th>
            <th>Size</th><th>Peers</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // --------------------------------------------------------------------
  // Fleet (accounts)
  // --------------------------------------------------------------------

  async accounts(): Promise<Response> {
    const cards = await this.#views.accountCards();
    const issues = this.#credentials.problems;

    const rows = cards.map((c) => {
      const quota = c.status.quota;
      const fillPct = quota && quota.max > 0 ? (quota.used / quota.max) * 100 : 0;
      const statePill = c.status.needsReauth
        ? '<span class="pill bad"><span class="dot"></span>Bad password</span>'
        : c.status.cdnHealthy === false
          ? '<span class="pill warn"><span class="dot"></span>Torn reel</span>'
          : c.status.healthy
            ? '<span class="pill ok live"><span class="dot"></span>Healthy</span>'
            : '<span class="pill off"><span class="dot"></span>Offline</span>';
      return `<tr data-account-row="${esc(c.accountId)}">
        <td><a class="mono" style="font-weight:600; color:var(--text);" href="/admin/accounts/${esc(c.accountId)}">${esc(c.accountId)}</a></td>
        <td class="muted">${esc(c.email)}</td>
        <td>${statePill}</td>
        <td>
          <div class="bar-inline">
            <div class="bar${c.status.cdnHealthy === false ? ' warn' : ''}"><div class="fill" style="--fill: ${(fillPct / 100).toFixed(4)}"></div></div>
            <span class="pct">${fillPct.toFixed(0)}%</span>
          </div>
        </td>
        <td class="mono">${quota ? `${formatBytes(quota.used)} / ${formatBytes(quota.max)}` : '—'}</td>
        <td class="mono dim">${c.status.activeStreams}</td>
        <td>
          <div class="row-actions">
            <a class="btn btn-sm" href="/admin/accounts/${esc(c.accountId)}">${icon('arrow-right-left', { size: 12 })} Open</a>
            <button class="btn btn-sm danger" x-data x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:confirm', { detail: { verb: 'Purge', body: 'Delete every file on this account from both Seedr and the local library. Cannot be undone.', action: 'purge', accountId: '${esc(c.accountId)}' } }))">${icon('eraser', { size: 12 })} Purge</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('server', { size: 11 })} Fleet</div>
          <h1>${cards.length} accounts</h1>
          <p class="lede">Click any account id to open its detail page. Use the buttons in the table to purge or re-probe; the per-account page also exposes a remove button and full history.</p>
        </div>
        <div class="actions">
          <button class="btn primary" x-data x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:open-modal', { detail: { id: 'addAccountModal' } }))">${icon('plus', { size: 13 })} Add account</button>
          <button class="btn" hx-post="/admin/api/reload" hx-swap="none">${icon('rotate-ccw', { size: 13 })} Re-probe all</button>
          <button class="btn" hx-post="/admin/api/dump" hx-swap="none">${icon('database', { size: 13 })} Dump now</button>
          <a class="btn" href="/admin/dumps">${icon('archive', { size: 13 })} Dumps</a>
        </div>
      </div>

      <div class="section">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>ID</th><th>Email</th><th>State</th><th>Used</th><th>Quota</th><th>Streams</th><th></th>
            </tr></thead>
            <tbody>${raw(rows)}</tbody>
          </table>
        </div>
      </div>

      ${issues.length > 0
        ? raw(html`
            <div class="section">
              <div class="section-head"><h2>${icon('alert-triangle', { size: 12 })} Credential diagnostics <span class="count">${issues.length} issue${issues.length === 1 ? '' : 's'}</span></h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Line</th><th>Detail</th></tr></thead>
                  <tbody>
                    ${raw(issues.map((p) => `<tr><td class="mono" style="color:var(--bad); font-weight:700;">#${p.line}</td><td>${esc(p.reason)}</td></tr>`).join(''))}
                  </tbody>
                </table>
              </div>
            </div>
          `)
        : ''}

      <div class="section">
        <div class="section-head"><h2>${icon('database', { size: 12 })} Source</h2></div>
        <div class="card">
          <p class="muted" style="font-size:0.85rem; line-height: 1.5;">
            Accounts load from your configured credentials file — one <code>email:password</code> per line.
            Line 1 → <code>acc1</code>, line 2 → <code>acc2</code>. <strong>Append</strong> at the bottom; never renumber.
            The Add account modal writes a new line; the Reload button re-reads the file.
          </p>
        </div>
      </div>

      <!-- Add account modal — Alpine controlled. -->
      <div class="modal-backdrop" id="addAccountModal" x-data
           x-bind:class="$store.modals.add ? 'open' : ''"
           x-on:keydown.escape.window="$store.modals.add = false"
           x-on:click.self="$store.modals.add = false">
        <div class="modal" x-on:click.stop x-show="$store.modals.add">
          <div class="modal-head">
            <div class="modal-title">${icon('plus', { size: 14 })} Add Seedr account</div>
            <button class="modal-close" x-on:click="$store.modals.add = false">${icon('x', { size: 14 })}</button>
          </div>
          <form hx-post="/admin/api/account/add" hx-swap="none" hx-on::after-request="if (event.detail.xhr.status === 200) { try { const r = JSON.parse(event.detail.xhr.responseText); if (r.ok) { setTimeout(()=>window.location='/admin/accounts/'+r.data.accountId, 800); } } catch(_){} }">
            <div class="modal-body">
              <label class="field">
                Email
                <input type="email" name="email" required placeholder="you@example.com" class="field-input" />
              </label>
              <label class="field">
                Password
                <input type="password" name="password" required minlength="6" class="field-input" />
                <span class="hint">Tested against Seedr before saving. Bad credentials are rejected and never written.</span>
              </label>
            </div>
            <div class="modal-foot">
              <button type="button" class="btn" x-on:click="$store.modals.add = false">Cancel</button>
              <button type="submit" class="primary">${icon('plus', { size: 13 })} Add</button>
            </div>
          </form>
        </div>
      </div>
    `;
    return this.#page('Fleet', '/admin/accounts', body);
  }

  // --------------------------------------------------------------------
  // Activity log
  // --------------------------------------------------------------------

  activity(ctx: RouteContext): Response {
    const url = new URL(ctx.request.url);
    const account = url.searchParams.get('account') ?? '';
    const kind = url.searchParams.get('kind') ?? '';
    const since = Number(url.searchParams.get('since') ?? 0);
    const until = Number(url.searchParams.get('until') ?? 0);
    const events = this.#library.recentActivity(1000);

    const filtered = events.filter((e) => {
      if (kind && e.kind !== kind) return false;
      if (since > 0 && e.at < since) return false;
      if (until > 0 && e.at > until) return false;
      if (account) {
        const hay = `${e.message} ${e.detail ?? ''}`.toLowerCase();
        if (!hay.includes(account.toLowerCase())) return false;
      }
      return true;
    });

    const accountChip = (label: string, value: string, isActive: boolean) =>
      `<button class="chip${isActive ? ' active' : ''}" onclick="setParam('account', '${esc(value)}')">${esc(label)}${isActive ? '<span class="x">×</span>' : ''}</button>`;
    const kindChip = (k: string, label: string) =>
      `<button class="chip${kind === k ? ' active' : ''}" onclick="setParam('kind', '${kind === k ? '' : esc(k)}')">${esc(label)}</button>`;

    const accountList = [...new Set(events.map((e) => extractAccountFromDetail(e.message, e.detail) ?? '').filter(Boolean))];
    const kinds: Array<'info' | 'success' | 'warn' | 'bad'> = ['info', 'success', 'warn', 'bad'];

    const rows = filtered.map((e) => {
      const acc = extractAccountFromDetail(e.message, e.detail) ?? '—';
      return `<tr>
        <td class="ts mono">${formatRelative(Date.now() - e.at)} ago</td>
        <td class="ts mono dim">${new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td><span class="pill ${esc(e.kind)}"><span class="dot"></span>${esc(e.kind)}</span></td>
        <td class="mono">${acc.startsWith('acc') ? `<a href="/admin/accounts/${esc(acc)}">${esc(acc)}</a>` : esc(acc)}</td>
        <td>${esc(e.message)}</td>
        <td class="muted">${e.detail ? esc(e.detail) : ''}</td>
      </tr>`;
    }).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('activity', { size: 11 })} Transaction history</div>
          <h1>Activity <span class="num">· ${filtered.length} of ${events.length}</span></h1>
          <p class="lede">Every event the operator should know about. Filter by account, kind, or time.</p>
        </div>
        <div class="actions">
          <a class="btn" href="/admin">${icon('arrow-left', { size: 13 })} Back</a>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Filters</h2></div>
        <div class="card" style="display:flex; flex-direction:column; gap: 0.85rem;">
          <div>
            <div class="muted mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 0.35rem;">Account</div>
            <div class="chip-group">
              <button class="chip${account === '' ? ' active' : ''}" onclick="setParam('account', '')">all</button>
              ${raw(accountList.map((a) => accountChip(a, a, account === a)).join(''))}
            </div>
          </div>
          <div>
            <div class="muted mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 0.35rem;">Kind</div>
            <div class="chip-group">
              ${raw(kinds.map((k) => kindChip(k, k)).join(''))}
            </div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 0.65rem;">
            <label class="field">
              Since
              <input type="datetime-local" value="${since ? new Date(since).toISOString().slice(0, 16) : ''}" onchange="setParam('since', this.value ? new Date(this.value).getTime() : '')" class="field-input" />
            </label>
            <label class="field">
              Until
              <input type="datetime-local" value="${until ? new Date(until).toISOString().slice(0, 16) : ''}" onchange="setParam('until', this.value ? new Date(this.value).getTime() : '')" class="field-input" />
            </label>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>Events</h2>
          <span class="muted mono" style="font-size: 0.7rem;">${filtered.length} matching</span>
        </div>
        ${filtered.length === 0
          ? raw(html`
              <div class="empty">
                <h3>No events match these filters</h3>
                <p>Try a wider date range or remove the account filter.</p>
              </div>
            `)
          : raw(html`
              <div class="table-wrap">
                <table>
                  <thead><tr>
                    <th>When</th><th>Timestamp</th><th>Kind</th><th>Account</th>
                    <th>Message</th><th>Detail</th>
                  </tr></thead>
                  <tbody>${raw(rows)}</tbody>
                </table>
              </div>
            `)}
      </div>

      <script>
        function setParam(k, v) {
          var url = new URL(window.location.href);
          if (v === '' || v === null || v === undefined) url.searchParams.delete(k);
          else url.searchParams.set(k, String(v));
          window.location = url.pathname + (url.search ? url.search : '');
        }
      </script>
    `;
    return this.#page('Activity', '/admin/activity', body);
  }

  // --------------------------------------------------------------------
  // Dumps inventory
  // --------------------------------------------------------------------

  // --------------------------------------------------------------------
  // Health — the same checks /healthz grades, rendered for a human.
  // --------------------------------------------------------------------

  healthPage(): Response {
    const report = this.#healthReport();

    const badge = (status: 'ok' | 'warn' | 'bad') =>
      status === 'ok'
        ? '<span class="pill ok live"><span class="dot"></span>OK</span>'
        : status === 'warn'
          ? '<span class="pill warn"><span class="dot"></span>Warn</span>'
          : '<span class="pill bad"><span class="dot"></span>Bad</span>';

    const rows = report.checks
      .map((c) => `<tr>
        <td class="mono">${esc(c.name)}</td>
        <td>${badge(c.status)}</td>
        <td class="muted">${c.detail === null ? '—' : esc(c.detail)}</td>
      </tr>`)
      .join('');

    const overall = report.status === 'ok'
      ? 'All subsystems healthy.'
      : report.status === 'warn'
        ? 'Serving, but something needs attention.'
        : 'One or more subsystems are down.';

    return this.#page('Health', '/admin/health', html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('heart-pulse', { size: 11 })} Health</div>
          <h1>${badge(report.status)} ${overall}</h1>
          <div class="sub">The same checks <code>/healthz</code> grades — one definition of healthy, two consumers.</div>
        </div>
      </div>
      <div class="section">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Subsystem</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>${raw(rows)}</tbody>
          </table>
        </div>
      </div>
    `);
  }

  async dumps(): Promise<Response> {
    const { readdir, stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(this.#config.dumpsDir, { withFileTypes: true });
    } catch {
      return this.#page('Dumps', '/admin/dumps', html`
        <div class="empty"><h3>Dumps directory not found</h3><p>Ensure the dump path is configured and writable.</p></div>
      `);
    }
    const latestByAccount = new Map<string, { name: string; size: number; mtime: number }>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = /^([^.]+)\.(\d+)\.json$/.exec(e.name);
      if (!m || !m[1] || !m[2]) continue;
      const s = await stat(join(this.#config.dumpsDir, e.name)).catch(() => null);
      if (!s) continue;
      const existing = latestByAccount.get(m[1]);
      if (!existing || Number(m[2]) > existing.mtime) {
        latestByAccount.set(m[1], { name: e.name, size: s.size, mtime: Number(m[2]) });
      }
    }
    const rows = [...latestByAccount.entries()].sort(([a], [b]) => a.localeCompare(b));
    const tableRows = rows.length === 0
      ? '<tr><td colspan="4" class="muted">No dumps yet.</td></tr>'
      : rows.map(([accountId, info]) =>
          `<tr>
            <td class="mono"><a href="/admin/accounts/${esc(accountId)}">${esc(accountId)}</a></td>
            <td class="mono">${esc(info.name)}</td>
            <td class="mono dim">${(info.size / 1024).toFixed(1)} KiB</td>
            <td class="muted">${new Date(info.mtime).toISOString().replace('T', ' ').slice(0, 19)}</td>
          </tr>`,
        ).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${icon('database', { size: 11 })} Account Dumps</div>
          <h1>Latest dump per account <span class="num">· ${rows.length} file${rows.length === 1 ? '' : 's'}</span></h1>
          <p class="lede">One file per account per run. Access tokens are masked. Read with <code>cat data/dumps/acc1.*.json | jq</code>.</p>
        </div>
        <div class="actions">
          <button class="btn primary" hx-post="/admin/api/dump" hx-swap="none">${icon('play', { size: 13 })} Dump now</button>
        </div>
      </div>
      <div class="section">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Account</th><th>File</th><th>Size</th><th>Captured</th></tr></thead>
            <tbody>${raw(tableRows)}</tbody>
          </table>
        </div>
      </div>
    `;
    return this.#page('Dumps', '/admin/dumps', body);
  }

  async transferCount(): Promise<Response> {
    try {
      const transfers = await this.#getPool().listAllTransfers();
      const count = transfers.filter((t) => t.state !== 'finished' && t.state !== 'failed').length;
      return new Response(JSON.stringify({ count }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    } catch {
      return new Response(JSON.stringify({ count: 0 }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  }

  // --------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------

  #accountCard(c: AccountCard): string {
    const quota = c.status.quota;
    const fillPct = quota && quota.max > 0 ? (quota.used / quota.max) * 100 : 0;
    const cls = c.status.cdnHealthy === false ? 'warn'
      : c.status.healthy ? 'ok'
      : c.status.needsReauth ? 'bad' : 'bad';
    const state = c.status.cdnHealthy === false ? 'Torn reel'
      : c.status.healthy ? (c.status.activeStreams > 0 ? `${c.status.activeStreams} streaming` : 'Ready')
      : c.status.needsReauth ? 'Bad password' : 'Offline';
    const transfersTxt = c.transfers.length > 0
      ? `<span><strong>${c.transfers.length}</strong> transfer${c.transfers.length === 1 ? '' : 's'}</span>`
      : '';
    return `
      <a class="account-card ${cls}" href="/admin/accounts/${esc(c.accountId)}">
        <div class="head">
          <div>
            <div class="id">${esc(c.accountId)}</div>
            <div class="email">${esc(c.email)}</div>
          </div>
          <div class="state"><span class="dot"></span> ${esc(state)}</div>
        </div>
        <div class="meter"><div class="fill" style="--fill: ${(fillPct / 100).toFixed(4)}"></div></div>
        <div class="stats">
          <span><strong>${quota ? formatBytes(quota.used) : '—'}</strong> / ${quota ? formatBytes(quota.max) : '—'}</span>
          <span class="sep">·</span>
          <span><strong>${c.library.titles}</strong> title${c.library.titles === 1 ? '' : 's'}</span>
          ${c.library.titles > 0 ? raw(`<span class="sep">·</span>${transfersTxt}`) : ''}
        </div>
      </a>`;
  }

  #libraryPosterCard(c: LibraryCard, cdnBroken: Set<string>): string {
    const t = c.title;
    const files = c.files;
    const accounts = c.accounts;
    const isTorn = c.torn === 'some';
    const allTorn = c.torn === 'all';
    const primaryFile = files[0];
    const movable = files.some((f) => f.magnet !== null);

    let resBadge: string;
    if (c.isUhd) resBadge = '<span class="pill purple">4K UHD</span>';
    else if (c.isFhd) resBadge = '<span class="pill ok">1080p</span>';
    else if (t.bestResolution !== null && t.bestResolution >= 720) resBadge = '<span class="pill warn">720p</span>';
    else resBadge = '<span class="pill muted">SD</span>';

    const playState = allTorn
      ? '<span class="pill warn"><span class="dot"></span>HLS</span>'
      : isTorn
        ? '<span class="pill warn"><span class="dot"></span>Mixed</span>'
        : '<span class="pill ok"><span class="dot"></span>Direct</span>';

    const posterUrl = t.imdbId
      ? `https://images.metahub.space/poster/medium/${esc(t.imdbId)}/img.jpg`
      : null;

    const categories = [t.kind, c.resClass, isTorn || allTorn ? 'torn' : 'healthy'].join(' ');

    const stremioLink = t.imdbId
      ? `<a class="btn btn-sm primary" href="stremio:///detail/${t.kind === 'series' ? 'series' : 'movie'}/${esc(t.imdbId)}" target="_blank" rel="noreferrer">${icon('play', { size: 12 })} Play</a>`
      : '';

    const moveAction = movable && primaryFile
      ? `<button class="btn btn-sm" hx-post="/admin/api/move" hx-vals='{"accountId":"${esc(primaryFile.accountId)}","fileId":"${esc(primaryFile.fileId)}"}' hx-swap="none">${icon('arrow-right-left', { size: 12 })} Move</button>`
      : '';

    const streamUrl = `${this.#config.publicUrl}/${this.#config.addonSecret}/play/${primaryFile?.accountId ?? ''}/${primaryFile?.fileId ?? ''}`;
    const copyLink = primaryFile
      ? `<button class="btn btn-sm" type="button" onclick="copyText(this, '${esc(streamUrl)}')">${icon('link', { size: 12 })} Copy</button>`
      : '';

    const download = primaryFile
      ? `<a class="btn btn-sm" href="/${esc(this.#config.addonSecret)}/play/${esc(primaryFile.accountId)}/${esc(primaryFile.fileId)}?download=1" target="_blank" rel="noreferrer">${icon('arrow-down-circle', { size: 12 })} Download</a>`
      : '';

    const deleteAction = primaryFile
      ? `<button class="btn btn-sm danger" x-data x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:confirm', { detail: { verb: 'Delete', body: 'Delete this file from Seedr and from the library.', action: 'file-delete', accountId: '${esc(primaryFile.accountId)}', fileId: '${esc(primaryFile.fileId)}' } }))">${icon('trash-2', { size: 12 })}</button>`
      : '';

    return `
      <div class="poster-card ${allTorn ? 'torn' : ''} ${categories}" data-category="${categories}"${primaryFile ? ` data-file-row="${esc(primaryFile.accountId)}/${esc(primaryFile.fileId)}"` : ''}>
        <div class="poster-cover">
          <div class="poster-fallback">${icon(t.kind === 'series' ? 'tv' : 'film', { size: 32 })}<span>${esc(t.name.slice(0, 2).toUpperCase())}</span></div>
          ${posterUrl ? `<img src="${posterUrl}" alt="${esc(t.name)}" loading="lazy" onerror="this.remove();" />` : ''}
          <div class="poster-badges">
            ${raw(resBadge)}
            ${raw(playState)}
          </div>
          <div class="poster-overlay-actions">
            ${raw(stremioLink)}
            <div class="row">
              ${raw(moveAction)}${raw(copyLink)}${raw(download)}${raw(deleteAction)}
            </div>
          </div>
        </div>
        <div class="poster-info">
          <div class="poster-title" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="poster-meta">
            <span>${t.year ?? '—'} · ${t.fileCount} file${t.fileCount === 1 ? '' : 's'}</span>
            <span class="poster-node-tag">${esc(accounts.join(', '))}</span>
          </div>
        </div>
      </div>`;
  }

  #libraryTableRow(c: LibraryCard, cdnBroken: Set<string>): string {
    const t = c.title;
    const files = c.files;
    const accounts = c.accounts;
    const isTorn = c.torn === 'some';
    const allTorn = c.torn === 'all';
    const primaryFile = files[0];
    const movable = files.some((f) => f.magnet !== null);

    let resBadge: string;
    if (c.isUhd) resBadge = '<span class="pill purple">4K</span>';
    else if (c.isFhd) resBadge = '<span class="pill ok">1080p</span>';
    else if (t.bestResolution !== null && t.bestResolution >= 720) resBadge = '<span class="pill warn">720p</span>';
    else resBadge = '<span class="pill muted">SD</span>';

    const playState = allTorn
      ? '<span class="pill warn"><span class="dot"></span>HLS</span>'
      : isTorn
        ? '<span class="pill warn"><span class="dot"></span>Mixed</span>'
        : files.length > 0
          ? '<span class="pill ok"><span class="dot"></span>Direct</span>'
          : '<span class="dim mono">—</span>';

    const accountsLabel = accounts.length === 0
      ? '—'
      : accounts.length <= 2
        ? esc(accounts.join(', '))
        : `${esc(accounts.slice(0, 2).join(', '))} <span class="muted">+${accounts.length - 2}</span>`;

    const moveAction = movable && primaryFile
      ? `<button class="btn btn-sm" hx-post="/admin/api/move" hx-vals='{"accountId":"${esc(primaryFile.accountId)}","fileId":"${esc(primaryFile.fileId)}"}' hx-swap="none">${icon('arrow-right-left', { size: 12 })} Move</button>`
      : '';
    const streamUrl = `${this.#config.publicUrl}/${this.#config.addonSecret}/play/${primaryFile?.accountId ?? ''}/${primaryFile?.fileId ?? ''}`;
    const copyLink = primaryFile
      ? `<button class="btn btn-sm" type="button" onclick="copyText(this, '${esc(streamUrl)}')">${icon('link', { size: 12 })} Copy</button>`
      : '';
    const stremioLink = t.imdbId
      ? `<a class="btn btn-sm primary" href="stremio:///detail/${t.kind === 'series' ? 'series' : 'movie'}/${esc(t.imdbId)}" target="_blank" rel="noreferrer">${icon('play', { size: 12 })} Stremio</a>`
      : '';
    const download = primaryFile
      ? `<a class="btn btn-sm" href="/${esc(this.#config.addonSecret)}/play/${esc(primaryFile.accountId)}/${esc(primaryFile.fileId)}?download=1" target="_blank" rel="noreferrer">${icon('arrow-down-circle', { size: 12 })}</a>`
      : '';
    const deleteAction = primaryFile
      ? `<button class="btn btn-sm danger" x-data x-on:click="window.dispatchEvent(new CustomEvent('seedrpool:confirm', { detail: { verb: 'Delete', body: 'Delete this file from Seedr and from the library.', action: 'file-delete', accountId: '${esc(primaryFile.accountId)}', fileId: '${esc(primaryFile.fileId)}' } }))">${icon('trash-2', { size: 12 })}</button>`
      : '';

    const actions = `${stremioLink}${moveAction}${copyLink}${download}${deleteAction}`;
    const trClass = allTorn ? 'torn' : isTorn ? 'mixed' : '';
    const categories = [t.kind, c.resClass, isTorn || allTorn ? 'torn' : 'healthy'].join(' ');

    const initial = (t.name[0] ?? '?').toUpperCase();
    const poster = t.imdbId
      ? `https://images.metahub.space/poster/small/${esc(t.imdbId)}/img.jpg`
      : null;
    const refreshMeta = `<button class="btn btn-sm ghost" hx-post="/admin/api/metadata/${esc(t.key)}" hx-swap="none" title="Re-fetch this title's IMDb/TMDB match">${icon('rotate-ccw', { size: 12 })}</button>`;

    return `<tr class="${trClass} ${categories}" data-category="${categories}"${primaryFile ? ` data-file-row="${esc(primaryFile.accountId)}/${esc(primaryFile.fileId)}"` : ''}>
      <td>
        <div class="movie-cell">
          <div class="poster-thumb"><span class="poster-thumb-fallback">${initial}</span>${poster ? `<img src="${poster}" alt="" onerror="this.remove();">` : ''}</div>
          <div class="meta">
            <div class="title">${esc(t.name)}</div>
            <div class="sub">
              ${t.imdbId !== null
                ? `<a href="https://www.imdb.com/title/${esc(t.imdbId)}/" target="_blank" rel="noreferrer">${esc(t.imdbId)}</a>`
                : '<span class="dim">awaiting metadata</span>'}
              ${t.imdbId === null ? raw(refreshMeta) : ''}
            </div>
          </div>
        </div>
      </td>
      <td class="mono dim">${t.kind === 'series' ? '<span class="pill muted">Series</span>' : '<span class="pill muted">Movie</span>'}</td>
      <td class="mono dim">${t.year ?? '—'}</td>
      <td>${resBadge}</td>
      <td>${playState}</td>
      <td class="mono">${t.fileCount}</td>
      <td class="mono">${formatBytes(t.totalSize)}</td>
      <td class="mono dim">${accountsLabel}</td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>`;
  }

  /**
   * Server-side storage donut. Zero JS, sync with the data the moment
   * the page renders, no Chart.js 205KB cost. Reading: a ring whose
   * arc lengths are proportional to each account's bytes, with a center
   * label that states the totals.
   */
  #storageDonut(breakdown: Array<{ label: string; valueGib: number }>): string {
    const total = breakdown.reduce((a, b) => a + b.valueGib, 0);
    if (total === 0) {
      return `<div class="muted" style="padding: 2.5rem 0; text-align: center;">No data yet.</div>`;
    }
    const palette = ['#6ea8fe', '#818cf8', '#a78bfa', '#c084fc', '#f472b6', '#fb7185', '#34d399', '#4ade80', '#67e8f9', '#facc15'];
    const freeEntry = breakdown[breakdown.length - 1];
    const accounts = breakdown.slice(0, -1);
    const freeColor = 'rgba(255,255,255,0.08)';

    let acc = 0;
    const stops: string[] = [];
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]!;
      const angle = (a.valueGib / total) * 360;
      const start = acc;
      const end = acc + angle;
      acc = end;
      const color = palette[i % palette.length] ?? '#6ea8fe';
      if (angle > 0.01) {
        stops.push(`${color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`);
      }
    }
    if (acc < 359.99) {
      stops.push(`${freeColor} ${acc.toFixed(2)}deg 360deg`);
    }
    const conic = stops.length > 0 ? stops.join(', ') : `${freeColor} 0deg 360deg`;

    return `
      <div class="donut">
        <div class="donut-ring" style="--donut-gradient: conic-gradient(${conic});">
          <div class="donut-center">
            <div class="donut-value">${total.toFixed(1)} <span class="muted">GiB</span></div>
            <div class="donut-label">across ${accounts.length} nodes</div>
          </div>
        </div>
        <div class="donut-legend">
          ${accounts.map((a, i) => `<div class="donut-row"><span class="dot" style="background:${palette[i % palette.length] ?? '#6ea8fe'}"></span>${esc(a.label)} <span class="muted">${a.valueGib.toFixed(2)} GiB</span></div>`).join('')}
          <div class="donut-row"><span class="dot" style="background:${freeColor}"></span>Free <span class="muted">${(freeEntry?.valueGib ?? 0).toFixed(2)} GiB</span></div>
        </div>
      </div>`;
  }

  #qualityBars(q: { uhd: number; fhd: number; hd: number; sd: number }): string {
    const max = Math.max(q.uhd, q.fhd, q.hd, q.sd, 1);
    const rows: Array<{ label: string; n: number; color: string }> = [
      { label: '4K UHD', n: q.uhd, color: '#c084fc' },
      { label: '1080p', n: q.fhd, color: '#4ade80' },
      { label: '720p', n: q.hd, color: '#f5b942' },
      { label: 'SD / Other', n: q.sd, color: '#5a6273' },
    ];
    return `<div class="bars">
      ${rows.map((r) => `
        <div class="bar-row">
          <div class="bar-label">${r.label}</div>
          <div class="bar-track"><div class="bar-fill" style="width: ${(r.n / max) * 100}%; background: ${r.color};"></div></div>
          <div class="bar-num">${r.n}</div>
        </div>
      `).join('')}
    </div>`;
  }
}

// ---------- Helpers ----------

function extractAccountFromDetail(message: string, detail: string | null): string | null {
  const text = `${message} ${detail ?? ''}`;
  const m = /\b(acc\d+|acc\w+)\b/i.exec(text);
  return m ? (m[1] ?? null) : null;
}

function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function isDeadTransfer(t: Transfer & { accountId: string }, ageSeconds: number): boolean {
  return t.state === 'running' && t.progress === 0 && t.seeders === 0 && ageSeconds > 120;
}

/**
 * Re-exported for the existing test import path. The implementation lives in
 * `magnet-name.ts` so the mutation layer can use it without importing this
 * rendering module.
 */
export { magnetDisplayName };

export function buildPoolEntries(credentials: CredentialFile) {
  return credentials.accounts.map((credential) => ({
    provider: new SeedrV1Provider(credential),
    label: credential.email,
    needsReauth: false,
  }));
}
