# 各服務接入程式碼（照抄即可）

> **這份是給各服務後端開發者的，照著複製貼上就能完成接入。**
> 每個服務的程式碼片段都已對照你們專案裡的實際內容標好位置。
> 原理與進階用法見 [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)。

**文件版本**：v1.0 ｜ **建立日期**：2026-09-18

---

## 0. 開始之前

### 0.1 跟平台維護者要一把 Key

告知你的服務代號（下表的 serviceId），會拿到一把長這樣的 Key：

```
dvd_devops_<serviceId>_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

⚠️ **只會顯示一次**，立刻存進 `.env`，**不要 commit 進 git**。

### 0.2 SDK 檔案在哪

```
D:\檔案分享\程式碼\DevOpsDiagram\backend\sdk\index.js
```

單一檔案、無外部相依（只用 Node 內建模組），直接複製即可。

### 0.3 每個服務的四樣東西

| 服務 | serviceId | SDK 複製到 | Dockerfile 要加 |
|------|-----------|-----------|----------------|
| BPM 後端 | `bpm-backend` | `BPMbackend\lib\devopsReporter.js` | ✅ 要加 |
| 共用後端 | `general-backend` | `GeneralBackend\backend\lib\devopsReporter.js` | ✅ 要加 |
| 檔案服務 | `general-filebackend` | `GeneralBackend\filebackend\lib\devopsReporter.js` | ✅ 要加 |
| SMB 服務 | `general-smbbackend` | `GeneralBackend\SMBbackend\lib\devopsReporter.js` | ✅ 要加 |
| NotesAPP 後端 | `notesapp-backend` | `NotesAppBackend\lib\devopsReporter.js` | ✅ 要加 |
| 自動排程 | `das-scheduler` | `AutomatedSchedulingBackend\src\lib\devopsReporter.js` | ❌ 不用（已是 `COPY . .`） |

### 0.4 ⚠️ 最容易踩的坑：Dockerfile 沒複製 lib 資料夾

**五個服務的 Dockerfile 是逐一列出 `COPY` 路徑的**，例如：

```dockerfile
COPY index.js ./
COPY config/ ./config/
COPY routes/ ./routes/
```

新增的 `lib/` 資料夾**不在清單裡就不會進映像**，服務一啟動就會炸：

```
Error: Cannot find module './lib/devopsReporter'
```

所以除了 DAS 之外，每個服務都要在 Dockerfile 的 COPY 區塊補一行：

```dockerfile
COPY lib/ ./lib/
```

---

## 1. 共通設定（每個服務都一樣）

### 1.1 `.env` 補三行

```ini
# ── DevOps 觀測平台回報 ──────────────────
DEVOPS_ENDPOINT=http://host.docker.internal:5132
DEVOPS_API_KEY=<跟平台維護者要的 Key>
DEVOPS_SERVICE_ID=<你的 serviceId>
```

> 沒設 `DEVOPS_API_KEY` 的話 SDK 會自動停用並在 console 印一行提示，服務照常運作。
> 所以本機開發不想回報時，把這行留空即可。

### 1.2 `docker-compose.yml` 補 `extra_hosts`

在你的服務區塊底下加：

```yaml
    extra_hosts:
      - 'host.docker.internal:host-gateway'   # 讓容器打得到宿主機的 5132
```

### 1.3 重建

```bash
docker compose up -d --build <你的服務名稱>
```

---

## 2. BPM 後端（`bpm-backend`）

**檔案**：`D:\檔案分享\程式碼\BPM\BPMbackend\app.js`

### 2.1 程式碼

找到這段（約第 22~30 行）：

```javascript
// app.use(express.json())
// 增加最大上傳限制
app.use(express.json({ limit: '50mb' }))

app.use(express.urlencoded({ extended: true }))



app.use('/', routeRouter);
```

改成（**中間插入的部分**）：

```javascript
// app.use(express.json())
// 增加最大上傳限制
app.use(express.json({ limit: '50mb' }))

app.use(express.urlencoded({ extended: true }))

// ── DevOps 觀測回報（要在路由之前）──────────────────────
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: process.env.DEVOPS_SERVICE_ID || 'bpm-backend',
  version:   require('./package.json').version,
}));

app.use('/', routeRouter);
```

### 2.2 Dockerfile

`BPMbackend\Dockerfile` 在 `COPY ./router ./router` 附近補一行：

```dockerfile
COPY ./lib ./lib
```

> ⚠️ **BPM 與其他服務有一個重要差異**：`BPMbackend/Dockerfile` 裡有 `COPY ./.env ./`，
> 也就是 **`.env` 是 build 時烤進映像的**（其他服務走 `env_file` 執行期注入）。
> 所以改完 `.env` **一定要 `--build`** 才會生效，單純 `docker compose up -d` 或 `restart` 都不會更新。
> 生產環境更換 API Key 時同樣要重建映像。

### 2.3 docker-compose

`BPM\docker-compose.yml` 的 `bpmbackend` 區塊：

```yaml
  bpmbackend:
    restart: always
    build: ./BPMbackend
    ports:
      - '5149:5149'
    extra_hosts:
      - 'host.docker.internal:host-gateway'
```

---

## 3. 共用後端（`general-backend`）

**檔案**：`D:\檔案分享\程式碼\GeneralBackend\backend\index.js`

### 3.1 程式碼

找到自訂 CORS 標頭那段 middleware 的結尾與路由掛載之間（約第 66~69 行）：

```javascript
  next();
});


app.use('/v1/', routeRouter)
```

改成：

```javascript
  next();
});

// ── DevOps 觀測回報（要在路由之前）──────────────────────
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: process.env.DEVOPS_SERVICE_ID || 'general-backend',
  version:   require('./package.json').version,
}));

app.use('/v1/', routeRouter)
```

### 3.2 Dockerfile

```dockerfile
COPY lib/ ./lib/
```

### 3.3 docker-compose

`GeneralBackend\docker-compose.yml` 的 `general-backend` 區塊加 `extra_hosts`（見 §1.2）。

---

## 4. 檔案服務（`general-filebackend`）

**檔案**：`D:\檔案分享\程式碼\GeneralBackend\filebackend\index.js`

### 4.1 程式碼

找到這段（約第 25~35 行）：

```javascript
// 中間件
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 靜態文件
app.use(express.static(__dirname));

// 導入路由
const routes = require('./routes/route');
app.use('/', routes);
```

改成：

```javascript
// 中間件
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── DevOps 觀測回報（要在路由之前）──────────────────────
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: process.env.DEVOPS_SERVICE_ID || 'general-filebackend',
  version:   require('./package.json').version,
  // 檔案服務流量大且 body 是二進位，排除下載與靜態檔
  ignorePaths: ['/health', '/download', '/upload.html', '/sql-upload.html'],
}));

// 靜態文件
app.use(express.static(__dirname));

// 導入路由
const routes = require('./routes/route');
app.use('/', routes);
```

> 檔案上傳的 `multipart/form-data` SDK 只會記錄檔名、大小與 MIME type，**不會記錄檔案內容**，不用擔心把檔案塞進資料庫。

### 4.2 Dockerfile 與 docker-compose

同 §3.2 / §3.3，服務名稱換成 `general-filebackend`。

---

## 5. SMB 服務（`general-smbbackend`）

**檔案**：`D:\檔案分享\程式碼\GeneralBackend\SMBbackend\index.js`

### 5.1 程式碼

找到這段（約第 21~32 行）：

```javascript
// 中間件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));



// 提供靜態檔案服務
app.use(express.static('.'));

// 根路由 - 顯示 API 資訊
app.use('/api', apiRoutes);
```

改成：

```javascript
// 中間件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));

// ── DevOps 觀測回報（要在路由之前）──────────────────────
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: process.env.DEVOPS_SERVICE_ID || 'general-smbbackend',
  version:   require('./package.json').version,
  ignorePaths: ['/health', '/localdownload', '/file-manager.html', '/upload-test.html'],
}));

// 提供靜態檔案服務
app.use(express.static('.'));

// 根路由 - 顯示 API 資訊
app.use('/api', apiRoutes);
```

### 5.2 Dockerfile 與 docker-compose

同 §3.2 / §3.3，服務名稱換成 `general-smbbackend`。

---

## 6. NotesAPP 後端（`notesapp-backend`）

**檔案**：`D:\檔案分享\程式碼\NotesAPP\NotesAppBackend\index.js`

### 6.1 程式碼

找到自訂 CORS middleware 結尾與路由掛載之間（約第 37~40 行）：

```javascript
  next();
});


app.use('/v1/', routeRouter)
```

改成：

```javascript
  next();
});

// ── DevOps 觀測回報（要在路由之前）──────────────────────
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: process.env.DEVOPS_SERVICE_ID || 'notesapp-backend',
  version:   require('./package.json').version,
}));

app.use('/v1/', routeRouter)
```

### 6.2 Dockerfile

```dockerfile
COPY lib/ ./lib/
```

### 6.3 docker-compose

`NotesAPP\docker-compose.yml` 的 `notesappbackend` 區塊加 `extra_hosts`。

---

## 7. 自動排程服務（`das-scheduler`）

這個服務要改**兩個地方**，但都很小。SDK 放在 `src/lib/devopsReporter.js`，Dockerfile 不用改（它用的是 `COPY . .`）。

### 7.1 HTTP API 部分

**檔案**：`AutomatedSchedulingBackend\src\app.js`

找到這段（約第 19~26 行）：

```javascript
// ── 中介軟體 ──────────────────────────────────────────────
app.use(cors()); // 預設允許所有 Origin
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── 路由掛載 ──────────────────────────────────────────────
app.use('/health',    healthRouter);
```

改成：

```javascript
// ── 中介軟體 ──────────────────────────────────────────────
app.use(cors()); // 預設允許所有 Origin
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── DevOps 觀測回報（要在路由之前）──────────────────────
const { reporter } = require('./lib/devopsReporter');
app.use(reporter({
  endpoint:  process.env.DEVOPS_ENDPOINT,
  apiKey:    process.env.DEVOPS_API_KEY,
  serviceId: process.env.DEVOPS_SERVICE_ID || 'das-scheduler',
  version:   require('../package.json').version,
}));

// ── 路由掛載 ──────────────────────────────────────────────
app.use('/health',    healthRouter);
```

### 7.2 排程執行部分（重點）

你們的 `scheduler/index.js` 有一個 `runJob()` 是所有排程的**共同入口**（cron 觸發與 API 手動觸發都走它），所以**只要包這一個函式，所有 job 就自動有紀錄** —— 不用改任何 Controller，日後在 registry 新增的排程也會自動涵蓋。

**檔案**：`AutomatedSchedulingBackend\src\scheduler\index.js`

找到 `runJob()` 開頭（約第 99~104 行）：

```javascript
async function runJob(controller, triggerType) {
  const triggeredAt = new Date();
  let result;

  try {
    result = await controller.execute(triggerType);
  } catch (unexpectedErr) {
```

改成：

```javascript
const { reportJob } = require('../lib/devopsReporter');

async function runJob(controller, triggerType) {
  const triggeredAt = new Date();
  let result;

  // 一次排程執行 = 平台上的一筆紀錄
  const devopsJob = reportJob({
    name: controller.jobName,
    trigger: triggerType,
  });

  try {
    result = await controller.execute(triggerType);
  } catch (unexpectedErr) {
```

然後在 `runJob()` 裡、寫入 Log 資料表**之前**（第 116 行 `// 寫入 Log 資料表（即使失敗也要寫入）` 那行上方）加上回報：

```javascript
  // 回報給 DevOps 觀測平台（失敗不影響原流程）
  if (result.success) {
    devopsJob.success({ processingContent: result.processingContent });
  } else {
    devopsJob.fail(
      new Error(result.errorMessage || '排程執行失敗'),
      { processingContent: result.processingContent }
    );
  }

  // 寫入 Log 資料表（即使失敗也要寫入）
  try {
```

這樣就能在平台上直接回答「昨天的合約到期通知有沒有跑成功」，失敗還會讓 `das-scheduler` 節點在架構圖上轉紅。

### 7.3 可選：記錄執行步驟

如果想看出「這次排程慢在哪一步」，可以在 Controller 裡加細節。但因為 `runJob()` 是統一入口，Controller 拿不到 `devopsJob` 物件 —— 最簡單的做法是讓 Controller 在回傳的 `processingContent` 裡帶上步驟摘要，平台端就看得到。

要更細的 `action` 記錄需要調整 Controller 介面，**建議先不做**，等實際有需求再談。

### 7.4 `.env` 與部署

```ini
DEVOPS_ENDPOINT=http://host.docker.internal:5132
DEVOPS_API_KEY=<Key>
DEVOPS_SERVICE_ID=das-scheduler
```

DAS 目前沒有 docker-compose.yml。若是直接跑在主機上（非容器），`DEVOPS_ENDPOINT` 要改成 `http://localhost:5132`。

---

## 8. 可選：加一個 `/health` 端點

目前 **BPM 後端、GeneralBackend 三個服務、NotesAPP 後端都沒有 `/health`**（GigaKS 與 DAS 已經有）。

**這不影響接入** —— SDK 會自動每 30 秒送心跳，存活判定照常運作。`/health` 只是多一層保險：當服務整個掛掉、連心跳都發不出來時，平台還能靠主動探測確認。

要加的話，放在所有路由之前：

```javascript
app.get('/health', (req, res) => {
  res.json({ success: true, timestamp: new Date().toISOString() });
});
```

**只要求回 2xx，body 格式不限。** 加完通知平台維護者把探測打開。

---

## 9. 完成後的驗證

### 9.1 先確認服務本身沒壞

```bash
docker compose logs <你的服務> --tail 30
```

看到 `Cannot find module './lib/devopsReporter'` → Dockerfile 漏了 `COPY lib/`（見 §0.4）。

### 9.2 確認有回報

打幾支自己的 API，等 10 秒，然後開平台前端 `http://<平台位址>:5131`：

| 檢查 | 預期 |
|------|------|
| 架構圖上你的節點 | 綠色 |
| 點節點 → 概況 | 「最後心跳」在 30 秒內 |
| 點節點 → 紀錄 | 出現剛才打的 API |
| 故意打一支會 500 的 | 出現在「錯誤」分頁 |

### 9.3 常見問題

| 現象 | 原因 |
|------|------|
| `Cannot find module './lib/devopsReporter'` | Dockerfile 沒加 `COPY lib/ ./lib/` |
| 節點是灰色 `unknown` | `serviceId` 拼錯，或服務沒啟動 |
| 有心跳但沒有 API 紀錄 | middleware 註冊在路由**後面**了 |
| 紀錄裡 body 是空的 | middleware 註冊在 `express.json()` **前面**了 |
| console 出現「未設定 apiKey，回報已停用」 | `.env` 沒被讀到，或 `DEVOPS_API_KEY` 是空的 |
| 回應 401 `INVALID_API_KEY` | Key 錯或已被停用，跟平台維護者確認 |

---

## 10. 你不需要擔心的事

| 疑慮 | 說明 |
|------|------|
| 會不會拖慢我的服務？ | 不會。紀錄先進記憶體佇列、每 5 秒批次送出，不在請求路徑上等待。實測平台整個停機時，服務回應時間沒有變化 |
| 平台掛掉會怎樣？ | 你的服務完全不受影響。SDK 逾時 1 秒就放棄，失敗的紀錄留在記憶體緩衝（上限 500 筆）等平台回來重送 |
| 會不會把密碼記進去？ | 不會。`password`、`token`、`authorization`、`apiKey`、`secret` 等欄位自動變成 `***`，巢狀物件與陣列也會處理。`Authorization` header 與 Cookie 完全不會送出 |
| 檔案上傳會被記錄嗎？ | 只記檔名、大小、MIME type，不記內容 |
| Express 5 能用嗎？ | 能。4.18 / 4.19 / 5.1.0 都實測過 |
| 要改既有的路由或錯誤處理嗎？ | 不用。只加一段 middleware，其他一字不動 |
| 流量太大怎麼辦？ | 加 `sampleRate: 0.1`（成功請求只記 10%）。**錯誤永遠 100% 記錄**，不受抽樣影響 |

---

## 11. 有問題找誰

- 要 Key、節點沒出現在架構圖上 → 平台維護者
- SDK 有 bug、想要新功能 → 平台維護者
- 更詳細的用法（記錄執行動作、抽樣、自訂遮蔽欄位）→ [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)
