# FRAME Audio Indexer

Private Mac-side maintenance tool. It is not part of the Cloudflare Pages build.

## Music library target
- Approx. 7,000+ tracks / 90 GB.
- Formats: FLAC, MP3, M4A, WAV.
- Mixed folder layout; embedded tags take priority.
- Embedded artwork and lyrics should be extracted where supported.
- User starts updates manually.

## Planned pipeline
1. Recursively enumerate configured OpenList roots using paginated directory listing.
2. Compare each file with SQLite state using path, size, modified time, and remote hash where available.
3. Skip unchanged tracks; inspect only new or changed files.
4. Read metadata with Mutagen through a seekable/range-aware source where supported.
5. Deduplicate embedded artwork by content hash and create WebP assets.
6. Preserve synchronized LRC timing; save plain lyrics as text.
7. Build tracks, albums, artists, and folder indexes.
8. Publish a new version only after a successful complete scan/export.

## Safety
- A failed scan must not delete old index records.
- Mark missing files first; remove only after a later successful full scan confirms absence.
- Do not hash all 90 GB by default.
- Do not download complete audio files just to read tags.
- WAV tags and artwork are optional and must not fail the whole scan.
- Keep tokens in environment variables and local configuration outside Git.

## Status
This is a specification-only scaffold. The OpenList client and metadata scanner are not yet implemented. First verify the user's actual OpenList root paths, auth format, get/download response and Range behaviour with a small sample.
