# language: zh-TW
@US-06 @D-03 @security @M1
功能: API Key 驗證與權限控管
  身為平台維護者
  我希望每個服務用自己的 API Key 回報且只能做被允許的事
  以便多個服務共用同一套 Mongo / Redis 時不會互相污染

  背景:
    假設 平台已啟動且 MongoDB 與 Redis 連線正常
    而且 已建立下列 API Key
      | key                                  | projectId | serviceId      | scopes   | enabled |
      | dvd_devops_gigaks-backend_aaa111     | devops    | gigaks-backend | ingest   | true    |
      | dvd_devops_bpm-backend_bbb222        | devops    | bpm-backend    | ingest   | true    |
      | dvd_devops_ui_ccc333                 | devops    |                | read     | true    |
      | dvd_devops_admin_ddd444              | devops    |                | admin    | true    |
      | dvd_devops_old-service_eee555        | devops    | old-service    | ingest   | false   |

  @critical
  場景: 有效的 ingest Key 可以寫入紀錄
    當 我以 Key "dvd_devops_gigaks-backend_aaa111" 呼叫 "POST /api/v1/ingest/logs"
    那麼 回應狀態碼應為 202
    而且 回應的 "success" 應為 true

  場景: 未帶 API Key 一律拒絕
    當 我不帶 "X-API-Key" 呼叫 "POST /api/v1/ingest/logs"
    那麼 回應狀態碼應為 401
    而且 回應的錯誤代碼應為 "MISSING_API_KEY"
    而且 該筆紀錄不應被寫入任何 collection

  場景: 不存在的 Key 一律拒絕
    當 我以 Key "dvd_devops_fake_zzz999" 呼叫 "POST /api/v1/ingest/logs"
    那麼 回應狀態碼應為 401
    而且 回應的錯誤代碼應為 "INVALID_API_KEY"

  場景: 已停用的 Key 一律拒絕
    當 我以 Key "dvd_devops_old-service_eee555" 呼叫 "POST /api/v1/ingest/logs"
    那麼 回應狀態碼應為 401
    而且 回應的錯誤代碼應為 "INVALID_API_KEY"

  @critical @security
  場景: serviceId 由 Key 決定，不採信 client 自報
    當 我以 Key "dvd_devops_gigaks-backend_aaa111" 回報一筆紀錄，且 body 中宣稱 serviceId 為 "bpm-backend"
    那麼 回應狀態碼應為 202
    而且 該筆紀錄的 serviceId 應為 "gigaks-backend"
    而且 "bpm-backend" 的紀錄數不應增加

  @security
  場景大綱: 權限不足時拒絕存取
    當 我以 Key "<key>" 呼叫 "<端點>"
    那麼 回應狀態碼應為 403
    而且 回應的錯誤代碼應為 "INSUFFICIENT_SCOPE"

    例子:
      | key                              | 端點                        | 說明                     |
      | dvd_devops_gigaks-backend_aaa111 | GET /api/v1/logs            | ingest Key 不能讀取      |
      | dvd_devops_gigaks-backend_aaa111 | GET /api/v1/services        | ingest Key 不能讀取      |
      | dvd_devops_ui_ccc333             | POST /api/v1/ingest/logs    | read Key 不能寫入        |
      | dvd_devops_ui_ccc333             | POST /api/v1/admin/keys     | read Key 不能管理        |
      | dvd_devops_gigaks-backend_aaa111 | POST /api/v1/admin/keys     | ingest Key 不能管理      |

  @security
  場景: 明文 Key 不落地
    當 管理者以 admin Key 建立一組新的 API Key
    那麼 回應應包含明文 Key
    而且 回應應包含警告訊息說明只顯示一次
    但是 資料庫中儲存的應為 SHA-256 雜湊
    而且 資料庫中不應存在該明文 Key

  @security @critical
  場景: 停用 Key 後立即失效，不受快取影響
    假設 Key "dvd_devops_bpm-backend_bbb222" 已被使用過且已進入 Redis 快取
    當 管理者將該 Key 設為停用
    那麼 Redis 中該 Key 的快取應已被刪除
    而且 立即以該 Key 呼叫 "POST /api/v1/ingest/logs" 應回應 401

  場景: 管理端點不回傳既有 Key 的明文或雜湊
    當 我以 admin Key 呼叫 "GET /api/v1/admin/keys"
    那麼 回應應包含每組 Key 的 "keyPrefix"
    但是 回應不應包含 "key" 明文欄位
    而且 回應不應包含 "keyHash" 欄位

  @D-03
  場景: 每筆紀錄都帶有 projectId
    當 我以 Key "dvd_devops_gigaks-backend_aaa111" 回報一筆紀錄
    那麼 該筆紀錄的 projectId 應為 "devops"
    而且 對應的 Redis key 應以 "dvd:devops:" 開頭

  @D-03
  場景: v1 不提供通用資料存取端點
    當 我以任何 Key 呼叫通用資料寫入端點 "POST /api/v1/data"
    那麼 回應狀態碼應為 404

  場景: Key 使用後更新最後使用時間
    假設 Key "dvd_devops_gigaks-backend_aaa111" 的 lastUsedAt 為空
    當 我以該 Key 成功呼叫任一端點
    那麼 該 Key 的 lastUsedAt 應被更新為近期時間
