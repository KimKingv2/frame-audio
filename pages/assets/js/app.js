import { listOpenListDirectory, joinOpenListPath, formatBytes, probeOpenListAudioRange, getOpenListFileInfo } from "./openlist-client.js";
import { inspectAudioMetadata } from "./metadata-inspector.js";

const AUDIO_FILE_PATTERN = /\.(?:flac|mp3|m4a|mp4|aac|wav|aiff?|ogg|opus|wma|ape|dsf|dff)$/i;

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#connection-dialog");
  const urlInput = $("#openlist-url");
  const tokenInput = $("#openlist-token");
  const pathInput = $("#openlist-path");
  const resultBox = $("#connection-result");
  const browser = $("#directory-browser");
  const listBox = $("#directory-list");
  const currentPathLabel = $("#current-path");
  const metadataPreview = $("#metadata-result");
  const browseButton = $("#browse-root");
  let activeBaseUrl = "";
  let activeToken = "";
  let activePath = "/";
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
      "實際讀取 " + formatBytes(stats.bytesFetched || 0),
      "讀取上限 " + formatBytes(stats.maxTransferBytes || 0)
    ].join("　·　");

    metadataPreview.append(heading, layout, lyrics, footer);
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
        "PASS：音訊標籤解析完成。\nRange 請求：" + (stats.rangeRequests || 0) +
        " 次；實際讀取：" + formatBytes(stats.bytesFetched || 0) +
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

        actions.append(rangeButton, metadataButton);
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
  tokenInput.addEventListener("input", () => {
    // Keep credentials only in this page's JavaScript/DOM memory. Never persist them.
    activeToken = tokenInput.value;
  });

  showView("music");
})();
