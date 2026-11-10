import { error, json, requireAdmin, readJson } from "../../_lib/api.js";

export async function onRequestPost({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") return error("D1 binding DB 尚未設定。", 503);

  let body;
  try { body = await readJson(request, 100000); }
  catch (e) { return error(e.message, 413); }

  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100 ||
      !paths.every(path => typeof path === "string" && path.startsWith("/") && path.length <= 4096 && path.indexOf(String.fromCharCode(0)) === -1)) {
    return error("每次查詢必須包含 1 至 100 個有效檔案路徑。");
  }

  try {
    const placeholders = paths.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      "SELECT path,file_size,modified_at FROM tracks WHERE path IN (" + placeholders + ")"
    ).bind(...paths).all();
    return json({
      ok: true,
      items: (rows.results || []).map(row => ({
        path: row.path,
        sizeBytes: Number(row.file_size || 0),
        modifiedAt: row.modified_at || null
      }))
    });
  } catch {
    return error("D1 曲目查詢失敗，請確認 tracks 資料表已初始化。", 503);
  }
}
