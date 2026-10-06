/**
 * 索引建立（DB_SCHEMA §7）
 * createIndex 具冪等性，開機時執行或手動執行皆可
 */
const mongo = require('../config/mongo');

const INDEXES = [
  ['services',       { projectId: 1, type: 1 },  {}],
  ['services',       { projectId: 1, layer: 1 }, {}],
  ['topology',       { projectId: 1, from: 1, to: 1 }, { unique: true }],

  ['api_logs',       { projectId: 1, serviceId: 1, ts: -1 }, {}],
  ['api_logs',       { projectId: 1, ts: -1 }, {}],
  ['api_logs',       { projectId: 1, serviceId: 1, 'response.status': 1, ts: -1 }, {}],
  ['api_logs',       { expireAt: 1 }, { expireAfterSeconds: 0 }],

  ['error_logs',     { projectId: 1, serviceId: 1, ts: -1 }, {}],
  ['error_logs',     { projectId: 1, ts: -1 }, {}],
  ['error_logs',     {
    projectId: 1, serviceId: 1, 'request.method': 1,
    'request.pathTemplate': 1, 'response.status': 1, ts: -1,
  }, {}],

  ['heartbeats',     { projectId: 1, serviceId: 1, ts: -1 }, {}],
  ['heartbeats',     { expireAt: 1 }, { expireAfterSeconds: 0 }],

  ['api_logs',       { projectId: 1, serviceId: 1, 'meta.upstream': 1, ts: -1 }, { sparse: true }],
  ['api_logs',       { projectId: 1, traceId: 1 }, { sparse: true }],
  ['error_logs',     { projectId: 1, traceId: 1 }, { sparse: true }],
  ['error_logs',     { projectId: 1, kind: 1, ts: -1 }, {}],

  // GigaNexus 擴充：Nginx 流量彙總、前端效能（TTL 90 天）
  ['traffic_minutely', { projectId: 1, ts: -1 }, {}],
  ['traffic_minutely', { expireAt: 1 }, { expireAfterSeconds: 0 }],
  ['web_vitals',     { projectId: 1, serviceId: 1, name: 1, ts: -1 }, {}],
  ['web_vitals',     { expireAt: 1 }, { expireAfterSeconds: 0 }],

  ['service_status', { projectId: 1, status: 1 }, {}],

  ['api_keys',       { keyHash: 1 }, { unique: true }],
  ['api_keys',       { projectId: 1, serviceId: 1 }, {}],
];

async function initIndexes() {
  let created = 0;
  for (const [collection, spec, options] of INDEXES) {
    try {
      await mongo.col(collection).createIndex(spec, options);
      created += 1;
    } catch (err) {
      console.warn(`[index] ${collection} 建立索引失敗：`, err.message);
    }
  }
  console.log(`[index] 已確保 ${created}/${INDEXES.length} 個索引`);
  return created;
}

if (require.main === module) {
  (async () => {
    await mongo.connect();
    await initIndexes();
    await mongo.close();
    process.exit(0);
  })();
}

module.exports = { initIndexes, INDEXES };
