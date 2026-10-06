/**
 * 前端健康度事件（MONITORING-PLAN D5）
 *
 * 瀏覽器不能持有 API Key：web-kit → BFF POST /api/telemetry/web → 本服務 POST /api/v1/ingest/web-events。
 * BFF 以 scope `ingest-web` 的 Key 轉送，事件的 app 即前端服務代碼（例 itapp-web），必須是拓樸中 type = frontend 的服務。
 *
 *   type error  JS 錯誤                 → error_logs（kind web，永久；body 規則同後端）
 *   type api    API 呼叫失敗（網路 / 5xx） → error_logs（traceId = requestId，可對到後端紀錄）
 *   type vital  Web Vitals / 載入時間    → web_vitals（TRAFFIC_TTL_DAYS 天）
 *   type view   頁面瀏覽                 → 只計數（錯誤率的分母），不存紀錄
 */
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const env = require('../config/env');
const { hourKey } = require('../utils/response');
const topologyService = require('./topologyService');
const ingestService = require('./ingestService');

const VITALS = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'load']);
const MAX_EVENTS = 100;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

/** 前端服務：拓樸中 type = frontend；未登錄的 app 一律拒收（避免任意字串變成服務） */
function isFrontend(app) {
  const svc = topologyService.getService(app);
  return !!svc && svc.type === 'frontend';
}

function toErrorLog(e) {
  const ts = new Date(e.ts);
  const isApi = e.type === 'api';
  return {
    ts: Number.isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString(),
    level: 'error',
    kind: 'web',
    traceId: str(e.requestId, 100),
    request: {
      method: isApi ? (str(e.method, 10) || 'GET') : 'VIEW',
      path: (isApi ? str(e.url, 300) : str(e.page, 300)) || '/',
      pathTemplate: (isApi ? str(e.url, 300) : str(e.route, 300) || str(e.page, 300)) || '/',
      query: {},
      body: null,
      headers: e.ua ? { 'user-agent': str(e.ua, 300) } : {},
      ip: str(e.ip, 45),
      userId: e.anonymous ? null : str(e.userId, 50),
    },
    actions: [],
    response: { status: isApi ? Number(e.status) || 0 : 0, durationMs: Number(e.durationMs) || 0, body: null },
    error: {
      name: str(e.name, 100) || (isApi ? 'ApiError' : 'Error'),
      message: str(e.message, 2000) || '',
      stack: str(e.stack, 8000) || '',
      code: str(e.code, 100),
    },
    meta: { page: str(e.page, 200), anonymous: !!e.anonymous, ...(e.release ? { release: str(e.release, 50) } : {}) },
  };
}

async function countViews(serviceId, n) {
  if (!n || !redis.isConnected()) return;
  const key = redis.keys.stat(serviceId, hourKey(new Date()));
  try {
    await redis.getClient().pipeline().hincrby(key, 'total', n).expire(key, 86400).exec();
  } catch { /* 計數失敗不影響收件 */ }
}

/**
 * @returns {{ accepted, rejected, errors, errorDocs }}
 */
async function ingest(events, auth) {
  const errors = [];
  const byApp = new Map();
  events.forEach((e, index) => {
    if (index >= MAX_EVENTS) return errors.push({ index, message: `一次最多 ${MAX_EVENTS} 筆` });
    if (!e || typeof e !== 'object') return errors.push({ index, message: '事件必須為物件' });
    if (!isFrontend(e.app)) return errors.push({ index, message: `未登錄的前端服務：${e.app}` });
    if (!['error', 'api', 'vital', 'view'].includes(e.type)) return errors.push({ index, message: `未知的事件類型：${e.type}` });
    if (e.type === 'vital' && (!VITALS.has(e.name) || !Number.isFinite(Number(e.value)))) return errors.push({ index, message: '不合法的效能指標' });
    if (!byApp.has(e.app)) byApp.set(e.app, []);
    byApp.get(e.app).push(e);
    return null;
  });

  let accepted = 0;
  const errorDocs = [];
  for (const [app, list] of byApp) {
    const appAuth = { projectId: auth.projectId, serviceId: app, scopes: auth.scopes };
    const errorLogs = list.filter((e) => e.type === 'error' || e.type === 'api').map(toErrorLog);
    if (errorLogs.length) {
      const r = await ingestService.ingestBatch(errorLogs, appAuth);
      accepted += r.accepted;
      errorDocs.push(...r.errorDocs);
    }
    const vitals = list.filter((e) => e.type === 'vital').map((e) => {
      const ts = new Date(e.ts);
      const at = Number.isNaN(ts.getTime()) ? new Date() : ts;
      return {
        projectId: auth.projectId,
        serviceId: app,
        ts: at,
        page: str(e.route, 200) || str(e.page, 200) || '/',
        name: e.name,
        value: Number(e.value),
        rating: ['good', 'needs-improvement', 'poor'].includes(e.rating) ? e.rating : null,
        expireAt: new Date(at.getTime() + env.trafficTtlDays * 86400 * 1000),
      };
    });
    if (vitals.length && mongo.isConnected()) {
      await mongo.col('web_vitals').insertMany(vitals, { ordered: false }).catch((err) => console.warn('[web] 效能資料寫入失敗：', err.message));
    }
    accepted += vitals.length;
    const views = list.filter((e) => e.type === 'view').length;
    await countViews(app, views);
    accepted += views;
  }
  return { accepted, rejected: errors.length, errors, errorDocs };
}

/**
 * 各前端、各指標近 24 小時的 p75（Web Vitals 慣例）
 */
async function vitalsSummary(hours = 24) {
  if (!mongo.isConnected()) return [];
  const rows = await mongo.col('web_vitals').aggregate([
    { $match: { projectId: env.projectId, ts: { $gte: new Date(Date.now() - hours * 3600 * 1000) } } },
    { $group: { _id: { serviceId: '$serviceId', name: '$name' }, values: { $push: '$value' }, count: { $sum: 1 } } },
  ]).toArray();
  return rows.map((r) => {
    const sorted = r.values.sort((a, b) => a - b);
    const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
    return { serviceId: r._id.serviceId, name: r._id.name, p75, count: r.count };
  });
}

module.exports = { ingest, toErrorLog, vitalsSummary, isFrontend };
