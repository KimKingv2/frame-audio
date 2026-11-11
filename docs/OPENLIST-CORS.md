# FRAME Audio · VPS Alist CORS 設定

FRAME Audio runs in the browser at `https://frame-audio.pages.dev` and calls the VPS Alist API at `https://drive.kimkingv2.top` directly. The same VPS Alist source handles folder browsing, Music / Podcast scanning, file metadata reads and playback URL resolution.

## Required Production allowlist

Allow this exact Production origin:

```text
https://frame-audio.pages.dev
```

If the Preview deployment is used for testing, also allow:

```text
https://cf-preview.frame-audio.pages.dev
```

FRAME Audio calls:
- `POST /api/fs/list` to browse and scan folders.
- `POST /api/fs/get` to read file metadata and obtain temporary playback URLs.
- `GET` with a `Range` header to read bounded audio metadata ranges from the returned file URL.

The API CORS policy needs `POST`, `GET`, and `OPTIONS` methods and the `Authorization`, `Content-Type`, and `Range` request headers.

## Alist CORS policy

Configure the existing CORS section for the VPS Alist instance. Do not add a duplicate CORS key. The policy should allow these origins, methods and request headers:

```json
{
  "allow_origins": [
    "https://frame-audio.pages.dev",
    "https://cf-preview.frame-audio.pages.dev"
  ],
  "allow_methods": [
    "GET",
    "POST",
    "OPTIONS"
  ],
  "allow_headers": [
    "Authorization",
    "Content-Type",
    "Range"
  ]
}
```

The exact configuration file location depends on the Alist Docker volume mapping. Edit the existing configuration, then restart the Alist container if required by the installed version. Do not expose the API token in URLs or public files.

Do not use `*` for a private media library when an exact allowlist is available.

## Verify the preflight

Run this from a machine with access to the VPS Alist endpoint:

```bash
curl -i -X OPTIONS 'https://drive.kimkingv2.top/api/fs/list' \
  -H 'Origin: https://frame-audio.pages.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

The response must include:
- `Access-Control-Allow-Origin: https://frame-audio.pages.dev`
- `Access-Control-Allow-Methods` including `POST` and `OPTIONS`
- `Access-Control-Allow-Headers` including `authorization` and `content-type`

If headers are missing, check the Alist CORS setting and the Cloudflare Tunnel / reverse proxy. The proxy must pass `OPTIONS` to Alist or answer it with the same policy. Do not add a second, conflicting `Access-Control-Allow-Origin` header.

## Security and data boundaries

The browser uses `credentials: omit` and sends the VPS Alist API token in the `Authorization` header. Cookies are not required. Use an Alist account with read-only permissions for browsing and scanning.

Cloudflare D1 continues to store the catalogue, scan checkpoints, retry queues and listening history. Cloudflare R2 continues to store deduplicated artwork. Migrating the API source does not clear or rebuild those stores, and normal page load does not start a scan.
