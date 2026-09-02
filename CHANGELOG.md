# Change log

All notable changes to SeedrPool are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

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
