# language: zh-TW
@D-08 @M4
功能: 排程服務執行紀錄
  身為維運人員
  我希望排程任務的每次執行都被記錄下來
  以便我能回答「昨天的合約到期通知有沒有跑成功」

  背景:
    假設 平台已啟動
    而且 我持有 serviceId 為 "das-scheduler" 的有效 ingest Key

  # ── 基本回報 ────────────────────────────────────────────

  @critical
  場景: 排程執行成功時回報一筆紀錄
    當 我回報一次排程執行
      | name                  | trigger | cronExpr       | status | durationMs |
      | contractExpiryNotify  | cron    | 0 9 15,28 * *  | 200    | 4200       |
    那麼 回應狀態碼應為 202
    而且 "api_logs" 應新增 1 筆紀錄
    而且 該筆紀錄的 kind 應為 "job"
    而且 該筆紀錄的 request.method 應為 "JOB"
    而且 該筆紀錄的 request.path 應為 "contractExpiryNotify"

  @critical
  場景: 排程執行失敗時進入永久保存區
    當 我回報一次失敗的排程執行，status 為 500
    那麼 該筆紀錄應寫入 "error_logs"
    而且 該筆紀錄不應設定 expireAt
    而且 該筆紀錄應包含 error 的 name 與 message

  場景: 保存觸發來源與排程表達式
    當 我回報一次 trigger 為 "cron"、cronExpr 為 "0 9 15,28 * *" 的執行
    那麼 該筆紀錄的 request.body 應包含 trigger 為 "cron"
    而且 該筆紀錄的 request.body 應包含 cronExpr

  場景: 區分手動觸發與排程觸發
    當 我回報一次 trigger 為 "manual" 的執行
    那麼 該筆紀錄的 request.body.trigger 應為 "manual"

  場景: 保存執行結果摘要
    當 我回報一次執行，結果為 "{ processed: 12, sent: 3, skipped: 0 }"
    那麼 該筆紀錄的 response.body 應包含 processed 為 12
    而且 該筆紀錄的 response.durationMs 應為該次總執行時間

  # ── 執行步驟 ────────────────────────────────────────────

  場景: 保存執行步驟與各步驟耗時
    當 我回報一次執行，包含下列步驟
      | seq | type  | target          | durationMs | note              | ok   |
      | 1   | db    | mssql.contracts | 320        | 找到 12 筆         | true |
      | 2   | other | smtp            | 3800       | 寄出 1 封          | true |
    那麼 該筆紀錄應保存 2 筆 actions
    而且 我應能從 actions 看出寄信是最慢的步驟

  場景: 步驟失敗時標示於該步驟
    當 我回報一次執行，其中寄信步驟的 ok 為 false
    那麼 該步驟的 ok 應為 false
    而且 該筆紀錄應可從錯誤頁查到

  # ── 沿用同一套查詢介面 ──────────────────────────────────

  場景: 排程紀錄可在一般紀錄查詢中找到
    假設 "das-scheduler" 已有 5 筆排程執行紀錄
    當 我查詢 serviceId 為 "das-scheduler" 的紀錄
    那麼 應回傳 5 筆

  場景: 可只查排程類紀錄
    假設 平台中同時存在 http 與 job 兩種紀錄
    當 我查詢 kind 為 "job" 的紀錄
    那麼 應只回傳排程類紀錄

  場景: 排程失敗在錯誤頁依任務名稱聚合
    假設 "contractExpiryNotify" 連續 3 次執行失敗
    當 我呼叫 "GET /api/v1/errors"
    那麼 應有一組 pathTemplate 為 "contractExpiryNotify" 的聚合結果
    而且 該組的 count 應為 3

  場景: 排程服務不另開前端頁面
    當 我點擊架構圖上的 "das-scheduler" 節點
    那麼 應使用與其他服務相同的詳情面板
    而且 紀錄分頁應顯示排程執行紀錄

  # ── 存活判定 ────────────────────────────────────────────

  場景: 排程服務同樣以心跳判定存活
    當 "das-scheduler" 每 30 秒回報心跳
    那麼 該節點應顯示為 "healthy"

  場景: 排程沒跑不等於服務掛掉
    假設 "das-scheduler" 心跳正常但 24 小時內沒有任何排程執行
    當 狀態重算執行
    那麼 該節點的 status 應為 "healthy"

  @M5
  場景: 備份任務本身也是一個排程紀錄
    當 每日備份執行完成
    那麼 應以 serviceId "devopsdiagram-backup" 回報一筆 job 紀錄
    而且 備份失敗時該節點應在架構圖上轉紅
