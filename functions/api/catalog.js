import { error, json, requireAdmin, readJson, isObject } from "../_lib/api.js";

const TRACK_SQL = [
  "INSERT INTO tracks (id,path,title,artists_json,album,album_artist,track_number,disc_number,year,genres_json,duration_ms,audio_json,file_size,modified_at,signature,artwork_hash,lyrics_json,data_json,indexed_at)",
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  "ON CONFLICT(path) DO UPDATE SET id=excluded.id,title=excluded.title,artists_json=excluded.artists_json,",
  "album=excluded.album,album_artist=excluded.album_artist,track_number=excluded.track_number,",
  "disc_number=excluded.disc_number,year=excluded.year,genres_json=excluded.genres_json,",
  "duration_ms=excluded.duration_ms,audio_json=excluded.audio_json,file_size=excluded.file_size,",
  "modified_at=excluded.modified_at,signature=excluded.signature,artwork_hash=excluded.artwork_hash,",
  "lyrics_json=excluded.lyrics_json,data_json=excluded.data_json,indexed_at=excluded.indexed_at"
].join(" ");

const FOLDER_SQL = [
  "INSERT INTO folders (id,path,name,parent_id,child_folder_ids_json,track_ids_json,direct_track_count,recursive_track_count,data_json,indexed_at)",
  "VALUES (?,?,?,?,?,?,?,?,?,?)",
  "ON CONFLICT(path) DO UPDATE SET id=excluded.id,name=excluded.name,parent_id=excluded.parent_id,",
  "child_folder_ids_json=excluded.child_folder_ids_json,track_ids_json=excluded.track_ids_json,",
  "direct_track_count=excluded.direct_track_count,recursive_track_count=excluded.recursive_track_count,",
  "data_json=excluded.data_json,indexed_at=excluded.indexed_at"
].join(" ");

function trackRow(t) {
  const f = t.file;
  return [t.id,f.path,t.title,JSON.stringify(t.artists||[]),t.album||null,t.albumArtist||null,
    Number.isInteger(t.trackNumber)?t.trackNumber:null,Number.isInteger(t.discNumber)?t.discNumber:null,
    Number.isInteger(t.year)?t.year:null,JSON.stringify(t.genres||[]),
    Number.isFinite(t.durationMs)?Math.max(0,Math.round(t.durationMs)):null,
    JSON.stringify(t.audio||{}),f.sizeBytes,f.modifiedAt||null,f.signature||null,
    t.artwork?.sha256||null,JSON.stringify(t.lyrics||null),JSON.stringify(t),new Date().toISOString()];
}
function validTrack(t) {
  return isObject(t)&&isObject(t.file)&&typeof t.id==="string"&&t.id.length>0
    &&typeof t.title==="string"&&t.title.length>0&&typeof t.file.path==="string"
    &&t.file.path.startsWith("/")&&!t.file.path.includes("\0")
    &&Number.isSafeInteger(t.file.sizeBytes)&&t.file.sizeBytes>=0;
}
function validFolder(f) {
  return isObject(f)&&typeof f.id==="string"&&typeof f.name==="string"
    &&typeof f.path==="string"&&f.path.startsWith("/")&&!f.path.includes("\0");
}
function parsePathCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(value);
    return Array.isArray(cursor) && cursor.length === 1 &&
      typeof cursor[0] === "string" && cursor[0].startsWith("/") &&
      cursor[0].length <= 4096 ? cursor[0] : null;
  } catch { return null; }
}
export async function onRequest({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB) return error("D1 binding DB 尚未設定。",503);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "tracks";
  if (request.method === "GET") {
    const limit = Math.min(kind==="folders"?1000:500,Math.max(1,Math.floor(Number(url.searchParams.get("limit")||100))));
    const offset = Math.max(0,Math.floor(Number(url.searchParams.get("offset")||0)));
    const legacyOffset = url.searchParams.has("offset") && !url.searchParams.has("cursor");
    const table = kind==="folders"?"folders":kind==="tracks"?"tracks":null;
    if (!table) return error("kind 只能是 tracks 或 folders。");
    const changedSince = url.searchParams.get("changedSince") || "";
    if (changedSince && !Number.isFinite(Date.parse(changedSince))) return error("changedSince 必須是有效的 ISO 日期。");
    const cursor = parsePathCursor(url.searchParams.get("cursor") || "");
    if (url.searchParams.has("cursor") && !cursor) return error("cursor 格式不正確。");
    try {
      const meta = await env.DB.prepare(
        "SELECT item_count FROM catalog_meta WHERE kind=?"
      ).bind(kind).first();
      if (!meta) return error("D1 目錄摘要尚未初始化，請先執行 migrations/0004_catalog_meta.sql。",503);

      let total = Number(meta.item_count || 0);
      if (changedSince) {
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM " + table + " WHERE indexed_at>=?"
        ).bind(changedSince).first();
        total = Number(count?.count || 0);
      }

      let statement;
      if (legacyOffset) {
        statement = env.DB.prepare(
          "SELECT path,data_json FROM " + table +
          (changedSince ? " WHERE indexed_at>=?" : "") +
          " ORDER BY path LIMIT ? OFFSET ?"
        );
        statement = changedSince
          ? statement.bind(changedSince,limit,offset)
          : statement.bind(limit,offset);
      } else {
        const conditions = [];
        const bindings = [];
        if (changedSince) { conditions.push("indexed_at>=?"); bindings.push(changedSince); }
        if (cursor) { conditions.push("path>?"); bindings.push(cursor); }
        const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
        statement = env.DB.prepare(
          "SELECT path,data_json FROM " + table + where + " ORDER BY path LIMIT ?"
        ).bind(...bindings,limit+1);
      }

      const result = await statement.all();
      const rawRows = result.results || [];
      const rows = legacyOffset ? rawRows : rawRows.slice(0,limit);
      const hasMore = legacyOffset
        ? offset + rows.length < total
        : rawRows.length > limit;
      const items = rows.map(row=>JSON.parse(row.data_json));
      const lastPath = rows.length ? String(rows[rows.length-1].path || "") : "";
      return json({
        ok:true,kind,total,limit,
        offset:legacyOffset?offset:undefined,
        cursor:cursor?JSON.stringify([cursor]):null,
        nextOffset:legacyOffset && hasMore ? offset+items.length : null,
        nextCursor:!legacyOffset && hasMore && lastPath ? [lastPath] : null,
        hasMore,items
      });
    } catch { return error("D1 資料表尚未初始化或查詢失敗。",503); }
  }
  if (request.method !== "POST") return error("Method Not Allowed",405);
  let body;
  try { body=await readJson(request,1000000); } catch(e) { return error(e.message,413); }
  const now = new Date().toISOString();
  try {
    if (kind==="tracks") {
      const items=Array.isArray(body.tracks)?body.tracks:[body.track];
      if (!items.length||items.length>100||!items.every(validTrack)) return error("每批必須包含 1 至 100 筆有效歌曲資料。");
      await env.DB.batch([
        ...items.map(t=>env.DB.prepare(TRACK_SQL).bind(...trackRow(t))),
        env.DB.prepare("UPDATE catalog_meta SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE kind='tracks'")
      ]);
      return json({ok:true,saved:items.length,kind});
    }
    if (kind==="folders") {
      const items=body.folders;
      if (!Array.isArray(items)||items.length<1||items.length>500||!items.every(validFolder)) return error("每批必須包含 1 至 500 筆有效資料夾資料。");
      const batch=items.map(f=>env.DB.prepare(FOLDER_SQL).bind(
        f.id,f.path,f.name,f.parentId||null,JSON.stringify(f.childFolderIds||[]),
        JSON.stringify(f.trackIds||[]),Number(f.directTrackCount||0),Number(f.recursiveTrackCount||0),
        JSON.stringify(f),now));
      batch.push(env.DB.prepare("UPDATE catalog_meta SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE kind='folders'"));
      await env.DB.batch(batch);
      return json({ok:true,saved:items.length,kind});
    }
    return error("kind 只能是 tracks 或 folders。");
  } catch { return error("寫入 D1 失敗。請確認已執行 migrations/0004_catalog_meta.sql。",503); }
}
