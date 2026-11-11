import { error } from "./_lib/api.js";

export async function onRequest(context) {
  const { request, env } = context;
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/api/")) return context.next();

  // Cloudflare Access authenticates the visitor at the edge and injects this
  // assertion after successful authentication. Browser Bearer values are
  // always replaced before any private Pages Function receives the request.
  if (!request.headers.get("Cf-Access-Jwt-Assertion")) {
    return error("Cloudflare Access 驗證未完成，請重新登入後再試。", 403);
  }

  const adminToken = String(env.FRAME_AUDIO_API_ADMIN_TOKEN || env.FRAME_AUDIO_ADMIN_TOKEN || "").trim();
  if (!adminToken) {
    return error("Cloudflare 尚未設定 FRAME_AUDIO_API_ADMIN_TOKEN Secret。", 503);
  }

  const headers = new Headers(request.headers);
  headers.set("Authorization", "Bearer " + adminToken);
  return context.next(new Request(request, { headers }));
}
