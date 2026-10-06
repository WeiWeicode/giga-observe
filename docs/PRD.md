# 產品需求文件 (Product Requirements Document)

**產品名稱**：DevOpsDiagram（維運架構觀測平台）
**文件版本**：v0.2
**建立日期**：2026-09-18
**最後更新**：2026-09-18（七項關鍵決策定案，見第 12 章）
**負責人**：開發團隊
**狀態**：已定案 (Approved) — 可進入 M1

---

## 1. 背景與商業需求

### 1.1 問題陳述

公司目前已有多組獨立部署的前後端服務（BPM、GeneralBackend、GigaSolarKnowledgeBase、NotesAPP、DockerAutomatedScheduling），各自以 Docker 容器散落在不同 port 上。目前的維運方式存在三個問題：

1. **看不到全貌**：服務之間誰呼叫誰、掛掉會影響誰，只存在少數人腦中。
2. **出事才知道**：服務或容器停掉、API 持續回 500，沒有主動告警，多半由使用者回報。
3. **查錯很慢**：要進到個別容器 `docker logs` 才能看到錯誤，缺乏跨服務、可搜尋的統一紀錄。

### 1.2 商業目標

| 目標 | 說明 |
|------|------|
| **架構可視化** | 一張可互動的架構圖，點擊節點即可看到該服務的即時狀態與紀錄 |
| **縮短故障發現時間** | 心跳異常在 1 分鐘內反映在圖上（節點轉紅） |
| **縮短故障定位時間** | 從「發現異常」到「看到該服務的錯誤明細」不超過 3 次點擊 |
| **統一紀錄留存** | 一般紀錄保留 7 天、錯誤紀錄永久保存，可跨服務搜尋 |
| **低侵入接入** | 既有服務接入成本控制在「加一個 middleware + 設定 API Key」 |

### 1.3 範疇 (Scope)

**納入範疇**
- API 請求／回應紀錄的收集、儲存、查詢
- 服務心跳（heartbeat）與存活狀態判定
- 錯誤 API 清單與明細查詢
- 架構圖前端（節點狀態疊加、點擊查看紀錄）
- API Key 機制（多服務共用同一組 Mongo / Redis）
- SSE 即時狀態推播
- error_logs 每日自動備份
- 提供給各服務後端的**接入手冊**

**排除範疇（本版本不做）**
- 告警通知（Email / Teams / Line）— 列為 v2
- 分散式追蹤（trace id 串接跨服務呼叫鏈）— 列為 v2，但**資料模型先預留欄位**
- 主機層級指標（CPU / Memory / Disk）
- 使用者帳號系統（本版以 IP 白名單 + API Key 控管）
- 架構圖的線上編輯（初版以設定檔維護，沿用 ArchAtlas 做法）
- **通用資料存取 API**（讓非監控用途的專案共用這套 Mongo/Redis）— 資料模型與 API Key 先預留 `projectId` 維度，但 v1 不開放此用途，見 4.4

---

## 2. 使用者故事

### 2.1 角色定義

| 角色 | 說明 |
|------|------|
| **維運人員 (DevOps)** | 主要使用者。每天開一次總覽頁確認服務都活著；接到回報時用這個平台定位問題 |
| **後端開發者** | 兩種身分：(a) 把自己的服務接上這個平台；(b) 查自己服務的錯誤明細 |
| **平台維護者** | 維護本專案、發 API Key、維護架構圖設定檔 |

### 2.2 使用者故事清單

#### US-01：一眼看出哪個服務掛了
> **身為** 維運人員，**我希望** 打開首頁就看到架構圖上每個節點的顏色（綠=正常／黃=異常升高／紅=失聯），**以便** 我不用逐台連線就知道哪裡有問題。

**驗收條件**
- [ ] 首頁載入 3 秒內顯示所有已註冊服務的節點與當前狀態
- [ ] 心跳逾時（預設 90 秒未回報）的節點顯示為紅色
- [ ] 節點狀態經 SSE 即時推播，狀態變化後 5 秒內反映在圖上
- [ ] SSE 連線中斷時自動重連，重連期間退回輪詢，不出現長時間顯示過期狀態

#### US-02：點節點看該服務的紀錄
> **身為** 維運人員，**我希望** 點擊架構圖上的節點就跳出該服務的側邊面板，看到最近的 API 呼叫與錯誤，**以便** 我能立刻判斷是整台掛掉還是某支 API 壞掉。

**驗收條件**
- [ ] 側邊面板顯示：服務基本資料、最後心跳時間、近 1 小時請求數／錯誤數、最近 50 筆紀錄
- [ ] 面板可切換「全部紀錄 / 只看錯誤」
- [ ] 單筆紀錄可展開看到完整 request / response 內容

#### US-03：查錯誤 API 清單
> **身為** 維運人員，**我希望** 有一頁列出所有服務近期的錯誤 API，依「出現次數」或「最近發生時間」排序，**以便** 我能優先處理最常爆的那一支。

**驗收條件**
- [ ] 可依服務、時間區間、HTTP 狀態碼、路徑關鍵字篩選
- [ ] 同一支 API 的重複錯誤可聚合顯示（路徑 + 狀態碼 + 次數）
- [ ] 錯誤紀錄永久保存，可查詢一年前的資料

#### US-04：查單一 API 的請求／回應明細
> **身為** 後端開發者，**我希望** 看到某次呼叫的完整 request（method、path、query、body、headers）、後端做了什麼動作、以及 response 內容與耗時，**以便** 我能重現問題。

**驗收條件**
- [ ] 明細包含：時間、服務、method、path、status、耗時(ms)、request、response、動作紀錄(actions)
- [ ] 敏感欄位（password、token、authorization、apiKey）自動遮蔽為 `***`

#### US-05：把自己的服務接上平台
> **身為** 後端開發者，**我希望** 有一份手冊與範例程式碼，照著貼上就能開始回報，**以便** 我不用花半天研究資料格式。

**驗收條件**
- [ ] 手冊含：取得 API Key、心跳接法、API 紀錄接法、Express middleware 完整範例
- [ ] 以 GigaSolarKnowledgeBase 為首個接入對象並驗證成功

#### US-06：服務共用同一套儲存但資料互相隔離
> **身為** 平台維護者，**我希望** 每個服務用自己的 API Key 回報，且只能查自己的資料（或由平台統一查詢），**以便** 共用 Mongo / Redis 不會互相污染。

**驗收條件**
- [ ] 每筆紀錄都帶 `serviceId`，由 API Key 反查決定，不信任 client 自報
- [ ] API Key 失效或錯誤時回 401，且該次請求不落地

---

## 3. 核心功能

### 3.1 架構圖總覽（前端主畫面）

參考 `D:\檔案分享\Tools\archatlas` 的呈現方式（Vue Flow + dagre 分層佈局），在其之上疊加**即時狀態**：

- 節點 = 一個服務（前端 / 後端 / 資料庫 / 快取 / 外部系統）
- 連線 = 呼叫關係
- 節點狀態色：

  | 狀態 | 條件 | 顏色 |
  |------|------|------|
  | `healthy` | 心跳正常且近 5 分鐘錯誤率 < 5% | 綠 |
  | `degraded` | 心跳正常但近 5 分鐘錯誤率 ≥ 5% | 黃 |
  | `down` | 超過 90 秒未收到心跳 | 紅 |
  | `unknown` | 從未回報過（已在設定檔但尚未接入） | 灰 |

- 節點上直接顯示：近 1 小時請求數 / 錯誤數
- 支援縮放、平移、搜尋、依類型／狀態篩選
- 狀態由 SSE 即時推播更新（見 3.7），不需手動重整

### 3.2 服務詳情面板

點擊節點展開，分頁呈現：

1. **概況**：基本資料（名稱、類型、位址、Repo 路徑）、最後心跳、版本、uptime
2. **紀錄**：最近 API 呼叫列表（可切換全部／只看錯誤），點開看明細
3. **錯誤**：該服務的錯誤聚合清單
4. **相依**：上下游服務，以及下游是否健康

### 3.3 API 紀錄查詢頁

- 全域搜尋：服務、path、status、時間區間、關鍵字（可搜 request/response 內容）
- 分頁（cursor-based）、預設顯示最近 100 筆
- 一般紀錄查 Redis（近 24 小時，快）→ 查不到再回查 MongoDB

### 3.4 錯誤 API 頁

- 聚合視圖：`serviceId + method + path + status` 分組，顯示次數、首次／最近發生時間
- 展開看個別事件明細
- 永久保存，支援歷史回查

### 3.5 心跳與存活監控

兩種模式並行：

- **Push（主要）**：各服務每 30 秒打 `POST /api/v1/heartbeat`，帶服務狀態與自身依賴（DB 連線等）
- **Pull（補強）**：本平台每 30 秒主動打各服務的 `GET /health`，用於服務整個掛掉、連 push 都發不出來的情況

判定：兩者任一成功即視為活著；皆失敗超過 90 秒 → `down`。

### 3.6 資料收集（Ingest）

接收各服務回報的三類資料：

1. **API 請求**：method、path、query、body、headers（遮蔽後）、來源 IP
2. **API 執行動作**：後端在這支 API 中做了什麼（查了哪個 DB、呼叫了哪個外部服務、耗時）— 由開發者以 `ctx.action()` 主動記錄
3. **API 回應**：status、body（依 4.5 規則截斷）、總耗時

### 3.7 SSE 即時推播

- 後端在 5133 提供 `GET /api/v1/stream`（Server-Sent Events）
- 推播事件：

  | 事件 | 觸發時機 | Payload |
  |------|----------|---------|
  | `status` | 任一服務狀態改變（healthy ↔ degraded ↔ down） | 該服務的 serviceId 與新狀態 |
  | `error` | 收到新的錯誤紀錄 | serviceId、method、path、status、ts |
  | `snapshot` | 連線建立時、以及每 30 秒心跳幀 | 全服務狀態快照 |

- 前端以 `EventSource` 連線，斷線自動重連（指數退避，上限 30 秒）；重連期間退回 15 秒輪詢 `/api/v1/services`，確保推播失效時畫面仍會更新
- 狀態變更的判定與推播由後端單一模組負責（心跳檢查 cron + ingest 寫入時觸發），避免多處各判各的

### 3.8 排程型服務的紀錄（DockerAutomatedScheduling）

排程服務沒有 API 請求，改以「**一次排程執行 = 一筆紀錄**」沿用同一套 schema：

| 欄位 | 排程服務的對應 |
|------|----------------|
| `request` | 觸發來源（`cron` / `manual`）、job 名稱、排程表達式、觸發參數 |
| `actions` | 執行步驟（查了哪個 DB、寄了幾封信、各步驟耗時） |
| `response` | 執行結果（success / fail）、處理筆數、總耗時 |
| `error` | 失敗時的例外內容，並依 4.5 進 `error_logs` 永久保存 |

前端不另開頁面，直接重用既有的紀錄面板與錯誤頁；節點在架構圖上以 `type: devops` 呈現。

---

## 4. 資料設計

### 4.1 MongoDB（主儲存）

| Collection | 用途 | 保留策略 |
|------------|------|----------|
| `services` | 服務註冊資料（id、名稱、類型、位址、layer、repo 路徑） | 永久 |
| `api_logs` | 一般紀錄：2xx / 3xx / **4xx** 與服務自報 warn | **TTL 7 天**（`expireAt` index） |
| `error_logs` | 錯誤紀錄：HTTP ≥ 500 或服務自報 `level: error` | **永久保存，無 TTL** |
| `heartbeats` | 心跳事件流 | TTL 7 天 |
| `service_status` | 每服務最新狀態快照（1 服務 1 筆，upsert） | 永久 |
| `api_keys` | API Key（雜湊儲存）、對應 projectId / serviceId、權限、啟用狀態 | 永久 |

> 資料庫名稱固定為 `devops_diagram`，與未來其他專案的 database 分開（見 4.4）。

**關鍵索引**

- `api_logs`：`{ serviceId: 1, ts: -1 }`、`{ ts: -1 }`、`{ expireAt: 1 }`（TTL）
- `error_logs`：`{ serviceId: 1, ts: -1 }`、`{ serviceId: 1, method: 1, path: 1, status: 1 }`（聚合用）
- `service_status`：`{ serviceId: 1 }` unique
- 所有紀錄類 collection 皆以 `projectId` 為索引首欄位的複合索引預留（v1 值固定為 `devops`）

**紀錄文件結構（草案）**

```jsonc
{
  "_id": "ObjectId",
  "projectId": "devops",          // 共用儲存的隔離維度，v1 固定為 devops
  "serviceId": "gigaks-backend",
  "traceId": "uuid",              // v2 跨服務串接預留
  "ts": "2026-09-18T08:00:00.000Z",
  "level": "info | error",
  "request":  {
    "method": "POST", "path": "/api/v1/articles", "query": {},
    "body": {}, "bodySize": 2048, "bodyTruncated": false,   // 保存規則見 4.5
    "headers": {}, "ip": "10.10.112.13"
  },
  "actions":  [ { "seq": 1, "type": "db", "target": "mssql.articles", "durationMs": 12, "note": "insert" } ],
  "response": { "status": 500, "body": {}, "bodySize": 130, "bodyTruncated": false, "durationMs": 134 },
  "error":    { "name": "SequelizeConnectionError", "message": "...", "stack": "..." },
  "expireAt": "2026-09-25T08:00:00.000Z"   // 僅 api_logs 有
}
```

### 4.2 Redis（快取層）

| Key 樣式 | 型別 | 用途 | TTL |
|----------|------|------|-----|
| `dvd:{projectId}:log:{serviceId}` | List（LPUSH + LTRIM 1000） | 近期一般紀錄，供列表快查 | 1 天 |
| `dvd:{projectId}:err:{serviceId}` | List（LPUSH + LTRIM 1000） | 近期錯誤紀錄 | 1 天 |
| `dvd:{projectId}:hb:{serviceId}` | String | 最後心跳時間戳，存活判定用 | 120 秒 |
| `dvd:{projectId}:stat:{serviceId}:{yyyyMMddHH}` | Hash | 每小時計數（total / error / avgMs） | 1 天 |
| `dvd:{projectId}:status:all` | String(JSON) | 架構圖用的全服務狀態快照，SSE 也讀這份 | 60 秒 |
| `dvd:key:{hash}` | String | API Key → projectId + serviceId + 權限快取，免每次查 Mongo | 10 分鐘 |

> 命名前綴統一 `dvd:`，第二段固定為 `projectId`（v1 為 `devops`），避免與未來共用這套 Redis 的其他專案撞 key。

### 4.3 API Key 機制

- 每個接入服務發一組 Key，格式 `dvd_{projectId}_{serviceId}_{32位亂數}`
- Mongo 只存 SHA-256 雜湊，明文僅發放時顯示一次
- 傳遞方式：HTTP header `X-API-Key`
- 每組 Key 綁定 `projectId` + `serviceId` + 權限，**寫入時的 projectId / serviceId 一律由 Key 反查決定，不採信 client 自報的值**
- 權限分級：

  | 權限 | 說明 |
  |------|------|
  | `ingest` | 只能寫入自己 serviceId 的紀錄（各服務用，最小權限） |
  | `read` | 只能讀取自己 projectId 範圍內的資料（前端／查詢用） |
  | `admin` | 管理 Key 與服務註冊 |

- Key 可停用；停用後須同步刪除 `dvd:key:{hash}` 快取，使其在 10 分鐘快取期內也立即失效

### 4.4 共用儲存的隔離設計（v1 預留，不開放）

未來可能有非監控用途的專案共用這套 Mongo / Redis，因此 v1 先把隔離維度做進資料模型，避免日後改 schema：

| 項目 | v1 做法 | 未來擴充 |
|------|---------|----------|
| MongoDB | 固定使用 `devops_diagram` database | 其他專案各自一個 database，由平台依 Key 的 projectId 路由 |
| Redis | key 第二段固定 `devops` | 其他專案用自己的 projectId 前綴 |
| 資料欄位 | 每筆紀錄帶 `projectId: "devops"` | 依 Key 寫入各自的 projectId |
| API Key | 已綁 projectId，但僅接受監控類端點 | 開放通用存取端點時，沿用同一套 Key 與權限機制 |

**v1 明確不做**：通用的 document / KV 存取端點、每專案配額、自訂 schema 驗證。這些等有實際需求再開規格。

### 4.5 錯誤定義與 body 保存規則

**進 `error_logs`（永久保存）的條件**（滿足任一即是）：

- HTTP status ≥ 500
- 服務在回報時自報 `level: "error"`（用於 HTTP 200 但業務邏輯失敗的情況）
- 排程任務執行失敗

4xx 進 `api_logs`（7 天），但錯誤查詢頁可另外篩選出來查看 —— 4xx 多半是前端傳錯參數或權限不足，量大且長期價值低，不值得永久保存。

**body 保存規則**

| 情境 | request body | response body |
|------|--------------|---------------|
| 成功（非 error） | 只存**摘要**：`bodySize` + 前 1KB 內容 | 同左 |
| 錯誤（進 error_logs） | 存**完整**，超過 32KB 截斷並標記 `bodyTruncated: true` | 同左 |

- 遮蔽在 SDK 端先做一次、平台端再做一次：`password`、`token`、`authorization`、`apiKey`、`secret` 等欄位（不分大小寫）一律取代為 `***`
- `multipart/form-data` 只記錄檔名與大小，不記錄檔案內容

---

## 5. 系統架構

### 5.1 元件

```
[各服務後端]  --(SDK/middleware)-->  [DevOpsDiagram Backend]  -->  [MongoDB]
   BPM                                   Ingest API                [Redis]
   GeneralBackend                        Query API
   GigaSolarKnowledgeBase                Heartbeat API
   NotesAPP                              Pull Prober (cron)
   DockerAutomatedScheduling                  ^
                                              |
                                   [DevOpsDiagram Frontend]
                                   架構圖 / 紀錄 / 錯誤頁
```

### 5.2 技術棧（提案）

| 層 | 技術 | 理由 |
|----|------|------|
| 前端 | Vue 3 + Vite + TypeScript + Pinia + Vue Flow + dagre + Naive UI | 直接沿用 archatlas，可最大程度重用元件 |
| 前端即時更新 | 原生 `EventSource`（SSE） | 不需額外函式庫，瀏覽器內建、自動重連 |
| 後端 | Node.js + Express + mongodb driver + ioredis | 與現有 5 個服務一致，接入手冊範例也是 Express |
| 備份 | mongodump（獨立排程容器） | 見 5.5 |
| 部署 | Docker Compose | 與現有服務一致 |

### 5.3 Port 規劃（5131~5135）

| Port | 用途 |
|------|------|
| **5131** | 前端（Nginx 靜態站） |
| **5132** | 後端 API（Ingest + Query + Heartbeat） |
| **5133** | **SSE 即時推播**（`GET /api/v1/stream`），v1 啟用 |
| **5134** | 保留：內部維運端點（metrics、管理後台） |
| **5135** | 保留 |

MongoDB（27017）與 Redis（6379）**只綁 Docker 內部網路**，不對外開放；跨主機寫入一律走 5132 的 Ingest API。

> SSE 獨立在 5133 而非併入 5132，是因為 SSE 是長連線，與一般 API 的連線數／逾時設定需求不同，分開比較好調 Nginx 與監控。

### 5.4 環境

| 環境 | 位址 | 說明 |
|------|------|------|
| 開發／測試 | `10.10.112.13`（本機） | Docker 起全套，以 GigaSolarKnowledgeBase 為測試對象 |
| 生產 | `10.10.130.122` | 未來上架位置 |

**前端存取限制**：生產環境的前端（5131）、查詢 API 與 SSE（5133）僅允許 `10.10.112.13` 存取，以 Nginx `allow/deny` 實作；Ingest 端點（5132 的 `/api/v1/ingest/*`、`/api/v1/heartbeat`）不受此限（需讓各服務都能回報）。

### 5.5 備份策略

- 以獨立的排程容器每日 03:00 執行 `mongodump`，備份 `error_logs`、`services`、`api_keys`、`service_status` 四個 collection（`api_logs` 為 7 天暫存資料，不備份）
- 保留最近 **30 份**，超過自動刪除
- 備份檔落在 host 掛載目錄 `./backup/`，隨主機一起納入既有的檔案備份範圍
- 備份成功／失敗本身也回報為一筆紀錄（`serviceId: devopsdiagram-backup`），失敗會在架構圖上看得到

---

## 6. API 規格（概要）

> 完整規格另立 `docs/API_CONTRACT.md`。

### 6.1 Ingest（需 `ingest` 權限）

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/v1/ingest/log` | 單筆 API 紀錄 |
| POST | `/api/v1/ingest/logs` | 批次（建議，降低回報開銷，一次最多 100 筆） |
| POST | `/api/v1/heartbeat` | 心跳回報 |

### 6.2 Query（需 `read` 權限）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/v1/services` | 服務清單 + 當前狀態（架構圖用） |
| GET | `/api/v1/services/:id` | 單一服務詳情 |
| GET | `/api/v1/logs` | 紀錄查詢（篩選＋分頁） |
| GET | `/api/v1/logs/:id` | 單筆明細 |
| GET | `/api/v1/errors` | 錯誤聚合清單 |
| GET | `/api/v1/stats/overview` | 總覽統計 |
| GET | `/api/v1/topology` | 架構圖節點與連線定義 |
| GET | `/api/v1/stream` | **SSE 即時推播**（走 5133，事件定義見 3.7） |

### 6.3 平台自身健康

| Method | Path | 說明 |
|--------|------|------|
| GET | `/health` | 本平台存活（含 Mongo / Redis 連線狀態） |

---

## 7. 接入方式（已定案：統一走平台 API）

**各服務一律透過 `POST /api/v1/ingest/*` 回報，不直接連 Mongo / Redis。**

理由：DB 連線帳密不外散、Mongo/Redis 可完全不對外開放 port、資料格式由平台統一驗證、日後換儲存或加欄位不必動到五個服務。代價是平台掛掉時紀錄會遺失，以 SDK 端本地緩衝＋批次重送緩解（見下方 SDK 需求）。

**接入 SDK 需求（Express 為例）**

- 一個 `require('devops-reporter')` 的小模組，`app.use(reporter({ apiKey, serviceId, endpoint }))`
- 非阻塞：紀錄進記憶體 queue，每 5 秒或滿 50 筆批次送出；HTTP 逾時 1 秒
- 送不出去時保留在記憶體緩衝（上限 500 筆）等下一輪重送；緩衝滿了就丟最舊的，並在本地 console 警告，**絕不影響原服務回應**
- 自動遮蔽敏感欄位、body 依 4.5 規則處理（成功存摘要、錯誤存完整並於 32KB 截斷）
- 手動 API：`req.devops.action(type, target, note)` 記錄執行動作；`req.devops.error(err)` 主動標記為錯誤
- 內建心跳：啟動後每 30 秒自動打 `POST /api/v1/heartbeat`，不需各服務自己寫

---

## 8. 非功能性需求

| 項目 | 要求 |
|------|------|
| **效能（對被監控服務）** | 接入後單次請求額外延遲 < 2ms（非同步批次送出） |
| **效能（本平台）** | Ingest 端點 p95 < 50ms；查詢頁 p95 < 1s |
| **吞吐** | 支援 500 筆/秒寫入（5 個服務日常量級遠低於此） |
| **可用性** | 平台故障不得影響任何被監控服務（SDK 完全 fail-safe） |
| **資料量估算** | 每日 10 萬筆，成功只存 body 摘要後單筆約 1.5KB → 一般紀錄 7 天約 1GB；錯誤紀錄以 1% 計、單筆 6KB、年增約 2GB |
| **SSE 連線** | 支援 20 個並行 SSE 連線（實際使用者僅維運少數人）；連線異常中斷不影響 Ingest |
| **備份** | 每日 mongodump，保留 30 份，見 5.5 |
| **安全** | API Key 雜湊儲存並綁定 projectId/serviceId；敏感欄位雙重遮蔽；DB 不對外開放；生產前端與查詢 API IP 白名單 |
| **可維護性** | 架構圖拓樸以 JSON 設定檔維護（沿用 archatlas 格式），修改後重載即可 |

---

## 9. 首波接入對象

| 服務 | 路徑 | 現有 Port | 備註 |
|------|------|-----------|------|
| GigaSolarKnowledgeBase | `D:\檔案分享\程式碼\GigaSolarKnowledgeBase` | 5153 / 5155 | **首個測試對象**（Express + Mongo，最貼近平台技術棧） |
| BPM | `D:\檔案分享\程式碼\BPM` | 5147 / 5148 / 5149 | 三個容器，需分別註冊 |
| GeneralBackend | `D:\檔案分享\程式碼\GeneralBackend` | 5123 / 5124 / 5125 | 三個容器 |
| NotesAPP | `D:\檔案分享\程式碼\NotesAPP` | 5121 / 5122 | |
| DockerAutomatedScheduling | `D:\檔案分享\程式碼\DockerAutomatedScheduling` | — | 排程型服務，一次執行 = 一筆紀錄，沿用同 schema（見 3.8） |

---

## 10. 里程碑

| 階段 | 內容 | 產出 |
|------|------|------|
| **M0 規劃** | PRD / 架構文件 / API 合約 / DB Schema | `docs/` 四份文件 |
| **M1 後端骨架** | Docker Compose（Mongo + Redis + Backend）、API Key、Ingest、Heartbeat、SSE 端點 | 可用 curl 寫入與查詢，SSE 可接收事件 |
| **M2 接入驗證** | SDK + 接入手冊，接上 GigaSolarKnowledgeBase | 本機可看到真實紀錄 |
| **M3 前端** | 架構圖 + SSE 狀態疊加 + 詳情面板 + 紀錄頁 + 錯誤頁 | 本機完整可用 |
| **M4 其餘服務接入** | BPM / GeneralBackend / NotesAPP / DAS（排程型） | 5 個服務全上 |
| **M5 上生產** | 部署 10.10.130.122、IP 白名單、備份容器上線並驗證還原 | 正式啟用 |

---

## 11. 風險

| 風險 | 影響 | 對策 |
|------|------|------|
| 紀錄量爆增拖垮 Mongo | 平台與被監控服務都變慢 | TTL index、批次寫入、body 截斷、必要時加取樣（成功請求抽樣 10%） |
| 敏感資料落地 | 資安事件 | SDK 端先遮蔽再送出，平台端二次遮蔽 |
| 平台故障影響既有服務 | 生產事故 | SDK 完全非同步 + 逾時 1 秒 + 失敗即丟棄 |
| 各服務接入意願／成本 | 覆蓋率不足 | SDK 化，接入控制在 5 行內；先做一個成功案例 |
| 架構圖與實際不同步 | 資訊失真 | 對「有回報但圖上沒有」的服務自動標記，提示補設定 |

---

## 12. 決策紀錄（2026-09-18 定案）

| # | 議題 | 決策 | 理由 | 對應章節 |
|---|------|------|------|----------|
| D-01 | 資料寫入方式 | **統一走平台 Ingest API**，各服務不直連 DB | DB 帳密不外散、port 不對外、格式統一、日後換儲存不動各服務 | §7 |
| D-02 | Mongo / Redis 位置 | **與平台同一台跑 Docker**，只綁內部網路 | 部署最單純、隔離最好；本機測試與生產用同一份 compose | §5.3 §5.4 |
| D-03 | 共用儲存範疇 | **v1 只做監控用途**，但資料模型與 API Key 先預留 `projectId` 維度 | 未來其他專案要共用時不必改 schema，同時不讓 v1 肥大 | §1.3 §4.4 |
| D-04 | 錯誤定義 | **5xx + 服務自報 error** 進永久區；4xx 進 7 天區但錯誤頁可篩選 | 4xx 多為傳錯參數／權限不足，量大且長期價值低 | §4.5 |
| D-05 | body 保存 | **成功存摘要（大小 + 前 1KB），錯誤存完整（32KB 截斷）** | 錯誤要能重現所以留完整；成功的 body 幾乎不會被看，可大幅壓低儲存量 | §4.5 §8 |
| D-06 | 即時更新 | **SSE 推播（5133）**，斷線時退回 15 秒輪詢 | 狀態變化要即時看到；SSE 用瀏覽器原生 EventSource，成本可接受 | §3.7 §5.3 |
| D-07 | 備份 | **每日 mongodump，保留 30 份**，落在 host `./backup/` | 「永久保存」不能只靠單一磁碟；資料量小成本低 | §5.5 |
| D-08 | 排程服務接法 | **一次執行 = 一筆紀錄**，沿用同一套 schema | 不多維護一套模型，前端可直接重用紀錄面板與錯誤頁 | §3.8 |

### 12.1 尚未確認（不阻擋 M1）

- **生產主機的 Docker volume 掛載位置**：`./backup/` 與 Mongo data volume 要落在 10.10.130.122 的哪個路徑，上生產（M5）前確認即可。
- **既有服務的 `/health` 端點**：五個服務目前未必都有，Pull 探測要接哪個路徑，於 M4 逐一接入時確認；未提供者先只靠 Push 心跳。

---

## 13. 後續文件

| 文件 | 內容 | 狀態 |
|------|------|------|
| [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | 系統架構、部署拓樸、容器設計、故障影響分析 | ✅ v1.0 |
| [`docs/API_CONTRACT.md`](./API_CONTRACT.md) | 完整 API 規格（request / response / 錯誤碼 / SSE 事件） | ✅ v1.0 |
| [`docs/DB_SCHEMA.md`](./DB_SCHEMA.md) | Mongo collection 與 Redis key 完整定義、索引、容量估算 | ✅ v1.0 |
| [`docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) | **給各服務後端的接入手冊**（含 Express 範例） | ✅ v1.0 |
| [`docs/Gherkin/`](./Gherkin/) | 驗收規格（12 份 `.feature`，取代原規劃的 `ACCEPTANCE.md`） | ✅ v1.0 |
