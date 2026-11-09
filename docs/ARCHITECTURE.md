# FRAME Audio architecture

## Product areas

### Music
- Browse tracks, artists, albums, and the original OpenList folder tree.
- Each source folder can become a queue; parent-folder playback can include descendants.
- Extract embedded artwork and lyrics into a private, deduplicated asset cache.
- Build a local SQLite index and publish versioned JSON.
- Updates are manually started on the user's Mac. Page load never scans the library.
- The indexer is read-only against OpenList, uses HTTP Range, defaults to a 20-track sample, and caps metadata reads per file at 16 MiB.

### Podcasts
- Keep shows, episodes, and listening progress separate from Music.
- First target: audio files already stored in OpenList.
- Episode resume position, played state, and playback speed are podcast-specific.
- RSS discovery / automatic downloads remain optional future functionality.

## Shared core
- OpenList API and authenticated file URL resolution.
- Browser audio playback controller and queue primitives.
- HTTP Range capability checks and format compatibility handling.
- Artwork loading, caching, and request de-duplication.
- Shared error reporting and user settings.

## Private data boundary
The public repository contains source code and schemas only. User library paths, API tokens, SQLite state, tracks/manifests, artwork, lyrics, playback history, and audio files must not be committed to GitHub.

The browser obtains file URLs at playback time. Temporary OpenList signatures and tokens must not be placed in public JSON.

## Indexing strategy
The initial music library is about 7,000 tracks / 90 GB, with FLAC, MP3, M4A, and WAV files stored in mixed folders. Audio tags take priority over folder names; filename parsing is fallback only.

Incremental comparison uses path, size, modified time, and a reliable remote hash when available. Re-read metadata only for new or changed files. A failed or partial scan never triggers mass deletion; missing entries are removed only after a later successful full scan confirms absence. The current implementation intentionally does not auto-delete missing entries at all.

The local indexer reads metadata through bounded 64 KiB HTTP Range requests. It refuses HTTP 200 responses, enforces a per-file transfer ceiling, and keeps SQLite, artwork, lyrics and JSON outside the public repository.

## Deployment boundary
Cloudflare Pages serves the static application only. The user's Mac runs manual indexing and stores the private catalogue locally. Publishing the generated JSON/assets to a private data origin is a separate future step; no private index is committed to GitHub.
