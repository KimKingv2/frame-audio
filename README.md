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
Music 曲庫使用 Cloudflare D1 保存曲目資料與索引進度，R2 保存以 SHA-256 去重的封面；原始音訊仍留在 OpenList。

網頁索引採使用者手動啟動的遞迴小批次方式：
- 每批最多新增／更新 10 首，並設有項目數、資料夾數與執行時間上限。
- 每批進度寫入 D1，重新連接後可從上次游標續作。
- 以路徑、檔案大小及修改時間跳過未變更曲目。
- 失敗項目會留下最近錯誤記錄；部分或失敗掃描不會刪除既有曲目。
- 只讀取必要的 HTTP Range 區段；音訊本體不會上傳到 Cloudflare。
- Podcast 目錄不會因 Music 根目錄掃描而納入索引。

設定與測試方式見 [docs/CLOUDFLARE-STORAGE.md](docs/CLOUDFLARE-STORAGE.md)。

## Cloudflare Pages
- Repository：KimKingv2/frame-audio
- Production branch：main
- Preview branch：cf-preview
- Root directory：留空
- Build command：留空
- Build output directory：pages

目前只配置並測試 Preview。Production 綁定與 Secret 保持不變。
