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
    throw new Error("瀏覽器無法連接 OpenList。可能是網址、網路或 CORS 跨網域設定問題。");
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
