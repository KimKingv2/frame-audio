# FRAME Audio · Cloudflare storage, server-side secrets and deployment

FRAME Audio uses Cloudflare Pages Functions as its same-origin API, D1 for catalogue / scan / listening data, and R2 for deduplicated artwork. VPS Alist remains the read-only source for original audio files.

## Required resources

- D1 database: `frame-audio-catalog`
- R2 bucket: `frame-audio-artwork`
- Pages D1 binding: `DB`
- Pages R2 binding: `ARTWORKS`
- Secret: `FRAME_AUDIO_ADMIN_TOKEN`
- Secret: `OPENLIST_API_TOKEN`
- Variable: `OPENLIST_BASE_URL`

Keep using the existing D1 database and R2 bucket containing the Music and Podcast catalogue. Do not create replacement resources or run destructive SQL.

## D1 initialization

Run migrations in order only when the corresponding schema is not already present:

1. `migrations/0001_catalog.sql` — Music tracks, folders and scan checkpoints.
2. `migrations/0002_podcasts.sql` — Podcast shows and episodes.
3. `migrations/0003_listening.sql` — playback progress, per-episode Podcast playback speed and listening events.

The migrations are additive. Do not drop tables, clear catalogue rows, reset scan states, or replace the existing R2 bucket.

## Pages bindings and Secrets

In Cloudflare Dashboard, open **Workers & Pages → frame-audio → Settings → Variables and Secrets** (the exact tab label may vary slightly).

Configure the following separately for **Production** and **Preview**:

| Name | Type | Value |
|---|---|---|
| `OPENLIST_BASE_URL` | Variable | `https://drive.kimkingv2.top` |
| `OPENLIST_API_TOKEN` | Secret | The read-only VPS Alist API Token |
| `FRAME_AUDIO_ADMIN_TOKEN` | Secret | Keep the existing D1/R2 admin credential |

Do not paste any Secret into the website, JavaScript, GitHub, a URL, or a chat. Do not change the existing `FRAME_AUDIO_ADMIN_TOKEN` value while migrating. The new `OPENLIST_API_TOKEN` is a separate Pages Secret and should contain the read-only token currently used for VPS Alist.

Also verify the existing bindings in both environments:

- D1 binding `DB` → `frame-audio-catalog`
- R2 binding `ARTWORKS` → `frame-audio-artwork`

After saving environment values, trigger a new deployment of the relevant branch. Preview configuration does not automatically apply to Production.

## Cloudflare Access

Protect both production hostname `frame-audio.pages.dev` and the Preview hostname pattern `*.frame-audio.pages.dev` with Cloudflare Access. Restrict the Allow policy to the owner's exact email address. Pages middleware rejects API requests without the Access assertion header and injects the D1/R2 admin Secret into the request only on the server.

## Connection checks

Open the site and complete the Access email OTP login. The connection dialog should automatically test:

1. VPS Alist through the same-origin Pages Function routes `/api/openlist/list` and `/api/openlist/get`.
2. Cloudflare D1 and R2 through the existing catalogue status endpoint.

A successful status check reports Music track/folder counts, Podcast schema status and listening schema status. A missing `OPENLIST_API_TOKEN` or `OPENLIST_BASE_URL` returns an explicit server-side configuration error.

## API overview

- `POST /api/openlist/list`: server-side VPS Alist directory listing.
- `POST /api/openlist/get`: server-side VPS Alist file-info and temporary playback URL lookup.
- `GET /api/catalog?kind=tracks|folders`: paginated Music catalogue.
- `GET /api/catalog/podcasts?kind=shows|episodes`: paginated Podcast catalogue.
- `POST /api/listening`: playback progress and listening sessions.
- `PUT /api/artwork/<sha256>` / `GET /api/artwork/<sha256>`: private R2 artwork.

All API routes are protected by Cloudflare Access. The Pages middleware overwrites any browser Authorization header with the server-held `FRAME_AUDIO_ADMIN_TOKEN` before existing private D1/R2 handlers run.

## Media delivery and privacy

- The browser receives only the temporary `raw_url` needed for playback and metadata reads.
- HTML5 Audio connects directly to the Alist-provided `raw_url`; the full audio stream is not proxied or transcoded by Cloudflare.
- Bounded metadata Range requests still go from the browser to the final raw media host. That media host may need CORS permission for the Production origin when using Range-based metadata inspection or Web Audio EQ.
- Browsing and file-info API requests are server-to-server and no longer require Alist API CORS preflight from the browser.
- Indexing is user-triggered. Page load does not scan OpenList.
- No D1 data or R2 artwork is migrated, reset, or rebuilt by this credential change.
