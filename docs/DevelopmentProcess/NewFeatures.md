# 新增功能紀錄

> 每次新增功能都要留一筆。格式見 [AGENT.md](../../AGENT.md) §10。

---

## 紀錄格式

```markdown
## YYYY-MM-DD｜功能名稱

**需求來源**：對應的 PRD 章節 / 使用者故事（US-xx）/ 決策（D-xx）
**內容**：做了什麼
**修改**：新增或改動了哪些檔案
**驗證**：對應的 Gherkin 場景 / 測試
**影響範圍**：是否需要各服務配合（例如 Ingest 格式異動）
**文件同步**：是否已更新 API_CONTRACT / DB_SCHEMA / INTEGRATION_GUIDE
```

---

## 2026-10-07｜架構圖加入 RustIt 端點管理

**需求來源**:需求方要求架構觀測顯示端點管理 API 與 Agent WebSocket(RustIt INTEGRATION-PLAN M4 之後)

**內容**:拓樸新增 `endpoint-api`(管理 API,探測 `http://endpoint-server:51240/healthz`)、`endpoint-agent`(Agent 通道 :51241,臨時 TLS 憑證不探測、以心跳判定)、`ita-sqlserver` / `ita-mongo` / `ita-redis`,與 7 條連線(`gw-bff → endpoint-api`、`gw-nginx → endpoint-agent`、兩個服務 → 三種儲存)。WebSocket 以紀錄 `method: WS`(每條連線關閉時一筆,`meta` 帶 closeCode / messages / online)與心跳 `deps` 的「WebSocket 在線 N 條」呈現,**不需改 giga-observe 程式**。

**修改**:`backend/config/topology.json`

**驗證**:主機 2 以 bundle 更新、重啟 gno-backend,載入 18 個服務、19 條連線;兩把 ingest Key 建立後,`endpoint-api` / `endpoint-agent` 皆 healthy,`endpoint-agent` 收到 `POST /agent/v1/inventory`(來源 IP 為電腦實際 IP)。

**影響範圍**:RustIt ItAgentBack(0ebf47a)、Gateway `agent.conf` 加 `X-Forwarded-For`(40d633a)

**文件同步**:OPERATIONS §4.1 Key 清單

---

## 2026-10-06｜由 DevOpsDiagram 複製改造為 giga-observe(GigaNexus W9-8)

**需求來源**:Gateway `docs/MONITORING-PLAN.md` D2、D9–D13

**內容**

| 區塊 | 產出 |
|------|------|
| 隔離 | `OBSERVE_ENV`;DB `giga_observe_{env}`、Redis 前綴 `gno-{env}`、compose 專案名與資料目錄依部署區;port 51202 / 51203;移除自帶前端 |
| 認證 | 查詢接受 Gateway BFF 的 `X-Internal-Token`(JWKS 驗證,只給 read);Key 前綴 `gno_`;新 scope `ingest-web` |
| Ingest | 紀錄可帶 `meta`(平面標籤);`kind: web`;`POST /ingest/traffic`(Nginx 每分鐘彙總,同分鐘冪等);`POST /ingest/web-events`(前端事件,僅拓樸中的前端) |
| 查詢 | `/stats/today`、`/stats/upstreams`、`/alerts`(即時計算)、`/traffic`、`/traffic/top-ips`、`/web/vitals`;紀錄可依 `traceId` 查;`GET /openapi.json` 供 Gateway 匯入 |
| 保存 | 錯誤 body 90 天後裁成 1 KB 摘要;流量與前端效能 90 天 TTL |
| 穩定性 | Redis 不可用時統計改由 Mongo 計算;Nginx 節點統計由流量彙總計算 |
| 本機 | `npm run dev:local`(記憶體 MongoDB + 示範資料) |

**修改**:`backend/src/{index,gatewayOpenapi}.js`、`backend/src/services/{traffic,web,stats,alert,retention,ingest,query,status,apiKey}Service.js`、`backend/src/routes/{ingest,query,web}.js`、`backend/src/middlewares/apiKeyAuth.js`、`backend/src/config/{env,redis}.js`、`backend/src/scripts/{initIndexes,devLocal,demoData}.js`、`backend/config/topology.json`、`docker-compose.yml`、`deploy/*.example`、`backup/backup.sh`;刪除 `frontend/`

**驗證**:jest 110 項(含記憶體 MongoDB 整合測試 7 項)通過;OpenAPI 經 BFF 解析器檢查 13 條路由無錯誤;主機 2 測試區部署後 `/health` 正常、Gateway 發佈路由版本 37、BFF / Nginx / itapp-api / 前端事件皆有資料

**影響範圍**:新回報來源(nginx-log-agent、BFF 前端事件轉送);舊系統不接入(D11)

**文件同步**:`INTEGRATION_GUIDE.md` 改寫為 GigaNexus 版;新增 `OPERATIONS.md` 維運手冊;`README.md`

---

## 2026-09-18｜M1~M3 初版實作：後端、前端、SDK、備份

**需求來源**：PRD 全部、D-01 ~ D-08、US-01 ~ US-06

**內容**

| 區塊 | 產出 |
|------|------|
| 後端 | Express（CommonJS）+ mongodb driver + ioredis，5132 API / 5133 SSE |
| 資料層 | MongoDB 8 個 collection、15 個索引、Redis `dvd:{projectId}:*` key |
| 認證 | API Key（SHA-256 雜湊儲存、Redis 快取 10 分鐘、ingest/read/admin 三級） |
| Ingest | 批次/單筆回報、錯誤分流、遮蔽截斷、待補佇列 |
| 監控 | Push 心跳 + Pull 探測雙軌、狀態判定 cron（15 秒） |
| SSE | snapshot / status / error 三種事件，連線上限 20 |
| 查詢 | 紀錄查詢（Redis 優先回落 Mongo）、錯誤聚合、總覽統計 |
| SDK | `backend/sdk/`，無外部相依，Express middleware + `reportJob()` |
| 前端 | Vue 3 + TS + Pinia + Vue Flow + dagre + Naive UI，4 個頁面 |
| 備份 | 獨立容器每日 03:00 mongodump，保留 30 份，結果回報為 job 紀錄 |

**修改**：新增 `backend/`、`frontend/`、`backup/`、`docker-compose.yml`

**驗證**
- 後端單元測試 63 項全數通過（`cd backend && npx jest`）
- 手動驗證涵蓋 `api-key.feature`、`ingest.feature`、`heartbeat.feature`、`sse-stream.feature`、`retention-backup.feature` 的主要場景
- 以 GigaSolarKnowledgeBase 完成端到端接入驗證（見 [SdkCorrection.md](./SdkCorrection.md)）
- 備份還原演練：5 個 collection 筆數全對，`api_logs` 正確排除

**影響範圍**：首次發布，無既有服務受影響

**文件同步**：實作與 API_CONTRACT / DB_SCHEMA 定義一致，未改動文件

---

## 2026-09-18｜前端 API 位址改為從瀏覽器主機推導

**需求來源**：部署便利性（非 PRD 需求）

**內容**：原本 `VITE_API_BASE` 在建置時寫死，本機與生產得各建一份 dist。改為未設定環境變數時，從 `window.location.hostname` 加 5132 / 5133 推導 —— 前端與後端必定同機部署，同一份 dist 兩邊都能用。

**修改**：[frontend/src/api/client.ts](../../frontend/src/api/client.ts) 新增 `deriveBase()`

**驗證**：本機 `localhost:5131` 正常連上 `localhost:5132`

**影響範圍**：無

**文件同步**：無需異動

---

## 2026-09-18｜M4 接入：GeneralBackend 三個服務

**需求來源**：PRD §9 首波接入對象、US-05

**內容**：依 [SERVICE_PATCHES.md](../SERVICE_PATCHES.md) §3~§5 接入 `general-backend`、`general-filebackend`、`general-smbbackend`。

**修改**（三個服務各四處，皆在 `GeneralBackend/` 底下）

| 檔案 | 異動 |
|------|------|
| `<服務>/lib/devopsReporter.js` | 新增，由 `DevOpsDiagram/backend/sdk/index.js` 複製（md5 已比對一致） |
| `<服務>/index.js` | 在 `express.json()` 之後、路由之前註冊 middleware |
| `<服務>/Dockerfile` | 補 `COPY lib/ ./lib/` |
| `<服務>/.env` | 補 `DEVOPS_ENDPOINT` / `DEVOPS_API_KEY` / `DEVOPS_SERVICE_ID` |
| `docker-compose.yml` | 三個服務各補 `extra_hosts: host.docker.internal:host-gateway` |

檔案服務與 SMB 服務另外設了 `ignorePaths`，排除靜態頁與下載端點，避免大量二進位流量灌進紀錄。

**驗證**（本機）

| 項目 | 結果 |
|------|------|
| 三個容器啟動 | ✅ 皆正常，無 `Cannot find module` |
| 心跳（版本欄位） | ✅ 三者皆回報 `1.0.0`，心跳 2~5 秒前 |
| API 紀錄 | ✅ general-backend 4 筆、filebackend 2 筆、smbbackend 1 筆 |
| `ignorePaths` | ✅ SMB 的 `/upload-test.html` 回 200 但未被記錄 |
| 架構圖 | ✅ 三個節點轉綠並顯示請求數 |

**影響範圍**：三個服務需重建容器（已完成）。生產環境需另外產生 Key 並重複相同步驟，見 [DEPLOYMENT.md](../DEPLOYMENT.md) §7 的模式。

**文件同步**：[INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) §9.1 接入進度已更新

**備註**：這三個服務都沒有 `/health` 端點，因此 `topology.json` 中 `monitor.enabled` 維持 `false`，存活判定完全依賴 Push 心跳。若日後補上 `/health`，打開探測即可多一層保險。

---

## 2026-09-18｜M4 接入：NotesAPP 後端

**需求來源**：PRD §9 首波接入對象、US-05

**內容**：依 [SERVICE_PATCHES.md](../SERVICE_PATCHES.md) §6 接入 `notesapp-backend`。

**修改**（`NotesAPP/` 底下）

| 檔案 | 異動 |
|------|------|
| `NotesAppBackend/lib/devopsReporter.js` | 新增，md5 與平台 SDK 一致 |
| `NotesAppBackend/index.js` | 第 38 行起註冊 middleware（自訂 CORS middleware 之後、`app.use('/v1/', routeRouter)` 之前） |
| `NotesAppBackend/Dockerfile` | 補 `COPY lib/ ./lib/` |
| `NotesAppBackend/.env` | 補三個 `DEVOPS_*` 變數 |
| `docker-compose.yml` | `notesappbackend` 補 `extra_hosts` |

**驗證**（本機）

| 項目 | 結果 |
|------|------|
| 容器啟動 | ✅ 正常，無 `Cannot find module` |
| 心跳 | ✅ 版本 `1.0.0`，心跳 11 秒前 |
| API 紀錄 | ✅ 4 筆（3× `/v1/` 200、1× `/v1/notexist` 404） |
| 架構圖 | ✅ 節點轉綠 |

**影響範圍**：NotesAPP 後端需重建容器（已完成）。前端 `notesapp-frontend` 是 Nginx 靜態站，**不需任何改動**，僅需平台端打開探測。

**文件同步**：[INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) §9.1 接入進度已更新

**附帶觀察**：接入過程中 GeneralBackend 三個容器被停掉，平台在 90 秒逾時後正確將它們判為 `down`（心跳 1879 秒前）—— 意外驗證了失聯偵測與 `heartbeatTimeoutSec` 的實際行為。

**備註**：`NotesAppBackend/Dockerfile` 的 `CMD` 把 pm2 process 命名為 `general-backend`（應為 `notesapp-backend`），是該專案既有的複製貼上殘留。不影響運作也與本次接入無關，未更動 —— 若要修正屬於 NotesAPP 專案自己的整理範圍。

---

## 2026-09-18｜M4 接入：BPM 後端

**需求來源**：PRD §9 首波接入對象、US-05

**內容**：依 [SERVICE_PATCHES.md](../SERVICE_PATCHES.md) §2 接入 `bpm-backend`。

**修改**（`BPM/` 底下）

| 檔案 | 異動 |
|------|------|
| `BPMbackend/lib/devopsReporter.js` | 新增，md5 與平台 SDK 一致 |
| `BPMbackend/app.js` | 第 28 行起註冊 middleware（`express.urlencoded()` 之後、`app.use('/', routeRouter)` 之前） |
| `BPMbackend/Dockerfile` | 補 `COPY ./lib ./lib` |
| `BPMbackend/.env` | 補三個 `DEVOPS_*` 變數 |
| `docker-compose.yml` | `bpmbackend` 補 `extra_hosts` |

**驗證**（本機）

| 項目 | 結果 |
|------|------|
| 容器啟動 | ✅ 正常，`Server running at http://10.10.112.13:5149/` |
| 心跳 | ✅ 版本 `1.0.0`，心跳 12 秒前 |
| API 紀錄 | ✅ 4 筆（3× `/` 200、1× `/notexist` 404） |

**影響範圍**：BPM 後端需重建容器（已完成）。BPM 的 CDN 與元件是 Nginx 靜態站，不需改動。

**⚠️ BPM 與其他服務的重要差異**：`BPMbackend/Dockerfile` 有 `COPY ./.env ./`，也就是 **`.env` 是 build 時烤進映像的**，而非其他服務用的 `env_file` 執行期注入。這表示：

- 改 `.env` 後**一定要 `--build`** 才會生效，單純 `docker compose up -d` 或 `restart` 都不會更新
- 生產更新 Key 時同樣要重建映像

**文件同步**：[INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) §9.1 接入進度已更新

---

## 2026-09-18｜M4 接入：DockerAutomatedScheduling（M4 完成）

**需求來源**：PRD §9 首波接入對象、D-08 排程服務接法

**內容**：依 [SERVICE_PATCHES.md](../SERVICE_PATCHES.md) §7 接入 `das-scheduler`，分 HTTP 與排程兩部分。

**修改**（`AutomatedSchedulingBackend/` 底下）

| 檔案 | 異動 |
|------|------|
| `src/lib/devopsReporter.js` | 新增，md5 與平台 SDK 一致 |
| `src/app.js` | 第 24 行起註冊 middleware（HTTP API 部分） |
| `src/scheduler/index.js` | 第 21 行 require、`runJob()` 內建立 `devopsJob` 並於結束時回報（排程部分） |
| `.env` | 補三個 `DEVOPS_*` 變數 |
| `docker-compose.yml` | 補 `extra_hosts` |

Dockerfile 不需改動（它用 `COPY . .`，是六個服務中唯一不用補 `COPY lib/` 的）。

**為什麼包在 `runJob()` 而不是各個 Controller**：`runJob()` 是 cron 觸發與 API 手動觸發的共同入口，包這一個函式就涵蓋現有的 2 個排程與未來在 registry 新增的所有排程，符合該檔案原本宣告的 Open/Closed 原則。

**⚠️ 回報位置的關鍵細節**：`runJob()` 的「寫入 Log 資料表」區塊裡有一個 early return —— 當 Controller 回傳 `skipLogOnSuccess` 且執行成功時會直接 `return`。因此 DevOps 回報必須放在**該區塊之前**，否則這類排程永遠不會被回報。

**驗證**（本機）

| 項目 | 結果 |
|------|------|
| 容器啟動 | ✅ DB 連線成功，載入 2 個排程任務 |
| 心跳 | ✅ 版本 `1.0.0`，心跳 16 秒前 |
| HTTP 紀錄 | ✅ `GET /api/jobs` 200、66ms；`/health` 正確被排除 |
| 排程紀錄 | ✅ 16:00:00 的 `checkBPMFileService` cron 執行被記錄為 `kind: job`、200、91ms |

排程部分是**等 cron 自然執行**驗證的，未手動觸發 —— 兩個排程都可能寄出 Email（`contractExpiry` 寄月報、`checkBPMFileService` 在節點失敗時寄告警），不應為了測試產生對外副作用。

**這次驗證剛好證明了平台的價值**：那次 `checkBPMFileService` 成功執行後，DAS 因 `skipLogOnSuccess` **跳過了寫入自家 Log 表**，但平台完整記錄了該次執行與檢查明細（`檢查完成。成功: 2/2`）。「16:00 那次檢查有沒有跑」這個問題，DAS 自己的 Log 表答不出來，平台答得出來。

**影響範圍**：DAS 需重建容器（已完成）。

**文件同步**：[INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) §9.1 接入進度已更新 —— **M4 六個後端服務全數完成**。

---

## 2026-09-18｜靜態站探測啟用 + 資料層節點的內建檢查

**需求來源**：生產畫面上有 5 個節點長期是灰色的 `unknown` —— 三個靜態站與兩個資料層元件。

**內容**

**(1) 三個靜態站打開 HTTP 探測**：`notesapp-frontend`、`bpm-component`、`bpm-cdn` 的 `monitor.enabled` 改為 `true`。這三個是 Nginx 靜態站，**零程式改動、不需 API Key**，平台每 30 秒打它們的首頁，回 2xx 即視為存活。

啟用前先實測生產的實際回應，確認四個站的 `/` 都回 200 —— 若回 403/404，打開探測會讓節點從灰色變成紅色（比原本更糟）。

**(2) 資料層元件改用內建檢查**：`dvd-mongo` 與 `dvd-redis` 沒有 HTTP 端點，原本無法被探測。新增 `monitor.type: "internal"`，直接沿用平台既有的連線 ping（與 `/health` 用的是同一組檢查）。

```jsonc
"monitor": { "enabled": true, "type": "internal", "check": "mongo" }
```

**修改**

| 檔案 | 異動 |
|------|------|
| [backend/src/services/proberService.js](../../backend/src/services/proberService.js) | 新增 `INTERNAL_CHECKS` 與 `probeInternal()`，`probeAll()` 同時跑兩種探測 |
| [backend/src/services/topologyService.js](../../backend/src/services/topologyService.js) | `getProbeTargets()` 排除 internal，新增 `getInternalTargets()` |
| [backend/config/topology.json](../../backend/config/topology.json) | 5 個服務的 `monitor` 設定 |
| `backend/tests/prober.test.js` | 新增 7 項測試 |

**驗證**

| 項目 | 結果 |
|------|------|
| 內建檢查（Mongo） | ✅ `dvd-mongo` 轉 healthy，探測成功 16 秒前 |
| 內建檢查（Redis） | ✅ `dvd-redis` 轉 healthy |
| 靜態站 HTTP 探測 | ✅ 啟動本機 `gigaks-frontend` 後 23 秒內轉 healthy，**無心跳、零程式改動** |
| 生產靜態站可探測性 | ✅ 5147 / 5148 / 5122 / 5153 的 `/` 皆回 200 |
| 單元測試 | ✅ 新增 7 項（成功/失敗/例外/未知 check/延遲記錄），整體 89 項通過 |

**影響範圍**：只動平台自身，被監控服務完全不受影響。生產需重建 `dvd-backend` 才會生效。

**設計說明**：內建檢查刻意只支援 `mongo` 與 `redis` 兩個值，且由平台自身的連線狀態決定 —— 它反映的是「平台能不能用到這個元件」，而不是「這個元件對全世界是否健康」。這與節點在圖上的意義一致（它們是平台的資料層）。

---

## 2026-09-18｜新增監控對象：MES 前後端（wei_web）

**需求來源**：使用者要求納入 `D:\檔案分享\程式碼\wei_web`

**MES 的架構與前面幾個服務不同**：後端**沒有對外開 port**，只掛在 `node_network` 上，由一個 nginx `proxy` 容器（5180）代理對外。前端（5173）打的也是 5180。因此拆成三個節點：

| 節點 | 類型 | 監控方式 |
|------|------|----------|
| `mes-frontend` | frontend / presentation | HTTP 探測 `:5173/` |
| `mes-proxy` | gateway / api | HTTP 探測 `:5180/` |
| `mes-backend` | backend / api | SDK 心跳（主要）+ 探測 `:5180/health` |

這樣分的好處是故障可區分：後端掛掉時心跳會停、proxy 仍活著（回 502）；proxy 掛掉則兩者的探測一起失敗。

**修改**（`wei_web/` 底下）

| 檔案 | 異動 |
|------|------|
| `backend/lib/devopsReporter.js` | 新增，md5 與平台 SDK 一致 |
| `backend/app.js` | 第 29 行起註冊 middleware，並**新增 `/health` 端點**（原本沒有） |
| `backend/Dockerfile` | 補 `COPY ./lib ./lib` |
| `backend/.env` | 補三個 `DEVOPS_*` 變數 |
| `docker-compose.yml` | `mesbackend` 補 `extra_hosts`（它在自訂 network 上，沒有這個打不到宿主機） |

平台端：[backend/config/topology.json](../../backend/config/topology.json) 新增 3 個節點與 3 條連線。

**驗證**
- `node --check` 通過；`topology.json` 格式正確
- 生產的 `:5173/` 與 `:5180/` 皆回 200，探測可用
- 拓樸重載成功：18 個服務、20 條連線
- 三個 MES 節點已出現在架構圖（本機無 MES 容器故為 `unknown`，屬預期）

**環境變數的相依順序**：`backend/config/env.js` 在 require 時就 `dotenv.config()`，而 `app.js` 第 5 行先 require 它、第 29 行才用 `process.env.DEVOPS_*`，順序正確。`env.js` 本身是白名單式的設定匯出，不含 DEVOPS_*，但 SDK 是直接讀 `process.env`，不受影響。

**影響範圍**：MES 後端需重建容器；前端與 proxy 不需任何改動。
