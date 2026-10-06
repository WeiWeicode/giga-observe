# language: zh-TW
@US-04 @D-01 @D-04 @D-05 @M1
功能: API 紀錄回報與儲存
  身為後端開發者
  我希望我的服務回報的 API 紀錄被正確分流與保存
  以便我能在平台上查到完整的請求、執行動作與回應內容

  背景:
    假設 平台已啟動且 MongoDB 與 Redis 連線正常
    而且 我持有 serviceId 為 "gigaks-backend" 的有效 ingest Key

  # ── 基本寫入 ────────────────────────────────────────────

  @critical
  場景: 單筆回報成功
    當 我回報一筆紀錄
      | ts                       | level | method | path               | status | durationMs |
      | 2026-09-18T08:00:00.000Z | info  | POST   | /api/v1/articles   | 200    | 134        |
    那麼 回應狀態碼應為 202
    而且 "api_logs" 應新增 1 筆紀錄
    而且 "error_logs" 不應新增紀錄

  @critical
  場景: 批次回報成功
    當 我一次回報 50 筆合法紀錄
    那麼 回應狀態碼應為 202
    而且 回應的 "accepted" 應為 50
    而且 "api_logs" 應新增 50 筆紀錄

  場景: 批次中的單筆格式錯誤只丟棄該筆
    當 我一次回報 10 筆紀錄，其中第 3 筆缺少 "response.status"
    那麼 回應狀態碼應為 202
    而且 回應的 "accepted" 應為 9
    而且 回應的 "rejected" 應為 1
    而且 回應的 errors 應指出問題出在索引 3

  場景: 批次超過上限時整批拒絕
    當 我一次回報 101 筆紀錄
    那麼 回應狀態碼應為 400
    而且 回應的錯誤代碼應為 "BATCH_TOO_LARGE"
    而且 不應有任何紀錄被寫入

  場景: 平台記錄收到時間以偵測時鐘偏移
    當 我回報一筆 ts 為 "2026-09-18T07:00:00.000Z" 的紀錄
    那麼 該筆紀錄的 ts 應為 "2026-09-18T07:00:00.000Z"
    而且 該筆紀錄應另外記錄 receivedAt 為平台當下時間

  # ── 錯誤分流（D-04）────────────────────────────────────

  @critical @D-04
  場景大綱: 依狀態碼與 level 分流到正確的 collection
    當 我回報一筆 status 為 <status>、level 為 "<level>" 的紀錄
    那麼 該筆紀錄應被寫入 "<collection>"

    例子:
      | status | level | collection  | 說明                         |
      | 200    | info  | api_logs    | 成功                         |
      | 201    | info  | api_logs    | 成功                         |
      | 304    | info  | api_logs    | 轉向                         |
      | 400    | warn  | api_logs    | 4xx 進一般區                 |
      | 401    | warn  | api_logs    | 4xx 進一般區                 |
      | 404    | warn  | api_logs    | 4xx 進一般區                 |
      | 500    | error | error_logs  | 5xx 永久保存                 |
      | 502    | error | error_logs  | 5xx 永久保存                 |
      | 503    | error | error_logs  | 5xx 永久保存                 |
      | 200    | error | error_logs  | HTTP 200 但服務自報 error    |

  @D-04
  場景: 一般紀錄設有 7 天後到期時間
    當 我回報一筆 ts 為 "2026-09-18T08:00:00.000Z" 的成功紀錄
    那麼 該筆紀錄的 expireAt 應為 "2026-09-25T08:00:00.000Z"

  @D-04 @critical
  場景: 錯誤紀錄不設到期時間
    當 我回報一筆 status 為 500 的紀錄
    那麼 該筆紀錄不應包含 expireAt 欄位

  # ── body 保存規則（D-05）───────────────────────────────

  @D-05
  場景: 成功請求只保存 body 摘要
    當 我回報一筆成功紀錄，其 request body 長度為 5000 位元組
    那麼 儲存的 request body 長度應為 1024 位元組
    而且 儲存的 bodySize 應為 5000
    而且 儲存的 bodyTruncated 應為 true

  @D-05
  場景: 成功請求的小 body 完整保留
    當 我回報一筆成功紀錄，其 request body 長度為 500 位元組
    那麼 儲存的 request body 長度應為 500 位元組
    而且 儲存的 bodyTruncated 應為 false

  @D-05 @critical
  場景: 錯誤請求保存完整 body
    當 我回報一筆 status 為 500 的紀錄，其 request body 長度為 20000 位元組
    那麼 儲存的 request body 長度應為 20000 位元組
    而且 儲存的 bodyTruncated 應為 false

  @D-05
  場景: 錯誤請求的超大 body 於 32KB 截斷
    當 我回報一筆 status 為 500 的紀錄，其 request body 長度為 50000 位元組
    那麼 儲存的 request body 長度應為 32768 位元組
    而且 儲存的 bodySize 應為 50000
    而且 儲存的 bodyTruncated 應為 true

  @D-05
  場景: 檔案上傳只記錄檔案資訊不記錄內容
    當 我回報一筆 content-type 為 "multipart/form-data" 的紀錄
    那麼 儲存的 request body 應只包含欄位名、檔名、大小與 MIME type
    而且 儲存的 request body 不應包含檔案二進位內容

  場景: 非 JSON 的二進位回應不保存 body
    當 我回報一筆 response content-type 為 "application/octet-stream" 的紀錄
    那麼 儲存的 response body 應為 null
    而且 儲存的 bodySize 仍應記錄原始大小

  # ── 敏感資料遮蔽 ────────────────────────────────────────

  @security @critical
  場景大綱: 敏感欄位一律遮蔽
    當 我回報一筆紀錄，其 request body 包含欄位 "<欄位>"
    那麼 儲存的該欄位值應為 "***"

    例子:
      | 欄位          |
      | password      |
      | passwd        |
      | token         |
      | authorization |
      | apiKey        |
      | api_key       |
      | secret        |
      | credential    |
      | PASSWORD      |
      | Api_Key       |

  @security
  場景: 巢狀物件中的敏感欄位也要遮蔽
    當 我回報一筆紀錄，其 request body 為 "{ user: { profile: { token: 'eyJhbG' } } }"
    那麼 儲存的 user.profile.token 應為 "***"

  @security
  場景: 陣列中的敏感欄位也要遮蔽
    當 我回報一筆紀錄，其 request body 包含 "accounts" 陣列，每個元素都有 password 欄位
    那麼 儲存的每個元素的 password 都應為 "***"

  @security
  場景: 平台端二次遮蔽未經 SDK 處理的回報
    假設 某服務未使用 SDK，直接以 curl 回報未遮蔽的紀錄
    當 該紀錄送達平台
    那麼 儲存的敏感欄位仍應為 "***"

  @security
  場景: Headers 只保留白名單
    當 我回報一筆紀錄，其 headers 包含 "authorization"、"cookie" 與 "content-type"
    那麼 儲存的 headers 應包含 "content-type"
    但是 儲存的 headers 不應包含 "authorization"
    而且 儲存的 headers 不應包含 "cookie"

  # ── 執行動作（actions）─────────────────────────────────

  @US-04
  場景: 保存後端執行動作的順序與耗時
    當 我回報一筆紀錄，包含下列執行動作
      | seq | type | target          | durationMs | note          | ok    |
      | 1   | db   | mssql.articles  | 12         | insert 1 row  | true  |
      | 2   | http | qdrant:6333     | 340        | rag sync      | false |
    那麼 該筆紀錄應保存 2 筆 actions
    而且 actions 應依 seq 由小到大排列
    而且 第 2 筆 action 的 ok 應為 false

  # ── 快取與非同步寫入 ────────────────────────────────────

  場景: 紀錄同時寫入 Redis 供快查
    當 我回報一筆成功紀錄
    那麼 Redis 的 "dvd:devops:log:gigaks-backend" 應新增 1 筆
    而且 該 key 的 TTL 應為 1 天

  場景: 錯誤紀錄寫入獨立的 Redis list
    當 我回報一筆 status 為 500 的紀錄
    那麼 Redis 的 "dvd:devops:err:gigaks-backend" 應新增 1 筆

  場景: Redis list 維持最多 1000 筆
    假設 "dvd:devops:log:gigaks-backend" 已有 1000 筆
    當 我再回報 1 筆成功紀錄
    那麼 該 list 長度應仍為 1000
    而且 最舊的 1 筆應已被移除

  場景: 每小時計數同步更新
    當 我在 "2026-09-18T08:30:00.000Z" 回報 1 筆成功與 1 筆 500 紀錄
    那麼 Redis 的 "dvd:devops:stat:gigaks-backend:2026091808" 的 total 應為 2
    而且 該 hash 的 error 應為 1

  @critical
  場景: MongoDB 暫時不可用時 Ingest 仍接受回報
    假設 MongoDB 連線中斷
    當 我回報一筆紀錄
    那麼 回應狀態碼應為 202
    而且 該筆紀錄應寫入 Redis
    而且 該筆紀錄應進入待補佇列
    當 MongoDB 恢復連線
    那麼 待補佇列中的紀錄應被寫入 MongoDB
    而且 待補佇列應清空

  # ── 速率限制 ────────────────────────────────────────────

  場景: 超過速率限制時丟棄但不要求重送
    假設 "gigaks-backend" 本分鐘已回報 600 次
    當 我再回報一次
    那麼 回應狀態碼應為 429
    而且 回應應包含 "Retry-After" header
    而且 該批次應被丟棄而非要求服務重送
