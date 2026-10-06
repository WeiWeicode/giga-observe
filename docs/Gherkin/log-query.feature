# language: zh-TW
@US-03 @US-04 @M1 @M3
功能: 紀錄查詢與明細
  身為維運人員與後端開發者
  我希望能跨服務搜尋 API 紀錄並看到單筆的完整內容
  以便我能重現問題

  背景:
    假設 平台已啟動
    而且 我持有有效的 read Key
    而且 已存在下列紀錄
      | serviceId      | ts                       | method | path                 | status | durationMs |
      | gigaks-backend | 2026-09-18T08:00:00.000Z | POST   | /api/v1/articles     | 200    | 134        |
      | gigaks-backend | 2026-09-18T08:01:00.000Z | GET    | /api/v1/articles/123 | 500    | 1340       |
      | gigaks-backend | 2026-09-18T08:02:00.000Z | GET    | /api/v1/tags         | 404    | 12         |
      | bpm-backend    | 2026-09-18T08:03:00.000Z | POST   | /api/flow/submit     | 200    | 890        |
      | bpm-backend    | 2026-09-18T08:04:00.000Z | POST   | /api/flow/submit     | 500    | 3200       |

  # ── 基本查詢 ────────────────────────────────────────────

  @critical
  場景: 預設查詢近 1 小時的紀錄
    當 我呼叫 "GET /api/v1/logs" 不帶任何參數
    那麼 回應狀態碼應為 200
    而且 應回傳近 1 小時內的紀錄
    而且 紀錄應依時間由新到舊排列

  場景: 依服務篩選
    當 我查詢 serviceId 為 "bpm-backend" 的紀錄
    那麼 應回傳 2 筆
    而且 每筆的 serviceId 都應為 "bpm-backend"

  場景: 依多個服務篩選
    當 我查詢 serviceId 為 "gigaks-backend,bpm-backend" 的紀錄
    那麼 應回傳 5 筆

  場景: 依時間區間篩選
    當 我查詢 from 為 "2026-09-18T08:01:00.000Z"、to 為 "2026-09-18T08:03:00.000Z" 的紀錄
    那麼 應回傳 3 筆

  場景大綱: 依狀態碼篩選
    當 我查詢 status 為 "<條件>" 的紀錄
    那麼 應回傳 <筆數> 筆

    例子:
      | 條件 | 筆數 | 說明           |
      | 200  | 2    | 精確比對       |
      | 500  | 2    | 精確比對       |
      | 5xx  | 2    | 範圍比對       |
      | 4xx  | 1    | 範圍比對       |

  場景: 依路徑子字串篩選
    當 我查詢 path 包含 "articles" 的紀錄
    那麼 應回傳 2 筆

  場景: 依 level 篩選
    當 我查詢 level 為 "error" 的紀錄
    那麼 應回傳 2 筆

  場景: 關鍵字搜尋 body 內容
    假設 某筆紀錄的 request body 包含 "太陽能板規格"
    當 我以關鍵字 "太陽能板規格" 查詢
    那麼 該筆紀錄應出現在結果中

  場景: 查無結果時回傳空陣列而非錯誤
    當 我查詢 serviceId 為 "not-exist" 的紀錄
    那麼 回應狀態碼應為 200
    而且 回應的 data 應為空陣列

  # ── 分頁 ────────────────────────────────────────────────

  場景: 預設每頁 100 筆
    假設 符合條件的紀錄有 250 筆
    當 我查詢不指定 limit
    那麼 應回傳 100 筆
    而且 回應的 hasMore 應為 true
    而且 回應應包含 nextCursor

  場景: 以 cursor 取得下一頁
    假設 我已取得第一頁與其 nextCursor
    當 我以該 cursor 查詢下一頁
    那麼 應回傳接續的紀錄
    而且 不應與第一頁重複

  場景: limit 超過上限時取上限
    當 我查詢 limit 為 1000
    那麼 最多應回傳 500 筆

  場景: 最後一頁的 hasMore 為 false
    假設 符合條件的紀錄有 50 筆
    當 我查詢 limit 為 100
    那麼 應回傳 50 筆
    而且 回應的 hasMore 應為 false

  # ── 查詢來源策略 ────────────────────────────────────────

  場景: 近 24 小時的簡單查詢走 Redis
    當 我查詢近 1 小時、不帶關鍵字的紀錄
    那麼 回應 header "X-Data-Source" 應為 "redis"

  場景: 帶關鍵字的查詢走 MongoDB
    當 我查詢近 1 小時、帶關鍵字 "太陽能" 的紀錄
    那麼 回應 header "X-Data-Source" 應為 "mongo"

  場景: 超過 24 小時的查詢走 MongoDB
    當 我查詢 3 天前的紀錄
    那麼 回應 header "X-Data-Source" 應為 "mongo"

  場景: Redis 不可用時自動回落 MongoDB
    假設 Redis 連線中斷
    當 我查詢近 1 小時的紀錄
    那麼 回應狀態碼應為 200
    而且 回應 header "X-Data-Source" 應為 "mongo"

  # ── 明細（US-04）────────────────────────────────────────

  @US-04 @critical
  場景: 查看單筆紀錄的完整內容
    當 我呼叫 "GET /api/v1/logs/:id" 查詢某筆 500 紀錄
    那麼 回應應包含時間、服務、method、path、status 與耗時
    而且 回應應包含完整的 request query 與 body
    而且 回應應包含 actions 清單
    而且 回應應包含 response body
    而且 回應應包含 error 的 name、message 與 stack

  @US-04 @security
  場景: 明細中的敏感欄位已遮蔽
    假設 某筆紀錄的 request body 原本包含 password
    當 我查看該筆明細
    那麼 password 欄位值應為 "***"

  @US-04
  場景: 被截斷的 body 標示原始大小
    假設 某筆錯誤紀錄的 request body 原始大小為 50000 位元組
    當 我查看該筆明細
    那麼 bodyTruncated 應為 true
    而且 bodySize 應顯示 50000

  @US-04
  場景: 執行動作依序顯示並標示失敗步驟
    假設 某筆紀錄有 3 個 actions，其中第 2 個 ok 為 false
    當 我查看該筆明細
    那麼 actions 應依 seq 由小到大顯示
    而且 第 2 個 action 應被標示為失敗
    而且 每個 action 應顯示 type、target 與耗時

  場景: 查詢不存在的紀錄
    當 我查詢一個不存在的紀錄 id
    那麼 回應狀態碼應為 404
    而且 回應的錯誤代碼應為 "NOT_FOUND"

  場景: 已過期的一般紀錄查不到
    假設 某筆一般紀錄的 ts 為 8 天前
    當 我查詢該筆紀錄
    那麼 回應狀態碼應為 404

  # ── 總覽統計 ────────────────────────────────────────────

  場景: 總覽顯示服務健康分布與流量統計
    當 我呼叫 "GET /api/v1/stats/overview"
    那麼 回應應包含各狀態的服務數量
    而且 回應應包含近 1 小時與近 24 小時的請求數、錯誤數與錯誤率
    而且 回應應包含錯誤最多的 API 清單
    而且 回應應包含最慢的 API 清單
