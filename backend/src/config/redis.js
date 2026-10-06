/**
 * Redis 連線單例與 key 組裝
 * key 格式一律 {REDIS_PREFIX}:{projectId}:...（AGENT.md §9.8；預設前綴 gno-{部署區}）
 */
const Redis = require('ioredis');
const env = require('./env');

let client = null;
let connected = false;

function connect() {
  client = new Redis({
    host: env.redisHost,
    port: env.redisPort,
    password: env.redisPassword,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });

  client.on('ready', () => {
    connected = true;
    console.log('[redis] 已連線');
  });
  client.on('error', (err) => {
    connected = false;
    console.warn('[redis] 連線錯誤：', err.message);
  });
  client.on('end', () => { connected = false; });

  return client;
}

function getClient() {
  if (!client) throw new Error('Redis 尚未連線');
  return client;
}

function isConnected() {
  return connected;
}

// ── key 組裝 ────────────────────────────────────────────
const P = env.redisPrefix;
const PROJ = env.projectId;

const keys = {
  log:      (serviceId) => `${P}:${PROJ}:log:${serviceId}`,
  err:      (serviceId) => `${P}:${PROJ}:err:${serviceId}`,
  hb:       (serviceId) => `${P}:${PROJ}:hb:${serviceId}`,
  probe:    (serviceId) => `${P}:${PROJ}:probe:${serviceId}`,
  stat:     (serviceId, hourKey) => `${P}:${PROJ}:stat:${serviceId}:${hourKey}`,
  statusAll: () => `${P}:${PROJ}:status:all`,
  pending:  () => `${P}:${PROJ}:pending`,
  rate:     (scope, id, minuteKey) => `${P}:${PROJ}:rate:${scope}:${id}:${minuteKey}`,
  // apiKey 快取不帶 projectId —— 驗證時還不知道是哪個專案，雜湊本身全域唯一
  apiKey:   (hash) => `${P}:key:${hash}`,
};

async function ping() {
  const start = Date.now();
  try {
    await getClient().ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: null, error: err.message };
  }
}

async function close() {
  if (client) await client.quit().catch(() => {});
  connected = false;
}

module.exports = { connect, getClient, isConnected, keys, ping, close };
