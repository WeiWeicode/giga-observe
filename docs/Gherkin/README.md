# Gherkin 驗收規格

**專案**：DevOpsDiagram
**建立日期**：2026-09-18
**上游文件**：[PRD.md](../PRD.md)、[API_CONTRACT.md](../API_CONTRACT.md)、[DB_SCHEMA.md](../DB_SCHEMA.md)

---

## 1. 這些檔案是什麼

以 Gherkin 語法描述的驗收條件，同時作為三種用途：

1. **需求的可執行版本** —— PRD 的驗收條件寫成機器可讀的形式
2. **開發時的目標** —— 實作前先看這支 feature 要滿足什麼
3. **自動化測試的基礎** —— 日後接 Cucumber.js 時直接當測試案例

> 目前階段**只寫規格、不寫 step definitions**。M1 實作時再決定要不要接自動化。

---

## 2. 檔案清單

| 檔案 | 涵蓋範圍 | 對應 |
|------|----------|------|
| [`api-key.feature`](./api-key.feature) | API Key 驗證、權限分級、projectId 隔離 | US-06 / D-03 |
| [`ingest.feature`](./ingest.feature) | 紀錄回報、錯誤分流、body 保存、敏感遮蔽 | US-04 / D-01 D-04 D-05 |
| [`heartbeat.feature`](./heartbeat.feature) | 心跳回報、Pull 探測、存活判定 | US-01 |
| [`service-status.feature`](./service-status.feature) | healthy / degraded / down / unknown 狀態機 | US-01 |
| [`architecture-map.feature`](./architecture-map.feature) | 架構圖、節點狀態、服務詳情面板 | US-01 / US-02 |
| [`log-query.feature`](./log-query.feature) | 紀錄查詢、篩選、分頁、明細 | US-03 / US-04 |
| [`error-tracking.feature`](./error-tracking.feature) | 錯誤聚合、永久保存、歷史回查 | US-03 |
| [`sse-stream.feature`](./sse-stream.feature) | SSE 即時推播、重連、退回輪詢 | D-06 |
| [`job-logging.feature`](./job-logging.feature) | 排程服務的執行紀錄 | D-08 |
| [`retention-backup.feature`](./retention-backup.feature) | TTL 保留期、每日備份、還原 | D-04 / D-07 |
| [`sdk-failsafe.feature`](./sdk-failsafe.feature) | 平台故障不影響被監控服務 | PRD §8 |
| [`integration.feature`](./integration.feature) | 服務接入流程（端到端） | US-05 |

---

## 3. 撰寫慣例

### 3.1 語言

檔頭一律 `# language: zh-TW`，使用中文關鍵字：

| 英文 | 中文 |
|------|------|
| Feature | 功能 |
| Background | 背景 |
| Scenario | 場景 |
| Scenario Outline | 場景大綱 |
| Examples | 例子 |
| Given | 假設 |
| When | 當 |
| Then | 那麼 |
| And | 而且 |
| But | 但是 |

### 3.2 標籤

| 標籤 | 意義 |
|------|------|
| `@US-01` ~ `@US-06` | 對應 PRD §2.2 的使用者故事 |
| `@D-01` ~ `@D-08` | 對應 PRD §12 的決策紀錄 |
| `@M1` ~ `@M5` | 預計在哪個里程碑實現 |
| `@critical` | 壞掉就不能上線的核心行為 |
| `@security` | 資安相關，優先驗證 |
| `@manual` | 難以自動化，需人工驗收 |

### 3.3 撰寫原則

- **一個場景只驗一件事**，失敗時能直接指出是哪個行為壞了
- **描述行為，不描述實作** —— 寫「紀錄應永久保存」而非「不應建立 TTL 索引」
- **用具體數字** —— 寫「90 秒」而非「一段時間」，數字取自 PRD 與環境變數預設值
- **時間可控** —— 涉及時間的場景一律用「經過 N 秒」而非等待真實時間，實作時以可注入的時鐘處理

---

## 4. 與 ACCEPTANCE.md 的關係

這些 feature 檔**取代**原本規劃的 `docs/ACCEPTANCE.md` —— 同樣的內容寫成 Gherkin 更精確，也不必維護兩份。PRD §13 已同步更新。
