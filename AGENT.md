# giga-observe 開發手冊 (AGENT.md)

> **出處**:2026-10-06 由 `D:檔案分享程式碼DevOpsDiagram` 複製(未含資料、備份、`.env`),作為 GigaNexus 的觀測服務(甘特圖 W9-8,規劃見 `../giga-api-gateway-bff/docs/MONITORING-PLAN.md`)。原專案只作參考、不修改;本專案自有 MongoDB / Redis,**測試區與正式區各一套、不共用**。下文仍沿用原專案名稱,改名與擴充於 W9-8 進行。

> 本文件是 AI 程式助手（如 Claude、Gemini）在本專案中的行為準則。
> 所有 AI 協作開發必須遵守以下規範。

---

## Claude 子代理 — 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.9(有出入時以該節為準)。**只適用 Claude Code**,Gemini 等其他 AI 略過本節。

Claude 把搜尋、審查、資安檢查、除錯、測試、重構交給子代理,主對話只收結論。子代理定義放在**使用者層級** `~/.claude/agents/`(Windows:`%USERPROFILE%\.claude\agents\`),所有專案共用;範本在 `../giga-api-gateway-bff/docs/claude-agents/`。

| 子代理 | 用途 | 模型 | 權限 |
| --- | --- | --- | --- |
| `explore` | 快速搜尋、分析大型程式碼庫結構 | `haiku`(Haiku 5.5) | 唯讀 |
| `code-reviewer` | 檢查程式碼品質、命名與最佳實踐 | `sonnet`(Sonnet 5.5) | 唯讀 |
| `security-auditor` | 偵測安全漏洞(硬編碼密鑰、注入、權限缺漏、不安全的 API) | `opus`(Opus 5.5) | 唯讀 |
| `debugger` | 追蹤錯誤日誌,做根本原因分析 | `sonnet`(Sonnet 5.5) | 唯讀 |
| `test-runner` | 執行既有測試並分析覆蓋率 | `haiku`(Haiku 5.5) | 唯讀(只執行指令,不改檔) |
| `refactor-assistant` | 安全地重構與拆分模組 | `sonnet`(Sonnet 5.5) | 可修改檔案 |

檔名是「子代理名稱 + `.md`」。模型欄寫別名,自動對應該系列的最新版(括號內是 2026-10 的版本)。

**開工前檢查**(每個工作階段一次):

1. 確認 `~/.claude/agents/` 有上表 6 個檔案。
2. 缺少任何一個時,**先列出缺少的子代理,詢問使用者是否建立**;未經同意不要建立。使用者不建立時照常工作,改由主對話自己做。
3. 使用者同意後,從範本複製缺少的檔案;**已存在的同名檔不覆蓋**(內容與範本不同時列出差異,詢問是否更新):

   ```bash
   mkdir -p ~/.claude/agents && cp -n ../giga-api-gateway-bff/docs/claude-agents/*.md ~/.claude/agents/
   ```

   範本不在工作區(沒有 clone `giga-api-gateway-bff`)時,說明「範本未讀取」,詢問使用者要先 clone 該 repo,還是依上表欄位建立。
4. 建立後告訴使用者:**重新開啟 Claude Code 工作階段**後子代理才會載入。

**何時使用**:

| 情境 | 子代理 |
| --- | --- |
| 不熟的模組、要跨多個目錄找東西、回答「X 在哪裡 / 怎麼串」 | `explore` |
| 一批修改完成、commit 前 | `code-reviewer` |
| 動到登入、權限(RBAC)、Token / API Key、機密與 `.env*`、檔案上傳下載、對外 API、Nginx / 部署設定 | `security-auditor`(可與 `code-reviewer` 同時進行) |
| 錯誤 log、測試失敗或線上異常,原因不明 | `debugger` |
| 修改後跑 lint / 型別檢查 / 測試、查覆蓋率 | `test-runner` |
| 改名、搬檔、拆模組等不改變行為的重構 | `refactor-assistant` |

- 單一檔案、位置已知的小任務不必開子代理。
- 子代理看不到主對話的內容:委派時寫清楚任務範圍,以及本 AGENT.md 的相關規則(外科手術式修改、跨 repo 修改要先同意、測試失敗不得改測試、寫入測試區或共用資料庫前要先問)。
- 子代理的結果由主對話**檢查後**才採用或回報;回報時說明哪些是子代理做的。子代理回報「通過」不等於已驗證。
- 子代理不經手密碼與機密值;`security-auditor` 回報時遮蔽密鑰,只寫檔案與行號。

---

## 0. 專案一句話

**DevOpsDiagram 是監控其他五個服務的維運平台** —— 它自己壞掉不能拖累任何被監控的服務。這個前提決定了本專案大部分的設計取捨，動手前請先理解第 9 章的鐵則。

---

## 1. 先思考再動手

### 規則
- **動手之前，先說明你的理解與假設**。用 1-3 句話摘要你打算做什麼、為什麼這樣做。
- **有任何疑問，先問，不要猜**。錯誤的假設比多問一個問題代價高得多。
- 如果需求模糊或有多種解讀方式，列出你看到的選項，讓人類選擇。
- 本專案的關鍵決策已記錄在 `docs/PRD.md` §12（D-01 ~ D-08）。**動到相關設計前先查那張表**，不要重新發明已經定案的東西。

### 範例
```
❌ 錯誤：直接開始寫程式碼
✅ 正確：「我理解你想讓錯誤頁支援依服務篩選。我假設篩選是走
    GET /api/v1/errors 的 serviceId 參數，而不是前端撈全部再過濾。
    這樣對嗎？」
```

---

## 2. 簡單優先

### 規則
- **用最少的程式碼解決當前問題**，不要加用不到的功能。
- 不要「順便」引入新的套件、設計模式或抽象層，除非任務明確要求。
- 不要寫「未來可能用到」的程式碼。等需要的時候再加。
- 後端**不使用 ORM**，直接用 mongodb driver。不要為了「比較好維護」引入 Mongoose。

### 本專案已經明確排除的東西
以下是 PRD 決策過的「v1 不做」，不要主動加：

| 不要做 | 原因 | 何時再議 |
|:---|:---|:---|
| 告警通知（Email / Teams / Line） | 範疇外 | v2 |
| 分散式追蹤串接 | 資料模型已預留 `traceId`，但不實作 | v2 |
| 通用資料存取 API | 預留 `projectId` 維度就好 | 有實際需求時 |
| 主機層級指標（CPU / Memory） | 不在範疇 | — |
| 使用者帳號系統 | 用 IP 白名單 + API Key | — |
| 架構圖線上編輯 | 以 `topology.json` 維護 | — |

### 範例
```
❌ 錯誤：為了查詢條件組合，建立 QueryBuilder + Specification Pattern
✅ 正確：直接組 Mongo filter 物件，一個函式就好
```

---

## 3. 外科手術式修改

### 規則
- **只改必須改的地方**。不要順手「整理」、「重構」或「優化」不相關的程式碼。
- 不要改動現有的程式碼格式（縮排、空行、引號風格），除非那就是你的任務。
- 不要重新命名你沒被要求改的變數或函式。
- 每次修改都應該能用一句話解釋為什麼改。

### 特別注意
`docs/` 下的五份文件與 `docs/Gherkin/*.feature` 是**需求的真實來源**。改程式碼時若發現與文件不符：

1. 先確認是文件過時，還是程式碼寫錯
2. 是文件過時 → 提出來，取得同意後改文件，並在文件的版本與更新日期留痕
3. 是程式碼寫錯 → 改程式碼，文件不動

**不要**默默改文件去遷就程式碼。

### 範例
```
❌ 錯誤：修 SSE 重連的 bug，順手把整個 store 改成 setup 寫法
✅ 正確：只改重連退避的那幾行，其他一字不動
```

---

## 4. 目標導向執行

### 規則
- **先定義成功標準**：在開始之前，明確說出「做到什麼程度算完成」。
- 本專案的成功標準大多已寫成 Gherkin 場景，**優先引用 `docs/Gherkin/` 中的場景當驗收條件**。
- 自己迭代直到達成目標，不要每做一步就停下來問。
- 如果遇到阻塞（缺少資訊、權限不足），才停下來回報。
- 完成時，簡要說明做了什麼、驗證了什麼。

### 範例
```
❌ 錯誤：「我已經寫好了 ingest route，你要不要看一下再繼續？」
✅ 正確：「我完成了 POST /api/v1/ingest/logs，涵蓋
    ingest.feature 的批次回報、單筆格式錯誤只丟棄該筆、
    批次超上限整批拒絕三個場景，已確認回應格式符合
    API_CONTRACT.md §2.1。」
```

---

## 5. 尊重既有風格

### 規則
- **遵循現有程式碼的命名規範、寫法與慣例**，不要悄悄引入自己的風格。
- 新增程式碼前，先看同目錄下的現有檔案，學習它的風格。
- 保持一致性比「更好的寫法」更重要。
- 本專案前端**沿用 `D:\檔案分享\Tools\archatlas`** 的結構與寫法（Vue Flow 節點、dagre 分層、Pinia store 切法），新增元件前先看它怎麼寫。

### 本專案慣例

| 項目 | 規範 |
|:---|:---|
| 前端框架 | Vue 3 Composition API (`<script setup>`) + TypeScript |
| 前端 UI | Naive UI；圖表用 Vue Flow (`@vue-flow/core`) + dagre |
| 前端狀態 | Pinia |
| 後端框架 | Node.js + Express (**CommonJS**，與其他四個服務一致) |
| 資料庫存取 | mongodb driver（**不用 ORM**）+ ioredis |
| 命名規範 | 函式/變數 `camelCase`，類別/型別 `PascalCase`，檔名 `camelCase.js` |
| API 路徑 | `/api/v1/{resource}` 或 `/api/v1/{resource}/{action}` |
| serviceId | 小寫英數與連字號，例如 `gigaks-backend` |
| Redis key | `dvd:{projectId}:{用途}:{serviceId}`，前綴不可省略 |
| Mongo 欄位 | `camelCase`；時間欄位一律 `Date` 型別不存字串 |
| 註解語言 | 繁體中文或英文皆可，同一檔案內統一 |

> **注意 API 路徑格式**：本專案是 `/api/v1/...`，與 NotesAPP 的 `/v1/api/...` 不同。這是刻意與 GigaSolarKnowledgeBase 對齊，不要「順手改成一致」。

### 範例
```
❌ 錯誤：現有程式碼用 camelCase，你卻寫 snake_case
❌ 錯誤：後端是 CommonJS，你卻寫 import / export
❌ 錯誤：前端用 Naive UI，你卻引入 Element Plus 或 Tailwind
✅ 正確：新增的 service 模組沿用既有的 module.exports 與 async/await 風格
```

---

## 6. 失敗要明確說

### 規則
- **失敗就說失敗**，不能把「靜默跳過」包裝成「任務完成」。
- 如果某個步驟做不到、某個 API 回傳錯誤、某段程式碼無法通過測試，必須明確告知。
- 不要用 `try { } catch { }` 吞掉錯誤。
- 不要刪掉失敗的測試案例來讓測試「通過」。

### 本專案的例外：SDK 必須吞錯誤
`backend/sdk/` 底下的回報 SDK 是**唯一允許靜默失敗**的地方 —— 它跑在別人的正式環境裡，任何例外都不能往外拋。但即使在 SDK 裡：

- 失敗要 `console.warn` 留痕，不可完全無聲
- 只吞「送出回報」的錯誤，**不吞業務邏輯的錯誤**

除此之外，平台本身的程式碼一律遵守本章規則。

### 範例
```
❌ 錯誤：「已完成部署」（實際上 dvd-backup 容器啟動失敗但沒提）
❌ 錯誤：靜默 catch 所有 exception，回傳空結果假裝成功
✅ 正確：「後端與前端已啟動，但 dvd-backup 啟動失敗，
    錯誤訊息是 'mongodump: command not found'，
    應該是 Dockerfile 少裝 mongodb-database-tools。」
```

---

## 7. 專案參考文件

開發前請先閱讀以下文件，確保理解專案全貌：

| 文件 | 路徑 | 說明 |
|:---|:---|:---|
| 產品需求 | `docs/PRD.md` | 功能定義、驗收標準、**§12 決策紀錄** |
| 系統架構 | `docs/ARCHITECTURE.md` | 容器設計、模組結構、狀態判定邏輯、故障影響分析 |
| API 合約 | `docs/API_CONTRACT.md` | 所有端點定義、錯誤碼、SSE 事件 |
| 資料庫設計 | `docs/DB_SCHEMA.md` | Collection 欄位、索引、Redis key、保存規則 |
| 接入手冊 | `docs/INTEGRATION_GUIDE.md` | **給各服務後端的文件**，改動 SDK 或 Ingest 格式時必須同步更新 |
| 驗收規格 | `docs/Gherkin/*.feature` | 12 份可執行的驗收條件 |

### 閱讀順序建議
第一次接觸本專案：`PRD.md` §12 決策紀錄 → `ARCHITECTURE.md` §1 架構總覽 → 你要動的那一塊的細節文件。

---

## 8. 技術棧速查

| 層級 | 技術 |
|:---|:---|
| 前端框架 | Vue 3 (Composition API `<script setup>`) + Vite + TypeScript |
| 前端 UI | Naive UI |
| 前端圖表 | Vue Flow (`@vue-flow/core`) + dagre (`@dagrejs/dagre`) 分層排版 |
| 前端狀態 | Pinia |
| 前端即時更新 | 原生 `EventSource` (SSE)，斷線退回輪詢 |
| 後端 | Node.js + Express (CommonJS) |
| 資料庫 | MongoDB 7（主儲存）+ Redis 7（快取） |
| 資料庫存取 | mongodb driver + ioredis（**無 ORM**） |
| 備份 | mongodump（獨立排程容器，每日 03:00，保留 30 份） |
| 後端測試 | Jest + Supertest |
| 前端測試 | Vitest + jsdom + @vue/test-utils |
| BDD 測試 | Playwright + playwright-bdd（執行 `docs/Gherkin/*.feature`） |
| 部署 | Docker Compose（前端 :5131 / 後端 :5132 / SSE :5133） |

### 監控對象與環境

| 項目 | 內容 |
|:---|:---|
| 生產主機 | `10.10.130.122` |
| 開發/測試主機 | `10.10.112.13`（本機，Docker） |
| 首個接入驗證對象 | GigaSolarKnowledgeBase（`:5155`，已有 `/health`） |
| 其他監控對象 | BPM (`:5147/5148/5149`)、GeneralBackend (`:5123/5124/5125`)、NotesAPP (`:5121/5122`)、DockerAutomatedScheduling |
| 本專案 Port | 5131 前端 / 5132 API / 5133 SSE / 5134、5135 保留 |

---

## 9. 本專案鐵則（違反就是 bug）

以下每一條都來自已定案的決策，**不要在未經討論的情況下改動**：

### 9.1 Mongo / Redis 永遠不對外開放
`docker-compose.yml` 中 `dvd-mongo` 與 `dvd-redis` **不得宣告 `ports`**。外部寫入一律經過 5132 的 Ingest API（PRD D-01）。看到有人想加 port 對應，先問清楚原因。

### 9.2 serviceId 與 projectId 由 API Key 決定
**永遠不採信 client 在 body 中自報的 `serviceId` / `projectId`**。這是多服務共用同一套儲存的隔離基礎（PRD D-03、US-06）。

### 9.3 error_logs 沒有 TTL
`error_logs` 與 `service_status`、`services`、`api_keys` **不建立 TTL 索引**。只有 `api_logs` 與 `heartbeats` 有（PRD D-04）。

### 9.4 敏感欄位雙重遮蔽
SDK 端遮一次、平台端再遮一次。不要因為「SDK 已經處理過了」就把平台端的遮蔽拿掉 —— 有服務會用 curl 直接回報（PRD §4.5）。

### 9.5 SDK 絕不阻塞原服務
`backend/sdk/` 的任何修改都必須維持：非同步送出、1 秒逾時、失敗進緩衝、緩衝滿丟最舊。**不得在請求路徑上做任何網路等待**（PRD §8、`sdk-failsafe.feature`）。

### 9.6 狀態判定只有一個來源
`healthy / degraded / down / unknown` 的判斷集中在 `statusService`。Ingest 與 Prober 只餵資料，**不得直接寫 `service_status`**（ARCHITECTURE §3）。

### 9.7 Ingest 格式向後相容
平台永遠接受少欄位的舊版 payload，缺的補預設值。五個服務不會同時升級 SDK，**不能因為平台改版就讓某個服務的回報全被拒**（API_CONTRACT §8）。

### 9.8 Redis key 一律帶前綴
格式 `dvd:{projectId}:...`。這套 Redis 未來會有其他專案共用，少一段前綴就是撞 key（DB_SCHEMA §3）。

### 9.9 停用 API Key 要清快取
停用後必須 `DEL dvd:key:{hash}`，否則最長 10 分鐘內仍會通過驗證（DB_SCHEMA §3）。

### 9.10 改 Ingest 格式要同步更新接入手冊
`docs/INTEGRATION_GUIDE.md` 是給**別的團隊**看的。改了回報格式卻沒更新手冊，等於讓別人照著錯的文件接。

---

## 10. 修正紀錄

Bug 修改紀錄與新增功能紀錄、前端修改紀錄、後端修改紀錄

1. 由用戶自行進行測試，你不需要開啟瀏覽器檢測
2. 每次修正都需留紀錄

| 文件 | 路徑 | 說明 |
|:---|:---|:---|
| Bug 修改紀錄 | `docs/DevelopmentProcess/BugFix.md` | Bug 修改紀錄 |
| 新增功能紀錄 | `docs/DevelopmentProcess/NewFeatures.md` | 新增功能紀錄 |
| 前端修改紀錄 | `docs/DevelopmentProcess/FrontendCorrection.md` | 前端修改紀錄 |
| 後端修改紀錄 | `docs/DevelopmentProcess/BackendCorrection.md` | 後端修改紀錄 |
| SDK 修改紀錄 | `docs/DevelopmentProcess/SdkCorrection.md` | **SDK 改動會影響五個服務，一律留紀錄** |

### 紀錄格式
```markdown
## YYYY-MM-DD｜一句話標題

**問題**：發生什麼事
**原因**：為什麼會這樣
**修改**：改了哪些檔案的哪些地方
**驗證**：怎麼確認修好了（跑了哪個測試 / 哪個 Gherkin 場景）
**影響範圍**：是否影響已接入的服務
```

---

## 11. 自動化測試 (TDD / BDD)

### 規則
- **改到有測試的模組，先跑測試再交付**。測試紅燈就是沒做完。
- **修 bug 時先寫一個會失敗的測試**，再改程式碼讓它變綠，避免同一個 bug 復發。
- 新增後端 route / service、前端 store / 純邏輯元件時，補上對應測試。
- **測試不連真實資料庫、不打 10.10.130.122**。後端用 `mongodb-memory-server` 或攔截 `config/mongo`、`config/redis`；前端 BDD 用 Playwright `page.route()` 攔截整個後端。

### 指令

| 範圍 | 指令 | 工具 |
|:---|:---|:---|
| 後端單元/路由測試 | `cd backend && npm test` | Jest + Supertest |
| 前端單元/元件測試 | `cd frontend && npm test` | Vitest + jsdom + @vue/test-utils |
| BDD 行為測試 | `cd frontend && npm run test:bdd` | Playwright + playwright-bdd |

### 為什麼後端用 Jest、前端用 Vitest
後端是 CommonJS，Vitest 無法攔截 `require()`，mock 會失效並真的去連資料庫；
前端是 Vite + ESM，Vitest 可直接沿用專案既有的編譯設定。兩邊各用適合的工具，不強行統一。
（與 NotesAPP 相同的理由與做法。）

### BDD 與 Gherkin
`docs/Gherkin/*.feature` 不只是文件，是**可執行的驗收測試**。
playwright-bdd 原生支援 `# language: zh-TW`，feature 檔不需要為了測試改寫。
step definitions 位於 `frontend/e2e/steps/`，尚未接上 step definitions 的場景以
`playwright.config.js` 的 `tags` 排除，補齊後放寬條件即可。

### 標籤與執行範圍
feature 檔已標註里程碑與重要性，可依標籤挑要跑的範圍：

| 標籤 | 意義 | 建議用法 |
|:---|:---|:---|
| `@M1` ~ `@M5` | 對應里程碑 | 開發中只跑當前里程碑 |
| `@critical` | 壞掉就不能上線 | CI 必跑 |
| `@security` | 資安相關 | CI 必跑 |
| `@manual` | 難以自動化，需人工驗收 | 從自動化中排除 |
| `@US-xx` / `@D-xx` | 對應 PRD 使用者故事與決策 | 追溯需求時使用 |

```bash
# 只跑當前里程碑的核心場景
npm run test:bdd -- --tags "@M1 and @critical and not @manual"
```

### 特別需要測試的部分
以下幾塊出錯的代價最高，改動時務必補測試：

1. **API Key 驗證與隔離**（`api-key.feature`）—— 錯了就是資安問題
2. **錯誤分流**（`ingest.feature`）—— 錯了會讓該永久保存的資料 7 天後消失
3. **SDK fail-safe**（`sdk-failsafe.feature`）—— 錯了會拖垮別人的正式服務
4. **狀態判定**（`service-status.feature`）—— 錯了整個平台的可信度歸零
