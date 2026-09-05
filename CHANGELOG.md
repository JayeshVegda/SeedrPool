# Change log

All notable changes to SeedrPool are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## 0.3.2 — 2026-09-04

### Added

* **A real readiness check.** `/healthz` used to be a hardcoded `'ok'` — a
  liveness probe that proved the event loop existed and nothing else. A dead
  database, a pool with every account offline, an indexer dead for a day:
  all answered 200. It now grades four subsystems (database, pool, indexer
  freshness, enricher) and answers 503 when any of them is bad, so an uptime
  monitor or `docker compose ps` actually sees the failure. Warn does not
  fail the probe — a pool at 25% healthy or a stale index still serves
  traffic, and restarting the container over it would make things worse.
* **`/admin/health`** renders the same checks for a human. It previously
  returned `transferCount()` — a copy-paste leftover answering `{"count":N}`
  to anything expecting a health document. One grading definition, two
  consumers.
* Crash guards: `unhandledRejection` / `uncaughtException` handlers
  installed before anything else runs. One stray rejected promise from a
  background timer used to kill the process silently; Docker restarted it
  and mid-download state died with no trace. Fatal errors now also land in
  the activity log, the one place the operator reads.

### Fixed

* **The metadata enricher retried unmatched titles forever.** A title TMDB
  can never match — a typo in a release name, an obscure regional cut — was
  re-queried every 30 minutes for the life of the process, burning quota and
  log lines, and since unmatched titles are invisible to Stremio, invisible
  forever. Lookups now cap at 3 attempts (`ENRICH_MAX_ATTEMPTS`), a warning
  with the recovery path lands in the activity log on the crossing attempt,
  and the library row's "re-fetch" button resets the counter. A transport
  error (TMDB 429, network blip) does not consume an attempt — a burst of
  rate limits used to be able to permanently give up on titles that were
  never actually looked at.
* **`allocate(0)` could place a 4 GB file on an account with 10 MB free.**
  `moveFile` now passes the file's actual size (and the 409 error names the
  size it needed), and `reAddMagnet` passes the size summed from the magnet's
  previously indexed files. The transfer no longer sits at 0% forever on an
  account that never had room.
* **The WAL grew without bound.** Only `journal_mode` was set; no
  autocheckpoint, no busy timeout, nothing on shutdown. Production measured
  407 KB of WAL against a 72 KB database within a day. Now: `busy_timeout`
  5 s (a restart race waits instead of throwing SQLITE_BUSY),
  `wal_autocheckpoint` 512 pages, and `close()` runs
  `wal_checkpoint(TRUNCATE)` so a restart after OOM or host reboot finds a
  compact database.
* **The manifest reported version 0.1.0** while the shipped version had
  moved past 0.3 — hardcoded in `addon/app.ts`, drifting from package.json,
  so Stremio's addon list displayed a version nobody was running. The
  manifest now reads package.json through `resolveJsonModule`.
* `formatBytes` existed twice — server said "4.00 GiB", a client toast said
  "4.3 GB" for the same number. The server now serializes its own
  implementation into the page and the client prefers it.
* Purge failures now say why. "3 failed" carried no reason; the report and
  toast include one line per distinct refusal.
* SIGTERM: the enricher is stopped, and a hung keep-alive connection no
  longer holds shutdown open past 10 s.

## 0.3.1 — 2026-09-04

### Security

* **Rate-limited `/{secret}/play/:accountId/:fileId`** at 30 requests per
  minute per client. It is the only route that must stay unauthenticated —
  Stremio's player cannot send a basic-auth header — and it is also the only
  one that mints a real Seedr CDN URL. The path is enumerable (`acc1..accN`
  plus dense integer file ids), so anyone holding the manifest URL could walk
  the entire library, spending one Seedr API call per attempt against that
  account's rate budget. A token bucket rather than a fixed window, so a burst
  of stream starts still works and only a sustained sweep is refused. The
  tracked-client map is capped to bound memory, since an unauthenticated
  endpoint keyed by address is otherwise a memory-exhaustion vector.
* The peer address header the limiter falls back to is stripped from inbound
  requests before routing, so a client cannot spoof its own identity.

### Removed

* **The V2 provider, its device-flow onboarding, and the rotating token
  store** — about 950 lines that could not run. Seedr refuses new
  authorizations for the public client id, which RESEARCH.md has documented
  since 0.1.0, so this was dead weight that would mislead anyone debugging
  auth. `makeQuota` moved to `providers/shared.ts`, where the V1 provider
  already imported it from. `describeError` and `retryAfterSeconds` had no
  remaining callers and went with it, as did the now-unused
  `seedrRateLimiter` singleton and the `SEEDRPOOL_TOKEN_PATH` config.

  Removing this drops 4 test files whose only subject was the deleted code.
  Net test count is up (362 from 389 minus 51 V2-only tests, plus 24 new).

## 0.3.0 — 2026-09-04

### Fixed

* **Every toast in the admin console was silently dead.** The page imported
  sonner-js as `import { toast }`, but the bundle only has a *default*
  export, so the module threw a SyntaxError, `window.toast` was never
  assigned, and all feedback degraded to `console.log`. Add, delete, purge,
  reindex, and dump were all reaching the server and reporting correctly;
  nothing was rendered. Now imported as a default export.
* **Every modal and every confirm-gated destructive action was dead.**
  Alpine's bundle ends with `queueMicrotask(() => Alpine.start())`, and the
  microtask queue drains between deferred scripts — so with Alpine loaded
  before `client.js`, `alpine:init` had already fired before the listener was
  installed. `Alpine.store('modals')` never registered, `$store.modals` was
  undefined, and Add account, Update password, Purge and Remove threw on
  click. The client script now loads first and also copes with Alpine having
  already started.
* **Purge left in-flight torrents running.** A downloading torrent lives in
  Seedr's `torrents` list, not the folder tree, so it survived the purge and
  re-created its folder minutes later — making the purge look like it had
  silently failed. Transfers are now cancelled first, then folders and files
  swept, and the count is reported separately.
* **Deleting an account corrupted the library index.** Ids are positional, so
  removing acc2 renumbered acc3 to acc2 while the `files` table still stored
  the old ids — every row below the deleted account was reattributed to a
  different Seedr account. Deletion now writes a `#deleted accN` tombstone
  that holds the slot, and `addAccount` takes the next free slot rather than
  `accounts.length + 1`.
* **A fabricated free-space figure was sent to the client.** The magnet
  ingest response carried `freeAfter: Number.MAX_SAFE_INTEGER` behind a
  comment calling it a "best-effort placeholder", and the client rendered it
  as if measured. It is now the real quota, or `null` when Seedr will not say.
* **CRUD failures answered HTTP 200** with `{ok:false}`, so a proxy error
  page or an auth challenge was indistinguishable from success. Failures now
  carry a real status: 400 bad input, 404 unknown target, 409 no capacity,
  502 Seedr refused. The client trusts the status first.
* **A confirmed action reloaded the page 900 ms later**, destroying the toast
  the user was meant to read — the exact failure the JSON-action path was
  built to fix. The affected row is now removed in place and live regions
  repoll.
* Toasts fired before sonner finished loading are queued instead of dropped.
* `htmx:responseError` no longer double-reports a JSON failure that
  `htmx:afterRequest` has already surfaced with the server's own message.

### Changed

* **htmx, Alpine, and sonner-js are vendored and served from our own origin**
  through the content-hashed asset pipeline, instead of being fetched from
  jsDelivr at runtime with no SRI and no fallback. A blocked CDN previously
  left the console with zero interactivity and no indication why.
* **All mutations live in `core/admin-actions.ts`.** File, transfer, move, and
  re-add handlers were on `admin/app.ts` next to the HTML rendering; the two
  halves had drifted apart on error reporting. `admin/app.ts` renders,
  `admin-actions.ts` mutates.
* `moveFile` reports `sourceDeleted` and the reason when the source copy
  could not be removed, rather than leaving a silent duplicate behind.
* A dump that wrote nothing at all now answers 502 instead of reporting
  success.

### Added

* `tests/core/admin-actions.test.ts`: 46 tests covering purge, delete, add,
  file delete, transfer cancel, magnet ingest, move, re-add, reindex, dump,
  and reload — asserting both the effect and the HTTP status. There was no
  test coverage for any of these handlers before.
* Credentials tests for the tombstone format and a `writeCredentials`
  round-trip through a real file.
* Asset tests asserting the vendored bundles are present, that sonner's
  export is default, and that the script order cannot regress.

## 0.2.0 — 2026-09-02

### Changed

* **Removed the implicit "8 accounts" cap.** The pool, indexer,
  transfer-watcher, and rate-limiter were already N-account clean. This
  release drops the UI-side caps (`MAX_TITLE_KEYS_IN_LIB` removed,
  signal bar now `auto-fit minmax(140px, 1fr)` instead of `repeat(N, ...)`,
  catalog `limit` 500 → 1000, activity log query 500 → 1000) and updates
  every doc and the architecture diagram to talk about "N accounts" and
  "configurable storage" instead of "8 accounts" and "52 GiB".
* `STREAM_LIMIT_PER_ACCOUNT` raised from 3 to 5, with a docstring that
  explains the heuristic and how to raise it freely for larger pools
  (Seedr's CDN is what actually rate-limits).
* New `tests/core/account-pool.test.ts › scales to N accounts` block:
  50-account pool, allocator fairness across 50 entries, transfer-list
  fan-out. The seedr.zayu.dev test config is unchanged; the new block is
  a layer of assurance for the deployment flexibility.

## 0.1.0 — 2026-09-01

### Added

* Stremio addon serving movies and series from a multi-account Seedr
  pool. IMDb id identity; catalog / meta / stream / subtitles endpoints.
* Operator console at `/admin` (basic-auth). Five pages: overview, library,
  transfers, fleet, activity.
* Account lifecycle: add (probes Seedr before saving), remove, purge
  (walks every Seedr folder/file, deletes library rows).
* Library page with TMDB poster, Stremio deep link, copy-link button,
  Move (atomic re-queue + delete), and Delete (per file).
* Indexer: walks every account's folder tree, normalizes names to
  `title_key`, joins to `titles`, runs every 30 s.
* Metadata enricher: TMDB lookup, hooks the indexer so a new file gets
  an IMDb id within seconds of finishing download, runs on a 30-min
  safety-net timer.
* Transfer watcher: detects when a Seedr transfer disappears, triggers
  a per-account reindex + enrich + activity log entry.
* CDN-health quarantine: 30-min "torn reel" mark after a `ff_get` 404;
  HLS fallback via `presentation_urls.video.hls`.
* Activity log: every operator-actionable event, capped at 500 rows,
  filterable by account, kind, and time range.
* Sonner toasts and Lucide icons loaded from jsDelivr at runtime. No
  build step for the operator console.
* Multi-magnet paste on the overview page (one per line).
* Inline form actions via the `data-inline` attribute — no full page
  navigation on the operator console.
* 246 tests across 15 files, organized by `src/` subdir.

### Security

* Addon secret is a single URL-safe string, never logged.
* Basic-auth on `/admin/*` is the only access control on the operator
  console. The Caddy reverse proxy is expected to provide a second
  layer.
* `timingSafeEqual` for the basic-auth credential comparison.
* `dompurify`-style HTML escaping on every interpolated value in
  `src/admin/html.ts` — no unescaped user data ever reaches the page.
* The `.secrets/` directory is mounted read-only into the container.
