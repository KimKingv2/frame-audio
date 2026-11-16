import { error, json, requireAdmin } from "../../_lib/api.js";

export async function onRequestGet({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  try {
    const [trackCount, folderCount, trackRevision, folderRevision] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM tracks").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first(),
      env.DB.prepare("SELECT MAX(indexed_at) AS revision FROM tracks").first(),
      env.DB.prepare("SELECT MAX(indexed_at) AS revision FROM folders").first()
    ]);

    let shows = [];
    let showCount = 0;
    let episodeCount = 0;
    let showRevision = "";
    let episodeRevision = "";
    let podcastSchemaReady = false;
    try {
      const [counts, revisions, rows] = await Promise.all([
        Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_shows").first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_episodes").first()
        ]),
        Promise.all([
          env.DB.prepare("SELECT MAX(indexed_at) AS revision FROM podcast_shows").first(),
          env.DB.prepare("SELECT MAX(indexed_at) AS revision FROM podcast_episodes").first()
        ]),
        env.DB.prepare(
          "SELECT data_json,cover_hash,(SELECT COUNT(*) FROM podcast_episodes WHERE show_id=podcast_shows.id) AS episode_count FROM podcast_shows ORDER BY title COLLATE NOCASE LIMIT 6"
        ).all()
      ]);
      podcastSchemaReady = true;
      showCount = Number(counts[0]?.count || 0);
      episodeCount = Number(counts[1]?.count || 0);
      showRevision = revisions[0]?.revision || "";
      episodeRevision = revisions[1]?.revision || "";
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

    const counts = {
      tracks: Number(trackCount?.count || 0),
      folders: Number(folderCount?.count || 0),
      shows: showCount,
      episodes: episodeCount
    };
    const revision = [
      trackRevision?.revision,
      folderRevision?.revision,
      showRevision,
      episodeRevision
    ].filter(Boolean).sort().at(-1) || "";

    return json({
      ok: true,
      counts,
      revision,
      podcastSchemaReady,
      recentTracks,
      shows
    });
  } catch {
    return error("讀取首頁曲庫摘要失敗，請確認 D1 資料表已初始化。", 503);
  }
}
