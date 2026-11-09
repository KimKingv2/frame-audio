# FRAME Audio · Cloudflare storage setup

FRAME Audio uses Pages Functions as its same-origin API, D1 for track/folder records, and R2 for deduplicated artwork. OpenList remains the read-only source for original audio files.

## Create Preview resources

In the same Cloudflare account as Pages, create:
- D1 database: frame-audio-catalog
- R2 bucket: frame-audio-artwork

Configure Preview first. Do not connect these to Production yet.

## Initialize D1

Open the D1 database SQL Console and execute all SQL in migrations/0001_catalog.sql. It creates tracks, folders, catalog_state and indexes. The migration is safe to re-run.

## Bind to Pages Preview

Workers & Pages → frame-audio → Settings → Bindings. Select Preview and add:
| Type | Variable name | Resource |
|---|---|---|
| D1 database | DB | frame-audio-catalog |
| R2 bucket | ARTWORKS | frame-audio-artwork |

Save and redeploy Preview for the bindings to take effect.

## Add the API secret

In the Pages Preview environment, add Secret FRAME_AUDIO_ADMIN_TOKEN. Generate a fresh random value of at least 32 random bytes. Do not reuse the OpenList token and do not put this value in GitHub.

The settings dialog holds this key in page memory only. It is not saved to localStorage, cookies or the URL.

## API

All endpoints require Authorization: Bearer <FRAME_AUDIO_ADMIN_TOKEN>.
- GET /api/catalog/status: check both bindings and show current track/folder counts.
- GET /api/catalog?kind=tracks&limit=100&offset=0: paginated tracks.
- POST /api/catalog: upsert up to 100 tracks in one batch.
- GET /api/catalog?kind=folders&limit=500&offset=0: paginated folder hierarchy.
- POST /api/catalog?kind=folders: upsert up to 500 folders.
- PUT /api/artwork/<sha256>: store a validated image in R2.
- GET /api/artwork/<sha256>: retrieve a stored artwork object.

There is deliberately no bulk-delete route. A partial scan must never erase an existing catalogue.

## Privacy

- Original audio remains in OpenList. The browser reads metadata and bounded HTTP Range segments directly; audio files are never uploaded to Cloudflare.
- Only track/folder metadata and embedded artwork are sent to D1/R2.
- OpenList token and Cloudflare API secret are separate and memory-only in the page.
- Page load does not scan the library. Writes are user-triggered.
- Only Preview bindings/secrets should be configured now. Keep Production unchanged.
