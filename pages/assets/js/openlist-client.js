const DEFAULT_TIMEOUT_MS = 20000;

export function normalizeOpenListUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("OpenList 網址格式不正確。");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("OpenList 網址必須使用 HTTP 或 HTTPS。");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("正式網站只能連接 HTTPS 的 OpenList 網址。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OpenList 網址不可包含帳號、密碼、查詢參數或片段。");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function listOpenListDirectory({ baseUrl, token, path = "/", page = 1, perPage = 100 }) {
  const normalizedBase = normalizeOpenListUrl(baseUrl);
  const safePath = String(path || "/").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) {
    throw new Error("目錄路徑必須以 / 開頭。");
  }

  const headers = { "Content-Type": "application/json" };
  const trimmedToken = String(token || "").trim();
  if (trimmedToken) headers.Authorization = trimmedToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(normalizedBase + "/api/fs/list", {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      headers,
      body: JSON.stringify({
        path: safePath,
        password: "",
        page,
        per_page: perPage,
        refresh: false
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("連線逾時。請確認 OpenList 網址及網路狀態。");
    }
    const pageOrigin = typeof window !== "undefined" ? window.location.origin : "unknown";
    const browserDetail = error?.message ? ` 瀏覽器訊息：${error.message}` : "";
    throw new Error(
      `瀏覽器未取得 OpenList HTTP 回應。請檢查網路及 CORS 設定。\n目前頁面來源（請加入 OpenList CORS 允許清單）：${pageOrigin}\n並允許 POST、OPTIONS 方法，以及 Authorization、Content-Type 標頭。${browserDetail}`
    );
  } finally {
    clearTimeout(timeout);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`OpenList 回應不是有效 JSON（HTTP ${response.status}）。`);
  }

  if (!response.ok) {
    throw new Error(`OpenList HTTP ${response.status}：${payload?.message || response.statusText}`);
  }
  if (typeof payload?.code === "number" && payload.code !== 200) {
    const code = payload.code;
    const message = String(payload.message || "未知 API 錯誤");
    if (code === 401 || code === 403) {
      throw new Error("OpenList 驗證失敗或沒有目錄讀取權限，請檢查 Token。");
    }
    throw new Error(`OpenList API ${code}：${message}`);
  }

  const data = payload?.data;
  if (!data || !Array.isArray(data.content)) {
    throw new Error("OpenList 回傳格式與預期不同，找不到 data.content。");
  }

  return {
    path: safePath,
    items: data.content.map((item) => ({
      name: String(item.name || ""),
      isDir: Boolean(item.is_dir),
      size: Number(item.size || 0),
      modified: item.modified || null,
      sign: item.sign || ""
    })),
    total: Number(data.total ?? data.content.length),
    page: Number(data.page ?? page),
    perPage: Number(data.per_page ?? perPage)
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
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + " " + units[i];
}

export async function getOpenListFileInfo({ baseUrl, token, path }) {
  const normalizedBase = normalizeOpenListUrl(baseUrl);
  const safePath = String(path || "").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) {
    throw new Error("檔案路徑必須是以 / 開頭的完整路徑。");
  }

  const headers = { "Content-Type": "application/json" };
  const trimmedToken = String(token || "").trim();
  if (trimmedToken) headers.Authorization = trimmedToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(normalizedBase + "/api/fs/get", {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      headers,
      body: JSON.stringify({ path: safePath, password: "" }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("讀取 OpenList 檔案資訊逾時。");
    throw new Error("無法讀取 OpenList /api/fs/get。請確認 CORS、Token 與目錄權限。");
  } finally {
    clearTimeout(timeout);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`OpenList 檔案資訊不是有效 JSON（HTTP ${response.status}）。`);
  }
  if (!response.ok) throw new Error(`OpenList /api/fs/get HTTP ${response.status}。`);
  if (payload?.code != null && Number(payload.code) !== 200) {
    const code = Number(payload.code);
    if (code === 401 || code === 403) throw new Error("OpenList 驗證失敗或沒有檔案讀取權限，請檢查 Token。");
    throw new Error(`OpenList /api/fs/get API ${code}：${String(payload.message || "未知錯誤")}`);
  }
  if (!payload?.data || typeof payload.data !== "object") {
    throw new Error("OpenList /api/fs/get 缺少檔案資訊。");
  }
  return payload.data;
}

export async function probeOpenListAudioRange({
  baseUrl,
  token,
  path,
  byteCount = 65536
}) {
  const normalizedBase = normalizeOpenListUrl(baseUrl);
  const safePath = String(path || "").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) {
    throw new Error("音訊檔案路徑必須是以 / 開頭的完整路徑。");
  }
  if (!Number.isInteger(byteCount) || byteCount < 1 || byteCount > 65536) {
    throw new Error("Range 測試上限必須介於 1 到 65536 bytes。");
  }

  const headers = { "Content-Type": "application/json" };
  const trimmedToken = String(token || "").trim();
  if (trimmedToken) headers.Authorization = trimmedToken;

  const apiController = new AbortController();
  const apiTimeout = setTimeout(() => apiController.abort(), DEFAULT_TIMEOUT_MS);
  let infoResponse;
  try {
    infoResponse = await fetch(normalizedBase + "/api/fs/get", {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      headers,
      body: JSON.stringify({ path: safePath, password: "" }),
      signal: apiController.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("讀取音訊檔案資訊逾時。");
    }
    throw new Error("無法讀取 OpenList /api/fs/get。請確認 CORS、Token 與目錄權限。");
  } finally {
    clearTimeout(apiTimeout);
  }

  let payload;
  try {
    payload = await infoResponse.json();
  } catch {
    throw new Error(`OpenList 檔案資訊不是有效 JSON（HTTP ${infoResponse.status}）。`);
  }
  if (!infoResponse.ok) {
    throw new Error(`OpenList /api/fs/get HTTP ${infoResponse.status}。`);
  }
  if (payload?.code != null && Number(payload.code) !== 200) {
    const code = Number(payload.code);
    if (code === 401 || code === 403) {
      throw new Error("OpenList 驗證失敗或沒有檔案讀取權限，請檢查 Token。");
    }
    throw new Error(`OpenList /api/fs/get API ${code}：${String(payload.message || "未知錯誤")}`);
  }

  const info = payload?.data;
  if (!info || typeof info !== "object") {
    throw new Error("OpenList /api/fs/get 缺少檔案資訊。");
  }
  if (info.is_dir) {
    throw new Error("選取的項目是資料夾，請選擇音訊檔案。");
  }
  const fileSize = Number(info.size || 0);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("OpenList 回報檔案大小為 0，無法執行 Range 測試。");
  }
  if (!info.raw_url) {
    throw new Error("OpenList /api/fs/get 沒有提供 raw_url。");
  }

  const target = new URL(String(info.raw_url), normalizedBase + "/");
  if (!["https:", "http:"].includes(target.protocol)) {
    throw new Error("OpenList 回傳的音訊來源網址協定不受支援。");
  }
  const requestedBytes = Math.min(byteCount, fileSize);
  const rangeController = new AbortController();
  let rawResponse;
  try {
    rawResponse = await fetch(target.href, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      headers: { Range: `bytes=0-${requestedBytes - 1}` },
      signal: rangeController.signal
    });
  } catch {
    throw new Error("已取得檔案資訊，但瀏覽器無法讀取音訊來源。可能是來源網域的 CORS 或網路限制。");
  }

  const finalUrl = rawResponse.url || target.href;
  let finalHost = "";
  try { finalHost = new URL(finalUrl).hostname; } catch {}
  const contentRange = rawResponse.headers.get("content-range") || "";
  const contentLength = rawResponse.headers.get("content-length") || "";

  if (rawResponse.status !== 206) {
    try { await rawResponse.body?.cancel(); } catch {}
    return {
      path: safePath,
      file_size: fileSize,
      status_code: rawResponse.status,
      range_supported: false,
      content_range: contentRange,
      bytes_received: 0,
      content_length: contentLength,
      final_host: finalHost,
      warning: rawResponse.status === 200
        ? "來源伺服器忽略 Range；已取消回應串流，沒有讀取完整音訊。"
        : `來源伺服器回傳非預期 HTTP 狀態：${rawResponse.status}。`
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
    path: safePath,
    file_size: fileSize,
    status_code: rawResponse.status,
    range_supported: bytesReceived > 0,
    content_range: contentRange,
    bytes_received: bytesReceived,
    content_length: contentLength,
    final_host: finalHost,
    warning: bytesReceived > 0 ? "" : "伺服器回傳 HTTP 206，但沒有取得測試資料。"
  };
}

