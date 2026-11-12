# FRAME Audio · Cloudflare storage, server-side credentials and deployment

FRAME Audio uses Pages Functions as its same-origin API, D1 for catalogue / scan / listening data, and R2 for deduplicated artwork. VPS Alist, OpenList Worker and phone-browser LAN OpenList are interchangeable read-only sources.

## Required Cloudflare resources

- D1 database: `frame-audio-catalog`, binding `DB`
- R2 bucket: `frame-audio-artwork`, binding `ARTWORKS`
- Secret: `FRAME_AUDIO_API_ADMIN_TOKEN` (FRAME Audio internal API admin gate)
- Secret: `ALIST_VPS_API_TOKEN`; Text: `ALIST_VPS_API_BASE_URL`
- Secret: `OPENLIST_WORKER_API_TOKEN`; Text: `OPENLIST_WORKER_API_BASE_URL`

VPS / Worker settings are fixed in Cloudflare Pages **Variables and Secrets** and read only by Pages Functions. Their Tokens are never sent to the browser and are not stored in D1. The existing `FRAME_AUDIO_API_ADMIN_TOKEN` remains a separate application-level gate; do not replace it with an Alist Token or combine the values.

## Environment settings

Open **Workers & Pages → frame-audio → Settings → Variables and Secrets**. Set the following independently for Preview and Production:

| Name | Type | Value |
|---|---|---|
| `ALIST_VPS_API_BASE_URL` | Text | `https://drive.kimkingv2.top` |
| `ALIST_VPS_API_TOKEN` | Secret | The read-only VPS Alist API Token |
| `OPENLIST_WORKER_API_BASE_URL` | Text | Your OpenList Worker API base URL |
| `OPENLIST_WORKER_API_TOKEN` | Secret | The OpenList Worker API Token |
| `FRAME_AUDIO_API_ADMIN_TOKEN` | Secret | Existing FRAME Audio internal API admin Secret |

Legacy VPS aliases `OPENLIST_BASE_URL` / `OPENLIST_API_TOKEN` and Worker aliases `ALIST_WORKER_API_BASE_URL` / `ALIST_WORKER_API_TOKEN` remain supported. Use `OPENLIST_WORKER_API_BASE_URL` and `OPENLIST_WORKER_API_TOKEN` as the primary Worker settings. Never paste Secrets into the website, GitHub, URLs or chat. The site shows only whether a profile is configured and never reveals its Token.

Keep using the existing D1 and R2 resources. Preview and Production values are independent. After adding or changing environment values, redeploy the matching branch.

## D1 migrations

Run only the active migrations, in order, when the corresponding schema is not already present:

1. `migrations/0001_catalog.sql` — Music tracks, folders and scan checkpoints.
2. `migrations/0002_podcasts.sql` — Podcast shows and episodes.
3. `migrations/0003_listening.sql` — playback progress, Podcast playback speed and listening events.

`migrations/0004_connection_settings.sql` is retired/no-op and is not required. The previous D1 credential-storage approach has been removed. If an earlier test created an unused `connection_settings` table, leave it untouched; the current application ignores it.

## Cloudflare Access and APIs

Protect `frame-audio.pages.dev` and the Preview hostname pattern `*.frame-audio.pages.dev` with Cloudflare Access. Pages middleware rejects API requests without the Access assertion and injects the FRAME Audio admin Secret only on the server.

- `POST /api/openlist/list` and `POST /api/openlist/get`: server-side selected VPS Alist / OpenList Worker requests.
- `GET /api/settings/connections`: read-only base URL and configured-status metadata; never returns Tokens and does not accept writes.
- D1 / R2 catalogue and artwork endpoints continue using existing bindings.

## LAN-direct source

The phone browser calls the separate LAN OpenList device directly. Its URL and Token are stored only in the phone browser's local storage. The request bypasses Pages, D1 and R2. Use a least-privilege Token; plain HTTP does not encrypt the Authorization header over Wi-Fi, so use a trusted network and prefer LAN HTTPS where available. Allow the exact FRAME Audio Preview / Production origins in LAN OpenList CORS, including `Authorization` and `Content-Type`; Chrome may request Local Network Access permission.

## Media delivery

HTML5 Audio connects directly to the Alist-provided `raw_url`; Cloudflare does not proxy or transcode the full audio stream. Bounded metadata Range requests go from the browser to the final raw media host, which may need CORS. VPS / Worker API requests are server-to-server and do not require Alist API browser CORS. Indexing remains user-triggered. No catalogue data or R2 artwork is migrated, reset or rebuilt by this credential change.
