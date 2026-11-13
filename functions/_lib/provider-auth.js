const hotTokens = new Map();
const pendingLogins = new Map();

const LOGIN_TIMEOUT_MS = 15000;
const CACHE_PREFIX = "media-platform:provider-auth:v1";
const CLIENT_ID_PREFIX = "media-platform-server";

function decodeJwtExpiry(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[1]) return 0;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function digestHex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function cacheKeyFor(provider, baseUrl, username) {
  const fingerprint = await digestHex(provider + "\n" + baseUrl + "\n" + username);
  return CACHE_PREFIX + ":" + provider + ":" + fingerprint;
}

function usableRecord(record) {
  const now = Date.now();
  return Boolean(
    record &&
    typeof record.token === "string" &&
    record.token.length > 20 &&
    Number.isFinite(Number(record.expiresAt)) &&
    Number.isFinite(Number(record.refreshAt)) &&
    Number(record.refreshAt) > now &&
    Number(record.expiresAt) > now
  );
}

async function readCachedToken(env, key) {
  const hot = hotTokens.get(key);
  if (usableRecord(hot)) return hot;
  if (hot) hotTokens.delete(key);

  const binding = env?.MEDIA_AUTH_TOKEN_CACHE;
  if (!binding || typeof binding.get !== "function") return null;

  try {
    const raw = await binding.get(key);
    if (!raw) return null;
    const record = JSON.parse(String(raw));
    if (!usableRecord(record)) return null;
    hotTokens.set(key, record);
    return record;
  } catch (cause) {
    console.warn("[FRAME Audio] Provider token KV read failed; using in-memory fallback", {
      name: String(cause?.name || "Error"),
      message: String(cause?.message || cause || "").slice(0, 120)
    });
    return null;
  }
}

async function writeCachedToken(env, key, record) {
  hotTokens.set(key, record);
  const binding = env?.MEDIA_AUTH_TOKEN_CACHE;
  if (!binding || typeof binding.put !== "function") return;

  const ttl = Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000));
  try {
    await binding.put(key, JSON.stringify(record), { expirationTtl: ttl });
  } catch (cause) {
    console.warn("[FRAME Audio] Provider token KV write failed; token remains in memory for this isolate", {
      name: String(cause?.name || "Error"),
      message: String(cause?.message || cause || "").slice(0, 120)
    });
  }
}

async function removeCachedToken(env, key) {
  hotTokens.delete(key);
  const binding = env?.MEDIA_AUTH_TOKEN_CACHE;
  if (!binding || typeof binding.delete !== "function") return;
  try {
    await binding.delete(key);
  } catch (cause) {
    console.warn("[FRAME Audio] Provider token KV delete failed", {
      name: String(cause?.name || "Error"),
      message: String(cause?.message || cause || "").slice(0, 120)
    });
  }
}

async function loginProvider(baseUrl, provider, username, password) {
  const target = new URL("api/auth/login", baseUrl + "/").href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

  try {
    const response = await fetch(target, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Client-Id": CLIENT_ID_PREFIX + "-" + provider
      },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error("登入 API 回傳重新導向，請檢查設定的 HTTPS API 網址。");
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("登入 API 回應不是有效 JSON。");
    }

    const token = String(payload?.data?.token || "").trim();
    if (!response.ok || Number(payload?.code) !== 200 || !token) {
      const reason = String(payload?.message || payload?.error || "").replace(/\s+/g, " ").slice(0, 180);
      throw new Error(
        "登入失敗（HTTP " + response.status + "）" +
        (reason ? "：" + reason : "。請檢查專用帳號與密碼。")
      );
    }

    const expiresAt = decodeJwtExpiry(token);
    if (!expiresAt || expiresAt <= Date.now() + 60000) {
      throw new Error("登入成功但 Token 未包含有效的未來到期時間，已拒絕快取。");
    }

    const lifetimeMs = expiresAt - Date.now();
    const refreshLeadMs = Math.min(15 * 60 * 1000, Math.max(60 * 1000, lifetimeMs * 0.05));
    return {
      token,
      expiresAt,
      refreshAt: expiresAt - refreshLeadMs,
      savedAt: Date.now()
    };
  } catch (cause) {
    if (cause?.name === "AbortError") {
      throw new Error("登入 API 請求逾時（" + Math.round(LOGIN_TIMEOUT_MS / 1000) + " 秒）。");
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Username/password login takes priority. A legacy static Token remains available
 * only as a temporary migration fallback.
 */
export async function getProviderToken(env, provider, baseUrl, profile, options = {}) {
  const username = String(profile?.username || "").trim();
  const password = String(profile?.password || "");
  const legacyToken = String(profile?.token || "").trim();

  if (Boolean(username) !== Boolean(password)) {
    throw new Error("帳號與密碼 Secrets 必須同時設定。");
  }

  if (!username && !password) {
    if (legacyToken) return { token: legacyToken, managed: false, source: "legacy-secret" };
    throw new Error("尚未設定服務帳號密碼或舊版 API Token Secret。");
  }

  const key = await cacheKeyFor(provider, baseUrl, username);
  if (options.forceRefresh) {
    await removeCachedToken(env, key);
  } else {
    const cached = await readCachedToken(env, key);
    if (cached) return { token: cached.token, managed: true, source: "cache", expiresAt: cached.expiresAt };
  }

  const pending = pendingLogins.get(key);
  if (pending) {
    const record = await pending;
    return { token: record.token, managed: true, source: "login", expiresAt: record.expiresAt };
  }

  const task = (async () => {
    const record = await loginProvider(baseUrl, provider, username, password);
    await writeCachedToken(env, key, record);
    return record;
  })();
  pendingLogins.set(key, task);
  try {
    const record = await task;
    return { token: record.token, managed: true, source: "login", expiresAt: record.expiresAt };
  } finally {
    if (pendingLogins.get(key) === task) pendingLogins.delete(key);
  }
}

export async function invalidateProviderToken(env, provider, baseUrl, profile) {
  const username = String(profile?.username || "").trim();
  const password = String(profile?.password || "");
  if (!username || !password) return;
  const key = await cacheKeyFor(provider, baseUrl, username);
  await removeCachedToken(env, key);
}
