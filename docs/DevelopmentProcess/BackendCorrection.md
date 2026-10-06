# 後端修改紀錄

> 後端（`backend/`）的修改都要留一筆。格式見 [AGENT.md](../../AGENT.md) §10。

---

## 紀錄格式

```markdown
## YYYY-MM-DD｜一句話標題

**項目**：Ingest / Query / Heartbeat / SSE / Prober / 狀態判定 / API Key / 備份 / 其他
**內容**：改了什麼
**修改**：檔案與位置
**驗證**：對應的 Gherkin 場景 / Jest 測試
**鐵則檢查**：是否觸及 AGENT.md §9 的任一條，若有請說明為何安全
```

---

<!-- 新的紀錄加在這行下面，最新的放最上面 -->

## 2026-09-18｜M1 後端初版

**項目**：Ingest / Query / Heartbeat / SSE / Prober / 狀態判定 / API Key / 備份
**內容**：見 [NewFeatures.md](./NewFeatures.md) 的 M1~M3 條目；過程中修正的 5 個後端 bug 見 [BugFix.md](./BugFix.md)
**修改**：`backend/` 全部
**驗證**：`cd backend && npx jest` 63 項通過；手動驗證涵蓋 5 份 feature 的主要場景
**鐵則檢查**：
- §9.1 Mongo/Redis 不對外 —— docker-compose 中兩者皆未宣告 `ports`；`docker inspect` 確認 `dvd-mongo` 與 `dvd-redis` 的 HostPorts 皆為空。註：本機的 27017 有回應，但那是另一個專案的 `techprep_mongodb`，以本專案帳密連線會 Authentication failed，證明外部確實碰不到 `dvd-mongo`
- §9.2 serviceId 由 Key 決定 —— 測試涵蓋「body 宣稱 bpm-backend 但寫入 gigaks-backend」
- §9.3 error_logs 無 TTL —— 實機確認 `error_logs` 沒有 TTL 索引、文件無 `expireAt`
- §9.4 雙重遮蔽 —— 平台端漏遮 `api_key` 已修正，見 BugFix.md
- §9.6 狀態判定單一來源 —— 僅 `statusService` 寫 `service_status`
- §9.8 Redis key 前綴 —— 全部經 `redis.keys.*` 組裝，格式 `dvd:devops:*`
- §9.9 停用 Key 清快取 —— 實機確認停用後立即回 401
