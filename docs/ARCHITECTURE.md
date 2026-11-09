# FRAME Audio architecture

## Product areas

### Music
- Browse tracks, artists, albums, and the original OpenList folder tree.
- Each source folder can become a queue; parent-folder playback can include descendants.
- Extract embedded artwork and lyrics into a private, deduplicated asset cache.
- Build a local SQLite index and publish versioned JSON.
- Updates are manually started on the user's Mac. Page load never scans the library.

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

The browser must obtain file URLs at playback time. Do not put temporary OpenList signatures or tokens in public JSON.

## Indexing strategy
The initial music library is about 7,000 tracks / 90 GB, with FLAC, MP3, M4A, and WAV files stored in mixed folders. Audio tags take priority over folder names; filename parsing is fallback only.

Incremental comparison uses path, size, modified time, and a reliable remote hash when available. Re-read metadata only for new or changed files. A failed scan must never trigger mass deletion; missing entries are removed only after a later successful full scan confirms absence.

## Implementation gate
Before implementing the full remote metadata reader, verify the real OpenList list/get response, authentication method, direct file URL, and byte-range behaviour against a small sample. Do not assume every storage driver supports seeking identically.
