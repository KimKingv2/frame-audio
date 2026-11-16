import { error, json, requireAdmin } from "../../_lib/api.js";

export async function onRequestGet({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  try {
    const [tracks, folders] = await Promise.all([
      env.DB.prepare("SELECT id FROM tracks").all(),
      env.DB.prepare("SELECT id FROM folders").all()
    ]);
    let shows = [];
    let episodes = [];
    try {
      const [showRows, episodeRows] = await Promise.all([
        env.DB.prepare("SELECT id FROM podcast_shows").all(),
        env.DB.prepare("SELECT id FROM podcast_episodes").all()
      ]);
      shows = (showRows.results || []).map(row => row.id);
      episodes = (episodeRows.results || []).map(row => row.id);
    } catch {
      // Podcast tables are an optional additive migration.
    }
    return json({
      ok: true,
      manifest: {
        tracks: (tracks.results || []).map(row => row.id),
        folders: (folders.results || []).map(row => row.id),
        shows,
        episodes
      }
    });
  } catch {
    return error("讀取曲庫同步清單失敗。", 503);
  }
}
