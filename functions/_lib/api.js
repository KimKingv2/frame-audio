export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }});
}
export function error(message, status = 400) { return json({ ok: false, error: message }, status); }
export async function requireAdmin(request, env) {
  // Match the client-side trim: pasted secrets can carry a trailing newline.
  const expected = String(env.FRAME_AUDIO_API_ADMIN_TOKEN || env.FRAME_AUDIO_ADMIN_TOKEN || "").trim();
  if (!expected) return error("Cloudflare 尚未設定 FRAME_AUDIO_API_ADMIN_TOKEN。", 503);
  const supplied = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!supplied || supplied.length !== expected.length) return error("Cloudflare 管理金鑰不正確。", 401);
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0 ? null : error("Cloudflare 管理金鑰不正確。", 401);
}
export function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
export async function readJson(request, maxBytes = 1000000) {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) throw new Error("Request body 超過大小限制。");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("Request body 超過大小限制。");
  try { return JSON.parse(raw); } catch { throw new Error("Request body 不是有效 JSON。"); }
}
