import { error, json, requireAdmin } from "../../_lib/api.js";

export async function onRequestGet({request,env}) {
  // Safe, unauthenticated presence check. Never returns secret values.
  if (new URL(request.url).searchParams.get("diagnostics") === "1") {
    return json({
      ok: true,
      branch: env.CF_PAGES_BRANCH || null,
      hasAdminToken: typeof env.FRAME_AUDIO_ADMIN_TOKEN === "string" && env.FRAME_AUDIO_ADMIN_TOKEN.length > 0,
      hasD1: !!env.DB && typeof env.DB.prepare === "function",
      hasR2: !!env.ARTWORKS && typeof env.ARTWORKS.put === "function"
    });
  }

  const denied=await requireAdmin(request,env);
  if(denied)return denied;
  if(!env.DB||typeof env.DB.prepare!=="function")return error("D1 尚未綁定，請新增名為 DB 的 D1 binding。",503);
  if(!env.ARTWORKS||typeof env.ARTWORKS.put!=="function")return error("R2 尚未綁定，請新增名為 ARTWORKS 的 R2 binding。",503);
  try{
    const [tracks,folders]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM tracks").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first()
    ]);
    let podcastSchemaReady = false;
    let listeningSchemaReady = false;
    let podcastShows = 0;
    let podcastEpisodes = 0;
    try {
      const [shows, episodes] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_shows").first(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM podcast_episodes").first()
      ]);
      podcastSchemaReady = true;
      podcastShows = Number(shows?.count || 0);
      podcastEpisodes = Number(episodes?.count || 0);
    } catch {
      // Podcast migration is additive and can be applied separately.
    }
    try {
      await env.DB.prepare("SELECT COUNT(*) AS count FROM listening_progress").first();
      await env.DB.prepare("SELECT COUNT(*) AS count FROM listening_events").first();
      listeningSchemaReady = true;
    } catch {
      // Listening analytics migration is additive and may be applied after the catalogue migrations.
    }
    return json({
      ok:true,storage:"cloudflare-d1-r2",d1:true,r2:true,
      tracks:Number(tracks?.count||0),folders:Number(folders?.count||0),
      podcastSchemaReady,podcastShows,podcastEpisodes,listeningSchemaReady
    });
  }catch{return error("D1 已綁定，但尚未初始化資料表。請執行 migrations/0001_catalog.sql。",503);}
}
