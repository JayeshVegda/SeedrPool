# SeedrPool — architecture

> Last verified: 2026-09-01

## The problem

A single Seedr.cc account gives you **~6.5 GiB of personal cloud storage** and
the ability to **add magnets** that the Seedr app or web UI will fetch and
expose to a single user. Useful. Limiting.

The same operator with **two or more accounts** (the kind of person who has
a personal account, a shared one, and a "testing" account) is forced
into a choice: pick one, juggle Stremio addons, or manually copy the
manifest.json URL every time. The seedr.zayu.dev deploy runs with **8
accounts and ~52 GiB**, but the architecture itself imposes no upper
bound — the pool is a Map of arbitrary size, the rate limiter is per
account, and the indexer / transfer-watcher run at a fixed cadence
regardless of pool size. 8 is a deployment choice, not a hard limit.

The seedr.zayu.dev deploy is a working example: 8 Seedr accounts,
~52 GiB, one operator (Jay) and a tiny friend circle.

## Constraints (verified in `RESEARCH.md`)

These are the hard facts the design must respect:

1. **No Stremio support for multi-account pools.** The Stremio addon protocol
   is built around the assumption that one addon serves one library. There is
   no native way to expose "N accounts behind one URL". SeedrPool must
   pretend to be a single account.

2. **Each Seedr account has independent storage and quota.** Movies you add
   to `acc1` only live in `acc1`. There is no cross-account copy mechanism on
   the Seedr side. SeedrPool must run an indexer that walks all accounts and
   merges their contents into a single in-memory library.

3. **Seedr's API is rate-limited and not designed for server use.** Every
   call costs against a per-account quota. The default `client_id` (`seedr_test`)
   is rate-limited to almost nothing. SeedrPool uses `client_id=seedr_chrome`
   to get a usable budget. The transfer-watcher polls every N seconds
   per account, with a 250 ms token-bucket between requests. At 50 accounts
   that's one request per N seconds × 50 — well inside Seedr's
   per-client quota.

4. **Stremio and Seedr speak different identities.** Stremio asks for `tt…`
   (IMDb). Seedr returns internal `folder_id`, `file_id`, and `transfer_id`.
   The mapping is a private contract: SeedrPool's library DB.

5. **The "v1 password grant" is the only viable auth path** in 2026. The
   v2 device-flow flow requires per-user browser approval and the v2 client
   id is gated; v2 tokens are accepted as a fallback for legacy reasons but
   v2 is effectively dead for new deployments.

## What SeedrPool does

A single Node process that:

* Listens on a configurable port.
* Exposes a Stremio addon manifest at `/<secret>/manifest.json` declaring
  catalogs, meta, stream, and subtitles resources for `kind=movie` and
  `kind=series`.
* Exposes a basic-auth admin UI at `/admin` for adding/removing accounts,
  purging an account, viewing the library, transfers, and the operator
  activity log.
* On boot, probes every account (V1 password grant) and reports the
  result. Then scans each account's folder tree, extracting a stable
  title key from the file name. The same file on two accounts maps to the
  same title.
* Polls each account every 30 seconds for transfer-list changes. When a
  transfer disappears from the list, the indexer re-scans that account.
* Runs a background metadata enricher (TMDB) on a 30-minute timer, hooked
  to the indexer so a new file gets an IMDb id within seconds of finishing
  download, not on the next 30-minute poll.
* Uses the Seedr V1 password grant to mint playback URLs. When Seedr's CDN
  serves a fresh `ff_get` URL, the operator gets it directly. When Seedr's
  CDN 404s (the `rd12.seedr.cc` and similar CDN pool that does not serve
  some accounts), the addon probes with a 128-byte range request and
  falls back to the file's HLS playlist from `presentation_urls.video.hls`.

## System map

![Architecture](architecture.svg)

The single diagram (kept inline to render in any markdown viewer) shows
the three tiers:

* **Stremio** — one client process, one user. Speaks IMDb and the
  Stremio addon protocol.
* **SeedrPool** — the Node process this repository contains. Speaks Stremio
  to clients, speaks Seedr V1 to accounts. The middle of the diagram
  shows the four endpoints: `manifest.json`, `catalog`, `stream`,
  `meta` + `subtitles`, plus the indexer.
* **Seedr pool** — N Seedr accounts, each with ~6.5 GiB. The
  `library.sqlite` (WAL) sits underneath the SeedrPool process, holding
  the merged index.

The dotted `acc4` line in the pool is a "torn reel" — Seedr's CDN returns
  404 for that account's direct-download URLs. The library is still
  browsable, but `play` falls back to the HLS playlist.

## The library DB (file → IMDB mapping)

```text
titles       (key, name, year, kind, added_at, imdb_id, tmdb_id)
files        (file_id, account_id, folder_id, name, size, hash,
             title_key, season, episode, resolution, group,
             seen_at, magnet)
subtitles    (file_id, account_id, folder_id, name, language,
             seen_at)
magnets      (display_name, magnet, account_id, added_at)
activity    (id, at, kind, message, detail)
```

`title_key` is a normalized file-name key (lower-cased, separators collapsed,
year inlined for non-series). It is the join key between `files` and
`titles`. The same `title_key` on two accounts = one title in the catalog.

`magnet` is a denormalization cache: when a magnet was added, the URL is
stored on the file so the operator can re-add it from the library page
without re-pasting. The transfer-watcher also reads it to detect "torn
reel" recovery.

## Project layout (this repository)

```text
src/
  addon/        Stremio addon endpoints (manifest, catalog, meta,
                stream, subtitles, play) — IMDb id identity
  admin/        basic-auth operator console
  core/         pool, watcher, router, rate-limiter, config,
                credentials, token-store, types
  library/      indexer, parser, store, enricher, TMDB client
  providers/    seedr-v1 (the only viable path), seedr-v2 (legacy)
  index.ts      wiring: pool, indexer, enricher, watcher, router, server

tests/         mirrors src/ subdirs; 246 tests across 15 files
docs/          research notes, this file, INSTALL, OPERATIONS, API
assets/        logo, architecture diagram (inline SVG, no scripts)
.github/       CI workflow (typecheck + tests)
```

## Out of scope

* **Torrent search / discovery.** Operators add magnets by URL. The
  operator who built this deliberately does not want a torrent search
  engine in their library.
* **Cross-account dedup via copying.** If the same content lives on
  acc1 and acc2, SeedrPool shows one catalog entry with two stream
  candidates. It does not copy the file between accounts to free up
  space. (It does provide a "purge" action on the fleet page that deletes
  the Seedr-side file and the library row for one account.)
* **Token rotation and v2 onboarding.** v2 device flow is a vestigial
  path that exists only for the legacy token-store; new deployments
  use v1 exclusively.
