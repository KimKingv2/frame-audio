import { error, json, requireAdmin, readJson, isObject } from "../_lib/api.js";

const ITEM_TYPES = new Set(["track", "episode"]);
const VIEWS = new Set(["progress", "continue", "report"]);

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !value.includes("\0");
}
function validPath(value) {
  return typeof value === "string" && value.startsWith("/") &&
    value.length <= 4096 && !value.includes("\0");
}
function validText(value, max = 500) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function isoDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function reportCutoff(period) {
  const days = ({ week: 7, month: 30, year: 365 })[period];
  return days ? new Date(Date.now() - days * 86400000).toISOString() : null;
}

export async function onRequest({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  if (request.method === "GET") {
    const url = new URL(request.url);
    const view = url.searchParams.get("view") || "progress";
    const itemType = url.searchParams.get("itemType") || "episode";
    if (!VIEWS.has(view)) return error("view 必須是 progress、continue 或 report。");
    if (!ITEM_TYPES.has(itemType)) return error("itemType 必須是 track 或 episode。");

    try {
      if (view === "progress") {
        const itemId = url.searchParams.get("itemId") || "";
        if (!validId(itemId)) return error("itemId 無效。");
        const row = await env.DB.prepare(
          "SELECT item_type,item_id,path,title,subtitle,artwork_hash,position_ms,duration_ms,playback_rate,updated_at " +
          "FROM listening_progress WHERE item_type=? AND item_id=?"
        ).bind(itemType, itemId).first();
        return json({ ok: true, item: row || null });
      }

      if (view === "continue") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
        const rows = await env.DB.prepare(
          "SELECT item_type,item_id,path,title,subtitle,artwork_hash,position_ms,duration_ms,playback_rate,updated_at " +
          "FROM listening_progress WHERE item_type=? AND position_ms>0 " +
          "AND (duration_ms IS NULL OR position_ms<duration_ms-5000) " +
          "ORDER BY updated_at DESC LIMIT ?"
        ).bind(itemType, limit).all();
        return json({ ok: true, items: rows.results || [] });
      }

      const period = url.searchParams.get("period") || "week";
      if (!["week", "month", "year", "all"].includes(period)) return error("period 必須是 week、month、year 或 all。");
      const cutoff = reportCutoff(period);
      const where = cutoff ? " WHERE item_type=? AND started_at>=?" : " WHERE item_type=?";
      const bindings = cutoff ? [itemType, cutoff] : [itemType];
      const [summary, rows] = await Promise.all([
        env.DB.prepare(
          "SELECT COUNT(*) AS plays,COALESCE(SUM(listened_seconds),0) AS listened_seconds," +
          "COUNT(DISTINCT item_id) AS distinct_items,COALESCE(SUM(completed),0) AS completed " +
          "FROM listening_events" + where
        ).bind(...bindings).first(),
        env.DB.prepare(
          "SELECT item_id,MAX(title) AS title,MAX(subtitle) AS subtitle,COUNT(*) AS plays," +
          "COALESCE(SUM(listened_seconds),0) AS listened_seconds," +
          "COALESCE(SUM(completed),0) AS completed,MAX(started_at) AS last_played " +
          "FROM listening_events" + where +
          " GROUP BY item_id ORDER BY listened_seconds DESC,plays DESC LIMIT 200"
        ).bind(...bindings).all()
      ]);
      return json({
        ok: true, itemType, period, cutoff,
        summary: {
          plays: Number(summary?.plays || 0),
          listenedSeconds: Number(summary?.listened_seconds || 0),
          distinctItems: Number(summary?.distinct_items || 0),
          completed: Number(summary?.completed || 0)
        },
        items: rows.results || []
      });
    } catch {
      return error("收聽資料表尚未初始化或查詢失敗。請先執行 migrations/0003_listening.sql。", 503);
    }
  }

  if (request.method !== "POST") return error("Method Not Allowed", 405);
  let body;
  try { body = await readJson(request, 30000); }
  catch (e) { return error(e.message, 413); }
  if (!isObject(body)) return error("收聽資料格式不正確。");

  const action = body.action;
  const itemType = body.itemType;
  if (!ITEM_TYPES.has(itemType)) return error("itemType 必須是 track 或 episode。");
  const now = new Date().toISOString();

  try {
    if (action === "progress") {
      if (!validId(body.itemId) || !validPath(body.path) || !validText(body.title) ||
          !Number.isFinite(body.positionMs) || body.positionMs < 0 ||
          (body.durationMs != null && (!Number.isFinite(body.durationMs) || body.durationMs < 0)) ||
          (body.playbackRate != null && (!Number.isFinite(body.playbackRate) || body.playbackRate < 0.5 || body.playbackRate > 2))) {
        return error("播放進度欄位無效。");
      }
      const position = Math.min(7 * 24 * 60 * 60 * 1000, Math.round(body.positionMs));
      const duration = body.durationMs == null ? null : Math.round(body.durationMs);
      await env.DB.prepare(
        "INSERT INTO listening_progress (item_type,item_id,path,title,subtitle,artwork_hash,position_ms,duration_ms,playback_rate,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_type,item_id) DO UPDATE SET " +
        "path=excluded.path,title=excluded.title,subtitle=excluded.subtitle," +
        "artwork_hash=excluded.artwork_hash,position_ms=excluded.position_ms," +
        "duration_ms=excluded.duration_ms,playback_rate=excluded.playback_rate,updated_at=excluded.updated_at"
      ).bind(
        itemType, body.itemId, body.path, body.title.slice(0, 500),
        validText(body.subtitle || "", 500) ? body.subtitle.slice(0, 500) : null,
        /^[a-f0-9]{64}$/i.test(String(body.artworkHash || "")) ? body.artworkHash : null,
        position, duration, body.itemType === "episode" ? Number(body.playbackRate || 1) : 1, now
      ).run();
      return json({ ok: true, savedAt: now, positionMs: position });
    }

    if (action === "event") {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(body.sessionId || "")) ||
          !validId(body.itemId) || !validText(body.title) ||
          !validPath(body.path) ||
          !Number.isFinite(body.listenedSeconds) || body.listenedSeconds < 0) {
        return error("播放事件欄位無效。");
      }
      const startedAt = isoDate(body.startedAt) || now;
      const listenedSeconds = Math.min(7 * 24 * 60 * 60, Math.round(body.listenedSeconds));
      const durationSeconds = Number.isFinite(body.durationSeconds) && body.durationSeconds > 0
        ? Math.round(body.durationSeconds) : null;
      await env.DB.prepare(
        "INSERT INTO listening_events (session_id,item_type,item_id,path,title,subtitle,started_at,listened_seconds,duration_seconds,completed,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET " +
        "listened_seconds=MAX(listening_events.listened_seconds,excluded.listened_seconds)," +
        "duration_seconds=COALESCE(excluded.duration_seconds,listening_events.duration_seconds)," +
        "completed=MAX(listening_events.completed,excluded.completed),updated_at=excluded.updated_at"
      ).bind(
        body.sessionId, itemType, body.itemId, body.path, body.title.slice(0, 500),
        validText(body.subtitle || "", 500) ? body.subtitle.slice(0, 500) : null,
        startedAt, listenedSeconds, durationSeconds, body.completed ? 1 : 0, now
      ).run();
      return json({ ok: true, savedAt: now, listenedSeconds });
    }
    return error("action 必須是 progress 或 event。");
  } catch {
    return error("收聽資料寫入 D1 失敗。請確認已執行 migrations/0003_listening.sql。", 503);
  }
}
