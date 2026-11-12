import { readJson, error } from "../../_lib/api.js";
import { postOpenList, validOpenListPath, json } from "../../_lib/openlist.js";

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await readJson(request, 65536); }
  catch (cause) { return error(cause.message || "目錄請求格式不正確。", 400); }

  if (!validOpenListPath(body?.path)) return error("OpenList 目錄路徑無效。", 400);
  const page = Number(body.page ?? 1);
  const perPage = Number(body.per_page ?? 100);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
    return error("OpenList page 必須是正整數。", 400);
  }
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 500) {
    return error("OpenList per_page 必須介於 1 到 500。", 400);
  }

  const provider = body.provider === "worker" ? "worker" : "vps";
  const result = await postOpenList(env, "list", {
    path: body.path,
    password: "",
    page,
    per_page: perPage,
    refresh: false
  }, 45000, provider);
  if (result.response) return result.response;
  return json(result.payload);
}
