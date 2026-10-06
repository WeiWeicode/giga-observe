# language: zh-TW
@US-01 @M1 @critical
功能: 服務健康狀態判定
  身為維運人員
  我希望每個服務的健康狀態由單一邏輯判定且判準明確
  以便架構圖上的顏色始終可信，不會出現前後矛盾

  背景:
    假設 平台已啟動
    而且 心跳逾時設定為 90 秒
    而且 錯誤率門檻設定為 5%
    而且 狀態重算間隔設定為 15 秒
    而且 "gigaks-backend" 已登錄在 topology 中

  # ── 四種狀態 ────────────────────────────────────────────

  場景: 從未回報過的服務為 unknown
    假設 "gigaks-backend" 從未收到心跳也未探測成功過
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "unknown"

  場景: 心跳正常且錯誤率低為 healthy
    假設 "gigaks-backend" 在 10 秒前回報過心跳
    而且 近 5 分鐘有 100 筆請求、1 筆錯誤
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "healthy"

  場景: 心跳正常但錯誤率高為 degraded
    假設 "gigaks-backend" 在 10 秒前回報過心跳
    而且 近 5 分鐘有 100 筆請求、8 筆錯誤
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "degraded"

  場景: 超過 90 秒沒有任何存活訊號為 down
    假設 "gigaks-backend" 的最後存活訊號在 91 秒前
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "down"

  場景大綱: 錯誤率門檻的邊界
    假設 "gigaks-backend" 在 10 秒前回報過心跳
    而且 近 5 分鐘有 <總數> 筆請求、<錯誤數> 筆錯誤
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "<狀態>"

    例子:
      | 總數 | 錯誤數 | 狀態     | 說明               |
      | 100  | 4      | healthy  | 4% 未達門檻        |
      | 100  | 5      | degraded | 5% 剛好達到門檻    |
      | 100  | 6      | degraded | 6% 超過門檻        |
      | 100  | 0      | healthy  | 零錯誤             |
      | 0    | 0      | healthy  | 無流量不視為異常   |

  場景: down 的判定優先於錯誤率
    假設 "gigaks-backend" 的最後存活訊號在 120 秒前
    而且 近 5 分鐘有 100 筆請求、50 筆錯誤
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "down"

  # ── 狀態轉換 ────────────────────────────────────────────

  場景: 狀態改變時記錄轉換時間
    假設 "gigaks-backend" 的 status 為 "healthy"，since 為 "2026-09-18T06:00:00.000Z"
    當 該服務在 "2026-09-18T08:00:00.000Z" 被判定為 "down"
    那麼 "gigaks-backend" 的 status 應為 "down"
    而且 "gigaks-backend" 的 since 應為 "2026-09-18T08:00:00.000Z"

  場景: 狀態未改變時不更新 since
    假設 "gigaks-backend" 的 status 為 "healthy"，since 為 "2026-09-18T06:00:00.000Z"
    當 狀態重算後仍為 "healthy"
    那麼 "gigaks-backend" 的 since 應仍為 "2026-09-18T06:00:00.000Z"

  場景: 服務恢復後狀態自動轉回 healthy
    假設 "gigaks-backend" 的 status 為 "down"
    當 該服務重新回報心跳
    而且 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "healthy"

  # ── 計數與跨時段 ────────────────────────────────────────

  場景: 近 5 分鐘統計跨小時時合併相鄰計數
    假設 現在時間為 "2026-09-18T09:02:00.000Z"
    而且 "dvd:devops:stat:gigaks-backend:2026091808" 的 total 為 40、error 為 2
    而且 "dvd:devops:stat:gigaks-backend:2026091809" 的 total 為 60、error 為 4
    當 狀態重算執行
    那麼 錯誤率計算應涵蓋兩個時段的資料

  # ── 單一判定來源 ────────────────────────────────────────

  場景: 收到錯誤紀錄時立即重算該服務狀態
    假設 "gigaks-backend" 的 status 為 "healthy"
    而且 近 5 分鐘有 20 筆請求、0 筆錯誤
    當 該服務連續回報 5 筆 500 錯誤
    那麼 "gigaks-backend" 的狀態應立即被重算
    而且 不需等待下一次 15 秒的定期重算

  場景: 狀態只由狀態判定模組寫入
    當 任一模組需要變更服務狀態
    那麼 變更應一律經由狀態判定模組
    而且 service_status 不應被 Ingest 或探測模組直接寫入

  # ── 未登錄服務 ──────────────────────────────────────────

  場景: 有回報但未登錄在 topology 的服務被標示出來
    假設 "some-new-service" 不存在於 topology 中
    當 該 serviceId 回報一筆紀錄
    那麼 平台應記錄一則警告
    而且 "GET /api/v1/topology" 的 unregistered 應包含 "some-new-service"
    而且 前端應提示補上拓樸設定
