# API 規格文件 (API Contract)

**專案**：DevOpsDiagram
**文件版本**：v1.0
**建立日期**：2026-09-18
**狀態**：已定案
**上游文件**：[PRD.md](./PRD.md)、[DB_SCHEMA.md](./DB_SCHEMA.md)

---

## 1. 通則

### 1.1 Base URL

| 用途 | 開發（10.10.112.13） | 生產（10.10.130.122） |
|------|---------------------|----------------------|
| API | `http://10.10.112.13:5132/api/v1` | `http://10.10.130.122:5132/api/v1` |
| SSE | `http://10.10.112.13:5133/api/v1` | `http://10.10.130.122:5133/api/v1` |
| 前端 | `http://10.10.112.13:5131` | `http://10.10.130.122:5131` |

### 1.2 認證

所有端點（除 `GET /health`）都需要 header：

```
X-API-Key: dvd_devops_gigaks-backend_a1b2c3d4e5f6...
```

- `projectId` 與 `serviceId` **一律由 Key 反查決定**，request body 中若帶了這兩個欄位會被忽略
- 權限不足回 403，Key 無效或停用回 401

| Scope | 可用端點 |
|-------|----------|
| `ingest` | `POST /ingest/*`、`POST /heartbeat` |
| `read` | 所有 `GET` 查詢端點、`GET /stream` |
| `admin` | 上述全部 + `/admin/*` |

### 1.3 統一回應格式

成功：

```json
{ "success": true, "data": { } }
```

列表：

```json
{
  "success": true,
  "data": [ ],
  "pagination": { "limit": 100, "nextCursor": "6512ab...", "hasMore": true }
}
```

失敗：

```json
{
  "success": false,
  "error": { "code": "INVALID_API_KEY", "message": "API Key 無效或已停用" }
}
```

### 1.4 錯誤碼

| HTTP | code | 說明 |
|------|------|------|
| 400 | `VALIDATION_ERROR` | 欄位缺漏或格式錯誤，`error.details` 列出問題欄位 |
| 400 | `BATCH_TOO_LARGE` | 批次超過 100 筆 |
| 401 | `MISSING_API_KEY` | 未帶 `X-API-Key` |
| 401 | `INVALID_API_KEY` | Key 不存在或已停用 |
| 403 | `INSUFFICIENT_SCOPE` | 權限不足 |
| 403 | `IP_NOT_ALLOWED` | 查詢端點的來源 IP 不在白名單 |
| 404 | `NOT_FOUND` | 資源不存在 |
| 413 | `PAYLOAD_TOO_LARGE` | 單次請求超過 5MB |
| 429 | `RATE_LIMITED` | 超過速率限制，`Retry-After` header 標示秒數 |
| 503 | `SSE_LIMIT_REACHED` | SSE 並行連線已達 20 上限 |
| 500 | `INTERNAL_ERROR` | 平台內部錯誤 |

### 1.5 時間格式

一律 ISO 8601 帶時區：`2026-09-18T08:00:00.000Z`。服務端時間與平台時間不同步時，平台會同時記錄 `ts`（服務報的）與 `receivedAt`（平台收到的）。

### 1.6 速率限制

| 端點群 | 限制 |
|--------|------|
| `POST /ingest/*` | 每個 serviceId 每分鐘 600 次請求（批次算 1 次） |
| `POST /heartbeat` | 每個 serviceId 每分鐘 10 次 |
| 查詢端點 | 每個 Key 每分鐘 300 次 |

超限回 429。Ingest 超限時平台**丟棄該批次但仍回 202** —— 不讓被監控服務因為我們的限流而卡住或不斷重送。

---

## 2. Ingest API（scope: `ingest`）

### 2.1 `POST /api/v1/ingest/logs` — 批次回報（**建議使用**）

SDK 預設走這支，每 5 秒或滿 50 筆送一次。

**Request**

```jsonc
{
  "logs": [
    {
      "ts": "2026-09-18T08:00:00.000Z",
      "level": "info",                    // info | warn | error
      "kind": "http",                     // http | job
      "traceId": null,
      "request": {
        "method": "POST",
        "path": "/api/v1/articles/123",
        "pathTemplate": "/api/v1/articles/:id",
        "query": { "draft": "1" },
        "body": { "title": "..." },
        "bodySize": 2048,
        "bodyTruncated": false,
        "headers": { "content-type": "application/json" },
        "ip": "10.10.112.50",
        "userId": "S112009"
      },
      "actions": [
        { "seq": 1, "type": "db", "target": "mssql.articles", "durationMs": 12, "note": "insert", "ok": true }
      ],
      "response": {
        "status": 200,
        "body": { "success": true },
        "bodySize": 130,
        "bodyTruncated": false,
        "durationMs": 134
      }
    }
  ]
}
```

**必填欄位**：`ts`、`level`、`request.method`、`request.path`、`response.status`、`response.durationMs`。其餘可省略。

**Response** `202 Accepted`

```json
{ "success": true, "data": { "accepted": 48, "rejected": 2, "errors": [{ "index": 3, "message": "缺少 response.status" }] } }
```

**行為說明**

- 回 **202 而非 201** —— 平台只保證收下，實際寫入是非同步的
- 單筆格式錯誤只丟棄該筆，不影響整批
- 一批最多 100 筆，超過回 400 `BATCH_TOO_LARGE`
- `level: "error"` 或 `response.status >= 500` → 進 `error_logs`（永久），其餘進 `api_logs`（7 天）
- body 依 [DB_SCHEMA §4](./DB_SCHEMA.md) 規則處理：成功存摘要、錯誤存完整

### 2.2 `POST /api/v1/ingest/log` — 單筆回報

body 即單筆 log 物件（同上結構，不包 `logs` 陣列）。供手寫回報或除錯用；正式接入請用批次。

**Response** `202 Accepted`

```json
{ "success": true, "data": { "accepted": 1 } }
```

### 2.3 `POST /api/v1/heartbeat` — 心跳

**Request**

```jsonc
{
  "ts": "2026-09-18T08:00:00.000Z",
  "version": "1.2.0",
  "uptimeSec": 86400,
  "deps": [
    { "name": "mssql", "ok": true,  "latencyMs": 8 },
    { "name": "mongo", "ok": true,  "latencyMs": 3 },
    { "name": "qdrant", "ok": false, "latencyMs": null }
  ]
}
```

全部欄位皆可省略 —— 打一個空 body `{}` 就足以表示「我還活著」。

**Response** `200`

```json
{ "success": true, "data": { "serviceId": "gigaks-backend", "status": "healthy", "nextExpectedWithinSec": 90 } }
```

`deps` 中有 `ok: false` 時，該服務狀態仍為 `healthy`（它自己活著），但前端詳情面板會標示依賴異常。

---

## 3. Query API（scope: `read`）

> 生產環境這些端點僅允許 `10.10.112.13` 存取，其他來源回 403 `IP_NOT_ALLOWED`。

### 3.1 `GET /api/v1/services` — 服務清單與狀態（架構圖用）

**Query 參數**

| 參數 | 說明 |
|------|------|
| `status` | 篩選 `healthy` / `degraded` / `down` / `unknown`，可逗號分隔 |
| `type` | 篩選服務類型 |
| `layer` | 篩選層級 |

**Response**

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "gigaks-backend",
      "name": "知識庫後端",
      "type": "backend",
      "layer": "api",
      "stack": ["Node.js", "Express", "MongoDB"],
      "team": "開發團隊",
      "owner": "—",
      "lifecycle": "active",              // 服務生命週期
      "health": {
        "status": "healthy",              // 即時健康狀態
        "since": "2026-09-18T06:12:00.000Z",
        "lastHeartbeatAt": "2026-09-18T08:00:12.000Z",
        "lastProbeOkAt": "2026-09-18T08:00:05.000Z",
        "stats1h": { "total": 1284, "error": 3, "avgMs": 87 },
        "deps": [{ "name": "mssql", "ok": true }]
      },
      "links": { "repo": "D:\\檔案分享\\程式碼\\GigaSolarKnowledgeBase" }
    }
  ]
}
```

> `lifecycle`（active/developing/deprecated）與 `health.status`（healthy/degraded/down/unknown）是**兩件不同的事**，刻意分開命名避免混淆。

### 3.2 `GET /api/v1/services/:id` — 單一服務詳情

回傳同上單筆，額外包含：

```jsonc
{
  "recentLogs": [ /* 最近 50 筆摘要 */ ],
  "recentErrors": [ /* 最近 20 筆錯誤摘要 */ ],
  "dependencies": {
    "upstream":   [{ "id": "gigaks-frontend", "status": "healthy" }],
    "downstream": [{ "id": "mssql-kb", "status": "healthy" }]
  },
  "stats24h": { "total": 28400, "error": 41, "avgMs": 92, "p95Ms": 310 }
}
```

### 3.3 `GET /api/v1/logs` — 紀錄查詢

**Query 參數**

| 參數 | 預設 | 說明 |
|------|------|------|
| `serviceId` | — | 可逗號分隔多個 |
| `from` / `to` | 近 1 小時 | ISO 8601 |
| `level` | 全部 | `info` / `warn` / `error` |
| `status` | — | HTTP 狀態碼，支援 `500` 或 `5xx` |
| `method` | — | |
| `path` | — | 子字串比對 |
| `q` | — | 關鍵字，搜 request/response body 內容 |
| `kind` | 全部 | `http` / `job` |
| `limit` | 100 | 上限 500 |
| `cursor` | — | 上一頁回傳的 `nextCursor` |

**Response**

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6512ab...",
      "serviceId": "gigaks-backend",
      "ts": "2026-09-18T08:00:00.000Z",
      "level": "error",
      "kind": "http",
      "method": "POST",
      "path": "/api/v1/articles/123",
      "status": 500,
      "durationMs": 1340,
      "errorMessage": "SequelizeConnectionError: ..."   // 列表只給摘要
    }
  ],
  "pagination": { "limit": 100, "nextCursor": "6512aa...", "hasMore": true }
}
```

**查詢策略**：`from` 在近 24 小時內且無 `q` 條件時走 Redis List（快）；否則走 Mongo。回應 header `X-Data-Source: redis|mongo` 標示這次從哪來，方便除錯。

### 3.4 `GET /api/v1/logs/:id` — 單筆明細

回傳完整文件，含 `request`（query/body/headers）、`actions`、`response`、`error`。body 已遮蔽，若曾截斷則 `bodyTruncated: true` 且 `bodySize` 顯示原始大小。

```jsonc
{
  "success": true,
  "data": {
    "id": "6512ab...",
    "serviceId": "gigaks-backend",
    "ts": "2026-09-18T08:00:00.000Z",
    "receivedAt": "2026-09-18T08:00:01.200Z",
    "level": "error",
    "request": {
      "method": "POST", "path": "/api/v1/articles/123",
      "pathTemplate": "/api/v1/articles/:id",
      "query": {}, "body": { "title": "...", "password": "***" },
      "bodySize": 2048, "bodyTruncated": false,
      "headers": { "content-type": "application/json" },
      "ip": "10.10.112.50", "userId": "S112009"
    },
    "actions": [
      { "seq": 1, "type": "db", "target": "mssql.articles", "durationMs": 1200, "note": "insert", "ok": false }
    ],
    "response": { "status": 500, "body": { "success": false, "message": "伺服器內部錯誤" }, "durationMs": 1340 },
    "error": { "name": "SequelizeConnectionError", "message": "...", "stack": "..." }
  }
}
```

### 3.5 `GET /api/v1/errors` — 錯誤聚合清單

依 `serviceId + method + pathTemplate + status` 分組。

**Query 參數**

| 參數 | 預設 | 說明 |
|------|------|------|
| `serviceId` | 全部 | |
| `from` / `to` | 近 7 天 | 可查到一年前（error_logs 永久保存） |
| `status` | — | |
| `path` | — | |
| `sort` | `count` | `count`（次數多的優先）/ `latest`（最近發生的優先） |
| `limit` | 50 | |

**Response**

```jsonc
{
  "success": true,
  "data": [
    {
      "serviceId": "gigaks-backend",
      "method": "POST",
      "pathTemplate": "/api/v1/articles/:id",
      "status": 500,
      "count": 42,
      "firstSeenAt": "2026-09-17T22:10:00.000Z",
      "lastSeenAt": "2026-09-18T07:58:00.000Z",
      "sampleErrorMessage": "SequelizeConnectionError: ...",
      "sampleLogId": "6512ab..."        // 點進去看明細
    }
  ]
}
```

### 3.6 `GET /api/v1/errors/:groupKey/events` — 某組錯誤的個別事件

`groupKey` 格式 `{serviceId}|{method}|{pathTemplate}|{status}`（URL encode）。回傳該組的事件列表，結構同 3.3。

### 3.7 `GET /api/v1/stats/overview` — 總覽統計

```jsonc
{
  "success": true,
  "data": {
    "services": { "total": 12, "healthy": 10, "degraded": 1, "down": 1, "unknown": 0 },
    "last1h":   { "total": 5284, "error": 63, "errorRate": 0.0119, "avgMs": 95 },
    "last24h":  { "total": 98210, "error": 412, "errorRate": 0.0042, "avgMs": 91 },
    "topErrors": [
      { "serviceId": "gigaks-backend", "pathTemplate": "/api/v1/articles/:id", "status": 500, "count": 42 }
    ],
    "slowest": [
      { "serviceId": "bpm-backend", "pathTemplate": "/api/flow/:id", "avgMs": 2100, "count": 88 }
    ]
  }
}
```

### 3.8 `GET /api/v1/topology` — 架構圖定義

```jsonc
{
  "success": true,
  "data": {
    "services": [ /* 同 3.1，含 health */ ],
    "edges": [ { "from": "gigaks-frontend", "to": "gigaks-backend", "label": "REST" } ],
    "unregistered": ["some-service-id"]   // 有回報但 topology 沒登錄，提示補設定
  }
}
```

---

## 4. SSE（scope: `read`，Port 5133）

### 4.1 `GET /api/v1/stream`

**連線**

```javascript
const es = new EventSource('http://10.10.112.13:5133/api/v1/stream?apiKey=dvd_devops_ui_xxx');
```

> `EventSource` 無法帶自訂 header，因此 SSE 端點**額外接受 `apiKey` query 參數**。這是唯一允許 Key 出現在 URL 的端點；該 Key 應只給 `read` 權限，且此端點在生產環境受 IP 白名單保護。

**事件**

| event | 觸發時機 | data |
|-------|----------|------|
| `snapshot` | 連線建立時、之後每 30 秒 | 全服務狀態陣列（同 3.1 的 `data`） |
| `status` | 某服務狀態改變 | `{ serviceId, status, previousStatus, since }` |
| `error` | 收到新錯誤紀錄 | `{ logId, serviceId, method, path, status, ts, message }` |

```
event: status
data: {"serviceId":"bpm-backend","status":"down","previousStatus":"healthy","since":"2026-09-18T08:01:30.000Z"}

event: error
data: {"logId":"6512ab...","serviceId":"gigaks-backend","method":"POST","path":"/api/v1/articles/123","status":500,"ts":"2026-09-18T08:00:00.000Z","message":"SequelizeConnectionError: ..."}
```

**行為說明**

- 只有**狀態改變**才推 `status`，不會每 15 秒灌一次全量
- 每 30 秒的 `snapshot` 兼作 keep-alive，防止 Nginx 因閒置切斷長連線
- 並行連線上限 20，超過回 503 `SSE_LIMIT_REACHED`，前端應退回輪詢
- 前端重連採指數退避（1s → 2s → 4s … 上限 30s），重連期間以 15 秒輪詢 `GET /services` 維持畫面更新

---

## 5. Admin API（scope: `admin`）

### 5.1 `POST /api/v1/admin/keys` — 建立 API Key

**Request**

```json
{ "projectId": "devops", "serviceId": "gigaks-backend", "scopes": ["ingest"], "label": "知識庫後端 - 正式" }
```

**Response** `201`

```json
{
  "success": true,
  "data": {
    "id": "6512cd...",
    "key": "dvd_devops_gigaks-backend_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    "keyPrefix": "dvd_devops_g",
    "warning": "明文 Key 只顯示這一次，請立即保存"
  }
}
```

### 5.2 `GET /api/v1/admin/keys` — 列出 Key

只回 `keyPrefix`、`projectId`、`serviceId`、`scopes`、`label`、`enabled`、`lastUsedAt`、`createdAt`，**不回明文也不回雜湊**。

### 5.3 `PATCH /api/v1/admin/keys/:id` — 啟用 / 停用

```json
{ "enabled": false }
```

停用會同步刪除 Redis 的 `dvd:key:{hash}` 快取，立即生效。

### 5.4 `DELETE /api/v1/admin/keys/:id` — 刪除 Key

### 5.5 `POST /api/v1/admin/services` / `PATCH /api/v1/admin/services/:id`

維護服務註冊資料（欄位見 [DB_SCHEMA §2.1](./DB_SCHEMA.md)）。

### 5.6 `POST /api/v1/admin/topology/reload` — 重載拓樸設定

從 `backend/config/topology.json` 重新匯入 `services` 與 `topology`，不需重啟容器。

```json
{ "success": true, "data": { "services": 12, "edges": 15, "removed": 0 } }
```

---

## 6. 平台自身健康

### 6.1 `GET /health` — 免認證

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "uptimeSec": 86400,
    "version": "1.0.0",
    "deps": {
      "mongo": { "ok": true, "latencyMs": 3 },
      "redis": { "ok": true, "latencyMs": 1 }
    },
    "queue": { "pendingMongoWrites": 0, "sseConnections": 2 }
  }
}
```

Mongo 或 Redis 任一不通時 `status: "degraded"`，但**仍回 HTTP 200** —— 避免探測工具因為 5xx 就把整個容器判死重啟，實際上此時 Ingest 還能運作。

---

## 7. 被監控服務需提供的端點

平台的 Pull 探測會呼叫各服務的健康端點，**唯一要求是回 HTTP 2xx**，body 格式不限。

| 服務 | 探測 URL | 現況 |
|------|----------|------|
| GigaSolarKnowledgeBase | `http://{host}:5155/health` | ✅ 已有 |
| BPM backend | `http://{host}:5149/health` | 待確認 |
| GeneralBackend | `http://{host}:5123/health` | 待確認 |
| NotesAPP backend | `http://{host}:5121/health` | 待確認 |
| DockerAutomatedScheduling | 既有 Health Check API | 待確認 |

未提供 `/health` 的服務，在 `topology.json` 中設 `monitor.enabled: false`，只靠 Push 心跳判定存活 —— SDK 會自動送心跳，所以不做任何事也能運作。

---

## 8. 版本策略

- 路徑帶 `v1`，破壞性變更才升 `v2`，新增欄位不升版
- Ingest 格式**向後相容優先**：平台永遠接受少欄位的舊版 payload，缺的欄位補預設值。理由是五個服務不會同時升級 SDK，不能因為平台改版就讓某個服務的回報全被拒
