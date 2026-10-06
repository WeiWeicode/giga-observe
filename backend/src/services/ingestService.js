/**
 * 紀錄寫入：驗證 → 遮蔽截斷 → 寫 Redis → 寫 Mongo
 * Ingest 路徑要最短，不做任何同步的重運算（ARCHITECTURE §3）
 */
const { ObjectId } = require('mongodb');
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const env = require('../config/env');
const { maskDeep, maskHeaders } = require('../utils/mask');
const { processBody } = require('../utils/truncate');
const { hourKey } = require('../utils/response');

const REQUIRED = [
  ['ts', (l) => l.ts],
  ['level', (l) => l.level],
  ['request.method', (l) => l.request && l.request.method],
  ['request.path', (l) => l.request && l.request.path],
  ['response.status', (l) => l.response && l.response.status !== undefined],
  ['response.durationMs', (l) => l.response && l.response.durationMs !== undefined],
];

function validate(raw) {
  if (!raw || typeof raw !== 'object') return '紀錄必須為物件';
  for (const [name, getter] of REQUIRED) {
    if (!getter(raw)) return `缺少 ${name}`;
  }
  const ts = new Date(raw.ts);
  if (Number.isNaN(ts.getTime())) return 'ts 格式錯誤';
  return null;
}

/**
 * 判定是否為錯誤（PRD D-04）
 *   - HTTP >= 500
 *   - 服務自報 level: error
 */
function isError(raw) {
  const status = Number(raw.response.status);
  return status >= 500 || raw.level === 'error';
}

const META_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

/**
 * 附加標籤（例：BFF 的 routeCode、upstream）：只收平面的字串 / 數字 / 布林，最多 20 個，字串 200 字
 * 不合規的欄位直接略過，不讓整筆紀錄被拒
 */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (n >= 20 || !META_KEY.test(k)) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else continue;
    n += 1;
  }
  return n ? out : undefined;
}

/**
 * 將回報的原始紀錄正規化為儲存文件
 */
function normalize(raw, auth) {
  const error = isError(raw);
  const ts = new Date(raw.ts);
  const now = new Date();

  const req = raw.request || {};
  const resp = raw.response || {};

  const reqBody = processBody(
    maskDeep(req.body, req.maskFields || []),
    error,
    req.bodySize
  );
  const respBody = processBody(
    maskDeep(resp.body, req.maskFields || []),
    error,
    resp.bodySize
  );

  const doc = {
    // 寫入前先配發 _id —— Redis 摘要與 SSE 事件都要用，
    // 等 insertMany 回填會與並行的 Redis 寫入產生競態
    _id: new ObjectId(),
    projectId: auth.projectId,
    serviceId: auth.serviceId,       // 由 Key 決定，不採信 client 自報
    traceId: raw.traceId || null,
    ts,
    receivedAt: now,
    level: error ? 'error' : (raw.level === 'warn' ? 'warn' : 'info'),
    kind: ['job', 'web'].includes(raw.kind) ? raw.kind : 'http',
    request: {
      method: String(req.method).toUpperCase(),
      path: req.path,
      pathTemplate: req.pathTemplate || req.path,
      query: maskDeep(req.query || {}),
      body: reqBody.body,
      bodySize: reqBody.bodySize,
      bodyTruncated: reqBody.bodyTruncated,
      headers: maskHeaders(req.headers),
      ip: req.ip || null,
      userId: req.userId || null,
    },
    actions: Array.isArray(raw.actions)
      ? raw.actions.slice(0, 100).map((a, i) => ({
          seq: a.seq != null ? a.seq : i + 1,
          type: a.type || 'other',
          target: a.target || '',
          durationMs: a.durationMs != null ? a.durationMs : null,
          note: a.note || '',
          ok: a.ok !== false,
        })).sort((a, b) => a.seq - b.seq)
      : [],
    response: {
      status: Number(resp.status),
      body: respBody.body,
      bodySize: respBody.bodySize,
      bodyTruncated: respBody.bodyTruncated,
      durationMs: Number(resp.durationMs),
    },
  };

  const meta = sanitizeMeta(raw.meta);
  if (meta) doc.meta = meta;

  if (error) {
    doc.error = raw.error ? {
      name: raw.error.name || 'Error',
      message: raw.error.message || '',
      stack: raw.error.stack || '',
      code: raw.error.code || null,
    } : null;
  } else {
    // 一般紀錄設 7 天後到期（TTL index 依此刪除）
    doc.expireAt = new Date(ts.getTime() + env.logTtlDays * 86400 * 1000);
  }

  return { doc, isError: error };
}

/**
 * 寫入 Redis 快查層
 */
async function writeRedis(doc, error) {
  if (!redis.isConnected()) return;
  const client = redis.getClient();
  const listKey = error ? redis.keys.err(doc.serviceId) : redis.keys.log(doc.serviceId);
  const statKey = redis.keys.stat(doc.serviceId, hourKey(doc.ts));

  try {
    const pipeline = client.pipeline();
    pipeline.lpush(listKey, JSON.stringify(summarize(doc)));
    pipeline.ltrim(listKey, 0, env.redisListMax - 1);
    pipeline.expire(listKey, 86400);
    pipeline.hincrby(statKey, 'total', 1);
    if (error) pipeline.hincrby(statKey, 'error', 1);
    pipeline.hincrby(statKey, 'sumMs', Math.round(doc.response.durationMs));
    pipeline.expire(statKey, 86400);
    await pipeline.exec();
  } catch (err) {
    console.warn('[ingest] Redis 寫入失敗：', err.message);
  }
}

/**
 * 列表用的精簡版本
 */
function summarize(doc) {
  return {
    id: doc._id ? String(doc._id) : null,
    serviceId: doc.serviceId,
    ts: doc.ts,
    level: doc.level,
    kind: doc.kind,
    method: doc.request.method,
    path: doc.request.path,
    status: doc.response.status,
    durationMs: doc.response.durationMs,
    errorMessage: doc.error ? `${doc.error.name}: ${doc.error.message}` : null,
  };
}

/**
 * 寫入 Mongo；失敗時進待補佇列
 */
async function writeMongo(docs, error) {
  const collection = error ? 'error_logs' : 'api_logs';
  if (!mongo.isConnected()) {
    await pushPending(collection, docs);
    return false;
  }
  try {
    await mongo.col(collection).insertMany(docs, { ordered: false });
    return true;
  } catch (err) {
    console.warn(`[ingest] Mongo 寫入失敗（${collection}）：`, err.message);
    await pushPending(collection, docs);
    return false;
  }
}

async function pushPending(collection, docs) {
  if (!redis.isConnected()) return;
  try {
    const payloads = docs.map((d) => JSON.stringify({ collection, doc: d }));
    await redis.getClient().rpush(redis.keys.pending(), ...payloads);
  } catch (err) {
    console.warn('[ingest] 待補佇列寫入失敗：', err.message);
  }
}

/**
 * 消化待補佇列（Mongo 恢復後呼叫）
 */
async function flushPending(limit = 500) {
  if (!redis.isConnected() || !mongo.isConnected()) return 0;
  const client = redis.getClient();
  let flushed = 0;

  for (let i = 0; i < limit; i += 1) {
    const raw = await client.lpop(redis.keys.pending());
    if (!raw) break;
    try {
      const { collection, doc } = JSON.parse(raw);
      doc.ts = new Date(doc.ts);
      doc.receivedAt = new Date(doc.receivedAt);
      if (doc.expireAt) doc.expireAt = new Date(doc.expireAt);
      await mongo.col(collection).insertOne(doc);
      flushed += 1;
    } catch (err) {
      console.warn('[ingest] 待補紀錄寫入失敗，已丟棄：', err.message);
    }
  }
  return flushed;
}

async function pendingCount() {
  if (!redis.isConnected()) return 0;
  try {
    return await redis.getClient().llen(redis.keys.pending());
  } catch {
    return 0;
  }
}

/**
 * 主要入口：接收一批原始紀錄
 * @returns {{accepted:number, rejected:number, errors:Array, errorDocs:Array}}
 */
async function ingestBatch(rawLogs, auth) {
  const accepted = { normal: [], error: [] };
  const errors = [];

  rawLogs.forEach((raw, index) => {
    const problem = validate(raw);
    if (problem) {
      errors.push({ index, message: problem });
      return;
    }
    const { doc, isError: err } = normalize(raw, auth);
    if (err) accepted.error.push(doc);
    else accepted.normal.push(doc);
  });

  const tasks = [];
  if (accepted.normal.length) {
    tasks.push(writeMongo(accepted.normal, false));
    accepted.normal.forEach((d) => tasks.push(writeRedis(d, false)));
  }
  if (accepted.error.length) {
    tasks.push(writeMongo(accepted.error, true));
    accepted.error.forEach((d) => tasks.push(writeRedis(d, true)));
  }
  await Promise.all(tasks);

  return {
    accepted: accepted.normal.length + accepted.error.length,
    rejected: errors.length,
    errors,
    errorDocs: accepted.error,
  };
}

module.exports = {
  ingestBatch, validate, normalize, isError, sanitizeMeta,
  summarize, flushPending, pendingCount,
};
