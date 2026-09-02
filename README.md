# SeedrPool

Private multi-account Seedr media platform.

## Goal

Make eight Seedr accounts behave like one intelligent media library for movies and
TV, totalling 52 GiB.

Users interact primarily through Stremio.

### Features

* 8 Seedr accounts → one library
* automatic account selection
* automatic storage cleanup
* movie/TV indexing
* duplicate removal
* magnet support
* playback through Stremio
* subtitle support
* private VPS deployment

Torrent/search discovery is deliberately out of scope; magnets are added manually.

## Configuration

Accounts come from `/opt/stacks/.secrets/seedrpool-credentials.txt`, one
`email:password` per line, mode 0600. Ids are positional (line 1 is `acc1`), so
the file is **append-only** — reordering or deleting a line renumbers the accounts
below it.

Reload accounts from `/admin/accounts` after editing; no restart needed.

## Project Files

* `agents.md` — instructions for coding agents
* `plan.md` — implementation roadmap
* `ARCHITECTURE.md` — system design
* `RESEARCH.md` — technical research, measured vs documented

## Status

Phases 0-2 complete: all 8 accounts healthy, admin page deployed at
`seedr.zayu.dev`. Phase 3 (library index) and Phase 4 (Stremio addon) are next —
the addon manifest URL is reserved but not yet served.
