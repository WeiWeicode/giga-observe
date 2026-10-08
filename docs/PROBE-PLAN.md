# 架構圖「未回報」節點補探測 — 規劃

> 狀態:**規劃(未實作)**,2026-10-08 需求方提出(額度限制,先規劃)。
> 現況:架構觀測「未回報 8」;需求:① 後端樣本不呈現 ② 「核心服務」「資料與儲存」也要有健康狀態。

## 1. 現況盤點

| 節點 | 層 | 現在的 monitor | 誰在用它(心跳 `deps` 已有的檢查) |
| --- | --- | --- | --- |
| `node-sample` 後端樣本 | api | `planned`、不探測 | — (範例服務,非正式服務) |
| `gw-worker` BFF Worker | service | 不探測 | 與 BFF 同映像、另一行程;無 HTTP 端點 |
| `gw-sqlserver` Gateway 資料庫 | data | 不探測 | gw-bff(sql)、file-api(`sql`,schema file_svc) |
| `gw-redis` Gateway Redis | data | 不探測 | gw-bff(redis)、gw-worker(佇列) |
| `ita-sqlserver` 端點資料庫 | data | 不探測 | endpoint-api / endpoint-agent |
| `ita-mongo` 端點快照歷史 | data | 不探測 | endpoint-agent |
| `ita-redis` 端點在線狀態 | data | 不探測 | endpoint-api / endpoint-agent |
| `file-storage` 附件實體檔 | data | 不探測 | file-api(`storage`;NAS 備份狀態在 file-api) |
| `bpm-attachments` BPM 附件來源 | data | 不探測 | file-api(尚無對應 dep) |

已有機制(`backend/src/services/`):
- `proberService`:HTTP 探測 `monitor.healthUrl`(只看 2xx);`monitor.type = internal` 以平台自己的 Mongo / Redis ping(gno-mongo、gno-redis 用這個)。
- `statusService.recordHeartbeat`:各服務心跳帶 `deps: [{ name, ok, latencyMs }]`,已存在 `service_status.deps`。

## 2. 做法

### 2.1 後端樣本不呈現

- `topology.json` 刪除 `node-sample` 與 `gw-bff → node-sample` 連線(只是範例,Gateway `samples/node-backend` 保留)。
- 或保留資料、加 `"hidden": true`,畫面與統計略過;**建議直接刪除**(較單純,要再看時從 git 取回)。

### 2.2 資料節點:沿用使用者服務的心跳 `deps`(主要做法)

新增 monitor 類型 `dep`:節點狀態由「使用它的服務」心跳裡的 dep 推算,不另開連線、不需要資料庫帳密。

```jsonc
"monitor": {
  "enabled": true,
  "type": "dep",
  "from": [
    { "service": "gw-bff", "dep": "sql" },
    { "service": "file-api", "dep": "sql" }
  ]
}
```

- 狀態規則:任一來源回報 `ok: false` → 異常;全部來源都失聯(心跳逾時)→ 未回報;否則正常。延遲取各來源最大值。
- 節點詳情顯示「依據:gw-bff.sql、file-api.sql(最後心跳時間)」。
- 實作位置:`topologyService.getDepTargets()`、`statusService` 在收到心跳時順帶更新被引用的資料節點(或 `proberService` 每輪彙總);前端只需顯示新增的「依據」欄位。
- **前置:確認各服務心跳的 dep 名稱**(gw-bff、endpoint-api、endpoint-agent 實際送出的 `deps`;file-api 為 `sql`、`storage`)。缺的由該服務補:
  - endpoint-agent 補 `mongo`、`redis`;endpoint-api 補 `sql`、`redis`(RustIt ItAgentBack,改 backend-sdk `deps` 回呼)。
  - file-api 補 `bpm-test`、`bpm-prod`(NaNa `SELECT 1` + 5144 `GET /` 2xx,快取 60 秒,避免每次心跳打 BPM)與 `nas`(標記檔存在)。

| 節點 | 依據 |
| --- | --- |
| `gw-sqlserver` | gw-bff.sql、file-api.sql |
| `gw-redis` | gw-bff.redis |
| `ita-sqlserver` | endpoint-api.sql、endpoint-agent.sql |
| `ita-mongo` | endpoint-agent.mongo |
| `ita-redis` | endpoint-api.redis、endpoint-agent.redis |
| `file-storage` | file-api.storage、file-api.nas |
| `bpm-attachments` | file-api.bpm-test、file-api.bpm-prod |

### 2.3 核心服務:BFF Worker

- `gw-worker` 沒有 HTTP 端點 → 由 worker 自己送心跳(backend-sdk `setupMonitor` 的 heartbeat,serviceId `gw-worker`,deps:redis 佇列、未處理工作數)。需 Gateway 改 `bff/src/workers/` 啟動流程,並建立 `gw-worker` 的 ingest Key。
- 若不想改 Gateway:改為 `dep` 類型,依據 `gw-redis` 佇列與 BFF 回報的「待處理工作數」(需 BFF 心跳 deps 補 `queue`)。**建議前者**(worker 掛掉時 BFF 仍正常,dep 判斷不出來)。

### 2.4 備案:TCP 探測

心跳拿不到的節點(例如沒有使用者服務的獨立資料庫),新增 monitor 類型 `tcp`(`host:port` 可連即正常)。只確認埠可連,不驗帳密;目前清單都有使用者服務,**第一版不做**。

## 3. 工作拆解與順序

| # | 項目 | repo | 估計 |
| --- | --- | --- | --- |
| 1 | 刪除 `node-sample`(拓樸) | giga-observe | 0.1 天 |
| 2 | `dep` 類型:topologyService / statusService / 單元測試;前端詳情顯示依據 | giga-observe、GigaItApp | 1 天 |
| 3 | 確認各服務心跳 deps 名稱,補 endpoint-api / endpoint-agent 的 deps | RustIt ItAgentBack | 0.5 天 |
| 4 | file-api 補 `nas`、`bpm-test`、`bpm-prod` deps(含快取) | giga-file-service | 0.5 天 |
| 5 | gw-worker 心跳 + ingest Key | giga-api-gateway-bff、giga-observe | 0.5 天 |
| 6 | 拓樸各資料節點改 `type: dep`、gw-worker 啟用;測試區驗收(停掉 ita-redis 等觀察變為異常) | giga-observe | 0.5 天 |

驗收:「未回報」只剩真正沒有來源的節點(預期 0);停掉任一資料容器,對應節點 1 分鐘內變「異常」,恢復後回到「正常」。
