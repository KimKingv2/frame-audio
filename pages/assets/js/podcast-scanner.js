import {
  listOpenListDirectory,
  joinOpenListPath,
  formatBytes,
  getOpenListFileInfo
} from "./openlist-client.js?v=20261112-four-source-login1";
import { inspectAudioMetadata } from "./metadata-inspector.js";

const AUDIO_FILE_PATTERN = /\.(?:flac|mp3|m4a|mp4|aac|wav|aiff?|ogg|opus|wma|ape|dsf|dff)$/i;
const MAX_FILE_ATTEMPTS = 20;
const MAX_INDEXED_PER_BATCH = 500;
const MAX_ENTRIES_PER_BATCH = 500;
const MAX_FOLDERS_PER_BATCH = 500;
const MAX_BATCH_DURATION_MS = 7500000;

function normalizePath(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.includes("\0")) throw new Error("Podcast 根目錄路徑無效。");
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

function childShowFolder(rootPath, episodePath) {
  const root = normalizePath(rootPath);
  const prefix = root === "/" ? "/" : root + "/";
  if (!episodePath.startsWith(prefix)) return null;
  const relative = episodePath.slice(prefix.length);
  const first = relative.split("/").filter(Boolean)[0];
  return first ? joinOpenListPath(root, first) : null;
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" / ");
  if (typeof value === "object") return String(value.text || value.value || value.label || "").trim();
  return "";
}

function positiveInteger(value) {
  const raw = value && typeof value === "object" ? value.no : value;
  const match = String(raw ?? "").match(/\d+/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function newPodcastState(rootPath, previousState = null) {
  return {
    version: 1,
    kind: "podcasts",
    rootPath,
    pendingFolders: [rootPath],
    currentFolder: null,
    page: 1,
    itemIndex: 0,
    seenFolders: [rootPath],
    showFolders: [],
    indexedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    visitedFolderCount: 0,
    scannedEntryCount: 0,
    errors: Array.isArray(previousState?.errors) ? previousState.errors.slice(-20) : [],
    completed: false,
    updatedAt: new Date().toISOString()
  };
}

function progressText(state, batch, finished = false, pauseRequested = false) {
  const lines = [
    "Podcast 根目錄：" + state.rootPath,
    "節目資料夾：" + (state.showFolders || []).length + " 個",
    "已新增／更新單集：" + state.indexedCount + " 集",
    "未變更而跳過：" + state.skippedCount + " 集",
    "累計曾失敗：" + state.failedCount + " 集",
    "已完成資料夾：" + state.visitedFolderCount + " 個",
    "待掃描資料夾：" + state.pendingFolders.length + (state.currentFolder ? "；目前：" + state.currentFolder : ""),
    "本批新增／更新：" + batch.indexed + " 集；跳過：" + batch.skipped + " 集；失敗：" + batch.failed + " 集"
  ];
  if (batch.currentPath) lines.push("正在處理：" + batch.currentPath);
  if (batch.stopReason) lines.push("本批停止原因：" + batch.stopReason);
  if (state.currentFolder) {
    lines.push("續作游標：第 " + state.page + " 頁，第 " + (state.itemIndex + 1) + " 個項目。");
  }
  if (state.completed) lines.push("Podcast 目錄已完成遍歷。再次掃描會跳過未變更單集，並檢查新增或變更檔案。");
  else if (pauseRequested) lines.push("已要求暫停，進度已保存，可以之後續作。");
  else if (finished) lines.push("本批已結束，進度已保存至 D1，可以之後續作。");
  else lines.push("掃描進行中，請保持此頁面開啟；進度會持續保存至 D1。");
  const lastError = state.errors?.[state.errors.length - 1];
  if (lastError) lines.push("最近錯誤：" + lastError.path + "｜" + lastError.message);
  return lines.join("\n");
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.ok) {
    throw new Error(data.error || ("Podcast API HTTP " + response.status));
  }
  return data;
}

async function scanStateRequest(key, method = "GET", state = null) {
  const url = method === "GET"
    ? "/api/catalog/state?key=" + encodeURIComponent(key)
    : "/api/catalog/state";
  return apiRequest(url, {
    method,
    ...(method === "POST" ? {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, state })
    } : {})
  });
}

async function saveScanState(key, state, onLog) {
  state.updatedAt = new Date().toISOString();
  const startedAt = performance.now();
  onLog("Podcast D1 掃描進度保存開始");
  await scanStateRequest(key, "POST", state);
  onLog("Podcast D1 掃描進度保存完成：" +
    Math.round(performance.now() - startedAt) + " ms", "success");
}

async function loadRetryPaths() {
  const data = await apiRequest("/api/catalog/podcasts/retries");
  return new Set((data.items || []).map(item => String(item?.path || "")).filter(path => path.startsWith("/")));
}

async function saveRetryPath(path, message) {
  await apiRequest("/api/catalog/podcasts/retries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, message })
  });
}

async function resolveRetryPath(path) {
  await apiRequest("/api/catalog/podcasts/retries", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path })
  });
}

async function savePodcastShow(show) {
  return apiRequest("/api/catalog/podcasts?kind=shows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ show })
  });
}

export async function indexPodcastEpisode({
  path, rootPath, baseUrl, listedFile, onLog
}) {
  const showFolderPath = childShowFolder(rootPath, path);
  if (!showFolderPath) throw new Error("單集不在任何第一層節目資料夾內，已略過。");
  const showName = showFolderPath.split("/").filter(Boolean).pop() || "未命名節目";
  const info = await getOpenListFileInfo({ baseUrl, path });
  if (info.is_dir) throw new Error("Podcast 單集路徑實際上是資料夾。");
  const fileSize = Number(info.size || 0);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error("OpenList 沒有提供有效的單集檔案大小。");

  onLog("Podcast 單集 Metadata Range 解析開始：" + path);
  const result = await inspectAudioMetadata({
    rawUrl: info.raw_url,
    baseUrl,
    path,
    fileSize,
    onEvent: event => onLog(event.message, event.level)
  });
  const common = result.metadata?.common || {};
  const format = result.metadata?.format || {};
  const title = textValue(common.title) || path.split("/").pop() || "未命名單集";
  const durationSeconds = Number(format.duration || 0);
  const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.round(durationSeconds * 1000) : null;

  let artwork = null;
  let coverHash = null;
  const picture = Array.isArray(common.picture) ? common.picture[0] : null;
  if (picture?.data?.byteLength) {
    const pictureBytes = picture.data instanceof Uint8Array
      ? picture.data
      : picture.data instanceof ArrayBuffer ? new Uint8Array(picture.data) : null;
    const rawType = String(picture.format || "").toLowerCase();
    const mimeType = ({
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif"
    })[rawType] || (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(rawType) ? rawType : "");
    if (pictureBytes && mimeType && pictureBytes.byteLength <= 10 * 1024 * 1024) {
      const hash = await sha256Hex(pictureBytes);
      onLog("Podcast R2 封面上傳開始：" + formatBytes(pictureBytes.byteLength));
      const coverResponse = await fetch("/api/artwork/" + hash, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": mimeType
        },
        body: new Blob([pictureBytes], { type: mimeType })
      });
      let coverData = {};
      try { coverData = await coverResponse.json(); } catch {}
      if (!coverResponse.ok || !coverData.ok) {
        throw new Error(coverData.error || ("Podcast 封面 R2 寫入失敗（HTTP " + coverResponse.status + "）。"));
      }
      artwork = { sha256: hash, mimeType, sizeBytes: pictureBytes.byteLength };
      coverHash = hash;
      onLog("Podcast R2 封面已去重保存：" + hash, "success");
    } else if (pictureBytes?.byteLength > 10 * 1024 * 1024) {
      onLog("Podcast 封面超過 10 MiB，已略過封面", "warning");
    }
  }

  const showId = await sha256Hex(showFolderPath);
  const episodeId = await sha256Hex(path);
  const author = textValue(common.artist || common.albumartist || common.albumArtist) || null;
  const description = textValue(common.description || common.comment) || null;
  const publishedAt = textValue(common.date || common.year) || null;
  const episode = {
    id: episodeId,
    showId,
    title,
    description,
    episodeNumber: positiveInteger(common.episode ?? common.track),
    seasonNumber: positiveInteger(common.season ?? common.disk),
    publishedAt,
    durationMs,
    audio: {
      container: format.container || null,
      codec: format.codec || null,
      bitrate: Number.isFinite(Number(format.bitrate)) ? Number(format.bitrate) : null,
      sampleRate: Number.isFinite(Number(format.sampleRate)) ? Number(format.sampleRate) : null,
      bitsPerSample: Number.isFinite(Number(format.bitsPerSample)) ? Number(format.bitsPerSample) : null,
      channels: Number.isFinite(Number(format.numberOfChannels)) ? Number(format.numberOfChannels) : null,
      lossless: typeof format.lossless === "boolean" ? format.lossless : null
    },
    artwork,
    file: {
      path,
      sizeBytes: fileSize,
      modifiedAt: listedFile?.modified || info.modified || info.modified_at || null
    },
    metadata: {
      tagTypes: result.metadata?.format?.tagTypes || [],
      common: {
        title: common.title || null,
        artist: common.artist || null,
        album: common.album || null,
        date: common.date || common.year || null,
        episode: common.episode || null,
        season: common.season || null
      }
    }
  };
  const show = {
    id: showId,
    title: showName,
    folderPath: showFolderPath,
    author,
    description,
    coverHash
  };

  await apiRequest("/api/catalog/podcasts?kind=episodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ show, episode })
  });
  onLog("Podcast 單集寫入 D1 完成：" + title, "success");
  return { ok: true, title, showName, durationMs, stats: result.stats || {} };
}

export async function runPodcastBatch({
  baseUrl,
  rootPath,
  onLog = () => {},
  onProgress = () => {},
  shouldPause = () => false
}) {
  const root = normalizePath(rootPath);
  if (!baseUrl) throw new Error("伺服器端連線尚未就緒。");
  const log = (message, level = "info") => {
    try { onLog(String(message || ""), level); } catch {}
  };
  const key = "podcast_scan_" + await sha256Hex(root);
  const fakeButton = { disabled: false };
  const batch = { indexed: 0, skipped: 0, failed: 0, entries: 0, foldersVisited: 0 };
  let state = null;

  try {
    log("========== Podcast 批次索引開始 ==========");
    log("Podcast 根目錄：" + root);
    const stored = await scanStateRequest(key);
    state = stored.state;
    if (!state) {
      state = newPodcastState(root);
      await saveScanState(key, state, log);
    } else if (state.completed) {
      const restart = window.confirm(
        "這個 Podcast 根目錄上一輪已完成。\n再次掃描會跳過未變更單集，只索引新增或變更項目，不會刪除既有資料。要開始新一輪嗎？"
      );
      if (!restart) return { cancelled: true };
      state = newPodcastState(root, state);
      await saveScanState(key, state, log);
    }

    const retryPaths = await loadRetryPaths();
    log("Podcast 全域失敗重試佇列讀取完成：" + retryPaths.size + " 個待重試路徑",
      retryPaths.size ? "warning" : "success");
    const startedAt = Date.now();
    const recoveredPaths = new Set();
    const exhaustedRetryPaths = new Set();
    const rootPrefix = root === "/" ? "/" : root + "/";
    const retryInRoot = [...retryPaths]
      .filter(path => path.startsWith(rootPrefix) && AUDIO_FILE_PATTERN.test(path) && childShowFolder(root, path))
      .sort((a, b) => a.localeCompare(b, "en"));

    if (retryInRoot.length) {
      log("Podcast 根目錄內有 " + retryInRoot.length +
        " 集待重試內容；先依完整路徑處理，不受原目錄分頁游標影響。", "warning");
    }

    for (const retryPath of retryInRoot) {
      if (shouldPause() || batch.indexed >= MAX_INDEXED_PER_BATCH ||
          batch.entries >= MAX_ENTRIES_PER_BATCH || Date.now() - startedAt >= MAX_BATCH_DURATION_MS) break;
      if (!retryPaths.has(retryPath)) continue;
      let indexed = null;
      log("Podcast 失敗佇列優先重試：" + retryPath, "warning");
      for (let attempt = 1; attempt <= MAX_FILE_ATTEMPTS; attempt += 1) {
        log("Podcast 單集重試 " + attempt + "/" + MAX_FILE_ATTEMPTS + "：" + retryPath);
        try {
          indexed = await indexPodcastEpisode({
            path: retryPath, rootPath: root, baseUrl,
            onLog: log
          });
        } catch (error) {
          indexed = { ok: false, error: error.message || String(error) };
        }
        if (indexed?.ok) break;
        const message = String(indexed?.error || "未知錯誤").slice(0, 700);
        if (/管理金鑰不正確|尚未設定 FRAME_AUDIO_ADMIN_TOKEN|HTTP 401|HTTP 403|驗證失敗|沒有.*權限/i.test(message)) {
          throw new Error(message + " 請檢查 Cloudflare Pages 的 OPENLIST_API_TOKEN 與 FRAME_AUDIO_ADMIN_TOKEN Secrets。");
        }
        if (attempt < MAX_FILE_ATTEMPTS) {
          const delay = 1500 * attempt;
          log("Podcast 單集重試等待 " + delay + " ms：" + message, "warning");
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      batch.entries += 1;
      if (indexed?.ok) {
        await resolveRetryPath(retryPath);
        retryPaths.delete(retryPath);
        recoveredPaths.add(retryPath);
        state.errors = (state.errors || []).filter(item => item?.path !== retryPath);
        state.indexedCount += 1;
        batch.indexed += 1;
        log("Podcast 單集重試成功，已從獨立失敗佇列解除：" + retryPath, "success");
      } else {
        const message = String(indexed?.error || "未知錯誤").slice(0, 700);
        exhaustedRetryPaths.add(retryPath);
        state.failedCount += 1;
        batch.failed += 1;
        await saveRetryPath(retryPath, message);
        state.errors = (state.errors || []).filter(item => item?.path !== retryPath);
        state.errors.push({ path: retryPath, message, at: new Date().toISOString() });
        if (state.errors.length > 20) state.errors.shift();
        log("Podcast 單集仍失敗，已保留待重試狀態：" + retryPath, "warning");
      }
      await saveScanState(key, state, log);
      onProgress(progressText(state, batch, false, shouldPause()), "ok");
    }

    while (!state.completed &&
      batch.indexed < MAX_INDEXED_PER_BATCH &&
      batch.entries < MAX_ENTRIES_PER_BATCH &&
      batch.foldersVisited < MAX_FOLDERS_PER_BATCH &&
      Date.now() - startedAt < MAX_BATCH_DURATION_MS &&
      !shouldPause()) {
      if (!state.currentFolder) {
        if (!state.pendingFolders.length) {
          state.completed = true;
          break;
        }
        state.currentFolder = state.pendingFolders.shift();
        state.page = 1;
        state.itemIndex = 0;
        log("Podcast 進入資料夾：" + state.currentFolder);
        await saveScanState(key, state, log);
      }

      const listing = await listOpenListDirectory({
        baseUrl, 
        path: state.currentFolder,
        page: state.page,
        perPage: 100,
        onEvent: event => log(event.message, event.level)
      });
      log("Podcast 目錄列表完成：" + state.currentFolder + "；第 " +
        state.page + " 頁；本頁 " + listing.items.length + "/" + listing.total + " 項", "success");

      const audioItems = listing.items.filter(item => !item.isDir && AUDIO_FILE_PATTERN.test(item.name));
      const existingByPath = new Map();
      if (audioItems.length) {
        const lookup = await apiRequest("/api/catalog/podcasts/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paths: audioItems.map(item => joinOpenListPath(state.currentFolder, item.name))
          })
        });
        for (const item of lookup.items || []) existingByPath.set(item.path, item);
      }

      if (state.itemIndex > listing.items.length) state.itemIndex = 0;
      for (let index = state.itemIndex; index < listing.items.length; index += 1) {
        if (shouldPause() || batch.indexed >= MAX_INDEXED_PER_BATCH ||
            batch.entries >= MAX_ENTRIES_PER_BATCH || Date.now() - startedAt >= MAX_BATCH_DURATION_MS) break;
        const item = listing.items[index];
        const fullPath = joinOpenListPath(state.currentFolder, item.name);
        let checkpointNow = false;

        if (item.isDir) {
          if (state.currentFolder === root) {
            const showPath = fullPath;
            const showId = await sha256Hex(showPath);
            const showName = item.name || "未命名節目";
            await savePodcastShow({
              id: showId, title: showName, folderPath: showPath,
              author: null, description: null, coverHash: null
            });
            if (!state.showFolders.includes(showPath)) state.showFolders.push(showPath);
            log("Podcast 節目資料夾已建立／更新：" + showName, "success");
          }
          if (!state.seenFolders.includes(fullPath)) {
            state.seenFolders.push(fullPath);
            state.pendingFolders.push(fullPath);
            log("Podcast 發現子資料夾：" + fullPath);
          }
        } else if (AUDIO_FILE_PATTERN.test(item.name)) {
          const showPath = childShowFolder(root, fullPath);
          if (!showPath) {
            log("Podcast 根目錄中的散落音訊未歸入節目，已略過；請將單集放進節目資料夾：" + fullPath, "warning");
          } else if (recoveredPaths.has(fullPath)) {
            batch.skipped += 1;
            state.skippedCount += 1;
            log("本批已在 Podcast 失敗佇列優先階段修復，略過重複處理：" + fullPath, "success");
          } else if (exhaustedRetryPaths.has(fullPath)) {
            batch.skipped += 1;
            state.skippedCount += 1;
            log("本批已重試 20 次仍失敗，不重複消耗相同單集額度：" + fullPath, "warning");
          } else {
            const existing = existingByPath.get(fullPath);
            const modified = item.modified || null;
            const unchanged = !retryPaths.has(fullPath) && existing &&
              Number(existing.sizeBytes) === Number(item.size) &&
              !!modified && existing.modifiedAt === modified;
            if (unchanged) {
              batch.skipped += 1;
              state.skippedCount += 1;
              log("跳過未變更 Podcast 單集：" + fullPath, "success");
            } else {
              batch.currentPath = fullPath;
              onProgress(progressText(state, batch), "ok");
              let indexed = null;
              const fileStartedAt = performance.now();
              for (let attempt = 1; attempt <= MAX_FILE_ATTEMPTS; attempt += 1) {
                log("Podcast 單集索引嘗試 " + attempt + "/" + MAX_FILE_ATTEMPTS + "：" + fullPath);
                try {
                  indexed = await indexPodcastEpisode({
                    path: fullPath, rootPath: root, baseUrl,
                    listedFile: item, onLog: log
                  });
                } catch (error) {
                  indexed = { ok: false, error: error.message || String(error) };
                }
                if (indexed?.ok) break;
                const message = String(indexed?.error || "未知錯誤").slice(0, 700);
                if (/管理金鑰不正確|尚未設定 FRAME_AUDIO_ADMIN_TOKEN|HTTP 401|HTTP 403|驗證失敗|沒有.*權限/i.test(message)) {
                  throw new Error(message + " 請檢查 Cloudflare Pages 的 OPENLIST_API_TOKEN 與 FRAME_AUDIO_ADMIN_TOKEN Secrets。");
                }
                if (attempt < MAX_FILE_ATTEMPTS) {
                  const delay = 1500 * attempt;
                  log("Podcast 單集索引失敗，" + delay + " ms 後重試：" + message, "warning");
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              }
              batch.currentPath = "";
              if (indexed?.ok) {
                if (retryPaths.has(fullPath)) {
                  await resolveRetryPath(fullPath);
                  retryPaths.delete(fullPath);
                  state.errors = (state.errors || []).filter(error => error?.path !== fullPath);
                }
                state.indexedCount += 1;
                batch.indexed += 1;
                log("Podcast 單集索引成功：" + indexed.title + "；節目：" +
                  indexed.showName + "；耗時 " +
                  ((performance.now() - fileStartedAt) / 1000).toFixed(1) + " 秒", "success");
              } else {
                const message = String(indexed?.error || "未知錯誤").slice(0, 700);
                state.failedCount += 1;
                batch.failed += 1;
                try {
                  await saveRetryPath(fullPath, message);
                  retryPaths.add(fullPath);
                  log("Podcast 單集已加入 Podcast 專屬失敗佇列：" + fullPath, "warning");
                } catch (queueError) {
                  log("Podcast 失敗佇列寫入失敗：" + (queueError.message || queueError), "error");
                }
                state.errors.push({ path: fullPath, message, at: new Date().toISOString() });
                if (state.errors.length > 20) state.errors.shift();
              }
              checkpointNow = true;
            }
          }
        }

        state.itemIndex = index + 1;
        state.scannedEntryCount += 1;
        batch.entries += 1;
        if (checkpointNow || batch.entries % 10 === 0) {
          await saveScanState(key, state, log);
        }
        onProgress(progressText(state, batch), "ok");
      }

      if (state.itemIndex >= listing.items.length) {
        if (state.page * listing.perPage < listing.total) {
          state.page += 1;
          state.itemIndex = 0;
        } else {
          state.currentFolder = null;
          state.page = 1;
          state.itemIndex = 0;
          state.visitedFolderCount += 1;
          batch.foldersVisited += 1;
        }
        await saveScanState(key, state, log);
      }
    }

    if (!state.currentFolder && state.pendingFolders.length === 0) state.completed = true;
    const elapsedMs = Date.now() - startedAt;
    if (state.completed) batch.stopReason = "Podcast 根目錄已完整遍歷";
    else if (shouldPause()) batch.stopReason = "使用者要求暫停";
    else if (batch.indexed >= MAX_INDEXED_PER_BATCH) batch.stopReason = "達到每批新增／更新 500 集上限";
    else if (batch.entries >= MAX_ENTRIES_PER_BATCH) batch.stopReason = "達到每批檢查 500 個項目上限";
    else if (batch.foldersVisited >= MAX_FOLDERS_PER_BATCH) batch.stopReason = "達到每批完成 500 個資料夾上限";
    else if (elapsedMs >= MAX_BATCH_DURATION_MS) batch.stopReason = "達到單批安全時限";
    else batch.stopReason = "本批正常結束，仍有工作可續作";
    await saveScanState(key, state, log);
    log("========== Podcast 本批結束：" + batch.stopReason + " ==========",
      state.completed ? "success" : "warning");
    onProgress(progressText(state, batch, true, shouldPause()), "ok");
    return { ok: true, completed: state.completed, state, batch };
  } catch (error) {
    log("Podcast 批次索引發生錯誤：" + (error.message || error), "error");
    if (state) {
      state.lastError = String(error.message || error).slice(0, 700);
      try { await saveScanState(key, state, log); } catch {}
      onProgress(progressText(state, batch, false, shouldPause()) +
        "\n發生錯誤，已保存目前進度；修復後可續作。", "error");
    } else {
      onProgress(error.message || "Podcast 掃描失敗。", "error");
    }
    return { ok: false, error: error.message || String(error), state };
  }
}
