# FRAME Audio · Cloudflare storage setup

FRAME Audio uses Pages Functions as its same-origin API, D1 for track/folder records and resumable scan checkpoints, and R2 for deduplicated artwork. OpenList remains the read-only source for original audio files.

## Preview resources

In the same Cloudflare account as Pages, create:
- D1 database: `frame-audio-catalog`
- R2 bucket: `frame-audio-artwork`

Configure Preview first. Do not connect these to Production yet.

## Initialize D1

Open the D1 database SQL Console and execute all SQL in `migrations/0001_catalog.sql`. It creates `tracks`, `folders`, `catalog_state` and indexes. The migration is safe to re-run.

## Bind to Pages Preview

Workers & Pages → frame-audio → Settings → Bindings. Select Preview and add:

| Type | Variable name | Resource |
|---|---|---|
| D1 database | `DB` | `frame-audio-catalog` |
| R2 bucket | `ARTWORKS` | `frame-audio-artwork` |

Save and redeploy Preview for the bindings to take effect.

## Add the API secret

In the Pages Preview environment, add Secret `FRAME_AUDIO_ADMIN_TOKEN`. Generate a fresh random value of at least 32 random bytes. Do not reuse the OpenList token and do not put this value in GitHub.

The settings dialog holds this key in page memory only. It is not saved to localStorage, cookies or the URL. After editing the Secret, redeploy Preview so the active Pages deployment receives the new value.

## API

All private endpoints require `Authorization: Bearer <FRAME_AUDIO_ADMIN_TOKEN>`.

- `GET /api/catalog/status`: check bindings and show current track/folder counts.
- `GET /api/catalog?kind=tracks&limit=100&offset=0`: paginated tracks.
- `POST /api/catalog`: upsert up to 100 tracks in one batch.
- `POST /api/catalog/folders/rebuild`: rebuild the selected completed folder hierarchy from folder paths and existing D1 track paths; upsert is idempotent and does not delete old rows.
- `POST /api/catalog/lookup`: look up up to 100 paths and return file size / modified time for incremental comparison.
- `GET /api/catalog/state?key=music_scan_<sha256>`: read one scan checkpoint.
- `POST /api/catalog/state`: save the scan checkpoint in `catalog_state`.
- `GET /api/catalog?kind=folders&limit=500&offset=0`: paginated folder hierarchy.
- `POST /api/catalog?kind=folders`: upsert up to 500 folder records.
- `PUT /api/artwork/<sha256>`: store a validated image in R2.
- `GET /api/artwork/<sha256>`: retrieve a stored artwork object.

There is deliberately no bulk-delete route. A partial scan never erases an existing catalogue.

## Browser batch indexing

1. Open the Preview site and connect the Music root in OpenList.
2. Test Cloudflare storage using the Preview admin secret.
3. Navigate to the directory that should be the Music scan root (for example, `/中國移動雲盤/Kim King/03 Music`).
4. Click **開始／繼續建立歌曲與資料夾索引**.
5. The browser recursively walks subfolders, reads audio tags with bounded HTTP Range requests, stores track metadata in D1, and stores embedded artwork in R2.
6. Click the same button again to continue the next batch. The cursor is stored in D1 and survives page reloads. The Pause button stops after the current item and checkpoints the cursor.

Each batch is limited to 500 successful track writes, 500 directory entries, 500 completed folders and 7,500 seconds (2 hours 5 minutes). If a limit is reached while a directory is still active, the current page/item cursor remains saved and the UI shows the exact resume position and stop reason. Unchanged tracks are skipped when the source provides a usable modification time. Each changed/new track is attempted up to 20 times (first attempt plus 19 retries); retries re-fetch file info and restart bounded metadata reading. Authentication and permission errors stop immediately. After the entire selected tree is scanned, the browser calls `POST /api/catalog/folders/rebuild`; the function derives deterministic folder IDs, direct track membership, child-folder links and recursive track counts from the completed folder-path list and D1 track paths. Folder records are upserted in batches and existing rows are never bulk-deleted.

Metadata Range reads use 256 KiB chunks to reduce high-latency request round trips. The total transfer limit remains 16 MiB per audio file, and a per-file time limit is still enforced. Larger chunks can read some bytes beyond the parser's immediate need, so the tradeoff is deliberately bounded. The folder hierarchy is now persisted in D1 after a root scan completes. The folder browsing / playlist UI is a separate follow-up phase.

## Privacy

- Original audio remains in OpenList. The browser reads bounded HTTP Range segments directly; audio files are never uploaded to Cloudflare.
- Track metadata and embedded artwork are sent to D1/R2 only after the user starts indexing.
- OpenList token and Cloudflare admin secret are separate and memory-only in the page.
- Page load does not scan the library. All writes are user-triggered.
- Only Preview bindings/secrets should be configured now. Keep Production unchanged.
