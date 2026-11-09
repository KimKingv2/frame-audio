# FRAME Audio

FRAME Audio 是以 OpenList 為音訊來源的私人音訊平台，分為 **Music** 與 **Podcasts**，共用播放核心、OpenList 存取層與資產快取。

## 原則
- 原始音訊留在 OpenList，不搬移、不修改。
- Music 與 Podcasts 使用獨立索引及業務資料。
- 共用音訊播放、串流、快取及安全處理。
- 正常開啟網站不掃描音樂庫；索引更新由使用者在 Mac 手動啟動。
- 私人索引、封面、歌詞、播放進度、Token、SQLite 與音訊檔案不提交到 Git。

## 目錄
- pages/：Cloudflare Pages 靜態網站輸出。
- indexer/：Mac 本機手動執行的唯讀索引器。
- schemas/：Music / Podcasts JSON 資料契約。
- docs/：架構與實作決策。

## 索引器
索引器預設只處理 20 首歌曲，使用最多 64 KiB HTTP Range 讀取標籤，每首上限 16 MiB，且不超過檔案大小的 40%；若來源忽略 Range 並回傳 HTTP 200，會取消請求，不會下載完整檔案。索引結果、SQLite 與封面只寫入本機 private-export/。

安裝及使用方式見 indexer/README.md。完整曲庫掃描必須由使用者明確指定 scan-music --full，不會自動執行。

## Cloudflare Pages
- Repository：KimKingv2/frame-audio
- Production branch：main
- Preview branch：cf-preview
- Root directory：留空
- Build command：留空
- Build output directory：pages

Cloudflare Pages 只負責靜態網站；私有音樂索引不會放進公開 Git 倉庫。
