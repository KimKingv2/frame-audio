import { error, json, requireAdmin, readJson, isObject } from "../../_lib/api.js";

const KEY_PATTERN = /^music_scan_[a-f0-9]{64}$/;

export async function onRequest({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  if (request.method === "GET") {
    const key = new URL(request.url).searchParams.get("key") || "";
    if (!KEY_PATTERN.test(key)) return error("索引狀態 key 格式不正確。");
    try {
      const row = await env.DB.prepare(
        "SELECT value, updated_at FROM catalog_state WHERE key=?"
      ).bind(key).first();
      if (!row) return json({ ok: true, state: null, updatedAt: null });
      return json({ ok: true, state: JSON.parse(row.value), updatedAt: row.updated_at });
    } catch {
      return error("讀取 D1 索引進度失敗，請確認 catalog_state 資料表已初始化。", 503);
    }
  }

  if (request.method === "POST") {
    let body;
    try { body = await readJson(request, 900000); }
    catch (e) { return error(e.message, 413); }
    const key = String(body?.key || "");
    const state = body?.state;
    if (!KEY_PATTERN.test(key) || !isObject(state)) return error("索引狀態資料格式不正確。");
    if (state.version !== 1 || typeof state.rootPath !== "string" || !state.rootPath.startsWith("/")) {
      return error("索引狀態版本或根目錄不正確。");
    }
    const value = JSON.stringify(state);
    if (value.length > 800000) return error("索引進度資料超過 800 KB 上限。", 413);
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        "INSERT INTO catalog_state (key,value,updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
      ).bind(key, value, now).run();
      return json({ ok: true, key, updatedAt: now });
    } catch {
      return error("保存 D1 索引進度失敗。", 503);
    }
  }

  return error("Method Not Allowed", 405);
}
