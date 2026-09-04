# Change log

All notable changes to SeedrPool are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

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
