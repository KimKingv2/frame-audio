import { error, json, requireAdmin, readJson, isObject } from "../../_lib/api.js";

function normalizePath(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.indexOf(String.fromCharCode(0)) !== -1 || path.length > 4096) return null;
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

async function pathHash(path) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseValue(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  try {
    // Import legacy scan-state errors as well as explicit global retry records.
    // A resolved marker prevents an old scan state's error from re-queuing a
    // path after a successful retry from another scan root.
    const result = await env.DB.prepare(
      "SELECT key,value FROM catalog_state WHERE " +
      "substr(key,1,11)='music_scan_' OR " +
      "substr(key,1,12)='music_retry_' OR " +
      "substr(key,1,17)='music_retry_done_'"
    ).all();

    const pending = new Map();
    const resolved = new Set();
    const rows = result.results || [];

    for (const row of rows) {
      const key = String(row.key || "");
      const value = parseValue(row.value);
      if (!value) continue;

      if (key.startsWith("music_retry_done_")) {
        const path = normalizePath(value.path);
        if (path) resolved.add(path);
        continue;
      }

      if (key.startsWith("music_retry_")) {
        const path = normalizePath(value.path);
        if (path) pending.set(path, {
          path,
          message: String(value.message || "先前索引失敗，等待重試"),
          updatedAt: value.updatedAt || null
        });
        continue;
      }

      if (key.startsWith("music_scan_") && Array.isArray(value.errors)) {
        for (const item of value.errors) {
          const path = normalizePath(item?.path);
          if (!path || pending.has(path)) continue;
          pending.set(path, {
            path,
            message: String(item?.message || "先前索引失敗，等待重試"),
            updatedAt: item?.at || null
          });
        }
      }
    }

    for (const path of resolved) pending.delete(path);
    return json({ ok: true, count: pending.size, items: [...pending.values()] });
  } catch {
    return error("讀取全域失敗重試佇列時，D1 查詢失敗。", 503);
  }
}

export async function onRequestPost({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  let body;
  try { body = await readJson(request, 12000); }
  catch (e) { return error(e.message, 413); }
  if (!isObject(body)) return error("失敗重試項目格式不正確。");

  const path = normalizePath(body.path);
  if (!path) return error("失敗重試路徑無效。");
  const message = String(body.message || "索引失敗，等待重試").slice(0, 700);
  const now = new Date().toISOString();

  try {
    const hash = await pathHash(path);
    const retryKey = "music_retry_" + hash;
    const resolvedKey = "music_retry_done_" + hash;
    const value = JSON.stringify({ path, message, updatedAt: now });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO catalog_state (key,value,updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
      ).bind(retryKey, value, now),
      env.DB.prepare("DELETE FROM catalog_state WHERE key=?").bind(resolvedKey)
    ]);
    return json({ ok: true, path, updatedAt: now });
  } catch {
    return error("保存失敗重試項目至 D1 失敗。", 503);
  }
}

export async function onRequestDelete({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  let body;
  try { body = await readJson(request, 12000); }
  catch (e) { return error(e.message, 413); }
  if (!isObject(body)) return error("解除失敗重試項目格式不正確。");

  const path = normalizePath(body.path);
  if (!path) return error("失敗重試路徑無效。");
  const now = new Date().toISOString();

  try {
    const hash = await pathHash(path);
    const retryKey = "music_retry_" + hash;
    const resolvedKey = "music_retry_done_" + hash;
    const value = JSON.stringify({ path, resolvedAt: now });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM catalog_state WHERE key=?").bind(retryKey),
      env.DB.prepare(
        "INSERT INTO catalog_state (key,value,updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
      ).bind(resolvedKey, value, now)
    ]);
    return json({ ok: true, path, resolvedAt: now });
  } catch {
    return error("解除失敗重試項目時，D1 寫入失敗。", 503);
  }
}
