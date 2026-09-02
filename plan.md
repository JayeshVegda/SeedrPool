# SeedrPool Plan

Phase 0 is complete. Findings are recorded in `RESEARCH.md` and several of them
changed this plan. Read `RESEARCH.md` before implementing anything here.

## What changed after research

* Seedr **V1 password grant** is the authentication path. V2 works technically,
  but Seedr now refuses new device authorizations for the only client id available
  to us, and there is no developer portal to register our own. This reverses the
  original decision; see `RESEARCH.md`.
* V1 tokens last ~30 days and re-login is **idempotent**, so there is no fragile
  rotating chain. Accounts come from an `email:password` file — no browser
  approval, no onboarding UI.
* Playback uses direct original-file URLs (`ff_get`), not HLS. The 360p free-tier
  cap applies only to Seedr's web player, so quality is not limited. Identical on
  V1 and V2.
* `ff_get` URLs expire in ~24 h, so stream URLs are minted per playback.
* Streaming concurrency is **2 reads per signed URL**, not per account. Minting
  per playback removes the constraint entirely.
* Torrent/search discovery is **dropped**. Magnets are added manually.
* Real pool size is **52 GiB across 8 accounts**, not 24 GB or 36 GiB.
* The V1 magnet field is `magnet`. `torrent_magnet` returns 404 in the body and
  silently files to the wishlist in the query string.

---

## Phase 0 — Research ✅

* [x] Verify current Seedr API + authentication
* [x] Verify storage/file/download/delete/playback APIs
* [x] Verify Seedr account limitations
* [x] Research current Seedr → Stremio projects
* [x] Research current Stremio addon protocol
* [x] Research subtitle approach
* [x] Record findings in `RESEARCH.md`
* [x] Finalize architecture

Deferred to Phase 4, needs a real Stremio client:

* [ ] Does `notWebReady` need to be `true` for `application/octet-stream`?
* [ ] How many parallel connections does a client open per stream URL?

Measured after Phase 2:

* [x] Streaming concurrency — 2 reads per signed URL; 12 concurrent reads on one
      account succeeded across 6 minted URLs

---

## Phase 1 — Core and providers ✅

* [x] TypeScript / Node LTS / pnpm project
* [ ] SQLite schema and migrations
* [x] Config loading, credentials from
      `/opt/stacks/.secrets/seedrpool-credentials.txt`
* [x] `TokenStore`: atomic write-then-rename, single writer (V2 only; V1 needs no
      such care)
* [x] `StorageProvider` interface
* [x] `SeedrV2Provider`: device flow, proactive refresh, quota, listing, magnet
      add, task polling, URL minting, delete — retained but unused
* [x] `SeedrV1Provider`: password login, quota, listing, magnet add, transfers,
      URL minting, delete
* [x] Account health and rejected-credential state
* [x] Tests (137 unit tests + `scripts/verify-live.ts` against all 8 accounts)

**Goal:** talk to one account reliably. ✅

Zero runtime dependencies: `fetch` and `node:sqlite` are both built into Node 24.

---

## Phase 2 — Account pool ✅

* [x] `AccountPool` over N providers
* [x] Per-account capacity and health tracking
* [x] Best-fit allocation for new content
* [x] Placement spreads streams as a fairness heuristic (not a 429 constraint —
      concurrency is per signed URL)
* [x] Failover when an account is unhealthy
* [x] Shared rate limiter with escalating cooldown, per client id
* [x] All 8 accounts onboarded and healthy
* [ ] Treat playback HTTP 429 as "mint a new URL", not an error — needs the
      addon's playback path (Phase 4)

**Goal:** eight accounts behave as one 52 GiB pool. ✅

---

## Phase 3 — Unified library

* [ ] Scan all accounts (`is_video` filters media; no extension matching needed)
* [x] Filename parsing: title, year, season, episode, resolution, release group
      (`src/library/parse.ts`)
* [ ] Movie/TV classification
* [ ] Metadata matching to IMDB IDs so Stremio's Cinemeta supplies artwork
* [ ] Unified library across accounts
* [ ] Duplicate detection via Seedr's SHA-1 `hash`
* [ ] Search
* [ ] Initial index of everything already in every account

**Goal:** one library; the account holding a file is invisible to users.

---

## Phase 4 — Stremio addon

* [ ] `/manifest.json` with CORS allowing all origins on every route
* [ ] Catalog
* [ ] Meta for SeedrPool-native IDs (`tt` IDs fall through to Cinemeta)
* [ ] Streams pointing at an internal `/play/...` endpoint
* [ ] Playback redirect that mints a fresh `ff_get` URL per request
* [ ] `behaviorHints`: `filename`, `videoSize`, `bingeGroup`, and
      `notWebReady` once measured
* [ ] Subtitles from Seedr sidecar files (e.g. `.en.srt`) in the same folder
* [ ] Verify end-to-end playback at 1080p in a real Stremio client

**Goal:** install one addon, press play, it plays.

---

## Phase 5 — Downloads

* [ ] Magnet input
* [ ] Account selection with the reason recorded
* [ ] Task polling with a stall timeout
* [ ] Dead-magnet detection via seeder count (a dead magnet sits at
      `progress: 0` forever rather than erroring)
* [ ] Automatic indexing on completion
* [ ] Failed and paused task cleanup

**Goal:** paste a magnet, the pool picks an account, it appears in the library.

---

## Phase 6 — Storage intelligence

* [ ] Best-fit allocation refinement
* [ ] Automatic eviction when space is needed
* [ ] Pin/protect flag, never auto-removed
* [ ] Eviction scoring: failed/temp → duplicates → never watched → least
      recently watched
* [ ] Duplicate removal preferring the better release
* [ ] Dry-run preview of what eviction would remove

**Goal:** the pool behaves as one intelligent 52 GiB cache.

---

## Phase 7 — Admin and production ✅ (mostly)

* [x] Admin page: magnet input, transfers with seeder counts, per-account cards,
      live library table, pool totals, account reload
* [ ] Library pin/delete and eviction preview — needs Phase 3 and 6
* [x] Server-rendered, no SPA build step, to keep RAM low
* [x] Basic auth on `/admin` (constant-time compare)
* [x] Unguessable path segment for the addon manifest (persisted; must never
      change or friends must reinstall)
* [x] Docker deployment, 256 MiB limit
* [x] Caddy route for `seedr.zayu.dev`
* [x] Exclude from Watchtower
* [ ] Operations documentation

**Deployment target:** this VPS. Metabase was stopped to make room; see
`RESEARCH.md`.

---

## Security posture

* The addon must be publicly reachable for friends' Stremio clients to load it.
  The protocol has no authentication, so an unguessable path is the only
  protection. **Anyone holding that URL can browse and stream the library.**
  Accepted knowingly.
* `/admin` is behind basic auth over HTTPS. Credentials live in
  `/opt/stacks/.secrets/`, never in the repo.
* Seedr account **passwords** and tokens stay server-side. They must never appear
  in logs, the admin HTML, error messages, addon responses, or stream URLs handed
  to clients. A test asserts the password never reaches an error message.
* The credentials file is append-only: ids are positional and the library index
  stores them.

---

## Future

Only after the core works:

* external subtitle providers (OpenSubtitles, SubDL, SubSource)
* watch history and better eviction scoring
* smarter release preference on duplicates
* additional storage providers behind `StorageProvider`
* torrent discovery, if manual magnets ever become tiresome
