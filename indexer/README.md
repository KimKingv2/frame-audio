# FRAME Audio Indexer

Mac 本機手動執行的唯讀索引器。它會從 OpenList 讀取目錄資訊與音訊標籤，在本機建立 SQLite、JSON 目錄及封面快取；不會修改、搬移或刪除 OpenList 原始檔案。

## 安全預設

- scan-music 預設最多處理 20 首，先建立小批次樣本，不會啟動全曲庫掃描。
- 每首歌曲預設最多透過 HTTP Range 讀取 16 MiB，且不超過該檔案大小的 40%；使用最多 64 KiB 區塊，並限制記憶體快取。
- 來源若忽略 Range 並回傳 HTTP 200，索引器會取消回應，不讀取完整檔案。
- 對每首歌曲只讀取標籤需要的區段。MP4／M4A 等格式若標籤位於檔案尾端，也可能需要額外 Range。
- SQLite 以路徑為鍵，透過檔案大小、修改時間及遠端 hash 判斷是否需要重讀。
- 任何掃描都不會因為檔案暫時消失或本次掃描不完整而批次刪除資料。
- Token、SQLite、JSON、封面與歌詞只留在本機 private-export/，不提交 GitHub。

## 私人設定

1. 在專案根目錄建立私人設定目錄，複製 indexer/config.example.toml 為 config/local.toml。
2. 填入自己的 OpenList 網址與 Music／Podcasts 根目錄。
3. 把 API Token 放進設定檔指定的環境變數，不要寫進 TOML 或命令列。
4. 安裝 Python 3.11+ 與套件：

~~~bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ./indexer
~~~

## 指令

~~~bash
frame-audio-indexer check-config
frame-audio-indexer list-roots
frame-audio-indexer probe-range --path "/完整/音訊/檔案.flac" --bytes 1024
frame-audio-indexer scan-music
~~~

scan-music 預設最多處理 20 首，輸出到設定中的 output.directory：

- frame-audio.sqlite3：增量狀態與已讀取的曲目資料。
- music-catalog.json：網站端可讀取的音樂目錄。
- assets/：依 SHA-256 去重的內嵌封面。

確認小批次結果正常後，才手動執行完整掃描：

~~~bash
frame-audio-indexer scan-music --full
~~~

完整掃描仍受每首歌曲 16 MiB Range 上限保護。單檔超過上限、來源不支援 Range 或標籤格式無法解析時，該檔會記錄錯誤並繼續處理其他歌曲。

## 格式與索引行為

目前索引器使用 Mutagen 讀取常見音訊容器的標籤，優先保留標籤中的標題、歌手、專輯、專輯藝人、曲目／唱片編號、年份、類型、作曲者、內嵌歌詞及封面。缺少標題時才以檔名作為顯示名稱。

Music 目錄樹會保留資料夾階層，資料夾可在播放器端作為歌單。Podcasts 的節目、單集與收聽進度維持獨立資料模型，暫不混入 Music 索引。
