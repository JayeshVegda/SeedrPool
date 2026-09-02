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
import { Router, htmlResponse, redirect, requireBasicAuth } from './core/router.ts';
import { AdminApp, buildPoolEntries } from './admin/app.ts';
import { LibraryStore } from './library/store.ts';
import { Indexer } from './library/indexer.ts';
import { MetadataEnricher } from './library/metadata-enricher.ts';
import { TmdbClient } from './library/tmdb.ts';
import { AddonApp } from './addon/app.ts';
import { TransferWatcher } from './core/transfer-watcher.ts';
import { Dumper } from './core/dumper.ts';

const config = await loadConfig();

let credentials = await loadCredentials(config.credentialsPath);

if (credentials.accounts.length === 0) {
  console.warn(
    `WARNING: no accounts in ${config.credentialsPath}. ` +
      'Add one "email:password" per line, then reload from /admin/accounts.',
  );
}
for (const problem of credentials.problems) {
  console.warn(`credentials line ${problem.line}: ${problem.reason}`);
}

/**
 * The pool is rebuilt rather than mutated when accounts change, so an appended
 * credential line is usable without a restart.
 */
let pool = new AccountPool(buildPoolEntries(credentials));
let library = new LibraryStore(config.databasePath);
const indexer = new Indexer(library, () => pool);
const tmdb = new TmdbClient(config.tmdbApiKey);
const enricher = new MetadataEnricher(library, tmdb);
const addon = new AddonApp(library, () => pool, config);
const watcher = new TransferWatcher(() => pool, indexer);

// When the indexer writes a new title without an IMDb id, fire an
// immediate enricher tick. This is the missing link that was letting
// fresh magnets sit un-indexed for up to 30 minutes between polls.
// The hook is fire-and-forget so a slow TMDB response never blocks the
// next scan; the periodic poll remains as a safety net for any titles
// the search missed (e.g. obscure releases, transient TMDB errors).
indexer.setOnScanComplete(async () => {
  await enricher.tick();
});

// When the watcher notices a torrent finished, it reindexes the affected
// account and then runs the enricher immediately. The result: a finished
// download gains an IMDb id within seconds, not the next 30-minute tick.
watcher.setOnCompletion(
  async (enr, accountId, finished) => {
    for (const id of finished) {
      library.recordActivity(
        'success',
        `Transfer completed on ${accountId}`,
        id,
      );
    }
    await enr.tick();
  },
  enricher,
);

async function rebuildPool(): Promise<void> {
  credentials = await loadCredentials(config.credentialsPath);
  pool = new AccountPool(buildPoolEntries(credentials));
  admin.setCredentials(credentials);
  // Force a probe: the operator pressed reload precisely to see fresh state.
  await pool.refresh({ force: true });
  // Rescanning is a fire-and-forget response to keep the page snappy.
  void indexer.scanAll();
}

const admin = new AdminApp(
  () => pool, config, credentials, rebuildPool, library, indexer, enricher,
  () => dumper.dump(pool).then((r) => r),
);

const addonPath = `/${config.addonSecret}`;

// Periodic per-account JSON dumper. Each run writes one file per account
// to `data/dumps/<accountId>.<unixMs>.json`; the Dumper prunes the
// rest. Operators can read the latest dump via `cat data/dumps/acc1.*.json`
// without hitting Seedr.
const dumper = new Dumper({ directory: config.dumpsDir });
const DUMP_INTERVAL_MS = 6 * 60 * 60_000; // 6h
async function runDump(): Promise<{ written: string[]; errors: string[] }> {
  try {
    const { written, errors } = await dumper.dump(pool);
    if (written.length > 0) {
      console.log(
        `dump: wrote ${written.length} file${written.length === 1 ? '' : 's'}` +
        (errors.length > 0 ? `, ${errors.length} error${errors.length === 1 ? '' : 's'}` : ''),
      );
    }
    if (errors.length > 0) {
      for (const e of errors) console.warn(`dump: ${e}`);
    }
    return { written, errors };
  } catch (err) {
    console.warn('dump: failed:', err instanceof Error ? err.message : err);
    return { written: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}
await runDump();
const dumpTimer = setInterval(() => { void runDump(); }, DUMP_INTERVAL_MS);
dumpTimer.unref();

const router = new Router()
  .get('/', () => redirect('/admin'))
  .get('/admin', () => admin.overview())
  .get('/admin/accounts', () => admin.accounts())
  .post('/admin/accounts/reload', () => admin.reloadAccounts())
  .post('/admin/accounts/add', (ctx) => admin.addAccount(ctx))
  .post('/admin/accounts/delete', (ctx) => admin.deleteAccount(ctx))
  .post('/admin/accounts/purge', (ctx) => admin.purgeAccount(ctx))
  .get('/admin/library', () => admin.library())
  .get('/admin/transfers', () => admin.transfers())
  .get('/admin/transfers/count', () => admin.transferCount())
  .post('/admin/transfers/delete', (ctx) => admin.deleteTransfer(ctx))
  .get('/admin/activity', (ctx) => admin.activity(ctx))
  .post('/admin/file/delete', (ctx) => admin.deleteFile(ctx))
  .post('/admin/file/url', (ctx) => addon.fileUrl(ctx))
  .get('/admin/file/download', (ctx) => addon.fileDownload(ctx))
  .post('/admin/dump', () => admin.dumpNow(runDump))
  .get('/admin/dumps', () => admin.dumps())
  .post('/admin/magnet', (ctx) => admin.addMagnet(ctx))
  .post('/admin/reindex', () => admin.reindex())
  .post('/admin/readd', (ctx) => admin.reAddMagnet(ctx))
  .post('/admin/move', (ctx) => admin.moveFile(ctx))
  .get('/healthz', () => new Response('ok'))
  // Stremio routes: all carry CORS, all live under the unguessable secret
  // segment so they get no basic auth.
  .get(`${addonPath}/manifest.json`, () => addon.manifest(), { cors: true })
  .get(`${addonPath}/catalog/:type/:catalogId.json`, (ctx) => addon.catalog(ctx), {
    cors: true,
  })
  .get(`${addonPath}/catalog/:type/:catalogId/:extra.json`, (ctx) => addon.catalog(ctx), {
    cors: true,
  })
  .get(`${addonPath}/meta/:type/:id`, (ctx) => addon.meta(ctx), { cors: true })
  .get(`${addonPath}/stream/:type/:id`, (ctx) => addon.stream(ctx), { cors: true })
  .get(`${addonPath}/subtitles/:type/:id`, (ctx) => addon.subtitles(ctx), { cors: true })
  .get(`${addonPath}/play/:accountId/:fileId`, (ctx) => addon.play(ctx))
  .get(`${addonPath}/poster/:key`, (ctx) => addon.poster(ctx), { cors: true })
  .get(`${addonPath}/logo.png`, () => addon.logo(), { cors: true });

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;

  // Node's IncomingMessage is not a WHATWG Request, so adapt it.
  const body =
    req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers: req.headers as Record<string, string>,
    ...(body !== undefined ? { body } : {}),
  });

  let response: Response;
  try {
    // The Stremio addon (under the unguessable secret segment) and the health
    // check are public. Everything else sits behind basic auth.
    const path = new URL(url).pathname;
    const isPublic = path === '/healthz' || path.startsWith(addonPath);
    const challenge = isPublic
      ? null
      : requireBasicAuth(request, config.adminUser, config.adminPassword);

    response = challenge ?? (await router.handle(request));
  } catch (err) {
    console.error('request failed:', err instanceof Error ? err.message : err);
    response = htmlResponse('<h1>500</h1><p>Internal error.</p>', { status: 500 });
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

// Probe accounts at startup so a broken token chain is visible immediately
// rather than when someone presses play.
const statuses = await pool.refresh();
for (const status of statuses) {
  const state = status.needsReauth
    ? 'NEEDS RE-AUTH'
    : status.healthy
      ? 'healthy'
      : `unreachable (${status.reason ?? 'unknown'})`;
  console.log(`account ${status.accountId}: ${state}`);
}

// Initial library scan after accounts are healthy. A failure here should not
// stop the server — the admin can manually trigger a reindex.
void indexer
  .scanAll()
  .then((results) => {
    for (const result of results) {
      if (result.error) {
        console.warn(
          `index ${result.accountId} failed: ${result.error}`,
        );
      } else {
        console.log(
          `index ${result.accountId}: ${result.videos} videos, ` +
            `${result.subtitles} subtitles, ${result.pruned} pruned`,
        );
      }
    }
    // Start the transfer watcher only after the initial scan, so the first
    // poll's "active id set" is the steady state rather than the post-startup
    // transient.
    watcher.start();
  })
  .catch((err) => {
    console.error('initial index failed:', err instanceof Error ? err.message : err);
  });

// Background metadata enrichment runs on its own schedule, independently of
// the indexer. New titles are picked up at the next tick (~30 min), or by a
// manual reindex, since the reindex button does both.
enricher.start();

if (config.adminPassword === '') {
  console.warn(
    'WARNING: no admin password set; /admin is unauthenticated. ' +
      'Safe only while bound to loopback.',
  );
}

server.listen(config.port, config.host, () => {
  console.log(`seedrpool listening on http://${config.host}:${config.port}`);
  console.log(`admin:    http://${config.host}:${config.port}/admin`);
  console.log(`manifest: ${config.publicUrl}${addonPath}/manifest.json`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing`);
    clearInterval(dumpTimer);
    watcher.stop();
    server.close(() => {
      library.close();
      process.exit(0);
    });
  });
}
