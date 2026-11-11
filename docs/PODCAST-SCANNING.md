# Podcast scanning and playback

## Folder contract

Podcast scan root: `/中國移動雲盤/Kim King/13 喜马拉雅`.

Every immediate child directory under the Podcast root is one show. All nested directories under that show remain part of the same show. Every supported audio file below it is one episode. Files placed directly in the Podcast root are skipped and reported because they do not belong to a show folder.

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

The show title comes from the immediate folder name. Episode title, episode/season number, publication date, description, duration and audio properties are read from embedded tags where available. Missing fields fall back to the file name or remain empty.

## Scan behaviour

- Dedicated Podcast scan action and checkpoint namespace.
- D1 tables `podcast_shows` and `podcast_episodes`.
- Independent retry queue using `podcast_scan_`, `podcast_retry_` and `podcast_retry_done_`.
- Up to 500 entries / changed episodes per batch, with a resumable D1 cursor.
- Bounded browser Range reads from the VPS Alist file URL and R2 artwork de-duplication.
- Unchanged episodes are skipped using full path, file size and modification timestamp.
- Partial scans and missing source files never delete existing Podcast records.

## Playback

- Each show has a detail page and ordered episode list.
- The shared player obtains the current VPS Alist playback URL when an episode is selected.
- Episode resume position is periodically saved and restored when played again.
- Playback speed can be selected from 0.5× to 2.0× and is saved independently for each episode.
- Continue Listening lists unfinished episodes.

## Listening reports

Podcast reports are independent from Music. They include play count, actual listened time, completed sessions and latest played time for each episode. Periods are rolling 7-day, 30-day, 365-day and all-time ranges.

## D1 setup

Apply `migrations/0002_podcasts.sql` once if Podcast tables are not yet present. Apply `migrations/0003_listening.sql` to enable resume position, saved speed and reports. Both are additive and do not clear any catalogue data or R2 objects.
