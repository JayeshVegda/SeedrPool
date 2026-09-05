/**
 * SeedrPool entrypoint.
 *
 * Wires the credentials file, account pool, library index, admin interface,
 * Stremio addon, and HTTP server. The manifest path is reserved under
 * `/{addonSecret}/...` so the URL friends install never has to change.
 */

import { createServer } from 'node:http';
import { loadConfig } from './core/config.ts';
import { loadCredentials } from './core/credentials.ts';
import { AccountPool } from './core/account-pool.ts';
import { Router, htmlResponse, json, redirect, requireBasicAuth, serveAsset } from './core/router.ts';
import { AdminApp, buildPoolEntries } from './admin/app.ts';
import { LibraryStore } from './library/store.ts';
import { Indexer } from './library/indexer.ts';
import { MetadataEnricher } from './library/metadata-enricher.ts';
import { TmdbClient } from './library/tmdb.ts';
import { AddonApp } from './addon/app.ts';
import { TransferWatcher } from './core/transfer-watcher.ts';
import { Dumper } from './core/dumper.ts';
import { AdminViews } from './core/admin-views.ts';
import { AdminActions, type DumpResult } from './core/admin-actions.ts';
import { buildAdminAssets, assetList } from './core/assets.ts';
import { buildHealthReport, type HealthSources } from './core/health.ts';
import {
  playbackLimiter,
  clientKey,
  tooManyRequests,
  PEER_ADDRESS_HEADER,
} from './core/request-limiter.ts';
import { STYLES_BODY, layout } from './admin/html.ts';
import { type AccountStatus } from './core/account-pool.ts';
import { NoCapacityError } from './core/account-pool.ts';
import { magnetDisplayName } from './admin/magnet-name.ts';

// ---------------------------------------------------------------------------
// Crash guards — installed before anything below can reject.
//
// Without these, one stray rejected promise from a background timer takes the
// whole process down (Node's default for unhandledRejection). Docker restarts
// it, but mid-download state dies silently and the operator finds out later.
// `recordFatal` is late-bound: during startup `library` does not exist yet,
// and a crash there is still a crash.
// ---------------------------------------------------------------------------

let recordFatal: (kind: string, err: unknown) => void = (_kind, _err) => {};

process.on('unhandledRejection', (err) => {
  console.error('FATAL unhandled rejection:', err instanceof Error ? (err.stack ?? err.message) : err);
  recordFatal('unhandled rejection', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('FATAL uncaught exception:', err instanceof Error ? (err.stack ?? err.message) : err);
  recordFatal('uncaught exception', err);
  process.exit(1);
});

const config = await loadConfig();
let credentials = await loadCredentials(config.credentialsPath);

if (credentials.accounts.length === 0) {
  console.warn(`WARNING: no accounts in ${config.credentialsPath}. Add one "email:password" per line, then reload from /admin/accounts.`);
}
for (const problem of credentials.problems) {
  console.warn(`credentials line ${problem.line}: ${problem.reason}`);
}

let pool = new AccountPool(buildPoolEntries(credentials));
let library = new LibraryStore(config.databasePath);

// Now that the library exists, crashes also leave a trace in the activity
// log — the one place the operator actually reads. If the DB is itself the
// reason we are dying, this write fails and the console line above is the
// only record, which is fine.
recordFatal = (kind, err) => {
  try {
    library.recordActivity(
      'bad',
      `Process ${kind}`,
      err instanceof Error ? err.message : String(err),
    );
  } catch {
    /* already logged to the console */
  }
};
const indexer = new Indexer(library, () => pool);
const tmdb = new TmdbClient(config.tmdbApiKey);
const enricher = new MetadataEnricher(library, tmdb);
const addon = new AddonApp(library, () => pool, config);
const watcher = new TransferWatcher(() => pool, indexer);
const views = new AdminViews(() => pool, library);

const dumper = new Dumper({ directory: config.dumpsDir });

/**
 * One health snapshot, shared by /healthz, the admin health page, and the
 * container healthcheck. The sources are getters so each report sees the
 * current pool (which rebuildPool() can replace) rather than a stale one.
 */
function healthSources(): HealthSources {
  return {
    db: library,
    pool,
    // The watcher's poll heartbeat, not the indexer's scan timestamp: a scan
    // only runs when a transfer completes, so a quiet pool is healthy.
    indexer: { lastTickAt: watcher.lastTickAt },
    enricher,
    store: library,
  };
}

/**
 * The readiness endpoint.
 *
 * 200 = every check ok or merely warned; 503 = at least one check is bad, so
 * an uptime monitor (or `docker compose ps`) sees the failure instead of a
 * process that is merely alive. Warn does not fail the probe: a pool at 25%
 * healthy or a stale index still serves traffic, and flipping the container
 * to unhealthy over it would trigger restart loops that make things worse.
 */
function healthz(): Response {
  const report = buildHealthReport(healthSources());
  const body = JSON.stringify(
    { status: report.status, checks: report.checks },
    null,
    process.env['NODE_ENV'] === 'production' ? 0 : 2,
  );
  return new Response(body, {
    status: report.status === 'bad' ? 503 : 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const DUMP_INTERVAL_MS = 6 * 60 * 60_000;
async function runDump(): Promise<DumpResult> {
  try {
    const { written, errors, incomplete } = await dumper.dump(pool);
    if (written.length > 0) {
      console.log(
        `dump: wrote ${written.length} file${written.length === 1 ? '' : 's'}` +
        (incomplete.length > 0 ? `, ${incomplete.length} incomplete` : '') +
        (errors.length > 0 ? `, ${errors.length} error${errors.length === 1 ? '' : 's'}` : ''),
      );
    }
    for (const e of errors) console.warn(`dump: ${e}`);
    // An incomplete dump is written but its numbers are not the account's
    // real state. Logging it loudly is the difference between noticing and
    // silently trusting a file full of zeros.
    for (const i of incomplete) console.warn(`dump: incomplete ${i}`);
    return {
      written: written.length,
      errors: errors.length,
      errorMessages: errors,
      incomplete: incomplete.length,
      incompleteMessages: incomplete,
    };
  } catch (err) {
    console.warn('dump: failed:', err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : String(err);
    return { written: 0, errors: 1, errorMessages: [message], incomplete: 0, incompleteMessages: [] };
  }
}

async function rebuildPool(): Promise<void> {
  credentials = await loadCredentials(config.credentialsPath);
  pool = new AccountPool(buildPoolEntries(credentials));
  admin.setCredentials(credentials);
  await pool.refresh({ force: true });
  void indexer.scanAll().then(() => views.refresh());
}

const actions = new AdminActions({
  getPool: () => pool,
  getLibrary: () => library,
  indexer,
  enricher,
  getCredentials: () => credentials,
  credentialsPath: config.credentialsPath,
  onAccountsChanged: rebuildPool,
  runDump,
});

const assets = buildAdminAssets(() => STYLES_BODY);

const admin = new AdminApp({
  getPool: () => pool,
  config,
  credentials,
  onAccountsChanged: rebuildPool,
  library,
  indexer,
  enricher,
  actions,
  views,
  assets,
  runDump,
  healthReport: () => buildHealthReport(healthSources()),
});

indexer.setOnScanComplete(async () => {
  views.refresh();
  await enricher.tick();
});

watcher.setOnCompletion(
  async (enr, accountId, finished) => {
    for (const id of finished) {
      library.recordActivity('success', `Transfer completed on ${accountId}`, id);
    }
    await enr.tick();
  },
  enricher,
);

// The startup dump is deliberately NOT run here.
//
// It used to be, and that was the bug behind eight dumps of a 5 GiB account
// all reading `0.00 GB`: this point in the file is before the first
// `pool.refresh()`, so no account had logged in yet, every API call in the
// snapshot failed, and the old `.catch(() => ({ used: 0 }))` wrote zeros that
// were indistinguishable from a genuinely empty account. The dump now runs
// after the startup probe, further down.
const dumpTimer = setInterval(() => { void runDump(); }, DUMP_INTERVAL_MS);
dumpTimer.unref();

const addonPath = `/${config.addonSecret}`;

const router = new Router()
  .get('/admin/assets/:name', (ctx) => {
    const name = ctx.params['name'] ?? '';
    const asset = assetList(assets).find((a) => a.path.endsWith(`/${name}`));
    if (asset) return serveAsset(asset, ctx.request);
    return new Response('not found', { status: 404 });
  })
  .get('/', () => redirect('/admin'))
  .get('/admin', () => admin.overview())
  .get('/admin/library', () => admin.library())
  .get('/admin/transfers', () => admin.transfers())
  // The polled fragment for live updates. htmx on /admin/transfers fires
  // this every 4s; the response is just the table markup, not a full page.
  .get('/admin/transfers/table', () => admin.transfersTable())
  .get('/admin/transfers/count', () => admin.transferCount())
  .get('/admin/accounts', () => admin.accounts())
  .get('/admin/accounts/:accountId', (ctx) => admin.accountDetailPage(ctx))
  .get('/admin/activity', (ctx) => admin.activity(ctx))
  .get('/admin/dumps', () => admin.dumps())
  // Centralized health, same checks as /healthz but rendered for humans.
  // Previously this returned `transferCount()` — a copy-paste leftover that
  // answered `{"count":N}` to anyone expecting a health document.
  .get('/admin/health', () => admin.healthPage())
  .get('/healthz', healthz)

  // ---- JSON action endpoints (item 9: rich toasts, no page replacement) ----
  //
  // Every mutation is served by `AdminActions`. They used to be split: some
  // here, some on `AdminApp` next to the HTML rendering, and the two halves
  // disagreed about error reporting (one used status codes, the other
  // answered 200 with `{ok:false}`). One owner now.
  .post('/admin/api/magnet', (ctx) => actions.addMagnet(ctx))
  .post('/admin/api/account/add', (ctx) => actions.addAccount(ctx))
  .post('/admin/api/account/delete', (ctx) => actions.deleteAccount(ctx))
  .post('/admin/api/account/purge', (ctx) => actions.purgeAccount(ctx))
  .post('/admin/api/account/reauth', (ctx) => actions.reauthAccount(ctx))
  .post('/admin/api/transfer/delete', (ctx) => actions.deleteTransfer(ctx))
  .post('/admin/api/move', (ctx) => actions.moveFile(ctx))
  .post('/admin/api/file/delete', (ctx) => actions.deleteFile(ctx))
  .post('/admin/api/readd', (ctx) => actions.reAddMagnet(ctx))
  .post('/admin/api/reindex', () => actions.reindex())
  .post('/admin/api/reindex/:accountId', (ctx) => actions.reindexAccount(ctx))
  .post('/admin/api/enrich-all', () => actions.enrichAll())
  .post('/admin/api/clear-metadata', () => actions.clearMetadataAll())
  .post('/admin/api/metadata/:titleKey', (ctx) => actions.clearMetadataOne(ctx))
  .post('/admin/api/dump', () => actions.runDump())
  .post('/admin/api/reload', () => actions.reload())

  // ---- Stremio addon routes ----
  .get(`${addonPath}/manifest.json`, () => addon.manifest(), { cors: true })
  .get(`${addonPath}/catalog/:type/:catalogId.json`, (ctx) => addon.catalog(ctx), { cors: true })
  .get(`${addonPath}/catalog/:type/:catalogId/:extra.json`, (ctx) => addon.catalog(ctx), { cors: true })
  .get(`${addonPath}/meta/:type/:id`, (ctx) => addon.meta(ctx), { cors: true })
  .get(`${addonPath}/stream/:type/:id`, (ctx) => addon.stream(ctx), { cors: true })
  .get(`${addonPath}/subtitles/:type/:id`, (ctx) => addon.subtitles(ctx), { cors: true })
  // Rate-limited: this is the only unauthenticated route that mints a real
  // Seedr CDN URL, and the path is enumerable (`accN` plus a dense file id).
  // Without a limit, anyone holding the manifest URL could walk the whole
  // library, spending one Seedr API call per attempt against that account's
  // budget. 30/min per client is far above real playback and far below a sweep.
  .get(`${addonPath}/play/:accountId/:fileId`, (ctx) => {
    const decision = playbackLimiter.check(clientKey(ctx.request));
    if (!decision.allowed) return tooManyRequests(decision);
    return addon.play(ctx);
  })
  .get(`${addonPath}/poster/:key`, (ctx) => addon.poster(ctx), { cors: true })
  .get(`${addonPath}/logo.png`, () => addon.logo(), { cors: true });

// Compatibility shim for any client that hits the old direct-download paths.
router.post('/admin/file/delete', (ctx) => actions.deleteFile(ctx));
router.post('/admin/file/url', (ctx) => addon.fileUrl(ctx));
router.get('/admin/file/download', (ctx) => addon.fileDownload(ctx));
router.post('/admin/magnet', (ctx) => actions.addMagnet(ctx));
router.post('/admin/reindex', () => actions.reindex());
router.post('/admin/readd', (ctx) => actions.reAddMagnet(ctx));
router.post('/admin/move', (ctx) => actions.moveFile(ctx));
router.post('/admin/dump', () => actions.runDump());
router.post('/admin/accounts/reload', () => actions.reload());
router.post('/admin/accounts/add', (ctx) => actions.addAccount(ctx));
router.post('/admin/accounts/delete', (ctx) => actions.deleteAccount(ctx));
router.post('/admin/accounts/purge', (ctx) => actions.purgeAccount(ctx));
router.post('/admin/transfers/delete', (ctx) => actions.deleteTransfer(ctx));

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

  // Record the TCP peer for the request limiter, overwriting anything a client
  // sent under that name so it cannot be spoofed. Caddy's X-Real-IP is
  // preferred when present; this is the fallback for direct connections.
  const headers = { ...req.headers } as Record<string, string>;
  delete headers[PEER_ADDRESS_HEADER];
  const peer = req.socket.remoteAddress;
  if (peer !== undefined) headers[PEER_ADDRESS_HEADER] = peer;

  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  let response: Response;
  try {
    const path = new URL(url).pathname;
    const isPublic = path === '/healthz' || path.startsWith(addonPath) || path.startsWith('/admin/assets/');
    const challenge = isPublic ? null : requireBasicAuth(request, config.adminUser, config.adminPassword);
    response = challenge ?? (await router.handle(request));
  } catch (err) {
    console.error('request failed:', err instanceof Error ? err.message : err);
    response = htmlResponse(`<h1>500</h1><p>Internal error.</p>`, { status: 500 });
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
});

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const statuses = await pool.refresh();
for (const status of statuses) {
  const state = status.needsReauth
    ? 'NEEDS RE-AUTH'
    : status.healthy ? 'healthy' : `unreachable (${status.reason ?? 'unknown'})`;
  console.log(`account ${status.accountId}: ${state}`);
}

// Now that every account has logged in, the startup snapshot is meaningful.
// Fire-and-forget: a slow dump must not delay the server accepting requests.
void runDump();

void indexer.scanAll()
  .then((results) => {
    for (const result of results) {
      if (result.error) console.warn(`index ${result.accountId} failed: ${result.error}`);
      else console.log(`index ${result.accountId}: ${result.videos} videos, ${result.subtitles} subtitles, ${result.pruned} pruned`);
    }
    views.refresh();
    watcher.start();
  })
  .catch((err) => console.error('initial index failed:', err instanceof Error ? err.message : err));

enricher.start();

if (config.adminPassword === '') {
  console.warn('WARNING: no admin password set; /admin is unauthenticated. Safe only while bound to loopback.');
}

server.listen(config.port, config.host, () => {
  console.log(`seedrpool listening on http://${config.host}:${config.port}`);
  console.log(`admin:    http://${config.host}:${config.port}/admin`);
  console.log(`manifest: ${config.publicUrl}${addonPath}/manifest.json`);
  console.log(`assets:   ${assets.css.path}  ${assets.js.path}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing`);
    clearInterval(dumpTimer);
    enricher.stop();
    watcher.stop();
    // library.close() checkpoints the WAL (TRUNCATE) before closing, so a
    // restart after OOM or host reboot finds a compact database rather than
    // a dirty WAL.
    server.close(() => { library.close(); process.exit(0); });
    // If a hung keep-alive connection holds the close open, do not wait
    // forever — the container runtime will SIGKILL after its grace period.
    setTimeout(() => { library.close(); process.exit(0); }, 10_000).unref();
  });
}
