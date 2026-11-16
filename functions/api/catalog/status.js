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
  try {
    const metaResult = await env.DB.prepare(
      "SELECT kind,item_count,revision FROM catalog_meta"
    ).all();
    const meta = new Map((metaResult.results || []).map(row => [row.kind,row]));
    if (["tracks","folders","shows","episodes"].some(kind => !meta.has(kind))) {
      return error("請先在此環境的 D1 執行 migrations/0004_catalog_meta.sql。",503);
    }

    let podcastSchemaReady = false;
    let listeningSchemaReady = false;
    try {
      await Promise.all([
        env.DB.prepare("SELECT 1 FROM podcast_shows LIMIT 1").first(),
        env.DB.prepare("SELECT 1 FROM podcast_episodes LIMIT 1").first()
      ]);
      podcastSchemaReady = true;
    } catch {
      // Podcast migration is additive and may be applied separately.
    }
    try {
      await Promise.all([
        env.DB.prepare("SELECT 1 FROM listening_progress LIMIT 1").first(),
        env.DB.prepare("SELECT 1 FROM listening_events LIMIT 1").first()
      ]);
      listeningSchemaReady = true;
    } catch {
      // Listening analytics migration is additive.
    }

    return json({
      ok:true,storage:"cloudflare-d1-r2",d1:true,r2:true,
      tracks:Number(meta.get("tracks")?.item_count||0),
      folders:Number(meta.get("folders")?.item_count||0),
      podcastSchemaReady,
      podcastShows:podcastSchemaReady?Number(meta.get("shows")?.item_count||0):0,
      podcastEpisodes:podcastSchemaReady?Number(meta.get("episodes")?.item_count||0):0,
      listeningSchemaReady
    });
  } catch {
    return error("D1 已綁定，但目錄摘要尚未初始化。請執行 migrations/0004_catalog_meta.sql。",503);
  }
}
