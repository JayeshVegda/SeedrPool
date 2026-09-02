# Operations

Day-to-day operations on a running SeedrPool. Read this if something
is yellow, red, or silent in the operator console.

## The operator console

`https://seedr.zayu.dev/admin` (basic-auth).

Five pages:

* **Overview** — the signal bar (one cell per Seedr account), three KPIs
  (movies / files / free space), the Stremio addon URL, the ingest
  form, and the activity timeline. The first thing to look at.
* **Library** — one row per indexed movie with poster (TMDB art when
  available), title, year, quality, playback state (Direct / HLS /
  Mixed), the accounts it lives on, and inline actions (Stremio deep
  link, Copy link, Move, Delete). Filter by typing.
* **Transfers** — one row per in-flight Seedr transfer. The "No seeders"
  pills mean the swarm is dead — remove to free the slot.
* **Fleet** — one row per Seedr account with health pill (Healthy /
  Torn reel / Offline / Bad password), used-storage bar, the streams
  count, and per-row Purge + Remove buttons. "Dump now" captures a
  per-account JSON snapshot; "Dumps" jumps to the dump inventory.
* **Activity** — full transaction history. Filter by account, kind, or
  time range. The last 500 events are kept (auto-pruned beyond that).
* **Dumps** — latest JSON snapshot per account, with size and capture
  time. Files themselves are read off the host (`data/dumps/`); this
  page is just an inventory.

## Adding an account

The fleet page's **Add account** button opens a modal asking for email
and password. The handler **probes Seedr with a V1 password grant**
before saving, so a wrong password never lands on disk. If the password
is correct, the credentials file is appended with one line and the
addon process is re-probed.

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

**Purge** is destructive. It walks every Seedr folder/file on the named
account, deletes each, and removes the corresponding library rows. The
30-minute CDN quarantine is reset so the next `ff_get` URL the account
serves is treated as fresh. Use this when:

* the account's storage is full of junk and the operator wants a
  clean slate;
* the account is being decommissioned permanently.

The fleet page's pool auto-skips the account for 30 minutes after a CDN
404, but the underlying files are still on Seedr. Purge is the only way
to free space.

## Per-account JSON dumps

Every six hours, plus on demand from the **Dump now** button on the
fleet page (POST `/admin/dump`), each Seedr account is snapshotted to
`SEEDRPOOL_DUMPS_DIR/accN.<unixMs>.json`. The default directory is
`/app/data/dumps` (in the container) which is the same Docker volume as
the library SQLite, so dumps survive container restarts.

Each dump looks like:

```json
{
  "accountId": "acc1",
  "email": "you@example.com",
  "capturedAt": 1735689600000,
  "token": {
    "issuedAt": 1735689336,
    "expiresIn": 2410477,
    "prefix": "df00aa",
    "suffix": "9f35"
  },
  "quota": { "used": 4521984000, "max": 8053063680, "free": 3531079680 },
  "root": {
    "folders": [
      { "id": "1432717205", "name": "In.the.Mood.For.Love.2000…", "size": 4581984000 }
    ],
    "files": [
      { "id": "5984133767", "name": "In.the.Mood.For.Love.mkv", "size": 4521984000, "folderId": "1432717205" }
    ]
  },
  "transfers": [
    { "id": "196071038", "name": "Big.Buck.Bunny…", "state": "running", "progress": 23, "size": 763482113, "seeders": 4, "leechers": 1, "error": null }
  ]
}
```

The access token is **masked**: the full `sdo_…` string is never in
the file. The operator can read the dump directly off the host with
`cat data/dumps/acc1.<ts>.json | jq` or open the **Dumps** page for an
inventory. The Dumper prunes to the most recent 5 files per account
(`Dumper({ keepPerAccount: 5 })`) — older dumps are deleted on the next
run.

**No secrets in the dump.** `prefix` (6 chars) + `suffix` (4 chars) is
enough to detect token rotation in logs but cannot be used to
authenticate against Seedr.

## Transfer watching

The transfer-watcher polls every account's `get_torrents` list every 30
seconds. When a transfer ID that was in the list 30 seconds ago is no
longer there, the watcher:

1. Triggers a re-index of just that account.
2. Fires the metadata enricher so any new files get an IMDb id.
3. Records the completion in the activity log.

The poll budget is **N accounts × `POLL_INTERVAL_MS`** (default 30 s
per account). For the seedr.zayu.dev deploy that's 8 × 30 s. For a
50-account pool, increase `POLL_INTERVAL_MS` in
`src/core/transfer-watcher.ts` proportionally (or just accept the lower
per-account cadence — the watcher only re-scans accounts whose transfer
list changed, so the overhead is a list call, not a full folder walk).

## Backup and restore

The library DB is a single sqlite file at `data/library.sqlite`. To
back up:

```bash
sqlite3 /opt/stacks/compose/seedrpool/data/library.sqlite \
  ".backup '/opt/stacks/backups/seedrpool-$(date +%F).sqlite'"
```

The `.backup` command is the safe way to copy a sqlite file while the
process is still writing to it. Plain `cp` is not safe.

The DB is **regenerable** — every title and file can be re-derived from
the Seedr accounts on the next reindex. The only thing that is *not*
regenerable is the `magnet` field on each file (the original URL the
operator pasted in). If you back up the DB periodically, you preserve
the ability to re-add magnets without re-pasting.

The dumps directory (`data/dumps/`) is on the same Docker volume and
backed up the same way.

## Hard restart

```bash
cd /opt/stacks/compose/seedrpool
docker compose restart seedrpool
docker compose logs --tail=30 seedrpool
```

The image has no `node_modules` and no toolchain, so a cold start takes
under 1 second. The first scan runs immediately, then the watcher
takes over.
