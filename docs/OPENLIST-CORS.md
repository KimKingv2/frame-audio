# FRAME Audio · OpenList CORS 設定

FRAME Audio runs in the browser at `https://frame-audio.pages.dev` and calls the OpenList API at `https://openlist.kimkingv2.top` directly. Because these are different origins, OpenList must answer the browser's CORS preflight request.

## Required Production allowlist

For the Production site, allow this exact origin:

```text
https://frame-audio.pages.dev
```

FRAME Audio calls:
- `POST /api/fs/list` to browse folders.
- `POST /api/fs/get` to read file metadata and playback URLs.
- `GET` with a `Range` header to read bounded audio metadata ranges (and later the selected audio source).

The OpenList CORS policy therefore needs the `POST`, `GET`, and `OPTIONS` methods and the `Authorization`, `Content-Type`, and `Range` request headers.

## OpenList config.json

Edit the existing `cors` section in OpenList's `data/config.json`. Do not add a duplicate `cors` key. Use this policy for Production:

```json
"cors": {
  "allow_origins": [
    "https://frame-audio.pages.dev"
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

If the Preview site also needs to connect, add its exact origin as a second entry:

```json
"https://cf-preview.frame-audio.pages.dev"
```

Do not use `*` for a private media library when an exact allowlist is available.

Typical config locations:
- Linux one-click installation: `/opt/openlist/data/config.json`
- Manual Linux installation: `<openlist directory>/data/config.json`
- Docker: the mounted OpenList data directory's `config.json`

After saving the file, restart the OpenList service/container. OpenList reads configuration at startup.

## Verify the preflight

Run this from a machine with access to the OpenList host:

```bash
curl -i -X OPTIONS 'https://openlist.kimkingv2.top/api/fs/list' \
  -H 'Origin: https://frame-audio.pages.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

The response must include:
- `Access-Control-Allow-Origin: https://frame-audio.pages.dev`
- `Access-Control-Allow-Methods` including `POST` and `OPTIONS`
- `Access-Control-Allow-Headers` including `authorization` and `content-type`

If these headers are missing even after the OpenList restart, check the reverse proxy / CDN in front of OpenList. The proxy must forward `OPTIONS` to OpenList or answer it with the same allow-origin, allow-methods and allow-headers policy. Do not add a second, conflicting `Access-Control-Allow-Origin` header.

## Security boundary

The browser uses `credentials: omit` and supplies the OpenList API token in the `Authorization` header. Cookies are not required. The allowlist should contain only the FRAME Audio Production origin and any explicitly used Preview origin.
