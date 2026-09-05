# API reference

SeedrPool exposes two surfaces:

* the **Stremio addon** under `/<addonSecret>/...` (public)
* the **operator console** under `/admin/...` (cookie login at `/admin/login`;
  APIs answer 401 JSON when the session is missing)

## Stremio addon

The addon secret is a URL-safe string, e.g. `OXLwLzaLuh9UJFqVH9SOjaz55awwrAV`. All
addon routes are prefixed with it:

```text
GET /<addonSecret>/manifest.json
GET /<addonSecret>/catalog/<type>/<id>.json
GET /<addonSecret>/catalog/<type>/<id>/<extra>.json
GET /<addonSecret>/meta/<type>/<id>.json
GET /<addonSecret>/stream/<type>/<id>.json
GET /<addonSecret>/subtitles/<type>/<id>.json
GET /<addonSecret>/play/<accountId>/<fileId>
GET /<addonSecret>/logo.png
```

All responses have `Access-Control-Allow-Origin: *` so any Stremio client
can call them.

### `GET /<addonSecret>/manifest.json`

```json
{
  "id": "dev.zayu.seedrpool",
  "version": "0.1.0",
  "name": "SeedrPool",
  "description": "N Seedr accounts → one library",
  "types": ["movie", "series"],
  "resources": ["catalog", "meta", "stream", "subtitles"],
  "idPrefixes": null,
  "catalogs": [
    { "type": "movie", "id": "seedrpool-movies", "name": "SeedrPool Movies" },
    { "type": "series", "id": "seedrpool-series", "name": "SeedrPool Series" }
  ],
  "logo": "https://seedr.zayu.dev/<addonSecret>/logo.png"
}
```

`idPrefixes` is intentionally `null` — the addon does the IMDb id
resolution itself via TMDB. This lets Cinemeta merge with the addon's
metadata for richer detail (cast, crew, runtime, plot).

### `GET /<addonSecret>/catalog/movie/seedrpool-movies.json`

```json
{
  "metas": [
    {
      "id": "tt0118694",
      "type": "movie",
      "name": "In the Mood for Love",
      "year": 2000,
      "imdbRating": 8.1,
      "genres": ["Drama", "Romance"]
    },
    { "id": "tt1727587", "type": "movie", "name": "Sintel", ... },
    ...
  ]
}
```

The `id` field is always an IMDb id (`tt\d+`). Cinemeta fills in the rest.

### `GET /<addonSecret>/meta/movie/tt0118694.json`

```json
{
  "meta": {
    "id": "tt0118694",
    "type": "movie",
    "name": "In the Mood for Love",
    "year": 2000,
    "imdbRating": 8.1,
    "genres": ["Drama", "Romance"],
    "runtime": "1h 38m",
    "cast": ["Tony Leung Chiu-wai", "Maggie Cheung", ...],
    "director": ["Wong Kar-wai"],
    "poster": "https://image.tmdb.org/t/p/w500/...",
    "background": "https://image.tmdb.org/t/p/w1280/...",
    "logo": "https://image.tmdb.org/t/p/w300/...",
    "videos": []
  }
}
```

`meta` returns the SeedrPool-local cache: file counts, accounts it lives
on, copy-link URL. Cinemeta fills the rest (cast, poster, etc.) when
the client requests both. Series support is staged off per the
project's "movie-only" directive; `kind=series` is reserved.

### `GET /<addonSecret>/stream/movie/tt0118694.json`

```json
{
  "streams": [
    {
      "title": "SeedrPool 1080p",
      "name": "In the Mood for Love\n4.28 GiB · OFT\nacc1 · In the Mood for Love 2000 Criterion 1080p BluRay x264-OFT.mkv",
      "url": "https://seedr.zayu.dev/<addonSecret>/play/acc1/5984133767",
      "behaviorHints": {
        "notWebReady": true,
        "filename": "In the Mood for Love 2000 Criterion 1080p BluRay x264-OFT.mkv",
        "bingeGroup": "seedrpool-inthemoodforlove-2000"
      }
    }
  ]
}
```

`url` is a 302 redirect to the Seedr CDN URL. `notWebReady: true` is
set so Stremio's web player (which can't seek into HLS or arbitrary
codecs) hands off to an external player; VLC, MPV, and the iOS / Android
apps all handle the URL.

`bingeGroup` is **per-title** (`seedrpool-<titleKey>`) — not
per-resolution — so 1080p and 720p of the next episode of the same
title both trigger Stremio's auto-play.

### `GET /<addonSecret>/subtitles/movie/tt0118694.json`

```json
{
  "subtitles": [
    {
      "id": "acc1-9984133770",
      "url": "https://seedr.zayu.dev/<addonSecret>/play/acc1/9984133770",
      "lang": "eng"
    }
  ]
}
```

`lang` is the 3-letter OpenSubtitles code (eng, spa, fra, …) parsed from
the subtitle file name. The URL is the same play endpoint, used for
both video and subtitle retrieval.

### `GET /<addonSecret>/play/<accountId>/<fileId>`

Issues a 302 redirect. The target is a fresh `ff_get` URL minted from
Seedr's V1 grant. Lifetime is ~24 h.

If the underlying CDN is unreachable (the "torn reel" case) the
endpoint returns a 302 to the file's HLS playlist from
`presentation_urls.video.hls` instead.

**Rate limited: 30 requests per minute per client.** This is the only
unauthenticated route that mints a real CDN URL, and its path is enumerable —
account ids are `acc1..accN` and Seedr file ids are dense integers — so anyone
holding the manifest URL could otherwise walk the whole library, spending one
Seedr API call per attempt against that account's rate budget. Exceeding the
limit returns `429` with a `Retry-After` header. The budget is a token bucket
that refills continuously, so a burst of stream starts is fine and only a
sustained sweep is refused. The client is identified by `X-Real-IP`, then the
first `X-Forwarded-For` entry, then the TCP peer.

## Operator console (admin)

All `/admin/*` routes require a session cookie, minted by the login page at
`/admin/login` (`POST /admin/login` with `user` + `password`; 12-hour sliding
expiry; `POST /admin/logout` drops it). `/admin/api/*` calls answer
`401 {"ok":false,"error":"Not signed in."}` when the session is missing, so a
client can react instead of parsing HTML. The addon routes and `/healthz` are
unaffected.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin` | overview page |
| GET | `/admin/accounts` | fleet page with per-account health |
| GET | `/admin/library` | library page with per-movie actions |
| GET | `/admin/transfers` | in-flight transfers |
| GET | `/admin/activity` | full transaction history |
| GET | `/admin/transfers/count` | JSON `{ count: N }` polled by the client-side script every 30s |
| GET | `/healthz` | liveness check (200 = ok) |
| POST | `/admin/magnet` | add magnet(s); body `magnet=<url>` (one per line) |
| POST | `/admin/reindex` | trigger full reindex |
| POST | `/admin/accounts/reload` | re-probe every account |
| POST | `/admin/accounts/add` | modal: add account (`email`, `password`) |
| POST | `/admin/accounts/delete` | modal: remove account (`accountId`) |
| POST | `/admin/accounts/purge` | modal: purge account (`accountId`) |
| POST | `/admin/file/delete` | modal: delete file from Seedr + library |
| POST | `/admin/move` | atomic move (`accountId`, `fileId`) |
| POST | `/admin/readd` | re-add from stored magnet (`displayName`) |
| POST | `/admin/transfers/delete` | remove transfer (`accountId`, `transferId`) |
| POST | `/admin/reload` | (alias of `/admin/accounts/reload`) |

Inline actions (those wrapped in `data-inline` in the rendered HTML) do
not perform a full navigation. The client script does a `fetch()` and
replaces the page's `<main>` element. The user sees the change without
a page reload.

### Account lifecycle

```text
                                     ┌────────────────┐
                                     │  credentials   │
                                     │   .txt on disk │
                                     └────────────────┘
                                              ▲
                                              │ append line
                                              │
   operator form submit ──► /admin/accounts/add
                                              │
                                              ▼
                                  Seedr V1 health check
                                              │
                                              ▼
                                  pool.reload() if ok
```

If the health check fails, no write happens. The credential is never
saved in a state Seedr would reject later.

### Move flow

The `Move` action on the library page is **atomic-ish**. Two operations:

1. Re-queue the magnet on a different account.
2. Delete the source file from Seedr.

If step 2 fails after step 1 succeeds, the operator sees a warning in
the activity log: the file is now on **two** accounts, not the intended
one. The duplicates list on the library page surfaces this so the
operator can pick which to delete. This is by design — moving first
guarantees the operator never loses a file by the Move action.
