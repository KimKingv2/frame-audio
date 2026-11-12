import { readJson, error } from "../../_lib/api.js";
import { postOpenList, validOpenListPath, normalizedRawUrl, json } from "../../_lib/openlist.js";

const LINK_RETRY_DELAYS_MS = [700, 1500];
const TRANSIENT_PROVIDER_ERROR = /(?:i\/o timeout|client\.timeout exceeded|context deadline exceeded|dial tcp[^\n]*timeout|tls handshake timeout|connection timed out|operation timed out|temporary failure in name resolution|no such host|connection reset by peer|unexpected eof)/i;

function isTransientProviderLinkError(payload) {
  return Number(payload?.code) === 500 &&
    TRANSIENT_PROVIDER_ERROR.test(String(payload?.message || payload?.error || ""));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withServerTiming(response, metrics = {}) {
  const entries = [
    ["openlist_profile", metrics.profileMs],
    ["openlist_upstream", metrics.upstreamMs],
    ["openlist_body", metrics.bodyMs],
    ["retry_wait", metrics.retryWaitMs],
    ["function_total", metrics.totalMs]
  ].filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(([name, value]) => name + ";dur=" + (Math.round(Number(value) * 10) / 10));
  if (entries.length) response.headers.set("Server-Timing", entries.join(", "));
  return response;
}

export async function onRequestPost({ request, env }) {
  const handlerStartedAt = performance.now();
  const timings = { profileMs: 0, upstreamMs: 0, bodyMs: 0, retryWaitMs: 0 };
  const addTiming = result => {
    for (const key of ["profileMs", "upstreamMs", "bodyMs"]) timings[key] += Number(result?.timing?.[key] || 0);
  };
  const respond = response => withServerTiming(response, { ...timings, totalMs: performance.now() - handlerStartedAt });
  let body;
  try { body = await readJson(request, 65536); }
  catch (cause) { return error(cause.message || "檔案資訊請求格式不正確。", 400); }

  if (!validOpenListPath(body?.path)) return error("OpenList 檔案路徑無效。", 400);

  const provider = ["vps", "worker", "k40"].includes(String(body.provider || "")) ? String(body.provider) : "";
  if (!provider) return error("請明確指定目前活動的 VPS、Worker 或 K40 來源。", 400);
  let result;
  let transientFailure = false;
  for (let attempt = 1; attempt <= LINK_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    result = await postOpenList(env, "get", {
      path: body.path,
      password: ""
    }, 55000, provider);
    addTiming(result);
    if (result.response) return respond(result.response);
    if (!isTransientProviderLinkError(result.payload)) break;

    transientFailure = true;
    if (attempt > LINK_RETRY_DELAYS_MS.length) {
      console.error("[FRAME Audio] OpenList provider link retries exhausted", {
        attempts: attempt,
        reason: "temporary provider network failure"
      });
      const message = String(result.payload.message || result.payload.error || "雲盤下載連結取得失敗");
      result.payload.message = message + "（已自動重試 " + LINK_RETRY_DELAYS_MS.length + " 次，仍未成功）";
      break;
    }
    const delayMs = LINK_RETRY_DELAYS_MS[attempt - 1];
    console.warn("[FRAME Audio] retrying transient OpenList provider link failure", {
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      reason: "temporary provider network failure"
    });
    timings.retryWaitMs += delayMs;
    await sleep(delayMs);
  }

  const payload = result.payload;
  if (transientFailure && Number(payload?.code) === 500) {
    // The original provider response is retained; only the retry note is appended
    // after the bounded retry budget has been exhausted.
  }
  if (Number(payload.code) === 200 && payload.data && typeof payload.data === "object" &&
      payload.data.raw_url) {
    const rawUrl = normalizedRawUrl(payload.data.raw_url, result.baseUrl);
    if (!rawUrl) return respond(error("OpenList 回傳的 raw_url 格式不受支援。", 502));
    payload.data.raw_url = rawUrl;
  }
  return respond(json(payload));
}
