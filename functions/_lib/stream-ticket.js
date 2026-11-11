const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function signingKey(env) {
  const secret = String(env.FRAME_AUDIO_API_ADMIN_TOKEN || env.FRAME_AUDIO_ADMIN_TOKEN || "").trim();
  if (!secret) throw new Error("Stream signing secret is not configured.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createStreamTicket(env, rawUrl) {
  let target;
  try { target = new URL(rawUrl); } catch { return null; }
  if (target.protocol !== "https:" || target.username || target.password) return null;

  const payload = {
    url: target.href,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await signingKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return encodedPayload + "." + encodeBase64Url(new Uint8Array(signature));
}

export async function verifyStreamTicket(env, ticket) {
  if (typeof ticket !== "string" || ticket.length > 24_000) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const key = await signingKey(env);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(parts[1]),
      encoder.encode(parts[0])
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(decodeBase64Url(parts[0])));
    if (!payload || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
    const target = new URL(String(payload.url || ""));
    if (target.protocol !== "https:" || target.username || target.password) return null;
    return target.href;
  } catch {
    return null;
  }
}
