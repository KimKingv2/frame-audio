import { listOpenListDirectory, joinOpenListPath, formatBytes, probeOpenListAudioRange, getOpenListFileInfo } from "./openlist-client.js?v=20261111-vps-all-source1";
import { inspectAudioMetadata } from "./metadata-inspector.js";
import { runPodcastBatch, indexPodcastEpisode } from "./podcast-scanner.js";
import { initLibraryUI } from "./library-ui.js?v=20261111-album-ime2";

const AUDIO_FILE_PATTERN = /\.(?:flac|mp3|m4a|mp4|aac|wav|aiff?|ogg|opus|wma|ape|dsf|dff)$/i;
(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#connection-dialog");
  const urlInput = $("#openlist-url");
  const tokenInput = $("#openlist-token");
  const storageTokenInput = $("#cloudflare-admin-token");
  const musicRootInput = $("#music-root-path");
  const podcastRootInput = $("#podcast-root-path");
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
  let libraryUI = null;

  // Register connection controls before the rest of the UI initializes.
  // This keeps the essential setup actions available even if another view
  // component encounters an initialization problem.
  $("#test-connection")?.addEventListener("click", testConnection);
  $("#test-storage")?.addEventListener("click", testCloudflareStorage);
  browseButton?.addEventListener("click", () => loadDirectory(pathInput.value.trim() || "/"));

  const views = {
    music: ["Music", "YOUR MUSIC LIBRARY", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "MUSIC LIBRARY", "你的音樂收藏", "♫", "音樂庫尚未連接", "先連接 OpenList 並確認音樂根目錄；之後再建立音樂索引。"],
    podcasts: ["Podcasts", "YOUR PODCAST LIBRARY", "好內容，<span>慢慢聽。</span>", "集中管理喜愛的節目，從上次停止的位置繼續收聽。", "PODCAST LIBRARY", "你的節目收藏", "▤", "Podcast 尚未連接", "接入節目資料後，節目封面、單集、收聽進度與播放速度控制就會出現在這裡。"],
    tracks: ["Music", "TRACKS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "TRACKS", "所有歌曲", "♫", "歌曲索引尚未發布", "歌曲索引發布後，這裡會顯示完整曲庫。"],
    albums: ["Music", "ALBUMS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "ALBUMS", "專輯", "▣", "專輯索引尚未發布", "專輯索引發布後，這裡會依照專輯資訊整理收藏。"],
    artists: ["Music", "ARTISTS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "ARTISTS", "歌手", "♙", "歌手索引尚未發布", "歌手索引發布後，這裡會整理歌曲與專輯關聯。"],
    folders: ["Music", "FOLDER PLAYLISTS", "音樂，<span>隨時入場。</span>", "整理你的收藏，讓每一次播放都回到自己的音樂世界。", "FOLDER PLAYLISTS", "資料夾歌單", "▰", "資料夾索引尚未發布", "索引器會保留 OpenList 原始目錄樹。每個資料夾都能成為播放清單，並可選擇包含子資料夾。"],
    shows: ["Podcasts", "SHOWS", "好內容，<span>慢慢聽。</span>", "集中管理喜愛的節目，從上次停止的位置繼續收聽。", "SHOWS", "所有節目", "▥", "節目索引尚未發布", "節目索引發布後，這裡會顯示你的 Podcast 節目與單集。"],
    continue: ["Podcasts", "CONTINUE LISTENING", "好內容，<span>慢慢聽。</span>", "集中管理喜愛的節目，從上次停止的位置繼續收聽。", "CONTINUE LISTENING", "繼續收聽", "◷", "目前沒有收聽紀錄", "Podcast 播放進度會獨立保存，之後可以從上次停止的位置繼續。"],
    reports: ["ACTIVITY", "LISTENING REPORTS", "每一次聆聽，<span>都有回聲。</span>", "依時間範圍檢視 Music 與 Podcast 的播放次數及實際收聽時長。", "LISTENING REPORTS", "收聽報告", "▣", "還沒有收聽紀錄", "開始播放後，這裡會整理你的收聽統計。"],
    errors: ["MAINTENANCE", "INDEX REPAIR", "讓收藏，<span>保持完整。</span>", "檢視失敗項目，修正路徑後單獨更新索引。", "INDEX REPAIR", "索引錯誤", "⚠", "目前沒有待修復錯誤", "單首修復不會重新掃描整個目錄，也不會修改原始音訊。"]
  };

  function showView(name) {
    const view = views[name] || views.music;
    const ids = ["section", "eyebrow", "title", "description", "kicker", "heading", "icon", "emptytitle", "emptytext"];
    ids.forEach((id, index) => {
      const node = document.getElementById(id);
      if (!node) return;
      if (id === "title") node.innerHTML = view[index];
      else node.textContent = view[index];
    });
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    libraryUI?.showView(name);
  }

  function setResult(message, type = "") {
    resultBox.textContent = message;
    resultBox.className = "statusbox" + (type ? " " + type : "");
  }

  function setStorageResult(message, type = "") {
    storageResultBox.textContent = message;
    storageResultBox.className = "statusbox" + (type ? " " + type : "");
  }

  function getConfiguredRoot(input, label) {
    const raw = String(input?.value || "").trim();
    if (!raw.startsWith("/") || raw.includes("\0")) {
      throw new Error(label + " 根目錄必須以 / 開頭，且不能包含空字元。");
    }
    return raw === "/" ? "/" : raw.replace(/\/+$/, "");
  }

  function setCurrentFolderAsRoot(input, label) {
    if (!activePath || !activePath.startsWith("/")) {
      setResult("請先在 VPS Alist 目錄瀏覽器中開啟要設定的資料夾。", "error");
      return;
    }
    input.value = activePath;
    setResult("已將目前資料夾設為 " + label + " 根目錄：\n" + activePath, "ok");
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
      void libraryUI?.refresh();
      setStorageResult(
        "PASS：Cloudflare 儲存已連線。\nD1：歌曲 " + data.tracks + " 首；資料夾 " + data.folders + " 個。\nR2：已連接。" +
        (data.podcastSchemaReady
          ? "\nPodcast D1：已初始化；節目 " + data.podcastShows + " 個；單集 " + data.podcastEpisodes + " 集。"
          : "\nPodcast D1：尚未初始化。請在 D1 執行 migrations/0002_podcasts.sql 後再開始 Podcast 掃描。") +
        (data.listeningSchemaReady
          ? "\n收聽進度與報表資料表：已初始化。"
          : "\n收聽進度與報表資料表：尚未初始化，請執行 migrations/0003_listening.sql。"),
        data.podcastSchemaReady ? "ok" : "");
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
      const message = "請先測試 VPS Alist 連線並讀取目錄。";
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
      let info = null;
      let openListInfoMs = 0;
      const preloadedFileInfo = options.preloadedFileInfo || null;
      if (preloadedFileInfo && preloadedFileInfo.path === path) {
        log("等待前瞻預取的 VPS Alist /api/fs/get：" + path);
        const preloadResult = await preloadedFileInfo.promise;
        if (preloadResult?.ok) {
          info = preloadResult.info;
          openListInfoMs = Number(preloadResult.elapsedMs || 0);
          log("已使用前瞻預取的 /api/fs/get 結果；原請求耗時 " +
            openListInfoMs + " ms；檔案大小 " + formatBytes(Number(info.size || 0)), "success");
        } else {
          log("前瞻預取 /api/fs/get 失敗，改為一般請求重試：" +
            (preloadResult?.error?.message || preloadResult?.error || "未知錯誤"), "warning");
        }
      }
      if (!info) {
        const fileInfoStartedAt = performance.now();
        log("VPS Alist /api/fs/get 開始");
        info = await getOpenListFileInfo({ baseUrl: activeBaseUrl, token: activeToken, path });
        openListInfoMs = Math.round(performance.now() - fileInfoStartedAt);
        log("VPS Alist /api/fs/get 完成：" + openListInfoMs + " ms；檔案大小 " +
          formatBytes(Number(info.size || 0)), "success");
      }
      if (info.is_dir) throw new Error("選取的項目是資料夾，請選擇音訊檔案。");
      const fileSize = Number(info.size || 0);
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error("VPS Alist 沒有提供有效的檔案大小。");
      if (typeof options.onFileInfoReady === "function") {
        try { options.onFileInfoReady(info); }
        catch (error) { log("啟動下一首檔案資訊預取失敗：" + (error.message || error), "warning"); }
      }

      log("音訊 metadata 解析階段開始");
      const result = await inspectAudioMetadata({
        rawUrl: info.raw_url,
        baseUrl: activeBaseUrl,
        path,
        fileSize,
        onEvent: (event) => log(event.message, event.level)
      });
      log("音訊 metadata 解析階段完成：總 " +
        (result.stats?.metadataReadElapsedMs ?? result.stats?.parseElapsedMs ?? "?") +
        " ms（首尾預取 " + (result.stats?.metadataPrefetchMs ?? 0) +
        " ms；解析 " + (result.stats?.parseElapsedMs ?? "?") + " ms）；Range " +
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
          "\n原始音訊未下載、未修改。",
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
      "累計曾失敗：" + state.failedCount + " 首",
      "已完成資料夾：" + state.visitedFolderCount + " 個",
      "待掃描資料夾：" + state.pendingFolders.length + (state.currentFolder ? "；目前：" + state.currentFolder : ""),
      "本批新增／更新：" + batch.indexed + " 首；跳過：" + batch.skipped + " 首；失敗：" + batch.failed + " 首"
    ];
    if (batch.phase) lines.push(batch.phase);
    if (batch.currentPath) lines.push("正在處理：" + batch.currentPath);
    if (batch.lastFileInfo) lines.push("最近完成：" + batch.lastFileInfo);
    if (batch.stopReason) lines.push("本批停止原因：" + batch.stopReason);
    if (state.folderIndexCompleted) {
      lines.push("資料夾階層：已建立 " + Number(state.folderIndexCount || 0) +
        " 個資料夾；關聯歌曲 " + Number(state.folderTrackCount || 0) + " 首。");
    }
    if (state.currentFolder) {
      lines.push(
        "目前資料夾尚未掃完；續作游標：第 " + state.page +
        " 頁，第 " + (state.itemIndex + 1) + " 個項目。"
      );
    } else if (state.pendingFolders.length) {
      lines.push("目前資料夾已掃完，尚有 " + state.pendingFolders.length + " 個子資料夾待處理。");
    }
    if (state.completed && state.folderIndexCompleted === true) {
      lines.push("歌曲與資料夾階層索引已完成。再次啟動會重新檢查新增或變更檔案，不會刪除既有資料。");
    } else if (state.completed) {
      lines.push("歌曲掃描已完成；資料夾階層索引尚未完成。重新啟動會自動補做，不會重掃歌曲。");
    } else if (scanPauseRequested) lines.push("已要求暫停，進度已保存；可以關閉頁面，之後重新連接並續作。");
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
    const startedAt = performance.now();
    appendScanLog("D1 掃描進度保存開始");
    try {
      await scanStateRequest(key, "POST", state);
      appendScanLog("D1 掃描進度保存完成：" + Math.round(performance.now() - startedAt) + " ms", "success");
    } catch (error) {
      appendScanLog("D1 掃描進度保存失敗：" + (error.message || error), "error");
      throw error;
    }
  }

  async function loadRetryPathSet() {
    const response = await fetch("/api/catalog/retries", {
      method: "GET",
      credentials: "same-origin",
      headers: { Authorization: "Bearer " + activeStorageToken }
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.ok) {
      throw new Error(data.error || ("讀取失敗重試佇列失敗（HTTP " + response.status + "）。"));
    }
    return new Set((data.items || [])
      .map(item => String(item?.path || ""))
      .filter(path => path.startsWith("/")));
  }

  async function saveRetryPath(path, message) {
    const response = await fetch("/api/catalog/retries", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Authorization: "Bearer " + activeStorageToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, message })
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.ok) {
      throw new Error(data.error || ("保存失敗重試項目失敗（HTTP " + response.status + "）。"));
    }
  }

  async function resolveRetryPath(path) {
    const response = await fetch("/api/catalog/retries", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        Authorization: "Bearer " + activeStorageToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path })
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.ok) {
      throw new Error(data.error || ("解除失敗重試項目失敗（HTTP " + response.status + "）。"));
    }
  }

  function newScanState(rootPath, previousState = null) {
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
      errors: Array.isArray(previousState?.errors) ? previousState.errors.slice(-20) : [],
      completed: false,
      folderIndexCompleted: false,
      folderIndexCount: 0,
      folderTrackCount: 0,
      updatedAt: new Date().toISOString()
    };
  }

  async function batchIndexCurrentTree() {
    const startButton = $("#scan-music-batch");
    const pauseButton = $("#scan-pause");
    if (scanRunning) return;
    if (!connected) {
      setResult("請先測試 VPS Alist 連線，並讀取要索引的音樂根目錄。", "error");
      return;
    }
    if (!cloudflareStorageReady || !activeStorageToken) {
      setResult("請先輸入 Cloudflare 管理金鑰並成功測試 D1 / R2。", "error");
      return;
    }
    let rootPath;
    try {
      rootPath = getConfiguredRoot(musicRootInput, "Music");
    } catch (error) {
      setResult(error.message || "Music 根目錄路徑無效。", "error");
      return;
    }
    if (!window.confirm(
      "即將掃描 Music 根目錄：\n" + rootPath +
      "\n\n每批最長執行 7,500 秒（2 小時 5 分鐘），最多檢查 500 個項目；單首索引最多嘗試 20 次（首次加 19 次重試）。會遞迴讀取子資料夾。原始音訊不會上傳或修改。確定開始／繼續？"
    )) return;

    scanRunning = true;
    scanPauseRequested = false;
    startButton.disabled = true;
    $("#scan-podcast-batch").disabled = true;
    pauseButton.disabled = false;
    const fakeButton = { disabled: false };
    let prefetchedFileInfo = null;
    const key = "music_scan_" + await sha256Hex(new TextEncoder().encode(rootPath));
    const batch = {
      indexed: 0, skipped: 0, failed: 0, entries: 0, foldersVisited: 0,
      directoryListMs: 0, catalogLookupMs: 0
    };
    let state = null;

    try {
      appendScanLog("========== 批次索引開始 ==========");
      appendScanLog("掃描根目錄：" + rootPath);
      appendScanLog("D1 讀取掃描進度開始");
      const stateReadStartedAt = performance.now();
      const stored = await scanStateRequest(key);
      appendScanLog("D1 讀取掃描進度完成：" + Math.round(performance.now() - stateReadStartedAt) + " ms", "success");
      state = stored.state;
      if (!state) {
        state = newScanState(rootPath);
        await saveScanState(key, state);
      } else if (state.completed && state.folderIndexCompleted !== true) {
        appendScanLog("曲目掃描已完成；尚未建立資料夾階層，將補做資料夾索引。", "warning");
      } else if (state.completed) {
        if (!window.confirm(
          "這個目錄的上一輪掃描與資料夾階層索引都已完成。重新執行會跳過未變更歌曲，只索引新增或變更項目，不會刪除任何資料。要開始新一輪嗎？"
        )) return;
        state = newScanState(rootPath, state);
        await saveScanState(key, state);
      }

      const retryPaths = await loadRetryPathSet();
      appendScanLog("全域失敗重試佇列讀取完成：" + retryPaths.size + " 個待重試路徑",
        retryPaths.size ? "warning" : "success");
      setScanProgress("批量索引已啟動。\n" + scanProgressText(state, batch), "ok");
      const startedAt = Date.now();
      const maxIndexedPerBatch = 500;
      const maxEntriesPerBatch = 500;
      const maxFoldersPerBatch = 500;
      const maxDurationMs = 7500000;
      const maxFileAttempts = 20;
      const recoveredPaths = new Set();
      const retryRootPrefix = rootPath === "/" ? "/" : rootPath + "/";
      const rootRetryPaths = [...retryPaths]
        .filter(path => path.startsWith(retryRootPrefix) && AUDIO_FILE_PATTERN.test(path))
        .sort((a, b) => a.localeCompare(b, "en"));

      if (rootRetryPaths.length) {
        appendScanLog("目前掃描根目錄內有 " + rootRetryPaths.length +
          " 首待重試歌曲；先直接依完整路徑處理，不受原目錄分頁游標影響。", "warning");
      }

      for (const retryPath of rootRetryPaths) {
        if (scanPauseRequested || batch.indexed >= maxIndexedPerBatch ||
            batch.entries >= maxEntriesPerBatch ||
            Date.now() - startedAt >= maxDurationMs) break;
        if (!retryPaths.has(retryPath)) continue;

        batch.currentPath = retryPath;
        batch.phase = "優先重試先前失敗歌曲";
        setScanProgress(scanProgressText(state, batch), "warning");
        appendScanLog("全域失敗佇列優先重試開始：" + retryPath, "warning");
        const retryStartedAt = performance.now();
        let indexed = null;

        for (let attempt = 1; attempt <= maxFileAttempts; attempt += 1) {
          appendScanLog("失敗佇列歌曲索引嘗試 " + attempt + "/" +
            maxFileAttempts + "：" + retryPath);
          indexed = await indexSingleAudioFile(retryPath, fakeButton, {
            silent: true,
            onLog: (message, level) => appendScanLog(message, level)
          });
          if (indexed.ok) {
            if (attempt > 1) appendScanLog("失敗佇列歌曲重試後索引成功：" + retryPath, "success");
            break;
          }

          const failureMessage = String(indexed.error || "未知索引錯誤").slice(0, 700);
          if (/管理金鑰不正確|尚未設定 FRAME_AUDIO_ADMIN_TOKEN|HTTP 401|HTTP 403|驗證失敗|沒有.*權限/i.test(failureMessage)) {
            throw new Error(failureMessage + " 請重新測試 Cloudflare 儲存連線或檢查 VPS Alist Token 後再繼續。");
          }
          if (attempt < maxFileAttempts) {
            const retryDelayMs = 1500 * attempt;
            appendScanLog("失敗佇列歌曲索引失敗，" + retryDelayMs +
              " ms 後重新取得檔案資訊並重試（" + (attempt + 1) + "/" +
              maxFileAttempts + "）：" + failureMessage, "warning");
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          }
        }

        const retryElapsedSeconds = (performance.now() - retryStartedAt) / 1000;
        batch.currentPath = "";
        batch.phase = "";
        batch.entries += 1;

        if (indexed?.ok) {
          await resolveRetryPath(retryPath);
          retryPaths.delete(retryPath);
          recoveredPaths.add(retryPath);
          state.errors = (state.errors || []).filter(item => item?.path !== retryPath);
          state.indexedCount += 1;
          batch.indexed += 1;
          appendScanLog("歌曲已成功重試，從全域失敗佇列解除：" + retryPath +
            "；耗時 " + retryElapsedSeconds.toFixed(1) + " 秒", "success");
          const stats = indexed.stats || {};
          batch.lastFileInfo = indexed.title + "｜失敗佇列重試成功｜總 " +
            retryElapsedSeconds.toFixed(1) + " 秒｜Range " +
            (stats.rangeRequests || 0) + " 次";
        } else {
          const message = String(indexed?.error || "未知索引錯誤").slice(0, 700);
          state.failedCount += 1;
          batch.failed += 1;
          try {
            await saveRetryPath(retryPath, message);
            appendScanLog("失敗佇列歌曲仍未成功，保留待重試狀態：" + retryPath, "warning");
          } catch (queueError) {
            appendScanLog("更新失敗佇列項目失敗：" +
              (queueError.message || queueError), "error");
          }
          state.errors = (state.errors || []).filter(item => item?.path !== retryPath);
          state.errors.push({ path: retryPath, message, at: new Date().toISOString() });
          if (state.errors.length > 20) state.errors.shift();
        }

        await saveScanState(key, state);
        setScanProgress(scanProgressText(state, batch), "ok");
      }

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
          appendScanLog("進入資料夾：" + state.currentFolder);
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
          perPage: 100,
          onEvent: (event) => appendModuleLog(event, state.currentFolder)
        });
        const directoryElapsedMs = Math.round(performance.now() - directoryListStartedAt);
        batch.directoryListMs += directoryElapsedMs;
        appendScanLog("目錄列表完成：" + state.currentFolder + "；第 " + state.page +
          " 頁；本頁 " + listing.items.length + "/" + listing.total + " 項；耗時 " + directoryElapsedMs + " ms", "success");
        batch.phase = "";
        const audioItems = listing.items.filter(item => !item.isDir && AUDIO_FILE_PATTERN.test(item.name));
        const existingByPath = new Map();
        if (audioItems.length) {
          appendScanLog("D1 增量查詢開始：" + audioItems.length + " 個音訊路徑");
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
          const lookupElapsedMs = Math.round(performance.now() - catalogLookupStartedAt);
          batch.catalogLookupMs += lookupElapsedMs;
          appendScanLog("D1 增量查詢完成：" + lookupElapsedMs + " ms；找到既有 " +
            (lookupData.items || []).length + " 首", "success");
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
              appendScanLog("發現子資料夾：" + fullPath);
            }
          } else if (AUDIO_FILE_PATTERN.test(item.name)) {
            const existing = existingByPath.get(fullPath);
            const listedModified = item.modified || null;
            const queuedForRetry = retryPaths.has(fullPath);
            const alreadyRecovered = recoveredPaths.has(fullPath);
            const unchanged = alreadyRecovered || (!queuedForRetry && existing &&
              Number(existing.sizeBytes) === Number(item.size) &&
              !!listedModified &&
              existing.modifiedAt === listedModified);
            if (alreadyRecovered) {
              appendScanLog("本批已在全域失敗佇列優先階段成功索引，略過重複處理：" + fullPath, "success");
            }
            if (queuedForRetry) {
              appendScanLog("此歌曲在全域失敗佇列中，本輪強制重試，不因既有 D1 紀錄而跳過：" + fullPath, "warning");
            }
            if (unchanged) {
              state.skippedCount += 1;
              batch.skipped += 1;
              appendScanLog("跳過未變更歌曲：" + fullPath, "success");
            } else {
              batch.currentPath = fullPath;
              setScanProgress(scanProgressText(state, batch), "ok");
              const trackStartedAt = performance.now();
              const nextCandidate = (() => {
                for (let nextIndex = index + 1; nextIndex < listing.items.length; nextIndex += 1) {
                  const candidate = listing.items[nextIndex];
                  if (candidate.isDir || !AUDIO_FILE_PATTERN.test(candidate.name)) continue;
                  const candidatePath = joinOpenListPath(state.currentFolder, candidate.name);
                  const existingCandidate = existingByPath.get(candidatePath);
                  const candidateModified = candidate.modified || null;
                  const candidateUnchanged = !retryPaths.has(candidatePath) && existingCandidate &&
                    Number(existingCandidate.sizeBytes) === Number(candidate.size) &&
                    !!candidateModified &&
                    existingCandidate.modifiedAt === candidateModified;
                  if (!candidateUnchanged) return { path: candidatePath, item: candidate };
                }
                return null;
              })();
              let indexed = null;
              for (let attempt = 1; attempt <= maxFileAttempts; attempt += 1) {
                const currentPrefetch = attempt === 1 && prefetchedFileInfo?.path === fullPath
                  ? prefetchedFileInfo : null;
                if (currentPrefetch) prefetchedFileInfo = null;
                appendScanLog("歌曲索引嘗試 " + attempt + "/" + maxFileAttempts + "：" + fullPath);
                indexed = await indexSingleAudioFile(fullPath, fakeButton, {
                  silent: true,
                  listedFile: item,
                  preloadedFileInfo: currentPrefetch,
                  onFileInfoReady: () => {
                    if (!nextCandidate || prefetchedFileInfo || scanPauseRequested ||
                        batch.indexed >= maxIndexedPerBatch - 1 ||
                        Date.now() - startedAt >= maxDurationMs) return;
                    const prefetchStartedAt = performance.now();
                    appendScanLog("下一首 /api/fs/get 前瞻預取開始：" + nextCandidate.path);
                    const promise = getOpenListFileInfo({
                      baseUrl: activeBaseUrl,
                      token: activeToken,
                      path: nextCandidate.path
                    }).then(info => {
                      const elapsedMs = Math.round(performance.now() - prefetchStartedAt);
                      appendScanLog("下一首 /api/fs/get 前瞻預取完成：" + nextCandidate.path +
                        "；耗時 " + elapsedMs + " ms；檔案大小 " +
                        formatBytes(Number(info.size || 0)), "success");
                      return { ok: true, info, elapsedMs };
                    }).catch(error => {
                      const elapsedMs = Math.round(performance.now() - prefetchStartedAt);
                      appendScanLog("下一首 /api/fs/get 前瞻預取失敗：" + nextCandidate.path +
                        "；耗時 " + elapsedMs + " ms；" + (error.message || error), "warning");
                      return { ok: false, error, elapsedMs };
                    });
                    prefetchedFileInfo = { path: nextCandidate.path, promise };
                  },
                  onLog: (message, level) => appendScanLog(message, level)
                });
                if (indexed.ok) {
                  if (attempt > 1) appendScanLog("歌曲重試後索引成功：" + fullPath, "success");
                  break;
                }

                const failureMessage = String(indexed.error || "未知索引錯誤").slice(0, 700);
                if (/管理金鑰不正確|尚未設定 FRAME_AUDIO_ADMIN_TOKEN|HTTP 401|HTTP 403|驗證失敗|沒有.*權限/i.test(failureMessage)) {
                  throw new Error(failureMessage + " 請重新測試 Cloudflare 儲存連線或檢查 VPS Alist Token 後再繼續。");
                }
                if (attempt < maxFileAttempts) {
                  const retryDelayMs = 1500 * attempt;
                  appendScanLog("歌曲索引失敗，" + retryDelayMs +
                    " ms 後重新取得檔案資訊並重試（" + (attempt + 1) + "/" +
                    maxFileAttempts + "）：" + failureMessage, "warning");
                  await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
              }
              const trackElapsedSeconds = (performance.now() - trackStartedAt) / 1000;
              batch.currentPath = "";
              if (indexed.ok) {
                if (retryPaths.has(fullPath)) {
                  try {
                    await resolveRetryPath(fullPath);
                    retryPaths.delete(fullPath);
                    state.errors = (state.errors || []).filter(item => item?.path !== fullPath);
                    appendScanLog("歌曲已成功重試，從全域失敗佇列解除：" + fullPath, "success");
                  } catch (error) {
                    appendScanLog("歌曲已索引成功，但解除失敗佇列時發生錯誤；下次掃描仍可能再檢查：" +
                      (error.message || error), "warning");
                  }
                }
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
                  "首尾預取 " + (stats.metadataPrefetchMs ?? 0) + " ms｜" +
                  "解析 " + (stats.parseElapsedMs ?? "?") + " ms｜" +
                  "資訊 API " + (stats.openListInfoMs ?? "?") + " ms｜" +
                  "R2 " + (stats.artworkUploadMs ?? "?") + " ms｜" +
                  "D1 " + (stats.catalogWriteMs ?? "?") + " ms";
              } else {
                batch.lastFileInfo =
                  "索引失敗｜" + trackElapsedSeconds.toFixed(1) + " 秒｜" + fullPath;
                const message = String(indexed.error || "未知索引錯誤").slice(0, 700);
                state.failedCount += 1;
                batch.failed += 1;
                try {
                  await saveRetryPath(fullPath, message);
                  retryPaths.add(fullPath);
                  appendScanLog("已將失敗歌曲加入全域重試佇列：" + fullPath, "warning");
                } catch (queueError) {
                  appendScanLog("保存全域重試佇列失敗，掃描狀態仍會保留錯誤紀錄：" +
                    (queueError.message || queueError), "error");
                }
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
      if (state.completed && state.folderIndexCompleted !== true) {
        appendScanLog("========== 資料夾階層索引開始 ==========");
        appendScanLog("根目錄：" + state.rootPath + "；資料夾路徑 " +
          (state.seenFolders || []).length + " 個");
        const folderIndexStartedAt = performance.now();
        const folderResponse = await fetch("/api/catalog/folders/rebuild", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Authorization: "Bearer " + activeStorageToken,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            rootPath: state.rootPath,
            folderPaths: Array.isArray(state.seenFolders) ? state.seenFolders : [state.rootPath]
          })
        });
        let folderData = {};
        try { folderData = await folderResponse.json(); } catch {}
        if (!folderResponse.ok || !folderData.ok) {
          throw new Error(folderData.error || ("資料夾階層索引失敗（HTTP " + folderResponse.status + "）。"));
        }
        state.folderIndexCompleted = true;
        state.folderIndexCount = Number(folderData.savedFolders || 0);
        state.folderTrackCount = Number(folderData.indexedTracks || 0);
        await saveScanState(key, state);
        appendScanLog("資料夾階層索引完成：" + state.folderIndexCount +
          " 個資料夾；關聯歌曲 " + state.folderTrackCount + " 首；耗時 " +
          Math.round(performance.now() - folderIndexStartedAt) + " ms", "success");
      }
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
      appendScanLog("========== 本批結束：" + batch.stopReason + " ==========", state.completed ? "success" : "warning");
      setScanProgress(scanProgressText(state, batch, true), "ok");
    } catch (error) {
      appendScanLog("批次索引發生錯誤：" + (error.message || error), "error");
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
      $("#scan-podcast-batch").disabled = false;
      pauseButton.disabled = true;
    }
  }

  async function batchIndexPodcastTree() {
    const startButton = $("#scan-podcast-batch");
    const musicButton = $("#scan-music-batch");
    const pauseButton = $("#scan-pause");
    if (scanRunning) return;
    if (!connected) {
      setResult("請先測試 VPS Alist 連線，並確認 Podcast 根目錄可讀取。", "error");
      return;
    }
    if (!cloudflareStorageReady || !activeStorageToken) {
      setResult("請先輸入 Cloudflare 管理金鑰並成功測試 D1 / R2。", "error");
      return;
    }
    let rootPath;
    try {
      rootPath = getConfiguredRoot(podcastRootInput, "Podcast");
    } catch (error) {
      setResult(error.message || "Podcast 根目錄路徑無效。", "error");
      return;
    }
    if (!window.confirm(
      "即將掃描 Podcast 根目錄：\n" + rootPath +
      "\n\n第一層每個資料夾視為一個節目；其下所有子資料夾中的音訊檔視為單集。每批最多檢查 500 個項目，單集最多嘗試 20 次。原始音訊不會上傳或修改。確定開始／繼續？"
    )) return;

    scanRunning = true;
    scanPauseRequested = false;
    startButton.disabled = true;
    musicButton.disabled = true;
    pauseButton.disabled = false;
    appendScanLog("========== Podcast 獨立掃描入口 ==========");
    appendScanLog("節目規則：Podcast 根目錄第一層資料夾 = 一個節目；子資料夾仍屬於該節目。");
    try {
      const result = await runPodcastBatch({
        baseUrl: activeBaseUrl,
        openListToken: activeToken,
        adminToken: activeStorageToken,
        rootPath,
        onLog: appendScanLog,
        onProgress: setScanProgress,
        shouldPause: () => scanPauseRequested
      });
      if (result?.cancelled) {
        appendScanLog("Podcast 已完成掃描；使用者取消新一輪掃描。", "warning");
      } else if (result?.ok) {
        setResult(
          "Podcast 掃描本批完成。\n根目錄：" + rootPath +
          "\n節目資料夾：" + (result.state?.showFolders || []).length +
          "\n本批新增／更新：" + (result.batch?.indexed || 0) +
          " 集；跳過：" + (result.batch?.skipped || 0) +
          " 集；失敗：" + (result.batch?.failed || 0) + " 集。",
          "ok"
        );
      }
    } catch (error) {
      appendScanLog("Podcast 掃描入口錯誤：" + (error.message || error), "error");
      setScanProgress(error.message || "Podcast 掃描失敗。", "error");
    } finally {
      scanRunning = false;
      startButton.disabled = false;
      musicButton.disabled = false;
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
        throw new Error("VPS Alist 沒有提供有效的檔案大小。");
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

    const summary = `VPS Alist 連線成功。讀取 ${result.items.length} 個項目（API 回報總數 ${result.total}）。\n進入資料夾後，點選支援格式的音訊檔即可測試最多 64 KiB 的 Range 回應。`;
    setResult(summary, "ok");
    $("#connection-label").textContent = "VPS Alist 已連線";
    $("#connection-dot").style.background = "#78b98d";
    connected = true;
    if (cloudflareStorageReady && activeStorageToken) void libraryUI?.refresh();
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
    if (!activeToken.trim()) {
      setResult("請先輸入 VPS Alist 唯讀 API Token。", "error");
      tokenInput.focus();
      return;
    }
    if (!activeBaseUrl) {
      setResult("請先填寫 VPS Alist 網址。", "error");
      urlInput.focus();
      return;
    }
    button.disabled = true;
    browseButton.disabled = true;
    browser.hidden = true;
    connected = false;
    $("#connection-label").textContent = "正在連接 VPS Alist";
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
      $("#connection-label").textContent = "VPS Alist 尚未連線";
      $("#connection-dot").style.background = "#b78b75";
      setResult(error.message || "連線失敗。", "error");
    } finally {
      button.disabled = false;
    }
  }

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  $("#scan-music-batch").addEventListener("click", batchIndexCurrentTree);
  $("#scan-podcast-batch").addEventListener("click", batchIndexPodcastTree);
  $("#scan-log-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(scanLogEntries.join("\n"));
      appendScanLog("日誌已複製到剪貼簿", "success");
    } catch (error) {
      appendScanLog("複製日誌失敗：" + (error.message || error), "error");
    }
  });
  $("#scan-log-clear").addEventListener("click", () => {
    scanLogEntries.length = 0;
    const output = $("#scan-log-output");
    output.replaceChildren();
    const placeholder = document.createElement("div");
    placeholder.className = "scan-log-placeholder";
    placeholder.textContent = "日誌已清空。下一個掃描事件會顯示於此。";
    output.append(placeholder);
    $("#scan-log-count").textContent = "0 筆";
  });
  $("#scan-pause").addEventListener("click", () => {
    scanPauseRequested = true;
    $("#scan-pause").disabled = true;
    setScanProgress("已要求暫停，完成目前單曲／單集的索引後會保存進度……", "ok");
  });
  $("#use-current-music-root").addEventListener("click", () => {
    setCurrentFolderAsRoot(musicRootInput, "Music");
  });
  $("#use-current-podcast-root").addEventListener("click", () => {
    setCurrentFolderAsRoot(podcastRootInput, "Podcast");
  });
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

  libraryUI = initLibraryUI({
    getCredentials: () => ({
      adminToken: activeStorageToken,
      openListToken: activeToken,
      baseUrl: activeBaseUrl,
      connected,
    }),
    reindexMusic: path => indexSingleAudioFile(path, { disabled: false }, {
      silent: true,
      onLog: appendScanLog
    }),
    reindexPodcast: path => {
      const rootPath = getConfiguredRoot(podcastRootInput, "Podcast");
      return indexPodcastEpisode({
        path,
        rootPath,
        baseUrl: activeBaseUrl,
        openListToken: activeToken,
        adminToken: activeStorageToken,
        onLog: appendScanLog
      });
    },
    resolveRetry: async (kind, path) => {
      const endpoint = kind === "episode"
        ? "/api/catalog/podcasts/retries"
        : "/api/catalog/retries";
      const response = await fetch(endpoint, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          Authorization: "Bearer " + activeStorageToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path })
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok || !data.ok) throw new Error(data.error || ("解除失敗佇列失敗（HTTP " + response.status + "）。"));
      return data;
    },
    relink: async ({ itemType, oldPath, newPath }) => {
      const response = await fetch("/api/catalog/relink", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Authorization: "Bearer " + activeStorageToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ itemType, oldPath, newPath })
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok || !data.ok) throw new Error(data.error || ("舊路徑移轉失敗（HTTP " + response.status + "）。"));
      return data;
    }
  });

  showView("music");
})();
