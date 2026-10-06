/**
 * Nginx 流量彙總（MONITORING-PLAN D4）
 *
 * nginx-log-agent 每分鐘送一筆彙總，不逐筆送（BFF 已逐筆回報同一批請求）。
 * 以 `${serviceId}:${分鐘}` 為 _id upsert：agent 重送同一分鐘不會重複計算。
 * 保留 TRAFFIC_TTL_DAYS 天（預設 90）。
 */
const mongo = require('../config/mongo');
const env = require('../config/env');

const COLLECTION = 'traffic_minutely';
const MAX_TOP = 20;
const IP = /^[0-9a-fA-F:.]{2,45}$/;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 物件型計數（{ '2xx': 10 }、{ '429': 3 }），只收數字 */
function counts(obj, keyPattern) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (keyPattern.test(k)) out[k] = num(v);
  }
  return out;
}

function validate(raw) {
  if (!raw || typeof raw !== 'object') return '彙總必須為物件';
  const ts = new Date(raw.ts);
  if (Number.isNaN(ts.getTime())) return 'ts 格式錯誤';
  if (raw.total === undefined || !Number.isFinite(Number(raw.total))) return '缺少 total';
  return null;
}

/**
 * 正規化單分鐘彙總
 */
function normalize(raw, auth) {
  const ts = new Date(raw.ts);
  ts.setUTCSeconds(0, 0);
  const topIps = (Array.isArray(raw.topIps) ? raw.topIps : [])
    .filter((x) => x && IP.test(String(x.ip)))
    .slice(0, MAX_TOP)
    .map((x) => ({ ip: String(x.ip), count: num(x.count), errors: num(x.errors), denied: num(x.denied) }));
  const topPaths = (Array.isArray(raw.topPaths) ? raw.topPaths : [])
    .filter((x) => x && typeof x.path === 'string')
    .slice(0, MAX_TOP)
    .map((x) => ({ path: x.path.slice(0, 200), count: num(x.count), errors: num(x.errors) }));

  return {
    _id: `${auth.serviceId}:${ts.toISOString()}`,
    projectId: auth.projectId,
    serviceId: auth.serviceId,
    ts,
    total: num(raw.total),
    status: counts(raw.status, /^[1-5]xx$/),
    codes: counts(raw.codes, /^[1-5]\d\d$/),
    bytes: num(raw.bytes),
    avgMs: num(raw.avgMs),
    p95Ms: num(raw.p95Ms),
    uniqueIps: num(raw.uniqueIps),
    topIps,
    topPaths,
    // 沒走 PROXY protocol 的連線，來源 IP 會是 Docker 網段（DEPLOYMENT §6.1）
    realIp: raw.realIp !== false,
    receivedAt: new Date(),
    expireAt: new Date(ts.getTime() + env.trafficTtlDays * 86400 * 1000),
  };
}

async function ingest(minutes, auth) {
  const errors = [];
  const docs = [];
  minutes.forEach((raw, index) => {
    const problem = validate(raw);
    if (problem) errors.push({ index, message: problem });
    else docs.push(normalize(raw, auth));
  });
  if (docs.length && mongo.isConnected()) {
    await mongo.col(COLLECTION).bulkWrite(
      docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false }
    );
  }
  return { accepted: docs.length, rejected: errors.length, errors };
}

function range(params) {
  const to = params.to ? new Date(params.to) : new Date();
  const from = params.from ? new Date(params.from) : new Date(to.getTime() - 24 * 3600 * 1000);
  return { from, to };
}

/**
 * 時序：bucket = minute | hour
 */
async function series(params = {}) {
  if (!mongo.isConnected()) return [];
  const { from, to } = range(params);
  const unit = params.bucket === 'minute' ? 'minute' : 'hour';
  const rows = await mongo.col(COLLECTION).aggregate([
    { $match: { projectId: env.projectId, ts: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$ts', unit } },
        total: { $sum: '$total' },
        s4xx: { $sum: { $ifNull: ['$status.4xx', 0] } },
        s5xx: { $sum: { $ifNull: ['$status.5xx', 0] } },
        c401: { $sum: { $ifNull: ['$codes.401', 0] } },
        c403: { $sum: { $ifNull: ['$codes.403', 0] } },
        c429: { $sum: { $ifNull: ['$codes.429', 0] } },
        bytes: { $sum: '$bytes' },
        p95Ms: { $max: '$p95Ms' },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();
  return rows.map((r) => ({
    ts: r._id, total: r.total, status4xx: r.s4xx, status5xx: r.s5xx,
    unauthorized: r.c401, forbidden: r.c403, rateLimited: r.c429, bytes: r.bytes, p95Ms: r.p95Ms,
  }));
}

/**
 * 期間內的來源 IP 排行（由每分鐘的 Top N 合併，為近似值）
 */
async function topIps(params = {}) {
  if (!mongo.isConnected()) return [];
  const { from, to } = range(params);
  const limit = Math.min(Number(params.limit) || 20, 100);
  const rows = await mongo.col(COLLECTION).aggregate([
    { $match: { projectId: env.projectId, ts: { $gte: from, $lt: to } } },
    { $unwind: '$topIps' },
    {
      $group: {
        _id: '$topIps.ip',
        count: { $sum: '$topIps.count' },
        errors: { $sum: '$topIps.errors' },
        denied: { $sum: '$topIps.denied' },
        lastSeen: { $max: '$ts' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]).toArray();
  return rows.map((r) => ({ ip: r._id, count: r.count, errors: r.errors, denied: r.denied, lastSeen: r.lastSeen }));
}

/**
 * 告警用：近 N 分鐘每分鐘的 401/403/429 與單一 IP 最高請求數
 */
async function recentMinutes(minutes = 15) {
  if (!mongo.isConnected()) return [];
  return mongo.col(COLLECTION)
    .find({ projectId: env.projectId, ts: { $gte: new Date(Date.now() - minutes * 60 * 1000) } })
    .project({ ts: 1, total: 1, codes: 1, status: 1, topIps: 1, realIp: 1 })
    .sort({ ts: 1 })
    .toArray();
}

module.exports = { ingest, validate, normalize, series, topIps, recentMinutes, COLLECTION };
