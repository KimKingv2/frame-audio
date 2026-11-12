# FRAME Audio - Multi-source OpenList connections

FRAME Audio supports three interchangeable read-only sources and shares one D1 catalogue / R2 artwork store:

- **VPS Alist:** Pages Functions proxy. URL and Token come from Cloudflare environment bindings.
- **OpenList Worker:** Pages Functions proxy. URL and Token come from Cloudflare environment bindings.
- **LAN OpenList:** the phone browser directly calls a separate device on the same private network, for example `http://192.168.31.xx:5244`.

## VPS Alist and Worker credentials

Set four values in Cloudflare Pages → Settings → Variables and Secrets, separately for Preview and Production:

| Name | Type |
|---|---|
| `ALIST_VPS_API_BASE_URL` | Text / Variable |
| `ALIST_VPS_API_TOKEN` | Secret |
| `OPENLIST_WORKER_API_BASE_URL` | Text / Variable |
| `OPENLIST_WORKER_API_TOKEN` | Secret |

`FRAME_AUDIO_API_ADMIN_TOKEN` remains a separate Secret for FRAME Audio's own private API gate. Do not reuse it as an Alist Token.

Pages Functions read the server credentials for each request. The browser receives only base URLs and boolean status fields such as `hasToken`, never the Tokens. The settings page cannot write server credentials, and no VPS / Worker credential is stored in D1. Migration `0004_connection_settings.sql` is retired/no-op and is not required. Any old unused `connection_settings` table is left untouched and ignored.

Legacy VPS aliases `OPENLIST_BASE_URL` / `OPENLIST_API_TOKEN` and Worker aliases `ALIST_WORKER_API_BASE_URL` / `ALIST_WORKER_API_TOKEN` remain accepted. Use `OPENLIST_WORKER_API_BASE_URL` and `OPENLIST_WORKER_API_TOKEN` as the primary Worker settings.

## LAN-direct OpenList

Enter the LAN OpenList URL and Token on the phone. Replace the example IP with the actual address and port of the other device running OpenList.

The LAN profile is stored in the phone browser's `localStorage` because the browser attaches its Token to direct private-network requests. Use a read-only / least-privilege Token. Plain HTTP does not encrypt Authorization over Wi-Fi, so use a trusted network and prefer HTTPS on the LAN. The LAN Token is not sent through Pages, D1, R2 or the server-side connection API.

LAN OpenList must expose `POST /api/fs/list` and `POST /api/fs/get`, allow CORS from the exact FRAME Audio origin, allow `Authorization` and `Content-Type`, and return `raw_url` values reachable from the phone browser. Metadata Range reads also require suitable CORS headers. HTML5 Audio connects directly to `raw_url`; Pages does not relay or transcode audio.

The app waits for the explicit Test current source button before its first LAN request; it does not probe a saved LAN endpoint at page load. Chrome may require Local Network Access permission for public HTTPS pages contacting private LAN addresses.

## Shared catalogue behavior

All three sources use the same configured Music and Podcast root paths. D1 tracks, folders, podcasts, scan checkpoints, retries, listening progress and analytics remain shared. R2 artwork remains shared. Switching sources does not clear or rebuild D1/R2 data. Verify that providers expose the same absolute path layout before indexing or playing.
