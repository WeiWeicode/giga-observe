/**
 * GigaItApp 儀表板統計（MONITORING-PLAN §5.5）
 *
 * 「API 呼叫」以入口服務（BFF，ENTRY_SERVICE_ID）的紀錄計算：同一請求 BFF 與下游後端各記一筆，
 * 只算入口才不會重複。日界線以台灣時間（UTC+8）計。
 *
 *   today()      今日呼叫數（與昨日同時段比較）、可用率（非 5xx 比例）、平均 / p95 回應時間、每小時流量
 *   upstreams()  依上游（BFF 紀錄的 meta.upstream）彙總呼叫數、錯誤率、p95
 */
const mongo = require('../config/mongo');
const env = require('../config/env');

const TPE_OFFSET_MS = 8 * 3600 * 1000;
const COLLECTIONS = ['api_logs', 'error_logs'];

function entryServiceId() {
  return process.env.ENTRY_SERVICE_ID || 'gw-bff';
}

/** 台灣時間當日 00:00 的 UTC 時刻 */
function startOfTpeDay(now = new Date()) {
  const t = new Date(now.getTime() + TPE_OFFSET_MS);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TPE_OFFSET_MS);
}

/** 兩個 collection 跑同一個 pipeline 後合併 */
async function both(pipeline) {
  const [a, b] = await Promise.all(COLLECTIONS.map((c) => mongo.col(c).aggregate(pipeline).toArray()));
  return [...a, ...b];
}

async function summary(match) {
  const rows = await both([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        s5xx: { $sum: { $cond: [{ $gte: ['$response.status', 500] }, 1, 0] } },
        sumMs: { $sum: '$response.durationMs' },
        durations: { $push: '$response.durationMs' },
      },
    },
  ]);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const s5xx = rows.reduce((s, r) => s + r.s5xx, 0);
  const sumMs = rows.reduce((s, r) => s + r.sumMs, 0);
  const durations = rows.flatMap((r) => r.durations).sort((x, y) => x - y);
  return {
    total,
    errors: s5xx,
    availability: total ? Number(((total - s5xx) / total).toFixed(4)) : null,
    avgMs: total ? Math.round(sumMs / total) : null,
    p95Ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null,
  };
}

async function today(now = new Date()) {
  const empty = { entryServiceId: entryServiceId(), today: null, yesterday: null, hourly: [] };
  if (!mongo.isConnected()) return empty;
  const start = startOfTpeDay(now);
  const yStart = new Date(start.getTime() - 86400 * 1000);
  const yNow = new Date(now.getTime() - 86400 * 1000);
  const base = { projectId: env.projectId, serviceId: entryServiceId(), kind: 'http' };

  const [t, y, hours] = await Promise.all([
    summary({ ...base, ts: { $gte: start, $lt: now } }),
    summary({ ...base, ts: { $gte: yStart, $lt: yNow } }),
    both([
      { $match: { ...base, ts: { $gte: start, $lt: now } } },
      {
        $group: {
          _id: { $dateTrunc: { date: '$ts', unit: 'hour' } },
          total: { $sum: 1 },
          errors: { $sum: { $cond: [{ $gte: ['$response.status', 500] }, 1, 0] } },
          sumMs: { $sum: '$response.durationMs' },
        },
      },
    ]),
  ]);

  // 補齊 0 點到現在的每個小時，圖表才不會斷
  const byHour = new Map();
  for (const h of hours) {
    const k = h._id.getTime();
    const cur = byHour.get(k) || { total: 0, errors: 0, sumMs: 0 };
    byHour.set(k, { total: cur.total + h.total, errors: cur.errors + h.errors, sumMs: cur.sumMs + h.sumMs });
  }
  const hourly = [];
  for (let k = start.getTime(); k <= now.getTime(); k += 3600 * 1000) {
    const h = byHour.get(k) || { total: 0, errors: 0, sumMs: 0 };
    hourly.push({ ts: new Date(k), total: h.total, errors: h.errors, avgMs: h.total ? Math.round(h.sumMs / h.total) : null });
  }
  return { entryServiceId: entryServiceId(), today: t, yesterday: y, hourly };
}

async function upstreams(hours = 1) {
  if (!mongo.isConnected()) return [];
  const rows = await both([
    {
      $match: {
        projectId: env.projectId,
        serviceId: entryServiceId(),
        'meta.upstream': { $type: 'string' },
        ts: { $gte: new Date(Date.now() - hours * 3600 * 1000) },
      },
    },
    {
      $group: {
        _id: '$meta.upstream',
        total: { $sum: 1 },
        errors: { $sum: { $cond: [{ $gte: ['$response.status', 500] }, 1, 0] } },
        durations: { $push: '$response.durationMs' },
        lastAt: { $max: '$ts' },
      },
    },
  ]);
  const merged = new Map();
  for (const r of rows) {
    const cur = merged.get(r._id) || { total: 0, errors: 0, durations: [], lastAt: null };
    merged.set(r._id, {
      total: cur.total + r.total,
      errors: cur.errors + r.errors,
      durations: cur.durations.concat(r.durations),
      lastAt: !cur.lastAt || r.lastAt > cur.lastAt ? r.lastAt : cur.lastAt,
    });
  }
  return [...merged.entries()].map(([upstream, v]) => {
    const d = v.durations.sort((a, b) => a - b);
    return {
      upstream,
      total: v.total,
      errors: v.errors,
      errorRate: v.total ? Number((v.errors / v.total).toFixed(4)) : 0,
      availability: v.total ? Number(((v.total - v.errors) / v.total).toFixed(4)) : null,
      p95Ms: d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.95))] : null,
      lastAt: v.lastAt,
    };
  }).sort((a, b) => b.total - a.total);
}

module.exports = { today, upstreams, startOfTpeDay, entryServiceId };
