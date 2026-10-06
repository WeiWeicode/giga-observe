# language: zh-TW
@US-05 @M2 @M4
功能: 服務接入流程
  身為後端開發者
  我希望照著手冊貼上程式碼就能開始回報
  以便我不用花半天研究資料格式

  背景:
    假設 平台已部署且可從各服務主機連線
    而且 接入手冊 INTEGRATION_GUIDE.md 已提供

  # ── 端到端接入（US-05）─────────────────────────────────

  @critical
  場景: 依照手冊完成接入
    假設 我是 "gigaks-backend" 的開發者且未接入過
    當 我向平台維護者索取 API Key
    而且 我依照手冊安裝 SDK 並註冊 middleware
    而且 我將 Key 寫入 .env 並重啟服務
    那麼 該服務應在 60 秒內於架構圖上顯示為 "healthy"
    而且 該服務的 API 呼叫應在 5 秒內出現在紀錄中

  @critical @manual
  場景: 接入所需的程式碼變更控制在最小範圍
    當 我依照手冊接入一個既有服務
    那麼 需要新增的程式碼應不超過 6 行
    而且 既有的路由與錯誤處理不需修改

  場景: 手冊涵蓋必要內容
    當 我閱讀接入手冊
    那麼 手冊應說明如何取得 API Key
    而且 手冊應包含完整的 Express 範例
    而且 手冊應說明如何記錄執行動作
    而且 手冊應說明排程服務的接法
    而且 手冊應包含驗證接入成功的檢查清單

  # ── 註冊順序 ────────────────────────────────────────────

  場景: middleware 註冊在 body parser 之後才能記錄 body
    假設 middleware 註冊在 "express.json()" 之後
    當 有人以 JSON body 呼叫 API
    那麼 紀錄中應包含 request body

  場景: middleware 註冊在 body parser 之前會缺少 body
    假設 middleware 註冊在 "express.json()" 之前
    當 有人以 JSON body 呼叫 API
    那麼 紀錄中的 request body 應為空
    而且 此現象應記載於手冊的故障排除表

  場景: middleware 註冊在路由之後將攔不到請求
    假設 middleware 註冊在所有路由之後
    當 有人呼叫 API
    那麼 不應產生任何紀錄
    而且 此現象應記載於手冊的故障排除表

  # ── 最小接入方式 ────────────────────────────────────────

  場景: 只送心跳也能在架構圖上顯示存活
    假設 某服務不使用 SDK，僅以 curl 每 30 秒送心跳
    當 該服務持續運行
    那麼 該節點應顯示為 "healthy"
    但是 該節點不應有任何 API 紀錄

  場景: 完全不改程式也能被監控存活
    假設 "gigaks-frontend" 不做任何程式修改
    而且 平台在 topology 中設定其 healthUrl
    當 Pull 探測執行
    那麼 該節點應顯示為 "healthy"

  場景: 非 Node 服務可直接以 HTTP 回報
    假設 某服務非 Node.js 撰寫
    當 該服務依手冊格式直接呼叫 "POST /api/v1/ingest/logs"
    那麼 回應狀態碼應為 202
    而且 該筆紀錄應正常出現在查詢結果中

  # ── 環境區分 ────────────────────────────────────────────

  場景: 測試與正式環境使用不同的 serviceId
    假設 "gigaks-backend" 與 "gigaks-backend-dev" 各持有一組 Key
    當 兩個環境同時回報
    那麼 兩者的紀錄應分別歸屬於各自的 serviceId
    而且 架構圖上應為兩個獨立節點

  場景: 本機開發可關閉回報
    假設 開發者的環境變數中沒有 DEVOPS_API_KEY
    當 服務於本機啟動
    那麼 SDK 應自動停用
    而且 服務應正常啟動

  # ── 故障排除 ────────────────────────────────────────────

  場景大綱: 常見接入問題可由手冊自行排除
    假設 開發者遇到「<現象>」
    當 開發者查閱手冊的故障排除表
    那麼 應能找到原因「<原因>」

    例子:
      | 現象                    | 原因                       |
      | 回應 401 MISSING_API_KEY | 沒帶 header 或 .env 未載入 |
      | 回應 401 INVALID_API_KEY | Key 錯誤或已停用           |
      | 回應 403                | 拿錯權限的 Key             |
      | 節點是灰色 unknown       | serviceId 拼錯或服務未啟動 |
      | 節點是紅色 down          | 超過 90 秒沒有心跳         |
      | 有心跳但沒有 API 紀錄     | middleware 註冊順序錯誤    |
      | body 是空的              | 註冊在 body parser 之前    |

  # ── 首波接入驗證（M2 / M4）─────────────────────────────

  @M2 @critical
  場景: GigaSolarKnowledgeBase 作為首個接入對象通過驗證
    假設 "gigaks-backend" 已完成接入
    當 我在本機對該服務執行一輪操作
    那麼 架構圖上該節點應為綠色
    而且 詳情面板的最後心跳應在 30 秒內
    而且 紀錄分頁應顯示剛才的 API 呼叫
    當 我故意觸發一支會回 500 的 API
    那麼 該筆錯誤應出現在錯誤分頁
    而且 該筆錯誤應永久保存

  @M4
  場景大綱: 其餘服務依序接入
    假設 "<服務>" 尚未接入
    當 依手冊完成接入
    那麼 該服務應出現在架構圖上且狀態正確

    例子:
      | 服務                   | 接入方式      |
      | bpm-backend            | SDK 完整接入  |
      | general-backend        | SDK 完整接入  |
      | general-filebackend    | SDK 完整接入  |
      | general-smbbackend     | SDK 完整接入  |
      | notesapp-backend       | SDK 完整接入  |
      | das-scheduler          | reportJob     |
      | gigaks-frontend        | Pull 探測     |
      | notesapp-frontend      | Pull 探測     |
      | bpm-cdn                | Pull 探測     |

  @M4
  場景: 未提供健康端點的服務僅靠 Push 心跳
    假設 某服務沒有 "/health" 端點
    而且 其 topology 設定 monitor.enabled 為 false
    當 該服務以 SDK 回報心跳
    那麼 該節點應顯示為 "healthy"
    而且 平台不應對該服務發出探測請求
