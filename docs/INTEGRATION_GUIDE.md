# 接入手冊(Integration Guide)

> 對象:要把服務接到 giga-observe 的工程師。**改了回報格式(Ingest API)必須同步更新本文件**(AGENT.md §9.10)。
> giga-observe 只監控 GigaNexus 新架構的服務;MES、NotesAPP、BPM 等舊系統繼續用原本的 DevOpsDiagram(MONITORING-PLAN D11),不要雙送。

---

## 0. 三分鐘版本(Node.js / Fastify)

1. 向 Gateway 負責人申請:服務代碼(= Gateway 上游代碼)、giga-observe ingest Key(測試區、正式區各一把)、登錄到拓樸。
2. 安裝 SDK(公司 GitLab npm Registry,`.npmrc` 見 Gateway BACKEND-GUIDE §11.6):`npm install @giganexus/backend-sdk`
3. 在路由之前註冊:

```ts
import { loadGatewayEnv, loadMonitorEnv } from '@giganexus/backend-sdk';
import { setupGateway } from '@giganexus/backend-sdk/fastify';

const gateway = loadGatewayEnv();
await app.register(setupGateway, { env: gateway, monitor: loadMonitorEnv(gateway.gwEnv), version: process.env.npm_package_version });
```

4. 部署設定 `MONITOR_URL=http://observe-api:51202`、`MONITOR_API_KEY_FILE=/run/secrets/monitor_api_key`。
5. 到 GigaItApp「架構觀測」確認節點變成「正常」、紀錄有資料。

完整說明(步驟記錄、自報錯誤、排程、環境變數):Gateway **BACKEND-GUIDE §11**;範例:`giga-api-gateway-bff/samples/node-backend`、`GigaItApp/backend`(itapp-api)。

## 1. Key 與服務代碼

| 項目 | 說明 |
| --- | --- |
| serviceId | 由 **Key 決定**,不採信回報內容;= Gateway 上游代碼(例 `itapp-api`) |
| scope | 一般服務用 `ingest`;前端事件只接受 BFF 的 `ingest-web` Key |
| 部署區 | 測試區、正式區各一套 giga-observe、各一把 Key,**不可跨區送** |
| 未登錄拓樸 | 照收,但架構圖不顯示,頁面會提示「有服務在回報但未登錄」 |

## 2. 前端(Vue)

```ts
import { installMonitor } from '@giganexus/web-kit';
installMonitor({ app: '<前端服務代碼>', router, vueApp: app, release: import.meta.env.VITE_RELEASE, enabled: import.meta.env.PROD });
```

前端不持有 Key:事件送到 BFF `POST /api/telemetry/web`,BFF 補上 IP 與使用者後轉送。`app` 必須是拓樸中 `type: frontend` 的服務代碼。

## 3. 不用 Node.js 的服務(直接呼叫 Ingest API)

所有請求帶 `X-API-Key: <ingest Key>`,`Content-Type: application/json`。回 202 表示收下(非同步寫入);401 / 403 檢查 Key;429 表示超過限流,**丟棄不要重送**。

### 3.1 心跳 `POST /api/v1/heartbeat`(每 30 秒)

```json
{ "ts": "2026-10-06T08:00:00.000Z", "version": "1.2.0", "uptimeSec": 86400,
  "deps": [{ "name": "mssql", "ok": true, "latencyMs": 8 }] }
```

全部欄位可省略;90 秒沒有心跳(也沒有探測成功)即顯示「失聯」。

### 3.2 紀錄 `POST /api/v1/ingest/logs`(批次,一次最多 100 筆)

```jsonc
{ "logs": [{
  "ts": "2026-10-06T08:00:00.000Z",          // 必填
  "level": "info",                            // 必填:info / warn / error(error 一律永久保存)
  "kind": "http",                             // http / job
  "traceId": "<X-Request-Id>",                // Gateway 傳下來的 X-Request-Id,串接 BFF / Nginx / 前端
  "request": { "method": "GET", "path": "/v1/items/42", "pathTemplate": "/v1/items/:id",   // method、path 必填
               "query": {}, "body": null, "headers": {}, "ip": "10.10.112.50", "userId": "S112009" },
  "actions": [{ "seq": 1, "type": "db", "target": "mssql.items", "durationMs": 12, "note": "select", "ok": true }],
  "response": { "status": 200, "durationMs": 34, "body": null },   // status、durationMs 必填
  "error": null,                                                    // { name, message, stack, code }
  "meta": { "routeCode": "mes.item.read" }                          // 選填:平面的字串 / 數字 / 布林,最多 20 個
}] }
```

- **pathTemplate** 一定要填(例 `/v1/items/:id`),否則錯誤聚合會以實際路徑分組。
- 敏感欄位請先遮罩;平台也會再遮罩 password、token、secret、authorization、cookie 等欄位。
- 成功的 body 只存前 1 KB;錯誤存完整(32 KB 截斷,90 天後裁成 1 KB 摘要)。

### 3.3 鐵則(自己實作時必須做到)

1. **非同步**:紀錄進記憶體佇列,批次送出,不在請求路徑上等網路
2. **逾時 1 秒**:平台慢不能拖慢服務
3. **失敗不影響服務**:送不出去保留重送,緩衝滿了丟最舊的;只寫 warn,不拋錯

### 3.4 只做探測(完全不改程式)

服務提供 `GET /healthz`(2xx 即可),在拓樸填 `monitor.healthUrl`;平台每 30 秒探測。只會有存活狀態,沒有紀錄與錯誤。

## 4. 平台內部的回報(參考)

| 來源 | API | 說明 |
| --- | --- | --- |
| nginx-log-agent | `POST /api/v1/ingest/traffic` | `{ minutes: [{ ts, total, status: { "2xx": n }, codes: { "429": n }, bytes, avgMs, p95Ms, uniqueIps, topIps: [{ ip, count, errors, denied }], topPaths: [{ path, count, errors }], realIp }] }`;同一分鐘重送會覆蓋,不重複計算 |
| BFF(前端事件轉送) | `POST /api/v1/ingest/web-events` | scope `ingest-web`;`{ events: [{ app, type: error/api/vital/view, ts, page, route, … }] }`,一次最多 100 筆 |

## 5. 驗證接入成功

1. 服務啟動日誌沒有「giga-observe 認證失敗」。
2. GigaItApp「架構觀測 › 架構圖」該節點為「正常」,詳情顯示版本與最後心跳。
3. 打一支 API 後,「紀錄」查得到(可用 Request ID 搜尋)。

## 6. 常見問題

| 問題 | 回答 |
| --- | --- |
| 平台掛了會怎樣? | 服務不受影響;SDK 送不出去只丟監控資料 |
| dev(本機)要開監控嗎? | 預設關閉;要試送設 `MONITOR_ENABLED=true` 並指向本機 giga-observe(`npm run dev:local`) |
| 4xx 算錯誤嗎? | 不算(不影響狀態);在錯誤頁可篩選 4xx,保留 7 天 |
| 想多記一些欄位? | 用 `meta`(平面欄位)或 `req.monitor.action()` 記步驟;不要把整個物件塞進 body |
