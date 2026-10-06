# 生產部署指南 (Deployment)

**目標主機**：`10.10.130.122`
**文件版本**：v1.0
**建立日期**：2026-09-18
**上游文件**：[ARCHITECTURE.md](./ARCHITECTURE.md) §7

---

## 0. 先讀這一段（重要）

### 0.1 IP 白名單在 Docker Desktop 上不會如預期運作

本機實測：從宿主機打到 `5132`，後端看到的來源 IP 是 **`172.20.0.1`（Docker 橋接網路的閘道）**，不是真實客戶端 IP。

原因是 Docker Desktop（Windows / Mac）的 port publishing 走 NAT，會改寫來源位址。原生 Linux Docker 則會保留真實 IP。

**後果**：如果你在生產的 `.env` 直接設 `ALLOWED_QUERY_IPS=10.10.112.13`，**所有請求都會被擋下（403），平台完全無法使用** —— 包含你自己從 10.10.112.13 開的瀏覽器。

**所以第一次部署時 `ALLOWED_QUERY_IPS` 請留空**，先照 §6 實測生產主機看到的是哪個 IP，再決定用哪種方式限制存取。

### 0.2 部署前要準備的東西

| 項目 | 說明 |
|------|------|
| 主機權限 | 10.10.130.122 的登入權限、Docker 可用 |
| 磁碟空間 | Mongo volume 建議預留 **20 GB**（見 DB_SCHEMA §6） |
| Port | 5131 / 5132 / 5133 未被佔用（既有服務用 5121~5155 的其他號碼） |
| 密碼 | 自行決定 Mongo 與 Redis 的正式密碼，**不要沿用 .env.example 的預設值** |

---

## 1. 把程式碼放上去

專案在 `D:\檔案分享\程式碼\DevOpsDiagram`，若生產主機看得到同一個檔案分享，直接複製整個資料夾即可。

**不要複製的東西**（會讓本機的設定與資料汙染生產）：

```
backend/.env          ← 本機密碼與本機的 API Key
backend/node_modules
frontend/node_modules
data/                 ← 本機的 Mongo / Redis 資料
backup/archives/      ← 本機的備份檔
```

`frontend/dist/` **要複製**（前端已建置好，生產主機不需要 Node 環境）。

---

## 2. 建立生產設定檔

在生產主機的專案根目錄下，用 `backend/.env.example` 建立 `backend/.env`，並改掉以下幾項：

```ini
NODE_ENV=production
PORT=5132
SSE_PORT=5133
PROJECT_ID=devops

# ── 改成你自己的正式密碼（兩處要一致）─────────
MONGO_INITDB_ROOT_USERNAME=dvd_root
MONGO_INITDB_ROOT_PASSWORD=<正式密碼>
MONGO_URI=mongodb://dvd_root:<正式密碼>@dvd-mongo:27017/devops_diagram?authSource=admin
MONGO_DB=devops_diagram

REDIS_HOST=dvd-redis
REDIS_PORT=6379
REDIS_PASSWORD=<正式密碼>
REDIS_PREFIX=dvd

# ── 監控參數：先用預設值，觀察後再調 ──────────
HEARTBEAT_TIMEOUT_SEC=90
PROBE_INTERVAL_SEC=30
STATUS_EVAL_INTERVAL_SEC=15
ERROR_RATE_THRESHOLD=0.05
LOG_TTL_DAYS=7
BODY_SUMMARY_BYTES=1024
BODY_MAX_BYTES=32768

# ── 第一次部署請留空！見 §0.1 與 §6 ───────────
ALLOWED_QUERY_IPS=
TRUST_PROXY=false
CORS_ORIGINS=

# ── 備份 ────────────────────────────────────
BACKUP_CRON_HOUR=3
BACKUP_KEEP=30
BACKUP_DIR=/backup
```

> `TRUST_PROXY` 保持 `false`。只有在 5132 前面真的架了反向代理時才改成 `true` —— 否則等於讓任何人送一個假的 `X-Forwarded-For` 就繞過 IP 白名單。

---

## 3. 確認拓樸設定

`backend/config/topology.json` 裡各服務的 `monitor.healthUrl` 目前都指向 `host.docker.internal:<port>`。

生產環境的被監控服務（GigaKS、BPM、GeneralBackend、NotesAPP）都在 **同一台 10.10.130.122** 上，所以這些設定**不需要修改** —— `dvd-backend` 的 `docker-compose.yml` 已經設了 `extra_hosts: host.docker.internal:host-gateway`。

若有服務其實在別台，把該服務的 `healthUrl` 改成實際位址即可。

目前只有 `gigaks-frontend`、`gigaks-backend`、`devopsdiagram-backend` 開啟探測（`monitor.enabled: true`），其餘為 `false` —— 因為還沒確認它們有沒有 `/health`。上線後可逐一確認再打開。

---

## 4. 啟動

```bash
cd /path/to/DevOpsDiagram
mkdir -p data/mongo data/redis backup/archives
docker compose up -d --build
```

等約 30 秒讓 Mongo 完成首次初始化，然後確認：

```bash
docker compose ps
curl -s http://localhost:5132/health
```

`/health` 應回 `"status":"ok"`、`mongo.ok=true`、`redis.ok=true`。

> 若 Mongo 首次啟動較慢，後端會重試 6 次（每次間隔 5 秒），之後還有每 10 秒的背景重連 —— 不需要手動重啟。

---

## 5. 建立 API Key

生產是全新的資料庫，Key 要重新產生（本機那幾把在生產無效）。

```bash
docker exec dvd-backend node src/scripts/createApiKey.js --scope read  --label "維運查詢"
docker exec dvd-backend node src/scripts/createApiKey.js --scope admin --label "管理"
docker exec dvd-backend node src/scripts/createApiKey.js --service gigaks-backend       --scope ingest --label "知識庫後端"
docker exec dvd-backend node src/scripts/createApiKey.js --service devopsdiagram-backup --scope ingest --label "備份排程"
```

每把 Key 的明文**只會印這一次**，立刻存起來。

備份那把要寫回 `backend/.env` 再重啟備份容器：

```ini
BACKUP_API_KEY=<剛才產生的備份 Key>
BACKUP_REPORT_ENDPOINT=http://dvd-backend:5132
```

```bash
docker compose up -d dvd-backup
```

---

## 6. 實測來源 IP，決定存取控制方式

這是 §0.1 說的關鍵步驟。**從 10.10.112.13 的瀏覽器**開 `http://10.10.130.122:5131`，填入 read Key，然後在生產主機上看後端日誌：

```bash
docker compose logs dvd-backend --tail 50 | grep -i "來源 IP"
```

沒有 403 的話就看不到這行，改用這個方式直接確認後端看到的 IP：

```bash
docker exec dvd-mongo mongosh "mongodb://dvd_root:<正式密碼>@localhost:27017/devops_diagram?authSource=admin" \
  --quiet --eval 'db.api_logs.find({},{["request.ip"]:1}).sort({ts:-1}).limit(5).toArray()'
```

### 情況 A：看到的是 `10.10.112.13`（原生 Linux Docker 通常如此）

IP 白名單可用，直接設定並重啟：

```ini
ALLOWED_QUERY_IPS=10.10.112.13
CORS_ORIGINS=http://10.10.130.122:5131
```

```bash
docker compose up -d dvd-backend
```

同時把 `frontend/nginx.conf` 裡的 `allow` / `deny` 兩行取消註解，重啟 `dvd-frontend`。

### 情況 B：看到的是 `172.x.x.x`（Docker Desktop，本機實測就是這樣）

應用層的 IP 白名單無效，`ALLOWED_QUERY_IPS` **保持留空**，改用主機防火牆限制：

```powershell
# 在 10.10.130.122 上以系統管理員身分執行
New-NetFirewallRule -DisplayName "DevOpsDiagram 前端" -Direction Inbound -LocalPort 5131 `
  -Protocol TCP -RemoteAddress 10.10.112.13 -Action Allow
New-NetFirewallRule -DisplayName "DevOpsDiagram SSE"  -Direction Inbound -LocalPort 5133 `
  -Protocol TCP -RemoteAddress 10.10.112.13 -Action Allow
```

**5132 不要限制來源** —— 它同時承載 Ingest，各服務都要打得到。

> 這個做法有個缺口：5132 上的查詢端點仍對內網開放，只是需要有效的 read Key 才能讀到資料。若要徹底隔離，可把查詢端點搬到保留的 5134，讓 5132 只留 Ingest，這樣就能對 5134 單獨設防火牆規則。這是一個明確的後續工作，目前規格沒有涵蓋，需要時再討論。

---

## 7. 接入生產的 GigaSolarKnowledgeBase

生產的 GigaKS 需要各自接入（本機的接法不會跟著程式碼一起過去，因為 `.env` 不複製）。

1. 確認生產的 `GigaSolarKnowledgeBase/backend/src/lib/devopsReporter.js` 存在（跟著 `src` 一起複製過去了）
2. 確認 `src/index.js` 有那段 `reporter()` 註冊（同上）
3. 在生產的 `GigaSolarKnowledgeBase/backend/.env` 補上：

```ini
DEVOPS_ENDPOINT=http://host.docker.internal:5132
DEVOPS_API_KEY=<§5 產生的 gigaks-backend Key>
DEVOPS_SERVICE_ID=gigaks-backend
```

4. 確認 `GigaSolarKnowledgeBase/docker-compose.yml` 的 backend 有 `extra_hosts: host.docker.internal:host-gateway`
5. 重建：`docker compose up -d --build backend`

沒設 `DEVOPS_API_KEY` 的話 SDK 會自動停用，GigaKS 照常運作 —— 所以這步驟做錯不會弄壞既有服務。

---

## 8. 驗收清單

| # | 檢查 | 預期 |
|---|------|------|
| 1 | `curl http://localhost:5132/health` | `status: ok`，mongo/redis 皆 true |
| 2 | 從 10.10.112.13 開 `http://10.10.130.122:5131` | 架構圖顯示 15 個節點 |
| 3 | 工具列右上 | 顯示「即時連線中」（SSE 通了） |
| 4 | GigaKS 節點 | 30 秒內轉綠 |
| 5 | 對 GigaKS 打幾支 API，等 10 秒 | 紀錄頁出現這些請求 |
| 6 | 點 GigaKS 節點 | 詳情面板顯示版本、最後心跳、依賴狀態 |
| 7 | `docker exec dvd-backup /app/backup.sh once` | 產出備份檔，備份節點轉綠 |
| 8 | 還原演練（見 §9） | 筆數與原始相符 |

第 8 項在正式啟用前必須做過一次 —— 沒驗證過的備份等於沒備份。

---

## 9. 備份還原演練

```bash
# 還原到臨時 DB，不動到正式資料
docker exec dvd-backup mongorestore \
  --uri "mongodb://dvd_root:<正式密碼>@dvd-mongo:27017/?authSource=admin" \
  --gzip --archive=/backup/dvd-<YYYYMMDD>.gz \
  --nsFrom 'devops_diagram.*' --nsTo 'restore_test.*'

# 比對筆數後清掉臨時 DB
docker exec dvd-mongo mongosh "mongodb://dvd_root:<正式密碼>@localhost:27017/?authSource=admin" --quiet --eval '
const src = db.getSiblingDB("devops_diagram"), dst = db.getSiblingDB("restore_test");
["error_logs","services","api_keys","service_status","topology"].forEach(c =>
  print(c + " 原始:" + src[c].countDocuments() + " 還原:" + dst[c].countDocuments()));
dst.dropDatabase();'
```

---

## 10. 效能觀察

### 10.1 看什麼

```bash
# 容器資源用量（持續刷新，Ctrl+C 離開）
docker stats dvd-backend dvd-mongo dvd-redis

# 平台自身狀態：待補佇列若持續 > 0 表示 Mongo 寫入跟不上
curl -s http://localhost:5132/health

# 資料量
docker exec dvd-mongo mongosh "mongodb://dvd_root:<正式密碼>@localhost:27017/devops_diagram?authSource=admin" \
  --quiet --eval 'db.getCollectionNames().forEach(c => print(c.padEnd(16) + db[c].countDocuments() + " 筆  " + Math.round(db[c].totalSize()/1024/1024) + " MB"))'
```

### 10.2 判讀標準

| 指標 | 正常 | 要注意 |
|------|------|--------|
| `queue.pendingMongoWrites` | 0 | 持續 > 100 表示寫入跟不上 |
| dvd-backend 記憶體 | < 300 MB | 持續成長不回落 = 可能有洩漏 |
| dvd-mongo CPU | 平時 < 20% | 持續 > 80% 需要看索引 |
| Ingest 回應時間 | < 50ms | 見 10.3 的量測方式 |
| 被監控服務的回應時間 | 接入前後差 < 2ms | 差異明顯就要看 SDK 設定 |

### 10.3 壓測

專案裡附了一支壓測腳本：

```bash
docker exec dvd-backend node src/scripts/loadTest.js --key <ingest key> --rps 50 --seconds 30
```

它會以指定速率送出批次紀錄，並印出 p50 / p95 / p99 與錯誤率。預估的日常量級（5 個服務合計每日 10 萬筆 ≈ 1.2 筆/秒）遠低於設計上限，這支腳本是用來確認還有多少餘裕。

### 10.3.1 本機基準（2026-09-18 實測，供生產比對）

測試環境：Windows 10 + Docker Desktop，宿主機 8 GB 記憶體。

| 速率 | p50 | p95 | p99 | 失敗 | 待補佇列 |
|------|-----|-----|-----|------|----------|
| 50 筆/秒 | 8.0 ms | 26.3 ms | 97.8 ms | 0 | 0 |
| **495 筆/秒**（設計上限） | 15.0 ms | 29.6 ms | 91.5 ms | 0 | 0 |

500 筆/秒持續 25 秒時的資源用量（壓測進行中取樣，非結束後的閒置值）：

| 容器 | CPU | 記憶體 |
|------|-----|--------|
| dvd-backend | 8–11% | 83–99 MB |
| dvd-mongo | 1.9–2.2% | 99–107 MB |
| dvd-redis | 1.6–1.8% | 4 MB |

**判讀**：設計上限的 400 倍於日常量級之下，p95 仍只有 29.6 ms（PRD 目標是 < 50 ms），CPU 用量個位數，待補佇列全程為 0。生產主機若規格不低於此，效能不會是瓶頸。

生產實測時請用同樣的參數（`--rps 500 --batch 100 --seconds 20`）以便直接比對。

### 10.4 量太大時的調整順序

三個都是環境變數，改完重啟容器即可，**不需要改程式**：

1. `LOG_TTL_DAYS` 調小（例如 3 天）—— 直接減少儲存量
2. SDK 端設 `sampleRate: 0.1` —— 成功請求只記 10%，錯誤永遠 100% 記錄
3. `BODY_SUMMARY_BYTES` 調小（例如 256）—— 減少每筆大小

---

## 11. 回滾

平台是獨立的，關掉不影響任何被監控服務：

```bash
docker compose down            # 保留資料
docker compose down -v         # 連 volume 一起清掉（資料會消失）
```

被監控服務那邊，把 `.env` 的 `DEVOPS_API_KEY` 清空再重啟，SDK 就會自動停用。

---

## 12. 已知限制

| 項目 | 說明 |
|------|------|
| 查詢端點的 IP 限制 | Docker Desktop 環境下需靠主機防火牆，見 §6 |
| 5132 同時承載 Ingest 與查詢 | 無法對查詢端點單獨設防火牆規則；要徹底隔離需把查詢搬到 5134 |
| 其餘四個服務尚未接入 | BPM / GeneralBackend / NotesAPP / DAS 列在 M4 |
| 前端 BDD 測試未接上 | `docs/Gherkin/*.feature` 目前僅為規格 |
