import { error, json, readJson, requireAdmin } from "../../_lib/api.js";
import { publicConnectionProfiles, readConnectionProfiles, saveConnectionProfiles } from "../../_lib/connection-settings.js";

export async function onRequest({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  if (request.method === "GET") {
    try {
      const state = await readConnectionProfiles(env);
      return json({
        ok: true,
        profiles: publicConnectionProfiles(state.profiles),
        settingsTableReady: state.settingsTableReady
      });
    } catch (cause) {
      return error(cause.message || "讀取 OpenList 連線設定失敗。", 503);
    }
  }

  if (request.method === "POST") {
    let body;
    try { body = await readJson(request, 30000); }
    catch (cause) { return error(cause.message || "連線設定格式不正確。", 400); }
    try {
      const profiles = await saveConnectionProfiles(env, body?.profiles || {});
      return json({
        ok: true,
        saved: true,
        profiles: publicConnectionProfiles(profiles)
      });
    } catch (cause) {
      return error(cause.message || "保存 OpenList 連線設定失敗。", 503);
    }
  }

  return error("Method Not Allowed", 405);
}
