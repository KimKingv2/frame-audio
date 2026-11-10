# Podcast scanning

The Preview application has two independent scan actions:

- Music: \`/中國移動雲盤/Kim King/03 Music\`
- Podcasts: \`/中國移動雲盤/Kim King/13 喜马拉雅\`

## Folder contract

Every immediate child directory under the Podcast root is one show. All nested directories under that show remain part of the same show. Every supported audio file below the show folder is one episode. Files placed directly in the Podcast root are skipped and reported because they do not belong to a show folder.

Example:

~~~text
13 喜马拉雅/
├── Show A/
│   ├── EP01.mp3
│   └── Season 02/
│       └── EP02.flac
└── Show B/
    └── 2026-11-01.mp3
~~~

The show title comes from the immediate folder name. Episode title, episode/season number, publication date, description, duration, and audio properties are read from embedded tags where available. Missing fields fall back to the file name or remain empty; the scanner does not invent metadata.

## D1 setup

Before the first Podcast scan, apply \`migrations/0002_podcasts.sql\` to the existing \`frame-audio-catalog\` D1 database. This migration is additive: it creates \`podcast_shows\` and \`podcast_episodes\` and does not alter or clear Music tables, existing scan checkpoints, or R2 objects.

After deployment, open the Cloudflare D1 Console for \`frame-audio-catalog\`, select the database, paste and execute the SQL from \`migrations/0002_podcasts.sql\`. Then return to FRAME Audio, reconnect, and run “測試 Cloudflare 儲存”. It should report Podcast table readiness and current show/episode counts.

## Independent progress and retry handling

Podcast progress uses \`podcast_scan_<SHA-256(root path)>\`. Its retry queue uses \`podcast_retry_<SHA-256(file path)>\` and \`podcast_retry_done_...\`. Music continues using its existing \`music_scan_\` / \`music_retry_\` keys. A Podcast failure never enters the Music retry queue.

The scanner uses the existing OpenList browser connection and bounded metadata Range reader. It does not download full audio, modify OpenList files, or require the VPS. Each batch checks up to 500 entries and indexes up to 500 new or changed episodes. Each episode has up to 20 attempts. Progress is checkpointed in D1 and can resume after a page reload or interrupted connection.

Incremental comparison uses the episode's full path, file size, and modification timestamp. Missing files are not deleted from D1. The first version stores show/episode metadata and artwork references; playback, resume progress, monthly reports, and listening analytics remain subsequent product work.
