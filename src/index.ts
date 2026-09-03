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
import { buildAdminAssets } from './core/assets.ts';
import { STYLES_BODY, layout } from './admin/html.ts';
import { type AccountStatus } from './core/account-pool.ts';
import { NoCapacityError } from './core/account-pool.ts';
import { magnetDisplayName } from './admin/magnet-name.ts';

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
const indexer = new Indexer(library, () => pool);
const tmdb = new TmdbClient(config.tmdbApiKey);
const enricher = new MetadataEnricher(library, tmdb);
const addon = new AddonApp(library, () => pool, config);
const watcher = new TransferWatcher(() => pool, indexer);
const views = new AdminViews(() => pool, library);

const dumper = new Dumper({ directory: config.dumpsDir });
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
  cssPath: assets.css.path,
  jsPath: assets.js.path,
  runDump,
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
    if (name === assets.css.path.split('/').pop()) return serveAsset(assets.css, ctx.request);
    if (name === assets.js.path.split('/').pop())  return serveAsset(assets.js,  ctx.request);
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
  .get('/admin/health', () => admin.transferCount())
  .get('/healthz', () => new Response('ok'))

  // ---- JSON action endpoints (item 9: rich toasts, no page replacement) ----
  .post('/admin/api/magnet', (ctx) => actions.addMagnet(ctx))
  .post('/admin/api/account/add', (ctx) => actions.addAccount(ctx))
  .post('/admin/api/account/delete', (ctx) => actions.deleteAccount(ctx))
  .post('/admin/api/account/purge', (ctx) => actions.purgeAccount(ctx))
  .post('/admin/api/account/reauth', (ctx) => actions.reauthAccount(ctx))
  .post('/admin/api/transfer/delete', (ctx) => admin.deleteTransfer(ctx))
  .post('/admin/api/move', (ctx) => admin.moveFile(ctx))
  .post('/admin/api/file/delete', (ctx) => admin.deleteFile(ctx))
  .post('/admin/api/readd', (ctx) => admin.reAddMagnet(ctx))
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
  .get(`${addonPath}/play/:accountId/:fileId`, (ctx) => addon.play(ctx))
  .get(`${addonPath}/poster/:key`, (ctx) => addon.poster(ctx), { cors: true })
  .get(`${addonPath}/logo.png`, () => addon.logo(), { cors: true });

// Compatibility shim for any client that hits the old direct-download paths.
router.post('/admin/file/delete', (ctx) => admin.deleteFile(ctx));
router.post('/admin/file/url', (ctx) => addon.fileUrl(ctx));
router.get('/admin/file/download', (ctx) => addon.fileDownload(ctx));
router.post('/admin/magnet', (ctx) => actions.addMagnet(ctx));
router.post('/admin/reindex', () => actions.reindex());
router.post('/admin/readd', (ctx) => admin.reAddMagnet(ctx));
router.post('/admin/move', (ctx) => admin.moveFile(ctx));
router.post('/admin/dump', () => actions.runDump());
router.post('/admin/accounts/reload', () => actions.reload());
router.post('/admin/accounts/add', (ctx) => actions.addAccount(ctx));
router.post('/admin/accounts/delete', (ctx) => actions.deleteAccount(ctx));
router.post('/admin/accounts/purge', (ctx) => actions.purgeAccount(ctx));
router.post('/admin/transfers/delete', (ctx) => admin.deleteTransfer(ctx));

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers: req.headers as Record<string, string>,
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
    watcher.stop();
    server.close(() => { library.close(); process.exit(0); });
  });
}
