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
    const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 100))));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
    const legacyOffset = url.searchParams.has("offset") && !url.searchParams.has("cursor");
    const showId = url.searchParams.get("showId") || "";
    try {
      const changedSince = url.searchParams.get("changedSince") || "";
      if (changedSince && !Number.isFinite(Date.parse(changedSince))) return error("changedSince 必須是有效的 ISO 日期。");
      const rawCursor = url.searchParams.get("cursor") || "";
      let cursor = null;
      if (rawCursor) {
        try { cursor = JSON.parse(rawCursor); } catch {}
        const expectedLength = kind === "shows" ? 2 : 3;
        if (!Array.isArray(cursor) || cursor.length !== expectedLength ||
            !cursor.every(value => typeof value === "string" && value.length <= 4096)) {
          return error("cursor 格式不正確。");
        }
      }

      const meta = await env.DB.prepare(
        "SELECT item_count FROM catalog_meta WHERE kind=?"
      ).bind(kind).first();
      if (!meta) return error("D1 目錄摘要尚未初始化，請先執行 migrations/0005_catalog_meta.sql。",503);

      const conditions = [];
      const bindings = [];
      if (kind === "episodes" && showId) { conditions.push("show_id=?"); bindings.push(showId); }
      if (changedSince) { conditions.push("indexed_at>=?"); bindings.push(changedSince); }
      if (cursor) {
        if (kind === "shows") {
          conditions.push("(title COLLATE NOCASE,folder_path) > (?,?)");
        } else {
          conditions.push("(COALESCE(published_at,''),title COLLATE NOCASE,path) > (?,?,?)");
        }
        bindings.push(...cursor);
      }
      const filtered = (kind === "episodes" && !!showId) || !!changedSince;
      let total = Number(meta.item_count || 0);
      if (filtered) {
        const countWhere = [];
        const countBindings = [];
        if (kind === "episodes" && showId) { countWhere.push("show_id=?"); countBindings.push(showId); }
        if (changedSince) { countWhere.push("indexed_at>=?"); countBindings.push(changedSince); }
        const countSql = "SELECT COUNT(*) AS count FROM podcast_" + kind +
          (countWhere.length ? " WHERE " + countWhere.join(" AND ") : "");
        const countStatement = env.DB.prepare(countSql);
        const count = countBindings.length
          ? await countStatement.bind(...countBindings).first()
          : await countStatement.first();
        total = Number(count?.count || 0);
      }

      const order = kind === "shows"
        ? " ORDER BY title COLLATE NOCASE,folder_path"
        : " ORDER BY COALESCE(published_at,''),title COLLATE NOCASE,path";
      const selected = kind === "shows"
        ? "SELECT data_json,cover_hash,title,folder_path FROM podcast_shows"
        : "SELECT data_json,title,published_at,path FROM podcast_episodes";
      let statement;
      if (legacyOffset) {
        const where = [];
        const values = [];
        if (kind === "episodes" && showId) { where.push("show_id=?"); values.push(showId); }
        if (changedSince) { where.push("indexed_at>=?"); values.push(changedSince); }
        statement = env.DB.prepare(
          selected + (where.length ? " WHERE " + where.join(" AND ") : "") +
          order + " LIMIT ? OFFSET ?"
        ).bind(...values,limit,offset);
      } else {
        statement = env.DB.prepare(
          selected + (conditions.length ? " WHERE " + conditions.join(" AND ") : "") +
          order + " LIMIT ?"
        ).bind(...bindings,limit+1);
      }

      const result = await statement.all();
      const rawRows = result.results || [];
      const rows = legacyOffset ? rawRows : rawRows.slice(0,limit);
      const hasMore = legacyOffset
        ? offset + rows.length < total
        : rawRows.length > limit;
      const items = rows.map(row => {
        const item = JSON.parse(row.data_json);
        return kind === "shows" ? {...item,coverHash:row.cover_hash||null} : item;
      });
      let nextCursor = null;
      if (!legacyOffset && hasMore && rows.length) {
        const last = rows[rows.length-1];
        nextCursor = kind === "shows"
          ? [String(last.title||""),String(last.folder_path||"")]
          : [String(last.published_at||""),String(last.title||""),String(last.path||"")];
      }
      return json({
        ok:true,kind,showId:showId||null,total,limit,
        offset:legacyOffset?offset:undefined,
        nextOffset:legacyOffset&&hasMore?offset+items.length:null,
        nextCursor,hasMore,changedSince:changedSince||null,items
      });
    } catch {
      return error("Podcast 資料表或目錄摘要尚未初始化。請先執行 migrations/0002_podcasts.sql 與 migrations/0005_catalog_meta.sql。", 503);
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
      await env.DB.batch([...items.map(show => env.DB.prepare(SHOW_SQL).bind(...showRow(show, now))), env.DB.prepare("UPDATE catalog_meta SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE kind='shows'")]);
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
        env.DB.prepare(EPISODE_SQL).bind(...episodeRow(episode, now)),
        env.DB.prepare("UPDATE catalog_meta SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE kind='shows'"),
        env.DB.prepare("UPDATE catalog_meta SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE kind='episodes'")
      ]);
      return json({ ok: true, kind, savedShows: 1, savedEpisodes: 1 });
    }
    return error("kind 只能是 shows 或 episodes。");
  } catch {
    return error("Podcast 資料寫入 D1 失敗。請確認已執行 migrations/0002_podcasts.sql。", 503);
  }
}
