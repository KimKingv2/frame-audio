const PARSER_URL = "https://esm.sh/music-metadata@12.3.5?bundle";
const CHUNK_SIZE = 64 * 1024;
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

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
    parserPromise = import(PARSER_URL).then((module) => {
      if (typeof module.parseFromTokenizer !== "function") {
        throw new Error("music-metadata 載入成功，但找不到 parseFromTokenizer API。");
      }
      return module;
    }).catch((error) => {
      parserPromise = null;
      throw new Error(
        "無法載入 music-metadata 瀏覽器解析器。請確認目前網路可存取 esm.sh CDN。"
      );
    });
  }
  return parserPromise;
}

class OpenListRangeTokenizer {
  constructor({ url, size, mimeType, maxTransferBytes = MAX_TRANSFER_BYTES }) {
    this.fileInfo = { url: "OpenList audio", size, mimeType };
    this.position = 0;
    this.url = url;
    this.chunkSize = CHUNK_SIZE;
    this.maxTransferBytes = maxTransferBytes;
    this.bytesFetched = 0;
    this.rangeRequests = 0;
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
      const controller = new AbortController();
      this.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const end = start + expectedLength - 1;
        const response = await fetch(this.url, {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          redirect: "follow",
          headers: { Range: `bytes=${start}-${end}` },
          signal: controller.signal
        });

        if (response.status !== 206) {
          const finalUrl = response.url || this.url;
          let finalHost = "無法判定";
          try { finalHost = new URL(finalUrl).hostname; } catch {}
          const contentRange = response.headers.get("content-range") || "未提供／未暴露";
          try { await response.body?.cancel(); } catch {}
          throw new Error(
            (response.status === 200
              ? "音訊來源忽略 Range"
              : "音訊來源 Range 請求失敗") +
            `（HTTP ${response.status}）。要求位元組範圍：${start}-${end}；來源主機：${finalHost}；Content-Range：${contentRange}。此前已成功讀取：${this.bytesFetched} bytes（${this.rangeRequests} 次 Range）。為避免下載整個檔案，解析已停止。`
          );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength < expectedLength) {
          throw new Error(
            `Range 回應長度不足：預期 ${expectedLength} bytes，實際 ${bytes.byteLength} bytes。`
          );
        }
        if (bytes.byteLength > expectedLength) {
          throw new Error("Range 回應超出要求長度，為避免非預期下載，解析已停止。");
        }
        this.rangeRequests += 1;
        this.bytesFetched += bytes.byteLength;
        return bytes;
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("音訊 Range 請求逾時。");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        this.controllers.delete(controller);
      }
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
      bytesFetched: this.bytesFetched,
      maxTransferBytes: this.maxTransferBytes
    };
  }
}

function mimeForPath(path) {
  const extension = String(path).split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXTENSION[extension] || undefined;
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

export async function inspectAudioMetadata({ rawUrl, baseUrl, path, fileSize }) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("OpenList 沒有提供有效的音訊檔案大小。");
  }
  if (!rawUrl) throw new Error("OpenList 沒有提供音訊來源網址。");

  const parser = await loadParser();
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
    mimeType: mimeForPath(path)
  });

  try {
    const metadata = await parser.parseFromTokenizer(tokenizer, {
      duration: false,
      skipCovers: false
    });
    return {
      metadata: {
        common: metadata.common || {},
        format: metadata.format || {},
        tagTypes: metadata.format?.tagTypes || []
      },
      stats: tokenizer.getStats()
    };
  } finally {
    await tokenizer.close();
  }
}
