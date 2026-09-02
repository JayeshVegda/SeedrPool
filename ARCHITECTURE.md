# SeedrPool Architecture

```text id="z6r5c0"
                    Stremio
                       │
                 Stremio Addon
                       │
                SeedrPool Core
                       │
        ┌──────────────┼──────────────┐
        │              │              │
     Library       Downloads       Playback
        │              │              │
        └──────────────┼──────────────┘
                       │
                 Account Pool
                       │
       ┌───────┬───────┼───────┬───────┐
       │       │       │       │       │
     Seedr1  Seedr2  Seedr3  Seedr4  Seedr5/6
```

## Core concepts

### StorageProvider

Generic interface for external storage.

Seedr is the first implementation, with two variants: `SeedrV1Provider` (password
grant, in use) and `SeedrV2Provider` (OAuth device flow, retained but unused —
Seedr refuses new authorizations for our client id).

### AccountPool

Manages all accounts:

* capacity
* health
* allocation
* failover

### Library

One logical movie/TV library containing physical files from multiple accounts.

### DownloadManager

Receives magnets/search results and chooses where to store them.

### PlaybackManager

Finds the best physical copy and obtains a playable URL.

### SubtitleManager

Finds subtitles independently of the Seedr filename and returns them through Stremio.

### EvictionManager

Automatically removes low-value content when storage is needed.

Default priority:

1. failed/temp files
2. duplicates
3. never watched
4. old/rarely watched
5. protected/favorites never automatically removed

## Data flow

### Existing files

```text
Seedr accounts
 → scanner
 → filename parser
 → metadata matcher
 → database
 → unified library
```

### New content

```text
Search / Magnet
 → DownloadManager
 → AccountPool
 → Seedr
 → completed file
 → scanner
 → library
```

### Playback

```text
Stremio
 → media ID
 → library
 → best physical file
 → Seedr playback URL
 → Stremio
```

### Subtitles

```text
Stremio
 → media metadata
 → SubtitleManager
 → subtitle provider(s)
 → Stremio
```

## Deployment

VPS:

```text
HTTPS
 ↓
SeedrPool
 ↓
SQLite
 ↓
Seedr APIs
```

The VPS does not store the actual videos.

Seedr remains the media storage layer.

## Technology

Preferred, pending research:

* TypeScript
* Node.js LTS
* pnpm
* SQLite
* current Stremio Community SDK
* Docker

Keep the architecture provider-agnostic so future storage providers can be added.
