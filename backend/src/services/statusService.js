/**
 * 服務健康狀態判定（ARCHITECTURE §4）
 *
 * 全專案唯一可以寫 service_status 的地方（AGENT.md §9.6）。
 * Ingest 與 Prober 只負責餵資料，判斷一律經過這裡。
 */
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const env = require('../config/env');
const sseHub = require('./sseHub');
const { hourKey } = require('../utils/response');
const topologyService = require('./topologyService');

let evalTimer = null;

function statusId(serviceId) {
  return `${env.projectId}:${serviceId}`;
}

/**
 * 取近 N 分鐘的計數；跨小時時合併相鄰兩個 key
 */
/**
 * Redis 不可用時改從 Mongo 計算(較慢,但統計不會歸零);前端瀏覽次數只記在 Redis,此時不列入
 */
async function recentStatsFromMongo(serviceId, minutes) {
  const match = { projectId: env.projectId, serviceId, ts: { $gte: new Date(Date.now() - minutes * 60 * 1000) } };
  const pipeline = [{ $match: match }, { $group: { _id: null, total: { $sum: 1 }, sumMs: { $sum: '$response.durationMs' } } }];
  const [n, e] = await Promise.all([
    mongo.col('api_logs').aggregate(pipeline).toArray(),
    mongo.col('error_logs').aggregate(pipeline).toArray(),
  ]);
  const a = n[0] || { total: 0, sumMs: 0 };
  const b = e[0] || { total: 0, sumMs: 0 };
  return { total: a.total + b.total, error: b.total, sumMs: a.sumMs + b.sumMs };
}

async function recentStats(serviceId, minutes = 5) {
  if (!redis.isConnected()) {
    if (!mongo.isConnected()) return { total: 0, error: 0, sumMs: 0 };
    return recentStatsFromMongo(serviceId, minutes).catch(() => ({ total: 0, error: 0, sumMs: 0 }));
  }

  const now = new Date();
  const prevHour = new Date(now.getTime() - 3600 * 1000);
  const keys = [
    redis.keys.stat(serviceId, hourKey(now)),
    redis.keys.stat(serviceId, hourKey(prevHour)),
  ];

  try {
    const results = await Promise.all(keys.map((k) => redis.getClient().hgetall(k)));
    const agg = { total: 0, error: 0, sumMs: 0 };
    for (const r of results) {
      if (!r) continue;
      agg.total += parseInt(r.total || 0, 10);
      agg.error += parseInt(r.error || 0, 10);
      agg.sumMs += parseInt(r.sumMs || 0, 10);
    }
    return agg;
  } catch {
    return { total: 0, error: 0, sumMs: 0 };
  }
}

async function lastSignal(serviceId) {
  const result = { heartbeat: null, probe: null };
  if (!redis.isConnected()) return result;
  try {
    const [hb, probe] = await redis.getClient().mget(
      redis.keys.hb(serviceId),
      redis.keys.probe(serviceId)
    );
    if (hb) result.heartbeat = new Date(parseInt(hb, 10));
    if (probe) result.probe = new Date(parseInt(probe, 10));
  } catch { /* 忽略 */ }
  return result;
}

/**
 * 判定單一服務的狀態
 */
async function evaluate(serviceId) {
  const signals = await lastSignal(serviceId);
  let existing = null;
  if (mongo.isConnected()) {
    existing = await mongo.col('service_status').findOne({ _id: statusId(serviceId) });
  }

  // Redis 掉資料時回落 service_status 中的既有時間戳
  const hbAt = signals.heartbeat || (existing && existing.lastHeartbeatAt) || null;
  const probeAt = signals.probe || (existing && existing.lastProbeOkAt) || null;

  const stats = await recentStats(serviceId, 5);
  const errorRate = stats.total > 0 ? stats.error / stats.total : 0;

  let status;
  if (!hbAt && !probeAt) {
    status = 'unknown';
  } else {
    const newest = Math.max(
      hbAt ? new Date(hbAt).getTime() : 0,
      probeAt ? new Date(probeAt).getTime() : 0
    );
    const ageSec = (Date.now() - newest) / 1000;
    if (ageSec > env.heartbeatTimeoutSec) {
      status = 'down';
    } else {
      status = errorRate >= env.errorRateThreshold ? 'degraded' : 'healthy';
    }
  }

  const previousStatus = existing ? existing.status : null;
  const changed = previousStatus !== status;
  const now = new Date();

  const doc = {
    _id: statusId(serviceId),
    projectId: env.projectId,
    serviceId,
    status,
    since: changed ? now : (existing ? existing.since : now),
    lastHeartbeatAt: hbAt,
    lastProbeOkAt: probeAt,
    lastErrorAt: existing ? existing.lastErrorAt : null,
    stats5m: { total: stats.total, error: stats.error, errorRate: Number(errorRate.toFixed(4)) },
    stats1h: existing ? existing.stats1h : { total: 0, error: 0, avgMs: 0 },
    version: existing ? existing.version : null,
    uptimeSec: existing ? existing.uptimeSec : null,
    deps: existing ? existing.deps : [],
    updatedAt: now,
  };

  if (mongo.isConnected()) {
    await mongo.col('service_status').updateOne(
      { _id: doc._id },
      { $set: doc },
      { upsert: true }
    );
  }

  if (changed) {
    sseHub.broadcast('status', {
      serviceId,
      status,
      previousStatus,
      since: doc.since,
    });
    console.log(`[status] ${serviceId}: ${previousStatus || '—'} → ${status}`);
  }

  return doc;
}

/**
 * 重算所有已登錄服務
 */
async function evaluateAll() {
  const services = topologyService.getServices();
  for (const svc of services) {
    try {
      await evaluate(svc.id);
    } catch (err) {
      console.warn(`[status] ${svc.id} 判定失敗：`, err.message);
    }
  }
  await refreshSnapshot();
}

/**
 * 更新心跳時間戳（由 heartbeat route 與 prober 呼叫）
 */
async function recordHeartbeat(serviceId, { version, uptimeSec, deps, source = 'push' } = {}) {
  const now = Date.now();
  if (redis.isConnected()) {
    const key = source === 'probe' ? redis.keys.probe(serviceId) : redis.keys.hb(serviceId);
    await redis.getClient().setex(key, 120, String(now)).catch(() => {});
  }

  if (mongo.isConnected()) {
    const ts = new Date(now);
    const hbDoc = {
      projectId: env.projectId,
      serviceId,
      ts,
      source,
      ok: true,
      version: version || null,
      uptimeSec: uptimeSec != null ? uptimeSec : null,
      deps: Array.isArray(deps) ? deps : [],
      expireAt: new Date(now + env.logTtlDays * 86400 * 1000),
    };
    await mongo.col('heartbeats').insertOne(hbDoc).catch(() => {});

    const update = { updatedAt: ts };
    if (source === 'probe') update.lastProbeOkAt = ts;
    else update.lastHeartbeatAt = ts;
    if (version) update.version = version;
    if (uptimeSec != null) update.uptimeSec = uptimeSec;
    if (Array.isArray(deps)) update.deps = deps;

    await mongo.col('service_status').updateOne(
      { _id: statusId(serviceId) },
      { $set: update, $setOnInsert: { projectId: env.projectId, serviceId, status: 'unknown', since: ts } },
      { upsert: true }
    ).catch(() => {});
  }
}

async function recordProbeFailure(serviceId) {
  if (!mongo.isConnected()) return;
  await mongo.col('heartbeats').insertOne({
    projectId: env.projectId,
    serviceId,
    ts: new Date(),
    source: 'probe',
    ok: false,
    version: null,
    uptimeSec: null,
    deps: [],
    expireAt: new Date(Date.now() + env.logTtlDays * 86400 * 1000),
  }).catch(() => {});
}

/**
 * 收到錯誤時立即重算，不等下一輪定期判定
 */
async function onErrorReported(serviceId) {
  if (mongo.isConnected()) {
    await mongo.col('service_status').updateOne(
      { _id: statusId(serviceId) },
      { $set: { lastErrorAt: new Date() } }
    ).catch(() => {});
  }
  await evaluate(serviceId);
  await refreshSnapshot();
}

/**
 * 取得全服務狀態（架構圖與 SSE snapshot 共用）
 */
async function getAllStatus() {
  if (!mongo.isConnected()) return [];
  const docs = await mongo.col('service_status')
    .find({ projectId: env.projectId })
    .toArray();
  const map = {};
  for (const d of docs) map[d.serviceId] = d;
  return map;
}

async function buildSnapshot() {
  const statusMap = await getAllStatus();
  const services = topologyService.getServices();
  return services.map((svc) => ({
    id: svc.id,
    name: svc.name,
    type: svc.type,
    layer: svc.layer,
    stack: svc.stack || [],
    team: svc.team || '',
    owner: svc.owner || '',
    lifecycle: svc.status || 'active',
    links: svc.links || {},
    health: buildHealth(statusMap[svc.id]),
  }));
}

function buildHealth(statusDoc) {
  if (!statusDoc) {
    return {
      status: 'unknown', since: null,
      lastHeartbeatAt: null, lastProbeOkAt: null,
      stats1h: { total: 0, error: 0, avgMs: 0 },
      stats5m: { total: 0, error: 0, errorRate: 0 },
      deps: [],
    };
  }
  return {
    status: statusDoc.status,
    since: statusDoc.since,
    lastHeartbeatAt: statusDoc.lastHeartbeatAt,
    lastProbeOkAt: statusDoc.lastProbeOkAt,
    lastErrorAt: statusDoc.lastErrorAt,
    stats1h: statusDoc.stats1h || { total: 0, error: 0, avgMs: 0 },
    stats5m: statusDoc.stats5m || { total: 0, error: 0, errorRate: 0 },
    version: statusDoc.version,
    uptimeSec: statusDoc.uptimeSec,
    deps: statusDoc.deps || [],
  };
}

/**
 * 更新 Redis 中的狀態快照
 */
async function refreshSnapshot() {
  if (!redis.isConnected()) return;
  try {
    const snapshot = await buildSnapshot();
    await redis.getClient().setex(
      redis.keys.statusAll(), 60, JSON.stringify(snapshot)
    );
  } catch (err) {
    console.warn('[status] 快照更新失敗：', err.message);
  }
}

/**
 * 更新近 1 小時統計（每次定期判定時一併算）
 */
/**
 * 只送每分鐘彙總、不逐筆回報的服務(Nginx):近 1 小時統計改由 traffic_minutely 計算
 */
async function trafficStats(serviceId, minutes) {
  const rows = await mongo.col('traffic_minutely').aggregate([
    { $match: { projectId: env.projectId, serviceId, ts: { $gte: new Date(Date.now() - minutes * 60 * 1000) } } },
    { $group: { _id: null, total: { $sum: '$total' }, error: { $sum: { $ifNull: ['$status.5xx', 0] } }, sumMs: { $sum: { $multiply: ['$avgMs', '$total'] } } } },
  ]).toArray();
  return rows[0] || { total: 0, error: 0, sumMs: 0 };
}

async function refreshHourlyStats() {
  if (!mongo.isConnected()) return;
  const services = topologyService.getServices();
  for (const svc of services) {
    let stats = await recentStats(svc.id, 60);
    if (stats.total === 0) stats = await trafficStats(svc.id, 60).catch(() => stats);
    const avgMs = stats.total > 0 ? Math.round(stats.sumMs / stats.total) : 0;
    await mongo.col('service_status').updateOne(
      { _id: statusId(svc.id) },
      { $set: { stats1h: { total: stats.total, error: stats.error, avgMs } } }
    ).catch(() => {});
  }
}

function startEvalLoop() {
  if (evalTimer) return;
  evalTimer = setInterval(async () => {
    try {
      await refreshHourlyStats();
      await evaluateAll();
    } catch (err) {
      console.warn('[status] 定期判定失敗：', err.message);
    }
  }, env.statusEvalIntervalSec * 1000);
}

function stop() {
  if (evalTimer) clearInterval(evalTimer);
  evalTimer = null;
}

module.exports = {
  evaluate, evaluateAll, recordHeartbeat, recordProbeFailure,
  onErrorReported, getAllStatus, buildSnapshot, buildHealth,
  refreshSnapshot, startEvalLoop, stop, statusId, recentStats,
};
