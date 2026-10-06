# language: zh-TW
@US-01 @M1
功能: 心跳回報與存活探測
  身為維運人員
  我希望平台以 Push 與 Pull 兩種方式確認服務存活
  以便服務整個掛掉、連回報都發不出來時也能被發現

  背景:
    假設 平台已啟動且 MongoDB 與 Redis 連線正常
    而且 心跳逾時設定為 90 秒
    而且 Pull 探測間隔設定為 30 秒
    而且 我持有 serviceId 為 "gigaks-backend" 的有效 ingest Key

  # ── Push 心跳 ──────────────────────────────────────────

  @critical
  場景: 回報心跳後更新最後存活時間
    當 我在 "2026-09-18T08:00:00.000Z" 回報心跳
    那麼 回應狀態碼應為 200
    而且 Redis 的 "dvd:devops:hb:gigaks-backend" 應為該時間戳
    而且 該 key 的 TTL 應為 120 秒
    而且 "gigaks-backend" 的 lastHeartbeatAt 應為該時間

  場景: 空 body 的心跳也視為有效
    當 我以空 body "{}" 回報心跳
    那麼 回應狀態碼應為 200
    而且 "gigaks-backend" 的 lastHeartbeatAt 應被更新

  場景: 心跳保存版本與運行時間
    當 我回報心跳，version 為 "1.2.0"，uptimeSec 為 86400
    那麼 "gigaks-backend" 的 version 應為 "1.2.0"
    而且 "gigaks-backend" 的 uptimeSec 應為 86400

  場景: 服務偷偷重啟可從 uptime 歸零看出
    假設 "gigaks-backend" 上一次心跳的 uptimeSec 為 86400
    當 我回報心跳，uptimeSec 為 12
    那麼 "gigaks-backend" 的 uptimeSec 應為 12
    而且 heartbeats 中應保留兩筆紀錄供比對

  場景: 心跳事件流保留 7 天
    當 我在 "2026-09-18T08:00:00.000Z" 回報心跳
    那麼 "heartbeats" 應新增 1 筆，source 為 "push"
    而且 該筆的 expireAt 應為 "2026-09-25T08:00:00.000Z"

  # ── 依賴狀態 ────────────────────────────────────────────

  場景: 依賴異常不影響服務本身的健康狀態
    當 我回報心跳，deps 為
      | name   | ok    | latencyMs |
      | mssql  | true  | 8         |
      | mongo  | true  | 3         |
      | qdrant | false |           |
    那麼 "gigaks-backend" 的 status 應為 "healthy"
    而且 "gigaks-backend" 的 deps 應標示 qdrant 為異常
    而且 服務詳情面板應顯示依賴異常提示

  # ── Pull 探測 ──────────────────────────────────────────

  @critical
  場景: 平台主動探測服務的健康端點
    假設 "gigaks-backend" 在 topology 中設定 healthUrl 為 "http://10.10.130.122:5155/health"
    而且 該端點回應 HTTP 200
    當 Pull 探測執行
    那麼 "heartbeats" 應新增 1 筆，source 為 "probe"，ok 為 true
    而且 Redis 的 "dvd:devops:probe:gigaks-backend" 應被更新

  場景: 健康端點回非 2xx 時視為探測失敗
    假設 "gigaks-backend" 的健康端點回應 HTTP 503
    當 Pull 探測執行
    那麼 該筆探測紀錄的 ok 應為 false
    而且 "dvd:devops:probe:gigaks-backend" 不應被更新

  場景: 健康端點逾時視為探測失敗
    假設 "gigaks-backend" 的健康端點在 5 秒內無回應
    當 Pull 探測執行
    那麼 該筆探測紀錄的 ok 應為 false

  場景: 探測只要求 2xx，不檢查回應內容
    假設 "bpm-backend" 的健康端點回應 HTTP 200 且 body 為純文字 "OK"
    當 Pull 探測執行
    那麼 該筆探測紀錄的 ok 應為 true

  場景: 未啟用探測的服務不被探測
    假設 "notesapp-frontend" 在 topology 中設定 monitor.enabled 為 false
    當 Pull 探測執行
    那麼 不應對 "notesapp-frontend" 發出任何探測請求
    而且 "notesapp-frontend" 的存活判定應只依據 Push 心跳

  # ── 雙軌判定 ────────────────────────────────────────────

  @critical
  場景: Push 與 Pull 任一成功即視為存活
    假設 "gigaks-backend" 的 Push 心跳已停止 120 秒
    但是 Pull 探測在 10 秒前成功
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 不應為 "down"

  @critical
  場景: 兩者皆失敗超過 90 秒才判定為 down
    假設 "gigaks-backend" 的最後 Push 心跳在 100 秒前
    而且 最後成功的 Pull 探測在 100 秒前
    當 狀態重算執行
    那麼 "gigaks-backend" 的 status 應為 "down"

  場景: 存活時間取兩者較新者
    假設 "gigaks-backend" 的最後 Push 心跳在 100 秒前
    而且 最後成功的 Pull 探測在 20 秒前
    當 狀態重算執行
    那麼 存活判定應以 20 秒前為準
    而且 "gigaks-backend" 的 status 不應為 "down"

  # ── 速率限制 ────────────────────────────────────────────

  場景: 心跳過於頻繁時限流
    假設 "gigaks-backend" 本分鐘已回報 10 次心跳
    當 我再回報一次心跳
    那麼 回應狀態碼應為 429
    但是 既有的存活判定不應受影響
