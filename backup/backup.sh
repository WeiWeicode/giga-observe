#!/bin/bash
# 每日備份（ARCHITECTURE §8）
#   - 備份整個 DB，但排除 api_logs 與 heartbeats（7 天暫存資料，不值得備份）
#     用 --excludeCollection 而非列舉 --collection，因為 mongodump 的 --collection
#     只吃最後一個值，列舉會靜默地只備份到最後那個 collection
#   - 保留最近 BACKUP_KEEP 份
#   - 結果回報為一筆 job 紀錄，失敗時在架構圖上看得到

BACKUP_DIR="${BACKUP_DIR:-/backup}"
BACKUP_KEEP="${BACKUP_KEEP:-30}"
BACKUP_HOUR="${BACKUP_CRON_HOUR:-3}"
REPORT_ENDPOINT="${BACKUP_REPORT_ENDPOINT:-http://gno-backend:51202}"
REPORT_KEY="${BACKUP_API_KEY:-}"

report() {
  local status=$1
  local message=$2
  local duration=$3
  [ -z "$REPORT_KEY" ] && return 0

  local level="info"
  local error_json="null"
  if [ "$status" -ge 500 ]; then
    level="error"
    error_json="{\"name\":\"BackupError\",\"message\":\"${message}\"}"
  fi

  curl -s -m 3 -X POST "${REPORT_ENDPOINT}/api/v1/ingest/logs" \
    -H "X-API-Key: ${REPORT_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"logs\":[{
          \"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",
          \"level\":\"${level}\",
          \"kind\":\"job\",
          \"request\":{\"method\":\"JOB\",\"path\":\"dailyBackup\",\"pathTemplate\":\"dailyBackup\",
                       \"body\":{\"trigger\":\"cron\",\"cronExpr\":\"0 ${BACKUP_HOUR} * * *\"}},
          \"response\":{\"status\":${status},\"body\":{\"message\":\"${message}\"},\"durationMs\":${duration}},
          \"error\":${error_json}
        }]}" > /dev/null 2>&1
}

heartbeat() {
  [ -z "$REPORT_KEY" ] && return 0
  curl -s -m 3 -X POST "${REPORT_ENDPOINT}/api/v1/heartbeat" \
    -H "X-API-Key: ${REPORT_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"version":"1.0.0"}' > /dev/null 2>&1
}

run_backup() {
  local start=$(date +%s%3N)
  local stamp=$(date +%Y%m%d)
  local target="${BACKUP_DIR}/gno-${OBSERVE_ENV:-dev}-${stamp}.gz"

  echo "[backup] 開始備份 → ${target}"

  if mongodump --uri "${MONGO_URI}" \
      --excludeCollection=api_logs \
      --excludeCollection=heartbeats \
      --gzip --archive="${target}" 2>&1; then
    # 保留最近 N 份
    ls -1t "${BACKUP_DIR}"/gno-${OBSERVE_ENV:-dev}-*.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f
    local size=$(du -h "${target}" | cut -f1)
    local duration=$(( $(date +%s%3N) - start ))
    echo "[backup] 完成，大小 ${size}，耗時 ${duration}ms"
    report 200 "備份完成 ${size}" "${duration}"
  else
    local duration=$(( $(date +%s%3N) - start ))
    echo "[backup] 失敗"
    report 500 "mongodump 執行失敗" "${duration}"
  fi
}

echo "[backup] 排程啟動，每日 ${BACKUP_HOUR}:00 執行，保留 ${BACKUP_KEEP} 份"
[ -z "$REPORT_KEY" ] && echo "[backup] 未設定 BACKUP_API_KEY，不回報狀態"

# 立即送一次心跳，讓節點在架構圖上先亮起來
heartbeat

# 手動觸發：docker compose exec gno-backup /app/backup.sh once
if [ "$1" = "once" ]; then
  run_backup
  exit 0
fi

while true; do
  now_hour=$(date +%-H)
  now_min=$(date +%-M)

  if [ "$now_hour" -eq "$BACKUP_HOUR" ] && [ "$now_min" -eq 0 ]; then
    run_backup
    sleep 3600
  else
    heartbeat
    sleep 60
  fi
done
