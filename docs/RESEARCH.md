# SeedrPool Research

This file records verified technical findings.

## Rules

Prioritize:

1. Official documentation
2. Official/current GitHub repositories
3. GitHub issues
4. Reddit/community reports
5. Other sources

For important findings record:

* date
* source
* finding
* confidence
* implementation impact

Findings marked **measured** were reproduced against a live free Seedr account
on this VPS. Findings marked **documented** come from vendor docs only and have
not been independently reproduced.

---

## Seedr has two APIs; SeedrPool uses V1

Date: 2026-08-31
Confidence: measured

| | V1 (legacy) | V2 (current) |
| --- | --- | --- |
| Base URL | `https://www.seedr.cc/oauth_test` | `https://v2.seedr.cc/api/v0.1/p` |
| Password grant | **works** (`seedr_chrome`) | absent (HTTP 500) |
| Device flow | issued empty/pending tokens | works, but see below |
| New authorizations | unrestricted | **refused** for our client id |
| Access token life | ~30 days | 3600 s |
| Token rotation | none; re-login is idempotent | single-use rotating refresh chain |
| Streaming ladder | 720p max (own player) | up to 2160p (own player) |
| Original-file download | `ff_get`, untranscoded | `ff_get`, untranscoded |

This reverses an earlier conclusion. The project started on V2 and the earlier
draft of this file declared V1 unusable. That was wrong in a specific way: V1's
**device** flow is broken (it issues empty tokens), but its **password** grant
was never tested and works perfectly.

What forced the change was V2 becoming unusable for onboarding. `acc1` was
authorized successfully at 12:31, but by 13:20 the same client id returned:

```text
POST /oauth/device/code   → 200, still issues codes
GET  /oauth/device/verify → ?error=This+application+is+not+available+for+authorization.
```

The client id `tn7B667iqQajxkyMKtiVitHvfnxsS1Tj` belongs to the MIT-licensed
`aryalsuman/stremio-seedr-addon`, not to us. Seedr appears to have disabled it
for new grants, plausibly triggered by a burst of five device-code requests plus
repeated polling from this VPS. The older ids are dead on V2 outright:
`seedr_xbmc`, `seedr_chrome`, and `seedr_kodi` all return
`400 {"reason_phrase":"Invalid client"}`.

There is no public Seedr developer portal to register a client of our own; a
search found none.

**Impact:** SeedrPool authenticates with the V1 password grant
(`src/providers/seedr-v1.ts`). The V2 provider is retained for reference and
because already-issued tokens still work, but nothing uses it. V1's documented
retirement is now the project's main external risk — a retiring API that works
beats a current API that refuses to authorize.

Source: <https://www.seedr.cc/docs/api/rest/v1/>

---

## Authentication (V1 password grant)

Date: 2026-08-31
Confidence: measured

```text
POST https://www.seedr.cc/oauth_test/token.php
  grant_type=password&client_id=seedr_chrome&type=login
  &username=<email>&password=<password>
  → { access_token, refresh_token, expires_in: 2586746, token_type: "Bearer", scope: null }
```

All eight of Jay's accounts authenticated on the first attempt. Measured
properties:

| Property | Result |
| --- | --- |
| `expires_in` | 2 585 000-2 587 000 s ≈ **30 days** |
| Repeated login | returns the **same** access token |
| Earlier token after re-login | still valid (HTTP 200) |
| Wrong password | HTTP 401 `Invalid username and password combination` |
| Invalid token | HTTP 401 `{"result":false,"error":"access_denied"}` |
| Rate limiting on login | none observed across repeated logins |
| `refresh_token` grant | works, but unnecessary |

The password grant is **idempotent**. Logging in twice yields the same token and
does not invalidate the first one. This is the opposite of V2's behaviour and it
collapses a large amount of complexity: tokens are a cache, not a fragile secret.
A lost token costs one HTTP request, not a manual re-approval.

`type=login` is required in the body; omitting it still works but the seedrcc
reference library sends it, so SeedrPool does too.

**Impact:**

* accounts come from a plain `email:password` file, one per line, 0600, stored
  outside the repo at `/opt/stacks/.secrets/seedrpool-credentials.txt`;
* no browser approval, no onboarding UI, no device-code polling;
* a wrong password is cached as rejected so it is not retried on every request;
* the tradeoff versus V2: passwords are more sensitive than scoped tokens. They
  are never logged, never rendered in the admin page, and never included in error
  messages (asserted by test).

---

## Filesystem and task API (V1)

Date: 2026-08-31
Confidence: measured

Every call is `GET` or form-`POST` to
`https://www.seedr.cc/oauth_test/resource.php?access_token=<t>&func=<name>`.

```text
func=get_memory_bandwidth              quota (space_used, space_max, is_premium)
func=get_settings                      account identity, user_id, wishlist
func=list_contents  content_type=folder&content_id=0     root; any id for a folder
func=add_torrent    magnet=<magnet>                      queue a download
func=fetch_file     folder_file_id=<id>                  mint direct ff_get URL
func=delete         delete_arr=[{"type":"file","id":N}]  file | folder | torrent
```

**The magnet field is `magnet`, not `torrent_magnet`.** This cost real time and
the seedrcc reference library documents it wrongly. Measured:

| Request | Result |
| --- | --- |
| `POST` body `magnet=…` | **works** — `{user_torrent_id, title, torrent_hash}` |
| `POST` body `torrent_magnet=…` | `404 Not Found` |
| `POST` body `torrent_url=…` / `url=…` | `422 parsing_error` |
| `POST` body `torrent_link=…` | `400 no_torrent_passed` |
| `torrent_magnet` in the **query string** | `queue_full_added_to_wishlist` — silently parked, nothing downloads |

That last row is the dangerous one: it returns a plausible-looking success body
containing a `wt` object, but no download starts. The provider treats the
presence of `wt` as a failure.

Other V1 differences from V2:

* the root is folder `0`, addressed through the same `list_contents` call;
* there is no task endpoint. In-progress downloads appear in the root listing's
  `torrents` array with `progress`, `seeders`, `leechers`, `stopped`, and
  `warnings`; a finished torrent leaves the array and becomes a folder;
* consequently a completed transfer's folder id is not reported directly — it has
  to be matched by name in the root listing;
* `delete` handles files, folders, and torrents through one endpoint with a
  JSON-encoded `delete_arr`;
* file objects carry the same useful fields as V2: `name`, `size`, `hash`
  (SHA-1), `is_video`, `is_audio`, `presentation_urls`.

A dead magnet behaves as on V2: it sits in `torrents` at `progress: 0`,
`size: 0`, `seeders: 0` indefinitely rather than erroring. Verified by adding a
fabricated info hash, which persisted with zero peers until deleted.

---

## Authentication (V2, retained for reference)

Date: 2026-08-31
Confidence: measured

Device code flow only. No password grant exists.

```text
POST /oauth/device/code
  client_id=<id>&scope=files.read files.write tasks.read tasks.write profile
  → { device_code, user_code, verification_uri_complete, expires_in: 1800, interval: 5 }

POST /oauth/token
  grant_type=urn:ietf:params:oauth:grant-type:device_code
  → { access_token, refresh_token, expires_in: 3600, scope, user_id }
```

Approval requires an authenticated Seedr **web session**:

* `GET /oauth/device/verify?code=...` → HTTP 302 to web login
* `POST /oauth/device/verify` → HTTP 401 `session_expired` / `reauthenticate`

Seedr's verify page also **ignores the `?code=` parameter**, so
`verification_uri_complete` does not actually save the user from typing the
8-character code.

**Impact:** approval cannot be automated. This is moot now that V1's password
grant is in use, and doubly so since new authorizations for our client id are
refused.

### Token endpoint throttling

Date: 2026-08-31
Confidence: measured

Polling `POST /oauth/token` for five device codes concurrently caused every poll
to fail with `Rate limit exceeded. Please try again later.` The throttle is
per-client rather than per-device-code, and the status is not always 429
(HTTP 403 was also observed), so detection must also match the message text.

This throttle also caused a **misdiagnosis worth recording**: a throttled quota
request was reported on the admin page as `unreachable`, which looked like a
broken token chain. The account was fine. Rate-limit responses must be checked
*before* the 401 branch in every request path, and must never flag an account as
needing re-authorization.

**Impact:** `src/core/rate-limiter.ts` coordinates one shared budget per client
id, with a 250 ms minimum gap and a 60 s → 5 min escalating cooldown. V1 gets its
own limiter instance because the throttle is per client id and V1 uses a
different one.


---

## Refresh tokens are single-use and rotate (V2 only)

Date: 2026-08-31
Confidence: measured

This section applies to the **V2** provider, which is no longer in use. It is
retained because it explains why `src/core/token-store.ts` is built the way it is,
and because it is the failure mode to remember if V2 is ever revisited.

```text
POST /oauth/token grant_type=refresh_token
  1st use of a given refresh token → 200, new access_token AND new refresh_token
  2nd use of the same refresh token → 401 { "reason_phrase": "Token has been revoked" }
```

Access tokens live 3600 s. An access token was also observed returning 401 about
16 minutes after issue, following a refresh — refreshing appears to invalidate
the previously issued access token.

This is a rotating chain. Losing the newest refresh token before it is persisted
permanently breaks that account; only a fresh manual device approval recovers it.
This was demonstrated accidentally during research: a refresh succeeded but the
new token was redacted from output rather than persisted, revoking the account's
chain.

`TokenStore` therefore writes atomically (temp file, fsync, rename), serializes
writes through a mutex, and keeps the previous value until the new one is
committed. Restic backups of rotating tokens are near-useless — a restored token
is a revoked token.

**V1 has none of this.** The password grant is idempotent and re-login is free, so
the token file is a cache that can be deleted at any time with no consequence
beyond one extra HTTP request. Rule 6 in `agents.md` has been updated accordingly.

This is a rotating chain. Losing the newest refresh token before it is persisted
permanently breaks that account; only a fresh manual device approval recovers it.
This was demonstrated accidentally during research: a refresh succeeded but the
new token was redacted from output rather than persisted, revoking the account's
chain.

**Impact, mandatory:**

* persist the new refresh token atomically (write temp + `rename`) before the
  new access token is used for anything;
* exactly one writer per account — no second instance, no dev copy against
  production tokens;
* keep the previous token as a fallback until the new one is confirmed written;
* refresh proactively (~45 min against a 60 min expiry) rather than reactively
  on 401, which keeps every chain warm and sidesteps any unknown idle expiry;
* surface a broken chain on the admin page as "needs re-auth" at startup, not at
  playback time;
* Restic backups of rotating tokens are near-useless — a restored token is a
  revoked token. Atomic writes and single-writer discipline are the real
  protection.

Whether an unused refresh token expires on its own is **not known**; Seedr does
not document it and the observation window was ~20 minutes. Proactive refresh
makes the question moot.

---

## Storage and quota

Date: 2026-08-31
Confidence: measured

V1 reports quota from `func=get_memory_bandwidth`:

```json
{ "bandwidth_used": 0, "bandwidth_max": 0, "space_used": 0,
  "space_max": 6979321856, "space_scope": "user", "is_premium": false }
```

`bandwidth_max: 0` means no bandwidth cap is enforced on the free tier — only
stored bytes count.

Measured across all eight of Jay's accounts:

| Accounts | `space_max` each | Total |
| --- | --- | --- |
| acc1 | 8 053 063 680 (7.50 GiB) | 7.50 GiB |
| acc2-acc6 | 6 979 321 856 (6.50 GiB) | 32.50 GiB |
| acc7-acc8 | 6 442 450 944 (6.00 GiB) | 12.00 GiB |
| **Pool** | | **52.00 GiB** |

This corrects two earlier figures: the pool is **52 GiB, not 36 GiB**, and there
are **8 accounts, not 6**. Seedr's UI labels these accounts in GB while the API
reports binary GiB, and free allowances above the advertised 2 GB come from
referral bonuses.

Files do not auto-expire on any tier (documented, both v1 and v2 FAQ).

At 52 GiB the pool holds roughly 10-18 1080p films. With three users the library
is still a rotating cache rather than an archive, so the pin/protect flag matters.

---

## Playback: the 360p cap does not apply to API access

Date: 2026-08-31
Confidence: measured

This was the project's main risk. It is resolved.

Seedr's marketing states free accounts stream at 360p and v1 caps at 720p. That
limit applies to **Seedr's own web player**, not to streams obtained through the
API. The HLS master playlist returned for a free account advertises:

```text
RESOLUTION=854x480    NAME="480p"
RESOLUTION=1280x720   NAME="720p"
RESOLUTION=1920x1080  NAME="1080p"
```

The playlist is named `master-2160.m3u8`, implying the ladder extends to 2160p
when the source supports it.

Better still, the original file is directly retrievable, bypassing transcoding
entirely. Both APIs return the same kind of URL:

```text
V1: POST resource.php?func=fetch_file  folder_file_id=<id>
V2: GET  /download/file/{fileId}/url
  → { "url": "https://nwXX.seedr.cc/ff_get/{userId}/{fileId}/{name}?st=...&e=...",
      "name": "...", "success": true }
```

Measured on **V2** (276 MB 1080p MP4) and re-measured on **V1** (129 MB
`Sintel.mp4` and a 280 MB `.mkv`); results are identical:

| Property | Result |
| --- | --- |
| `content-length` | full original, byte-identical, no transcode |
| `content-type` | `application/octet-stream` |
| `content-disposition` | `attachment` |
| `accept-ranges` | `bytes` |
| `Range: 0-1023` | HTTP 206, 1024 bytes |
| mid-file `Range` | HTTP 206, 1024 bytes (seek works) |
| Throughput | 4.6-4.8 MB/s ≈ 37-38 Mbps over an 8 MiB sample |
| URL lifetime | ~24 h (`e=` unix expiry) |
| Repeated minting | each call returns a **different** signed URL; all work |

**Impact:** SeedrPool serves original files via `ff_get`, not HLS. Range support
means Stremio can seek. Throughput is ample for 1080p. Switching from V2 to V1
changed nothing here, which is why the auth change carries no playback risk.

Because `content-type` is `application/octet-stream` rather than `video/mp4`,
`stream.behaviorHints.notWebReady` likely must be `true` — to be confirmed by
testing in a real Stremio client rather than assumed.

---

## Filesystem and task API (V2)

Date: 2026-08-31
Confidence: measured

```text
GET  /fs/root/contents              quota + root listing
GET  /fs/folder/{folderId}/contents folder listing
GET  /download/file/{fileId}/url    mint direct original-file URL
POST /tasks       { "torrent_magnet": "magnet:?..." }
GET  /tasks                         all tasks
GET  /tasks/{id}                    one task
```

Root listing returns folders with `path` (not `name`); folder listings return
files with `name`, `size`, `hash` (SHA-1), `is_video`, `is_audio`, and
`presentation_urls` (thumbnails at 48/64/220/720 plus an `hls` URL).

`is_video` gives free movie/TV filtering — no need to match file extensions.
`hash` gives cross-account duplicate detection for free.
`size` and `name` feed `behaviorHints.videoSize` / `filename` for subtitle
matching.

Adding a magnet returns immediately:

```json
{ "user_torrent_id": 196008266, "title": "Big Buck Bunny", "success": true,
  "torrent_hash": "dd8255..." }
```

Task states observed: `running`, `finished`, `paused`. A completed task exposes
`folder_created_id`, which links the task to its resulting folder. Tasks carry
`torrent_payload.seeders` / `.leechers` / `.download_rate`.

A dead magnet (bare info hash, no trackers) sits at `state: running`,
`progress: 0`, `size: 0`, `seeders: 0` indefinitely rather than erroring. The
admin UI must surface seeder counts so dead magnets are visibly dead, and the
DownloadManager needs a stall timeout.

---

## Stremio addon protocol

Date: 2026-08-31
Confidence: documented

Minimum viable addon: an HTTP server serving `/manifest.json` and
`/{resource}/{type}/{id}.json` for at least one resource. Resources are
`catalog`, `meta`, `stream`, `subtitles`. Extra args arrive as a
querystring-shaped path segment: `/{resource}/{type}/{id}/{extraArgs}.json`.

**CORS allowing all origins is required on every route, including
`/manifest.json`.**

Using `tt` (IMDB) ID prefixes means Stremio's own Cinemeta handles metadata, so
`meta` only needs implementing for SeedrPool-native IDs.

Relevant stream object fields:

* `url` — direct HTTP(S) link
* `name` — conventionally the quality label
* `description` — replaces the deprecated `title`
* `behaviorHints.notWebReady` — set when the URL is not HTTPS or not an MP4
* `behaviorHints.bingeGroup` — same value ⇒ Stremio auto-picks for next episode
* `behaviorHints.filename` / `videoSize` / `videoHash` — passed to subtitle
  addons for matching
* `behaviorHints.proxyHeaders` — requires `notWebReady: true`

**Impact:** because `ff_get` URLs expire in ~24 h, `stream.url` must point at a
SeedrPool endpoint that mints a fresh URL per playback and 302-redirects. Stream
URLs are never cached in the library and Seedr tokens never reach the client.

Source: <https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md>
and `docs/api/responses/stream.md`.

The community SDK (`@stremio-addon/sdk`, ESM-first TypeScript, Zod validation)
is a viable alternative to the official SDK. Given the protocol is this small,
serving it directly avoids a dependency.

Source: <https://github.com/Stremio-Community/stremio-addon-sdk>

---

## Concurrency is per signed URL, not per account

Date: 2026-08-31
Confidence: measured

This corrects an earlier conclusion in this file. The earlier measurement — "~3
sustained streams per account, then HTTP 429" — was an artefact of hammering **one
signed URL**. Re-measured properly on V1, varying one factor at a time:

| Setup | Result |
| --- | --- |
| 1 URL, 2 concurrent 256 KiB reads | 2/2 → 206 |
| 1 URL, 3 concurrent reads | 2/3 → one **429** |
| 1 URL, 4 concurrent reads | 2/4 → two 429 |
| 2 URLs (same file, same account), 2 reads each | **4/4 → 206** |
| 2 URLs (2 files, same account), 2 reads each | **4/4 → 206** |
| 4 URLs (same account), 2 reads each = 8 | **8/8 → 206** |
| 5 URLs (same account), 1 read each | **5/5 → 206** |
| 6 URLs (same account), 2 reads each = 12 | **12/12 → 206** |
| 2 accounts, 2 reads each, same source IP | 4/4 → 206 |

The limit is **2 simultaneous reads per signed `ff_get` URL**. It is not
per-account, not per-file, and not per-IP: 12 concurrent reads from one account
all succeeded once they were spread over six separately minted URLs. Minting is
cheap and each call returns a distinct signed URL.

The 429 body is 162 bytes with no `Retry-After` header.

**Impact, and it is good news:**

* `/play/...` mints a fresh URL per playback, so two viewers never share a URL and
  never contend. Three users across eight accounts is far from any ceiling;
* the earlier plan to spread content across accounts *for concurrency* is
  unnecessary. Allocation optimizes for **capacity**; stream counts remain as a
  bandwidth-fairness heuristic and for admin visibility, not as a hard limit
  (`STREAM_LIMIT_PER_ACCOUNT`, now documented as soft);
* a single client opening more than 2 parallel connections to one URL is the one
  case that would still 429 — worth watching in real Stremio clients, which
  sometimes open several connections for buffering. If it happens, the fix is to
  mint per connection rather than per playback.

Seedr's FAQ states free accounts get 2 download connections; paid tiers get 4-8.
The per-URL measurement matches that number exactly, suggesting `ff_get` inherits
the download-connection budget per signed link.

Source: <https://www.seedr.cc/faq/> plus direct measurement.

---

## Terms of use

Date: 2026-08-31
Confidence: documented

The Acceptable Use Policy §3 prohibits using "automated means to create
accounts, abuse free tiers, or evade billing" and "excessive automated requests
or circumvention of rate limits." Termination may occur without notice.

Pooling eight free accounts to approximate a paid tier is within the scope of
that clause, and using the password grant against `oauth_test` endpoints is
squarely in the same territory. Jay has been informed and accepts the risk for a
personal learning project. Recorded here so the tradeoff stays visible rather
than forgotten.

Practical mitigations: keep request rates modest, do not create accounts
programmatically, and expect that accounts can disappear.

Source: <https://www.seedr.cc/aup/>

---

## Operational notes

Date: 2026-08-31
Confidence: measured

VPS has 1.9 GiB RAM total and 2 cores. Before changes: 279 MiB available with
2.5 GiB of swap in use, of which Metabase's JVM held 1.25 GiB. Metabase and
metabase-db were stopped with Jay's approval, freeing swap to 1.3 GiB and
raising available RAM to ~530 MiB. Data, compose file, and the
`metabase.zayu.dev` Caddy route were left intact for reversibility.

**Do not authorize other Seedr→Stremio addons on the pooled accounts.** On V2 a
shared OAuth client id could rotate or revoke SeedrPool's refresh chain. On V1
this risk is gone, but a third-party addon would still consume the accounts'
download-connection budget.

**Credentials file.** `/opt/stacks/.secrets/seedrpool-credentials.txt`, mode 0600,
owned by uid 1000 to match the container's `node` user. Ids are positional, so a
slot number must never be reused: the library index stores account ids, and
renumbering silently reattributes one account's file rows to another. Deleting an
account through the admin therefore writes a `#deleted accN` **tombstone** in its
place, which the parser counts as a consumed slot. Editing the file by hand is
still unsafe — remove a line and everything below it shifts up. Use the admin, or
replace the line with a tombstone yourself. `data.txt` in the repo is gitignored;
the deployed copy is the one that matters.

SeedrPool is excluded from Watchtower so updates are deliberate and a restart
never lands mid-download.

At 52 GiB the pool holds roughly 10-18 1080p films. With three users the library
is a rotating cache, not an archive, so the pin/protect flag carries more weight
than its size suggests.

---

## Resolved questions

1. Which Seedr API — **V1 password grant** at `www.seedr.cc/oauth_test`. V2 works
   technically but refuses new device authorizations for the only client id
   available to us, and there is no way to register our own.
2. Can eight accounts be managed concurrently — yes. V1 tokens are independent,
   long-lived (~30 days), and re-login is idempotent, so there is no chain to
   break.
3. What counts against storage — stored bytes (`space_used` vs `space_max`);
   `bandwidth_max` is 0, meaning no bandwidth cap; files never auto-expire.
4. Streaming concurrency — **2 simultaneous reads per signed `ff_get` URL**, not
   per account. 12 concurrent reads from one account succeeded across 6 minted
   URLs. Minting per playback removes the constraint.
5. Playback URL reliability — `ff_get` URLs are range-capable and last ~24 h;
   mint per playback. Each mint returns a distinct URL and all remain valid.
6. Reusing existing code — `hemantapkh/seedrcc` is the useful V1 reference for
   endpoint shapes, but its `torrent_magnet` field name is **wrong**; the working
   field is `magnet`. `aryalsuman/stremio-seedr-addon` remains the V2 reference.
7. Subtitle strategy — Seedr returns sidecar files (e.g. `.en.srt`) in the same
   folder; serve those first, external providers later. Confirmed on V1 with
   Sintel, which ships 9 `.srt` files alongside the video.
8. Torrent discovery — **dropped.** Jay adds magnets manually.
9. Private addon limitations — no auth mechanism in the protocol; an unguessable
   URL path is the only practical protection, and anyone holding that URL can
   stream the library.
10. Plan changes — see `plan.md`; V1 password grant, no discovery, 8 accounts,
    52 GiB, no token-rotation fragility.

## Open questions

1. Does `notWebReady: true` need setting for `application/octet-stream` URLs in
   real Stremio clients? (measured that `content-type` is
   `application/octet-stream`, not `video/mp4`; client behaviour still untested)
2. When will V1 be retired? Seedr's docs say "coming months" with no date. This is
   the project's main external risk and there is no way to measure it.
3. Do `ff_get` URLs remain valid for their full ~24 h in practice?
4. How many parallel connections does a real Stremio client open to one stream
   URL? More than 2 would hit the per-URL 429 and require minting per connection
   rather than per playback.
5. Does V1 throttle sustained API use? No throttling was observed across ~60
   requests and repeated logins, but the sample is small and the limiter is in
   place regardless.

