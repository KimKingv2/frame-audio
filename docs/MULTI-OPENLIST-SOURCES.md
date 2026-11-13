# FRAME Audio - Four mutually exclusive sources

FRAME Audio has four possible sources that share one D1 catalogue and R2 artwork store:

1. **VPS Alist** - Pages Functions proxy.
2. **OpenList Worker** - Pages Functions proxy.
3. **Mobile Device Alist** - Pages Functions proxy.
4. **LAN OpenList** - browser direct to a device on the same LAN or through a private VPN route.

## Active-source isolation

- The last explicitly saved provider is restored on page load.
- Changing the dropdown only changes the pending selection. A source becomes active only after **Save settings and switch / LAN login** is pressed.
- The Test button always tests the saved active provider, never the pending dropdown selection.
- At startup only the saved active server-side provider may be tested. If LAN is active, the page waits for username/password login from a user gesture.
- An unconfigured active server provider is reported unavailable; the app does not silently fall back to a different provider.
- The settings endpoint reads environment bindings and returns endpoint configuration plus a credential-present flag; it does not contact any Alist/OpenList node.
- Server sources prefer dedicated username/password Secrets and automatically call `/api/auth/login`; legacy static Token Secrets remain a migration fallback until each provider passes testing.
- Provider JWTs are cached in the shared `MEDIA_AUTH_TOKEN_CACHE` KV binding with an expiry TTL, plus per-isolate memory. The generic cache prefix is `media-platform:provider-auth:v1`; separate media applications can reuse cached logins only when provider identity, base URL, username, key derivation and `Client-Id: media-platform-server-{provider}` all match. No credentials or JWTs are returned to browser JavaScript. The Mobile Device provider identity is `mobile-device`, and its stable Client-Id is `media-platform-server-mobile-device`.
- The diagnostic page lists all four providers without probing them. Users can select any 2–4 providers, including all four; only after the explicit Start test button is pressed are those selected providers temporarily activated for this diagnostic run, one at a time. The saved app-wide active provider is not changed. Unselected providers receive no API requests.
- VPS, Worker and Mobile Device requests include the explicit active provider ID. Unknown IDs are rejected rather than defaulting to VPS.
- Outside an explicitly started comparison, no inactive source receives list/get/login/range requests or next-track prefetch requests. During a comparison, only the 2–4 explicitly selected providers are contacted, in sequence; all remaining providers are untouched.

## Cloudflare Preview / Production values

Configure each Pages environment separately. For the Preview migration, create or select the shared KV namespace `media-platform-auth-cache` and bind it as `MEDIA_AUTH_TOKEN_CACHE`. Keep a separate namespace for Production. Add the service-account Secrets below, and keep legacy Token Secrets until every provider passes testing. Add these Mobile Device values:

| Name | Type |
|---|---|
| `ALIST_MOBILE_DEVICE_API_BASE_URL` | Variable |
| `ALIST_MOBILE_DEVICE_USERNAME` | Secret |
| `ALIST_MOBILE_DEVICE_PASSWORD` | Secret |

Existing settings:

| Source | URL Variable | Username Secret | Password Secret |
|---|---|---|---|
| VPS Alist | `ALIST_VPS_API_BASE_URL` | `ALIST_VPS_USERNAME` | `ALIST_VPS_PASSWORD` |
| OpenList Worker | `OPENLIST_WORKER_API_BASE_URL` | `OPENLIST_WORKER_USERNAME` | `OPENLIST_WORKER_PASSWORD` |
| Mobile Device Alist | `ALIST_MOBILE_DEVICE_API_BASE_URL` | `ALIST_MOBILE_DEVICE_USERNAME` | `ALIST_MOBILE_DEVICE_PASSWORD` |

`FRAME_AUDIO_API_ADMIN_TOKEN` remains a separate Secret for FRAME Audio's own private API gate. Upstream service credentials are read only by Pages Functions, while short-lived JWTs are cached in KV/memory; neither credentials nor JWTs are sent to browser JavaScript or written to D1/R2. Legacy Token Secrets remain supported only during migration. The Mobile Device endpoint must be an HTTPS URL reachable from Cloudflare Pages Functions; a private RFC1918 address on a home LAN is not reachable from Cloudflare without a suitable tunnel or public route.

## LAN OpenList username/password login

The browser calls `POST /api/auth/login` directly using the LAN URL, username and password, then uses the temporary JWT for `/api/fs/list` and `/api/fs/get`.

- Only the LAN base URL is stored in this browser's `localStorage`.
- Username, password and JWT are never stored in `localStorage`, D1 or Pages Secrets. The password field is cleared after login; the JWT stays in page memory only.
- Reloading requires login again. Switching away from LAN clears its in-memory JWT.
- LAN OpenList must allow CORS from the exact FRAME Audio origin for `POST, OPTIONS`, `Content-Type` and `Authorization`, including `/api/auth/login`, `/api/fs/list` and `/api/fs/get`.
- HTTP does not encrypt credentials on an untrusted Wi-Fi network. Use HTTPS or Tailscale/WireGuard when travelling or on public Wi-Fi.

## Audio delivery and IP visibility

HTML5 Audio still reads the active source's returned `raw_url` directly; Pages does not relay or transcode audio. The final cloud-drive download host sees the browser's public IP during direct playback or Range reads. Active-source isolation ensures only the selected Alist/OpenList node is asked for file information; it does not hide the browser IP from a direct cloud-drive `raw_url`. Hiding this IP requires audio bytes to be proxied through the active node, with bandwidth and latency trade-offs.

## Shared catalogue behavior

All four sources share the same Music and Podcast root paths, D1 tracks/folders/podcasts/scan checkpoints/listening history, and R2 artwork. Verify that each exposes the same absolute path layout before indexing or playing. Switching sources does not clear or rebuild D1/R2.


## Browser LAN troubleshooting

- `/lan-access-diagnostic.html` separates the browser permission state, a no-auth `GET /api/public/settings`, and the credentialed `POST /api/auth/login` preflight path.
- The diagnostic page performs no provider requests on page load. Each local request requires an explicit click. It does not read files, create download links, or contact the cloud-drive provider.
- Login diagnostics never print or persist the username, password, or returned JWT.
