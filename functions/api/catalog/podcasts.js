import { error, json, requireAdmin, readJson, isObject } from "../../_lib/api.js";

const SHOW_SQL = [
  "INSERT INTO podcast_shows (id,folder_path,title,author,description,cover_hash,data_json,indexed_at)",
  "VALUES (?,?,?,?,?,?,?,?)",
  "ON CONFLICT(folder_path) DO UPDATE SET id=excluded.id,title=excluded.title,",
  "author=COALESCE(excluded.author,podcast_shows.author),",
  "description=COALESCE(excluded.description,podcast_shows.description),",
  "cover_hash=COALESCE(excluded.cover_hash,podcast_shows.cover_hash),",
  "data_json=excluded.data_json,indexed_at=excluded.indexed_at"
].join(" ");

const EPISODE_SQL = [
  "INSERT INTO podcast_episodes (id,show_id,path,title,description,episode_number,season_number,published_at,duration_ms,audio_json,file_size,modified_at,artwork_hash,data_json,indexed_at)",
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  "ON CONFLICT(path) DO UPDATE SET id=excluded.id,show_id=excluded.show_id,title=excluded.title,",
  "description=excluded.description,episode_number=excluded.episode_number,season_number=excluded.season_number,",
  "published_at=excluded.published_at,duration_ms=excluded.duration_ms,audio_json=excluded.audio_json,",
  "file_size=excluded.file_size,modified_at=excluded.modified_at,artwork_hash=excluded.artwork_hash,",
  "data_json=excluded.data_json,indexed_at=excluded.indexed_at"
].join(" ");

function validPath(value) {
  return typeof value === "string" && value.startsWith("/") &&
    !value.includes("\0") && value.length <= 4096;
}
function validShow(show) {
  return isObject(show) && typeof show.id === "string" && show.id.length > 0 &&
    typeof show.title === "string" && show.title.trim().length > 0 &&
    validPath(show.folderPath);
}
function validEpisode(episode) {
  return isObject(episode) && isObject(episode.file) &&
    typeof episode.id === "string" && episode.id.length > 0 &&
    typeof episode.showId === "string" && episode.showId.length > 0 &&
    typeof episode.title === "string" && episode.title.trim().length > 0 &&
    validPath(episode.file.path) &&
    Number.isSafeInteger(episode.file.sizeBytes) && episode.file.sizeBytes >= 0;
}
function showRow(show, now) {
  return [
    show.id, show.folderPath, show.title.trim(),
    show.author || null, show.description || null, show.coverHash || null,
    JSON.stringify(show), now
  ];
}
function episodeRow(episode, now) {
  const file = episode.file;
  return [
    episode.id, episode.showId, file.path, episode.title,
    episode.description || null,
    Number.isSafeInteger(episode.episodeNumber) ? episode.episodeNumber : null,
    Number.isSafeInteger(episode.seasonNumber) ? episode.seasonNumber : null,
    episode.publishedAt || null,
    Number.isFinite(episode.durationMs) ? Math.max(0, Math.round(episode.durationMs)) : null,
    JSON.stringify(episode.audio || {}),
    file.sizeBytes, file.modifiedAt || null,
    episode.artwork?.sha256 || null,
    JSON.stringify(episode), now
  ];
}

export async function onRequest({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "shows";

  if (request.method === "GET") {
    if (!["shows", "episodes"].includes(kind)) return error("kind 只能是 shows 或 episodes。");
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const showId = url.searchParams.get("showId") || "";
    try {
      if (kind === "shows") {
        const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_shows").first();
        const rows = await env.DB.prepare(
          "SELECT data_json,cover_hash FROM podcast_shows ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?"
        ).bind(limit, offset).all();
        const items = (rows.results || []).map(row => ({
          ...JSON.parse(row.data_json),
          coverHash: row.cover_hash || null
        }));
        const total = Number(count?.count || 0);
        return json({ ok: true, kind, total, limit, offset,
          nextOffset: offset + items.length < total ? offset + items.length : null, items });
      }
      const where = showId ? " WHERE show_id=?" : "";
      const countStatement = showId
        ? env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_episodes WHERE show_id=?").bind(showId)
        : env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_episodes");
      const rowsStatement = showId
        ? env.DB.prepare("SELECT data_json FROM podcast_episodes WHERE show_id=? ORDER BY COALESCE(published_at,''),title COLLATE NOCASE LIMIT ? OFFSET ?")
            .bind(showId, limit, offset)
        : env.DB.prepare("SELECT data_json FROM podcast_episodes ORDER BY COALESCE(published_at,''),title COLLATE NOCASE LIMIT ? OFFSET ?")
            .bind(limit, offset);
      const [count, rows] = await Promise.all([countStatement.first(), rowsStatement.all()]);
      const items = (rows.results || []).map(row => JSON.parse(row.data_json));
      const total = Number(count?.count || 0);
      return json({ ok: true, kind, showId: showId || null, total, limit, offset,
        nextOffset: offset + items.length < total ? offset + items.length : null, items });
    } catch {
      return error("Podcast 資料表尚未初始化或查詢失敗。請先執行 migrations/0002_podcasts.sql。", 503);
    }
  }

  if (request.method !== "POST") return error("Method Not Allowed", 405);
  let body;
  try { body = await readJson(request, 1000000); }
  catch (e) { return error(e.message, 413); }
  const now = new Date().toISOString();

  try {
    if (kind === "shows") {
      const items = Array.isArray(body.shows) ? body.shows : [body.show];
      if (!items.length || items.length > 100 || !items.every(validShow)) {
        return error("每批必須包含 1 至 100 筆有效 Podcast 節目資料。");
      }
      await env.DB.batch(items.map(show => env.DB.prepare(SHOW_SQL).bind(...showRow(show, now))));
      return json({ ok: true, kind, saved: items.length });
    }
    if (kind === "episodes") {
      const show = body.show;
      const episode = body.episode;
      if (!validShow(show) || !validEpisode(episode) || episode.showId !== show.id) {
        return error("Podcast 節目或單集資料格式不正確。");
      }
      await env.DB.batch([
        env.DB.prepare(SHOW_SQL).bind(...showRow(show, now)),
        env.DB.prepare(EPISODE_SQL).bind(...episodeRow(episode, now))
      ]);
      return json({ ok: true, kind, savedShows: 1, savedEpisodes: 1 });
    }
    return error("kind 只能是 shows 或 episodes。");
  } catch {
    return error("Podcast 資料寫入 D1 失敗。請確認已執行 migrations/0002_podcasts.sql。", 503);
  }
}
