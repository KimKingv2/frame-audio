# FRAME Audio architecture

## Product areas

### Music
- Browse tracks, artists, albums, and the selected OpenList source folder tree.
- Albums, artists, and folders can launch an ordered playback queue.
- Extract embedded artwork and lyrics into a private, SHA-256-deduplicated R2 asset store.
- Store metadata and resumable scan checkpoints in D1.
- Indexing is user-triggered; normal page load never scans the library.
- Incremental scan skips unchanged files using path, file size and modification time when available.
- A separate full Music re-scan mode ignores the unchanged-file check and re-parses embedded metadata for every audio file; it automatically chains bounded batches and remains resumable/pausable.
- Resumable scan checkpoints reconcile legacy discovered-folder lists with pending work once, rechecking known directories without re-indexing unchanged audio.
- The Folder Playlists view lists only immediate child folders of the configured Music root; each tile queues all indexed tracks below that folder.
- A partial or failed scan never deletes existing catalogue rows.

### Podcasts
- Dedicated root: `/中國移動雲盤/Kim King/13 喜马拉雅`.
- Every immediate child directory is one show; nested directories remain part of that show; each supported audio file is one episode.
- Dedicated D1 tables, scan checkpoints and retry queue, independent from Music.
- Show cards, show detail, episode lists and ordered show playback.
- Resume position is saved per episode.
- Playback speed ranges from 0.5× to 2.0× and is saved per episode.
- Continue Listening lists unfinished Podcast episodes.

### Playback and listening analytics
- One shared browser audio player supports Music tracks and Podcast episodes.
- VPS Alist, OpenList Worker and phone-local OpenList are interchangeable read-only sources for folder browsing, Music / Podcast scanning, metadata reads and playback URL resolution; each source uses the same configured absolute Music / Podcast paths.
- Playback position is periodically saved and restored when the same item is opened again.
- Listening time is accumulated from actual active playback, not from the media duration or a seek operation.
- One listening event/session contributes one play. Repeated progress writes update the same session rather than incrementing play count repeatedly.
- Reports are separated by Music and Podcast and support rolling 7-day, 30-day, 365-day and all-time periods.
- Per-item report fields include play count, total listened seconds, completed sessions and latest play time.

### Index maintenance
- Music and Podcast retry queues remain independent.
- The error table allows a user to edit an individual source path and re-run only that item's metadata index.
- If a corrected path differs, the new catalogue row is written first. The relink transaction then moves old listening events and resume progress to the new item identifier and removes the stale catalogue row.
- If re-indexing fails, the original item and retry record remain available for another repair attempt.
- Cumulative scan failures are labelled as historical failure events; they are not presented as current unresolved count.

## Shared core
- Provider-aware OpenList API access (VPS Alist Pages proxy, OpenList Worker Pages proxy, or phone-local direct connection) and authenticated file URL resolution.
- Bounded HTTP Range metadata reads.
- Browser audio playback and ordered queue handling.
- Artwork retrieval from R2.
- Cloudflare Access plus Pages middleware for private same-origin API access; Pages Variables provide server-side API base URLs, Pages Secrets provide VPS / Worker Tokens and FRAME Audio's internal API admin gate; D1 and R2 are accessed through their existing Pages bindings.
- Retry queues, D1 scan checkpoints and user-visible diagnostic logs.

## Private data boundary
The public repository contains source code, schemas and migrations only. User catalogue data, playback history, file paths, API tokens, R2 artwork objects, and audio files must not be committed to GitHub.

The browser obtains temporary VPS Alist playback URLs at playback time. Tokens and temporary URL signatures must not be placed in public JSON.

## Indexing strategy
The Music library is incrementally indexed from the selected OpenList source. All sources must expose the same absolute directory layout; switching sources does not migrate or rebuild the D1 catalogue. Existing D1 catalogue rows and R2 artwork remain in place when the source API is migrated; no scan runs automatically on page load. The browser reads metadata through bounded 256 KiB HTTP Range requests, with a 16 MiB transfer cap and a 90-second per-file metadata deadline. It does not download complete audio files.

Each batch has ceilings of 500 successful writes, 500 directory entries, 500 completed folders and 7,500 seconds. A file is attempted up to 20 times; authentication and permission errors stop immediately. D1 stores the cursor, folder queue, counts and recent errors so later batches can resume.

Podcast uses the same bounded browser Range approach but a separate state namespace and independent tables. Missing paths are never automatically deleted from either catalogue.

## D1 data model
- `tracks`, `folders`, `catalog_state`: Music and scan state.
- VPS / Worker connection profiles are read from Cloudflare Pages environment bindings and are not stored in D1. Phone-local credentials remain in that device's browser only.
- `podcast_shows`, `podcast_episodes`: Podcast catalogue.
- `listening_progress`: current per-item resume position and Podcast playback speed.
- `listening_events`: per-session plays, active listening time and completion state.

## Deployment boundary
Cloudflare Pages serves the static application and same-origin Functions API. Cloudflare Access protects Production and Preview hostnames. Pages middleware rejects API requests without an Access assertion and injects the `FRAME_AUDIO_API_ADMIN_TOKEN` application-level admin Secret server-side. Pages Functions read `ALIST_VPS_API_BASE_URL` / `ALIST_VPS_API_TOKEN` and `OPENLIST_WORKER_API_BASE_URL` / `OPENLIST_WORKER_API_TOKEN` server-side. Production and Preview require their own environment settings and existing D1/R2 bindings. The browser never receives either server-side Token; only the LAN-direct profile remains on the device.
