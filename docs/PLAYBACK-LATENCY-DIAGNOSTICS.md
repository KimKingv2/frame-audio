# Playback latency diagnostics

This release keeps the existing playback architecture: the browser asks Alist/OpenList for file information, then the browser plays the returned `raw_url` directly. Pages does not relay or transcode the audio. WebDAV is not introduced, and no periodic cloud-drive heartbeat is added.

## What is measured

Open the browser developer console before playback. The player emits the following structured messages:

- `[FRAME Audio] OpenList file-info request`: browser-observed request-to-response-header time (`responseMs`), JSON body parse time (`bodyMs`), HTTP status, and the same-origin `Server-Timing` header when the selected source is VPS Alist or OpenList Worker.
- `Server-Timing` breakdown: `openlist_profile` measures loading the server-side source configuration; `openlist_upstream` measures the upstream Alist/OpenList fetch until response headers arrive; `openlist_body` measures reading its JSON response; `retry_wait` records bounded transient-error retry delays; `function_total` measures the Pages Function handler duration.
- `[FRAME Audio] Audio startup pipeline`: elapsed time from assigning the audio URL to `loadstart`, `loadedmetadata`, `loadeddata`, `canplay`, and `playing`. `loadeddata` means media data is available to the browser decoder; `canplay` means the browser estimates it can begin playback. These are media-element milestones, not packet-level measurements of the first network byte.
- `[FRAME Audio] Next-track file info ready` and `[FRAME Audio] Next-track buffer`: how long the next file's information request takes and when its hidden Audio preloader reaches metadata, data, or `canplay`.

For direct LAN OpenList requests, the browser logs the client-side request duration. A Pages `Server-Timing` header is not expected because those requests bypass Pages Functions.

## Interpreting the results

- High `openlist_upstream` or `responseMs` with a fast audio startup usually points to slow file-link generation or network latency between Pages and the configured Alist/OpenList service.
- Fast file-info timings but high `loadeddataMs` / `canPlayMs` point to the returned audio host, redirect chain, or audio-source delivery path.
- If the next-track buffer reaches `canplay` before the current track ends, the prefetch has prepared enough media data for the browser to begin playback. If it only reaches metadata, the browser has not yet confirmed that enough audio data is ready.

## Request and security behavior

- No periodic request is sent to the cloud-drive provider to keep an account session alive.
- The existing next-track prefetch remains event-driven near the final 30 seconds of the current track.
- The metrics contain durations, status, provider, and media readiness state only. They do not log API tokens, passwords, raw download URLs, or file paths.
- Actual audio continues to stream directly from the source returned by Alist/OpenList. No audio bytes are relayed through Pages.
