# Operations

Day-to-day operations on a running SeedrPool. Read this if something is
yellow, red, or silent in the admin console.

## The operator console

`https://seedr.zayu.dev/admin` (basic-auth).

There are five pages:

* **Overview** — the signal bar (one cell per Seedr account), three KPIs
  (movies / files / free space), the Stremio addon URL, the ingest
  form, and the activity timeline. The first thing to look at.
* **Library** — one row per indexed movie with poster (TMDB art when
  available), title, year, quality, playback state (Direct / HLS /
  Mixed), the accounts it lives on, and inline actions (Stremio deep
  link, Move, Copy link, Delete). Filter by typing.
* **Transfers** — one row per in-flight Seedr transfer. The "No seeders"
  pill means the swarm is dead — remove it to free the slot.
* **Fleet** — one row per Seedr account with health pill (Healthy / Torn
  reel / Offline / Bad password), used-storage bar, the streams count,
  and per-row Purge + Remove buttons. Top-right **Add account** opens a
  modal.
* **Activity** — full transaction history. Filter by account, kind, or
  time range. The last 500 events are kept (auto-pruned beyond that).

## Adding an account

The fleet page's **Add account** button opens a modal asking for email
and password. The handler **probes Seedr with a V1 password grant**
before persisting, so a wrong password never lands on disk. If the
password is correct, the credentials file is appended with one line
(`email:password`) and the addon process is re-probed.

```text
acc1@email.com:correctpass
acc2@email.com:correctpass
acc3@email.com:correctpass
...
```

The file is **append-only** — the positional `accN` ID is derived from the
line number. Reordering or deleting a line renumbers every account and
breaks the library DB. To remove an account, use the **Remove** button
on the fleet page (or `git rm -f` from the credentials file before a
restart); it preserves the library rows so the operator can re-add later
without losing title mappings.

## Removing an account

The fleet page's **Remove** button does two things:

1. Rewrites the credentials file without that line.
2. Reloads the pool so the addon stops probing that account.

The library rows for the account are **kept** (they are tagged with
`account_id` and continue to render in the catalog). Re-adding the
account later restores the same rows; the Seedr file IDs may differ if
the underlying file was deleted, in which case the indexer drops them on
next scan.

## Purging an account

**Purge** is destructive. It walks every folder and file on the Seedr
side of the named account, deletes each, and removes the corresponding
library rows. The 30-minute CDN quarantine is reset so the next
`ff_get` URL the account serves is treated as fresh. Use this when:

* the account's storage is full of junk and the operator wants a
  clean slate;
* the account is being decommissioned permanently.

The fleet page's pool auto-skips the account for 30 minutes after a CDN
404, but the underlying files are still on Seedr. Purge is the only way
to free space.

## CDN "torn reel"

Some Seedr CDN pools (`rd12.seedr.cc` and similar) return 404 for the
direct-download URL of certain accounts, even for freshly minted links.
SeedrPool handles this automatically:

1. `getPlaybackUrl` issues a 128-byte range request to probe the URL.
2. If 200, the URL is served as-is and the operator gets a 302 redirect.
3. If 404, the addon looks up the file via `get_folder` to find
   `presentation_urls.video.hls` and returns the HLS playlist URL
   instead.
4. The account is marked `cdnHealthy = false` for 30 minutes (the
   `CDN_QUARANTINE_MS`), and the pool allocator stops placing new
   content on it during that window.

Stremio's iOS, Android, and TV clients all support HLS. The desktop
player (VLC, MPV) also does. So torn-reel accounts remain playable —
they just require a player that handles `.m3u8`.

After 30 minutes the account is retried on the next `play` request. If
the CDN recovered (Seedr rotates its CDN pool periodically), the account
returns to `Direct` automatically. If it didn't, the account stays in
the `Torn reel` quarantine for another 30 minutes.

## Transfer watching

The transfer-watcher polls every account's `get_torrents` list every 30
seconds. When a transfer ID that was in the list 30 seconds ago is no
longer there, the watcher:

1. Triggers a re-index of just that account.
2. Fires the metadata enricher so any new files get an IMDb id.
3. Records the completion in the activity log.

The poll budget is the limiting factor. 8 accounts × 30 s = one
`get_torrents` per account per 30 s. Seedr's rate limit tolerates this;
doubling the pool to 16 would push against the limit and start producing
transient 429s on the account whose number falls unlucky.

## Activity log

Every operator-actionable event flows through the activity log. There
are four kinds:

* `info` — successful, normal events (magnet added, transfer completed,
  account re-probed, reindex started).
* `success` — explicit positive outcomes (file moved, file deleted,
  TMDB match found).
* `warn` — recoverable problems (torn reel detected, source deletion
  failed during a Move, but the new file is in place).
* `bad` — failures (purge failed, Seedr rejected credentials).

The activity table is capped at 500 rows. Older rows are auto-pruned. The
activity page is the right place to look when something is "off" — the
exact failure message is there.

## Backing up the library DB

The library DB is a single sqlite file at
`/opt/stacks/sites/seedrpool/data/library.sqlite` (or wherever
`SEEDRPOOL_DB_PATH` points). To back up:

```bash
sqlite3 /opt/stacks/sites/seedrpool/data/library.sqlite \
  ".backup '/opt/stacks/backups/seedrpool-$(date +%F).sqlite'"
```

The `.backup` command is the safe way to copy a sqlite file while the
process is still writing to it. Plain `cp` is not safe.

The DB is **regenerable** — every title and file can be re-derived from
the Seedr accounts on the next reindex. The only thing that is *not*
regenerable is the `magnet` field on each file (the original URL the
operator pasted in). If you back up the DB periodically, you preserve
the ability to re-add magnets without re-pasting.

## Restoring after a Seedr rate-limit window

Seedr's V1 password grant can be rate-limited if too many logins happen
in a short window. The symptoms are: an account's `healthCheck` returns
`access_denied` or a 429 status; the account shows as `Offline` or
`Bad password`; the indexer skips it. Recovery is automatic — the
next `play` request retries the login. If you need it sooner, click
**Reload credentials** on the fleet page; the pool refreshes every
account's token.

## Hard restart

```bash
cd /opt/stacks/compose/seedrpool
docker compose restart seedrpool
docker compose logs --tail=30 seedrpool
```

The image has no `node_modules` and no toolchain, so a cold start takes
under 1 second. The first scan runs immediately, then the watcher
takes over.
