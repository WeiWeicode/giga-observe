# 接入手冊 (Integration Guide)

> **這份文件是給各服務後端開發者看的。**
> 目標：讓你的服務把 API 紀錄與心跳回報到 DevOpsDiagram，之後就能在架構圖上看到自己的服務狀態與錯誤。
> 預計花費時間：**10 分鐘**。

**文件版本**：v1.0 ｜ **建立日期**：2026-09-18 ｜ **適用**：Node.js + Express

---

## 0. 三分鐘版本

```bash
# 1. 安裝
npm install devops-reporter --registry http://10.10.130.122:4873   # 或直接複製 lib 目錄
```

```javascript
// 2. app 入口，放在所有路由「之前」
const { reporter } = require('devops-reporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,   // http://10.10.130.122:5132
  apiKey:    process.env.DEVOPS_API_KEY,    // 跟平台維護者要
  serviceId: 'gigaks-backend',
}));
```

```ini
# 3. .env
DEVOPS_ENDPOINT=http://10.10.130.122:5132
DEVOPS_API_KEY=dvd_devops_gigaks-backend_xxxxxxxx
```

完成。重啟服務後，到 `http://10.10.112.13:5131` 應該就能看到你的節點變綠。

需要更細的控制（記錄執行動作、排程服務、不用 Express）再往下看。

---

## 1. 開始之前

### 1.1 取得 API Key

跟平台維護者索取，告知：

- **服務代號**（`serviceId`）：小寫英數與連字號，例如 `gigaks-backend`、`bpm-backend`、`notesapp-backend`
- **用途**：正式環境 / 測試環境（建議各發一組）

你會拿到一組長這樣的 Key：

```
dvd_devops_gigaks-backend_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

> 💡 **平台維護者建立 Key 指令（生產環境執行）**：
> ```bash
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service bpm-backend --scope ingest --label "BPM後端"
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service general-backend --scope ingest --label "共用後端"
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service general-filebackend --scope ingest --label "檔案服務"
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service general-smbbackend --scope ingest --label "SMB服務"
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service notesapp-backend --scope ingest --label "NotesAPP後端"
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service das-scheduler --scope ingest --label "自動排程"
> docker exec -it dvd-backend node src/scripts/createApiKey.js --service mes-backend --scope ingest --label "MES後端"
> ```
>
> ⚠️ **這組 Key 只會顯示一次**，請立刻存進你的 `.env`。弄丟就重發一組，舊的停用。
> ⚠️ **不要 commit 進 git**，比照現有的 `.env` 處理方式。

### 1.2 這組 Key 能做什麼

只能**寫入你自己服務的紀錄**（scope: `ingest`）。它不能讀資料、不能看別的服務、不能連資料庫。即使外洩，影響範圍也只是有人可以偽造你的服務紀錄。

### 1.3 你不需要做的事

- ❌ 不需要連 MongoDB 或 Redis（平台不對外開放這兩個 port）
- ❌ 不需要自己寫心跳排程（SDK 內建）
- ❌ 不需要自己遮蔽密碼欄位（SDK 內建，平台端還會再遮一次）
- ❌ 不需要擔心平台掛掉會影響你（見 §6）

---

## 2. Express 接入

### 2.1 最小接法

```javascript
const express = require('express');
const { reporter } = require('devops-reporter');

const app = express();

app.use(cors());
app.use(express.json());

// ── DevOps 回報：一定要放在「路由之前」、「body parser 之後」 ──
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: 'gigaks-backend',
  version:   require('../package.json').version,
}));

app.use('/api/v1/articles', require('./routes/articles'));
// ...
```

**為什麼要放在 body parser 之後**：SDK 要記錄 request body，`express.json()` 沒跑過的話 `req.body` 是空的。

**為什麼要放在路由之前**：middleware 是按註冊順序執行的，放在路由之後就攔不到請求。

### 2.2 完整設定

```javascript
app.use(reporter({
  // ── 必填 ──
  endpoint:  'http://10.10.130.122:5132',
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: 'gigaks-backend',

  // ── 選填，以下都是預設值 ──
  version:        null,        // 服務版本，會顯示在架構圖上
  enabled:        true,        // false 可整個關閉，方便本機開發
  flushIntervalMs: 5000,       // 幾毫秒送一次
  batchSize:      50,          // 滿幾筆就立刻送
  bufferSize:     500,         // 送不出去時最多緩衝幾筆
  timeoutMs:      1000,        // 送出的逾時
  heartbeatSec:   30,          // 心跳間隔，設 0 關閉

  // 不想記錄的路徑（正則或字串前綴）
  ignorePaths:    ['/health', '/uploads', /^\/static/],

  // 只記錄錯誤（量太大時可開）
  errorOnly:      false,

  // 成功請求抽樣率，1 = 全記，0.1 = 只記 10%
  sampleRate:     1,

  // 額外要遮蔽的欄位名（預設已含 password/token/authorization/apikey/secret）
  maskFields:     ['idNumber', 'phone'],

  // 回報自身依賴狀態，隨心跳一起送
  deps: async () => [
    { name: 'mssql', ok: await checkMssql(), latencyMs: 8 },
    { name: 'mongo', ok: await checkMongo(), latencyMs: 3 },
  ],
}));
```

### 2.3 記錄「後端做了什麼」

架構圖上能看到 API 呼叫了，但要看出「這支 API 慢在哪一步」，需要你主動標記：

```javascript
// controllers/articleController.js
exports.createArticle = async (req, res) => {
  const t1 = Date.now();
  const article = await Article.create(req.body);
  req.devops?.action('db', 'mssql.articles', Date.now() - t1, 'insert 1 row');

  const t2 = Date.now();
  await ragSyncService.push(article.id);
  req.devops?.action('http', 'qdrant:6333', Date.now() - t2, 'rag sync');

  res.json({ success: true, data: article });
};
```

`action(type, target, durationMs, note)`：

| 參數 | 說明 |
|------|------|
| `type` | `db` / `http` / `cache` / `file` / `mq` / `other` |
| `target` | 對象，例如 `mssql.articles`、`http://10.10.130.45:53020/api` |
| `durationMs` | 耗時，可省略 |
| `note` | 自由描述 |

**用 `req.devops?.` 的可選鏈**：這樣即使哪天你把 reporter 關掉（`enabled: false`），這些呼叫也不會噴錯。

**建議標記的地方**：DB 查詢、呼叫外部 API、檔案讀寫、寄信。不用每一行都標，標「可能會慢」的地方就好。

### 2.4 標記業務層錯誤

HTTP 回 200 但業務邏輯其實失敗的情況（例如同步失敗但為了前端體驗仍回 200），平台預設看不出來。主動標記：

```javascript
try {
  await ragSyncService.push(article.id);
} catch (err) {
  req.devops?.error(err, 'RAG 同步失敗，但文章已建立');
  // 仍然回 200
  return res.json({ success: true, data: article, warning: 'RAG 同步失敗' });
}
```

標記後這筆會進 **永久保存**的 `error_logs`，即使 HTTP 是 200。

### 2.5 錯誤處理中介層

SDK 會自動攔截 `next(err)` 傳下來的錯誤。你原本的錯誤處理不用改，只要確保 reporter 註冊在它之前：

```javascript
app.use(reporter({ ... }));       // ← 先
app.use('/api/v1/articles', ...);
app.use((err, req, res, next) => { // ← 後，原本的錯誤處理不用動
  console.error('Server Error:', err);
  res.status(err.status || 500).json({ success: false, message: err.message });
});
```

---

## 3. 排程服務接法（DockerAutomatedScheduling）

排程沒有 HTTP 請求，改用 `reportJob()`，一次執行回報一筆：

```javascript
const { reportJob } = require('devops-reporter');

async function runContractExpiryNotify(trigger = 'cron') {
  const job = reportJob({
    name:    'contractExpiryNotify',
    trigger,                          // 'cron' | 'manual'
    cronExpr: '0 9 15,28 * *',
    params:  { daysAhead: 60 },
  });

  try {
    const t1 = Date.now();
    const contracts = await queryExpiringContracts(60);
    job.action('db', 'mssql.contracts', Date.now() - t1, `找到 ${contracts.length} 筆`);

    const t2 = Date.now();
    await sendMail(contracts);
    job.action('other', 'smtp', Date.now() - t2, `寄出 ${contracts.length} 筆`);

    await job.success({ processed: contracts.length, sent: 1 });
  } catch (err) {
    await job.fail(err);              // 進 error_logs 永久保存
    throw err;
  }
}
```

排程的執行紀錄與 API 紀錄用同一套資料模型，所以在前端是同一個紀錄面板、同一個錯誤頁，不需要另外找地方看。

---

## 4. 不用 Express / 不用 Node 的服務

SDK 只是幫你組 HTTP 請求，你也可以直接打。

### 4.1 心跳（最低限度的接入）

只要做這一件事，你的服務就會在架構圖上顯示為存活：

```bash
curl -X POST http://10.10.130.122:5132/api/v1/heartbeat \
  -H "X-API-Key: dvd_devops_your-service_xxxx" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.0.0"}'
```

每 30 秒打一次即可（**超過 90 秒沒收到就會判定為 down**）。body 全部可省略，`-d '{}'` 也可以。

### 4.2 回報紀錄

```bash
curl -X POST http://10.10.130.122:5132/api/v1/ingest/logs \
  -H "X-API-Key: dvd_devops_your-service_xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [{
      "ts": "2026-09-18T08:00:00.000Z",
      "level": "info",
      "kind": "http",
      "request":  { "method": "POST", "path": "/api/orders", "ip": "10.10.112.50" },
      "response": { "status": 200, "durationMs": 134 }
    }]
  }'
```

必填欄位只有：`ts`、`level`、`request.method`、`request.path`、`response.status`、`response.durationMs`。完整欄位見 [API_CONTRACT.md §2](./API_CONTRACT.md)。

### 4.3 只做 Pull 探測（完全不改程式）

如果你的服務暫時不想動任何程式碼，只要它有一個回 2xx 的健康端點，告訴平台維護者該網址，平台會每 30 秒主動探測。架構圖上一樣看得到綠燈，只是看不到 API 紀錄與錯誤明細。

GigaSolarKnowledgeBase 已有 `GET /health`，可直接用。

---

## 5. 敏感資料處理

### 5.1 自動遮蔽

欄位名（不分大小寫）包含以下字樣者，值一律變成 `***`，遞迴處理巢狀物件：

`password`、`passwd`、`token`、`authorization`、`apikey`、`api_key`、`secret`、`credential`

```javascript
// 你的 request body
{ "account": "S112009", "password": "abc123", "profile": { "token": "eyJhbG..." } }

// 平台上看到的
{ "account": "S112009", "password": "***",    "profile": { "token": "***" } }
```

### 5.2 需要額外遮蔽的

身分證號、電話、地址這類欄位名不在預設清單中，請自行加：

```javascript
maskFields: ['idNumber', 'phone', 'address', 'bankAccount']
```

### 5.3 檔案上傳

`multipart/form-data` 只記錄檔名、大小、MIME type，**不記錄檔案內容**，不需要你做任何事。

### 5.4 Headers

只保留白名單：`content-type`、`user-agent`、`referer`、`x-request-id`。`Authorization` 與 Cookie **完全不會被送出**。

---

## 6. 平台掛掉會怎樣？

**不會影響你的服務。** 三道機制：

| 機制 | 說明 |
|------|------|
| **非同步** | 紀錄先進記憶體佇列，回應早就送給使用者了才批次送出。不在請求路徑上 |
| **1 秒逾時** | 送給平台的 HTTP 請求逾時 1 秒，逾時即放棄 |
| **緩衝 + 丟棄** | 送不出去的保留在記憶體（上限 500 筆）等下一輪重送；滿了就丟最舊的並在 console 印一行警告 |

最壞情況是「這段時間的紀錄遺失」，你的服務照常運作。

實測開銷：單次請求增加約 **0.3ms**（組 payload + 推進陣列），不含任何網路等待。

---

## 7. 驗證接入成功

### 7.1 檢查清單

```bash
# 1. Key 有效嗎
curl -X POST http://10.10.130.122:5132/api/v1/heartbeat \
  -H "X-API-Key: $DEVOPS_API_KEY" -H "Content-Type: application/json" -d '{}'
# 預期：{"success":true,"data":{"serviceId":"...","status":"healthy",...}}

# 2. 平台活著嗎
curl http://10.10.130.122:5132/health
```

| 現象 | 原因 | 處理 |
|------|------|------|
| 401 `MISSING_API_KEY` | 沒帶 header | 檢查 `.env` 有沒有被讀到（`require('dotenv').config()` 是否在最前面） |
| 401 `INVALID_API_KEY` | Key 錯或已停用 | 跟平台維護者確認 |
| 403 `INSUFFICIENT_SCOPE` | 拿 `read` Key 去寫 | 要一組 `ingest` Key |
| 節點是灰色 `unknown` | 從未收到回報 | 服務沒啟動，或 `serviceId` 拼錯（大小寫敏感） |
| 節點是紅色 `down` | 超過 90 秒沒心跳 | 檢查服務是否還活著、網路是否通 |
| 有心跳但沒有 API 紀錄 | middleware 註冊順序錯 | 確認在路由之前、body parser 之後 |
| body 是空的 | 註冊在 `express.json()` 之前 | 調整順序 |

### 7.2 到前端確認

開 `http://10.10.112.13:5131`：

1. 架構圖上找到你的節點 → 應該是**綠色**
2. 點節點 → 側邊面板應該看得到「最後心跳」時間在 30 秒內
3. 對你的服務打幾支 API → 面板的「紀錄」分頁應該在 5 秒內出現
4. 故意打一支會 500 的 API → 應該出現在「錯誤」分頁，且節點可能轉黃（錯誤率超過 5%）

---

## 8. 常見問題

**Q：我的服務流量很大，全記會不會太多？**
先開 `sampleRate: 0.1`（成功的只記 10%）。**錯誤永遠 100% 記錄，不受抽樣影響** —— 抽樣只作用在成功請求上。

**Q：我不想記某些路徑（例如檔案下載）**
`ignorePaths: ['/uploads', /^\/static/]`。健康檢查端點預設就已排除。

**Q：本機開發時不想回報**
`enabled: process.env.NODE_ENV === 'production'`，或乾脆不要在 `.env` 放 `DEVOPS_API_KEY`（沒 Key 時 SDK 會自動停用並印一行提示）。

**Q：測試環境和正式環境要分開嗎？**
建議各發一組 Key、各用一個 `serviceId`（例如 `gigaks-backend` 與 `gigaks-backend-dev`），這樣架構圖上分得開。

**Q：紀錄會保留多久？**
一般紀錄 **7 天**自動刪除；錯誤紀錄（5xx 與你主動標記的）**永久保存**。所以查半年前的錯誤是查得到的，查半年前的成功請求則查不到。

**Q：`pathTemplate` 是什麼，一定要填嗎？**
Express 版 SDK 會自動從 `req.route.path` 取得（例如 `/api/v1/articles/:id`）。它讓錯誤頁能把 `/articles/1`、`/articles/2` 聚合成同一支 API。手寫回報時建議填，不填的話聚合會失準。

**Q：我可以查別人服務的資料嗎？**
你的 `ingest` Key 不行。前端頁面（維運人員用）看得到全部。

**Q：可以不改程式就接上嗎？**
可以，見 §4.3，只做 Pull 探測。代價是只有存活狀態，沒有 API 紀錄。

**Q：SDK 從哪拿？**
`backend/sdk/` 目錄下，可以複製整個資料夾進你的專案（無外部相依，只用 Node 內建模組）。

---

## 9. 各服務要做什麼

### 9.1 總覽

| 服務 | serviceId | 要做的事 | 狀態 |
|------|-----------|----------|------|
| GigaSolarKnowledgeBase 後端 | `gigaks-backend` | 已完成 | ✅ 本機 + 生產已驗證 |
| BPM 後端 | `bpm-backend` | 已完成 | ✅ 本機已驗證 |
| GeneralBackend | `general-backend` | 已完成 | ✅ 本機已驗證 |
| GeneralBackend 檔案服務 | `general-filebackend` | 已完成 | ✅ 本機已驗證 |
| GeneralBackend SMB 服務 | `general-smbbackend` | 已完成 | ✅ 本機已驗證 |
| NotesAPP 後端 | `notesapp-backend` | 已完成 | ✅ 本機已驗證 |
| DockerAutomatedScheduling | `das-scheduler` | 已完成 | ✅ 本機已驗證（含排程紀錄） |
| 四個純前端 / 靜態服務 | `gigaks-frontend` `notesapp-frontend` `bpm-component` `bpm-cdn` | **不用改任何程式**（§9.7） | 待啟用探測 |

### 9.2 每個後端服務的共同四步

不論哪個服務，都是這四步，**不需要改動任何既有的路由或錯誤處理**：

| # | 動作 | 說明 |
|---|------|------|
| 1 | 跟平台維護者要一把 `ingest` Key | 告知你的 serviceId |
| 2 | 複製 SDK 檔案進專案 | `backend/sdk/index.js` → 你的專案（路徑見各服務說明） |
| 3 | 註冊 middleware | 在 `express.json()` **之後**、所有路由**之前**，約 7 行 |
| 4 | `.env` 補三個變數 + `docker-compose.yml` 補 `extra_hosts` | 見下方 |

`.env` 三個變數（所有服務都一樣，只有 `DEVOPS_SERVICE_ID` 不同）：

```ini
DEVOPS_ENDPOINT=http://host.docker.internal:5132
DEVOPS_API_KEY=<跟平台維護者要>
DEVOPS_SERVICE_ID=<你的 serviceId>
```

`docker-compose.yml` 在你的服務底下加：

```yaml
    extra_hosts:
      - 'host.docker.internal:host-gateway'   # 讓容器打得到宿主機的 5132
```

最後 `docker compose up -d --build <你的服務>`。

> **相容性已實測**：SDK 在 Express **4.18 / 4.19 / 5.1.0** 上都驗證過，8 項檢查（pathTemplate、遮蔽、錯誤標記、action 記錄、query 保留、平台不可用時不影響原服務等）全部通過。GeneralBackend 與 NotesAPP 用的是 Express 5，不需要任何特別處理。

> **沒設 `DEVOPS_API_KEY` 的話 SDK 會自動停用**，服務照常運作 —— 所以這幾步做錯不會弄壞既有服務。

### 9.3 BPM 後端（`bpm-backend`）

| 項目 | 內容 |
|------|------|
| 專案路徑 | `D:\檔案分享\程式碼\BPM\BPMbackend` |
| 進入點 | `app.js`（Express 4.18，CommonJS） |
| SDK 放哪 | `lib/devopsReporter.js`（`app.js` 同層建 `lib/` 資料夾） |
| 插在哪 | `app.js` 第 24 行 `app.use(express.json({ limit: '50mb' }))` **之後**、第 30 行 `app.use('/', routeRouter)` **之前** |
| docker-compose | `BPM/docker-compose.yml` 的 `bpmbackend` 服務下加 `extra_hosts` |
| `/health` | **目前沒有**，見 §9.8 |

```javascript
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: 'bpm-backend',
  version:   require('./package.json').version,
}));
```

### 9.4 GeneralBackend 三個服務

三個服務做法完全相同，只有 `serviceId` 與路徑不同。

| 服務 | serviceId | 專案路徑 | 插在哪 |
|------|-----------|----------|--------|
| 共用後端 | `general-backend` | `GeneralBackend\backend` | `index.js` 第 42 行 `app.use(express.json())` 之後、第 69 行 `app.use('/v1/', routeRouter)` 之前 |
| 檔案服務 | `general-filebackend` | `GeneralBackend\filebackend` | `index.js` 第 27 行之後、第 35 行 `app.use('/', routes)` 之前 |
| SMB 服務 | `general-smbbackend` | `GeneralBackend\SMBbackend` | `index.js` 第 22 行之後、第 32 行 `app.use('/api', apiRoutes)` 之前 |

- Express 5.1.0，已實測相容
- SDK 放 `lib/devopsReporter.js`
- `GeneralBackend/docker-compose.yml` 三個服務各自加 `extra_hosts`
- 檔案服務建議加上 `ignorePaths: ['/health', '/download']` 之類的設定，避免大量檔案傳輸都被記錄

### 9.5 NotesAPP 後端（`notesapp-backend`）

| 項目 | 內容 |
|------|------|
| 專案路徑 | `D:\檔案分享\程式碼\NotesAPP\NotesAppBackend` |
| 進入點 | `index.js`（Express 5.1.0） |
| SDK 放哪 | `lib/devopsReporter.js` |
| 插在哪 | 第 13 行 `app.use(express.json())` 之後、第 40 行 `app.use('/v1/', routeRouter)` 之前 |
| docker-compose | `NotesAPP/docker-compose.yml` 的 `notesappbackend` 加 `extra_hosts` |
| `/health` | **目前沒有**，見 §9.8 |

### 9.6 DockerAutomatedScheduling（`das-scheduler`）

這個服務比較特別，**有兩部分**：

**(a) HTTP API 部分** —— 和其他服務一樣掛 middleware：

| 項目 | 內容 |
|------|------|
| 專案路徑 | `D:\檔案分享\程式碼\DockerAutomatedScheduling\AutomatedSchedulingBackend` |
| 進入點 | `src/app.js`（Express 4.19） |
| 插在哪 | 第 22 行 `app.use(express.urlencoded(...))` 之後、第 25 行 `app.use('/health', healthRouter)` 之前 |
| `/health` | **已經有了** ✅，探測可直接啟用 |
| docker-compose | 專案目前沒有 docker-compose.yml，依實際部署方式調整 endpoint |

**(b) 排程執行部分** —— 這才是重點。每個 job 用 `reportJob()` 包起來，一次執行記一筆：

```javascript
const { reportJob } = require('../lib/devopsReporter');

async function runContractExpiryNotify(trigger = 'cron') {
  const job = reportJob({
    name: 'contractExpiryNotify',
    trigger,                        // 'cron' | 'manual'
    cronExpr: '0 9 15,28 * *',
  });

  try {
    const t1 = Date.now();
    const contracts = await queryExpiringContracts(60);
    job.action('db', 'mssql.contracts', Date.now() - t1, `找到 ${contracts.length} 筆`);

    const t2 = Date.now();
    await sendMail(contracts);
    job.action('other', 'smtp', Date.now() - t2, `寄出 ${contracts.length} 筆`);

    await job.success({ processed: contracts.length });
  } catch (err) {
    await job.fail(err);            // 進 error_logs 永久保存
    throw err;
  }
}
```

這樣「昨天的合約到期通知有沒有跑成功」就能在平台上直接查到，失敗還會讓節點在架構圖上轉紅。

### 9.7 純前端 / 靜態服務：完全不用動

`gigaks-frontend`、`notesapp-frontend`、`bpm-component`、`bpm-cdn` 這四個是 Nginx 靜態站，**不需要改任何程式、不需要 API Key**。

平台會每 30 秒主動打它們的首頁，只要回 2xx 就判定存活。要做的只有一件事，而且是**平台維護者做，不是服務owner做**：在 `backend/config/topology.json` 把該服務的 `monitor.enabled` 改成 `true`，然後呼叫 `POST /api/v1/admin/topology/reload`。

代價是只看得到「活著沒有」，沒有 API 紀錄與錯誤明細 —— 對純靜態站來說這樣就夠了。

### 9.8 關於 `/health` 端點

目前 **BPM 後端、GeneralBackend 三個服務、NotesAPP 後端都沒有 `/health`**（GigaKS 與 DAS 有）。

這不影響接入 —— SDK 會自動每 30 秒送 Push 心跳，存活判定照樣運作。`/health` 只是多一層保險：**當服務整個掛掉、連 Push 心跳都發不出來時**，平台還能靠主動探測確認。

要加的話很簡單，加在所有路由之前：

```javascript
app.get('/health', (req, res) => {
  res.json({ success: true, timestamp: new Date().toISOString() });
});
```

加完告訴平台維護者，把 `topology.json` 該服務的 `monitor.enabled` 打開即可。**只要求回 2xx，body 格式不限。**

### 9.9 接入後怎麼確認成功

1. 重啟服務後等 60 秒
2. 開 `http://<平台位址>:5131`，在架構圖上找到你的節點 → 應該是**綠色**
3. 點節點 → 「最後心跳」應在 30 秒內
4. 對你的服務打幾支 API → 「紀錄」分頁應在 5 秒內出現

沒成功的話對照 §7.1 的故障排除表，最常見的是 middleware 註冊順序錯（放到路由後面了）。

---

## 10. 有問題找誰

- **要 Key、服務沒出現在架構圖上、拓樸圖要改** → 平台維護者
- **SDK 有 bug、想要新功能** → 開 issue 或直接找平台維護者
- **相關文件** → [API_CONTRACT.md](./API_CONTRACT.md)（完整 API 規格）、[DB_SCHEMA.md](./DB_SCHEMA.md)（資料欄位定義）


