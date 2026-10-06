# language: zh-TW
@US-01 @US-02 @M3
功能: 架構圖與服務詳情
  身為維運人員
  我希望打開首頁就看到架構圖與每個服務的即時狀態
  以便我不用逐台連線就知道哪裡有問題

  背景:
    假設 平台已啟動
    而且 topology 中已登錄下列服務
      | id              | name       | type     | layer        | status   |
      | gigaks-frontend | 知識庫前端 | frontend | presentation | healthy  |
      | gigaks-backend  | 知識庫後端 | backend  | api          | healthy  |
      | bpm-backend     | BPM 後端   | backend  | api          | down     |
      | general-backend | 共用後端   | backend  | api          | degraded |
      | mssql-kb        | 知識庫 DB  | database | data         | unknown  |
    而且 我以有效的 read Key 開啟前端頁面

  # ── 地圖呈現 ────────────────────────────────────────────

  @critical
  場景: 首頁顯示所有服務節點
    當 我開啟首頁
    那麼 架構圖應顯示 5 個節點
    而且 首次資料應在 3 秒內載入完成

  @critical
  場景大綱: 節點依健康狀態上色
    當 我開啟首頁
    那麼 "<服務>" 的節點顏色應為 "<顏色>"

    例子:
      | 服務            | 顏色 | 狀態     |
      | gigaks-backend  | 綠   | healthy  |
      | general-backend | 黃   | degraded |
      | bpm-backend     | 紅   | down     |
      | mssql-kb        | 灰   | unknown  |

  場景: 節點依層級分層排列
    當 我開啟首頁
    那麼 presentation 層的節點應排在最上方
    而且 data 層的節點應排在下方
    而且 同一層的節點應水平並列

  場景: 節點顯示近 1 小時的請求與錯誤數
    假設 "gigaks-backend" 近 1 小時有 1284 筆請求、3 筆錯誤
    當 我開啟首頁
    那麼 "gigaks-backend" 的節點應顯示請求數 1284
    而且 該節點應顯示錯誤數 3

  場景: 連線顯示服務間的呼叫關係
    假設 topology 中有一條從 "gigaks-frontend" 到 "gigaks-backend" 的連線，標籤為 "REST"
    當 我開啟首頁
    那麼 兩個節點之間應顯示一條連線
    而且 該連線的標籤應為 "REST"

  場景: 支援縮放與平移
    當 我在架構圖上滾動滑鼠滾輪
    那麼 地圖應縮放
    當 我拖曳空白處
    那麼 地圖應平移

  # ── 搜尋與篩選 ──────────────────────────────────────────

  場景: 依名稱搜尋服務
    當 我在搜尋框輸入 "知識庫"
    那麼 "gigaks-frontend" 與 "gigaks-backend" 應被高亮
    而且 其餘節點應變淡

  場景: 依健康狀態篩選
    當 我篩選狀態為 "down" 與 "degraded"
    那麼 應只顯示 "bpm-backend" 與 "general-backend"

  場景: 依服務類型篩選
    當 我篩選類型為 "database"
    那麼 應只顯示 "mssql-kb"

  場景: 清除篩選後恢復全部顯示
    假設 我已篩選狀態為 "down"
    當 我清除篩選
    那麼 架構圖應重新顯示 5 個節點

  # ── 服務詳情面板（US-02）───────────────────────────────

  @US-02 @critical
  場景: 點擊節點展開詳情面板
    當 我點擊 "gigaks-backend" 節點
    那麼 應展開側邊詳情面板
    而且 面板應顯示服務名稱、類型、技術棧與 Repo 路徑
    而且 面板應顯示最後心跳時間
    而且 面板應顯示近 1 小時的請求數與錯誤數

  @US-02
  場景: 詳情面板顯示最近紀錄
    假設 "gigaks-backend" 近期有 80 筆紀錄
    當 我點擊該節點並切換到「紀錄」分頁
    那麼 應顯示最近 50 筆紀錄

  @US-02
  場景: 詳情面板可切換只看錯誤
    假設 "gigaks-backend" 近期有 50 筆一般紀錄與 5 筆錯誤
    當 我在紀錄分頁切換為「只看錯誤」
    那麼 應只顯示 5 筆錯誤紀錄

  @US-02 @critical
  場景: 從節點到錯誤明細不超過 3 次點擊
    假設 "bpm-backend" 有一筆 500 錯誤
    當 我點擊 "bpm-backend" 節點
    而且 我點擊「錯誤」分頁
    而且 我點擊該筆錯誤
    那麼 我應看到完整的 request、actions 與 response 內容

  @US-02
  場景: 詳情面板顯示上下游相依與其健康狀態
    假設 "gigaks-backend" 的上游為 "gigaks-frontend"、下游為 "mssql-kb"
    當 我點擊 "gigaks-backend" 並切換到「相依」分頁
    那麼 應顯示上游 "gigaks-frontend" 及其健康狀態
    而且 應顯示下游 "mssql-kb" 及其健康狀態

  場景: down 的服務顯示已中斷時長
    假設 "bpm-backend" 自 "2026-09-18T07:48:00.000Z" 起為 down
    而且 現在時間為 "2026-09-18T08:00:00.000Z"
    當 我點擊 "bpm-backend" 節點
    那麼 面板應顯示已中斷約 12 分鐘

  場景: 依賴異常在面板上標示
    假設 "gigaks-backend" 的心跳回報 qdrant 依賴異常
    當 我點擊該節點
    那麼 面板應標示 qdrant 為異常

  # ── 存取控制 ────────────────────────────────────────────

  @security
  場景: 生產環境僅允許指定 IP 存取前端
    假設 平台部署在生產環境，白名單為 "10.10.112.13"
    當 來源 IP 為 "10.10.130.50" 的使用者開啟前端
    那麼 應被拒絕存取

  @security
  場景: 生產環境的查詢 API 同樣受 IP 限制
    假設 平台部署在生產環境，白名單為 "10.10.112.13"
    當 來源 IP 為 "10.10.130.50" 以有效 read Key 呼叫 "GET /api/v1/logs"
    那麼 回應狀態碼應為 403
    而且 回應的錯誤代碼應為 "IP_NOT_ALLOWED"

  @security
  場景: Ingest 端點不受 IP 白名單限制
    假設 平台部署在生產環境，白名單為 "10.10.112.13"
    當 來源 IP 為 "10.10.130.50" 以有效 ingest Key 呼叫 "POST /api/v1/ingest/logs"
    那麼 回應狀態碼應為 202

  # ── 拓樸維護 ────────────────────────────────────────────

  場景: 重載拓樸設定不需重啟容器
    假設 我修改了 topology.json，新增一個服務
    當 我呼叫 "POST /api/v1/admin/topology/reload"
    那麼 回應應顯示服務數已增加
    而且 重新整理前端後應看到新節點
    而且 後端容器不應被重啟
