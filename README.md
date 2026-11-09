# FRAME Audio

FRAME Audio 是以 OpenList 為音訊來源的私人音訊平台，分為 **Music** 與 **Podcasts**，共用播放核心、OpenList 存取層與資產快取。

## 原則
- 原始音訊留在 OpenList，不搬移、不修改。
- Music 與 Podcasts 使用獨立索引及業務資料。
- 共用音訊播放、串流、快取及安全處理。
- 正常開啟網站不掃描音樂庫；索引更新由使用者手動啟動。
- 私人索引、封面、歌詞、播放進度、Token、SQLite 與音訊檔案不提交到 Git。

## 目錄
- `pages/`：Cloudflare Pages 靜態網站輸出。
- `indexer/`：之後在 Mac 上手動執行的 Python 索引器。
- `schemas/`：Music / Podcasts JSON 資料契約。
- `docs/`：架構與實作決策。

## Cloudflare Pages
- Repository：`KimKingv2/frame-audio`
- Production branch：`main`
- Preview branch：`cf-preview`
- Root directory：留空
- Build command：留空
- Build output directory：`pages`

目前為 V1 foundation。網站尚未連接私人 OpenList，也尚未啟用實際播放或索引掃描；會先用少量測試音訊驗證 OpenList API、Range 和標籤讀取，再擴充完整功能。
