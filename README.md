# FRAME Audio

FRAME Audio 是以 VPS Alist 為音訊來源的私人音訊平台，包含 **Music** 與 **Podcasts**。兩者有獨立曲庫及掃描進度，共用播放核心、封面資產、續播與收聽統計服務。

## 產品功能

- Music：歌曲、專輯、歌手、資料夾歌單與連續播放。
- Podcasts：節目卡片、節目詳情、單集列表、播放佇列及續播。
- Podcast 播放速度：0.5× 至 2.0×，每集分別保存播放速度與續播位置。
- 收聽報告：Music / Podcasts 分開統計播放次數、實際收聽時長、收聽項目數與完整聽完次數。
- 報告期間：近 7 日、近 30 日、近 365 日、全部時間。
- 索引修復：列出 Music 與 Podcast 失敗項目，可編輯檔案路徑後單獨重新索引，不必重掃整個目錄。
- 掃描進度：獨立保存 Music / Podcast 掃描游標、重試佇列及最近錯誤，可中斷續作。

## 資料安全原則

- 原始音訊留在中國移動雲盤，透過 VPS Alist 提供目錄、索引及播放連結；不搬移、不修改，也不把完整音訊上傳到 Cloudflare。
- 瀏覽器只透過有上限的 HTTP Range 讀取 metadata 所需區段。
- Music 曲目與 Podcast 節目／單集分開保存。
- D1 以新增／更新方式寫入；部分掃描、失敗掃描與路徑修復不會清空整個曲庫。
- R2 封面以 SHA-256 去重保存。
- 修復路徑時，先成功建立新索引，再將舊路徑的收聽事件及續播資料移轉到新索引。
- VPS Alist API Token 與 FRAME Audio 內部 API 管理 Secret 只保存在 Cloudflare Pages Secrets；瀏覽器不會取得、傳送或保存 Token。所有私有 API 均由 Cloudflare Access 保護。

## Cloudflare 資料表

| Migration | 用途 |
|---|---|
| `0001_catalog.sql` | Music 曲目、資料夾、掃描進度 |
| `0002_podcasts.sql` | Podcast 節目與單集 |
| `0003_listening.sql` | 播放進度、Podcast 播放速度、收聽事件 |

三個 migration 均採新增資料表／索引方式，不包含清空既有曲庫的操作。現有 D1 資料與 R2 封面應保留。

## 掃描規則

- Music：`/中國移動雲盤/Kim King/03 Music`
- Podcast：`/中國移動雲盤/Kim King/13 喜马拉雅`
- Podcast 根目錄的第一層資料夾 = 一個節目；其下所有子資料夾中的支援音訊檔 = 單集。
- 每批最多處理 500 個目錄項目、500 個新增／更新項目或 500 個資料夾，最長 7,500 秒。
- 單個檔案最多嘗試 20 次；驗證及權限錯誤會立即停止。
- 路徑、大小及修改時間未變更時，增量掃描會跳過該項目。
- 不自動刪除來源中已不存在的曲目或單集。

- VPS Alist CORS：正式版與 Preview 的跨域來源、方法及標頭設定見 [docs/OPENLIST-CORS.md](docs/OPENLIST-CORS.md)。

## 專案結構

- `pages/`：Cloudflare Pages 靜態網站。
- `functions/`：Cloudflare Pages Functions，同源 API。
- `migrations/`：D1 資料表結構。
- `indexer/`：獨立的 Mac 本機唯讀索引器原型。
- `schemas/`：Music / Podcasts JSON 資料契約。
- `docs/`：架構、部署與產品規格。

## 部署

- GitHub Repository：`KimKingv2/frame-audio`
- Production branch：`main`
- Preview branch：`cf-preview`
- Pages Root directory：留空
- Build command：留空
- Build output directory：`pages`

正式環境與 Preview 環境應各自設定 `DB`、`ARTWORKS` bindings、`FRAME_AUDIO_API_ADMIN_TOKEN`、`ALIST_VPS_API_TOKEN` Secrets，以及 `ALIST_VPS_API_BASE_URL=https://drive.kimkingv2.top` Variable。Access 必須保護 `frame-audio.pages.dev` 與 `*.frame-audio.pages.dev`。詳細步驟見 [docs/CLOUDFLARE-STORAGE.md](docs/CLOUDFLARE-STORAGE.md)。

新增或修改環境變數及 Secret 後，必須觸發一次新的 Pages 部署，新的設定才會注入該部署。請確認 Secret 設定在正確的環境（Production 或 Preview），再重新部署對應分支。
