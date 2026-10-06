/**
 * 查詢：近 24 小時的簡單查詢走 Redis，其餘走 Mongo（ARCHITECTURE §3）
 */
const { ObjectId } = require('mongodb');
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const env = require('../config/env');
const { hourKey } = require('../utils/response');

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function parseStatusFilter(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (/^[1-5]xx$/.test(s)) {
    const base = parseInt(s[0], 10) * 100;
    return { $gte: base, $lt: base + 100 };
  }
  const num = parseInt(s, 10);
  return Number.isNaN(num) ? null : num;
}

/**
 * 判斷這次查詢能不能走 Redis
 *   - 時間範圍在近 24 小時內
 *   - 沒有關鍵字搜尋
 *   - 沒有 cursor（Redis list 不支援 cursor 分頁）
 */
function canUseRedis(params) {
  if (!redis.isConnected()) return false;
  if (params.q) return false;
  if (params.traceId) return false;
  if (params.cursor) return false;
  if (!params.serviceId || params.serviceId.length !== 1) return false;
  const from = params.from ? new Date(params.from) : new Date(Date.now() - 3600 * 1000);
  return Date.now() - from.getTime() <= 24 * 3600 * 1000;
}

async function queryRedis(params) {
  const serviceId = params.serviceId[0];
  const limit = Math.min(params.limit || DEFAULT_LIMIT, MAX_LIMIT);

  // 未指定 level 時兩個 list 都要讀 —— 只讀 log: 會漏掉所有錯誤紀錄
  const keys = [];
  if (params.level === 'error') {
    keys.push(redis.keys.err(serviceId));
  } else if (params.level) {
    keys.push(redis.keys.log(serviceId));
  } else {
    keys.push(redis.keys.log(serviceId), redis.keys.err(serviceId));
  }

  const rawSets = await Promise.all(
    keys.map((k) => redis.getClient().lrange(k, 0, limit * 2))
  );

  let items = rawSets.flat().map((r) => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  // Redis 存的是精簡版，篩選條件在記憶體中套用
  items = applyFilters(items, params);
  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return items.slice(0, limit);
}

function applyFilters(items, params) {
  return items.filter((item) => {
    if (params.from && new Date(item.ts) < new Date(params.from)) return false;
    if (params.to && new Date(item.ts) > new Date(params.to)) return false;
    if (params.level && item.level !== params.level) return false;
    if (params.kind && item.kind !== params.kind) return false;
    if (params.method && item.method !== String(params.method).toUpperCase()) return false;
    if (params.path && !String(item.path).includes(params.path)) return false;
    if (params.status != null) {
      const f = parseStatusFilter(params.status);
      if (typeof f === 'number' && item.status !== f) return false;
      if (f && typeof f === 'object' && (item.status < f.$gte || item.status >= f.$lt)) return false;
    }
    return true;
  });
}

function buildMongoFilter(params) {
  const filter = { projectId: env.projectId };

  if (params.serviceId && params.serviceId.length) {
    filter.serviceId = params.serviceId.length === 1
      ? params.serviceId[0]
      : { $in: params.serviceId };
  }

  const from = params.from ? new Date(params.from) : new Date(Date.now() - 3600 * 1000);
  const to = params.to ? new Date(params.to) : null;
  filter.ts = { $gte: from };
  if (to) filter.ts.$lte = to;

  if (params.traceId) filter.traceId = String(params.traceId);
  if (params.level) filter.level = params.level;
  if (params.kind) filter.kind = params.kind;
  if (params.method) filter['request.method'] = String(params.method).toUpperCase();
  if (params.path) filter['request.path'] = { $regex: escapeRegex(params.path), $options: 'i' };

  const statusFilter = parseStatusFilter(params.status);
  if (statusFilter !== null) filter['response.status'] = statusFilter;

  if (params.cursor) {
    filter._id = { $lt: new ObjectId(params.cursor) };
  }

  return filter;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 跨 api_logs 與 error_logs 查詢
 */
async function queryMongo(params) {
  const limit = Math.min(params.limit || DEFAULT_LIMIT, MAX_LIMIT);
  const filter = buildMongoFilter(params);

  // level=error 時只查 error_logs，其餘兩邊都查再合併
  const collections = params.level === 'error'
    ? ['error_logs']
    : (params.level ? ['api_logs'] : ['api_logs', 'error_logs']);

  const results = await Promise.all(collections.map(async (c) => {
    let cursor = mongo.col(c).find(filter).sort({ ts: -1, _id: -1 }).limit(limit + 1);
    if (params.q) {
      // 關鍵字搜 body 內容：以正則掃描序列化後的 body
      const rx = { $regex: escapeRegex(params.q), $options: 'i' };
      cursor = mongo.col(c).find({
        ...filter,
        $or: [
          { 'request.path': rx },
          { 'request.body': rx },
          { 'response.body': rx },
          { 'error.message': rx },
        ],
      }).sort({ ts: -1, _id: -1 }).limit(limit + 1);
    }
    return cursor.toArray();
  }));

  const merged = results.flat()
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, limit + 1);

  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);

  return {
    items: page.map(toSummary),
    hasMore,
    nextCursor: hasMore && page.length ? String(page[page.length - 1]._id) : null,
  };
}

function toSummary(doc) {
  return {
    id: String(doc._id),
    serviceId: doc.serviceId,
    ts: doc.ts,
    level: doc.level,
    kind: doc.kind,
    method: doc.request.method,
    path: doc.request.path,
    pathTemplate: doc.request.pathTemplate || null,
    status: doc.response.status,
    durationMs: doc.response.durationMs,
    traceId: doc.traceId || null,
    userId: doc.request.userId || null,
    meta: doc.meta || null,
    errorMessage: doc.error ? `${doc.error.name}: ${doc.error.message}` : null,
  };
}

/**
 * 主查詢入口
 * @returns {{items, hasMore, nextCursor, source}}
 */
async function queryLogs(params) {
  if (canUseRedis(params)) {
    try {
      const items = await queryRedis(params);
      return { items, hasMore: false, nextCursor: null, source: 'redis' };
    } catch (err) {
      console.warn('[query] Redis 查詢失敗，回落 Mongo：', err.message);
    }
  }
  const result = await queryMongo(params);
  return { ...result, source: 'mongo' };
}

/**
 * 單筆明細：兩個 collection 都找
 */
async function getLogById(id) {
  if (!ObjectId.isValid(id)) return null;
  const oid = new ObjectId(id);
  const filter = { _id: oid, projectId: env.projectId };

  const [normal, error] = await Promise.all([
    mongo.col('api_logs').findOne(filter),
    mongo.col('error_logs').findOne(filter),
  ]);
  return error || normal || null;
}

/**
 * 錯誤聚合（API_CONTRACT §3.5）
 */
async function aggregateErrors(params) {
  const from = params.from ? new Date(params.from) : new Date(Date.now() - 7 * 86400 * 1000);
  const to = params.to ? new Date(params.to) : null;

  const match = { projectId: env.projectId, ts: { $gte: from } };
  if (to) match.ts.$lte = to;
  if (params.serviceId && params.serviceId.length) {
    match.serviceId = params.serviceId.length === 1
      ? params.serviceId[0] : { $in: params.serviceId };
  }
  const statusFilter = parseStatusFilter(params.status);
  if (statusFilter !== null) match['response.status'] = statusFilter;
  if (params.path) match['request.path'] = { $regex: escapeRegex(params.path), $options: 'i' };

  const sortStage = params.sort === 'latest' ? { lastSeenAt: -1 } : { count: -1 };
  const limit = Math.min(params.limit || 50, 200);

  // 4xx 在 api_logs，5xx 與自報 error 在 error_logs —— 兩邊都要查
  const wants4xx = statusFilter && typeof statusFilter === 'object'
    ? statusFilter.$gte < 500
    : (typeof statusFilter === 'number' ? statusFilter < 500 : false);

  const collections = wants4xx ? ['api_logs'] : ['error_logs'];
  if (!statusFilter) collections.push('api_logs');

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: {
          serviceId: '$serviceId',
          method: '$request.method',
          pathTemplate: '$request.pathTemplate',
          status: '$response.status',
        },
        count: { $sum: 1 },
        firstSeenAt: { $min: '$ts' },
        lastSeenAt: { $max: '$ts' },
        sampleLogId: { $last: '$_id' },
        sampleErrorMessage: { $last: '$error.message' },
      },
    },
    { $sort: sortStage },
    { $limit: limit },
  ];

  const resultSets = await Promise.all(collections.map(async (c) => {
    const m = c === 'api_logs' && !statusFilter
      ? { ...match, 'response.status': { $gte: 400, $lt: 500 } }
      : match;
    return mongo.col(c).aggregate([{ $match: m }, ...pipeline.slice(1)]).toArray();
  }));

  const merged = resultSets.flat().map((g) => ({
    serviceId: g._id.serviceId,
    method: g._id.method,
    pathTemplate: g._id.pathTemplate,
    status: g._id.status,
    count: g.count,
    firstSeenAt: g.firstSeenAt,
    lastSeenAt: g.lastSeenAt,
    sampleLogId: g.sampleLogId ? String(g.sampleLogId) : null,
    sampleErrorMessage: g.sampleErrorMessage || null,
  }));

  merged.sort((a, b) => params.sort === 'latest'
    ? new Date(b.lastSeenAt) - new Date(a.lastSeenAt)
    : b.count - a.count);

  return merged.slice(0, limit);
}

/**
 * 某組錯誤的個別事件
 */
async function errorGroupEvents(groupKey, limit = 100) {
  const [serviceId, method, pathTemplate, status] = groupKey.split('|');
  const filter = {
    projectId: env.projectId,
    serviceId,
    'request.method': method,
    'request.pathTemplate': pathTemplate,
    'response.status': parseInt(status, 10),
  };
  const [errs, normals] = await Promise.all([
    mongo.col('error_logs').find(filter).sort({ ts: -1 }).limit(limit).toArray(),
    mongo.col('api_logs').find(filter).sort({ ts: -1 }).limit(limit).toArray(),
  ]);
  return [...errs, ...normals]
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, limit)
    .map(toSummary);
}

/**
 * 總覽統計（API_CONTRACT §3.7）
 */
async function overview(statusMap) {
  const counts = { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const doc of Object.values(statusMap)) {
    counts.total += 1;
    counts[doc.status] = (counts[doc.status] || 0) + 1;
  }

  const [last1h, last24h] = await Promise.all([
    windowStats(1), windowStats(24),
  ]);

  const topErrors = await aggregateErrors({ sort: 'count', limit: 5 });
  const slowest = await slowestApis(5);

  return { services: counts, last1h, last24h, topErrors, slowest };
}

async function windowStats(hours) {
  const from = new Date(Date.now() - hours * 3600 * 1000);
  const match = { projectId: env.projectId, ts: { $gte: from } };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        sumMs: { $sum: '$response.durationMs' },
      },
    },
  ];

  const [normal, error] = await Promise.all([
    mongo.col('api_logs').aggregate(pipeline).toArray(),
    mongo.col('error_logs').aggregate(pipeline).toArray(),
  ]);

  const n = normal[0] || { total: 0, sumMs: 0 };
  const e = error[0] || { total: 0, sumMs: 0 };
  const total = n.total + e.total;
  const avgMs = total > 0 ? Math.round((n.sumMs + e.sumMs) / total) : 0;

  return {
    total,
    error: e.total,
    errorRate: total > 0 ? Number((e.total / total).toFixed(4)) : 0,
    avgMs,
  };
}

async function slowestApis(limit = 5) {
  const from = new Date(Date.now() - 24 * 3600 * 1000);
  const pipeline = [
    { $match: { projectId: env.projectId, ts: { $gte: from } } },
    {
      $group: {
        _id: { serviceId: '$serviceId', pathTemplate: '$request.pathTemplate' },
        avgMs: { $avg: '$response.durationMs' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gte: 3 } } },
    { $sort: { avgMs: -1 } },
    { $limit: limit },
  ];
  const rows = await mongo.col('api_logs').aggregate(pipeline).toArray();
  return rows.map((r) => ({
    serviceId: r._id.serviceId,
    pathTemplate: r._id.pathTemplate,
    avgMs: Math.round(r.avgMs),
    count: r.count,
  }));
}

/**
 * 單一服務的近期紀錄（詳情面板用）
 */
async function recentForService(serviceId, { limit = 50, onlyError = false } = {}) {
  const result = await queryLogs({
    serviceId: [serviceId],
    level: onlyError ? 'error' : null,
    limit,
    from: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  });
  return result.items;
}

module.exports = {
  queryLogs, getLogById, aggregateErrors, errorGroupEvents,
  overview, recentForService, toSummary, MAX_LIMIT, DEFAULT_LIMIT,
};
