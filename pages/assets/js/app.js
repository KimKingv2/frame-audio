import { listOpenListDirectory, joinOpenListPath, formatBytes, probeOpenListAudioRange, getOpenListFileInfo } from "./openlist-client.js";
import { inspectAudioMetadata } from "./metadata-inspector.js";

const AUDIO_FILE_PATTERN = /\.(?:flac|mp3|m4a|mp4|aac|wav|aiff?|ogg|opus|wma|ape|dsf|dff)$/i;

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#connection-dialog");
  const urlInput = $("#openlist-url");
  const tokenInput = $("#openlist-token");
  const storageTokenInput = $("#cloudflare-admin-token");
  const storageResultBox = $("#storage-result");
  const pathInput = $("#openlist-path");
  const resultBox = $("#connection-result");
  const browser = $("#directory-browser");
  const listBox = $("#directory-list");
  const currentPathLabel = $("#current-path");
  const metadataPreview = $("#metadata-result");
  const browseButton = $("#browse-root");
  let activeBaseUrl = "";
  let activeToken = "";
  let activeStorageToken = "";
  let cloudflareStorageReady = false;
  let activePath = "/";
  let scanRunning = false;
  let scanPauseRequested = false;
  let connected = false;
  let activeCoverUrl = "";

  const views = {
    music: ["Music", "YOUR MUSIC LIBRARY", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "MUSIC LIBRARY", "你的音樂收藏", "♫", "音樂庫尚未連接", "先連接 OpenList 並確認音樂根目錄；之後再建立音樂索引。"],
    podcasts: ["Podcasts", "YOUR PODCAST LIBRARY", "好內容，<span>慢慢聽。</span>", "集中管理喜愛的節目，從上次停止的位置繼續收聽。", "PODCAST LIBRARY", "你的節目收藏", "▤", "Podcast 尚未連接", "接入節目資料後，節目封面、單集、收聽進度與播放速度控制就會出現在這裡。"],
    tracks: ["Music", "TRACKS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "TRACKS", "所有歌曲", "♫", "歌曲索引尚未發布", "歌曲索引發布後，這裡會顯示完整曲庫。"],
    albums: ["Music", "ALBUMS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "ALBUMS", "專輯", "▣", "專輯索引尚未發布", "專輯索引發布後，這裡會依照專輯資訊整理收藏。"],
    artists: ["Music", "ARTISTS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "ARTISTS", "歌手", "♙", "歌手索引尚未發布", "歌手索引發布後，這裡會整理歌曲與專輯關聯。"],
    folders: ["Music", "FOLDER PLAYLISTS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "FOLDER PLAYLISTS", "資料夾歌單", "▰", "資料夾索引尚未發布", "索引器會保留 OpenList 原始目錄樹。每個資料夾都能成為播放清單，並可選擇包含子資料夾。"],
    shows: ["Podcasts", "SHOWS", "好內容，<span>慢慢聽。</span>", "集中管理喜愛的節目，從上次停止的位置繼續收聽。", "SHOWS", "所有節目", "▥", "節目索引尚未發布", "節目索引發布後，這裡會顯示你的 Podcast 節目與單集。"],
    continue: ["Podcasts", "CONTINUE LISTENING", "好內容，<span>慢慢聽。</span>", "集中管理喜愛的節目，從上次停止的位置繼續收聽。", "CONTINUE LISTENING", "繼續收聽", "◷", "目前沒有收聽紀錄", "Podcast 播放進度會獨立保存，之後可以從上次停止的位置繼續。"]
  };

  function showView(name) {
    const view = views[name] || views.music;
    const ids = ["section", "eyebrow", "title", "description", "kicker", "heading", "icon", "emptytitle", "emptytext"];
    ids.forEach((id, index) => {
      const node = document.getElementById(id);
      if (id === "title") node.innerHTML = view[index];
      else node.textContent = view[index];
    });
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  }

  function setResult(message, type = "") {
    resultBox.textContent = message;
    resultBox.className = "statusbox" + (type ? " " + type : "");
  }

  function setStorageResult(message, type = "") {
    storageResultBox.textContent = message;
    storageResultBox.className = "statusbox" + (type ? " " + type : "");
  }

  function setScanProgress(message, type = "") {
    const box = $("#scan-progress");
    if (!box) return;
    box.textContent = message;
    box.className = "statusbox" + (type ? " " + type : "");
  }

  const scanLogEntries = [];
  function appendScanLog(message, level = "info") {
    const now = new Date();
    const timestamp = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0")
    ].join(":") + "." + String(now.getMilliseconds()).padStart(3, "0");
    const line = timestamp + "  " + String(message || "");
    scanLogEntries.push(line);
    if (scanLogEntries.length > 300) scanLogEntries.shift();

    const output = $("#scan-log-output");
    if (output) {
      const placeholder = output.querySelector(".scan-log-placeholder");
      if (placeholder) placeholder.remove();
      const row = document.createElement("div");
      row.className = "scan-log-line";
      row.dataset.level = ["success", "warning", "error"].includes(level) ? level : "info";
      row.textContent = line;
      output.append(row);
      while (output.children.length > 300) output.firstElementChild.remove();
      output.scrollTop = output.scrollHeight;
    }
    const count = $("#scan-log-count");
    if (count) count.textContent = scanLogEntries.length + " 筆";
  }

  function appendModuleLog(event, prefix = "") {
    if (!event) return;
    appendScanLog((prefix ? prefix + "｜" : "") + (event.message || String(event)), event.level || "info");
  }

  async function testCloudflareStorage() {
    const button = $("#test-storage");
    activeStorageToken = storageTokenInput.value.trim();
    if (!activeStorageToken) {
      setStorageResult("請輸入 Cloudflare 儲存管理金鑰。這不是 OpenList API Token。", "error");
      return;
    }
    button.disabled = true;
    cloudflareStorageReady = false;
    setStorageResult("正在檢查 Cloudflare D1 與 R2……");
    try {
      const response = await fetch("/api/catalog/status", {
        method: "GET", credentials: "same-origin",
        headers: { Authorization: "Bearer " + activeStorageToken }
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok || !data.ok) throw new Error(data.error || ("Cloudflare API HTTP " + response.status));
      cloudflareStorageReady = true;
      setStorageResult("PASS：Cloudflare 儲存已連線。\nD1：已連接；歌曲 " + data.tracks + " 首；資料夾 " + data.folders + " 個。\nR2：已連接。", "ok");
    } catch (error) {
      setStorageResult(error.message || "Cloudflare 儲存連線失敗。", "error");
    } finally { button.disabled = false; }
  }

  function clearMetadataPreview() {
    if (activeCoverUrl) {
      URL.revokeObjectURL(activeCoverUrl);
      activeCoverUrl = "";
    }
    metadataPreview.replaceChildren();
    metadataPreview.hidden = true;
  }

  function metadataField(label, value) {
    if (value === undefined || value === null || value === "") return null;
    const item = document.createElement("div");
    item.className = "metadata-field";
    const name = document.createElement("span");
    name.className = "metadata-label";
    name.textContent = label;
    const data = document.createElement("strong");
    data.className = "metadata-value";
    data.textContent = String(value);
    item.append(name, data);
    return item;
  }

  function metadataTagValue(value) {
    if (Array.isArray(value)) return value.map(metadataTagValue).filter(Boolean).join(" / ");
    if (value && typeof value === "object") {
      if ("no" in value) return [value.no, value.of].filter(v => v !== undefined && v !== null).join(" / ");
      return value.text || value.value || "";
    }
    return value === undefined || value === null ? "" : String(value);
  }

  function renderMetadataResult(path, fileSize, result) {
    clearMetadataPreview();
    const { common = {}, format = {}, tagTypes = [] } = result.metadata || {};
    const stats = result.stats || {};
    metadataPreview.hidden = false;

    const heading = document.createElement("div");
    heading.className = "metadata-heading";
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = common.title || path.split("/").pop() || "音訊 metadata";
    const headingPath = document.createElement("span");
    headingPath.textContent = path;
    heading.append(headingTitle, headingPath);

    const layout = document.createElement("div");
    layout.className = "metadata-layout";
    const picture = Array.isArray(common.picture) ? common.picture[0] : null;
    if (picture?.data?.byteLength) {
      const cover = document.createElement("img");
      cover.className = "metadata-cover";
      cover.alt = "內嵌封面";
      activeCoverUrl = URL.createObjectURL(new Blob([picture.data], { type: picture.format || "image/jpeg" }));
      cover.src = activeCoverUrl;
      layout.append(cover);
    }

    const grid = document.createElement("div");
    grid.className = "metadata-grid";
    const fields = [
      ["歌手", common.artist],
      ["專輯", common.album],
      ["專輯藝人", common.albumartist],
      ["年份", common.year || common.date],
      ["曲目", common.track],
      ["唱片", common.disk],
      ["類型", common.genre],
      ["作曲", common.composer],
      ["格式", format.container],
      ["編碼", format.codec],
      ["取樣率", format.sampleRate ? format.sampleRate + " Hz" : ""],
      ["位元深度", format.bitsPerSample ? format.bitsPerSample + " bit" : ""],
      ["聲道", format.numberOfChannels],
      ["無損", format.lossless === true ? "是" : format.lossless === false ? "否" : ""],
      ["內嵌封面", Array.isArray(common.picture) ? common.picture.length + " 張" : "無"],
      ["歌詞", common.lyrics ? "有" : "未讀到"],
      ["標籤類型", tagTypes]
    ];
    for (const [label, value] of fields) {
      const node = metadataField(label, metadataTagValue(value));
      if (node) grid.append(node);
    }
    layout.append(grid);

    const lyricsValues = Array.isArray(common.lyrics) ? common.lyrics : common.lyrics ? [common.lyrics] : [];
    const lyricsText = lyricsValues.map(item => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n\n");
    const lyrics = document.createElement("div");
    lyrics.className = "metadata-lyrics";
    const lyricsTitle = document.createElement("strong");
    lyricsTitle.textContent = "歌詞預覽";
    const lyricsBody = document.createElement("pre");
    lyricsBody.textContent = lyricsText ? lyricsText.slice(0, 1200) : "檔案標籤中沒有讀到內嵌歌詞。";
    lyrics.append(lyricsTitle, lyricsBody);

    const footer = document.createElement("div");
    footer.className = "metadata-footer";
    footer.textContent = [
      "檔案大小 " + formatBytes(fileSize),
      "成功 Range " + (stats.rangeRequests || 0) + " 次",
      "請求嘗試 " + (stats.requestAttempts || stats.rangeRequests || 0) + " 次",
      "自動重試 " + (stats.retryCount || 0) + " 次",
      "重新導向 " + (stats.redirectedRequests || 0) + " 次",
      "來源 " + (stats.initialHost || "未知") + " → " + (stats.finalHost || "未知"),
      "實際讀取 " + formatBytes(stats.bytesFetched || 0),
      "Range 累計耗時 " + (stats.totalRequestMs ?? "未提供") + " ms",
      "Range 平均耗時 " + (stats.averageRequestMs ?? "未提供") + " ms",
      "Range 最慢一次 " + (stats.slowestRequestMs ?? "未提供") + " ms",
      "解析器載入 " + (stats.parserLoadMs ?? "未提供") + " ms",
      "標籤解析 " + (stats.parseElapsedMs ?? "未提供") + " ms",
      "檔案資訊 API " + (stats.openListInfoMs ?? "未提供") + " ms",
      "R2 封面上傳 " + (stats.artworkUploadMs ?? "未提供") + " ms",
      "D1 曲目寫入 " + (stats.catalogWriteMs ?? "未提供") + " ms",
      "整首索引 " + (stats.totalIndexMs ?? "未提供") + " ms",
      "讀取上限 " + formatBytes(stats.maxTransferBytes || 0)
    ].join("　·　");

    metadataPreview.append(heading, layout, lyrics, footer);
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function metadataStringList(value) {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return values.map(item => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") return String(item.text || item.value || item.name || "").trim();
      return "";
    }).filter(Boolean);
  }

  function metadataNumber(value) {
    const raw = value && typeof value === "object" ? value.no : value;
    const number = Number(raw);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  async function indexSingleAudioFile(path, button, options = {}) {
    const silent = options.silent === true;
    const listedFile = options.listedFile || null;
    const onLog = typeof options.onLog === "function" ? options.onLog : appendScanLog;
    const log = (message, level = "info") => {
      try { onLog(message, level); } catch {}
    };
    if (!connected) {
      const message = "請先連接 OpenList 並讀取目錄。";
      if (!silent) setResult(message, "error");
      return { ok: false, error: message };
    }
    if (!cloudflareStorageReady || !activeStorageToken) {
      const message = "請先輸入 Cloudflare 管理金鑰並成功執行「測試 Cloudflare 儲存」。";
      if (!silent) setResult(message, "error");
      return { ok: false, error: message };
    }

    button.disabled = true;
    if (!silent) {
      clearMetadataPreview();
      setResult("正在讀取音訊標籤，完成後會將這一首存入 D1；封面（若有）會去重後存入 R2。\n" + path);
    }
    try {
      const indexStartedAt = performance.now();
      log("歌曲索引開始：" + path);
      const fileInfoStartedAt = performance.now();
      log("OpenList /api/fs/get 開始");
      const info = await getOpenListFileInfo({ baseUrl: activeBaseUrl, token: activeToken, path });
      const openListInfoMs = Math.round(performance.now() - fileInfoStartedAt);
      log("OpenList /api/fs/get 完成：" + openListInfoMs + " ms；檔案大小 " +
        formatBytes(Number(info.size || 0)), "success");
      if (info.is_dir) throw new Error("選取的項目是資料夾，請選擇音訊檔案。");
      const fileSize = Number(info.size || 0);
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error("OpenList 沒有提供有效的檔案大小。");

      log("音訊 metadata 解析階段開始");
      const result = await inspectAudioMetadata({
        rawUrl: info.raw_url,
        baseUrl: activeBaseUrl,
        path,
        fileSize,
        onEvent: (event) => log(event.message, event.level)
      });
      log("音訊 metadata 解析階段完成：" +
        (result.stats?.parseElapsedMs ?? "?") + " ms；Range " +
        (result.stats?.rangeRequests || 0) + " 次；讀取 " +
        formatBytes(result.stats?.bytesFetched || 0), "success");
      if (!silent) renderMetadataResult(path, fileSize, result);

      const metadata = result.metadata || {};
      const common = metadata.common || {};
      const format = metadata.format || {};
      const title = String(common.title || path.split("/").pop() || "未命名音訊");
      const id = await sha256Hex(new TextEncoder().encode(path));
      let artwork = null;
      let artworkNote = "沒有內嵌封面";
      let artworkUploadMs = 0;

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
        if (!pictureBytes) {
          artworkNote = "封面資料格式不支援，已略過封面";
        } else if (!mimeType) {
          artworkNote = "封面格式不支援，已略過封面";
        } else if (pictureBytes.byteLength > 10 * 1024 * 1024) {
          artworkNote = "封面超過 10 MiB 上限，已略過封面";
        } else {
          const sha256 = await sha256Hex(pictureBytes);
          log("R2 封面上傳開始：" + formatBytes(pictureBytes.byteLength));
          const artworkStartedAt = performance.now();
          const coverResponse = await fetch("/api/artwork/" + sha256, {
            method: "PUT",
            credentials: "same-origin",
            headers: {
              Authorization: "Bearer " + activeStorageToken,
              "Content-Type": mimeType
            },
            body: new Blob([pictureBytes], { type: mimeType })
          });
          let coverData = {};
          try { coverData = await coverResponse.json(); } catch {}
          artworkUploadMs = Math.round(performance.now() - artworkStartedAt);
          if (!coverResponse.ok || !coverData.ok) {
            log("R2 封面上傳失敗：" + (coverData.error || ("HTTP " + coverResponse.status)), "error");
            throw new Error(coverData.error || ("R2 封面寫入失敗（HTTP " + coverResponse.status + "）。"));
          }
          log("R2 封面上傳完成：" + artworkUploadMs + " ms", "success");
          artwork = { sha256, mimeType, sizeBytes: pictureBytes.byteLength };
          artworkNote = "封面已去重保存至 R2";
        }
      }

      const commonSafe = { ...common };
      delete commonSafe.picture;
      const yearSource = common.year ?? common.date;
      const yearMatch = String(yearSource || "").match(/(?:19|20)\d{2}/);
      const year = yearMatch ? Number(yearMatch[0]) : null;
      const durationSeconds = Number(format.duration || 0);
      const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1000) : null;
      const track = {
        id,
        file: {
          path,
          sizeBytes: fileSize,
          modifiedAt: listedFile?.modified || info.modified || info.modified_at || null,
          signature: null
        },
        title,
        artists: metadataStringList(common.artists || common.artist),
        album: common.album || null,
        albumArtist: common.albumartist || common.albumArtist || null,
        trackNumber: metadataNumber(common.track),
        discNumber: metadataNumber(common.disk),
        year,
        genres: metadataStringList(common.genre),
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
        lyrics: metadataStringList(common.lyrics),
        artwork,
        metadata: { tagTypes: metadata.tagTypes || [], common: commonSafe }
      };

      log("D1 曲目寫入開始");
      const catalogWriteStartedAt = performance.now();
      const response = await fetch("/api/catalog?kind=tracks", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Authorization: "Bearer " + activeStorageToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ track })
      });
      let data = {};
      try { data = await response.json(); } catch {}
      const catalogWriteMs = Math.round(performance.now() - catalogWriteStartedAt);
      if (!response.ok || !data.ok) {
        log("D1 曲目寫入失敗：" + (data.error || ("HTTP " + response.status)), "error");
        throw new Error(data.error || ("D1 曲目寫入失敗（HTTP " + response.status + "）。"));
      }
      log("D1 曲目寫入完成：" + catalogWriteMs + " ms", "success");

      const stats = result.stats || {};
      stats.openListInfoMs = openListInfoMs;
      stats.artworkUploadMs = artworkUploadMs;
      stats.catalogWriteMs = catalogWriteMs;
      stats.totalIndexMs = Math.round(performance.now() - indexStartedAt);
      if (!silent) renderMetadataResult(path, fileSize, result);
      if (!silent) {
        setResult(
          "PASS：單首索引寫入完成。\n歌曲：" + title +
          "\nD1：已保存 1 首；路徑：" + path +
          "\nR2：" + artworkNote +
          "\nMetadata Range：" + (stats.rangeRequests || 0) + " 次；實際讀取 " +
          formatBytes(stats.bytesFetched || 0) +
          "\nOpenList 原始音訊未下載、未修改。",
          "ok"
        );
      }
      return { ok: true, title, artworkNote, stats };
    } catch (error) {
      const message = error.message || "單首索引失敗。";
      log("歌曲索引失敗：" + message, "error");
      if (!silent) setResult(message, "error");
      return { ok: false, error: message };
    } finally {
      button.disabled = false;
    }
  }

  function scanProgressText(state, batch, finished = false) {
    const lines = [
      "掃描根目錄：" + state.rootPath,
      "已寫入／更新：" + state.indexedCount + " 首",
      "未變更而跳過：" + state.skippedCount + " 首",
      "失敗：" + state.failedCount + " 首",
      "已完成資料夾：" + state.visitedFolderCount + " 個",
      "待掃描資料夾：" + state.pendingFolders.length + (state.currentFolder ? "；目前：" + state.currentFolder : ""),
      "本批新增／更新：" + batch.indexed + " 首；跳過：" + batch.skipped + " 首；失敗：" + batch.failed + " 首"
    ];
    if (batch.phase) lines.push(batch.phase);
    if (batch.currentPath) lines.push("正在處理：" + batch.currentPath);
    if (batch.lastFileInfo) lines.push("最近完成：" + batch.lastFileInfo);
    if (batch.stopReason) lines.push("本批停止原因：" + batch.stopReason);
    if (state.currentFolder) {
      lines.push(
        "目前資料夾尚未掃完；續作游標：第 " + state.page +
        " 頁，第 " + (state.itemIndex + 1) + " 個項目。"
      );
    } else if (state.pendingFolders.length) {
      lines.push("目前資料夾已掃完，尚有 " + state.pendingFolders.length + " 個子資料夾待處理。");
    }
    if (state.completed) lines.push("本輪掃描已完成。再次啟動會重新檢查新增或變更檔案，不會刪除既有資料。");
    else if (scanPauseRequested) lines.push("已要求暫停，進度已保存；可以關閉頁面，之後重新連接並續作。");
    else if (finished) lines.push("本批已結束，進度已保存至 D1；可以關閉頁面，之後重新連接並續作。");
    else lines.push("掃描進行中，請保持此頁面開啟；進度會持續保存至 D1。");
    if (state.errors?.length) {
      const last = state.errors[state.errors.length - 1];
      lines.push("最近錯誤：" + last.path + "｜" + last.message);
    }
    return lines.join("\n");
  }

  async function scanStateRequest(key, method = "GET", state = null) {
    const url = method === "GET"
      ? "/api/catalog/state?key=" + encodeURIComponent(key)
      : "/api/catalog/state";
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        Authorization: "Bearer " + activeStorageToken,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {})
      },
      ...(method === "POST" ? { body: JSON.stringify({ key, state }) } : {})
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.ok) throw new Error(data.error || ("索引進度 API HTTP " + response.status));
    return data;
  }

  async function saveScanState(key, state) {
    state.updatedAt = new Date().toISOString();
    await scanStateRequest(key, "POST", state);
  }

  function newScanState(rootPath) {
    return {
      version: 1,
      rootPath,
      pendingFolders: [rootPath],
      currentFolder: null,
      page: 1,
      itemIndex: 0,
      seenFolders: [rootPath],
      indexedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      visitedFolderCount: 0,
      scannedEntryCount: 0,
      errors: [],
      completed: false,
      updatedAt: new Date().toISOString()
    };
  }

  async function batchIndexCurrentTree() {
    const startButton = $("#scan-batch");
    const pauseButton = $("#scan-pause");
    if (scanRunning) return;
    if (!connected) {
      setResult("請先連接 OpenList，並讀取要索引的音樂根目錄。", "error");
      return;
    }
    if (!cloudflareStorageReady || !activeStorageToken) {
      setResult("請先輸入 Cloudflare 管理金鑰並成功測試 D1 / R2。", "error");
      return;
    }
    const rootPath = String(activePath || "").trim();
    if (!rootPath.startsWith("/") || rootPath.includes("\\0")) {
      setResult("目前目錄路徑無效，請重新讀取目錄。", "error");
      return;
    }
    if (!window.confirm(
      "即將以目前目錄作為索引根目錄：\n" + rootPath +
      "\n\n每批最多新增／更新 10 首，會遞迴讀取子資料夾。原始音訊不會上傳或修改。確定開始／繼續？"
    )) return;

    scanRunning = true;
    scanPauseRequested = false;
    startButton.disabled = true;
    pauseButton.disabled = false;
    const fakeButton = { disabled: false };
    const key = "music_scan_" + await sha256Hex(new TextEncoder().encode(rootPath));
    const batch = {
      indexed: 0, skipped: 0, failed: 0, entries: 0, foldersVisited: 0,
      directoryListMs: 0, catalogLookupMs: 0
    };
    let state = null;

    try {
      const stored = await scanStateRequest(key);
      state = stored.state;
      if (!state) {
        state = newScanState(rootPath);
        await saveScanState(key, state);
      } else if (state.completed) {
        if (!window.confirm(
          "這個目錄的上一輪掃描已完成。重新執行會跳過未變更歌曲，只索引新增或變更項目，不會刪除任何資料。要開始新一輪嗎？"
        )) return;
        state = newScanState(rootPath);
        await saveScanState(key, state);
      }

      setScanProgress("批量索引已啟動。\n" + scanProgressText(state, batch), "ok");
      const startedAt = Date.now();
      const maxIndexedPerBatch = 10;
      const maxEntriesPerBatch = 500;
      const maxFoldersPerBatch = 40;
      const maxDurationMs = 75000;

      while (!state.completed &&
             batch.indexed < maxIndexedPerBatch &&
             batch.entries < maxEntriesPerBatch &&
             batch.foldersVisited < maxFoldersPerBatch &&
             Date.now() - startedAt < maxDurationMs &&
             !scanPauseRequested) {
        if (!state.currentFolder) {
          if (state.pendingFolders.length === 0) {
            state.completed = true;
            break;
          }
          state.currentFolder = state.pendingFolders.shift();
          state.page = 1;
          state.itemIndex = 0;
          await saveScanState(key, state);
        }

        batch.phase = "正在讀取目錄列表：" + state.currentFolder +
          "（第 " + state.page + " 頁；單次最長 45 秒，最多自動重試 1 次）";
        setScanProgress(scanProgressText(state, batch), "ok");
        const directoryListStartedAt = performance.now();
        const listing = await listOpenListDirectory({
          baseUrl: activeBaseUrl,
          token: activeToken,
          path: state.currentFolder,
          page: state.page,
          perPage: 100
        });
        batch.directoryListMs += Math.round(performance.now() - directoryListStartedAt);
        batch.phase = "";
        const audioItems = listing.items.filter(item => !item.isDir && AUDIO_FILE_PATTERN.test(item.name));
        const existingByPath = new Map();
        if (audioItems.length) {
          const catalogLookupStartedAt = performance.now();
          const lookupResponse = await fetch("/api/catalog/lookup", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              Authorization: "Bearer " + activeStorageToken,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              paths: audioItems.map(item => joinOpenListPath(state.currentFolder, item.name))
            })
          });
          let lookupData = {};
          try { lookupData = await lookupResponse.json(); } catch {}
          if (!lookupResponse.ok || !lookupData.ok) {
            throw new Error(lookupData.error || ("D1 增量查詢失敗（HTTP " + lookupResponse.status + "）。"));
          }
          for (const item of lookupData.items || []) existingByPath.set(item.path, item);
          batch.catalogLookupMs += Math.round(performance.now() - catalogLookupStartedAt);
        }

        if (state.itemIndex > listing.items.length) state.itemIndex = 0;
        for (let index = state.itemIndex; index < listing.items.length; index += 1) {
          if (scanPauseRequested || batch.indexed >= maxIndexedPerBatch ||
              batch.entries >= maxEntriesPerBatch || Date.now() - startedAt >= maxDurationMs) break;

          const item = listing.items[index];
          const fullPath = joinOpenListPath(state.currentFolder, item.name);
          let checkpointNow = false;

          if (item.isDir) {
            if (!state.seenFolders.includes(fullPath)) {
              state.seenFolders.push(fullPath);
              state.pendingFolders.push(fullPath);
            }
          } else if (AUDIO_FILE_PATTERN.test(item.name)) {
            const existing = existingByPath.get(fullPath);
            const listedModified = item.modified || null;
            const unchanged = existing &&
              Number(existing.sizeBytes) === Number(item.size) &&
              !!listedModified &&
              existing.modifiedAt === listedModified;
            if (unchanged) {
              state.skippedCount += 1;
              batch.skipped += 1;
            } else {
              batch.currentPath = fullPath;
              setScanProgress(scanProgressText(state, batch), "ok");
              const trackStartedAt = performance.now();
              const indexed = await indexSingleAudioFile(fullPath, fakeButton, {
                silent: true,
                listedFile: item
              });
              const trackElapsedSeconds = (performance.now() - trackStartedAt) / 1000;
              batch.currentPath = "";
              if (indexed.ok) {
                state.indexedCount += 1;
                batch.indexed += 1;
                const stats = indexed.stats || {};
                batch.lastFileInfo =
                  indexed.title + "｜總 " + trackElapsedSeconds.toFixed(1) + " 秒｜" +
                  "Range " + (stats.rangeRequests || 0) + " 次／" +
                  formatBytes(stats.bytesFetched || 0) + "／" +
                  (stats.totalRequestMs ?? "?") + " ms" +
                  "（最慢 " + (stats.slowestRequestMs ?? "?") + " ms）｜" +
                  "CDN " + (stats.parserLoadMs ?? "?") + " ms｜" +
                  "解析 " + (stats.parseElapsedMs ?? "?") + " ms｜" +
                  "資訊 API " + (stats.openListInfoMs ?? "?") + " ms｜" +
                  "R2 " + (stats.artworkUploadMs ?? "?") + " ms｜" +
                  "D1 " + (stats.catalogWriteMs ?? "?") + " ms";
              } else {
                batch.lastFileInfo =
                  "索引失敗｜" + trackElapsedSeconds.toFixed(1) + " 秒｜" + fullPath;
                const message = String(indexed.error || "未知索引錯誤").slice(0, 700);
                if (/管理金鑰不正確|尚未設定 FRAME_AUDIO_ADMIN_TOKEN|HTTP 401|HTTP 403/i.test(message)) {
                  throw new Error(message + " 請重新測試 Cloudflare 儲存連線後再繼續。");
                }
                state.failedCount += 1;
                batch.failed += 1;
                state.errors.push({ path: fullPath, message, at: new Date().toISOString() });
                if (state.errors.length > 20) state.errors.shift();
              }
              checkpointNow = true;
            }
          }

          state.itemIndex = index + 1;
          state.scannedEntryCount += 1;
          batch.entries += 1;
          if (checkpointNow || batch.entries % 10 === 0) {
            await saveScanState(key, state);
          }
          setScanProgress(scanProgressText(state, batch), "ok");
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
          await saveScanState(key, state);
        }
      }

      if (!state.currentFolder && state.pendingFolders.length === 0) state.completed = true;
      const batchElapsedMs = Date.now() - startedAt;
      if (state.completed) {
        batch.stopReason = "整個指定根目錄已掃完";
      } else if (scanPauseRequested) {
        batch.stopReason = "使用者要求暫停";
      } else if (batch.indexed >= maxIndexedPerBatch) {
        batch.stopReason = "達到每批新增／更新 " + maxIndexedPerBatch + " 首上限";
      } else if (batch.entries >= maxEntriesPerBatch) {
        batch.stopReason = "達到每批檢查 " + maxEntriesPerBatch + " 個項目上限";
      } else if (batch.foldersVisited >= maxFoldersPerBatch) {
        batch.stopReason = "達到每批完成 " + maxFoldersPerBatch + " 個資料夾上限";
      } else if (batchElapsedMs >= maxDurationMs) {
        batch.stopReason = "達到單批 " + Math.round(maxDurationMs / 1000) + " 秒安全時限";
      } else {
        batch.stopReason = "本批正常結束，仍有工作可續作";
      }
      batch.stopReason += "；目錄列表 API " + batch.directoryListMs +
        " ms；D1 增量查詢 " + batch.catalogLookupMs + " ms";
      await saveScanState(key, state);
      setScanProgress(scanProgressText(state, batch, true), "ok");
    } catch (error) {
      if (state) {
        state.lastError = String(error.message || error).slice(0, 700);
        try { await saveScanState(key, state); } catch {}
      }
      setScanProgress(
        (error.message || "批量索引失敗。") +
        (state ? "\n已保留目前進度；修復問題後可以重新點擊續作。" : ""),
        "error"
      );
    } finally {
      scanRunning = false;
      startButton.disabled = false;
      pauseButton.disabled = true;
    }
  }

  async function testAudioMetadata(path, button) {
    button.disabled = true;
    clearMetadataPreview();
    setResult("正在讀取音訊標籤。解析器只會透過 HTTP Range 讀取需要的區段，單檔讀取上限 16 MiB……\n" + path);
    try {
      const info = await getOpenListFileInfo({
        baseUrl: activeBaseUrl,
        token: activeToken,
        path
      });
      if (info.is_dir) throw new Error("選取的項目是資料夾，請選擇音訊檔案。");
      const result = await inspectAudioMetadata({
        rawUrl: info.raw_url,
        baseUrl: activeBaseUrl,
        path,
        fileSize: Number(info.size || 0)
      });
      renderMetadataResult(path, Number(info.size || 0), result);
      const stats = result.stats || {};
      setResult(
        "PASS：音訊標籤解析完成。\n成功 Range：" + (stats.rangeRequests || 0) +
        " 次；請求嘗試：" + (stats.requestAttempts || stats.rangeRequests || 0) +
        " 次；自動重試：" + (stats.retryCount || 0) +
        " 次。\n重新導向：" + (stats.redirectedRequests || 0) +
        " 次；起始主機：" + (stats.initialHost || "未知") +
        "；最終主機：" + (stats.finalHost || "未知") +
        "。\n實際讀取：" + formatBytes(stats.bytesFetched || 0) +
        "；檔案大小：" + formatBytes(Number(info.size || 0)) +
        "。\n未下載完整音訊，未修改 OpenList 原始檔案。",
        "ok"
      );
    } catch (error) {
      setResult(error.message || "音訊標籤解析失敗。", "error");
    } finally {
      button.disabled = false;
    }
  }

  async function testAudioFile(path, row) {
    row.disabled = true;
    clearMetadataPreview();
    setResult("正在測試音訊檔案中段與尾端的 HTTP Range 回應……\n" + path);
    try {
      const info = await getOpenListFileInfo({
        baseUrl: activeBaseUrl,
        token: activeToken,
        path
      });
      const fileSize = Number(info.size || 0);
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
        throw new Error("OpenList 沒有提供有效的檔案大小。");
      }
      const chunk = 65536;
      const offsets = [...new Set([
        Math.floor(Math.floor(fileSize / 2) / chunk) * chunk,
        Math.floor(Math.max(0, fileSize - chunk) / chunk) * chunk
      ])].filter(offset => offset > 0 && offset < fileSize);

      if (offsets.length === 0) {
        setResult("檔案太小，無法測試非零位置的 Range。請選擇大於 128 KiB 的音訊檔。", "error");
        return;
      }

      const lines = [
        "中段／尾端 Range 測試",
        "檔案大小：" + formatBytes(fileSize),
        "檔案路徑：" + path
      ];
      let allPassed = true;
      for (let index = 0; index < offsets.length; index += 1) {
        const offset = offsets[index];
        setResult(lines.concat("正在測試 " + (index + 1) + "/" + offsets.length + "，起始位移 " + offset + " bytes……").join("\n"));
        const result = await probeOpenListAudioRange({
          baseUrl: activeBaseUrl,
          token: activeToken,
          path,
          byteCount: chunk,
          startByte: offset
        });
        lines.push(
          (result.range_supported ? "PASS" : "FAIL") +
          "：bytes=" + result.start_byte + "-" + result.end_byte +
          "；HTTP " + result.status_code +
          "；讀取 " + formatBytes(result.bytes_received) +
          "；來源 " + (result.final_host || "未知")
        );
        if (result.content_range) lines.push("Content-Range：" + result.content_range);
        if (result.warning) lines.push(result.warning);
        if (!result.range_supported) {
          allPassed = false;
          break;
        }
      }
      lines.push(allPassed
        ? "中段與尾端 Range 均通過。"
        : "非零位置的 Range 未全部通過，這可能是 metadata 解析中斷的原因。");
      setResult(lines.join("\n"), allPassed ? "ok" : "error");
    } catch (error) {
      setResult(error.message || "音訊 Range 測試失敗。", "error");
    } finally {
      row.disabled = false;
    }
  }

  function renderDirectory(result) {
    activePath = result.path;
    currentPathLabel.textContent = result.path;
    browser.hidden = false;
    browseButton.disabled = false;
    listBox.replaceChildren();

    if (result.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "browser-empty";
      empty.textContent = "這個目錄目前沒有項目。";
      listBox.append(empty);
    }

    const sorted = [...result.items].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-Hant"));
    for (const item of sorted) {
      const fullPath = joinOpenListPath(activePath, item.name);
      const isAudio = !item.isDir && AUDIO_FILE_PATTERN.test(item.name);
      const icon = document.createElement("span");
      icon.className = "entry-icon";
      icon.textContent = item.isDir ? "▰" : "♫";
      const name = document.createElement("span");
      name.className = "entry-name";
      name.textContent = item.name;
      const size = document.createElement("span");
      size.className = "entry-size";
      size.textContent = item.isDir ? "資料夾　›" : formatBytes(item.size);

      if (item.isDir) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "entry";
        row.append(icon, name, size);
        row.addEventListener("click", () => loadDirectory(fullPath));
        listBox.append(row);
      } else if (isAudio) {
        const wrapper = document.createElement("div");
        wrapper.className = "audio-entry-wrap";
        const infoRow = document.createElement("div");
        infoRow.className = "entry audio-info";
        size.textContent = formatBytes(item.size);
        infoRow.append(icon, name, size);

        const actions = document.createElement("div");
        actions.className = "entry-actions";
        const rangeButton = document.createElement("button");
        rangeButton.type = "button";
        rangeButton.className = "entry-action";
        rangeButton.textContent = "中段／尾端 Range 測試";
        rangeButton.addEventListener("click", () => testAudioFile(fullPath, rangeButton));

        const metadataButton = document.createElement("button");
        metadataButton.type = "button";
        metadataButton.className = "entry-action entry-action-primary";
        metadataButton.textContent = "讀取標籤";
        metadataButton.addEventListener("click", () => testAudioMetadata(fullPath, metadataButton));

        const indexButton = document.createElement("button");
        indexButton.type = "button";
        indexButton.className = "entry-action entry-action-primary";
        indexButton.textContent = "試存此首至曲庫";
        indexButton.addEventListener("click", () => indexSingleAudioFile(fullPath, indexButton));

        actions.append(rangeButton, metadataButton, indexButton);
        wrapper.append(infoRow, actions);
        listBox.append(wrapper);
      } else {
        const row = document.createElement("div");
        row.className = "entry";
        row.append(icon, name, size);
        listBox.append(row);
      }
    }

    const summary = `連線成功。讀取 ${result.items.length} 個項目（API 回報總數 ${result.total}）。\n進入資料夾後，點選支援格式的音訊檔即可測試最多 64 KiB 的 Range 回應。`;
    setResult(summary, "ok");
    $("#connection-label").textContent = "OpenList 已連線";
    $("#connection-dot").style.background = "#78b98d";
    connected = true;
  }

  async function loadDirectory(path) {
    setResult("正在讀取目錄……");
    try {
      const result = await listOpenListDirectory({
        baseUrl: activeBaseUrl,
        token: activeToken,
        path,
        page: 1,
        perPage: 100
      });
      pathInput.value = path;
      renderDirectory(result);
    } catch (error) {
      setResult(error.message || "讀取目錄失敗。", "error");
    }
  }

  async function testConnection() {
    const button = $("#test-connection");
    activeBaseUrl = urlInput.value.trim();
    activeToken = tokenInput.value;
    const path = pathInput.value.trim() || "/";
    button.disabled = true;
    browseButton.disabled = true;
    browser.hidden = true;
    connected = false;
    $("#connection-label").textContent = "正在連接 OpenList";
    $("#connection-dot").style.background = "#b78b75";
    setResult("正在連接並讀取目錄……");
    try {
      const result = await listOpenListDirectory({
        baseUrl: activeBaseUrl,
        token: activeToken,
        path,
        page: 1,
        perPage: 100
      });
      renderDirectory(result);
    } catch (error) {
      $("#connection-label").textContent = "OpenList 尚未連線";
      $("#connection-dot").style.background = "#b78b75";
      setResult(error.message || "連線失敗。", "error");
    } finally {
      button.disabled = false;
    }
  }

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  $("#open-settings").addEventListener("click", () => dialog.showModal());
  $("#close-settings").addEventListener("click", () => dialog.close());
  $("#test-connection").addEventListener("click", testConnection);
  $("#test-storage").addEventListener("click", testCloudflareStorage);
  $("#scan-batch").addEventListener("click", batchIndexCurrentTree);
  $("#scan-pause").addEventListener("click", () => {
    scanPauseRequested = true;
    $("#scan-pause").disabled = true;
    setScanProgress("已要求暫停，完成目前音訊的索引後會保存進度……", "ok");
  });
  browseButton.addEventListener("click", () => loadDirectory(pathInput.value.trim() || "/"));
  $("#choose-current").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(activePath);
      setResult("已複製目錄路徑：" + activePath, "ok");
    } catch {
      pathInput.value = activePath;
      setResult("目前路徑已填入上方欄位：" + activePath, "ok");
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  storageTokenInput.addEventListener("input", () => {
    activeStorageToken = storageTokenInput.value.trim();
    cloudflareStorageReady = false;
  });
  tokenInput.addEventListener("input", () => {
    // Keep credentials only in this page's JavaScript/DOM memory. Never persist them.
    activeToken = tokenInput.value;
  });

  showView("music");
})();
