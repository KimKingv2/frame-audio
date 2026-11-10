# FRAME Audio · Cloudflare storage and deployment

FRAME Audio uses Cloudflare Pages Functions as its same-origin API, D1 for catalogue / scan / listening data, and R2 for deduplicated artwork. OpenList remains the read-only source for original audio files.

## Required resources

- D1 database: `frame-audio-catalog`
- R2 bucket: `frame-audio-artwork`
- Pages D1 binding: `DB`
- Pages R2 binding: `ARTWORKS`
- Pages Secret: `FRAME_AUDIO_ADMIN_TOKEN`

Use the same existing D1 database and R2 bucket that contain the scanned Music and Podcast catalogue. Do not create a replacement database for the release and do not run any destructive SQL.

## D1 initialization

Run the migrations in order against the existing `frame-audio-catalog` database:

1. `migrations/0001_catalog.sql` — Music tracks, folders and scan checkpoints.
2. `migrations/0002_podcasts.sql` — Podcast shows and episodes.
3. `migrations/0003_listening.sql` — playback progress, per-episode Podcast playback speed and listening events.

Each migration uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. They are additive and can be re-run. Migration 0003 does not alter the existing Music or Podcast catalogue tables and does not clear scan states or artwork.

If 0001 and 0002 have already been applied, execute only the complete SQL in `migrations/0003_listening.sql`.

## Bindings and Secret

In Cloudflare Dashboard, open Workers & Pages → `frame-audio` → Settings → Bindings.

For both Production and Preview, verify the intended resources:
- D1 database binding named `DB` → `frame-audio-catalog`
- R2 bucket binding named `ARTWORKS` → `frame-audio-artwork`

Set Secret `FRAME_AUDIO_ADMIN_TOKEN` separately for Production and Preview. Use a strong random value and do not put it in GitHub. The OpenList API Token is a different credential and is entered in the app at runtime.

Save the environment settings and redeploy the relevant branch after changing bindings or secrets. Do not assume Preview settings automatically apply to Production.

## Connection check

Open FRAME Audio, choose **連接 OpenList**, enter the OpenList API Token and Cloudflare management secret, then:
1. Test OpenList access.
2. Test Cloudflare storage.
3. Confirm that Music, Podcast and listening schema status are all initialized.
4. Confirm the Music track count, Podcast show/episode counts and R2 connection are sensible.

The unauthenticated diagnostics endpoint `GET /api/catalog/status?diagnostics=1` returns only the Pages branch and presence flags for the admin token, D1 and R2. It never returns credential values or catalogue content.

## API overview

- `GET /api/catalog?kind=tracks|folders`: paginated Music catalogue.
- `GET /api/catalog/podcasts?kind=shows|episodes`: paginated Podcast catalogue.
- `GET /api/catalog/retries` and `GET /api/catalog/podcasts/retries`: independent Music / Podcast error lists.
- `POST /api/listening`: update playback progress or one listening session.
- `GET /api/listening?view=continue`: unfinished saved Podcast positions.
- `GET /api/listening?view=report`: period-based listening analytics.
- `POST /api/catalog/relink`: move stale path history to a successfully indexed replacement item.
- `PUT /api/artwork/<sha256>` / `GET /api/artwork/<sha256>`: private R2 artwork.

All private endpoints require `Authorization: Bearer <FRAME_AUDIO_ADMIN_TOKEN>`.

## Privacy and retention

- Full audio is never uploaded to D1 or R2.
- Original audio files are not moved, renamed, or modified by FRAME Audio.
- Indexing is user-triggered; page load does not scan OpenList.
- Music and Podcast missing files are not automatically deleted from D1.
- Listening history is retained in D1 until the user explicitly changes the data retention policy.
- API tokens and temporary playback URLs are not committed to source control.


## OpenList CORS

Before the browser can read the OpenList directory, configure the exact Production origin, allowed methods and request headers in the OpenList server's CORS policy. See [OPENLIST-CORS.md](OPENLIST-CORS.md). OpenList config changes require a service/container restart.
