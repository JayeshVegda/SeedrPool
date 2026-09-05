# Install

Two ways to run SeedrPool. Pick one.

## 1. Docker (recommended)

The image is built from the multi-stage `Dockerfile` in this repo. The
runtime image has **no toolchain and no node_modules** — only the compiled
`dist/` output and `node`. The build stage installs devDeps purely to run
`tsc`, and none of it reaches the runtime image. The runtime image is small
(about 80 MB on Alpine).

A working `docker-compose.yml` lives at
`/opt/stacks/compose/seedrpool/docker-compose.yml` (outside the repo,
alongside the secrets). The minimum file:

```yaml
services:
  seedrpool:
    build: /opt/stacks/sites/seedrpool      # repo root
    image: seedrpool-seedrpool:latest
    container_name: seedrpool
    restart: unless-stopped
    ports:
      - "127.0.0.1:7010:7010"                # only on loopback
    environment:
      SEEDRPOOL_CREDENTIALS_PATH: /secrets/seedrpool-credentials.txt
      SEEDRPOOL_ADDON_SECRET_PATH: /secrets/seedrpool-addon-secret
      SEEDRPOOL_DB_PATH:           /opt/stacks/sites/seedrpool/data/library.sqlite
      SEEDRPOOL_PUBLIC_URL:        https://seedr.zayu.dev
      SEEDRPOOL_ADMIN_USER:        jay
      SEEDRPOOL_ADMIN_PASSWORD:    change-me
      SEEDRPOOL_TMDB_API_KEY:      your-tmdb-v3-key
    volumes:
      - /opt/stacks/.secrets/seedrpool-credentials.txt:/secrets/seedrpool-credentials.txt:ro
      - /opt/stacks/.secrets/seedrpool-addon-secret:/secrets/seedrpool-addon-secret:ro
      - seedrpool-data:/opt/stacks/sites/seedrpool/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7010/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  seedrpool-data:
```

> **Caddy and Cloudflare sit in front.** Bind only to `127.0.0.1:7010` and
> let Caddy terminate TLS. The compose example assumes Caddy is on the
> host, reverse-proxying `seedr.zayu.dev` to `127.0.0.1:7010`.

Bring it up:

```bash
cd /opt/stacks/compose/seedrpool
docker compose build
docker compose up -d
docker compose logs --tail=20 seedrpool
```

You should see:

```text
account acc1: healthy
account acc2: healthy
...
seedrpool listening on http://0.0.0.0:7010
admin:    http://0.0.0.1:7010/admin
manifest: https://seedr.zayu.dev/<secret>/manifest.json
```

The manifest URL includes the addon secret. Don't share it.

## 2. Plain Node (no Docker)

```bash
git clone https://github.com/JayeshVegda/SeedrPool
cd SeedrPool
npm install              # devDeps only — tsc + vitest
npm run build            # → dist/
SEEDRPOOL_HOST=127.0.0.1 \
SEEDRPOOL_PORT=7010 \
SEEDRPOOL_CREDENTIALS_PATH=$PWD/credentials.txt \
SEEDRPOOL_ADDON_SECRET_PATH=$PWD/addon-secret \
SEEDRPOOL_DB_PATH=$PWD/data/library.sqlite \
SEEDRPOOL_PUBLIC_URL=http://127.0.0.1:7010 \
SEEDRPOOL_ADMIN_USER=jay \
SEEDRPOOL_ADMIN_PASSWORD=change-me \
SEEDRPOOL_TMDB_API_KEY= \
  node dist/index.js
```

The only runtime dependency is `parse-torrent-title` (release-name parsing);
everything else comes from Node 24's standard library — `node:sqlite` and
`fetch`. The front-end libraries (htmx, Alpine, sonner-js) are vendored in
`src/admin/vendor/` and served from the app's own origin, so the console has no
runtime dependency on a CDN. The rest of `npm install` is strictly for the
build.

## Required secret files

Two files must exist on disk and be readable by the process:

| File | Format | Used by |
| --- | --- | --- |
| `seedrpool-credentials.txt` | one `email:password` per line, slot N → `accN`; a `#deleted accN` line is a tombstone holding a retired slot | `SeedrV1Provider` |
| `seedrpool-addon-secret` | single line, any URL-safe string | Stremio addon URL prefix |

**File permissions matter.** Both should be `chmod 600` and owned by
the user that runs the container (`uid 1000` for the bundled image). The
container is configured to drop root and run as `node:node`, which is uid
`1000`.

If the credentials file is missing or unreadable, the operator console
shows the offending line in the diagnostics table and the affected
account is marked `unhealthy`. The container keeps running.

## Reverse proxy (Caddy)

```caddy
seedr.zayu.dev {
  reverse_proxy 127.0.0.1:7010 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    transport http {
      dial_timeout 5s
      response_header_timeout 30s
    }
  }
  basicauth {
    /admin/*
    {env.ADMIN_USER} {env.ADMIN_PASSWORD_HASH}
  }
}
```

SeedrPool authenticates `/admin/*` with a cookie login page (see
`/admin/login`; sessions last 12 h with a sliding refresh). Adding Caddy's
`basicauth` in front is still defense in depth. The Stremio addon paths (under
`/OXLwzaLuh9UJFqVH9SOjaz55awwrAV/...`) must be **publicly accessible**
to Stremio's catalog service, so they sit outside the Caddy `basicauth`
matcher. The Stremio addon secret itself is the only access control.

## Configuration reference

| Env var | Default | Purpose |
| --- | --- | --- |
| `SEEDRPOOL_HOST` | `0.0.0.0` | bind address inside container |
| `SEEDRPOOL_PORT` | `7010` | bind port |
| `SEEDRPOOL_CREDENTIALS_PATH` | `/secrets/seedrpool-credentials.txt` | per-account login |
| `SEEDRPOOL_ADDON_SECRET_PATH` | `/secrets/seedrpool-addon-secret` | addon URL prefix |
| `SEEDRPOOL_DB_PATH` | `/app/data/library.sqlite` | sqlite file |
| `SEEDRPOOL_PUBLIC_URL` | — | canonical public URL (used in addon manifest) |
| `SEEDRPOOL_ADMIN_USER` | `jay` | login user |
| `SEEDRPOOL_ADMIN_PASSWORD` | *(empty = no auth)* | login password |
| `SEEDRPOOL_TMDB_API_KEY` | *(empty = no enricher)* | TMDB v3 key, query-param style |

Empty `SEEDRPOOL_TMDB_API_KEY` is fine for development — the indexer
keeps working, files just don't get IMDb ids. New titles become invisible
to Stremio until you fill in a key. Restart the container after editing.

## Smoke test

1. Open `https://seedr.zayu.dev/admin` → credentials → every account
   shows as `healthy` (or as many as your pool has; there is no fixed
   maximum).
2. Click **Reindex**. After ~30 s the library table populates.
3. Open Stremio → Add-ons → Community → paste the manifest URL from the
   admin overview → catalog shows your movies.

If the catalog is empty, the indexer probably couldn't reach the Seedr
CDN; check `docker compose logs seedrpool` for `index accN: ... failed`.
