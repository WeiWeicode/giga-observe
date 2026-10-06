# giga-observe 觀測服務

GigaNexus 的 API / Nginx / 前端監控資料後端(Gateway 規劃見 `../giga-api-gateway-bff/docs/MONITORING-PLAN.md`,甘特圖 W9)。
由 DevOpsDiagram 複製改造;原專案只作參考、不修改。畫面在 GigaItApp「API Gateway 管理 › 架構觀測」,經 BFF `/api/observe/*` 讀取。

| 項目 | 內容 |
| --- | --- |
| 服務代碼 / port | `observe-api` / 51202(Ingest + Query + Admin)、51203(SSE,內網) |
| 資料 | 自有 MongoDB + Redis;**測試區與正式區各一套,完全隔離**(`OBSERVE_ENV`,DB `giga_observe_{env}`、Redis 前綴 `gno-{env}`) |
| 保存 | 成功紀錄 7 天、錯誤永久(完整 body 90 天後裁成 1 KB 摘要)、Nginx 流量彙總與前端效能 90 天 |
| 回報來源 | `@giganexus/backend-sdk` 的 `setupGateway`(後端)、BFF、`nginx-log-agent`、web-kit `installMonitor`(經 BFF 轉送) |
| 查詢 | API Key(scope `read`),或經 Gateway BFF 的 `X-Internal-Token`(權限 `observe.data.read` / `observe.log.body`);`GET /openapi.json` 供 Gateway 匯入 |

## 部署

```bash
cp backend/.env.example backend/.env.test      # 填密碼、GW_JWKS_URL;正式區另存 .env.prod,兩區不可相同
cp deploy/test.env.example deploy/test.env
docker compose --env-file deploy/test.env up -d --build
docker compose --env-file deploy/test.env exec gno-backend node src/scripts/createApiKey.js --service gw-bff --scope ingest --label "Gateway BFF"
```

## 本機開發

```bash
cd backend && npm install
npm test                 # 單元 + 記憶體 MongoDB 整合測試
PORT=15202 npm run dev:local   # 示範資料(記憶體 MongoDB);GigaItApp 以 OBSERVE_LOCAL=http://localhost:15202 npm run dev 連過來
```

AI 協作規則見 [AGENT.md](AGENT.md)。
