const SETTINGS_ID = "openlist";
const AAD = new TextEncoder().encode("FRAME Audio OpenList connection profiles v1");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fallbackProfiles(env) {
  return {
    vps: {
      baseUrl: String(env.ALIST_VPS_API_BASE_URL || env.OPENLIST_BASE_URL || "").trim(),
      token: String(env.ALIST_VPS_API_TOKEN || env.OPENLIST_API_TOKEN || "").trim()
    },
    worker: {
      baseUrl: String(env.ALIST_WORKER_API_BASE_URL || env.OPENLIST_WORKER_API_BASE_URL || "").trim(),
      token: String(env.ALIST_WORKER_API_TOKEN || env.OPENLIST_WORKER_API_TOKEN || "").trim()
    }
  };
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function encryptionKey(env) {
  const secret = String(env.FRAME_AUDIO_API_ADMIN_TOKEN || env.FRAME_AUDIO_ADMIN_TOKEN || "").trim();
  if (!secret) throw new Error("FRAME Audio 內部管理 Secret 尚未設定，無法解密連線設定。");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("FRAME_AUDIO_CONNECTION_SETTINGS_V1\u0000" + secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function decryptProfiles(env, row) {
  const key = await encryptionKey(env);
  const clear = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: fromBase64(row.nonce),
    additionalData: AAD
  }, key, fromBase64(row.encrypted_value));
  const saved = JSON.parse(decoder.decode(clear));
  const defaults = fallbackProfiles(env);
  return {
    vps: { ...defaults.vps, ...(saved?.vps || {}) },
    worker: { ...defaults.worker, ...(saved?.worker || {}) }
  };
}

function normalizeServerBase(value, label) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); }
  catch { throw new Error(label + "網址格式不正確。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(label + "必須是 HTTPS 網址，且不能包含帳密、查詢參數或片段。");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function readConnectionProfiles(env) {
  const defaults = fallbackProfiles(env);
  if (!env.DB || typeof env.DB.prepare !== "function") {
    return { profiles: defaults, settingsTableReady: false };
  }
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT encrypted_value, nonce FROM connection_settings WHERE id=?"
    ).bind(SETTINGS_ID).first();
  } catch {
    return { profiles: defaults, settingsTableReady: false };
  }
  if (!row) return { profiles: defaults, settingsTableReady: true };
  try {
    return { profiles: await decryptProfiles(env, row), settingsTableReady: true };
  } catch (cause) {
    throw new Error(cause?.message || "連線設定解密失敗。若剛更換 FRAME_AUDIO_ADMIN_TOKEN，請重新保存連線設定。");
  }
}

export function publicConnectionProfiles(profiles) {
  const output = {};
  for (const name of ["vps", "worker"]) {
    const profile = profiles?.[name] || {};
    const baseUrl = String(profile.baseUrl || "");
    const hasToken = Boolean(String(profile.token || ""));
    output[name] = { baseUrl, hasToken, configured: Boolean(baseUrl && hasToken) };
  }
  return output;
}

export async function saveConnectionProfiles(env, incoming) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    throw new Error("D1 binding DB 尚未設定。");
  }
  const current = await readConnectionProfiles(env);
  if (!current.settingsTableReady) {
    throw new Error("連線設定資料表尚未初始化。請先在 D1 執行 migrations/0004_connection_settings.sql。");
  }
  const next = {
    vps: { ...current.profiles.vps },
    worker: { ...current.profiles.worker }
  };
  for (const name of ["vps", "worker"]) {
    const value = incoming?.[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (Object.prototype.hasOwnProperty.call(value, "baseUrl")) {
      next[name].baseUrl = normalizeServerBase(value.baseUrl, name === "vps" ? "VPS Alist " : "OpenList Worker ");
    }
    if (value.clearToken === true) next[name].token = "";
    else if (typeof value.token === "string" && value.token.trim()) next[name].token = value.token.trim();
  }

  const key = await encryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: AAD
  }, key, encoder.encode(JSON.stringify(next)));
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO connection_settings (id, encrypted_value, nonce, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET encrypted_value=excluded.encrypted_value, nonce=excluded.nonce, updated_at=excluded.updated_at"
  ).bind(SETTINGS_ID, toBase64(new Uint8Array(encrypted)), toBase64(nonce), now).run();
  return next;
}
