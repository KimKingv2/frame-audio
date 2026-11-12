# FRAME Audio - Multi-source OpenList connections

FRAME Audio supports three interchangeable read-only file sources while keeping one shared D1 catalogue and R2 artwork store:

- VPS Alist: existing Pages Functions server-side proxy, using existing ALIST_VPS_API_BASE_URL / ALIST_VPS_API_TOKEN Cloudflare settings as fallbacks.
- OpenList Worker: Pages Functions server-side proxy to a second OpenList-compatible API.
- Phone-local OpenList: the browser on the phone calls its own loopback OpenList service directly. This source cannot be proxied by Cloudflare because the Cloudflare edge cannot reach a service bound to the phone's 127.0.0.1.

## Saved connection settings

Apply migrations/0004_connection_settings.sql to the existing frame-audio-catalog D1 database. Do not create a new D1 database and do not alter existing catalogue tables.

The VPS and Worker base URLs and tokens are stored together as AES-GCM ciphertext in D1. The encryption key is derived on the server from the existing FRAME_AUDIO_API_ADMIN_TOKEN / FRAME_AUDIO_ADMIN_TOKEN Secret. The settings API returns only base URLs and token-presence flags, never decrypted token values. If the internal admin Secret is rotated, open Settings and save the connection profiles again to re-encrypt them.

The phone-local profile is saved in that phone browser's localStorage because the browser must present its token directly to its local service. Anyone with access to that browser profile or same-origin page script can access that local token. Do not use this option with a token that grants more access than needed. The local token is never written to D1, R2, GitHub, or the server-side connection API.

When editing server profiles, leave a Token field blank to keep the already-saved value. Explicitly clear a token only when replacing it with a new value or when the profile should be disabled.

## Local OpenList requirements

For phone-local mode, enter the OpenList API base URL, typically a loopback URL such as http://127.0.0.1:5244 if that is the port configured on the phone. Use the actual port and base path of the local service.

The local OpenList must:
- Expose the Alist/OpenList-compatible POST /api/fs/list and POST /api/fs/get endpoints.
- Chrome 142 and later gates public-site requests to loopback behind a Local Network Access permission. Chrome 145 introduced the separate loopback-network permission for 127.0.0.1, localhost and ::1. The app therefore waits for the explicit Test current source button before its first local request; it does not probe a saved local endpoint at page load.
- Allow CORS from the exact FRAME Audio origin (both https://main.frame-audio.pages.dev for Preview and https://frame-audio.pages.dev for Production, if both are used).
- Allow Authorization and Content-Type request headers.
- For audio hosts used for tag inspection, allow cross-origin Range requests and expose Content-Range, Content-Length, and Accept-Ranges as needed.
- Return audio raw_url values reachable from the phone browser. The HTML5 audio element plays those URLs directly; Pages does not relay or transcode audio.

Chrome's Local Network Access rules apply to loopback too: FRAME Audio must be served over HTTPS and the user may need to grant loopback-network permission. For a private LAN address, Chrome 145+ uses local-network permission. Non-loopback HTTP addresses should not be used from the HTTPS FRAME Audio page; use HTTPS for LAN or remote addresses. Browser and Android-version behavior must be checked on the target phone.

## Shared catalogue behavior

All three source profiles use the same configured Music and Podcast root paths. D1 tracks, folders, podcasts, scan checkpoints, retries, listening progress and analytics remain shared. R2 artwork remains shared and content-addressed. Switching a source does not clear, recreate, migrate or automatically rescan D1/R2 data.

A source switch changes only folder listing, file-info lookup, metadata Range source and the raw audio URL resolved for new playback. Existing D1 entries continue to represent the same absolute paths. If different providers do not point to the same underlying files and paths, verify the mapping before indexing or playing.

## Existing server resources

- D1 database: frame-audio-catalog
- R2 bucket: frame-audio-artwork
- D1 binding: DB
- R2 binding: ARTWORKS
- Secret: FRAME_AUDIO_API_ADMIN_TOKEN or FRAME_AUDIO_ADMIN_TOKEN
- Existing VPS fallbacks: ALIST_VPS_API_BASE_URL / ALIST_VPS_API_TOKEN (also accepts legacy OPENLIST_BASE_URL / OPENLIST_API_TOKEN).

No VPS, DNS, Worker deployment, R2 or production configuration is changed by this code update.
