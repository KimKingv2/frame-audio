import { error, json, requireAdmin, readJson, isObject } from "../../../_lib/api.js";

const FOLDER_SQL = [
  "INSERT INTO folders (id,path,name,parent_id,child_folder_ids_json,track_ids_json,direct_track_count,recursive_track_count,data_json,indexed_at)",
  "VALUES (?,?,?,?,?,?,?,?,?,?)",
  "ON CONFLICT(path) DO UPDATE SET id=excluded.id,name=excluded.name,parent_id=excluded.parent_id,",
  "child_folder_ids_json=excluded.child_folder_ids_json,track_ids_json=excluded.track_ids_json,",
  "direct_track_count=excluded.direct_track_count,recursive_track_count=excluded.recursive_track_count,",
  "data_json=excluded.data_json,indexed_at=excluded.indexed_at"
].join(" ");

function normalizePath(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.indexOf(String.fromCharCode(0)) !== -1 || path.length > 4096) return null;
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
}

function parentPathOf(path) {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function nameOf(path) {
  if (path === "/") return "根目錄";
  return path.slice(path.lastIndexOf("/") + 1) || "未命名資料夾";
}

async function folderId(path) {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return "folder_" + hex;
}

export async function onRequestPost({ request, env }) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.DB || typeof env.DB.prepare !== "function") {
    return error("D1 binding DB 尚未設定。", 503);
  }

  let body;
  try { body = await readJson(request, 900000); }
  catch (e) { return error(e.message, 413); }

  if (!isObject(body)) return error("資料夾索引請求格式不正確。");
  const rootPath = normalizePath(body.rootPath);
  if (!rootPath) return error("資料夾索引根目錄路徑無效。");
  if (!Array.isArray(body.folderPaths) || body.folderPaths.length > 10000) {
    return error("資料夾路徑清單無效或超過 10,000 個上限。");
  }

  const prefix = rootPath === "/" ? "/" : rootPath + "/";
  const paths = new Set([rootPath]);
  for (const rawPath of body.folderPaths) {
    const path = normalizePath(rawPath);
    if (!path || (path !== rootPath && !path.startsWith(prefix))) {
      return error("資料夾路徑清單包含根目錄以外或格式錯誤的路徑。");
    }
    paths.add(path);
  }

  try {
    const folders = new Map();
    for (const path of paths) {
      folders.set(path, {
        id: await folderId(path),
        path,
        name: nameOf(path),
        parentPath: path === rootPath ? null : parentPathOf(path),
        childPaths: [],
        childFolderIds: [],
        trackIds: [],
        directTrackCount: 0,
        recursiveTrackCount: 0
      });
    }

    for (const folder of folders.values()) {
      if (!folder.parentPath) continue;
      const parent = folders.get(folder.parentPath);
      if (parent) {
        parent.childPaths.push(folder.path);
        parent.childFolderIds.push(folder.id);
      }
    }

    const trackPrefix = prefix;
    let trackOffset = 0;
    let indexedTracks = 0;
    const pageSize = 500;
    while (true) {
      const result = await env.DB.prepare(
        "SELECT id,path FROM tracks WHERE substr(path,1,?)=? ORDER BY path LIMIT ? OFFSET ?"
      ).bind(trackPrefix.length, trackPrefix, pageSize, trackOffset).all();
      const rows = result.results || [];
      for (const row of rows) {
        const path = String(row.path || "");
        if (!path.startsWith(trackPrefix) || typeof row.id !== "string") continue;
        const parentPath = parentPathOf(path);
        const folder = folders.get(parentPath);
        if (!folder) continue;
        folder.trackIds.push(row.id);
        folder.directTrackCount += 1;
        indexedTracks += 1;
      }
      trackOffset += rows.length;
      if (rows.length < pageSize) break;
    }

    const deepestFirst = [...folders.values()].sort((a, b) =>
      b.path.split("/").length - a.path.split("/").length
    );
    for (const folder of deepestFirst) {
      folder.recursiveTrackCount = folder.directTrackCount +
        folder.childPaths.reduce((total, childPath) =>
          total + (folders.get(childPath)?.recursiveTrackCount || 0), 0);
      folder.childPaths.sort();
      folder.childFolderIds = folder.childPaths
        .map(childPath => folders.get(childPath)?.id)
        .filter(Boolean);
      folder.trackIds.sort();
    }

    const now = new Date().toISOString();
    const records = [...folders.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = records.slice(offset, offset + 100).map(folder => {
        const parent = folder.parentPath ? folders.get(folder.parentPath) : null;
        const record = {
          id: folder.id,
          path: folder.path,
          name: folder.name,
          parentId: parent?.id || null,
          childFolderIds: folder.childFolderIds,
          trackIds: folder.trackIds,
          directTrackCount: folder.directTrackCount,
          recursiveTrackCount: folder.recursiveTrackCount,
          rootPath,
          indexedAt: now
        };
        return env.DB.prepare(FOLDER_SQL).bind(
          record.id,
          record.path,
          record.name,
          record.parentId,
          JSON.stringify(record.childFolderIds),
          JSON.stringify(record.trackIds),
          record.directTrackCount,
          record.recursiveTrackCount,
          JSON.stringify(record),
          now
        );
      });
      if (batch.length) await env.DB.batch(batch);
    }

    const root = folders.get(rootPath);
    return json({
      ok: true,
      rootPath,
      savedFolders: records.length,
      indexedTracks,
      directTrackCount: root?.directTrackCount || 0,
      recursiveTrackCount: root?.recursiveTrackCount || 0,
      indexedAt: now
    });
  } catch {
    return error("資料夾階層建立或 D1 寫入失敗。請保留目前掃描進度後重試。", 503);
  }
}
