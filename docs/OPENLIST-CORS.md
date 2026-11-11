# FRAME Audio · VPS Alist and media CORS

FRAME Audio now separates private API access from media delivery:

1. Folder listing and file-info lookups use same-origin Pages Functions routes. Cloudflare Pages reads the VPS Alist API token from the `OPENLIST_API_TOKEN` Secret and calls Alist server-to-server. The browser no longer sends an Alist API token to the VPS API and no longer needs Alist API CORS permissions for `/api/fs/list` or `/api/fs/get`.
2. Playback and bounded media Range reads still use the temporary `raw_url` returned by Alist. The browser connects directly to that URL. This is intentional: Pages does not proxy or transcode the audio stream.

## When CORS is still required

The standard HTML5 audio element can play a cross-origin media URL without exposing its bytes to JavaScript. However, FRAME Audio's metadata inspector and Web Audio equalizer use browser Fetch with Range requests. For these features, the **final media host** reached by the Alist `raw_url` must allow the Production origin:

```text
https://frame-audio.pages.dev
```

If the media URL redirects through `drive.kimkingv2.top`, that host must allow the origin. If it redirects to a cloud-drive CDN, CORS must be supported by that final CDN host as well. A CORS setting on the Alist API hostname cannot override a missing CORS header from a different final media host.

For Preview tests, also allow the applicable Preview origin, for example:

```text
https://cf-preview.frame-audio.pages.dev
```

For bounded media Range requests, the media host should allow `GET`, `OPTIONS`, the `Range` request header, and expose `Content-Range`, `Content-Length`, and `Accept-Ranges` when available. The browser sends no Alist API token on these media requests; the temporary signed `raw_url` is the authorization mechanism returned by Alist.

## Security boundary

Do not put the Alist API token in a query string, media URL, browser storage or public source code. Pages Functions obtain the API token only from the server-side Secret. Keep Cloudflare Access enabled for both the Production hostname and Preview hostnames.
