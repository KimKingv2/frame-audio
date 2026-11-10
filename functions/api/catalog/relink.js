import { error, json, requireAdmin, readJson, isObject } from "../../_lib/api.js";

function validPath(value) {
  return typeof value === "string" && value.startsWith("/") &&
    value.length <= 4096 && !value.includes("\0");
}

export async function onRequestPost({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);
  let body;
  try { body = await readJson(request, 12000); }
  catch (e) { return error(e.message, 413); }
  if (!isObject(body) || !["track", "episode"].includes(body.itemType) ||
      !validPath(body.oldPath) || !validPath(body.newPath)) {
    return error("索引路徑調整資料格式不正確。");
  }
  if (body.oldPath === body.newPath) return json({ ok: true, moved: false, reason: "same-path" });

  const table = body.itemType === "track" ? "tracks" : "podcast_episodes";
  try {
    const oldRow = await env.DB.prepare("SELECT id FROM " + table + " WHERE path=?").bind(body.oldPath).first();
    if (!oldRow) return json({ ok: true, moved: false, reason: "old-row-not-found" });
    const newRow = await env.DB.prepare("SELECT id,data_json FROM " + table + " WHERE path=?").bind(body.newPath).first();
    if (!newRow) return error("修正後路徑尚未成功寫入索引，未調整舊紀錄。", 409);

    let currentData = {};
    try { currentData = JSON.parse(newRow.data_json || "{}"); } catch {}
    const title = String(currentData.title || "已更新項目");
    const subtitle = body.itemType === "track"
      ? ([...(Array.isArray(currentData.artists) ? currentData.artists : []), currentData.albumArtist || ""].filter(Boolean).join(" / ") || currentData.album || null)
      : null;
    const itemType = body.itemType;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE listening_events SET item_id=?,path=?,title=?,subtitle=COALESCE(?,subtitle) WHERE item_type=? AND item_id=?"
      ).bind(newRow.id, body.newPath, title, subtitle, itemType, oldRow.id),
      env.DB.prepare(
        "INSERT INTO listening_progress (item_type,item_id,path,title,subtitle,artwork_hash,position_ms,duration_ms,playback_rate,updated_at) " +
        "SELECT item_type,?,?,?,COALESCE(?,subtitle),artwork_hash,position_ms,duration_ms,playback_rate,updated_at " +
        "FROM listening_progress WHERE item_type=? AND item_id=? " +
        "ON CONFLICT(item_type,item_id) DO UPDATE SET path=excluded.path,title=excluded.title," +
        "subtitle=COALESCE(excluded.subtitle,listening_progress.subtitle)," +
        "position_ms=MAX(listening_progress.position_ms,excluded.position_ms)," +
        "duration_ms=COALESCE(listening_progress.duration_ms,excluded.duration_ms)," +
        "playback_rate=COALESCE(excluded.playback_rate,listening_progress.playback_rate)," +
        "updated_at=MAX(listening_progress.updated_at,excluded.updated_at)"
      ).bind(newRow.id, body.newPath, title, subtitle, itemType, oldRow.id),
      env.DB.prepare("DELETE FROM listening_progress WHERE item_type=? AND item_id=?").bind(itemType, oldRow.id),
      env.DB.prepare("DELETE FROM " + table + " WHERE path=?").bind(body.oldPath)
    ]);
    return json({ ok: true, moved: true, oldId: oldRow.id, newId: newRow.id });
  } catch {
    return error("調整舊索引路徑失敗；新索引已保留，舊索引未確認清除。", 503);
  }
}
