const DEFAULT_TIMEOUT_MS = 180000;
const DIRECTORY_LIST_TIMEOUT_MS = 45000;
const DIRECTORY_LIST_MAX_ATTEMPTS = 2;
const DIRECTORY_LIST_RETRY_DELAY_MS = 900;

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

export async function listOpenListDirectory({
  baseUrl,
  token,
  path = "/",
  page = 1,
  perPage = 100,
  onEvent
}) {
  void baseUrl;
  void token;
  const emit = (message, level = "info") => {
    try { onEvent?.({ message, level }); } catch {}
  };
  const safePath = String(path || "/").trim();
  if (!safePath.startsWith("/") || safePath.includes("\\0")) throw new Error("目錄路徑必須以 / 開頭。");
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safePerPage = Number.isSafeInteger(Number(perPage)) && Number(perPage) > 0 ? Math.min(500, Number(perPage)) : 100;
  const headers = { "Content-Type": "application/json" };
  let response;
  let lastNetworkError = null;
  for (let attempt = 1; attempt <= DIRECTORY_LIST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIRECTORY_LIST_TIMEOUT_MS);
    const attemptStartedAt = performance.now();
    emit("伺服器端 OpenList 目錄列表第 " + attempt + "/" + DIRECTORY_LIST_MAX_ATTEMPTS + " 次請求開始；第 " + safePage + " 頁；最長等待 45 秒");
    try {
      response = await fetch("/api/openlist/list", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers,
        body: JSON.stringify({ path: safePath, password: "", page: safePage, per_page: safePerPage, refresh: false }),
        signal: controller.signal
      });
      emit("伺服器端 OpenList 目錄列表已收到 HTTP " + response.status + "；請求耗時 " + Math.round(performance.now() - attemptStartedAt) + " ms", response.ok ? "success" : "warning");
      lastNetworkError = null;
      break;
    } catch (error) {
      lastNetworkError = error;
      emit("伺服器端 OpenList 目錄列表請求失敗：" + (error?.name === "AbortError" ? "逾時" : (error?.message || error)) + "；耗時 " + Math.round(performance.now() - attemptStartedAt) + " ms", "warning");
      const retryable = error?.name === "AbortError" || error?.name === "TypeError";
      if (!retryable || attempt >= DIRECTORY_LIST_MAX_ATTEMPTS) break;
      emit("等待 " + DIRECTORY_LIST_RETRY_DELAY_MS + " ms 後自動重試", "warning");
      await new Promise(resolve => setTimeout(resolve, DIRECTORY_LIST_RETRY_DELAY_MS));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!response) {
    emit("伺服器端 OpenList 目錄列表最終失敗；已耗盡自動重試", "error");
    if (lastNetworkError?.name === "AbortError") {
      throw new Error(`讀取 OpenList 目錄列表逾時。資料夾：${safePath}；頁碼：${safePage}；每次等待 ${DIRECTORY_LIST_TIMEOUT_MS / 1000} 秒；已嘗試 ${DIRECTORY_LIST_MAX_ATTEMPTS} 次。進度游標未推進，可以稍後續作。`);
    }
    throw new Error("無法取得 Cloudflare Pages 的 OpenList API 回應。請確認 Cloudflare Access 登入，以及 OPENLIST_API_TOKEN、OPENLIST_BASE_URL 已設定。");
  }
  let payload;
  const jsonStartedAt = performance.now();
  emit("解析伺服器端 OpenList 目錄 JSON 開始");
  try {
    payload = await response.json();
    emit("解析伺服器端 OpenList 目錄 JSON 完成：" + Math.round(performance.now() - jsonStartedAt) + " ms", "success");
  } catch {
    throw new Error(`伺服器端 OpenList 回應不是有效 JSON（HTTP ${response.status}）。`);
  }
  if (!response.ok) throw new Error(`伺服器端 OpenList API HTTP ${response.status}：${payload?.error || payload?.message || response.statusText}`);
  if (typeof payload?.code === "number" && payload.code !== 200) {
    const code = payload.code;
    const message = String(payload.message || "未知 API 錯誤");
    if (code === 401 || code === 403) throw new Error("伺服器端 OpenList 驗證失敗，請檢查 OPENLIST_API_TOKEN Secret。");
    throw new Error(`OpenList API ${code}：${message}`);
  }
  const data = payload?.data;
  if (!data || !Array.isArray(data.content)) throw new Error("OpenList 回傳格式與預期不同，找不到 data.content。");
  return {
    path: safePath,
    items: data.content.map(item => ({
      name: String(item.name || ""),
      isDir: Boolean(item.is_dir),
      size: Number(item.size || 0),
      modified: item.modified || null,
      sign: item.sign || ""
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
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + " " + units[i];
}

export async function getOpenListFileInfo({ baseUrl, token, path, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  void baseUrl;
  void token;
  const safePath = String(path || "").trim();
  if (!safePath.startsWith("/") || safePath.includes("\\0")) throw new Error("檔案路徑必須是以 / 開頭的完整路徑。");
  const controller = new AbortController();
  const safeTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Math.min(180000, Number(timeoutMs))) : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
  let response;
  try {
    response = await fetch("/api/openlist/get", {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: safePath, password: "" }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("讀取 OpenList 檔案資訊逾時（已等待 " + Math.round(safeTimeoutMs / 1000) + " 秒）。");
    throw new Error("無法讀取伺服器端 OpenList 檔案資訊。請確認 Cloudflare Access 與 Pages Functions 設定。");
  } finally {
    clearTimeout(timeout);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`OpenList 檔案資訊不是有效 JSON（HTTP ${response.status}）。`); }
  if (!response.ok) throw new Error(payload?.error || `伺服器端 OpenList 檔案資訊 HTTP ${response.status}。`);
  if (payload?.code != null && Number(payload.code) !== 200) {
    const code = Number(payload.code);
    if (code === 401 || code === 403) throw new Error("伺服器端 OpenList 驗證失敗，請檢查 OPENLIST_API_TOKEN Secret。");
    throw new Error(`OpenList 檔案資訊 API ${code}：${String(payload.message || "未知錯誤")}`);
  }
  if (!payload?.data || typeof payload.data !== "object") throw new Error("OpenList 檔案資訊缺少 data。");
  return payload.data;
}

export async function probeOpenListAudioRange({
  baseUrl,
  token,
  path,
  byteCount = 65536,
  startByte = 0
}) {
  const normalizedBase = normalizeOpenListUrl(baseUrl);
  const safePath = String(path || "").trim();
  if (!safePath.startsWith("/") || safePath.includes("\0")) {
    throw new Error("音訊檔案路徑必須是以 / 開頭的完整路徑。");
  }
  if (!Number.isInteger(byteCount) || byteCount < 1 || byteCount > 65536) {
    throw new Error("Range 測試上限必須介於 1 到 65536 bytes。");
  }

  const info = await getOpenListFileInfo({ baseUrl, path, timeoutMs: DEFAULT_TIMEOUT_MS });
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
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= fileSize) {
    throw new Error("Range 測試起始位置超出檔案範圍。");
  }
  const requestedBytes = Math.min(byteCount, fileSize - startByte);
  const endByte = startByte + requestedBytes - 1;
  const rangeController = new AbortController();
  let rawResponse;
  try {
    rawResponse = await fetch(target.href, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      headers: { Range: `bytes=${startByte}-${endByte}` },
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
      start_byte: startByte,
      end_byte: endByte,
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
    start_byte: startByte,
    end_byte: endByte,
    status_code: rawResponse.status,
    range_supported: bytesReceived > 0,
    content_range: contentRange,
    bytes_received: bytesReceived,
    content_length: contentLength,
    final_host: finalHost,
    warning: bytesReceived > 0 ? "" : "伺服器回傳 HTTP 206，但沒有取得測試資料。"
  };
}

