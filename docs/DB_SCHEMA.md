# 資料庫設計文件 (DB Schema)

**專案**：DevOpsDiagram
**文件版本**：v1.0
**建立日期**：2026-09-18
**狀態**：已定案
**上游文件**：[PRD.md](./PRD.md) §4、[ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 1. 總覽

| 儲存 | 角色 | 存取方式 |
|------|------|----------|
| **MongoDB** `devops_diagram` | 主儲存，決定資料的真實狀態 | 只有 `dvd-backend` 連線；不對外開放 port |
| **Redis** | 快取層，服務近 24 小時的快查與狀態判定 | 同上 |

所有紀錄類文件都帶 `projectId`，v1 固定為 `devops`（PRD D-03 預留維度）。

---

## 2. MongoDB Collections

### 2.1 `services` — 服務註冊

架構圖的節點來源。由 `config/topology.json` 匯入，也可經 admin API 維護。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `_id` | string | 即 `serviceId`，例如 `gigaks-backend`（人工指定，非 ObjectId） |
| `projectId` | string | 固定 `devops` |
| `name` | string | 顯示名稱 |
| `type` | string | `frontend` / `backend` / `database` / `cache` / `thirdparty` / `gateway` / `storage` / `devops` |
| `layer` | string | `presentation` / `api` / `service` / `data` / `infra` |
| `description` | string | 職責描述 |
| `stack` | string[] | 技術棧 |
| `team` / `owner` | string | 負責團隊 / 負責人 |
| `status` | string | `active` / `developing` / `deprecated`（這是**服務生命週期**，不是健康狀態） |
| `links` | object | `{ repo, docs }` |
| `monitor` | object | `{ healthUrl, enabled }`，Pull 探測用 |
| `edges` | — | 不存在此 collection，連線定義見 `topology` |
| `createdAt` / `updatedAt` | Date | |

```javascript
db.services.createIndex({ projectId: 1, type: 1 });
db.services.createIndex({ projectId: 1, layer: 1 });
```

### 2.2 `topology` — 架構圖連線

| 欄位 | 型別 | 說明 |
|------|------|------|
| `_id` | ObjectId | |
| `projectId` | string | 固定 `devops` |
| `from` / `to` | string | serviceId |
| `label` | string | 例如 `REST`、`MSSQL`、`SMB` |

```javascript
db.topology.createIndex({ projectId: 1, from: 1, to: 1 }, { unique: true });
```

### 2.3 `api_logs` — 一般紀錄（TTL 7 天）

收 2xx / 3xx / **4xx** 與服務自報 `warn`（PRD D-04）。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `_id` | ObjectId | |
| `projectId` | string | 固定 `devops` |
| `serviceId` | string | **由 API Key 反查決定，不採信 client 自報** |
| `traceId` | string \| null | v2 跨服務串接預留 |
| `ts` | Date | 事件發生時間（服務端時間） |
| `receivedAt` | Date | 平台收到時間（用於偵測服務時鐘偏移） |
| `level` | string | `info` / `warn` |
| `kind` | string | `http`（API 請求）/ `job`（排程執行，見 §5） |
| `request` | object | 見 2.5 |
| `actions` | object[] | 見 2.6 |
| `response` | object | 見 2.7 |
| `expireAt` | Date | `ts + 7 天`，TTL 索引依此刪除 |

```javascript
db.api_logs.createIndex({ projectId: 1, serviceId: 1, ts: -1 });
db.api_logs.createIndex({ projectId: 1, ts: -1 });
db.api_logs.createIndex({ projectId: 1, serviceId: 1, "response.status": 1, ts: -1 });
db.api_logs.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });   // TTL
```

> TTL 索引用 `expireAt` 而非 `ts + expireAfterSeconds`，是為了讓保留天數可依服務調整（未來若某服務要留久一點，只要寫入時算出不同的 `expireAt` 即可，不用改索引）。

### 2.4 `error_logs` — 錯誤紀錄（永久保存）

進入條件（滿足任一，PRD D-04）：

- `response.status >= 500`
- 服務自報 `level: "error"`（HTTP 200 但業務邏輯失敗）
- 排程任務執行失敗

欄位與 `api_logs` 相同，差異：

| 欄位 | 說明 |
|------|------|
| `level` | 固定 `error` |
| `error` | `{ name, message, stack, code }` |
| `expireAt` | **不存在**（無 TTL 索引，永久保存） |
| `request.body` / `response.body` | 存**完整**內容（32KB 截斷），非摘要 |

```javascript
db.error_logs.createIndex({ projectId: 1, serviceId: 1, ts: -1 });
db.error_logs.createIndex({ projectId: 1, ts: -1 });
// 錯誤聚合頁專用
db.error_logs.createIndex({
  projectId: 1, serviceId: 1,
  "request.method": 1, "request.path": 1, "response.status": 1, ts: -1
});
```

### 2.5 `request` 子文件

| 欄位 | 型別 | 說明 |
|------|------|------|
| `method` | string | `GET` / `POST` / …；排程紀錄固定 `JOB` |
| `path` | string | 例如 `/api/v1/articles/123` |
| `pathTemplate` | string | 例如 `/api/v1/articles/:id`，**聚合統計用**（沒有它，每個不同 id 都會被當成不同 API） |
| `query` | object | 遮蔽後 |
| `body` | object \| string \| null | 依保存規則，見 §4 |
| `bodySize` | number | 原始大小（bytes），即使只存摘要也保留真實大小 |
| `bodyTruncated` | boolean | 是否被截斷 |
| `headers` | object | 遮蔽後，只保留白名單（`content-type`、`user-agent`、`referer`、`x-request-id`） |
| `ip` | string | 來源 IP |
| `userId` | string \| null | 服務可選填，方便追「誰觸發的」 |

### 2.6 `actions` 子文件陣列

後端在這支 API 中做了什麼，由開發者以 `req.devops.action()` 主動記錄。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `seq` | number | 序號，從 1 開始 |
| `type` | string | `db` / `http` / `cache` / `file` / `mq` / `other` |
| `target` | string | 例如 `mssql.articles`、`http://10.10.130.45:53020/api` |
| `durationMs` | number | 該動作耗時 |
| `note` | string | 自由描述，例如 `insert 1 row` |
| `ok` | boolean | 該動作是否成功 |

### 2.7 `response` 子文件

| 欄位 | 型別 | 說明 |
|------|------|------|
| `status` | number | HTTP 狀態碼；排程紀錄用 `200` / `500` 表示成功失敗 |
| `body` | object \| string \| null | 依保存規則，見 §4 |
| `bodySize` | number | 原始大小 |
| `bodyTruncated` | boolean | |
| `durationMs` | number | 該次請求總耗時 |

### 2.8 `heartbeats` — 心跳事件流（TTL 7 天）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `_id` | ObjectId | |
| `projectId` / `serviceId` | string | |
| `ts` | Date | |
| `source` | string | `push`（服務回報）/ `probe`（平台探測） |
| `ok` | boolean | |
| `version` | string \| null | 服務版本，方便確認有沒有部署成功 |
| `uptimeSec` | number \| null | 服務啟動至今秒數，可看出有沒有偷偷重啟 |
| `deps` | object[] | `[{ name, ok, latencyMs }]`，服務自身的依賴狀態（DB 連線等） |
| `expireAt` | Date | `ts + 7 天` |

```javascript
db.heartbeats.createIndex({ projectId: 1, serviceId: 1, ts: -1 });
db.heartbeats.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
```

> 保留心跳事件流（而非只留最後一筆）是為了回答「昨天半夜是不是斷過」這種問題。

### 2.9 `service_status` — 最新狀態快照（永久，1 服務 1 筆）

架構圖的資料來源，由 `statusService` upsert。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `_id` | string | `{projectId}:{serviceId}` |
| `projectId` / `serviceId` | string | |
| `status` | string | `healthy` / `degraded` / `down` / `unknown` |
| `since` | Date | 進入此狀態的時間（前端顯示「已 down 12 分鐘」） |
| `lastHeartbeatAt` | Date \| null | 最後一次 push 心跳 |
| `lastProbeOkAt` | Date \| null | 最後一次 pull 探測成功 |
| `lastErrorAt` | Date \| null | |
| `stats1h` | object | `{ total, error, avgMs }`，近 1 小時 |
| `stats5m` | object | `{ total, error, errorRate }`，狀態判定用 |
| `version` / `uptimeSec` | | 取自最後一次心跳 |
| `updatedAt` | Date | |

```javascript
db.service_status.createIndex({ projectId: 1, status: 1 });
```

### 2.10 `api_keys` — API Key

| 欄位 | 型別 | 說明 |
|------|------|------|
| `_id` | ObjectId | |
| `keyHash` | string | **SHA-256 雜湊，明文不存** |
| `keyPrefix` | string | 明文前 12 碼，例如 `dvd_devops_g`，供管理介面辨識用 |
| `projectId` | string | |
| `serviceId` | string \| null | `ingest` Key 必填；`read`/`admin` Key 可為 null（代表整個 projectId 範圍） |
| `scopes` | string[] | `["ingest"]` / `["read"]` / `["admin"]` |
| `label` | string | 例如「知識庫後端 - 正式」 |
| `enabled` | boolean | 停用後須同步刪除 Redis 快取 |
| `lastUsedAt` | Date \| null | 用來找出沒在用的殭屍 Key |
| `createdAt` / `createdBy` | | |

```javascript
db.api_keys.createIndex({ keyHash: 1 }, { unique: true });
db.api_keys.createIndex({ projectId: 1, serviceId: 1 });
```

---

## 3. Redis Key 設計

前綴一律 `dvd:`，第二段為 `projectId`（v1 為 `devops`），避免未來共用時撞 key。

| Key | 型別 | 內容 | TTL |
|-----|------|------|-----|
| `dvd:{proj}:log:{serviceId}` | List | 近期一般紀錄 JSON（`LPUSH` + `LTRIM 0 999`） | 1 天 |
| `dvd:{proj}:err:{serviceId}` | List | 近期錯誤紀錄 JSON（同上） | 1 天 |
| `dvd:{proj}:hb:{serviceId}` | String | 最後心跳的 epoch ms | 120 秒 |
| `dvd:{proj}:probe:{serviceId}` | String | 最後探測成功的 epoch ms | 120 秒 |
| `dvd:{proj}:stat:{serviceId}:{yyyyMMddHH}` | Hash | `total` / `error` / `sumMs` 計數 | 1 天 |
| `dvd:{proj}:status:all` | String(JSON) | 全服務狀態快照，架構圖與 SSE snapshot 都讀這份 | 60 秒 |
| `dvd:key:{sha256}` | String(JSON) | `{ projectId, serviceId, scopes, enabled }` | 10 分鐘 |
| `dvd:{proj}:pending` | List | Mongo 寫入失敗時的待補佇列 | 無（由背景工作消化） |

**注意事項**

- `dvd:key:*` **不帶 projectId**，因為驗證時還不知道是哪個專案 —— 雜湊本身就是全域唯一的。
- 停用 Key 時必須 `DEL dvd:key:{sha256}`，否則最長 10 分鐘內仍會通過驗證。
- `stat` 的 Hash 用 `HINCRBY`，跨小時查詢時合併相鄰兩個 key。
- Redis 啟用 AOF；即使掉資料也只影響快查，Mongo 仍是真實來源。

---

## 4. body 保存規則（PRD D-05）

| 情境 | `body` 存什麼 | `bodySize` | `bodyTruncated` |
|------|--------------|-----------|-----------------|
| 成功（進 `api_logs`） | 前 1KB 的字串摘要 | 原始大小 | 原始 > 1KB 時為 `true` |
| 錯誤（進 `error_logs`） | 完整內容，超過 32KB 截斷 | 原始大小 | 原始 > 32KB 時為 `true` |
| `multipart/form-data` | `[{ field, filename, size, mimetype }]`，**不含檔案內容** | 總大小 | `false` |
| 非 JSON / 二進位 | `null`，只留 `content-type` 與大小 | 原始大小 | `false` |

**遮蔽規則**：欄位名（不分大小寫）包含 `password`、`passwd`、`token`、`authorization`、`apikey`、`api_key`、`secret`、`credential` 者，值一律取代為 `***`。遞迴處理巢狀物件與陣列。SDK 端先做一次，平台端再做一次 —— 第二次是為了防止某個服務用了舊版 SDK 或自己手寫回報。

---

## 5. 排程紀錄的欄位對應（PRD D-08）

DockerAutomatedScheduling 這類排程服務，一次執行 = 一筆紀錄，`kind: "job"`：

| 欄位 | 排程服務填什麼 |
|------|---------------|
| `request.method` | 固定 `JOB` |
| `request.path` | job 名稱，例如 `contractExpiryNotify` |
| `request.pathTemplate` | 同 `path` |
| `request.body` | `{ trigger: "cron" \| "manual", cronExpr: "0 9 15,28 * *", params: {} }` |
| `actions` | 執行步驟：查了哪個 DB、寄了幾封信、各步驟耗時 |
| `response.status` | `200` 成功 / `500` 失敗 |
| `response.body` | `{ processed: 12, sent: 3, skipped: 0 }` |
| `response.durationMs` | 總執行時間 |
| `error` | 失敗時的例外，並進 `error_logs` |

前端不另開頁面，直接重用既有紀錄面板與錯誤頁。

---

## 6. 容量估算

| 項目 | 估算 |
|------|------|
| 每日紀錄量 | 10 萬筆（5 個服務合計，保守上限） |
| 一般紀錄單筆 | 約 1.5KB（成功只存 body 摘要） |
| `api_logs` 穩態 | 10 萬 × 7 天 × 1.5KB ≈ **1.0 GB** |
| 錯誤比例 | 1%（1000 筆/日） |
| 錯誤紀錄單筆 | 約 6KB（含完整 body 與 stack） |
| `error_logs` 年增 | 1000 × 365 × 6KB ≈ **2.1 GB/年** |
| 索引額外開銷 | 約資料量的 30% |
| Redis 常駐 | 每服務 2 個 List × 1000 筆 × 1.5KB ≈ 3MB，5 服務約 **15 MB** |
| **建議磁碟配置** | Mongo data volume 至少 **20 GB**（含 5 年錯誤紀錄與索引成長空間） |

若實際量遠超估算，緩解順序：(1) 縮短 `LOG_TTL_DAYS`、(2) 成功請求抽樣（只記 10%）、(3) 縮小 body 摘要長度。這三個都是環境變數，不需改程式。

---

## 7. 索引建立腳本

`backend/scripts/initIndexes.js`，開機時與部署後手動執行皆可（`createIndex` 具冪等性）：

```javascript
const indexes = [
  ['services',       { projectId: 1, type: 1 },  {}],
  ['services',       { projectId: 1, layer: 1 }, {}],
  ['topology',       { projectId: 1, from: 1, to: 1 }, { unique: true }],

  ['api_logs',       { projectId: 1, serviceId: 1, ts: -1 }, {}],
  ['api_logs',       { projectId: 1, ts: -1 }, {}],
  ['api_logs',       { projectId: 1, serviceId: 1, 'response.status': 1, ts: -1 }, {}],
  ['api_logs',       { expireAt: 1 }, { expireAfterSeconds: 0 }],

  ['error_logs',     { projectId: 1, serviceId: 1, ts: -1 }, {}],
  ['error_logs',     { projectId: 1, ts: -1 }, {}],
  ['error_logs',     { projectId: 1, serviceId: 1, 'request.method': 1,
                       'request.path': 1, 'response.status': 1, ts: -1 }, {}],

  ['heartbeats',     { projectId: 1, serviceId: 1, ts: -1 }, {}],
  ['heartbeats',     { expireAt: 1 }, { expireAfterSeconds: 0 }],

  ['service_status', { projectId: 1, status: 1 }, {}],

  ['api_keys',       { keyHash: 1 }, { unique: true }],
  ['api_keys',       { projectId: 1, serviceId: 1 }, {}],
];
```

---

## 8. 資料生命週期一覽

| Collection | 保留 | 清除機制 | 備份 |
|------------|------|----------|------|
| `services` | 永久 | — | ✅ |
| `topology` | 永久 | — | ✅ |
| `api_logs` | **7 天** | TTL index（`expireAt`） | ❌ |
| `error_logs` | **永久** | 無 | ✅ |
| `heartbeats` | 7 天 | TTL index | ❌ |
| `service_status` | 永久（覆寫） | upsert | ✅ |
| `api_keys` | 永久 | — | ✅ |
| Redis 全部 | ≤ 1 天 | TTL | ❌ |
