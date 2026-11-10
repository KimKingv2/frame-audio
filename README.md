# FRAME Audio

FRAME Audio 是以 OpenList 為音訊來源的私人音訊平台，分為 **Music** 與 **Podcasts**，共用播放核心、OpenList 存取層與資產快取。

## 原則
- 原始音訊留在 OpenList，不搬移、不修改。
- Music 與 Podcasts 使用獨立索引及業務資料。
- 共用音訊播放、串流、快取及安全處理。
- 正常開啟網站不掃描音樂庫；索引只會在使用者明確啟動後執行。
- 私人索引、封面、歌詞、播放進度、Token、SQLite 與音訊檔案不提交到 Git。

## 目錄
- pages/：Cloudflare Pages 靜態網站。
- functions/：Cloudflare Pages Functions，同源 API。
- migrations/：D1 資料表結構。
- indexer/：獨立的 Mac 本機唯讀索引器原型。
- schemas/：Music / Podcasts JSON 資料契約。
- docs/：架構與實作決策。

## Cloudflare 儲存與網頁索引
Music 曲庫使用 Cloudflare D1 保存曲目資料與索引進度，R2 保存以 SHA-256 去重的封面；原始音訊仍留在 OpenList。Podcast 使用獨立的節目／單集資料表、掃描進度與失敗佇列，不會混入 Music 曲庫。

網頁索引由使用者手動啟動，遞迴掃描指定目錄樹：
- 每批最長 7,500 秒（2 小時 5 分鐘），上限為 500 首新增／更新、500 個目錄項目及 500 個完成資料夾。
- 單首索引最多嘗試 20 次；每次失敗會重新取得檔案資訊並重新讀取 metadata。驗證或權限錯誤會立即停止。
- 每批進度寫入 D1，重新連接後可從上次游標續作。
- 以路徑、檔案大小及修改時間跳過未變更曲目。
- 整個目錄樹掃描完成後，伺服器會依照已掃描的資料夾路徑與 D1 曲目資料建立資料夾階層、子資料夾關係及歌曲關聯。
- 部分或失敗掃描不會刪除既有曲目或資料夾；原始音訊只透過 HTTP Range 讀取必要區段，不會上傳到 Cloudflare。
- Podcast 掃描使用獨立入口，固定根目錄為 `/中國移動雲盤/Kim King/13 喜马拉雅`；第一層每個資料夾就是一個節目，其下所有子資料夾中的音訊檔都是該節目的單集。
- Podcast 以獨立 D1 資料表保存節目與單集，並使用 `podcast_scan_`、`podcast_retry_` 狀態前綴。Music 與 Podcast 不共用失敗重試佇列。
- 第一次使用 Podcast 掃描前，需在 Cloudflare D1 執行 `migrations/0002_podcasts.sql`。儲存測試會顯示 Podcast 資料表是否已初始化。

設定與測試方式見 [docs/CLOUDFLARE-STORAGE.md](docs/CLOUDFLARE-STORAGE.md)。

## Cloudflare Pages
- Repository：KimKingv2/frame-audio
- Production branch：main
- Preview branch：cf-preview
- Root directory：留空
- Build command：留空
- Build output directory：pages

目前只配置並測試 Preview。Production 綁定與 Secret 保持不變。
