# SDK 修改紀錄

> **SDK（`backend/sdk/`）跑在五個服務的正式環境裡，任何改動都可能影響它們。**
> 每次修改都必須留紀錄，且須確認向後相容。格式見 [AGENT.md](../../AGENT.md) §10。

---

## 修改前必讀

| 檢查項 | 說明 |
|:---|:---|
| 是否維持非阻塞 | 不得在請求路徑上做任何網路等待 |
| 是否維持 1 秒逾時 | 平台慢不能拖慢原服務 |
| 是否維持緩衝行為 | 失敗進緩衝、滿了丟最舊、`console.warn` 留痕 |
| 是否向後相容 | 舊版 SDK 的 payload 平台仍須接受 |
| 是否需要各服務更新 | 若是，須在紀錄中列出受影響的服務並通知其開發者 |
| 接入手冊是否同步 | `docs/INTEGRATION_GUIDE.md` 是給別的團隊看的 |

---

## 紀錄格式

```markdown
## YYYY-MM-DD｜版本｜一句話標題

**內容**：改了什麼
**相容性**：舊版 SDK 是否仍可正常回報（必填）
**需要各服務更新嗎**：是 / 否；若是，列出服務清單與更新方式
**驗證**：對應的 sdk-failsafe.feature 場景 / 測試
**手冊同步**：INTEGRATION_GUIDE.md 是否已更新
```

---

## 2026-09-18｜v1.0.0｜首版 SDK 與 GigaSolarKnowledgeBase 接入

**內容**：實作 `reporter()` Express middleware 與 `reportJob()` 排程回報，無外部相依（只用 Node 內建模組），可整個資料夾複製進任何 Node 專案。

**接入對象**：GigaSolarKnowledgeBase 後端（`gigaks-backend`）
- SDK 複製到 `GigaSolarKnowledgeBase/backend/src/lib/devopsReporter.js`
- `src/index.js` 在 `express.json()` 之後、所有路由之前註冊 middleware，新增 7 行
- `.env` 新增 `DEVOPS_ENDPOINT` / `DEVOPS_API_KEY` / `DEVOPS_SERVICE_ID`
- `docker-compose.yml` 加 `extra_hosts: host.docker.internal:host-gateway`，讓容器打得到宿主機的 5132

**相容性**：首版，無舊版相容問題

**需要各服務更新嗎**：否（其餘四個服務尚未接入，列於 M4）

**驗證（sdk-failsafe.feature）**

| 場景 | 結果 |
|------|------|
| 平台完全無法連線時服務照常運作 | ✅ 停掉 dvd-backend 後 GigaKS 回應時間 4.4–5.8ms，與平台正常時的 3.5–5.6ms 無顯著差異 |
| 平台回傳錯誤時不拋例外到原服務 | ✅ GigaKS 日誌無任何未處理例外 |
| 送出失敗時保留在緩衝等待重送 | ✅ 停機期間打的 10 次請求，平台恢復後全數補上 |
| 排除的路徑不產生紀錄 | ✅ `/health` 未出現在任何紀錄中 |
| 未設定 API Key 時自動停用 | ✅ 單元測試涵蓋 |
| 緩衝滿時丟棄最舊的紀錄 | ✅ 單元測試涵蓋 |

另有 `backend/tests/sdk.test.js` 共 16 項單元測試全數通過。

**手冊同步**：`INTEGRATION_GUIDE.md` 的內容與實作一致，未需異動

---

## 2026-09-18｜v1.0.1｜修正 `pathTemplate` 在認證攔截時退回 `/`

**內容**：請求被認證中介層擋下時 `req.route` 是 undefined，原本退回 `req.path` —— 但在掛載的 router 內它已被 Express 去掉 baseUrl 變成 `/`，導致不同端點的 401 在錯誤頁被聚合成同一組。改為退回 `req.originalUrl.split('?')[0]`。

詳見 [BugFix.md](./BugFix.md) 的同名條目。

**相容性**：完全相容。只影響 SDK 送出的 `pathTemplate` 值，平台端不需任何改動，舊版 SDK 的回報照常接受。

**需要各服務更新嗎**：是
- `gigaks-backend` —— 已更新並重建容器
- 其餘服務尚未接入，M4 接入時直接使用新版

**驗證**：對 GigaKS 打 `/api/v1/meta`、`/api/v1/tags`、`/api/v1/directories`，錯誤頁聚合為三組獨立結果

**手冊同步**：無需異動（手冊對 `pathTemplate` 的說明本來就是「自動從 `req.route.path` 取得」，行為符合描述）

---

## 2026-09-18｜相容性驗證：Express 5.1.0

**內容**：未改動 SDK，僅補上相容性實測。GeneralBackend 三個服務與 NotesAPP 後端使用 Express 5.1.0，而 SDK 是在 Express 4.18（GigaKS）上開發驗證的，接入前先確認。

**測試方式**：以 GeneralBackend 已安裝的 express 5.1.0 建一個含掛載式 router 的最小應用，掛上 SDK 後打四種情境（route 匹配、含 body 的 POST、500 錯誤、認證攔截），endpoint 故意指向打不通的位址。

**結果**：8 項檢查全部通過

| 檢查 | 結果 |
|------|------|
| 產生 4 筆紀錄 | ✅ |
| route 匹配時 `pathTemplate` 帶參數樣式（`/api/v1/articles/:id`） | ✅ |
| 認證攔截時 `pathTemplate` 不退化為 `/` | ✅ |
| `password` 有被遮蔽 | ✅ |
| 500 被標記為 `level: error` | ✅ |
| `req.devops.action()` 有被記錄 | ✅ |
| `query` 有被保留 | ✅ |
| 平台打不通時原服務全部正常回應 | ✅ |

**結論**：Express 4.18 / 4.19 / 5.1.0 皆相容，各服務接入時不需特別處理。已寫入 [INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) §9.2。

**相容性**：無程式異動

**需要各服務更新嗎**：否

---

## 2026-09-18｜補上 `reportJob()` 的測試覆蓋

**內容**：無程式異動。撰寫 [SERVICE_PATCHES.md](../SERVICE_PATCHES.md) 要 DAS 採用 `reportJob()` 時發現它完全沒有測試覆蓋 —— 在叫別的團隊改他們的排程核心之前，這個介面應該先有保障。

**新增測試**（`backend/tests/sdk.test.js`，5 項）
- 成功執行產生一筆 `kind: job` 紀錄，欄位對應正確（`method: JOB`、`path` 為 job 名稱、`trigger`、`cronExpr`、`actions`）
- 失敗執行標記為 `level: error`、`status: 500`，並帶上例外內容
- 手動觸發與排程觸發可區分
- 正確記錄執行時間
- SDK 停用時呼叫 `reportJob()` 不拋例外（DAS 本機開發不設 Key 時的情況）

**相容性**：無程式異動

**需要各服務更新嗎**：否

**驗證**：`backend/tests/sdk.test.js` 20 項通過，整體 68 項通過

---

## 2026-09-18｜v1.0.2｜修正 ORM 物件造成的 event loop 阻塞（緊急）

**內容**：`maskDeep()` 繞過 `toJSON()` 直接列舉屬性，在 Sequelize 這類 ORM 的 model 實例上會挖出內部循環參考，導致成本指數成長並阻塞 event loop。加上三道保護：先走 `toJSON()`、WeakSet 循環偵測、5000 節點預算。序列化路徑改用 `safeStringify()`，任何情況都不拋例外。

完整分析見 [BugFix.md](./BugFix.md) 的同名條目。

**相容性**：完全相容。只影響 SDK 內部的資料處理，回報格式與平台端不需任何改動。舊版 SDK 的回報照常接受。

**需要各服務更新嗎**：**是，而且緊急**

| 服務 | 狀態 |
|------|------|
| `gigaks-backend`（本機） | 已同步並重建驗證 |
| `gigaks-backend`（生產） | **待更新 —— 使用者正受影響** |
| 其餘服務 | 尚未接入，M4 接入時直接使用新版 |

更新方式：複製 `backend/sdk/index.js` 覆蓋該服務的 `lib/devopsReporter.js`，然後 `docker compose up -d --build <服務>`。

**驗證**
- 事故重現腳本：12 標籤 × 6 編輯者的結構，3144 ms → 0.0 ms
- 新增 13 項回歸測試（`tests/mask.test.js` 8 項、`tests/sdk.test.js` 5 項）
- 整體測試 82 項通過
- 本機 GigaKS 重建後日誌無任何 `devops-reporter` 錯誤

**手冊同步**：[INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) §6 與 [SERVICE_PATCHES.md](../SERVICE_PATCHES.md) §10 對「不會拖慢你的服務」的說明，在此修正前對使用 ORM 的服務並不成立。修正後說明重新成立，內容無需改寫。
