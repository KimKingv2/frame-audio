import { error, json, requireAdmin } from "../../_lib/api.js";

export async function onRequestGet({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  try {
    const metaResult = await env.DB.prepare(
      "SELECT kind,item_count,revision FROM catalog_meta"
    ).all();
    const meta = new Map((metaResult.results || []).map(row => [row.kind, row]));
    const requiredKinds = ["tracks","folders","shows","episodes"];
    if (requiredKinds.some(kind => !meta.has(kind))) {
      return error("D1 目錄摘要尚未初始化，請先執行 migrations/0005_catalog_meta.sql。",503);
    }

    const counts = {
      tracks: Number(meta.get("tracks")?.item_count || 0),
      folders: Number(meta.get("folders")?.item_count || 0),
      shows: Number(meta.get("shows")?.item_count || 0),
      episodes: Number(meta.get("episodes")?.item_count || 0)
    };
    const revisions = Object.fromEntries(requiredKinds.map(kind => [
      kind, String(meta.get(kind)?.revision || 0)
    ]));
    const revision = requiredKinds.map(kind => kind + ":" + revisions[kind]).join("|");

    let shows = [];
    let podcastSchemaReady = false;
    try {
      const rows = await env.DB.prepare(
        "SELECT data_json,cover_hash,(SELECT COUNT(*) FROM podcast_episodes WHERE show_id=podcast_shows.id) AS episode_count " +
        "FROM podcast_shows ORDER BY title COLLATE NOCASE,folder_path LIMIT 6"
      ).all();
      podcastSchemaReady = true;
      shows = (rows.results || []).map(row => {
        let item = {};
        try { item = JSON.parse(row.data_json || "{}"); } catch {}
        return { ...item, coverHash: row.cover_hash || item.coverHash || null, episodeCount: Number(row.episode_count || 0) };
      });
    } catch {
      // Music remains available when the additive Podcast migration is absent.
    }

    let recentTracks = [];
    try {
      const recentRows = await env.DB.prepare(
        "SELECT item_id,path,title,subtitle,artwork_hash,duration_ms,updated_at " +
        "FROM listening_progress WHERE item_type='track' ORDER BY updated_at DESC LIMIT 8"
      ).all();
      const records = recentRows.results || [];
      if (records.length) {
        const paths = records.map(row => row.path).filter(path => typeof path === "string" && path.startsWith("/"));
        let byPath = new Map();
        if (paths.length) {
          const placeholders = paths.map(() => "?").join(",");
          const trackRows = await env.DB.prepare(
            "SELECT path,data_json FROM tracks WHERE path IN (" + placeholders + ")"
          ).bind(...paths).all();
          byPath = new Map((trackRows.results || []).map(row => {
            let item = {};
            try { item = JSON.parse(row.data_json || "{}"); } catch {}
            return [row.path, item];
          }));
        }
        recentTracks = records.map(record => {
          const item = byPath.get(record.path);
          return item
            ? { ...item, recentlyPlayedAt: record.updated_at }
            : {
                id: record.item_id,
                path: record.path,
                title: record.title,
                subtitle: record.subtitle,
                artworkHash: record.artwork_hash,
                durationMs: Number(record.duration_ms || 0),
                recentlyPlayedAt: record.updated_at
              };
        });
      }
    } catch {
      // Listening history is optional; a fresh library still renders without it.
    }

    return json({ok:true,counts,revision,revisions,podcastSchemaReady,recentTracks,shows});
  } catch {
    return error("讀取首頁曲庫摘要失敗，請確認 D1 資料表及 migrations/0005_catalog_meta.sql 已初始化。", 503);
  }
}
