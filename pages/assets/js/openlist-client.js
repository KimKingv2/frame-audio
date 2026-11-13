const DEFAULT_TIMEOUT_MS = 180000;
const DIRECTORY_LIST_TIMEOUT_MS = 45000;
const DIRECTORY_LIST_MAX_ATTEMPTS = 2;
const DIRECTORY_LIST_RETRY_DELAY_MS = 900;
let activeConnection = { provider: "mobile-device", baseUrl: "", token: "" };

export function configureOpenListConnection(config = {}) {
  const provider = ["vps", "worker", "mobile-device", "local"].includes(String(config.provider || "")) ? String(config.provider) : "mobile-device";
  activeConnection = { provider, baseUrl: String(config.baseUrl || "").trim(), token: String(config.token || "").trim() };
  return { provider: activeConnection.provider, baseUrl: activeConnection.baseUrl };
}
export function getOpenListConnection() { return { ...activeConnection, token: "" }; }

export async function loginOpenList({ baseUrl, username, password, timeoutMs = 20000 }) {
  const normalizedBase = normalizeOpenListUrl(baseUrl);
  const user = String(username || "").trim();
  const secret = String(password || "");
  if (!user || !secret) throw new Error("請輸入區域網路 OpenList 帳號與密碼。");
  const target = new URL("api/auth/login", normalizedBase + "/").href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(60000, Number(timeoutMs) || 20000)));
  try {
    const response = await fetch(target, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: secret }),
      signal: controller.signal,
      ...openListNetworkFetchOptions(target)
    });
    let payload = {};
    try { payload = await response.json(); }
    catch { throw new Error("OpenList 登入回應不是有效 JSON。"); }
    if (!response.ok || Number(payload?.code) !== 200 || !payload?.data?.token) {
      const reason = String(payload?.message || payload?.error || "");
      throw new Error("OpenList 登入失敗（HTTP " + response.status + "）" + (reason ? "：" + reason : "。請檢查帳號與密碼。"));
    }
    return String(payload.data.token);
  } catch (cause) {
    if (cause?.name === "AbortError") throw new Error("區域網路 OpenList 登入逾時。");
    if (cause instanceof Error && /登入失敗|回應不是有效 JSON|登入逾時/.test(cause.message)) throw cause;
    throw new Error("無法連接區域網路 OpenList 登入 API。請檢查網址、CORS、本機網路權限與 HTTPS／VPN 設定。" +
      (cause?.message ? " 詳情：" + String(cause.message).slice(0, 140) : ""));
  } finally {
    clearTimeout(timeout);
  }
}
function resolveConnection(baseUrl) { return { ...activeConnection, baseUrl: String(baseUrl || activeConnection.baseUrl || "").trim() }; }

function ipv4Octets(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const octets = hostname.split(".").map(Number);
  return octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? octets : null;
}
function isPrivateIpv4(hostname) {
  const ip = ipv4Octets(hostname);
  if (!ip) return false;
  const [a, b] = ip;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}
export function openListTargetAddressSpace(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return ""; }
  const hostname = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.startsWith("127.")) return "loopback";
  if (isPrivateIpv4(hostname)) return "local";
  return "";
}
export function openListNetworkFetchOptions(value) {
  const targetAddressSpace = openListTargetAddressSpace(value);
  return targetAddressSpace ? { targetAddressSpace } : {};
}
export function normalizeOpenListUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("OpenList 網址格式不正確。"); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("OpenList 網址必須使用 HTTP 或 HTTPS。");
  const loopback = openListTargetAddressSpace(url.href) === "loopback";
  const privateLan = openListTargetAddressSpace(url.href) === "local";
  if (url.protocol === "http:" && !loopback && !privateLan) {
    throw new Error("HTTP 只允許本機迴圈位址或私有區域網路 IPv4（10.x、172.16–31.x、192.168.x、169.254.x）。其他網域必須使用 HTTPS。");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("OpenList 網址不可包含帳號、密碼、查詢參數或片段。");
  return url.origin + url.pathname.replace(/\/+$/, "");
}
function sourceLabel(provider) {
  return provider === "worker" ? "OpenList Worker" : provider === "mobile-device" ? "Mobile Device Alist" : provider === "local" ? "區域網路 OpenList" : "VPS Alist";
}
async function directRequest(config, endpoint, payload, timeoutMs) {
  const baseUrl = normalizeOpenListUrl(config.baseUrl);
  if (!config.token) throw new Error("區域網路 OpenList 尚未登入，請輸入帳號與密碼。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = new URL("api/fs/" + endpoint, baseUrl + "/").href;
    return await fetch(target, {
      method: "POST", mode: "cors", credentials: "omit", redirect: "error",
      headers: { Authorization: config.token, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: controller.signal,
      ...openListNetworkFetchOptions(target)
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw new Error("本機 OpenList " + endpoint + " 請求逾時（" + Math.round(timeoutMs / 1000) + " 秒）。");
    throw new Error("無法直接連接區域網路 OpenList。請確認服務、網址與 CORS（Authorization、Content-Type）設定。若使用 Chrome 142+，請在網站設定允許本機網路存取；Chrome 145+ 的 127.0.0.1 通常顯示為「迴圈網路／Apps on device」。若先前拒絕，請到網站權限重新允許。" +
      (cause?.message ? " 詳情：" + String(cause.message).slice(0, 160) : ""));
  } finally { clearTimeout(timeout); }
}
async function proxyRequest(config, endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch("/api/openlist/" + endpoint, {
      method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, provider: config.provider }), signal: controller.signal
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw new Error(sourceLabel(config.provider) + " API 請求逾時（" + Math.round(timeoutMs / 1000) + " 秒）。");
    throw new Error("無法取得 Cloudflare Pages 的 " + sourceLabel(config.provider) + " API 回應，請確認 Cloudflare Access 與來源設定。");
  } finally { clearTimeout(timeout); }
}
async function requestOpenList(config, endpoint, payload, timeoutMs) {
  return config.provider === "local"
    ? directRequest(config, endpoint, payload, timeoutMs)
    : proxyRequest(config, endpoint, payload, timeoutMs);
}
async function parseResponse(response, provider, operation) {
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(sourceLabel(provider) + " " + operation + " 回應不是有效 JSON（HTTP " + response.status + "）。"); }
  if (!response.ok) throw new Error(payload?.error || (sourceLabel(provider) + " " + operation + " HTTP " + response.status + "。"));
  if (payload?.ok === false) throw new Error(payload.error || (sourceLabel(provider) + " " + operation + " 失敗。"));
  if (typeof payload?.code === "number" && payload.code !== 200) {
    const code = Number(payload.code);
    if (code === 401 || code === 403) throw new Error(sourceLabel(provider) + (provider === "local" ? " 登入已失效，請重新輸入帳號密碼。" : " 驗證失敗，請檢查伺服器端 Secret。"));
    throw new Error(sourceLabel(provider) + " API " + code + "：" + String(payload.message || "未知 API 錯誤"));
  }
  return payload;
}

export async function listOpenListDirectory({ baseUrl, token, path = "/", page = 1, perPage = 100, onEvent }) {
  void token;
  const config = resolveConnection(baseUrl);
  const emit = (message, level = "info") => { try { onEvent?.({ message, level }); } catch {} };
  const safePath = String(path || "/").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) throw new Error("目錄路徑必須以 / 開頭，且不能包含空字元。");
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safePerPage = Number.isSafeInteger(Number(perPage)) && Number(perPage) > 0 ? Math.min(500, Number(perPage)) : 100;
  let payload = null, lastError = null;
  for (let attempt = 1; attempt <= DIRECTORY_LIST_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = performance.now();
    emit(sourceLabel(config.provider) + " 目錄列表第 " + attempt + "/" + DIRECTORY_LIST_MAX_ATTEMPTS + " 次請求開始；第 " + safePage + " 頁");
    try {
      const response = await requestOpenList(config, "list", {
        path: safePath, password: "", page: safePage, per_page: safePerPage, refresh: false
      }, DIRECTORY_LIST_TIMEOUT_MS);
      emit(sourceLabel(config.provider) + " 目錄列表收到 HTTP " + response.status + "；耗時 " + Math.round(performance.now() - startedAt) + " ms", response.ok ? "success" : "warning");
      payload = await parseResponse(response, config.provider, "目錄列表");
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      emit(sourceLabel(config.provider) + " 目錄列表失敗：" + (error?.message || error), "warning");
      const retryable = /逾時|無法直接連接|無法取得 Cloudflare Pages/i.test(String(error?.message || ""));
      if (!retryable || attempt >= DIRECTORY_LIST_MAX_ATTEMPTS) break;
      await new Promise(resolve => setTimeout(resolve, DIRECTORY_LIST_RETRY_DELAY_MS));
    }
  }
  if (!payload) throw lastError || new Error(sourceLabel(config.provider) + " 目錄列表失敗。");
  const data = payload?.data;
  if (!data || !Array.isArray(data.content)) throw new Error(sourceLabel(config.provider) + " 回傳格式錯誤，找不到 data.content。");
  return {
    path: safePath,
    items: data.content.map(item => ({
      name: String(item.name || ""), isDir: Boolean(item.is_dir), size: Number(item.size || 0),
      modified: item.modified || null, sign: item.sign || ""
    })),
    total: Number(data.total ?? data.content.length),
    page: Number(data.page ?? safePage),
    perPage: Number(data.per_page ?? safePerPage)
  };
}
export function joinOpenListPath(parent, child) {
  const base = String(parent || "/").replace(/\/+$/, "");
  const name = String(child || "").replace(/^\/+|\/+$/g, "");
  return (base || "") + "/" + name || "/";
}
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + " " + units[i];
}
export async function getOpenListFileInfo({ baseUrl, token, path, timeoutMs = DEFAULT_TIMEOUT_MS, onTiming }) {
  const config = resolveConnection(baseUrl);
  void token;
  const safePath = String(path || "").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) throw new Error("檔案路徑必須是以 / 開頭的完整路徑。");
  const safeTimeout = Math.max(1000, Math.min(180000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const requestStartedAt = performance.now();
  const response = await requestOpenList(config, "get", { path: safePath, password: "" }, safeTimeout);
  const responseMs = Math.round(performance.now() - requestStartedAt);
  const bodyStartedAt = performance.now();
  const payload = await parseResponse(response, config.provider, "檔案資訊");
  const bodyMs = Math.round(performance.now() - bodyStartedAt);
  const timing = {
    provider: config.provider,
    responseMs,
    bodyMs,
    serverTiming: response.headers.get("server-timing") || null,
    status: response.status
  };
  console.info("[FRAME Audio] OpenList file-info request", timing);
  try { onTiming?.(timing); } catch {}
  if (!payload?.data || typeof payload.data !== "object") throw new Error(sourceLabel(config.provider) + " 檔案資訊缺少 data。");
  const info = { ...payload.data };
  if (info.raw_url) {
    const base = normalizeOpenListUrl(config.baseUrl || window.location.origin);
    try { info.raw_url = new URL(String(info.raw_url), base + "/").href; }
    catch { throw new Error(sourceLabel(config.provider) + " 回傳的 raw_url 格式不正確。"); }
  }
  return info;
}
export async function probeOpenListAudioRange({ baseUrl, token, path, byteCount = 65536, startByte = 0 }) {
  const config = resolveConnection(baseUrl);
  const normalizedBase = normalizeOpenListUrl(config.baseUrl || window.location.origin);
  const safePath = String(path || "").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) throw new Error("音訊檔案路徑必須是以 / 開頭的完整路徑。");
  if (!Number.isInteger(byteCount) || byteCount < 1 || byteCount > 65536) throw new Error("Range 測試上限必須介於 1 到 65536 bytes。");
  const info = await getOpenListFileInfo({ baseUrl: normalizedBase, token, path: safePath, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (info.is_dir) throw new Error("選取的項目是資料夾，請選擇音訊檔案。");
  const fileSize = Number(info.size || 0);
  if (!Number.isFinite(fileSize) || fileSize <= 0) throw new Error("OpenList 回報檔案大小為 0，無法執行 Range 測試。");
  if (!info.raw_url) throw new Error("OpenList /api/fs/get 沒有提供 raw_url。");
  const target = new URL(String(info.raw_url), normalizedBase + "/");
  if (!["https:", "http:"].includes(target.protocol)) throw new Error("OpenList 回傳的音訊來源網址協定不受支援。");
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= fileSize) throw new Error("Range 測試起始位置超出檔案範圍。");
  const requestedBytes = Math.min(byteCount, fileSize - startByte), endByte = startByte + requestedBytes - 1;
  const rawResponse = await fetch(target.href, {
    method: "GET", mode: "cors", credentials: "omit", redirect: "follow",
    headers: { Range: "bytes=" + startByte + "-" + endByte },
    ...openListNetworkFetchOptions(target.href)
  }).catch(() => { throw new Error("已取得檔案資訊，但瀏覽器無法讀取音訊來源。可能是來源網域的本機網路權限或 CORS 限制。"); });
  const finalUrl = rawResponse.url || target.href;
  let finalHost = "";
  try { finalHost = new URL(finalUrl).hostname; } catch {}
  const contentRange = rawResponse.headers.get("content-range") || "";
  const contentLength = rawResponse.headers.get("content-length") || "";
  if (rawResponse.status !== 206) {
    try { await rawResponse.body?.cancel(); } catch {}
    return {
      path: safePath, file_size: fileSize, start_byte: startByte, end_byte: endByte,
      status_code: rawResponse.status, range_supported: false, content_range: contentRange,
      bytes_received: 0, content_length: contentLength, final_host: finalHost,
      warning: rawResponse.status === 200 ? "來源伺服器忽略 Range；已取消回應串流，沒有讀取完整音訊。"
        : "來源伺服器回傳非預期 HTTP 狀態：" + rawResponse.status + "。"
    };
  }
  let bytesReceived = 0;
  if (rawResponse.body) {
    const reader = rawResponse.body.getReader();
    try {
      while (bytesReceived < requestedBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesReceived += Math.min(value?.byteLength || 0, requestedBytes - bytesReceived);
      }
    } finally {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
  return {
    path: safePath, file_size: fileSize, start_byte: startByte, end_byte: endByte,
    status_code: rawResponse.status, range_supported: bytesReceived > 0,
    content_range: contentRange, bytes_received: bytesReceived,
    content_length: contentLength, final_host: finalHost,
    warning: bytesReceived > 0 ? "" : "伺服器回傳 HTTP 206，但沒有取得測試資料。"
  };
}
