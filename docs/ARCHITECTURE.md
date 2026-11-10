# FRAME Audio architecture

## Product areas

### Music
- Browse tracks, artists, albums, and the original OpenList folder tree.
- Each source folder can become a queue; parent-folder playback can include descendants.
- Extract embedded artwork and lyrics into a private, deduplicated asset store.
- Store track metadata and resumable scan checkpoints in Cloudflare D1; store artwork in R2.
- Indexing is user-triggered from the browser. Page load never scans the library.
- Process up to 500 new or changed tracks per batch, with a 500-entry ceiling, a 500-folder ceiling and a 7,500-second soft time ceiling.
- Resume from D1 checkpoints after a page reload or interrupted session.
- Skip unchanged tracks using path, file size and modified time where available.
- A failed or partial scan never deletes existing catalogue rows. Once a root scan completes, D1 folder records are rebuilt idempotently from the completed folder-path set and indexed track paths.

### Podcasts
- Keep shows, episodes, and listening progress separate from Music.
- First target: audio files already stored in OpenList.
- Episode resume position, played state, and playback speed are podcast-specific.
- RSS discovery / automatic downloads remain optional future functionality.
- Podcast folders are not included when the user starts a Music-root scan.

## Shared core
- OpenList API and authenticated file URL resolution.
- Browser audio playback controller and queue primitives.
- HTTP Range capability checks and format compatibility handling.
- Artwork loading, caching, and request de-duplication.
- Shared error reporting and user settings.

## Private data boundary
The public repository contains source code and schemas only. User library paths, API tokens, D1 contents, R2 objects, tracks/manifests, lyrics, playback history, and audio files must not be committed to GitHub.

The browser obtains file URLs at playback time. Temporary OpenList signatures and tokens must not be placed in public JSON.

## Indexing strategy
The initial music library is about 7,000 tracks / 90 GB, with FLAC, MP3, M4A, and WAV files stored in mixed folders. Audio tags take priority over folder names; filename parsing is fallback only.

The browser reads metadata through bounded 256 KiB HTTP Range requests, with a 16 MiB transfer cap and a 90-second per-file metadata deadline. It never uploads the original audio file. Each batch has ceilings of 500 successful track writes, 500 directory entries, 500 completed folders and 7,500 seconds. A failed track is retried up to 20 total attempts; authentication and permission failures stop the scan immediately. The cursor, folder queue, counts and recent errors are stored in D1 so a subsequent batch can resume safely.

Incremental comparison uses path, file size and modified time when the source provides it. Files without a usable modification time are re-read rather than assumed unchanged. Repeated writes use the path as the unique track key and therefore update the existing row. Missing paths are not deleted automatically.

After the complete directory tree has been scanned, a same-origin Pages Function builds deterministic folder IDs, parent/child folder links, direct track IDs and recursive track counts in D1. Folder rebuilding is idempotent and does not delete old rows. A standalone Mac indexer prototype remains under indexer/, but the current Preview workflow uses the browser and Cloudflare D1/R2 directly.

## Deployment boundary
Cloudflare Pages serves the static application and same-origin Functions API. OpenList remains the source of truth for audio files. D1 stores the private catalogue and scan checkpoints; R2 stores artwork. Only Preview is configured until the workflow has been fully validated.
