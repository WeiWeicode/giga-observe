/**
 * giga-observe Backend 入口（由 DevOpsDiagram 複製改造，MONITORING-PLAN）
 *   :51202  Ingest + Query + Admin API（Query 亦接受 Gateway BFF 轉入的 X-Internal-Token）
 *   :51203  SSE（只供內網；GigaItApp 經 BFF 改以輪詢）
 */
const express = require('express');
const cors = require('cors');

const env = require('./config/env');
const mongo = require('./config/mongo');
const redis = require('./config/redis');

const { apiKeyAuth, requireScope, ipAllowlist, gatewayOrApiKey } = require('./middlewares/apiKeyAuth');
const { rateLimit } = require('./middlewares/rateLimit');

const ingestRoutes = require('./routes/ingest');
const heartbeatRoutes = require('./routes/heartbeat');
const queryRoutes = require('./routes/query');
const adminRoutes = require('./routes/admin');
const streamRoutes = require('./routes/stream');
const webRoutes = require('./routes/web');

const topologyService = require('./services/topologyService');
const statusService = require('./services/statusService');
const proberService = require('./services/proberService');
const ingestService = require('./services/ingestService');
const sseHub = require('./services/sseHub');
const retentionService = require('./services/retentionService');

const { ok } = require('./utils/response');
const { initIndexes } = require('./scripts/initIndexes');

const API = '/api/v1';
const startedAt = Date.now();

// CORS 設定：留空則全開（開發環境）
const corsOptions = env.corsOrigins.length
  ? { origin: env.corsOrigins }
  : {};

// ── API server（5132）────────────────────────────────────
const app = express();
// 預設不信任 X-Forwarded-For —— 前面沒有反向代理時，信任它等於
// 讓任何人送一個假的來源 IP 就繞過 ipAllowlist（env.js 有說明）
app.set('trust proxy', env.trustProxy);
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// 平台自身健康 —— 免認證
app.get('/health', async (req, res) => {
  const [mongoPing, redisPing] = await Promise.all([mongo.ping(), redis.ping()]);
  const pending = await ingestService.pendingCount();
  const degraded = !mongoPing.ok || !redisPing.ok;

  // Mongo/Redis 不通時仍回 200，避免探測工具直接把容器判死重啟
  return ok(res, {
    status: degraded ? 'degraded' : 'ok',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    version: require('../package.json').version,
    deps: { mongo: mongoPing, redis: redisPing },
    queue: { pendingMongoWrites: pending, sseConnections: sseHub.count() },
  });
});

// 給 Gateway 匯入的 OpenAPI（BACKEND-GUIDE §6.1）—— 免認證，只描述查詢 API
const { buildOpenApi } = require('./gatewayOpenapi');
app.get('/openapi.json', (req, res) => res.json(buildOpenApi({ serviceCode: env.gwServiceCode })));

// 前端事件：只收 BFF 轉送（scope ingest-web），需在 /ingest 之前掛載
app.use(`${API}/ingest/web-events`,
  apiKeyAuth(), requireScope('ingest-web'),
  rateLimit('ingest-web', env.rateLimitIngestPerMin),
  webRoutes);

// Ingest：需 ingest 權限，不受 IP 白名單限制
app.use(`${API}/ingest`,
  apiKeyAuth(), requireScope('ingest'),
  rateLimit('ingest', env.rateLimitIngestPerMin),
  ingestRoutes);

app.use(`${API}/heartbeat`,
  apiKeyAuth(), requireScope('ingest'),
  rateLimit('heartbeat', env.rateLimitHeartbeatPerMin),
  heartbeatRoutes);

// Admin：需 admin 權限
app.use(`${API}/admin`,
  apiKeyAuth(), requireScope('admin'), ipAllowlist,
  adminRoutes);

// Query：需 read 權限 + IP 白名單；GigaItApp 經 BFF 轉入時以 X-Internal-Token 取代 API Key
app.use(API,
  gatewayOrApiKey(), requireScope('read'), ipAllowlist,
  rateLimit('query', env.rateLimitQueryPerMin),
  queryRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'API 端點不存在' },
  });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: '請求內容過大' },
    });
  }
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: err.message || '伺服器內部錯誤' },
  });
});

// ── SSE server（5133）───────────────────────────────────
const sseApp = express();
sseApp.set('trust proxy', env.trustProxy);
sseApp.use(cors(corsOptions));
sseApp.use(API,
  apiKeyAuth({ allowQuery: true }), requireScope('read'), ipAllowlist,
  streamRoutes);

// ── 啟動 ────────────────────────────────────────────────
async function start() {
  console.log('='.repeat(56));
  console.log(`🔭  giga-observe - Backend（${env.observeEnv}）`);
  console.log('='.repeat(56));

  // Mongo 容器可能比後端晚就緒，重試幾次再放行
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await mongo.connect();
      await initIndexes();
      break;
    } catch (err) {
      console.warn(`[startup] MongoDB 連線失敗（第 ${attempt} 次）：${err.message}`);
      if (attempt === 6) {
        console.error('[startup] 服務仍會啟動，Ingest 將先寫入 Redis 待補');
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // 之後若中途斷線，由背景重連負責補上並重建索引
  mongo.startReconnectLoop(async () => {
    await initIndexes();
    await topologyService.load();
  });

  redis.connect();
  // 等 Redis ready 事件，最多 3 秒
  await new Promise((resolve) => {
    if (redis.isConnected()) return resolve();
    const timer = setTimeout(resolve, 3000);
    redis.getClient().once('ready', () => { clearTimeout(timer); resolve(); });
  });

  await topologyService.load();

  sseHub.setSnapshotProvider(() => statusService.buildSnapshot());
  sseHub.startSnapshotLoop();
  statusService.startEvalLoop();
  proberService.start();
  retentionService.start();

  // 定期消化待補佇列
  setInterval(() => {
    ingestService.flushPending().then((n) => {
      if (n > 0) console.log(`[ingest] 已補寫 ${n} 筆待補紀錄`);
    }).catch(() => {});
  }, 30000);

  await statusService.evaluateAll();

  app.listen(env.port, () => {
    console.log(`[api] 已啟動於 http://0.0.0.0:${env.port}`);
  });
  sseApp.listen(env.ssePort, () => {
    console.log(`[sse] 已啟動於 http://0.0.0.0:${env.ssePort}`);
  });

  console.log(`[env] 部署區=${env.observeEnv} db=${env.mongoDb} projectId=${env.projectId} 心跳逾時=${env.heartbeatTimeoutSec}s ` +
    `探測間隔=${env.probeIntervalSec}s 查詢白名單=${env.allowedQueryIps.join(',') || '(不限)'}`);
}

async function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，正在關閉…`);
  statusService.stop();
  proberService.stop();
  retentionService.stop();
  sseHub.stop();
  await mongo.close().catch(() => {});
  await redis.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((err) => {
    console.error('[startup] 啟動失敗：', err);
    process.exit(1);
  });
}

module.exports = { app, sseApp, start };
