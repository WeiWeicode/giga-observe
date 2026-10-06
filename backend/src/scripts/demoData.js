/**
 * 本機示範資料(devLocal.js 使用;不會在測試區 / 正式區執行):直接呼叫各 service 寫入,模擬
 *   gw-bff(含轉送上游的 meta)、itapp-api、itapp-web(前端事件)、gw-nginx(每分鐘流量)與心跳。
 * 近 30 分鐘 itapp-api 有一段 502、Nginx 有一段 429 突增,畫面上才看得到告警與錯誤。
 */
const ingestService = require('../services/ingestService');
const trafficService = require('../services/trafficService');
const webService = require('../services/webService');
const statusService = require('../services/statusService');

const P = 'giganexus';
const auth = (serviceId) => ({ projectId: P, serviceId, scopes: ['ingest'] });
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const USERS = ['S112009', 'S100001', 'S108742', 'S110355', 'S105210'];
const IPS = ['10.10.112.50', '10.10.112.61', '10.10.113.20', '10.10.120.8', '10.10.130.15'];

const BFF_ROUTES = [
  { path: '/api/it/dashboard/overview', tpl: '/api/it/dashboard/overview', routeCode: 'it.dashboard.overview', upstream: 'itapp-api', ms: [20, 90] },
  { path: '/api/it/dashboard/work', tpl: '/api/it/dashboard/work', routeCode: 'it.dashboard.work', upstream: 'itapp-api', ms: [15, 70] },
  { path: '/api/sample/items', tpl: '/api/sample/items', routeCode: 'sample.item.list', upstream: 'node-sample', ms: [8, 40] },
  { path: '/api/admin/routes', tpl: '/api/admin/routes', ms: [25, 120] },
  { path: '/api/admin/users', tpl: '/api/admin/users', ms: [30, 160] },
  { path: '/api/auth/me', tpl: '/api/auth/me', ms: [3, 15] },
  { path: '/api/admin/roles/12/permissions', tpl: '/api/admin/roles/:id/permissions', ms: [20, 80] },
];

let traceSeq = 0;
function requestPair(at, { fail = false, login = false } = {}) {
  const r = login ? { path: '/api/auth/login', tpl: '/api/auth/login', ms: [80, 250] } : pick(BFF_ROUTES);
  const traceId = `demo${Date.now().toString(36)}${(traceSeq += 1)}`;
  const user = pick(USERS);
  const status = login ? 401 : fail && r.upstream === 'itapp-api' ? 502 : 200;
  const ms = rnd(...r.ms) + (status === 502 ? 900 : 0);
  const bff = {
    ts: at.toISOString(),
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    kind: 'http',
    traceId,
    request: { method: login ? 'POST' : 'GET', path: r.path, pathTemplate: r.tpl, ip: pick(IPS), userId: login ? null : user, body: login ? { username: user, password: '***' } : null, headers: { 'user-agent': 'Mozilla/5.0' } },
    response: { status, durationMs: ms, body: status === 502 ? { code: 'UPSTREAM_ERROR', message: '上游服務錯誤', requestId: traceId } : '{"ok":true}' },
    error: status === 502 ? { name: 'GwError', message: 'UPSTREAM_ERROR:上游服務錯誤(HTTP 500)', stack: '', code: 'UPSTREAM_ERROR' } : null,
    meta: r.routeCode ? { routeCode: r.routeCode, upstream: r.upstream, routeType: 'proxy' } : undefined,
  };
  const logs = { 'gw-bff': [bff] };
  if (r.upstream === 'itapp-api') {
    logs['itapp-api'] = [{
      ts: at.toISOString(),
      level: status >= 500 ? 'error' : 'info',
      kind: 'http',
      traceId,
      request: { method: 'GET', path: r.path, pathTemplate: r.tpl, userId: user, ip: '172.18.0.5' },
      actions: [{ seq: 1, type: 'db', target: 'mssql.it_dashboard', durationMs: Math.round(ms * 0.6), note: 'select', ok: status < 500 }],
      response: { status: status === 502 ? 500 : 200, durationMs: Math.round(ms * 0.8), body: status === 502 ? { code: 'IT_DB_TIMEOUT', message: '資料庫逾時' } : '{"kpis":[]}' },
      error: status === 502 ? { name: 'RequestError', message: 'Timeout: Request failed to complete in 15000ms', stack: 'RequestError: Timeout\n    at Request.userCallback (tedious/lib/request.js:239:18)\n    at loadOverview (src/routes/dashboard.ts:42:11)', code: 'ETIMEOUT' } : null,
    }];
  }
  return logs;
}

async function ingest(byService) {
  for (const [svc, logs] of Object.entries(byService)) await ingestService.ingestBatch(logs, auth(svc));
}

function merge(target, src) {
  for (const [k, v] of Object.entries(src)) (target[k] = target[k] || []).push(...v);
  return target;
}

function trafficMinute(at, { spike = false } = {}) {
  const total = rnd(40, 120) + (spike ? 400 : 0);
  const s5 = rnd(0, 2);
  const s4 = rnd(1, 6) + (spike ? 380 : 0);
  return {
    ts: at.toISOString(),
    total,
    status: { '2xx': total - s4 - s5, '4xx': s4, '5xx': s5 },
    codes: spike ? { 401: 6, 403: 4, 429: 370 } : { 401: rnd(0, 2), 404: rnd(0, 3) },
    bytes: total * rnd(2000, 9000),
    avgMs: rnd(20, 60),
    p95Ms: rnd(120, 400),
    uniqueIps: rnd(5, 25),
    topIps: [
      ...(spike ? [{ ip: '10.10.140.77', count: 420, errors: 0, denied: 380 }] : []),
      ...IPS.map((ip) => ({ ip, count: rnd(5, 30), errors: Math.random() < 0.03 ? 1 : 0, denied: 0 })),
    ],
    topPaths: BFF_ROUTES.slice(0, 5).map((r) => ({ path: r.tpl, count: rnd(5, 30), errors: 0 })),
  };
}

async function seedHistory() {
  const now = Date.now();
  const logs = {};
  // 近 24 小時,每 5 分鐘 3–8 筆;越接近現在越多
  for (let t = now - 24 * 3600e3; t < now - 60e3; t += 5 * 60e3) {
    const n = rnd(3, 8);
    for (let i = 0; i < n; i += 1) merge(logs, requestPair(new Date(t + rnd(0, 290e3)), { fail: Math.random() < 0.01 }));
  }
  // 近 20 分鐘 itapp-api 一段 502、登入失敗
  for (let i = 0; i < 6; i += 1) merge(logs, requestPair(new Date(now - rnd(2, 20) * 60e3), { fail: true }));
  for (let i = 0; i < 4; i += 1) merge(logs, requestPair(new Date(now - rnd(1, 10) * 60e3), { login: true }));
  await ingest(logs);

  const minutes = [];
  for (let t = now - 24 * 3600e3; t < now - 60e3; t += 60e3) minutes.push(trafficMinute(new Date(t), { spike: now - t < 8 * 60e3 && now - t > 5 * 60e3 }));
  for (let i = 0; i < minutes.length; i += 100) await trafficService.ingest(minutes.slice(i, i + 100), auth('gw-nginx'));

  const events = [];
  for (let i = 0; i < 40; i += 1) events.push({ ts: new Date(now - rnd(1, 600) * 60e3).toISOString(), app: 'itapp-web', type: 'view', page: '/it/dashboard' });
  for (const [name, a, b] of [['LCP', 900, 3200], ['FCP', 400, 1500], ['TTFB', 60, 400], ['INP', 40, 320], ['load', 800, 2600]])
    for (let i = 0; i < 12; i += 1) events.push({ ts: new Date(now - rnd(1, 600) * 60e3).toISOString(), app: 'itapp-web', type: 'vital', name, value: rnd(a, b), route: '/dashboard' });
  events.push({ ts: new Date(now - 15 * 60e3).toISOString(), app: 'itapp-web', type: 'vital', name: 'CLS', value: 0.04, route: '/dashboard' });
  events.push({
    ts: new Date(now - 12 * 60e3).toISOString(), app: 'itapp-web', type: 'error', page: '/it/gateway/services/routes', route: '/gateway/services/routes',
    name: 'TypeError', message: "Cannot read properties of undefined (reading 'permissionCode')", stack: 'TypeError: Cannot read properties of undefined\n    at Routes.vue:212:31', userId: 'S112009', ip: '10.10.112.50',
  });
  for (let i = 0; i < events.length; i += 100) await webService.ingest(events.slice(i, i + 100), { projectId: P, scopes: ['ingest-web'] });
}

/** 每 30 秒:幾筆新請求、上一分鐘的 Nginx 彙總、心跳 */
async function tick() {
  const now = new Date();
  const logs = {};
  for (let i = 0; i < rnd(2, 6); i += 1) merge(logs, requestPair(new Date(now.getTime() - rnd(0, 25e3)), { fail: Math.random() < 0.02 }));
  await ingest(logs);
  await trafficService.ingest([trafficMinute(new Date(now.getTime() - 60e3))], auth('gw-nginx'));
  const deps = [{ name: 'sqlserver', ok: true, latencyMs: rnd(2, 8) }, { name: 'redis', ok: true, latencyMs: 1 }];
  await statusService.recordHeartbeat('gw-bff', { version: 'a1b2c3d4', uptimeSec: 86400 * 3, deps });
  await statusService.recordHeartbeat('itapp-api', { version: '0.7.2', uptimeSec: 3600 * 20, deps: [{ name: 'gateway-jwks', ok: true, latencyMs: 4 }] });
  await statusService.recordHeartbeat('gw-nginx', { version: 'a1b2c3d4', uptimeSec: 86400 * 3, deps: [{ name: 'nginx', ok: true, latencyMs: 2 }] });
  await statusService.recordHeartbeat('itapp-web', { source: 'probe' });
  await statusService.recordHeartbeat('portal-web', { source: 'probe' });
  await statusService.recordHeartbeat('observe-api', { version: '1.1.0', uptimeSec: 600 });
  await statusService.recordHeartbeat('gno-mongo', { source: 'probe' });
  await statusService.evaluateAll();
}

module.exports = { seedHistory, tick };
