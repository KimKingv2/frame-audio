import { readJson, error } from "../../_lib/api.js";
import { postOpenList, validOpenListPath, normalizedRawUrl, json } from "../../_lib/openlist.js";

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await readJson(request, 65536); }
  catch (cause) { return error(cause.message || "檔案資訊請求格式不正確。", 400); }

  if (!validOpenListPath(body?.path)) return error("OpenList 檔案路徑無效。", 400);

  const result = await postOpenList(env, "get", {
    path: body.path,
    password: ""
  }, 20000);
  if (result.response) return result.response;

  const payload = result.payload;
  if (Number(payload.code) === 200 && payload.data && typeof payload.data === "object" &&
      payload.data.raw_url) {
    const rawUrl = normalizedRawUrl(payload.data.raw_url, result.baseUrl);
    if (!rawUrl) return error("OpenList 回傳的 raw_url 格式不受支援。", 502);
    payload.data.raw_url = rawUrl;
  }
  return json(payload);
}
