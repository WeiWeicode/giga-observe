# Bug 修改紀錄

> 每次修 bug 都要留一筆。格式見 [AGENT.md](../../AGENT.md) §10。

---

## 紀錄格式

```markdown
## YYYY-MM-DD｜一句話標題

**問題**：發生什麼事
**原因**：為什麼會這樣
**修改**：改了哪些檔案的哪些地方
**驗證**：怎麼確認修好了（跑了哪個測試 / 哪個 Gherkin 場景）
**影響範圍**：是否影響已接入的服務
```

---

## 2026-09-18｜平台端遮蔽漏掉 `api_key` 欄位（資安）

**問題**：以 `api_key` 為欄位名的敏感值沒有被平台端遮蔽，會以明文寫進資料庫。

**原因**：`isSensitiveKey()` 正規化 key 時只去掉連字號（`replace(/-/g,'')`），沒去掉底線。`api_key` 正規化後仍是 `api_key`，比對樣式 `apikey` 失敗。SDK 端的同名函式有去掉底線，所以走 SDK 的服務不受影響 —— 但平台端這道遮蔽存在的意義，正是為了那些不用 SDK、直接 curl 回報的服務，漏遮等於這層防護對它們失效。

**修改**：[backend/src/utils/mask.js](../../backend/src/utils/mask.js) 的 `isSensitiveKey()` 改為 key 與樣式兩邊都以 `replace(/[-_]/g,'')` 正規化。

**驗證**
- 新增 `tests/mask.test.js`，以 `test.each` 涵蓋 8 個敏感欄位名 + 大小寫變體（這個 bug 就是這組測試抓到的）
- 實機驗證：直接 curl 回報含 `api_key` / `apiKey` / `x_secret` 的 body，三者在 Mongo 中皆為 `***`，`normal` 欄位保持原值

**影響範圍**：修正前寫入的紀錄若含 `api_key` 欄位仍是明文，7 天後隨 TTL 自動清除；`error_logs` 中若有則需人工確認。目前實測資料中沒有這類紀錄。

---

## 2026-09-18｜SDK 的 `pathTemplate` 讓不同端點的 401 被聚合成同一組

**問題**：錯誤頁上出現一組「路徑 `/`、401、4 次」的聚合結果，實際上是 `/api/v1/meta`、`/api/v1/tags` 等不同端點。

**原因**：SDK 取 `pathTemplate` 時，`req.route` 不存在就退回 `req.path`。但請求被認證中介層擋下時根本沒進到 route handler，`req.route` 必然是 undefined；而在 `app.use()` 掛載的 router 內，Express 已把 `req.url` 去掉 baseUrl，`req.path` 變成 `/`。結果所有被擋下的請求聚合鍵都相同。

**修改**：[backend/sdk/index.js](../../backend/sdk/index.js) 的 fallback 改用 `req.originalUrl.split('?')[0]`（與 `request.path` 同一來源），並同步到 GigaKS 的 `src/lib/devopsReporter.js`。

**驗證**：重新對 GigaKS 打 `/api/v1/meta`、`/api/v1/tags`、`/api/v1/directories`，錯誤頁聚合為 3 組各自獨立，不再併成 `/`。對應 `error-tracking.feature` 的「聚合以 pathTemplate 而非實際路徑分組」場景。

**影響範圍**：已接入的 GigaKS 需更新 SDK（已完成）。修正前的舊資料仍是 `/`，7 天後隨 TTL 清除。

---

## 2026-09-18｜後端在 Mongo 晚啟動時永久放棄連線

**問題**：首次 `docker compose up` 時後端記錄 `MongoDB 連線失敗`，之後即使 Mongo 就緒也不會再連，所有紀錄只進 Redis。

**原因**：Mongo 容器首次建立 WiredTiger 花了約 7.8 秒，後端在 5 秒逾時後失敗，而當時只試一次就放行啟動，沒有任何重連機制。設計上說「Mongo 回來後補寫佇列」，但沒有東西會讓它回來。

**修改**
- [backend/src/config/mongo.js](../../backend/src/config/mongo.js) 新增 `startReconnectLoop()`，每 10 秒重試並在成功後重建索引與拓樸
- [backend/src/index.js](../../backend/src/index.js) 啟動時改為重試 6 次（每次間隔 5 秒），之後交給背景重連

**驗證**：重新 `docker compose up` 後後端正常連上 Mongo、建立 15 個索引；`/health` 回報 `mongo.ok=true`、待補佇列 0。

**影響範圍**：無（平台自身問題，被監控服務不受影響）

---

## 2026-09-18｜Redis 查詢路徑漏掉錯誤紀錄

**問題**：查詢某服務的紀錄且未指定 `level` 時，結果只有一般紀錄，錯誤紀錄完全不出現。

**原因**：`queryRedis()` 以三元運算決定要讀哪個 list —— `level === 'error'` 讀 `err:`，否則讀 `log:`。但「未指定 level」代表要兩者都拿，卻落進了「只讀 `log:`」的分支。走 Mongo 的查詢沒有這個問題，所以只在近 24 小時的快查路徑上發生。

**修改**：[backend/src/services/queryService.js](../../backend/src/services/queryService.js) 的 `queryRedis()` 改為未指定 level 時讀取兩個 list 並依時間合併排序。

**驗證**：查詢 gigaks-backend 不帶 level，回傳 4 筆含 500 錯誤那筆，時間由新到舊正確排序，`X-Data-Source: redis`。

**影響範圍**：無

---

## 2026-09-18｜Redis 摘要的 `id` 與 Mongo 寫入有競態

**問題**：Redis 中的紀錄摘要與 SSE error 事件的 `logId` 可能為 `null`，導致點擊列表無法開啟明細。

**原因**：`_id` 原本依賴 `insertMany()` 回填，但 Mongo 寫入與 Redis 寫入是 `Promise.all` 並行的，Redis 這邊可能在 `_id` 產生前就序列化了。

**修改**：[backend/src/services/ingestService.js](../../backend/src/services/ingestService.js) 的 `normalize()` 改為寫入前就以 `new ObjectId()` 配發 `_id`。

**驗證**：查詢結果每筆都有 `id`，SSE error 事件帶出的 `logId` 可正常開啟明細。

**影響範圍**：無

---

## 2026-09-18｜備份只 dump 到最後一個指定的 collection

**問題**：`backup.sh` 列了 5 個 `--collection`，實際備份檔只有 `topology` 一個 collection 的 17 筆資料 —— 但腳本回報成功。這是最危險的一種失敗：看起來有備份，真要還原時才發現沒有。

**原因**：`mongodump` 的 `--collection` 只吃最後一個值，重複指定不會累加也不會報錯。

**修改**：[backup/backup.sh](../../backup/backup.sh) 改用 `--excludeCollection=api_logs --excludeCollection=heartbeats`（這兩個是 7 天暫存資料），備份整個 DB 的其餘部分。這個寫法的額外好處是日後新增 collection 會自動納入備份，不會被漏掉。

**驗證**：重跑備份，dump 出 `error_logs`、`services`、`api_keys`、`service_status`、`topology` 五個 collection；還原到臨時 DB 後筆數全部相符，`api_logs` 為 0 筆（正確排除）。對應 `retention-backup.feature` 的備份與還原場景。

**影響範圍**：無

---

## 2026-09-18｜備份容器沒有 curl，狀態回報全部靜默失敗

**問題**：備份執行成功，但架構圖上 `devopsdiagram-backup` 節點一直是灰色的 `unknown`，也查不到任何 job 紀錄。

**原因**：`mongo:7` 映像沒有內建 `curl`，而 `report()` 與 `heartbeat()` 都靠 curl 發送。腳本裡 curl 的輸出導到 `/dev/null`，失敗完全無聲。

**修改**：[backup/Dockerfile](../../backup/Dockerfile) 加裝 curl。

**驗證**：手動觸發備份後，平台收到一筆 `kind=job` 的 `dailyBackup` 紀錄（200、69ms），節點轉為 healthy。

**影響範圍**：無

---

## 2026-09-18｜`trust proxy: true` 讓 IP 白名單可被偽造繞過（資安）

**問題**：5132 / 5133 直接對外，前面沒有反向代理，但 Express 設了 `trust proxy: true`。這表示 `req.ip` 會採信請求自帶的 `X-Forwarded-For` —— 任何人只要送 `X-Forwarded-For: 10.10.112.13` 就能通過 `ipAllowlist`。

**原因**：`trust proxy` 是照慣例加上去的，沒有對應到實際部署拓樸。這個設定只有在請求真的經過可信任的反向代理時才正確。

**修改**
- [backend/src/config/env.js](../../backend/src/config/env.js) 新增 `TRUST_PROXY`（預設 `false`）與 `CORS_ORIGINS`
- [backend/src/index.js](../../backend/src/index.js) 改用 `env.trustProxy`，CORS 也改為可限制來源

**驗證**：暫時設 `ALLOWED_QUERY_IPS=10.10.112.13` 後實測 —— 一般查詢回 403，帶偽造 `X-Forwarded-For` 仍回 403，Ingest 端點不受影響仍回 202。

**影響範圍**：無（本機 `ALLOWED_QUERY_IPS` 一直留空，此漏洞尚未在任何環境被利用）

**附帶發現**：測試中發現後端看到的來源 IP 是 Docker 橋接閘道 `172.20.0.1` 而非真實客戶端 IP。這表示在 Docker Desktop 環境下 `ALLOWED_QUERY_IPS` 無法分辨客戶端，生產若直接填 `10.10.112.13` 會導致全部 403。已寫入 [DEPLOYMENT.md](../DEPLOYMENT.md) §0.1 與 §6，並提供主機防火牆的替代做法。

---

## 2026-09-18｜SDK 在 ORM 物件上阻塞 event loop 造成生產延遲 1~3 秒（嚴重）

**問題**：GigaKS 上線接入後，使用者點擊知識庫文章時**間歇性延遲 1~3 秒**。GigaKS 日誌持續出現：

```
[devops-reporter] 組裝紀錄失敗： Converting circular structure to JSON
    --> starting at object with constructor 'Object'
    |     property 'parent' -> object with constructor 'Object'
    --- property 'through' closes the circle
```

**原因**：文章 API 回傳的是帶 `include` 關聯的 Sequelize 實例（`res.json({ data: article })`，關聯含 `Tags`（belongsToMany，有 `through`）與 `Directory`（有 `parent`））。

Express 的 `res.json` 序列化時會走每個實例的 `toJSON()`，拿到的是乾淨的 `dataValues`，**永遠看不到內部循環參考**。但 SDK 的 `maskDeep()` 是直接列舉屬性做深拷貝，**繞過了 `toJSON()`**，於是把 `dataValues`、`_previousDataValues` 與關聯物件互指的 `parent` / `through` 全挖了出來。

循環參考讓同一批物件被不同路徑重複走訪，成本呈指數成長；最後 `JSON.stringify` 再拋出例外。實測（模擬相同結構）：

| 文章的關聯數量 | 修正前 | 修正後 |
|---|---|---|
| 1 標籤 × 1 編輯者 | 7.6 ms | 0.3 ms |
| 5 標籤 × 3 編輯者 | 208 ms | 0.1 ms |
| 10 標籤 × 5 編輯者 | 1628 ms | 0.0 ms |
| 12 標籤 × 6 編輯者 | **3144 ms** | 0.0 ms |

這段跑在 `res.on('finish')` 裡是**同步**的。雖然當下那個請求的回應已經送出，但它**卡住整個 event loop**，導致後續與併發的請求全部被延遲 —— 這正是使用者感受到的 1~3 秒。

**這直接違反 AGENT.md §9.5「SDK 絕不阻塞原服務」。** 當初只想到「不做網路等待」，沒想到 CPU 密集的深拷貝同樣會阻塞，而且是在別人的正式環境裡。

**修改**：`maskDeep()` 加三道保護（[backend/sdk/index.js](../../backend/sdk/index.js) 與 [backend/src/utils/mask.js](../../backend/src/utils/mask.js) 兩邊同步）

1. **先呼叫 `toJSON()`** —— 有 `toJSON` 的物件（Sequelize model、Date、Mongoose document）先轉成純資料，從根本上避免挖出 ORM 內部結構
2. **循環參考偵測（WeakSet）** —— 遇到已走訪過的物件回傳 `'[circular]'`，杜絕指數成長
3. **節點預算（5000）** —— 就算結構不循環但極深極寬，成本也有天花板

另外把序列化路徑全面加固，任何情況都不拋例外：
- [backend/sdk/index.js](../../backend/sdk/index.js) 新增 `safeStringify()`，`sizeOf()` 與 `prepareBody()` 改用它；無法序列化時 body 記為 `'[unserializable]'`，**但紀錄本身仍會產生**
- [backend/src/utils/truncate.js](../../backend/src/utils/truncate.js) 平台端同樣處理（有服務直接 curl 回報，不能假設一定可序列化）

**驗證**
- 新增 8 項回歸測試於 `tests/mask.test.js`、5 項於 `tests/sdk.test.js`，涵蓋 toJSON 優先、循環標記、結果必定可序列化、成本上限（事故形狀須 < 100ms）、節點預算截斷
- 重跑事故重現腳本：3144 ms → **0.0 ms**
- 本機重建 GigaKS 後，日誌不再出現任何 `devops-reporter` 錯誤

**影響範圍**：**生產環境的 GigaSolarKnowledgeBase 使用者受到實際影響**（文章頁面間歇延遲 1~3 秒）。修正需同步 SDK 檔案並重建該服務容器，見 [SdkCorrection.md](./SdkCorrection.md)。

**檢討**：兩個測試盲點

1. 所有 SDK 測試都用**純物件**當 body，從沒測過帶 `toJSON` 的 ORM 實例 —— 而那是真實服務最常見的回應型態
2. 既有的「組裝紀錄時發生例外不往外拋」測試，實際上是因為假的 `req` 少了 `get()` 方法而通過的，**驗到的根本不是循環結構**。這次一併修正，並補上真正驗證循環結構仍能產生紀錄的測試

---

## 2026-09-18｜`.env.example` 缺少備份回報的設定，導致生產備份節點永遠灰色

**問題**：生產環境的「備份排程」節點長時間顯示「尚未回報」，版本、最後心跳、最後探測成功全部是 `—`。

**原因**：`backend/.env.example` 只有 `BACKUP_CRON_HOUR` / `BACKUP_KEEP` / `BACKUP_DIR` 三個備份相關變數，**沒有 `BACKUP_API_KEY` 與 `BACKUP_REPORT_ENDPOINT`**。

生產的 `.env` 是照 `.env.example` 建立的，所以這兩個變數根本不存在。`backup.sh` 的 `heartbeat()` 與 `report()` 開頭都是 `[ -z "$REPORT_KEY" ] && return 0`，於是備份照常執行、卻完全不回報 —— 備份成功沒人知道，**備份失敗也沒有任何地方看得到**。

[DEPLOYMENT.md](../DEPLOYMENT.md) §5 其實有寫要補這兩個變數，但因為 `.env.example` 裡沒有對應的欄位，照著範本建檔的人很容易整段漏掉。

**修改**：[backend/.env.example](../../backend/.env.example) 補上 `BACKUP_API_KEY=`（空值）與 `BACKUP_REPORT_ENDPOINT`，並附上產生 Key 的指令與「留空會怎樣」的說明。

**驗證**：本機 `.env` 本來就有這兩個變數，備份節點狀態正常，今日 03:00 的排程備份也自動執行成功（8.0K）。

**影響範圍**：生產需補上這兩個變數並重新建立 `dvd-backup` 容器。備份資料本身不受影響 —— 只是狀態沒有回報。

**檢討**：這類「留空就靜默停用」的設計（SDK 的 `DEVOPS_API_KEY` 也是同樣模式）對服務可用性是對的，但代價是設定漏了不會有人發現。範本檔必須把所有會影響可觀測性的變數都列出來，即使值是空的。

---

## 2026-09-18｜`topology.json` 是烤進映像的，reload 永遠讀到舊檔

**問題**：修改 `backend/config/topology.json` 後呼叫 `POST /api/v1/admin/topology/reload`，回應顯示成功但服務數沒變 —— 新增的節點不會出現。

**原因**：後端 Dockerfile 用 `COPY . .`，`topology.json` 在 build 時就被烤進映像。`reload` 是重讀容器內的檔案，而容器內那份永遠是建置當下的版本，跟宿主機上被編輯的那份無關。

[ARCHITECTURE.md](../ARCHITECTURE.md) §10 寫著「修改後呼叫 reload 重載，**不需重啟容器**」—— 這句話在沒有掛載設定目錄的情況下是錯的，實際上必須重建映像。

**修改**
- [docker-compose.yml](../../docker-compose.yml) 的 `dvd-backend` 加上 `./backend/config:/usr/src/app/config` 掛載
- [ARCHITECTURE.md](../ARCHITECTURE.md) §2.2 的 compose 骨架與 §10 補上這個前提與「沒掛載會怎樣」的說明

選擇掛載而非改文件，是因為拓樸本來就是會經常變動的東西（每接入一個服務就要改），「改完 reload 即可」才是這個功能該有的樣子。

**驗證**：新增 MES 三個節點後，**不重建映像**、僅 `docker compose up -d dvd-backend` 重新建立容器再 reload，回報從 15 服務變成 18 服務、17 連線變成 20 連線，節點正確出現。

**影響範圍**：生產需重新建立 `dvd-backend` 容器一次（讓掛載生效），之後改拓樸就不用再碰容器了。
