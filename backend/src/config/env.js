/**
 * 環境變數讀取與驗證
 * 缺少必要變數時直接讓服務啟動失敗，不要等到跑一半才炸
 */
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[env] 缺少必要環境變數：${name}`);
    process.exit(1);
  }
  return value;
}

function int(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function float(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function list(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// 部署區（MONITORING-PLAN D2）：測試區與正式區各一套 giga-observe，資料庫、Redis 前綴預設都帶部署區，不可共用
const observeEnv = (process.env.OBSERVE_ENV || 'dev').toLowerCase();
if (!['dev', 'test', 'prod'].includes(observeEnv)) {
  console.error(`[env] OBSERVE_ENV 必須是 dev / test / prod：${observeEnv}`);
  process.exit(1);
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  observeEnv,
  // Gateway 平台保留區段（BACKEND-GUIDE §3.2）：observe-api 51202
  port: int('PORT', 51202),
  ssePort: int('SSE_PORT', 51203),

  // 共用儲存的隔離維度（PRD D-03）
  projectId: process.env.PROJECT_ID || 'giganexus',

  mongoUri: required('MONGO_URI'),
  mongoDb: process.env.MONGO_DB || `giga_observe_${observeEnv}`,

  redisHost: process.env.REDIS_HOST || 'gno-redis',
  redisPort: int('REDIS_PORT', 6379),
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  redisPrefix: process.env.REDIS_PREFIX || `gno-${observeEnv}`,

  heartbeatTimeoutSec: int('HEARTBEAT_TIMEOUT_SEC', 90),
  probeIntervalSec: int('PROBE_INTERVAL_SEC', 30),
  probeTimeoutMs: int('PROBE_TIMEOUT_MS', 5000),
  statusEvalIntervalSec: int('STATUS_EVAL_INTERVAL_SEC', 15),
  errorRateThreshold: float('ERROR_RATE_THRESHOLD', 0.05),

  logTtlDays: int('LOG_TTL_DAYS', 7),
  // 錯誤紀錄永久保存，但完整 body 只留 N 天，之後裁成摘要（MONITORING-PLAN D13）
  errorBodyDays: int('ERROR_BODY_DAYS', 90),
  // Nginx 流量彙總、前端效能資料保留天數（D9）
  trafficTtlDays: int('TRAFFIC_TTL_DAYS', 90),
  bodySummaryBytes: int('BODY_SUMMARY_BYTES', 1024),
  bodyMaxBytes: int('BODY_MAX_BYTES', 32768),

  ingestBatchMax: int('INGEST_BATCH_MAX', 100),
  redisListMax: int('REDIS_LIST_MAX', 1000),
  sseMaxConnections: int('SSE_MAX_CONNECTIONS', 20),
  sseSnapshotIntervalSec: int('SSE_SNAPSHOT_INTERVAL_SEC', 30),

  // 查詢端點的 IP 白名單；留空 = 不限制（開發環境）
  allowedQueryIps: list('ALLOWED_QUERY_IPS', []),

  // 是否信任 X-Forwarded-For。預設 false：5132/5133 直接對外，
  // 前面沒有反向代理，信任這個 header 等於讓任何人偽造來源 IP 繞過白名單。
  // 只有在真的加了反向代理時才設為 true。
  trustProxy: (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true',

  // CORS 允許的來源；留空 = 全開（開發環境）
  corsOrigins: list('CORS_ORIGINS', []),

  rateLimitIngestPerMin: int('RATE_LIMIT_INGEST_PER_MIN', 600),
  rateLimitHeartbeatPerMin: int('RATE_LIMIT_HEARTBEAT_PER_MIN', 10),
  rateLimitQueryPerMin: int('RATE_LIMIT_QUERY_PER_MIN', 300),

  // 經 Gateway BFF 轉入的查詢（GigaItApp 架構觀測頁）：驗證 X-Internal-Token（ES256、iss giganexus-bff、aud = 服務代碼）
  // 權限由 BFF 依路由表檢查（observe.data.read / observe.log.body）；留空則只接受 API Key
  gwJwksUrl: process.env.GW_JWKS_URL || '',
  gwServiceCode: process.env.GW_SERVICE_CODE || 'observe-api',

  // 告警門檻（GET /alerts）
  alertSecurityPerMin: int('ALERT_SECURITY_PER_MIN', 30),
  alertIpPerMin: int('ALERT_IP_PER_MIN', 600),
  alertWebErrorsPer15m: int('ALERT_WEB_ERRORS_PER_15M', 20),
};

module.exports = env;
