import { json } from "../_lib/api.js";

export async function onRequestGet({ env }) {
  const token = env.FRAME_AUDIO_ADMIN_TOKEN;
  const db = env.DB;
  const artworks = env.ARTWORKS;

  return json({
    ok: true,
    branch: env.CF_PAGES_BRANCH || null,
    hasAdminToken: typeof token === "string" && token.length > 0,
    hasD1: !!db && typeof db.prepare === "function",
    hasR2: !!artworks && typeof artworks.put === "function"
  });
}
