# 系統架構文件 (Architecture)

**專案**：DevOpsDiagram（維運架構觀測平台）
**文件版本**：v1.0
**建立日期**：2026-09-18
**狀態**：已定案
**上游文件**：[PRD.md](./PRD.md)（決策依據見 PRD §12 D-01 ~ D-08）

---

## 1. 架構總覽

```
                        ┌─────────────────────────────────────────┐
  被監控服務            │        DevOpsDiagram (Docker)           │
  ┌──────────────┐      │                                         │
  │ BPM          │      │  ┌───────────────────────────────┐      │
  │ GeneralBE    │──┐   │  │ backend (Node + Express)       │      │
  │ GigaKS       │  │   │  │  :5132  Ingest / Query API     │      │
  │ NotesAPP     │  ├──────▶│  :5133  SSE Stream            │      │
  │ DAS(排程)     │  │   │  │         Pull Prober (cron)    │      │
  └──────────────┘  │   │  │         Status Evaluator      │      │
         ▲          │   │  └────┬────────────────┬─────────┘      │
         │          │   │       │                │                │
         │ GET /health│   │  ┌────▼─────┐    ┌─────▼──────┐        │
         └──────────┴───│  │ MongoDB  │    │  Redis     │        │
        (Pull 探測)      │  │ :27017   │    │  :6379     │        │
                        │  └────┬─────┘    └────────────┘        │
                        │       │  (內部網路，不對外)             │
                        │  ┌────▼──────┐                          │
                        │  │ backup    │ 每日 mongodump           │
                        │  │ (cron)    │ → ./backup/              │
                        │  └───────────┘                          │
                        │                                         │
                        │  ┌───────────────────────────────┐      │
                        │  │ frontend (Nginx + Vue 3)       │      │
                        │  │  :5131                         │      │
                        │  └───────────────────────────────┘      │
                        └─────────────────────────────────────────┘
                                        ▲
                                        │ 生產環境僅允許 10.10.112.13
                                     維運人員瀏覽器
```

資料流有三條：

| # | 流向 | 說明 |
|---|------|------|
| 1 | 被監控服務 → backend:5132 | **Push**：SDK 批次回報 API 紀錄與心跳（主要來源） |
| 2 | backend → 被監控服務 `/health` | **Pull**：每 30 秒主動探測，補 Push 發不出來的情況 |
| 3 | backend:5133 → 前端 | **SSE**：狀態變化即時推播 |

---

## 2. 容器設計

### 2.1 容器清單

| 容器 | Image / Build | 對外 Port | 說明 |
|------|---------------|-----------|------|
| `dvd-frontend` | build `./frontend`（Nginx） | 5131 | Vue 3 靜態站，`dist` 以 volume 掛入，覆蓋即生效 |
| `dvd-backend` | build `./backend`（Node 20） | 5132, 5133 | Ingest / Query / SSE / Prober 全在同一個 process |
| `dvd-mongo` | `mongo:7` | **不對外** | 資料庫，data volume 持久化 |
| `dvd-redis` | `redis:7-alpine` | **不對外** | 快取，啟用 AOF |
| `dvd-backup` | build `./backup`（mongo tools + cron） | — | 每日 03:00 mongodump |

> 沿用現有專案慣例：`restart: unless-stopped`、敏感設定走 `env_file` 不 bake 進 image、前端 `dist` 以 volume 掛載。

### 2.2 docker-compose 骨架

```yaml
services:
  dvd-backend:
    build: ./backend
    container_name: dvd-backend
    env_file: ./backend/.env
    ports:
      - '5132:5132'   # Ingest + Query API
      - '5133:5133'   # SSE
    volumes:
      - ./backend/config:/usr/src/app/config   # 讓 topology reload 免重建（見 §10）
    depends_on: [dvd-mongo, dvd-redis]
    restart: unless-stopped
    networks: [dvd-net]

  dvd-frontend:
    build: ./frontend
    container_name: dvd-frontend
    ports:
      - '5131:5131'
    volumes:
      - ./frontend/dist:/usr/share/nginx/html
    depends_on: [dvd-backend]
    restart: unless-stopped
    networks: [dvd-net]

  dvd-mongo:
    image: mongo:7
    container_name: dvd-mongo
    env_file: ./backend/.env        # MONGO_INITDB_ROOT_*
    volumes:
      - ./data/mongo:/data/db
    # 不宣告 ports → 只在 dvd-net 內可達
    restart: unless-stopped
    networks: [dvd-net]

  dvd-redis:
    image: redis:7-alpine
    container_name: dvd-redis
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    volumes:
      - ./data/redis:/data
    restart: unless-stopped
    networks: [dvd-net]

  dvd-backup:
    build: ./backup
    container_name: dvd-backup
    env_file: ./backend/.env
    volumes:
      - ./backup:/backup
    depends_on: [dvd-mongo]
    restart: unless-stopped
    networks: [dvd-net]

networks:
  dvd-net:
    driver: bridge
```

**關鍵點**：`dvd-mongo` 與 `dvd-redis` **完全不宣告 `ports`**，只掛在 `dvd-net` 上。這是 PRD D-01 決策的直接落實 —— 外部要寫資料只能經過 5132 的 Ingest API。

### 2.3 環境變數

```ini
# ── 服務 ────────────────────────────────
NODE_ENV=production
PORT=5132
SSE_PORT=5133
PROJECT_ID=devops                # 共用儲存的隔離維度，v1 固定

# ── MongoDB ─────────────────────────────
MONGO_INITDB_ROOT_USERNAME=dvd_root
MONGO_INITDB_ROOT_PASSWORD=***
MONGO_URI=mongodb://dvd_root:***@dvd-mongo:27017/devops_diagram?authSource=admin
MONGO_DB=devops_diagram

# ── Redis ───────────────────────────────
REDIS_HOST=dvd-redis
REDIS_PORT=6379
REDIS_PASSWORD=***
REDIS_PREFIX=dvd

# ── 監控參數 ─────────────────────────────
HEARTBEAT_TIMEOUT_SEC=90         # 超過視為 down
PROBE_INTERVAL_SEC=30            # Pull 探測間隔
STATUS_EVAL_INTERVAL_SEC=15      # 狀態重算間隔
ERROR_RATE_THRESHOLD=0.05        # 錯誤率超過此值 → degraded
LOG_TTL_DAYS=7                   # 一般紀錄保留天數
BODY_SUMMARY_BYTES=1024          # 成功請求 body 摘要長度
BODY_MAX_BYTES=32768             # 錯誤請求 body 截斷上限

# ── 備份 ────────────────────────────────
BACKUP_CRON=0 3 * * *
BACKUP_KEEP=30
BACKUP_DIR=/backup
```

---

## 3. 後端模組結構

```
backend/src/
├── index.js                  # 入口：啟兩個 server（5132 API / 5133 SSE）
├── config/
│   ├── mongo.js              # MongoClient 單例、索引建立
│   ├── redis.js              # ioredis 單例、key 前綴組裝
│   └── env.js                # 環境變數讀取與驗證（缺必要變數就不啟動）
├── middlewares/
│   ├── apiKeyAuth.js         # X-API-Key 驗證 → req.auth = { projectId, serviceId, scopes }
│   ├── requireScope.js       # ingest / read / admin 權限檢查
│   └── errorHandler.js
├── routes/
│   ├── ingest.js             # POST /ingest/log, /ingest/logs
│   ├── heartbeat.js          # POST /heartbeat
│   ├── services.js           # GET /services, /services/:id
│   ├── logs.js               # GET /logs, /logs/:id
│   ├── errors.js             # GET /errors
│   ├── stats.js              # GET /stats/overview
│   ├── topology.js           # GET /topology
│   ├── admin.js              # API Key 與服務註冊管理
│   └── stream.js             # GET /stream（掛在 5133）
├── services/
│   ├── ingestService.js      # 分流 api_logs / error_logs、遮蔽、截斷、寫 Redis
│   ├── statusService.js      # 狀態判定（healthy/degraded/down/unknown）
│   ├── proberService.js      # Pull 探測 cron
│   ├── queryService.js       # 查詢：Redis 優先、回落 Mongo
│   ├── apiKeyService.js      # Key 產生、雜湊、驗證、快取失效
│   └── sseHub.js             # SSE 連線管理與事件廣播
├── models/                   # collection 存取封裝（無 ORM，直接用 driver）
└── utils/
    ├── mask.js               # 敏感欄位遮蔽
    ├── truncate.js           # body 摘要與截斷
    └── topologyLoader.js     # 讀取 config/topology.json
```

**設計原則**

1. **狀態判定只有一個來源**：所有 `healthy / degraded / down` 的判斷集中在 `statusService`，Ingest 寫入與 Prober 探測都只是餵資料給它，避免多處各判各的導致前端看到矛盾狀態。
2. **Ingest 路徑要最短**：驗證 Key（走 Redis 快取）→ 遮蔽截斷 → 寫 Redis → 非同步批次寫 Mongo，不做任何同步的重運算。
3. **查詢先問 Redis**：近 24 小時的列表查詢打 Redis List；超出範圍或帶複雜條件才回落 Mongo。

---

## 4. 狀態判定邏輯

`statusService` 每 15 秒重算一次，並在 Ingest 收到錯誤時立即重算該服務：

```
for each service in topology:
    lastHeartbeat = redis.get(dvd:{projectId}:hb:{serviceId})
    lastProbeOk   = service_status.lastProbeOkAt

    if lastHeartbeat == null and lastProbeOk == null:
        status = 'unknown'              # 已在架構圖但從未回報
    elif now - max(lastHeartbeat, lastProbeOk) > HEARTBEAT_TIMEOUT_SEC:
        status = 'down'
    else:
        errorRate = 近 5 分鐘 error 數 / 近 5 分鐘 total 數
        status = errorRate >= ERROR_RATE_THRESHOLD ? 'degraded' : 'healthy'

    if status != previousStatus:
        upsert service_status
        sseHub.broadcast('status', { serviceId, status, ... })
```

- Push 心跳與 Pull 探測**任一成功**即視為活著，取兩者較新的時間戳
- 近 5 分鐘計數取 `dvd:{projectId}:stat:{serviceId}:{yyyyMMddHH}` 的 Hash，跨小時時合併相鄰兩個 key
- 只有**狀態改變**才推播 `status` 事件，避免每 15 秒灌一次全量

---

## 5. SSE 設計

| 項目 | 做法 |
|------|------|
| 端點 | `GET /api/v1/stream`，獨立跑在 5133 |
| 連線管理 | `sseHub` 維護連線集合，連線建立時先送一次 `snapshot` |
| 心跳幀 | 每 30 秒送一次 `snapshot`，同時兼作 keep-alive 防止 Nginx 斷線 |
| 事件 | `status`（狀態變化）、`error`（新錯誤）、`snapshot`（全量快照） |
| 前端重連 | `EventSource` 原生重連 + 指數退避（上限 30 秒）；重連期間退回 15 秒輪詢 `/api/v1/services` |
| 上限 | 20 個並行連線；超過回 503，前端自動退回輪詢模式 |

**為何獨立在 5133**：SSE 是長連線，Nginx 需要 `proxy_read_timeout` 拉長、關閉 `proxy_buffering`，這些設定跟一般 API 相衝；分開後兩邊各自調，也方便單獨監控長連線數。

---

## 6. 網路與存取控制

### 6.1 生產環境（10.10.130.122）

| 端點 | 存取限制 |
|------|----------|
| 5131 前端 | **僅 10.10.112.13** |
| 5132 `/api/v1/ingest/*`、`/api/v1/heartbeat` | 不限來源 IP（各服務都要能回報），但**必須帶有效 `ingest` Key** |
| 5132 其餘查詢端點 | **僅 10.10.112.13** + `read` Key |
| 5133 SSE | **僅 10.10.112.13** + `read` Key |
| 27017 / 6379 | **不對外**（未宣告 ports） |

前端容器的 Nginx 設定：

```nginx
server {
    listen 5131;
    location / {
        allow 10.10.112.13;
        deny  all;
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
```

查詢端點的 IP 限制實作在後端 middleware（`ALLOWED_QUERY_IPS` 環境變數），而非只靠 Nginx —— 因為 5132 同時承載不限 IP 的 Ingest，無法整個 server block 一起擋。

### 6.2 開發環境（10.10.112.13 本機）

同一份 compose，差別只在 `.env`：`ALLOWED_QUERY_IPS` 留空表示不限制。

---

## 7. 部署流程

### 7.1 首次部署

```bash
cd D:/檔案分享/程式碼/DevOpsDiagram
cp backend/.env.example backend/.env    # 填入密碼
docker-compose up -d --build
docker exec dvd-backend node scripts/initIndexes.js    # 建索引
docker exec dvd-backend node scripts/createApiKey.js --service gigaks-backend --scope ingest
```

最後一行會印出明文 Key（只印這一次），交給該服務的開發者寫進他們的 `.env`。

### 7.2 前端更新

```bash
npm run build       # 產出 frontend/dist
```

`dist` 以 volume 掛入 Nginx，覆蓋即生效，不需重啟容器（沿用 GigaKS / NotesAPP 既有做法）。

### 7.3 後端更新

```bash
docker-compose up -d --build dvd-backend
```

---

## 8. 備份與還原

### 8.1 備份

`dvd-backup` 容器內的 cron 每日 03:00 執行：

```bash
mongodump --uri "$MONGO_URI" \
  --collection error_logs --collection services \
  --collection api_keys --collection service_status \
  --gzip --archive=/backup/dvd-$(date +%Y%m%d).gz
```

- `api_logs`（7 天暫存）與 `heartbeats` 不備份
- 保留最近 30 份，超過的由同一支腳本刪除
- 備份結果回報為一筆紀錄（`serviceId: devopsdiagram-backup`），失敗時該節點在架構圖上會轉紅

### 8.2 還原

```bash
docker exec -i dvd-mongo mongorestore --uri "$MONGO_URI" --gzip --archive < ./backup/dvd-20260918.gz
```

上生產（M5）前需**實際演練一次還原**，確認備份檔可用。

---

## 9. 故障影響分析

| 元件故障 | 對被監控服務的影響 | 對本平台的影響 |
|----------|-------------------|----------------|
| `dvd-backend` 掛掉 | **無**。SDK 逾時 1 秒、失敗保留在記憶體緩衝（500 筆）等重送 | 前端無法查詢；緩衝滿後最舊紀錄遺失 |
| `dvd-mongo` 掛掉 | 無 | Ingest 仍可寫 Redis，查詢只剩近 24 小時；Mongo 回來後補寫佇列 |
| `dvd-redis` 掛掉 | 無 | 直接走 Mongo，查詢變慢；狀態判定退回查 `service_status` |
| `dvd-frontend` 掛掉 | 無 | 看不到畫面，資料仍持續收集 |
| 網路不通 | 無 | 同 backend 掛掉 |

**核心保證**：本平台任何元件故障，都不得讓任何被監控服務變慢或出錯。這由 SDK 端的「非同步 + 1 秒逾時 + 失敗即緩衝」三道機制保證，詳見 [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)。

---

## 10. 架構圖拓樸維護

節點與連線定義放在 `backend/config/topology.json`，格式沿用 ArchAtlas 的 `AtlasData`：

```jsonc
{
  "services": [
    {
      "id": "gigaks-backend",
      "name": "知識庫後端",
      "type": "backend",
      "layer": "api",
      "description": "GigaSolar Knowledge Base API",
      "stack": ["Node.js", "Express", "MongoDB", "MSSQL"],
      "team": "開發團隊",
      "owner": "—",
      "status": "active",
      "links": { "repo": "D:\\檔案分享\\程式碼\\GigaSolarKnowledgeBase" },
      "monitor": {
        "healthUrl": "http://10.10.130.122:5155/health",
        "enabled": true
      }
    }
  ],
  "edges": [
    { "from": "gigaks-frontend", "to": "gigaks-backend", "label": "REST" }
  ]
}
```

- 相較 ArchAtlas 原型別，多一個 `monitor` 區塊供 Pull 探測使用
- 修改後呼叫 `POST /api/v1/admin/topology/reload` 重載，不需重啟容器

  > 這件事成立的前提是 `docker-compose.yml` 有把設定目錄掛進去：
  > ```yaml
  >     volumes:
  >       - ./backend/config:/usr/src/app/config
  > ```
  > 沒有這個掛載的話，容器裡是 build 時 `COPY` 進去的那份靜態檔案，
  > reload 會重讀同一份舊檔、看起來成功卻什麼都沒變 —— 必須重建映像才會生效。
- 若收到某 `serviceId` 的回報但 topology 中沒有，後端會記錄警告並在前端標示「未登錄服務」，提示補設定

---

## 11. 與現有服務的 Port 對照

| 主機 | Port | 服務 |
|------|------|------|
| — | 5121 / 5122 | NotesAPP（後端 / 前端） |
| — | 5123 / 5124 / 5125 | GeneralBackend（general / file / SMB） |
| — | **5131 / 5132 / 5133** | **DevOpsDiagram（前端 / API / SSE）** |
| — | 5134 / 5135 | DevOpsDiagram 保留 |
| — | 5147 / 5148 / 5149 | BPM（component / cdn / backend） |
| — | 5153 / 5155 | GigaSolarKnowledgeBase（前端 / 後端） |

5131~5135 與既有服務無衝突。
