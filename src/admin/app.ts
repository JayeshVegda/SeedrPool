/**
 * Admin interface.
 *
 * Server-rendered HTML with plain form posts. No SPA build step, no client
 * framework, minimal memory. Sits behind basic auth.
 *
 * Pages:
 *   /admin             - signal bar + KPIs + activity timeline + ingest
 *   /admin/library     - movie table with poster, copy-link, move, delete
 *   /admin/transfers   - per-account transfer list with remove
 *   /admin/accounts    - fleet per-account health + add/delete/purge UI
 *   /admin/activity    - full transaction history with filters
 */

import type { AccountPool, AccountStatus } from '../core/account-pool.ts';
import type { Transfer } from '../core/types.ts';
import { NoCapacityError, isDeadTransfer } from '../core/account-pool.ts';
import type { Config } from '../core/config.ts';
import type { AccountCredential, CredentialFile } from '../core/credentials.ts';
import { writeCredentials } from '../core/credentials.ts';
import { esc, formatBytes, html, layout, raw } from './html.ts';
import { htmlResponse, redirect, type RouteContext } from '../core/router.ts';
import { SeedrV1Provider } from '../providers/seedr-v1.ts';
import type { Indexer } from '../library/indexer.ts';
import type { MetadataEnricher } from '../library/metadata-enricher.ts';
import type { LibraryFile, LibraryStore, TitleSummary } from '../library/store.ts';
import { posterUrl, backdropUrl, type TmdbMatch } from '../library/tmdb.ts';
// (no extra imports needed)

const RECENT_ACTIVITY = 24;

export class AdminApp {
  #getPool: () => AccountPool;
  #config: Config;
  #credentials: CredentialFile;
  #onAccountsChanged: () => Promise<void>;
  #library: LibraryStore;
  #indexer: Indexer;
  #enricher: MetadataEnricher;

  constructor(
    getPool: () => AccountPool,
    config: Config,
    credentials: CredentialFile,
    onAccountsChanged: () => Promise<void>,
    library: LibraryStore,
    indexer: Indexer,
    enricher: MetadataEnricher,
  ) {
    this.#getPool = getPool;
    this.#config = config;
    this.#credentials = credentials;
    this.#onAccountsChanged = onAccountsChanged;
    this.#library = library;
    this.#indexer = indexer;
    this.#enricher = enricher;
  }

  get #pool(): AccountPool {
    return this.#getPool();
  }

  setCredentials(credentials: CredentialFile): void {
    this.#credentials = credentials;
  }

  // ---------- Overview ----------

  async overview(): Promise<Response> {
    const statuses = await this.#pool.refresh();
    const capacity = this.#pool.capacity();
    const stats = this.#library.stats();
    const activity = this.#library.recentActivity(RECENT_ACTIVITY);
    const manifestUrl = `${this.#config.publicUrl}/${this.#config.addonSecret}/manifest.json`;
    const stremioDeepLink = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;

    let activeTransfers = 0;
    let transferList: Array<Transfer & { accountId: string }> = [];
    try {
      const tl = await this.#pool.listAllTransfers() as Array<Transfer & { accountId: string }>;
      transferList = tl;
      activeTransfers = transferList.filter(
        (t) => t.state !== 'finished' && t.state !== 'failed',
      ).length;
    } catch { /* best-effort */ }

    const cdnBrokenCount = statuses.filter((s) => s.cdnHealthy === false).length;
    const offlineCount = statuses.filter((s) => !s.healthy).length;

    const signalCells = statuses
      .map((s) => {
        const fillPct = s.quota && s.quota.max > 0 ? (s.quota.used / s.quota.max) * 100 : 0;
        const cls =
          s.cdnHealthy === false ? 'warn'
          : s.healthy ? 'ok'
          : 'bad';
        const stateLabel = s.cdnHealthy === false
          ? 'Torn reel'
          : s.healthy
            ? s.activeStreams > 0 ? 'Streaming' : 'Ready'
            : 'Offline';
        return `
          <div class="signal-cell ${cls}">
            <div class="id">${esc(s.accountId)}</div>
            <div class="state"><i data-lucide="${s.cdnHealthy === false ? 'alert-triangle' : s.healthy ? 'circle-check' : 'circle-x'}"></i> ${esc(stateLabel)}</div>
            <div class="meter"><div class="fill" style="--fill: ${(fillPct / 100).toFixed(4)}"></div></div>
            <div class="bytes">${
              s.quota
                ? `${formatBytes(s.quota.used)} / ${formatBytes(s.quota.max)}`
                : '—'
            }</div>
          </div>`;
      })
      .join('');

    const transferRows = transferList
      .filter((t) => t.state !== 'finished' && t.state !== 'failed')
      .map((t) => {
        const dead = isDeadTransfer(t, 999);
        const pill = dead
          ? '<span class="pill bad"><span class="dot"></span>No seeders</span>'
          : `<span class="pill warn"><span class="dot"></span>${esc(t.state)}</span>`;
        return `<tr>
          <td class="mono">${esc(t.accountId)}</td>
          <td>${esc(t.name ?? '(resolving…)')}</td>
          <td>${pill}</td>
          <td>
            <div class="bar-inline">
              <div class="bar${dead ? ' warn' : ''}"><div class="fill" style="--fill: ${(t.progress / 100).toFixed(4)}"></div></div>
              <span class="pct">${t.progress}%</span>
            </div>
          </td>
          <td class="mono dim">${formatBytes(t.size)}</td>
        </tr>`;
      })
      .join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">Operator</div>
          <h1>Now <span class="accent">Reeling</span> <span class="num">· ${statuses.length} accounts · ${formatBytes(capacity.used)} on reel</span></h1>
          <p class="lede">
            ${cdnBrokenCount > 0
              ? html`<strong>${cdnBrokenCount} account${cdnBrokenCount === 1 ? '' : 's'} on a torn reel</strong> — the pool is routing around ${cdnBrokenCount === 1 ? 'it' : 'them'}. Existing files still play via HLS fallback.`
              : html`All reels intact. New magnets will land on the account with the most free space.`}
            ${offlineCount > 0
              ? html` <strong style="color:var(--bad);">${offlineCount} offline.</strong>`
              : ''}
          </p>
        </div>
        <div class="actions">
          <form class="inline" method="post" action="/admin/magnet" data-inline style="display:inline;" id="ingestForm">
            <label class="field" style="margin:0;">
              <span>Add magnet</span>
              <textarea name="magnet" rows="2" placeholder="magnet:?xt=urn:btih:…" required style="min-height: 4.5rem;"></textarea>
            </label>
            <div style="display:flex; gap:0.4rem; margin-top: 0.55rem;">
              <button class="primary" type="submit"><i data-lucide="plus"></i> Ingest</button>
              <button class="btn" type="button" onclick="navigator.clipboard.readText().then(t=>{document.querySelector('textarea[name=magnet]').value=t}).catch(()=>{})"><i data-lucide="clipboard-paste"></i> Paste</button>
            </div>
          </form>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2><i data-lucide="activity"></i> Fleet signal <span class="count">${statuses.length - offlineCount} / ${statuses.length} healthy</span></h2>
          <a class="btn btn-sm" href="/admin/accounts" data-nav>Manage accounts →</a>
        </div>
        <div class="signal-bar">${raw(signalCells)}</div>
      </div>

      <div class="card-row cols-3">
        <div class="kpi">
          <div class="label">Movies</div>
          <div class="value">${stats.titles}</div>
          <div class="sub">${
            stats.needsLookup > 0
              ? html`<strong style="color:var(--warn);">${stats.needsLookup} need metadata</strong>`
              : html`<strong>All matched</strong>`
          }</div>
        </div>
        <div class="kpi">
          <div class="label">Files</div>
          <div class="value">${stats.files}</div>
          <div class="sub">${stats.subtitles} subtitle${stats.subtitles === 1 ? '' : 's'}</div>
        </div>
        <div class="kpi">
          <div class="label">Free space</div>
          <div class="value">${formatBytes(capacity.free)}</div>
          <div class="sub">of <strong>${formatBytes(capacity.max)}</strong></div>
        </div>
      </div>

      <div class="card-row cols-2">
        <div class="card">
          <div class="section-head" style="margin-bottom: 0.65rem;">
            <h2>Stremio addon URL</h2>
            <span class="pill ok live"><span class="dot"></span>Live</span>
          </div>
          <p class="muted" style="font-size: 0.82rem; margin-bottom: 0.65rem;">
            One URL per install. Share only with people you trust.
          </p>
          <div class="input-group">
            <input type="text" readonly value="${esc(manifestUrl)}" onclick="this.select()" />
            <button class="btn" type="button" onclick="copyText(this, '${esc(manifestUrl)}')"><i data-lucide="copy"></i> Copy</button>
            <a class="btn primary" href="${esc(stremioDeepLink)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i> Open</a>
          </div>
        </div>
        <div class="card">
          <div class="section-head" style="margin-bottom: 0.65rem;">
            <h2>Shortcuts</h2>
          </div>
          <p class="muted" style="font-size: 0.84rem; line-height: 1.6;">
            <kbd>R</kbd> reindex ·
            <kbd>G</kbd> library ·
            <kbd>T</kbd> transfers ·
            <kbd>A</kbd> fleet ·
            <kbd>H</kbd> home ·
            <kbd>Y</kbd> activity ·
            <kbd>?</kbd> this
          </p>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2><i data-lucide="arrow-down-up"></i> In flight <span class="count">${activeTransfers} active</span></h2>
          <a class="btn btn-sm" href="/admin/transfers" data-nav>All transfers →</a>
        </div>
        ${activeTransfers === 0
          ? raw(html`
              <div class="empty">
                <h3>No active transfers</h3>
                <p>Add a magnet above to start one. The pool picks the account with the most free space.</p>
              </div>
            `)
          : raw(html`
              <div class="table-wrap">
                <table>
                  <thead><tr>
                    <th>Account</th><th>Torrent</th><th>State</th><th>Progress</th><th>Size</th>
                  </tr></thead>
                  <tbody>${raw(transferRows)}</tbody>
                </table>
              </div>
            `)}
      </div>

      <div class="section">
        <div class="section-head">
          <h2><i data-lucide="history"></i> Activity <span class="count">last ${activity.length}</span></h2>
          <a class="btn btn-sm" href="/admin/activity" data-nav>Full history →</a>
        </div>
        ${activity.length === 0
          ? raw(html`
              <div class="empty">
                <h3>No events yet</h3>
                <p>The booth timeline fills up as magnets land, transfers finish, and the pool rebalances.</p>
              </div>
            `)
          : raw(html`
              <div class="card">
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

    return htmlResponse(
      layout({
        title: 'Overview',
        activeNav: '/admin',
        activeTransfers,
        // grid auto-fits in CSS; no per-page signalCols needed
        body,
      }),
    );
  }

  // ---------- Library (movie only, with TMDB art) ----------

  async library(): Promise<Response> {
    const titles = this.#library.listTitles({ kind: 'movie' });
    const duplicates = this.#library.duplicateGroups();
    const storedMagnets = this.#library.listMagnets();
    const statuses = await this.#pool.refresh();
    const cdnBroken = new Set(statuses.filter((s) => s.cdnHealthy === false).map((s) => s.accountId));

    // Build a quick map from title key -> TMDB poster for the cells.
    // The library only stores imdb_id/tmdb_id; if tmdb is null we render
    // a placeholder. The full TMDB cache is intentionally not stored.
    const rows = titles.map((t) => this.#movieRow(t, cdnBroken)).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">Library</div>
          <h1>Movies <span class="num">· ${titles.length}</span></h1>
          <p class="lede">
            Hover a row to see actions. Tinted rows are on a torn reel (HLS-only). Use Move to consolidate.
          </p>
        </div>
        <div class="actions">
          <form class="inline" method="post" action="/admin/reindex" data-inline style="display:inline;">
            <button class="btn" type="submit"><i data-lucide="refresh-cw"></i> Reindex</button>
          </form>
          <a class="btn" href="/admin" data-nav><i data-lucide="arrow-left"></i> Back</a>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2><i data-lucide="film"></i> Movies <span class="count">${titles.length}</span></h2>
          <div class="search-bar" style="margin: 0;">
            <input type="text" class="search-input" placeholder="Search by title, IMDb, account…" data-table="movieTable" />
          </div>
        </div>
        ${titles.length === 0
          ? raw(html`
              <div class="empty">
                <h3>No movies yet</h3>
                <p>Add a magnet from the overview. The indexer picks up finished downloads within a minute.</p>
                <a class="btn primary" href="/admin#ingestForm" data-nav>Ingest a magnet</a>
              </div>
            `)
          : raw(html`
              <div class="table-wrap">
                <table id="movieTable">
                  <thead><tr>
                    <th>Title</th><th>Year</th><th>Quality</th><th>Playback</th>
                    <th>Files</th><th>Size</th><th>On</th><th></th>
                  </tr></thead>
                  <tbody>${raw(rows)}</tbody>
                </table>
              </div>
            `)}
      </div>

      ${duplicates.length > 0
        ? raw(html`
            <div class="section">
              <div class="section-head">
                <h2><i data-lucide="copy"></i> Duplicates <span class="count">${duplicates.length} group${duplicates.length === 1 ? '' : 's'}</span></h2>
                <span class="muted" style="font-size: 0.78rem;">Same SHA-1 on multiple accounts. Use Move to consolidate.</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>SHA-1</th><th>Copies</th><th>Distribution</th></tr></thead>
                  <tbody>
                    ${raw(
                      duplicates
                        .map(
                          (d) => `<tr>
                          <td class="mono" style="color:var(--warn);">${esc(d.hash.slice(0, 14))}…</td>
                          <td><span class="pill warn">${d.files.length} copies</span></td>
                          <td class="mono">${esc(d.files.map((f) => f.accountId).join(', '))}</td>
                        </tr>`,
                        )
                        .join(''),
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          `)
        : ''}

      ${storedMagnets.length > 0
        ? raw(html`
            <div class="section">
              <div class="section-head"><h2><i data-lucide="magnet"></i> Stored magnets <span class="count">${storedMagnets.length}</span></h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Folder</th><th>Landing</th><th>Added</th><th></th></tr></thead>
                  <tbody>
                    ${raw(
                      storedMagnets
                        .map(
                          (m) => `<tr>
                          <td style="font-weight:500;">${esc(m.displayName)}</td>
                          <td class="mono" style="color:var(--accent); font-weight:600;">${esc(m.accountId)}</td>
                          <td class="muted">${formatRelative(Date.now() - m.addedAt)} ago</td>
                          <td>
                            <form class="inline" method="post" action="/admin/readd" data-inline>
                              <input type="hidden" name="displayName" value="${esc(m.displayName)}" />
                              <button class="btn btn-sm" type="submit" data-confirm="Re-queue this magnet on a different account?"><i data-lucide="refresh-cw"></i> Re-add</button>
                            </form>
                          </td>
                        </tr>`,
                        )
                        .join(''),
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          `)
        : ''}
    `;

    return htmlResponse(
      layout({
        title: 'Library',
        activeNav: '/admin/library',
        body,
      }),
    );
  }

  #movieRow(t: TitleSummary, cdnBroken: Set<string>): string {
    const files = this.#library.filesForTitle(t.key);
    const accounts = [...new Set(files.map((f) => f.accountId))];
    const isTorn = accounts.some((a) => cdnBroken.has(a));
    const allTorn = accounts.length > 0 && accounts.every((a) => cdnBroken.has(a));
    const movable = files.some((f) => f.magnet !== null);
    const primaryFile = files[0];

    const resBadge =
      t.bestResolution && t.bestResolution >= 2160 ? '<span class="pill purple">4K</span>'
      : t.bestResolution && t.bestResolution >= 1080 ? '<span class="pill ok">1080p</span>'
      : t.bestResolution && t.bestResolution >= 720 ? '<span class="pill warn">720p</span>'
      : t.bestResolution && t.bestResolution >= 480 ? '<span class="pill muted">SD</span>'
      : '<span class="dim mono">—</span>';

    const playState = allTorn
      ? '<span class="pill warn"><span class="dot"></span>HLS</span>'
      : isTorn
        ? '<span class="pill warn"><span class="dot"></span>Mixed</span>'
        : files.length > 0
          ? '<span class="pill ok"><span class="dot"></span>Direct</span>'
          : '<span class="dim mono">—</span>';

    // TMDB art: we don't store the poster path in the library DB, so
    // we use the imdb_id as a Cinemeta-equivalent and only show a poster
    // for titles that have one in the index. Without a local cache, we
    // render a stable placeholder with the title's first letter.
    const initial = (t.name[0] ?? '?').toUpperCase();
    const poster = t.imdbId
      ? `https://placehold.co/44x64/1c2230/e6ebf2?text=${encodeURIComponent(initial)}&font=roboto`
      : `https://placehold.co/44x64/1c2230/6a5f4d?text=${encodeURIComponent(initial)}&font=roboto`;

    // Build the "on" label with already-HTML `<span>` for the +N suffix
    // (raw() inside a plain template string is the only way to keep that
    // span un-escaped without writing the whole row through html`…`).
    const accountsLabel =
      accounts.length === 0
        ? '—'
        : accounts.length <= 2
          ? esc(accounts.join(', '))
          : `${esc(accounts.slice(0, 2).join(', '))} ${raw(`<span class="muted">+${accounts.length - 2}</span>`)}`;

    // Per-file actions: move (one click), copy download link (so the
    // operator can pull to a laptop), delete (removes from library
    // AND from Seedr). We surface these on every row, with disable
    // states when the file has no stored magnet or no playback URL.
    const moveAction = movable && primaryFile
      ? `<form class="inline" method="post" action="/admin/move" data-inline>
           <input type="hidden" name="accountId" value="${esc(primaryFile.accountId)}" />
           <input type="hidden" name="fileId" value="${esc(primaryFile.fileId)}" />
           <button class="btn btn-sm" type="submit" data-confirm="Move to a different account?"><i data-lucide="arrow-right-left"></i> Move</button>
         </form>`
      : '';

    const copyLink = primaryFile
      ? `<button class="btn btn-sm" type="button"
                 onclick="copyText(this, '/${esc(this.#config.addonSecret)}/play/${esc(primaryFile.accountId)}/${esc(primaryFile.fileId)}')">
                 <i data-lucide="link"></i> Copy link
               </button>`
      : '';

    const stremioLink = t.imdbId
      ? `<a class="btn btn-sm primary" href="stremio:///detail/movie/${esc(t.imdbId)}" target="_blank" rel="noreferrer"><i data-lucide="play"></i> Stremio</a>`
      : '';

    const deleteAction = primaryFile
      ? `<form class="inline" method="post" action="/admin/file/delete" data-inline>
           <input type="hidden" name="accountId" value="${esc(primaryFile.accountId)}" />
           <input type="hidden" name="fileId" value="${esc(primaryFile.fileId)}" />
           <button class="btn btn-sm danger" type="submit" data-confirm="Delete this file from Seedr and from the library?"><i data-lucide="trash-2"></i></button>
         </form>`
      : '';

        const actions = `<div class="row-actions">${stremioLink}${moveAction}${copyLink}${deleteAction}</div>`;

    const trClass = allTorn ? 'torn' : isTorn ? 'mixed' : '';

    return `<tr class="${trClass}">
      <td>
        <div class="movie-cell">
          <div class="poster"><img src="${esc(poster)}" alt="" loading="lazy" onerror="this.style.display='none'"/></div>
          <div class="meta">
            <div class="title">${esc(t.name)}</div>
            <div class="sub">
              ${t.imdbId !== null
                ? html`<span class="id">${esc(t.imdbId)}</span>`
                : html`<span class="id dim">awaiting metadata</span>`}
              <span>·</span>
              <span>${t.fileCount} file${t.fileCount === 1 ? '' : 's'}</span>
            </div>
            ${actions}
          </div>
        </div>
      </td>
      <td class="mono dim">${t.year ?? '—'}</td>
      <td>${resBadge}</td>
      <td>${playState}</td>
      <td class="mono">${t.fileCount}</td>
      <td class="mono">${formatBytes(t.totalSize)}</td>
      <td class="mono dim">${accountsLabel}</td>
    </tr>`;
  }

  // ---------- Transfers ----------

  async transfers(): Promise<Response> {
    await this.#pool.refresh();
    const transfers = await this.#pool.listAllTransfers();
    const active = transfers.filter((t) => t.state !== 'finished' && t.state !== 'failed').length;

    const rows = transfers
      .map((t) => {
        const dead = isDeadTransfer(t, 999);
        const pill =
          t.state === 'finished'
            ? '<span class="pill ok"><span class="dot"></span>Finished</span>'
            : dead
              ? '<span class="pill bad"><span class="dot"></span>No seeders</span>'
              : t.state === 'failed'
                ? '<span class="pill bad"><span class="dot"></span>Failed</span>'
                : `<span class="pill warn"><span class="dot"></span>${esc(t.state)}</span>`;
        return `<tr>
          <td class="mono">${esc(t.accountId)}</td>
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
            <form class="inline" method="post" action="/admin/transfers/delete" data-inline>
              <input type="hidden" name="accountId" value="${esc(t.accountId)}" />
              <input type="hidden" name="transferId" value="${esc(t.id)}" />
              <button class="btn btn-sm danger" type="submit" data-confirm="Remove this transfer from ${esc(t.accountId)}?"><i data-lucide="trash-2"></i></button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">Transfers</div>
          <h1>${active} <span class="accent">in flight</span> <span class="num">· ${transfers.length} total</span></h1>
          <p class="lede">Per-account view of every magnet currently in flight. "No seeders" pills mean the swarm is dead — remove to free the slot.</p>
        </div>
        <div class="actions">
          <a class="btn" href="/admin" data-nav><i data-lucide="arrow-left"></i> Back</a>
        </div>
      </div>

      <div class="section">
        <div class="search-bar">
          <input type="text" class="search-input" placeholder="Search by account, torrent, state…" data-table="transferTable" />
          <span class="muted mono" style="font-size: 0.7rem;">${transfers.length} rows</span>
        </div>
        ${transfers.length === 0
          ? raw(html`
              <div class="empty">
                <h3>No transfers</h3>
                <p>Add a magnet from the overview to start one.</p>
                <a class="btn primary" href="/admin" data-nav>Back to overview</a>
              </div>
            `)
          : raw(html`
              <div class="table-wrap">
                <table id="transferTable">
                  <thead><tr>
                    <th>Account</th><th>Torrent</th><th>State</th><th>Progress</th>
                    <th>Size</th><th>Peers</th><th></th>
                  </tr></thead>
                  <tbody>${raw(rows)}</tbody>
                </table>
              </div>
            `)}
      </div>
    `;

    return htmlResponse(layout({ title: 'Transfers', activeNav: '/admin/transfers', body }));
  }

  async transferCount(): Promise<Response> {
    try {
      const transfers = await this.#pool.listAllTransfers();
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

  async deleteTransfer(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    const transferId = String(form.get('transferId') ?? '');
    const provider = this.#pool.provider(accountId);
    if (!provider) return this.#message('bad', `Unknown account ${accountId}.`);
    try {
      await provider.deleteTransfer(transferId);
      this.#library.recordActivity('info', `Transfer removed from ${accountId}`, transferId);
      return redirect('/admin/transfers');
    } catch (err) {
      return this.#message('bad', err instanceof Error ? err.message : String(err));
    }
  }

  // ---------- Fleet (accounts) ----------

  async accounts(): Promise<Response> {
    const statuses = await this.#pool.refresh();
    const { problems } = this.#credentials;
    const emails = new Map(this.#credentials.accounts.map((a) => [a.id, a.email]));

    const rows = statuses
      .map((s) => {
        const quota = s.quota;
        const fillPct = quota && quota.max > 0 ? (quota.used / quota.max) * 100 : 0;
        const statePill = s.needsReauth
          ? '<span class="pill bad"><span class="dot"></span>Bad password</span>'
          : s.cdnHealthy === false
            ? '<span class="pill warn"><span class="dot"></span>Torn reel</span>'
            : s.healthy
              ? '<span class="pill ok live"><span class="dot"></span>Healthy</span>'
              : '<span class="pill off"><span class="dot"></span>Offline</span>';
        const cdnNote =
          s.cdnHealthy === false && s.cdnBrokenAt !== undefined
            ? html`<div class="muted" style="color:var(--warn); font-size:0.74rem; margin-top:0.3rem;">${esc(s.cdnReason ?? 'ff_get 404s')} · ${formatRelative(Date.now() - s.cdnBrokenAt)} ago · pool retries in ${formatRelative(30 * 60_000 - (Date.now() - s.cdnBrokenAt))}</div>`
            : '';
        const fixNote = s.needsReauth
          ? html`<div class="muted" style="color:var(--bad); font-size:0.74rem; margin-top:0.3rem;">Correct credentials in <code>${esc(this.#config.credentialsPath)}</code>, then reload.</div>`
          : '';
        return `
          <tr>
            <td class="mono" style="font-weight:600; color: var(--text);">${esc(s.accountId)}</td>
            <td class="muted">${esc(emails.get(s.accountId) ?? '—')}</td>
            <td>${statePill}</td>
            <td>
              <div class="bar-inline">
                <div class="bar${s.cdnHealthy === false ? ' warn' : ''}"><div class="fill" style="--fill: ${(fillPct / 100).toFixed(4)}"></div></div>
                <span class="pct">${fillPct.toFixed(0)}%</span>
              </div>
            </td>
            <td class="mono">${quota ? `${formatBytes(quota.used)} / ${formatBytes(quota.max)}` : '—'}</td>
            <td class="mono dim">${s.activeStreams}</td>
            <td>
              <div class="row-actions">
                <form class="inline" method="post" action="/admin/accounts/purge" data-inline>
                  <input type="hidden" name="accountId" value="${esc(s.accountId)}" />
                  <button class="btn btn-sm danger" type="submit" data-confirm="Purge ALL files for ${esc(s.accountId)} from the library and from Seedr?"><i data-lucide="eraser"></i> Purge</button>
                </form>
                <form class="inline" method="post" action="/admin/accounts/delete" data-inline>
                  <input type="hidden" name="accountId" value="${esc(s.accountId)}" />
                  <button class="btn btn-sm danger" type="submit" data-confirm="Remove ${esc(s.accountId)} from the pool? Library rows for it are kept."><i data-lucide="x"></i> Remove</button>
                </form>
              </div>
            </td>
          </tr>
          ${cdnNote || fixNote ? raw(`<tr><td colspan="7" style="padding: 0.2rem 0.85rem 0.7rem;">${cdnNote}${fixNote}</td></tr>`) : ''}
        `;
      })
      .join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">Fleet</div>
          <h1>${statuses.length} accounts</h1>
          <p class="lede">One row per account. Bar shows storage in use; a red bar means a torn reel. <strong>Purge</strong> removes every file for that account from both Seedr and the library; <strong>Remove</strong> drops the account from the pool but keeps the library rows.</p>
        </div>
        <div class="actions">
          <button class="btn primary" data-modal-open="addAccountModal">
            <i data-lucide="plus"></i> Add account
          </button>
          <form class="inline" method="post" action="/admin/accounts/reload" data-inline style="display:inline;">
            <button class="btn" type="submit" data-confirm="Reload credentials and rebuild the pool?"><i data-lucide="rotate-ccw"></i> Re-probe all</button>
          </form>
        </div>
      </div>

      <div class="section">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>ID</th><th>Account</th><th>State</th><th>Used</th><th>Bytes</th><th>Streams</th><th></th>
            </tr></thead>
            <tbody>${raw(rows)}</tbody>
          </table>
        </div>
      </div>

      ${problems.length > 0
        ? raw(html`
            <div class="section">
              <div class="section-head"><h2><i data-lucide="alert-triangle"></i> Credential diagnostics <span class="count">${problems.length} issue${problems.length === 1 ? '' : 's'}</span></h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Line</th><th>Detail</th></tr></thead>
                  <tbody>
                    ${raw(problems.map((p) => `<tr><td class="mono" style="color:var(--bad); font-weight:700;">#${p.line}</td><td>${esc(p.reason)}</td></tr>`).join(''))}
                  </tbody>
                </table>
              </div>
            </div>
          `)
        : ''}

      <div class="section">
        <div class="section-head"><h2>Config</h2></div>
        <div class="card">
          <p class="muted" style="font-size:0.85rem;">Accounts load from <code>${esc(this.#config.credentialsPath)}</code> — one <code>email:password</code> per line. Line 1 → <code>acc1</code>, line 2 → <code>acc2</code>. <em>Append</em> at the bottom; never renumber.</p>
        </div>
      </div>

      <!-- Add-account modal -->
      <div class="modal-backdrop" id="addAccountModal">
        <div class="modal" onclick="event.stopPropagation()">
          <div class="modal-head">
            <div class="modal-title">Add Seedr account</div>
            <button class="modal-close" data-modal-close="addAccountModal"><i data-lucide="x"></i></button>
          </div>
          <form class="modal-body" method="post" action="/admin/accounts/add" data-inline>
            <label class="field">
              Seedr email
              <input type="email" name="email" required placeholder="you@example.com" />
            </label>
            <label class="field">
              Seedr password
              <input type="password" name="password" required minlength="6" />
            </label>
            <div class="muted" style="font-size: 0.74rem;">
              Credentials are appended to <code>${esc(this.#config.credentialsPath)}</code> and assigned <code>acc${this.#credentials.accounts.length + 1}</code>.
            </div>
            <div class="modal-foot">
              <button type="button" class="btn" data-modal-close="addAccountModal">Cancel</button>
              <button type="submit" class="primary"><i data-lucide="plus"></i> Add</button>
            </div>
          </form>
        </div>
      </div>
    `;

    return htmlResponse(
      layout({
        title: 'Fleet',
        activeNav: '/admin/accounts',
        // grid auto-fits in CSS; no per-page signalCols needed
        body,
      }),
    );
  }

  async reloadAccounts(): Promise<Response> {
    await this.#onAccountsChanged();
    return redirect('/admin/accounts');
  }

  async addAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '').trim();
    if (!email || !password) return this.#message('bad', 'Email and password required.');
    if (this.#credentials.accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      return this.#message('bad', `Account ${email} already in the pool.`);
    }
    // Sanity-check credentials by attempting a probe. If the password is
    // wrong, the Seedr V1 grant fails with "invalid_grant" — we surface
    // that before persisting so the operator never saves dead creds.
    const probe = new SeedrV1Provider({ id: '__probe__', email, password });
    try {
      const ok = await probe.healthCheck();
      if (!ok.healthy) {
        return this.#message('bad', `Seedr rejected these credentials: ${ok.reason ?? 'unknown reason'}`);
      }
    } catch (err) {
      return this.#message('bad', `Seedr login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const newAccount: AccountCredential = {
      id: `acc${this.#credentials.accounts.length + 1}`,
      email,
      password,
    };
    const updated = [...this.#credentials.accounts, newAccount];
    try {
      await writeCredentials(this.#config.credentialsPath, updated);
    } catch (err) {
      return this.#message('bad', `Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#library.recordActivity('info', `Account added: ${newAccount.id}`, email);
    await this.#onAccountsChanged();
    return redirect('/admin/accounts');
  }

  async deleteAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    const filtered = this.#credentials.accounts.filter((a) => a.id !== accountId);
    if (filtered.length === this.#credentials.accounts.length) {
      return this.#message('bad', `Account ${accountId} not found.`);
    }
    try {
      await writeCredentials(this.#config.credentialsPath, filtered);
    } catch (err) {
      return this.#message('bad', `Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#library.recordActivity('info', `Account removed: ${accountId}`);
    await this.#onAccountsChanged();
    return redirect('/admin/accounts');
  }

  async purgeAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    if (!accountId) return this.#message('bad', 'Missing accountId.');
    const provider = this.#pool.provider(accountId);
    if (!provider) {
      // Account is already removed; just clean up the library.
      const removed = this.#library.deleteAccountFiles(accountId);
      this.#library.recordActivity('warn', `Purged ${accountId} from library (not in pool)`, `${removed} files`);
      return redirect('/admin/accounts');
    }
    let deleted = 0;
    let failed = 0;
    try {
      const root = await provider.listFolder(null);
      for (const f of root.folders) {
        try { await provider.deleteFolder(f.id); deleted += 1; } catch { failed += 1; }
      }
      for (const f of root.files) {
        try { await provider.deleteFile(f.id); deleted += 1; } catch { failed += 1; }
      }
    } catch (err) {
      this.#library.recordActivity('bad', `Purge ${accountId} failed`, err instanceof Error ? err.message : String(err));
      return this.#message('bad', `Could not list folders on ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const removed = this.#library.deleteAccountFiles(accountId);
    this.#library.recordActivity(
      failed > 0 ? 'warn' : 'success',
      `Purged ${accountId}: ${deleted} Seedr item${deleted === 1 ? '' : 's'}, ${removed} library row${removed === 1 ? '' : 's'}`,
      failed > 0 ? `${failed} Seedr items failed` : 'ok',
    );
    return redirect('/admin/accounts');
  }

  async deleteFile(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    const fileId = String(form.get('fileId') ?? '');
    if (!accountId || !fileId) return this.#message('bad', 'Missing accountId or fileId.');
    const provider = this.#pool.provider(accountId);
    if (!provider) return this.#message('bad', `Unknown account ${accountId}.`);
    try {
      await provider.deleteFile(fileId);
    } catch (err) {
      this.#library.recordActivity('bad', `Delete failed on ${accountId}/${fileId}`, err instanceof Error ? err.message : String(err));
      return this.#message('bad', `Seedr delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#library.deleteFileRow(accountId, fileId);
    this.#library.recordActivity('info', `File deleted from ${accountId}`, fileId);
    return redirect('/admin/library');
  }

  // ---------- Activity (transaction history) ----------

  async activity(ctx: RouteContext): Promise<Response> {
    const url = new URL(ctx.request.url);
    const account = url.searchParams.get('account') ?? '';
    const kind = url.searchParams.get('kind') ?? '';
    const since = Number(url.searchParams.get('since') ?? 0); // unix ms
    const until = Number(url.searchParams.get('until') ?? 0);
    const events = this.#library.recentActivity(1000);
    const accounts = [...new Set(events.map((e) => extractAccountFromDetail(e.message, e.detail) ?? '').filter(Boolean))];
    const kinds: Array<'info' | 'success' | 'warn' | 'bad'> = ['info', 'success', 'warn', 'bad'];

    const filtered = events.filter((e) => {
      if (kind && e.kind !== kind) return false;
      if (since > 0 && e.at < since) return false;
      if (until > 0 && e.at > until) return false;
      if (account) {
        const inMsg = e.message.toLowerCase().includes(account.toLowerCase());
        const inDetail = e.detail !== null && e.detail.toLowerCase().includes(account.toLowerCase());
        if (!inMsg && !inDetail) return false;
      }
      return true;
    });

    const accountChip = (label: string, value: string, isActive: boolean) =>
      `<button class="chip${isActive ? ' active' : ''}" onclick="setParam('account', '${esc(value)}')">${esc(label)}${isActive ? `<span class="x" onclick="event.stopPropagation();setParam('account','')">×</span>` : ''}</button>`;
    const kindChip = (k: string, label: string) =>
      `<button class="chip${kind === k ? ' active' : ''}" onclick="setParam('kind', '${k === kind ? '' : esc(k)}')">${esc(label)}</button>`;

    const rows = filtered.map((e) => {
      const acc = extractAccountFromDetail(e.message, e.detail) ?? '—';
      return `<tr>
        <td class="ts mono">${formatRelative(Date.now() - e.at)} ago</td>
        <td class="ts mono dim">${new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td><span class="pill ${esc(e.kind)}"><span class="dot"></span>${esc(e.kind)}</span></td>
        <td class="mono">${esc(acc)}</td>
        <td>${esc(e.message)}</td>
        <td class="muted">${e.detail ? esc(e.detail) : ''}</td>
      </tr>`;
    }).join('');

    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">Transaction history</div>
          <h1>Activity <span class="num">· ${filtered.length} of ${events.length}</span></h1>
          <p class="lede">Every event the operator should know about. Filter by account, kind, or time.</p>
        </div>
        <div class="actions">
          <a class="btn" href="/admin" data-nav><i data-lucide="arrow-left"></i> Back</a>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Filters</h2></div>
        <div class="card-row cols-2" style="margin-bottom: 0.65rem;">
          <div>
            <div class="muted mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 0.35rem;">Account</div>
            <div class="chip-group">
              <button class="chip${account === '' ? ' active' : ''}" onclick="setParam('account', '')">all</button>
              ${raw(accounts.map((a) => accountChip(a, a, account === a)).join(''))}
            </div>
          </div>
          <div>
            <div class="muted mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 0.35rem;">Kind</div>
            <div class="chip-group">
              ${raw(kinds.map((k) => kindChip(k, k)).join(''))}
            </div>
          </div>
        </div>
        <div class="card-row cols-2">
          <div>
            <div class="muted mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 0.35rem;">Since</div>
            <input type="datetime-local" id="sinceInput" value="${since ? new Date(since).toISOString().slice(0, 16) : ''}" onchange="setParam('since', this.value ? new Date(this.value).getTime() : '')" />
          </div>
          <div>
            <div class="muted mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 0.35rem;">Until</div>
            <input type="datetime-local" id="untilInput" value="${until ? new Date(until).toISOString().slice(0, 16) : ''}" onchange="setParam('until', this.value ? new Date(this.value).getTime() : '')" />
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

    return htmlResponse(layout({ title: 'Activity', activeNav: '/admin/activity', body }));
  }

  // ---------- Add magnet (kept from before) ----------

  async addMagnet(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const raw = String(form.get('magnet') ?? '').trim();
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) return this.#message('bad', 'No magnet lines found.');
    if (lines.some((l) => !l.startsWith('magnet:'))) {
      const badLine = lines.find((l) => !l.startsWith('magnet:'));
      return this.#message('bad', `Not a magnet link: "${(badLine ?? '').slice(0, 60)}…"`);
    }
    await this.#pool.refresh();
    const results: string[] = [];
    for (const magnet of lines) {
      try {
        const allocation = this.#pool.allocate(0);
        const transfer = await allocation.provider.addMagnet(magnet);
        const displayName = magnetDisplayName(magnet);
        if (displayName !== null) this.#library.recordMagnet(displayName, magnet, allocation.accountId);
        this.#library.recordActivity('info', `Magnet added to ${allocation.accountId}`, displayName ?? transfer.id);
        void this.#indexer.scanAccount(allocation.provider).then(() => this.#enricher.tick());
        results.push(`${allocation.accountId} ← ${displayName ?? transfer.id}`);
      } catch (err) {
        if (err instanceof NoCapacityError) {
          return this.#message('bad', `No healthy account has space (${results.length} of ${lines.length} added).`);
        }
        return this.#message('bad', err instanceof Error ? err.message : String(err));
      }
    }
    return this.#message('ok', lines.length === 1 ? (results[0] ?? 'Ingested') : `Ingested ${lines.length}: ${results.join(' · ')}`);
  }

  // ---------- Re-add and move (from before) ----------

  async reindex(): Promise<Response> {
    void this.#indexer.scanAll().then(() => this.#enricher.tick());
    this.#library.recordActivity('info', 'Reindex started');
    return redirect('/admin');
  }

  async reAddMagnet(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const displayName = String(form.get('displayName') ?? '').trim();
    if (displayName === '') return this.#message('bad', 'Missing display name.');
    const record = this.#library.magnetForFolder(displayName);
    if (record === null) return this.#message('bad', `No stored magnet for "${displayName}".`);
    await this.#pool.refresh();
    try {
      const allocation = this.#pool.allocate(0);
      const transfer = await allocation.provider.addMagnet(record.magnet);
      this.#library.recordMagnet(displayName, record.magnet, allocation.accountId);
      this.#library.recordActivity('info', `Re-added to ${allocation.accountId}`, displayName);
      void this.#indexer.scanAccount(allocation.provider).then(() => this.#enricher.tick());
      return this.#message('ok', `Re-added to ${allocation.accountId}. Task ${transfer.id}.`);
    } catch (err) {
      if (err instanceof NoCapacityError) return this.#message('bad', 'No healthy account has space. Free some storage first.');
      return this.#message('bad', err instanceof Error ? err.message : String(err));
    }
  }

  async moveFile(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const sourceAccount = String(form.get('accountId') ?? '');
    const fileId = String(form.get('fileId') ?? '');
    if (sourceAccount === '' || fileId === '') return this.#message('bad', 'Missing accountId or fileId.');
    const file = this.#library.findFile(sourceAccount, fileId);
    if (file === null) return this.#message('bad', `File ${sourceAccount}/${fileId} not found.`);
    if (file.magnet === null) return this.#message('bad', 'No stored magnet for this file. Re-adding is only available for files added through this admin.');
    await this.#pool.refresh();
    let allocation;
    try { allocation = this.#pool.allocate(0); }
    catch (err) {
      if (err instanceof NoCapacityError) return this.#message('bad', 'No healthy account has space.');
      throw err;
    }
    if (allocation.accountId === sourceAccount) return this.#message('bad', `Pool picked the same account. All others are full or unhealthy.`);
    let transferId: string;
    try {
      const transfer = await allocation.provider.addMagnet(file.magnet);
      transferId = transfer.id;
    } catch (err) {
      return this.#message('bad', err instanceof Error ? err.message : String(err));
    }
    const sourceProvider = this.#pool.provider(sourceAccount);
    let deleted = false;
    let deleteError: string | null = null;
    if (sourceProvider !== undefined) {
      try { await sourceProvider.deleteFile(fileId); this.#library.deleteFileRow(sourceAccount, fileId); deleted = true; }
      catch (err) { deleteError = err instanceof Error ? err.message : String(err); }
    }
    const displayName = magnetDisplayName(file.magnet);
    if (displayName !== null) this.#library.recordMagnet(displayName, file.magnet, allocation.accountId);
    this.#library.recordActivity(
      deleted ? 'success' : 'warn',
      `Moved ${displayName ?? file.name} → ${allocation.accountId}`,
      deleted ? 'Source deleted.' : `Source not deleted: ${deleteError ?? 'unknown'}`,
    );
    void this.#indexer.scanAccount(allocation.provider).then(() => this.#enricher.tick());
    return this.#message(
      deleted ? 'ok' : 'bad',
      deleted
        ? `Moved to ${allocation.accountId} — ${allocation.reason}. Source deleted.`
        : `Move incomplete: re-added to ${allocation.accountId}, but source deletion failed (${deleteError ?? 'unknown'}). Use the duplicates list to clean up.`,
    );
  }

  // ---------- One-off result page ----------

  #message(kind: 'ok' | 'bad', text: string): Response {
    const title = kind === 'ok' ? 'Done' : 'Problem';
    const body = html`
      <div class="page-head">
        <div class="lead">
          <div class="eyebrow">${esc(title)}</div>
          <h1>${esc(text)}</h1>
        </div>
        <div class="actions">
          <a class="btn primary" href="/admin" data-nav><i data-lucide="arrow-left"></i> Back to overview</a>
          <a class="btn" href="/admin/library" data-nav><i data-lucide="library"></i> Open the library</a>
        </div>
      </div>
    `;
    return htmlResponse(
      layout({
        title: kind === 'ok' ? 'Done' : 'Problem',
        activeNav: '/admin',
        body,
        initialToast: { kind, title, detail: text },
      }),
    );
  }
}

// ---------- Helpers ----------

/** Pulls the accN reference from a message or detail string, if any. */
function extractAccountFromDetail(message: string, detail: string | null): string | null {
  const text = `${message} ${detail ?? ''}`;
  const m = /\b(acc\d+|acc\w+)\b/i.exec(text);
  return m ? (m[1] ?? null) : null;
}

/** Formats a duration in ms as a short human-readable string. */
function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function magnetDisplayName(magnet: string): string | null {
  const match = /[?&]dn=([^&]+)/.exec(magnet);
  if (!match?.[1]) return null;
  try { return decodeURIComponent(match[1].replaceAll('+', ' ')); }
  catch { return null; }
}

export function buildPoolEntries(credentials: CredentialFile) {
  return credentials.accounts.map((credential) => ({
    provider: new SeedrV1Provider(credential),
    label: credential.email,
    needsReauth: false,
  }));
}
