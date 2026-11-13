import { error, isObject, json } from "./api.js";
import { readConnectionProfiles } from "./connection-settings.js";
import { getProviderToken, invalidateProviderToken } from "./provider-auth.js";

function normalizeBase(raw, label) {
  if (!raw) return { response: error("尚未設定 " + label + " API 網址。", 503) };
  let url;
  try { url = new URL(raw); }
  catch { return { response: error(label + " API 網址格式不正確。", 503) }; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return { response: error(label + " API 網址必須是沒有帳密、查詢參數或片段的 HTTPS 網址。", 503) };
  }
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, "") };
}

export function validOpenListPath(value) {
  return typeof value === "string" && value.length <= 4096 &&
    value.startsWith("/") && !value.split("").some(char => char.charCodeAt(0) === 0);
}

export async function postOpenList(env, endpoint, body, timeoutMs = 20000, provider = "vps") {
  const source = ["vps", "worker", "k40"].includes(String(provider || "")) ? String(provider) : "";
  if (!source) return { response: error("未指定有效的活動伺服器來源。", 400) };
  const label = source === "worker" ? "OpenList Worker" : source === "k40" ? "K40 Alist" : "VPS Alist";
  const startedAt = performance.now();
  let profileMs = 0;
  let upstreamMs = 0;
  let bodyMs = 0;
  const timing = () => ({
    profileMs: Math.round(profileMs * 10) / 10,
    upstreamMs: Math.round(upstreamMs * 10) / 10,
    bodyMs: Math.round(bodyMs * 10) / 10,
    totalMs: Math.round((performance.now() - startedAt) * 10) / 10
  });

  const profileStartedAt = performance.now();
  let profiles;
  try {
    profiles = (await readConnectionProfiles(env)).profiles;
  } catch (cause) {
    profileMs = performance.now() - profileStartedAt;
    return { response: error(cause.message || "讀取 OpenList 來源設定失敗。", 503), timing: timing() };
  }
  profileMs = performance.now() - profileStartedAt;

  const profile = profiles[source] || {};
  const configured = normalizeBase(String(profile.baseUrl || "").trim(), label);
  if (configured.response) return { ...configured, timing: timing() };

  let auth;
  try {
    auth = await getProviderToken(env, source, configured.baseUrl, profile);
  } catch (cause) {
    return {
      response: error(label + " 自動認證失敗：" + String(cause?.message || "請檢查服務帳號設定。").slice(0, 220), 503),
      timing: timing()
    };
  }

  const target = new URL("api/fs/" + endpoint, configured.baseUrl + "/");
  async function requestOnce(token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let upstream;
    const upstreamStartedAt = performance.now();
    try {
      upstream = await fetch(target.href, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Authorization": token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      upstreamMs += performance.now() - upstreamStartedAt;
    } catch (cause) {
      upstreamMs += performance.now() - upstreamStartedAt;
      if (cause?.name === "AbortError") {
        const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
        console.warn("[FRAME Audio] OpenList provider API timeout", {
          provider: source, endpoint, timeoutMs, elapsedMs, profileMs, upstreamMs
        });
        return {
          response: error(label + " API 請求逾時（" + Math.round(elapsedMs / 1000) + " 秒）。", 504)
        };
      }
      const diagnosticCode = String(cause?.cause?.code || cause?.code || "");
      const diagnosticMessage = String(cause?.cause?.message || cause?.message || cause?.name || "Unknown error")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
        .replace(/(authorization|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
        .replace(/\s+/g, " ")
        .slice(0, 140);
      console.error("[FRAME Audio] OpenList provider fetch failed", {
        provider: source, endpoint, name: String(cause?.name || "Error"),
        code: diagnosticCode, message: diagnosticMessage
      });
      const detail = [diagnosticCode, diagnosticMessage].filter(Boolean).join(": ");
      return {
        response: error(
          "Cloudflare Pages 無法連接 " + label + " API。" + (detail ? " 診斷：" + detail : ""),
          502
        )
      };
    } finally {
      clearTimeout(timeout);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location") || "";
      let destination = "未知";
      try { destination = new URL(location, configured.baseUrl).hostname || "未知"; } catch {}
      return {
        response: error(
          label + " API 回傳 HTTP " + upstream.status +
          " 重新導向（目的主機：" + destination +
          "）。請將 API 網址設為最終 HTTPS API 網址；為保護 Token，系統不會自動跟隨重新導向。",
          502
        )
      };
    }

    let payload;
    const bodyStartedAt = performance.now();
    try {
      payload = await upstream.json();
      bodyMs += performance.now() - bodyStartedAt;
    } catch {
      bodyMs += performance.now() - bodyStartedAt;
      return {
        response: error(label + " API 回應不是有效 JSON。", 502),
        upstream,
        payload: null
      };
    }
    return { upstream, payload };
  }

  let attempt = await requestOnce(auth.token);
  if (attempt.response) return { ...attempt, timing: timing() };

  const authRejected = attempt.upstream?.status === 401 || Number(attempt.payload?.code) === 401;
  if (auth.managed && authRejected) {
    try {
      await invalidateProviderToken(env, source, configured.baseUrl, profile);
      auth = await getProviderToken(env, source, configured.baseUrl, profile, { forceRefresh: true });
      attempt = await requestOnce(auth.token);
      if (attempt.response) return { ...attempt, timing: timing() };
    } catch (cause) {
      return {
        response: error(label + " Token 已被拒絕，重新登入失敗：" + String(cause?.message || "請檢查服務帳號。").slice(0, 180), 503),
        timing: timing()
      };
    }
  }

  const upstream = attempt.upstream;
  const payload = attempt.payload;
  console.info("[FRAME Audio] OpenList provider API response", {
    provider: source,
    endpoint,
    status: upstream?.status || 0,
    authMode: auth.managed ? "automatic-login" : "legacy-token",
    profileMs: Math.round(profileMs),
    upstreamMs: Math.round(upstreamMs),
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10
  });

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { response: error(label + " API 回應格式不正確。", 502), timing: timing() };
  }
  if (!upstream.ok) {
    const message = String(payload.message || payload.error || "");
    return {
      response: error(label + " API HTTP " + upstream.status + (message ? "：" + message : "。"), 502),
      timing: timing()
    };
  }
  return { payload, baseUrl: configured.baseUrl, provider: source, timing: timing() };
}

export function normalizedRawUrl(value, baseUrl) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value, baseUrl + "/"); }
  catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  return url.href;
}

export { error, json };
