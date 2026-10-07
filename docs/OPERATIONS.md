# giga-observe 維運手冊

> 對象:Gateway / IT 維運人員。規劃與決策見 `../giga-api-gateway-bff/docs/MONITORING-PLAN.md`;使用方式見 `../GigaItApp/docs/OBSERVE-MANUAL.md`;服務接入見 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)。

---

## 1. 現況

| 項目 | 測試區(主機 2) | 正式區(主機 3) |
| --- | --- | --- |
| 位置 | `/srv/giganexus/giga-observe` | 未建置(隨 W3-M,見 §8) |
| compose 專案 | `giga-observe-test` | `giga-observe-prod` |
| 設定 | `backend/.env.test`(隨機密碼,權限 600)、`deploy/test.env` | `backend/.env.prod`、`deploy/prod.env` |
| 資料 | `data/test/mongo`、`data/test/redis`;備份 `backup/archives/test/` | `data/prod/…` |
| 網路 | `gno-backend` 加入 `giganexus-gw_default`,別名 `observe-api` | 同 |
| port | 51202(API)、51203(SSE)只綁主機本機 | 同 |

容器:`gno-backend`(API、探測、告警計算、body 裁切排程)、`gno-mongo`、`gno-redis`、`gno-backup`(每日 03:00 mongodump,保留 30 份)。

## 2. 部署與更新

主機 2 的 shell 是 PowerShell,引號會被吃掉:**一律把腳本 scp 到 `C:\Users\user`,再以 `wsl -u root -- sh /mnt/c/Users/user/<腳本>` 執行**。

```bash
cd /srv/giganexus/giga-observe
git pull                                      # 或以 git bundle 帶入(主機沒有 GitLab 帳號時)
docker compose --env-file deploy/test.env build --pull
docker compose --env-file deploy/test.env up -d
docker compose --env-file deploy/test.env exec -T gno-backend wget -qO- http://127.0.0.1:51202/health
```

`/health` 回 `status: ok` 且 `deps.mongo.ok`、`deps.redis.ok` 為 true 即正常。拓樸(`backend/config/`)以 volume 掛載,改完不用重建,`docker compose --env-file deploy/test.env restart gno-backend` 即可(或以 admin scope 的 Key 呼叫 `POST /api/v1/admin/topology/reload`)。

## 3. 與 Gateway 的連接

| 項目 | 設定 |
| --- | --- |
| BFF 回報 | Gateway `test.env`:`MONITOR_URL=http://observe-api:51202`、`MONITOR_API_KEY_FILE`、`MONITOR_WEB_API_KEY_FILE`;機密檔在 `/srv/giganexus/deploy/secrets/` |
| nginx-log-agent | Gateway `test.env`:`MONITOR_NGINX_API_KEY_FILE` |
| 查詢路由 | 上游 `observe-api` 與 13 條 `/api/observe/*`;由 `GET /openapi.json` 匯入 |
| Token 驗證 | `backend/.env.test` 的 `GW_JWKS_URL=http://bff-1:3000/.well-known/jwks.json`、`GW_SERVICE_CODE=observe-api` |

新部署區匯入路由(在該區 BFF 容器內):

```bash
docker exec giganexus-gw-bff-1-1 node dist/bff/src/cli/index.js import-openapi --file http://observe-api:51202/openapi.json --target http://observe-api:51202 --env test --actor cli:<你的工號>
docker exec giganexus-gw-bff-1-1 node dist/bff/src/cli/index.js publish --note "observe 路由" --actor cli:<你的工號>
```

`publish` 會把**所有草稿**一起發佈,執行前確認沒有不該發佈的草稿。新增查詢 API 時更新 `backend/src/gatewayOpenapi.js`,再重新匯入、發佈。

## 4. 新增一個要監控的服務

### 4.1 建立 Key

```bash
docker compose --env-file deploy/test.env exec -T gno-backend node src/scripts/createApiKey.js --service <服務代碼> --scope ingest --label "<說明>"
```

Key 明文**只顯示一次**,直接寫進該服務的 Docker secret 檔(擁有者 uid 1000、權限 400),不要貼到聊天或文件。scope 種類:

| scope | 用途 |
| --- | --- |
| `ingest` | 服務回報紀錄、心跳、Nginx 流量;serviceId 由 Key 決定 |
| `ingest-web` | 只給 BFF 轉送前端事件 |
| `read` | 直接查詢 API(一般經 BFF,不需要) |
| `admin` | Key 管理、拓樸重載 |

目前測試區的 Key:`gw-bff`、`gw-bff-web`、`gw-nginx`(Gateway 機密目錄)、`itapp-api`(`/srv/giganexus/itapp-secrets/monitor_api_key`)、`endpoint-api` / `endpoint-agent`(`/srv/giganexus/ita-secrets/monitor_api_key`、`agent_monitor_api_key`,由 RustIt `ItAgentBack/deploy/host2-set-secrets.sh` 建立)、`gno-backup`(`.env.test`)。

### 4.2 登錄到拓樸

編輯 `backend/config/topology.json`,在 `services` 加一筆、`edges` 加連線後重載(§2):

```jsonc
{
  "id": "mes-api",                       // = Key 的 serviceId = Gateway 上游代碼
  "name": "MES 後端",
  "type": "backend",                     // frontend / backend / gateway / database / cache / storage / devops
  "layer": "api",                        // presentation / api / service / data / infra
  "description": "…", "stack": ["Node.js 22"], "team": "MES", "owner": "—",
  "status": "active",                    // planned = 規劃中(虛線、不列入告警)
  "links": { "repo": "mes/backend" },
  "monitor": { "healthUrl": "http://mes-api:51210/healthz", "enabled": true }   // 探測網址(gno-backend 連得到的位址)
}
```

前端服務 `type: frontend`,web-kit `installMonitor({ app: '<id>' })` 的 app 必須是拓樸裡的 id,否則事件會被拒收。

## 5. 資料保存

| 資料 | 保存 | 機制 |
| --- | --- | --- |
| 成功紀錄(`api_logs`) | 7 天 | TTL(`LOG_TTL_DAYS`) |
| 錯誤紀錄(`error_logs`) | 永久;完整 body 90 天後裁成 1 KB 摘要 | 每小時排程(`ERROR_BODY_DAYS`) |
| Nginx 流量(`traffic_minutely`)、前端效能(`web_vitals`) | 90 天 | TTL(`TRAFFIC_TTL_DAYS`) |
| 心跳 | 7 天 | TTL |
| 備份 | 30 份(每日) | `gno-backup`,`backup/archives/<區>/`;不含 `api_logs`、心跳(只留 7 天的資料) |

還原(備份容器看得到備份檔):

```bash
docker compose --env-file deploy/test.env exec -T gno-backup sh -c 'mongorestore --uri "$MONGO_URI" --gzip --archive=/backup/<檔名>'
```

## 6. 告警門檻

`backend/.env.<區>`:`ALERT_SECURITY_PER_MIN`(401 / 403 / 429 單分鐘,預設 30)、`ALERT_IP_PER_MIN`(單一 IP 單分鐘,預設 600)、`ALERT_WEB_ERRORS_PER_15M`(前端錯誤 15 分鐘,預設 20)、`ERROR_RATE_THRESHOLD`(異常的錯誤率,預設 0.05)、`HEARTBEAT_TIMEOUT_SEC`(失聯秒數,預設 90)。改完 `up -d gno-backend` 生效。

## 7. 故障排除

| 狀況 | 檢查 |
| --- | --- |
| 架構觀測頁「尚未接入」 | Gateway 有沒有 `/api/observe/*` 已發佈路由(§3) |
| 頁面 502 / 504 | `gno-backend` 是否在跑、是否在 `giganexus-gw_default` 網路;`docker logs giga-observe-test-gno-backend-1` |
| 頁面 401(登入後) | `GW_JWKS_URL` 連不到 BFF,或 `GW_SERVICE_CODE` 與上游代碼不同 |
| 某服務沒有紀錄 | 該服務 `MONITOR_URL`、Key 檔是否設定(空白即停用);服務日誌有無「giga-observe 認證失敗」 |
| Nginx 流量沒資料 | `docker logs giganexus-gw-nginx-log-agent-1`;`nginx_logs` volume 是否有 `access.json` |
| 前端事件沒進來 | BFF `MONITOR_WEB_API_KEY_FILE`;前端只在建置版本回報 |
| Mongo 不通 | 紀錄先進 Redis 待補佇列,恢復後 30 秒內補寫(`/health` 的 `pendingMongoWrites`) |
| 監控整個掛掉 | **不影響任何服務**:SDK 非同步送出、1 秒逾時、緩衝滿了丟最舊的 |

## 8. 正式區(待建置,隨 W3-M)

1. 主機 3 另起一套:`OBSERVE_ENV=prod`、`backend/.env.prod`(**新密碼,不可沿用測試區**)、`deploy/prod.env`;測試區與正式區**不可互送**
2. 重新建立全部 Key(正式區只接受 `*_FILE`),寫入正式區機密目錄;Gateway `prod.env` 設定 `MONITOR_*`
3. 拓樸改成正式區位址(探測網址、`giganexus.gigasolar.com.tw` 等)
4. 正式區 Gateway 匯入 `/openapi.json` 並發佈;GigaItApp `gateway-rbac.yaml` 以 prod 套用
5. 依正式流量調整告警門檻、前端效能抽樣比例;告警 Email 另列工作項目
