# language: zh-TW
@US-03 @D-04 @M1 @M3
功能: 錯誤 API 追蹤
  身為維運人員
  我希望有一頁列出所有服務的錯誤 API 並能聚合排序
  以便我能優先處理最常爆的那一支

  背景:
    假設 平台已啟動
    而且 我持有有效的 read Key
    而且 error_logs 中已存在下列錯誤
      | serviceId      | ts                       | method | pathTemplate         | status |
      | gigaks-backend | 2026-09-18T07:00:00.000Z | GET    | /api/v1/articles/:id | 500    |
      | gigaks-backend | 2026-09-18T07:30:00.000Z | GET    | /api/v1/articles/:id | 500    |
      | gigaks-backend | 2026-09-18T08:00:00.000Z | GET    | /api/v1/articles/:id | 500    |
      | gigaks-backend | 2026-09-18T08:05:00.000Z | POST   | /api/v1/ai/summarize | 502    |
      | bpm-backend    | 2026-09-18T08:10:00.000Z | POST   | /api/flow/submit     | 500    |

  # ── 聚合 ────────────────────────────────────────────────

  @critical
  場景: 相同 API 的重複錯誤聚合為一組
    當 我呼叫 "GET /api/v1/errors"
    那麼 應回傳 3 組聚合結果
    而且 "gigaks-backend" 的 "/api/v1/articles/:id" 500 該組的 count 應為 3

  @critical
  場景: 聚合組顯示首次與最近發生時間
    當 我呼叫 "GET /api/v1/errors"
    那麼 "/api/v1/articles/:id" 該組的 firstSeenAt 應為 "2026-09-18T07:00:00.000Z"
    而且 該組的 lastSeenAt 應為 "2026-09-18T08:00:00.000Z"

  場景: 聚合以 pathTemplate 而非實際路徑分組
    假設 有 3 筆錯誤，實際路徑分別為 "/api/v1/articles/1"、"/api/v1/articles/2"、"/api/v1/articles/3"
    而且 三者的 pathTemplate 皆為 "/api/v1/articles/:id"
    當 我呼叫 "GET /api/v1/errors"
    那麼 三者應聚合為 1 組，count 為 3

  場景: 不同狀態碼視為不同組
    假設 同一支 API 有 500 與 502 兩種錯誤
    當 我呼叫 "GET /api/v1/errors"
    那麼 應分為 2 組

  場景: 不同服務的相同路徑視為不同組
    假設 "gigaks-backend" 與 "bpm-backend" 都有 "/api/health" 的 500 錯誤
    當 我呼叫 "GET /api/v1/errors"
    那麼 應分為 2 組

  場景: 聚合組附帶範例錯誤訊息與可追查的紀錄 id
    當 我呼叫 "GET /api/v1/errors"
    那麼 每組應包含 sampleErrorMessage
    而且 每組應包含 sampleLogId

  # ── 排序與篩選 ──────────────────────────────────────────

  場景: 預設依出現次數排序
    當 我呼叫 "GET /api/v1/errors" 不指定 sort
    那麼 結果應依 count 由多到少排列

  場景: 可依最近發生時間排序
    當 我呼叫 "GET /api/v1/errors" 且 sort 為 "latest"
    那麼 結果應依 lastSeenAt 由新到舊排列

  場景大綱: 依條件篩選錯誤
    當 我以 <參數> 為 "<值>" 查詢錯誤
    那麼 應回傳 <組數> 組

    例子:
      | 參數      | 值             | 組數 | 說明           |
      | serviceId | gigaks-backend | 2    | 依服務         |
      | serviceId | bpm-backend    | 1    | 依服務         |
      | status    | 500            | 2    | 依狀態碼       |
      | status    | 502            | 1    | 依狀態碼       |
      | path      | articles       | 1    | 依路徑關鍵字   |

  場景: 展開聚合組查看個別事件
    當 我呼叫 "GET /api/v1/errors/:groupKey/events"
    那麼 應回傳該組的所有個別事件
    而且 每筆事件應可點入查看完整明細

  # ── 永久保存與歷史回查 ──────────────────────────────────

  @critical @D-04
  場景: 錯誤紀錄可查詢一年前的資料
    假設 error_logs 中存在 400 天前的錯誤紀錄
    當 我查詢 from 為 400 天前的錯誤
    那麼 該筆錯誤應出現在結果中

  @critical @D-04
  場景: 錯誤紀錄不會被 TTL 清除
    假設 error_logs 中存在 400 天前的錯誤紀錄
    當 MongoDB 的 TTL 清理程序執行
    那麼 該筆錯誤紀錄應仍然存在

  @D-04
  場景: 4xx 進一般區但錯誤頁仍可篩選查看
    假設 存在一筆 404 的紀錄
    那麼 該筆應存在於 "api_logs"
    而且 該筆不應存在於 "error_logs"
    當 我在錯誤頁篩選狀態碼為 "4xx"
    那麼 該筆應出現在結果中

  @D-04
  場景: 4xx 紀錄 7 天後查不到
    假設 存在一筆 8 天前的 404 紀錄
    當 TTL 清理程序執行後我查詢該筆
    那麼 應查不到該筆紀錄

  @D-04
  場景: HTTP 200 但服務自報的錯誤永久保存
    假設 某服務回報一筆 status 為 200、level 為 "error" 的紀錄
    那麼 該筆應寫入 "error_logs"
    而且 該筆不應設定 expireAt
    而且 該筆應出現在錯誤頁

  # ── 前端呈現 ────────────────────────────────────────────

  @M3
  場景: 錯誤頁預設顯示近 7 天
    當 我開啟錯誤頁
    那麼 時間區間應預設為近 7 天

  @M3
  場景: 錯誤數上升時節點同步轉黃
    假設 "gigaks-backend" 的 status 為 "healthy"
    當 該服務近 5 分鐘的錯誤率超過 5%
    那麼 架構圖上該節點應轉為黃色
    而且 錯誤頁應出現對應的聚合組
