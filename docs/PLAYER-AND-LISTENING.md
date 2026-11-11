# FRAME Audio · Player and listening history

## Shared player

Music tracks and Podcast episodes use one bottom-docked HTML5 audio player. A queue is created from the current track list, album, artist, folder or show. Previous / next controls move inside that queue. VPS Alist remains the single source for folder browsing, indexing, file metadata and playback URL resolution. Browser requests to `/api/openlist/list` and `/api/openlist/get` are handled server-side by Pages Functions, which read `ALIST_VPS_API_BASE_URL` and `ALIST_VPS_API_TOKEN` from the Pages environment. D1/R2 endpoints use `FRAME_AUDIO_API_ADMIN_TOKEN` injected by the Pages middleware after Cloudflare Access authentication. The browser never receives, stores, or sends either credential. There is no automatic Cloudflare playback fallback: VPS API or HTML5 media errors are surfaced to the user. The browser receives the temporary `raw_url` directly; the audio stream is not proxied or transcoded by Pages or VPS. Legacy `frame-audio-credentials-v1` localStorage entries are removed on application startup; only non-secret Music/Podcast root paths are preserved during that cleanup.

## Resume

The `listening_progress` row is keyed by `item_type + item_id`. The page periodically saves the current playback position and saves again on pause or page hide. Opening the same Podcast episode restores its last saved position when that position is not at the very end.

Podcast playback speed is stored in the same row as the episode position. Each episode can use 0.5× to 2.0× independently. Music starts at 1.0×.

## Listening events

The client creates one session ID when a new item begins. Pause / resume updates the same session. Each event records:
- item type and stable catalogue ID,
- current source path and title,
- session start time,
- accumulated active listening seconds,
- media duration when known,
- whether the session reached the end.

The report counts distinct sessions as plays. It sums active listening seconds per item. Seeking does not itself add listening time.

## Report periods

- `week`: rolling last 7 days.
- `month`: rolling last 30 days.
- `year`: rolling last 365 days.
- `all`: all events stored in D1.

Reports can switch between Music tracks and Podcast episodes and include aggregate summary cards plus per-item rows.

## Manual path repair

The Index Repair view merges the independent Music and Podcast retry queues into one table. Change the proposed path and choose **單獨重新索引**. FRAME Audio reads metadata only for that file. On success:
1. the replacement row is written to the appropriate catalogue,
2. prior listening events and resume state are linked to the replacement catalogue ID,
3. the stale path row is removed only if it existed and a replacement row was confirmed,
4. the original retry item is resolved.

If the replacement index fails, the old catalogue row, listening history and retry record remain intact.

## Player experience upgrades

- Playback modes: Sequential (default), Repeat One and Repeat All. Repeat One uses the browser media element loop; Repeat All wraps the current queue.
- Next-track preloading: when 30 seconds remain, the player resolves the next queue item's VPS Alist file information and warms a detached HTML5 Audio element with `preload="auto"`. The resolved file information is reused when Next is pressed. Browser/network policy controls how much media data is buffered, so this removes the next file-info lookup from the transition but does not guarantee that the whole next file is downloaded.
- Start position: newly selected Music tracks always begin at 0:00. Podcast episodes alone restore their last saved position and playback rate.
- Pure direct playback: every Music track and Podcast episode uses only the temporary VPS Alist `raw_url` in the native HTML5 Audio element. The browser follows the source's HTTP 302 redirects directly. Cloudflare Pages does not relay, proxy, cache or transcode audio. There is no EQ mode or same-origin audio-stream fallback.
- Synchronized lyrics: The indexer preserves timestamped Vorbis lyric fields and structured native ID3 `SYLT` cue arrays instead of flattening them into plain text. ID3 SYLT timestamp units are interpreted using the tag's `timeStampFormat`, including sub-second millisecond values. The player supports LRC timestamps, multiple inline timestamps, LRC offsets, SRT-style timestamp/body pairs, structured cue objects, and Mornye-style `v1:` / `v2:` speaker prefixes. Existing D1 rows are not rewritten automatically; use the current-track page's single-track reindex button to refresh a track. No full-library rescan is required.
- Sequential playback automatically advances through the active queue when a track ends, then stops after the final queue item. Repeat One and Repeat All retain their independent repeat behavior.
- The dock's Now Playing control toggles the full current-track page open and closed. The page slides upward when opened and downward when dismissed; reduced-motion preferences are respected. The prior library window scroll position and search filter are restored when the page is dismissed. Lyrics are displayed without a framed card background.
- Transient VPS Alist file-link failures from provider-side network timeouts, DNS failures, or connection resets are retried up to two additional times with short backoff. Authentication and other non-transient failures are not retried. Playback still uses only the original temporary `raw_url` with direct HTTP 302 behavior; there is no proxy, transcode, cache, or alternate-source fallback.
- Track rows include a direct album-detail shortcut. The dock's current-track tile opens a full Now Playing page with centered, auto-following synchronized lyrics and click-to-seek. Manual lyric scrolling pauses auto-follow; the current line is recentered after five seconds without user interaction. Auto-follow scrolls only the lyrics list, not the outer page. Album, Podcast and player transitions use lightweight motion and respect `prefers-reduced-motion`.
- Player mode and shuffle preference are stored locally. Alist tokens and Cloudflare credentials are never included in those preferences. Music file-info lookup does not request a resume row because every newly selected Music track starts at 0:00; Podcast episodes still load their saved resume position and playback rate.

- The Now Playing view is a fixed full-viewport overlay rather than an animated library-grid child, preventing transformed-parent positioning and sidebar flicker. Its opaque layered dark-violet backdrop remains visible while the lyrics column itself stays unboxed. Entry and exit motions use slower compositor-friendly transforms; the dock stays above the sheet.

## Music 第一層資料夾與 Now Playing 背景保留（2026-11-11）

- 「資料夾歌單」優先讀取 D1 的資料夾階層索引；若舊掃描未寫入部分資料夾，前端會從已索引歌曲的完整路徑補出有歌曲的第一層資料夾，不需要重新讀取或上傳原始音訊。
- 空資料夾仍以 D1 資料夾索引為準；只靠曲目路徑無法推斷沒有音訊檔的空資料夾。
- Now Playing 疊層直接掛載在 document.body 最外層，不放在曲庫容器內；原曲庫 DOM、搜尋結果和捲動位置從進場到退場都保持不動。開啟時只將詳情頁上滑覆蓋，收起時背景已在下方顯示，詳情頁向下離場後才移除疊層。
- 播放詳情頁使用自己的固定全螢幕捲動層；不再隱藏 Hero/Footer 或鎖定 body 捲動，降低上滑／下滑動畫期間的背景消失與閃爍。

## 手機歌詞水平溢位與播放頁背景寬度固定（2026-11-11）

- 移除播放頁開啟時覆寫 main 左右 padding 的規則，避免背景曲庫內容寬度隨播放頁狀態變化。
- 歌詞清單明確限制水平溢位，只保留垂直捲動；手機版高亮歌詞不再使用 scale 放大，並允許長文字換行。

## 手機播放器底欄固定與單列控制（2026-11-11）

- 手機版播放器底欄固定在視窗底部並處理 safe-area inset；不強制建立 transform / will-change / contain 合成層，避免快速捲動時底欄因合成層重繪而抖動。
- 手機版明確重設舊版響應式樣式中的絕對定位：播放控制組與上一首／播放／下一首均留在正常 Grid / Flex 排版流中，避免控制項互相覆蓋。
- 封面／曲目標題與隨機、上一首、播放／暫停、下一首、播放模式、歌詞、速度及停止控制維持同一橫列；停止按鈕在手機版恢復顯示，進度條保留在控制列下方。
- 手機版隱藏次要副標與類型文字，並保留窄螢幕下的緊湊尺寸；桌面版配置不變。


## 極簡底欄與正在播放詳情（2026-11-11）

- 一般曲庫頁底部只顯示封面、單行「歌曲名稱 · 歌手名稱」與上一首／播放暫停／下一首三個按鈕；不顯示進度條或其他播放工具。
- 點擊封面或曲目資訊進入 Now Playing 詳情頁。詳情頁採用大封面、曲目信息、置中的播放控制與獨立進度觸控區，隨機播放、播放模式、歌詞、倍速與停止等工具集中在詳情頁。
- 詳情頁開啟時，前端將既有、已綁定事件的播放控制 DOM 暫時移入詳情頁；收起時原節點回到固定底欄，不複製播放器、不新增重複 ID，也不影響 HTML5 Audio 播放狀態。
- Now Playing 保留同步歌詞自動跟隨、手動捲動暫停跟隨，以及原曲庫背景 DOM／捲動位置。


## 行動版導覽抽屜與鎖定畫面控制（2026-11-12）

- 手機版側欄收合為品牌列右側的「選單」按鈕；點擊後由左側滑出完整導覽抽屜，包含 Music、Podcast、曲目、專輯、歌手、資料夾歌單、收聽報告與索引錯誤。點選分類、點擊遮罩或按 Escape 都會收起；桌面版側欄保持原樣。
- 播放器接入 Media Session API：切歌時同步歌曲標題、歌手、專輯與 R2 封面 URL；播放／暫停同步 playbackState；進度以 setPositionState 更新 duration、position 和 playbackRate。
- 系統媒體控制註冊播放、暫停、上一首、下一首、前後跳轉、指定位置 seekto 與停止動作。瀏覽器不支援的單項動作會獨立略過，不影響頁面內 HTML5 Audio。
- 頁面 document.title 同步顯示目前歌曲與歌手，作為不支援 Media Session 的瀏覽器標題退路。
- 鎖屏 metadata、封面、進度與按鍵的最終顯示由 iOS／Safari 版本和系統媒體 UI 決定；網頁不能自行設定原生 AVAudioSession 或保證所有 iOS 背景播放情境。Cloudflare Access 保護下的封面 URL 仍需由目前登入的瀏覽器工作階段可存取。
