import { openListNetworkFetchOptions } from "./openlist-client.js?v=20261112-multi-openlist2";

const PARSER_URL = "https://esm.sh/music-metadata@12.3.5?bundle";
const CHUNK_SIZE = 256 * 1024;
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const PARSER_LOAD_TIMEOUT_MS = 30000;
const MAX_METADATA_DURATION_MS = 90000;
const MAX_RANGE_RETRIES = 2;
const RETRY_DELAY_MS = 700;

function emitLog(onEvent, message, level = "info") {
  try { onEvent?.({ message, level }); } catch {}
}

const MIME_BY_EXTENSION = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  wave: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  ape: "audio/ape",
  wma: "audio/x-ms-wma",
  dsf: "audio/dsf",
  dff: "audio/dff"
};

let parserPromise;

async function loadParser() {
  if (!parserPromise) {
    let timeoutId;
    const modulePromise = import(PARSER_URL).then((module) => {
      if (typeof module.parseFromTokenizer !== "function") {
        throw new Error("music-metadata 載入成功，但找不到 parseFromTokenizer API。");
      }
      return module;
    });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(
        "music-metadata CDN 載入超過 30 秒，已停止等待。請稍後重試或檢查目前網路是否能連接 esm.sh。"
      )), PARSER_LOAD_TIMEOUT_MS);
    });
    parserPromise = Promise.race([modulePromise, timeoutPromise])
      .catch((error) => {
        parserPromise = null;
        throw error;
      })
      .finally(() => clearTimeout(timeoutId));
  }
  return parserPromise;
}

class OpenListRangeTokenizer {
  constructor({
    url,
    size,
    mimeType,
    maxTransferBytes = MAX_TRANSFER_BYTES,
    maxDurationMs = MAX_METADATA_DURATION_MS,
    onEvent
  }) {
    this.fileInfo = { url: "OpenList audio", size, mimeType };
    this.position = 0;
    this.startedAt = performance.now();
    this.maxDurationMs = maxDurationMs;
    this.onEvent = onEvent;
    this.url = url;
    this.chunkSize = CHUNK_SIZE;
    this.maxTransferBytes = maxTransferBytes;
    this.bytesFetched = 0;
    this.rangeRequests = 0;
    this.requestAttempts = 0;
    this.retryCount = 0;
    this.redirectedRequests = 0;
    this.initialHost = (() => { try { return new URL(url).hostname; } catch { return "unknown"; } })();
    this.finalHost = this.initialHost;
    this.lastRequestMs = 0;
    this.lastRequestRange = "";
    this.totalRequestMs = 0;
    this.slowestRequestMs = 0;
    this.cache = new Map();
    this.controllers = new Set();
    this.closed = false;
  }

  supportsRandomAccess() {
    return true;
  }

  setPosition(position) {
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new RangeError("Tokenizer position must be a non-negative safe integer.");
    }
    this.position = position;
  }

  async getChunk(start) {
    if (this.closed) throw new Error("Metadata tokenizer 已關閉。");
    if (this.cache.has(start)) return this.cache.get(start);

    const expectedLength = Math.min(this.chunkSize, this.fileInfo.size - start);
    if (expectedLength <= 0) return new Uint8Array(0);
    if (this.bytesFetched + expectedLength > this.maxTransferBytes) {
      throw new Error(
        `Metadata 測試已達 ${Math.round(this.maxTransferBytes / 1048576)} MiB 讀取上限，已停止繼續讀取。`
      );
    }

    const pending = (async () => {
      const end = start + expectedLength - 1;
      let lastError;

      for (let attempt = 0; attempt <= MAX_RANGE_RETRIES; attempt += 1) {
        const remainingMs = this.maxDurationMs - (performance.now() - this.startedAt);
        if (remainingMs <= 0) {
          throw new Error(
            `單首音訊標籤解析超過 ${Math.round(this.maxDurationMs / 1000)} 秒上限，已停止讀取；此前讀取 ${this.bytesFetched} bytes、成功 ${this.rangeRequests} 次 Range。`
          );
        }
        const controller = new AbortController();
        this.controllers.add(controller);
        const timeout = setTimeout(
          () => controller.abort(),
          Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs))
        );
        const requestStartedAt = performance.now();
        let responseInfo = null;
        let attemptError = null;
        let attemptStatus = "尚未取得 HTTP 回應";
        this.requestAttempts += 1;
        const requestNumber = this.requestAttempts;
        emitLog(this.onEvent,
          "Range #" + requestNumber + " 開始；重試序號 " + (attempt + 1) +
          "/" + (MAX_RANGE_RETRIES + 1) + "；bytes=" + start + "-" + end);
        try {
          const response = await fetch(this.url, {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            redirect: "follow",
            headers: { Range: `bytes=${start}-${end}` },
            signal: controller.signal,
            ...openListNetworkFetchOptions(this.url)
          });
          let responseHost = this.initialHost;
          try { responseHost = new URL(response.url || this.url).hostname; } catch {}
          responseInfo = {
            status: response.status,
            redirected: response.redirected,
            finalHost: responseHost
          };
          attemptStatus = "HTTP " + response.status;
          this.lastRequestMs = Math.round(performance.now() - requestStartedAt);
          this.lastRequestRange = `bytes=${start}-${end}`;
          this.finalHost = responseHost;
          if (response.redirected) this.redirectedRequests += 1;

          if (response.status !== 206) {
            const finalUrl = response.url || this.url;
            let finalHost = "無法判定";
            try { finalHost = new URL(finalUrl).hostname; } catch {}
            const contentRange = response.headers.get("content-range") || "未提供／未暴露";
            try { await response.body?.cancel(); } catch {}

            const error = new Error(
              (response.status === 200
                ? "音訊來源忽略 Range"
                : "音訊來源 Range 請求失敗") +
              `（HTTP ${response.status}）。要求位元組範圍：${start}-${end}；來源主機：${finalHost}；Content-Range：${contentRange}。此前已成功讀取：${this.bytesFetched} bytes（${this.rangeRequests} 次 Range）。為避免下載整個檔案，解析已停止。`
            );
            error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
            throw error;
          }

          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength !== expectedLength) {
            const error = new Error(
              `Range 回應長度不符：要求 ${expectedLength} bytes，實際 ${bytes.byteLength} bytes。位元組範圍：${start}-${end}。`
            );
            error.retryable = bytes.byteLength < expectedLength;
            throw error;
          }

          this.rangeRequests += 1;
          this.bytesFetched += bytes.byteLength;
          attemptStatus = "HTTP 206，取得 " + bytes.byteLength + " bytes";
          return bytes;
        } catch (error) {
          attemptError = error;
          lastError = error;
          this.lastRequestMs = Math.round(performance.now() - requestStartedAt);
          this.lastRequestRange = `bytes=${start}-${end}`;
          const retryable =
            error?.name === "AbortError" ||
            error?.name === "TypeError" ||
            error?.retryable === true;

          if (!retryable || attempt >= MAX_RANGE_RETRIES || this.closed) {
            if (error?.name === "AbortError") {
              throw new Error(
                `音訊 Range 請求逾時（${REQUEST_TIMEOUT_MS / 1000} 秒）。位元組範圍：${start}-${end}；初始主機：${this.initialHost}；` +
                (responseInfo
                  ? `已收到 HTTP ${responseInfo.status}；是否重新導向：${responseInfo.redirected ? "是" : "否"}；最終主機：${responseInfo.finalHost}；`
                  : "逾時前尚未取得最終 HTTP 回應；") +
                `本次耗時：${this.lastRequestMs} ms；已自動重試 ${this.retryCount} 次。`
              );
            }
            throw error;
          }

          this.retryCount += 1;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
        } finally {
          const attemptElapsedMs = Math.round(performance.now() - requestStartedAt);
          emitLog(this.onEvent,
            "Range #" + requestNumber + " 結束；" + attemptStatus +
            (attemptError ? "；錯誤：" + (attemptError.message || attemptError) : "") +
            "；耗時 " + attemptElapsedMs + " ms",
            attemptError ? "warning" : "success");
          this.lastRequestMs = attemptElapsedMs;
          this.totalRequestMs += attemptElapsedMs;
          this.slowestRequestMs = Math.max(this.slowestRequestMs, attemptElapsedMs);
          clearTimeout(timeout);
          this.controllers.delete(controller);
        }
      }

      throw lastError || new Error("音訊 Range 請求失敗。");
    })();

    this.cache.set(start, pending);
    try {
      const bytes = await pending;
      this.cache.set(start, bytes);
      return bytes;
    } catch (error) {
      this.cache.delete(start);
      throw error;
    }
  }

  async copyBytes(target, { length = target.length, position = this.position, mayBeLess = false } = {}) {
    if (!Number.isSafeInteger(length) || length < 0 || length > target.length) {
      throw new RangeError("Tokenizer read length is invalid.");
    }
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new RangeError("Tokenizer read position is invalid.");
    }

    const available = Math.max(0, Math.min(length, this.fileInfo.size - position));
    if (!mayBeLess && available < length) {
      throw new Error("Unexpected end of audio file while reading metadata.");
    }

    let copied = 0;
    while (copied < available) {
      const absolutePosition = position + copied;
      const chunkStart = Math.floor(absolutePosition / this.chunkSize) * this.chunkSize;
      const chunk = await this.getChunk(chunkStart);
      const offset = absolutePosition - chunkStart;
      const count = Math.min(chunk.byteLength - offset, available - copied);
      if (count <= 0) throw new Error("Range chunk did not contain the requested byte position.");
      target.set(chunk.subarray(offset, offset + count), copied);
      copied += count;
    }
    return copied;
  }

  async readBuffer(target, options = {}) {
    const position = options.position ?? this.position;
    const length = options.length ?? target.length;
    const count = await this.copyBytes(target, { ...options, position, length });
    this.position = position + count;
    return count;
  }

  async peekBuffer(target, options = {}) {
    const position = options.position ?? this.position;
    const length = options.length ?? target.length;
    return this.copyBytes(target, { ...options, position, length });
  }

  async readToken(token, position = this.position) {
    const bytes = new Uint8Array(token.len);
    const count = await this.readBuffer(bytes, { position });
    if (count < token.len) throw new Error("Unexpected end of audio file while reading token.");
    return token.get(bytes, 0);
  }

  async peekToken(token, position = null, maybeless = false) {
    const bytes = new Uint8Array(token.len);
    const count = await this.peekBuffer(bytes, {
      position: position ?? this.position,
      mayBeLess: maybeless
    });
    if (count < token.len) throw new Error("Unexpected end of audio file while peeking token.");
    return token.get(bytes, 0);
  }

  async readNumber(token) {
    return this.readToken(token, this.position);
  }

  async peekNumber(token) {
    return this.peekToken(token, this.position, false);
  }

  async ignore(length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("Tokenizer ignore length is invalid.");
    }
    const ignored = Math.min(length, Math.max(0, this.fileInfo.size - this.position));
    this.position += ignored;
    return ignored;
  }

  async abort() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  async close() {
    this.closed = true;
    await this.abort();
    this.cache.clear();
  }

  getStats() {
    return {
      rangeRequests: this.rangeRequests,
      requestAttempts: this.requestAttempts,
      retryCount: this.retryCount,
      redirectedRequests: this.redirectedRequests,
      initialHost: this.initialHost,
      finalHost: this.finalHost,
      lastRequestMs: this.lastRequestMs,
      lastRequestRange: this.lastRequestRange,
      totalRequestMs: this.totalRequestMs,
      slowestRequestMs: this.slowestRequestMs,
      averageRequestMs: this.requestAttempts
        ? Math.round(this.totalRequestMs / this.requestAttempts) : 0,
      elapsedMs: Math.round(performance.now() - this.startedAt),
      bytesFetched: this.bytesFetched,
      maxTransferBytes: this.maxTransferBytes
    };
  }
}

function mimeForPath(path) {
  const extension = String(path).split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXTENSION[extension] || undefined;
}

function nativeTextValues(nativeTags, ids) {
  const wanted = new Set(ids.map(id => String(id).toUpperCase()));
  return (Array.isArray(nativeTags) ? nativeTags : [])
    .filter(tag => wanted.has(String(tag?.id || "").toUpperCase()))
    .map(tag => tag?.value)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
}


function lyricPayloadValues(value) {
  if (Array.isArray(value)) return value.flatMap(lyricPayloadValues);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!value || typeof value !== "object") return [];
  const cueList = Array.isArray(value.cues) ? value.cues :
    Array.isArray(value.syncText) ? value.syncText :
    Array.isArray(value.synchronizedText) ? value.synchronizedText : null;
  if (cueList) {
    return [{
      ...(Array.isArray(value.cues) ? { cues: cueList } :
        Array.isArray(value.syncText) ? { syncText: cueList } : { synchronizedText: cueList }),
      ...(value.timeStampFormat != null ? { timeStampFormat: value.timeStampFormat } : {}),
      ...(value.timestampFormat != null ? { timestampFormat: value.timestampFormat } : {}),
      ...(value.language ? { language: value.language } : {}),
      ...(value.descriptor ? { descriptor: value.descriptor } : {})
    }];
  }
  if (typeof value.text === "string" && value.text.trim()) return [value.text.trim()];
  if (typeof value.value === "string" && value.value.trim()) return [value.value.trim()];
  if (typeof value.lyrics === "string" && value.lyrics.trim()) return [value.lyrics.trim()];
  return [];
}
function containsTimedLyrics(value) {
  if (typeof value === "string") {
    return /(?:[\[<({]\s*(?:[0-9]{1,3}:)?[0-9]{1,3}:[0-5][0-9](?:[.,][0-9]{1,3})?\s*[\]>)}]|^\s*(?:[0-9]{1,3}:)?[0-9]{1,3}:[0-5][0-9][.,][0-9]{1,3}\s*(?:-->|[-|]|\s))/m.test(value);
  }
  if (!value || typeof value !== "object") return false;
  const cueList = Array.isArray(value.cues) ? value.cues :
    Array.isArray(value.syncText) ? value.syncText :
    Array.isArray(value.synchronizedText) ? value.synchronizedText : null;
  return Boolean(cueList?.some(cue => cue && (
    cue.timeMs != null || cue.timestampMs != null || cue.startTimeMs != null ||
    cue.timestamp != null || cue.time != null || cue.startTime != null
  )));
}
function collectNativeLyrics(metadata) {
  const candidates = [];
  for (const [tagType, tags] of Object.entries(metadata.native || {})) {
    for (const tag of (Array.isArray(tags) ? tags : [])) {
      const id = String(tag?.id || "").trim();
      if (!/LYRIC|SYLT|SLT|USLT/i.test(id)) continue;
      for (const value of lyricPayloadValues(tag?.value)) {
        candidates.push({ tagType, id, value, source: "native." + tagType + ":" + id });
      }
    }
  }
  return candidates;
}
function selectLyrics(metadata, common) {
  const nativeCandidates = collectNativeLyrics(metadata);
  const commonCandidates = lyricPayloadValues(common.lyrics).map(value => ({
    tagType: "common", id: "lyrics", value, source: "common.lyrics"
  }));
  const candidates = [...nativeCandidates, ...commonCandidates];
  const score = candidate => {
    const type = String(candidate.tagType || "").toLowerCase();
    const id = String(candidate.id || "").toUpperCase();
    const timed = containsTimedLyrics(candidate.value);
    const vorbis = type === "vorbis";
    const sylt = /^(?:SYLT|SLT)$/.test(id);
    if (timed && vorbis) return 0;
    if (timed && sylt) return 1;
    if (timed && type !== "common") return 2;
    if (timed) return 3;
    if (vorbis && /^(?:LYRICS|SYNCEDLYRICS|SYNCED_LYRICS)$/.test(id)) return 10;
    if (vorbis && /UNSYNCED/i.test(id)) return 11;
    if (type !== "common") return 12;
    return 20;
  };
  candidates.sort((a, b) => score(a) - score(b));
  const selected = candidates[0];
  const values = selected
    ? candidates.filter(candidate =>
        score(candidate) === score(selected) &&
        candidate.tagType === selected.tagType &&
        candidate.id === selected.id
      ).map(candidate => candidate.value)
    : [];
  const diagnostics = nativeCandidates.map(candidate => {
    const value = candidate.value;
    const cueList = value && typeof value === "object"
      ? (value.cues || value.syncText || value.synchronizedText) : null;
    const shape = Array.isArray(cueList)
      ? "結構化 " + cueList.length + " cues"
      : typeof value === "string" ? "文字 " + value.length + " chars" : "其他結構";
    return candidate.tagType + ":" + candidate.id + "（" + shape +
      (containsTimedLyrics(value) ? "；含時間" : "；未辨識時間") + "）";
  });
  return {
    values,
    source: selected?.source || (common.lyrics ? "common.lyrics" : "none"),
    diagnostics: diagnostics.length ? diagnostics.join("；") : "沒有讀到原生歌詞標籤"
  };
}
function joinNativeArtists(values) {
  if (values.length > 2) {
    return values.slice(0, -1).join(", ") + " & " + values[values.length - 1];
  }
  return values.join(" & ");
}

function preferFlacVorbisIdentity(metadata, path) {
  const common = { ...(metadata.common || {}) };
  if (!/\.flac$/i.test(String(path))) return common;

  const vorbis = metadata.native?.vorbis || [];
  const title = nativeTextValues(vorbis, ["TITLE"]);
  const album = nativeTextValues(vorbis, ["ALBUM"]);
  const artists = nativeTextValues(vorbis, ["ARTIST"]);
  const albumArtists = nativeTextValues(vorbis, ["ALBUMARTIST", "ALBUM ARTIST"]);

  if (title.length) common.title = title[0];
  if (album.length) common.album = album[0];
  if (artists.length) {
    common.artists = artists;
    common.artist = joinNativeArtists(artists);
  }
  if (albumArtists.length) {
    common.albumartists = albumArtists;
    common.albumartist = joinNativeArtists(albumArtists);
  }
  return common;
}

function normalizeLyrics(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.text === "string") return item.text;
    return "";
  }).filter(Boolean);
}

export async function inspectAudioMetadata({
  rawUrl,
  baseUrl,
  path,
  fileSize,
  maxDurationMs = MAX_METADATA_DURATION_MS,
  onEvent
}) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("OpenList 沒有提供有效的音訊檔案大小。");
  }
  if (!rawUrl) throw new Error("OpenList 沒有提供音訊來源網址。");

  emitLog(onEvent, "music-metadata CDN 載入開始");
  const parserLoadStartedAt = performance.now();
  const parser = await loadParser();
  const parserLoadMs = Math.round(performance.now() - parserLoadStartedAt);
  emitLog(onEvent, "music-metadata CDN 載入完成：" + parserLoadMs + " ms", "success");
  const normalizedBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalizedBase)) {
    throw new Error("OpenList 基礎網址無效，無法解析音訊來源。");
  }
  const url = new URL(String(rawUrl), normalizedBase + "/");
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("音訊來源網址協定不受支援。");
  }

  const tokenizer = new OpenListRangeTokenizer({
    url: url.href,
    size: fileSize,
    mimeType: mimeForPath(path),
    maxDurationMs,
    onEvent
  });

  try {
    let metadataPrefetchMs = 0;
    const parseStartedAt = performance.now();
    if (/\.flac$/i.test(String(path)) && fileSize > tokenizer.chunkSize) {
      const prefetchStartedAt = performance.now();
      const firstChunkStart = 0;
      const lastChunkStart = Math.floor((fileSize - 1) / tokenizer.chunkSize) * tokenizer.chunkSize;
      emitLog(onEvent,
        "FLAC 首尾 metadata 區塊並行預取開始：bytes=" + firstChunkStart +
        " 與 bytes=" + lastChunkStart + "；每區塊最多 " +
        Math.round(tokenizer.chunkSize / 1024) + " KiB");
      await Promise.all([
        tokenizer.getChunk(firstChunkStart),
        tokenizer.getChunk(lastChunkStart)
      ]);
      metadataPrefetchMs = Math.round(performance.now() - prefetchStartedAt);
      emitLog(onEvent, "FLAC 首尾 metadata 區塊並行預取完成：" + metadataPrefetchMs + " ms", "success");
    }
    emitLog(onEvent, "music-metadata parseFromTokenizer 開始");
    const metadata = await parser.parseFromTokenizer(tokenizer, {
      duration: false,
      skipCovers: false
    });
    const parseElapsedMs = Math.round(performance.now() - parseStartedAt - metadataPrefetchMs);
    const metadataReadElapsedMs = Math.round(performance.now() - parseStartedAt);
    emitLog(onEvent, "music-metadata parseFromTokenizer 完成：" + parseElapsedMs + " ms；首尾預取 " +
      metadataPrefetchMs + " ms；metadata 總耗時 " + metadataReadElapsedMs + " ms", "success");
    const common = preferFlacVorbisIdentity(metadata, path);
    const lyricSelection = selectLyrics(metadata, common);
    if (lyricSelection.values.length) common.lyrics = lyricSelection.values;
    return {
      metadata: {
        // FLAC's Vorbis Comment is the canonical in-file tag block.
        // music-metadata ranks APEv2 above Vorbis, so a stale APEv2 footer
        // can otherwise override the user's current Vorbis values.
        common,
        native: metadata.native || {},
        format: metadata.format || {},
        tagTypes: metadata.format?.tagTypes || []
      },
      lyrics: lyricSelection.values,
      lyricsSource: lyricSelection.source,
      lyricsDiagnostics: lyricSelection.diagnostics,
      stats: {
        ...tokenizer.getStats(),
        parserLoadMs,
        metadataPrefetchMs,
        parseElapsedMs,
        metadataReadElapsedMs
      }
    };
  } finally {
    await tokenizer.close();
  }
}
