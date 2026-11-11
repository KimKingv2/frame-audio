# FRAME Audio · Player and listening history

## Shared player

Music tracks and Podcast episodes use one bottom-docked HTML5 audio player. A queue is created from the current track list, album, artist, folder or show. Previous / next controls move inside that queue. VPS Alist remains the single source for folder browsing, indexing, file metadata and playback URL resolution. Browser requests to `/api/openlist/list` and `/api/openlist/get` are handled server-side by Pages Functions, which read `ALIST_VPS_API_BASE_URL` and `ALIST_VPS_API_TOKEN` from the Pages environment. D1/R2 endpoints use `FRAME_AUDIO_API_ADMIN_TOKEN` injected by the Pages middleware after Cloudflare Access authentication. The browser never receives, stores, or sends either credential. There is no automatic Cloudflare playback fallback: VPS API or HTML5 media errors are surfaced to the user. The browser receives the temporary `raw_url` directly; the audio stream is not proxied or transcoded by Pages or VPS. Legacy `frame-audio-credentials-v1` localStorage entries are removed on application startup; only non-secret Music/Podcast root paths are preserved during that cleanup.

## Resume

The `listening_progress` row is keyed by `item_type + item_id`. The page periodically saves the current playback position and saves again on pause or page hide. Opening the same Podcast episode restores its last saved position when that position is not at the very end.

Podcast playback speed is stored in the same row as the episode position. Each episode can use 0.5× to 2.0× independently. Music starts at 1.0×.

## Listening events

The client creates one session ID when a new item begins. Pause / resume updates the same session. Each event records:
- item type and stable catalogue ID,
- current source path and title,
- session start time,
- accumulated active listening seconds,
- media duration when known,
- whether the session reached the end.

The report counts distinct sessions as plays. It sums active listening seconds per item. Seeking does not itself add listening time.

## Report periods

- `week`: rolling last 7 days.
- `month`: rolling last 30 days.
- `year`: rolling last 365 days.
- `all`: all events stored in D1.

Reports can switch between Music tracks and Podcast episodes and include aggregate summary cards plus per-item rows.

## Manual path repair

The Index Repair view merges the independent Music and Podcast retry queues into one table. Change the proposed path and choose **單獨重新索引**. FRAME Audio reads metadata only for that file. On success:
1. the replacement row is written to the appropriate catalogue,
2. prior listening events and resume state are linked to the replacement catalogue ID,
3. the stale path row is removed only if it existed and a replacement row was confirmed,
4. the original retry item is resolved.

If the replacement index fails, the old catalogue row, listening history and retry record remain intact.

## Player experience upgrades

- Playback modes: Sequential (default), Repeat One and Repeat All. Repeat One uses the browser media element loop; Repeat All wraps the current queue.
- Next-track preloading: when 30 seconds remain, the player resolves the next queue item's VPS Alist file information and warms a detached HTML5 Audio element with `preload="auto"`. The resolved file information is reused when Next is pressed. Browser/network policy controls how much media data is buffered, so this removes the next file-info lookup from the transition but does not guarantee that the whole next file is downloaded.
- Start position: newly selected Music tracks always begin at 0:00. Podcast episodes alone restore their last saved position and playback rate.
- Pure direct playback: every Music track and Podcast episode uses only the temporary VPS Alist `raw_url` in the native HTML5 Audio element. The browser follows the source's HTTP 302 redirects directly. Cloudflare Pages does not relay, proxy, cache or transcode audio. There is no EQ mode or same-origin audio-stream fallback.
- Synchronized lyrics: FLAC uses the original Vorbis `LYRICS` field as the preferred source when it contains LRC timestamps, rather than a flattened `common.lyrics` value or `UNSYNCEDLYRICS` fallback. The player supports LRC timestamps, multiple inline timestamps, LRC offsets, SRT-style timestamp/body pairs, cue objects with millisecond fields, and removes Mornye-style `v1:` / `v2:` speaker prefixes. Existing D1 rows are not rewritten automatically; use the current-track page's single-track reindex button for any FLAC whose stored lyrics were flattened. No full-library rescan is required.
- Track rows include a direct album-detail shortcut. The dock's current-track tile opens a full Now Playing page with centered, auto-scrolling synchronized lyrics and click-to-seek. Album, Podcast and player transitions use lightweight motion and respect `prefers-reduced-motion`.
- Player mode and shuffle preference are stored locally. Alist tokens and Cloudflare credentials are never included in those preferences. Music file-info lookup does not request a resume row because every newly selected Music track starts at 0:00; Podcast episodes still load their saved resume position and playback rate.
