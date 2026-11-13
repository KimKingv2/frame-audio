# FRAME Audio · Cloudflare storage, server-side credentials and deployment

FRAME Audio uses Pages Functions as its same-origin API, D1 for catalogue / scan / listening data, and R2 for deduplicated artwork. VPS Alist, OpenList Worker and phone-browser LAN OpenList are interchangeable read-only sources.

## Required Cloudflare resources

- D1 database: `frame-audio-catalog`, binding `DB`
- R2 bucket: `frame-audio-artwork`, binding `ARTWORKS`
- Secret: `FRAME_AUDIO_API_ADMIN_TOKEN` (FRAME Audio internal API admin gate)
- Shared KV namespace: `media-platform-auth-cache`; binding variable: `MEDIA_AUTH_TOKEN_CACHE` (short-lived upstream JWT cache shared by media apps)
- Secrets: `ALIST_VPS_USERNAME`, `ALIST_VPS_PASSWORD`; Text: `ALIST_VPS_API_BASE_URL`
- Secrets: `OPENLIST_WORKER_USERNAME`, `OPENLIST_WORKER_PASSWORD`; Text: `OPENLIST_WORKER_API_BASE_URL`
- Secrets: `ALIST_K40_USERNAME`, `ALIST_K40_PASSWORD`; Text: `ALIST_K40_API_BASE_URL`

VPS / Worker / K40 service-account credentials are read only by Pages Functions. Functions obtain upstream JWTs through each provider login API. JWTs are cached in the optional `MEDIA_AUTH_TOKEN_CACHE` KV binding with an expiry TTL and in isolate memory; they are never sent to the browser or stored in D1/R2. Without KV, the application falls back to isolate-memory caching and re-authenticates after a cold start. The existing `FRAME_AUDIO_API_ADMIN_TOKEN` remains a separate application-level gate; do not replace it with an Alist Token or combine the values.

## Environment settings

Open **Workers & Pages → frame-audio → Settings → Variables and Secrets**. Apply the new automatic-login credentials to **Preview first**. Keep Production unchanged until all three Preview sources pass testing:

| Name | Type | Value |
|---|---|---|
| `ALIST_VPS_API_BASE_URL` | Text | `https://drive.kimkingv2.top` |
| `ALIST_VPS_USERNAME` | Secret | Dedicated read-only VPS Alist username |
| `ALIST_VPS_PASSWORD` | Secret | Dedicated read-only VPS Alist password |
| `OPENLIST_WORKER_API_BASE_URL` | Text | Your OpenList Worker API base URL |
| `OPENLIST_WORKER_USERNAME` | Secret | Dedicated OpenList Worker username |
| `OPENLIST_WORKER_PASSWORD` | Secret | Dedicated OpenList Worker password |
| `ALIST_K40_API_BASE_URL` | Text | K40 Alist HTTPS API base URL |
| `ALIST_K40_USERNAME` | Secret | Dedicated K40 Alist username |
| `ALIST_K40_PASSWORD` | Secret | Dedicated K40 Alist password |
| `FRAME_AUDIO_API_ADMIN_TOKEN` | Secret | Existing FRAME Audio internal API admin Secret |

The new username/password Secrets take priority and enable automatic server-side login and renewal. During migration, existing `ALIST_VPS_API_TOKEN`, `OPENLIST_WORKER_API_TOKEN`, `ALIST_K40_API_TOKEN` and legacy aliases remain supported as fallback. Do not remove old Token Secrets until each source has passed Preview tests. Never paste Secrets into the website, GitHub, URLs or chat. The site shows only whether a profile is configured and never reveals credentials or JWTs.

Keep using the existing D1 and R2 resources. Under **Settings → Bindings → KV namespace bindings**, create or select the shared Preview namespace `media-platform-auth-cache` and bind it with variable name `MEDIA_AUTH_TOKEN_CACHE` in every media application's Preview project. This Preview namespace may be shared by trusted Preview media apps, but must remain separate from Production. The application still works without KV using per-isolate memory cache, but cold starts will perform a new login. To reuse a JWT across separate media applications, they must use the same namespace, identical provider identity/base URL/username cache-key derivation, the `media-platform:provider-auth:v1` key prefix, and matching `Client-Id: media-platform-server-{provider}` on both login and API requests. Add the matching Production credentials and a separate Production KV binding only after Preview has passed testing. After adding or changing environment values or bindings, redeploy the matching branch.

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
