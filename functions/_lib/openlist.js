import { error, isObject, json } from "./api.js";

function configuredBase(env) {
  const raw = String(env.OPENLIST_BASE_URL || "").trim();
  if (!raw) return { response: error("Cloudflare 尚未設定 OPENLIST_BASE_URL Variable。", 503) };
  let url;
  try { url = new URL(raw); }
  catch { return { response: error("OPENLIST_BASE_URL 不是有效網址。", 503) }; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return { response: error("OPENLIST_BASE_URL 必須是沒有帳密、查詢參數或片段的 HTTPS 網址。", 503) };
  }
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, "") };
}

export function validOpenListPath(value) {
  return typeof value === "string" && value.length <= 4096 &&
    value.startsWith("/") && !value.split("").some(char => char.charCodeAt(0) === 0);
}

export async function postOpenList(env, endpoint, body, timeoutMs = 20000) {
  const token = String(env.OPENLIST_API_TOKEN || "").trim();
  if (!token) return { response: error("Cloudflare 尚未設定 OPENLIST_API_TOKEN Secret。", 503) };
  const configured = configuredBase(env);
  if (configured.response) return configured;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  try {
    const target = new URL("api/fs/" + endpoint, configured.baseUrl + "/");
    upstream = await fetch(target.href, {
      method: "POST",
      redirect: "error",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (cause) {
    if (cause?.name === "AbortError") return { response: error("VPS Alist API 請求逾時。", 504) };
    return { response: error("Cloudflare Pages 無法連接 VPS Alist API。", 502) };
  } finally {
    clearTimeout(timeout);
  }

  let payload;
  try { payload = await upstream.json(); }
  catch { return { response: error("VPS Alist API 回應不是有效 JSON。", 502) }; }
  if (!upstream.ok) {
    const message = isObject(payload) ? String(payload.message || payload.error || "") : "";
    return { response: error("VPS Alist API HTTP " + upstream.status + (message ? "：" + message : "。"), 502) };
  }
  if (!isObject(payload)) return { response: error("VPS Alist API 回應格式不正確。", 502) };
  return { payload, baseUrl: configured.baseUrl };
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
