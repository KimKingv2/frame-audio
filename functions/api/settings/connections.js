import { error, json, requireAdmin } from "../../_lib/api.js";
import { publicConnectionProfiles, readConnectionProfiles } from "../../_lib/connection-settings.js";

export async function onRequest({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (request.method !== "GET") {
    return error("VPS Alist、OpenList Worker 與 K40 Alist 憑證只能透過 Cloudflare Pages Variables and Secrets 管理；此端點僅提供唯讀狀態。", 405);
  }
  try {
    const state = await readConnectionProfiles(env);
    return json({ ok: true, profiles: publicConnectionProfiles(state.profiles) });
  } catch (cause) {
    return error(cause.message || "讀取 OpenList 來源狀態失敗。", 503);
  }
}
