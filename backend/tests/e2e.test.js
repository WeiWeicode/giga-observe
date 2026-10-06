/**
 * 端對端（記憶體 MongoDB，不需 Redis）：Ingest → Query，涵蓋 GigaNexus 擴充
 *   BFF 紀錄（meta.upstream）→ 今日統計、上游健康、traceId 查詢
 *   Nginx 彙總 → 流量時序、來源 IP、資安告警
 *   前端事件 → 錯誤紀錄（kind web）、效能 p75；未登錄前端拒收；scope 隔離
 *   Gateway Token → 查詢；/openapi.json
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.setTimeout(120000);

let mongod;
let app;
let mongo;
let keys;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.OBSERVE_ENV = 'test';
  process.env.ALERT_SECURITY_PER_MIN = '30';
  mongo = require('../src/config/mongo');
  await mongo.connect();
  await require('../src/scripts/initIndexes').initIndexes();
  await require('../src/services/topologyService').load();
  ({ app } = require('../src/index'));
  const apiKeyService = require('../src/services/apiKeyService');
  const mk = (serviceId, scopes) => apiKeyService.createKey({ projectId: 'giganexus', serviceId, scopes }).then((r) => r.key);
  keys = {
    bff: await mk('gw-bff', ['ingest']),
    nginx: await mk('gw-nginx', ['ingest']),
    web: await mk('gw-bff-web', ['ingest-web']),
    read: await mk(null, ['read']),
  };
});

afterAll(async () => {
  require('../src/middlewares/apiKeyAuth').setGatewayVerifier(null);
  await mongo.close();
  await mongod.stop();
});

const request = () => require('supertest')(app);
const now = () => new Date().toISOString();

function bffLog(status, upstream, durationMs, traceId) {
  return {
    ts: now(), level: status >= 500 ? 'error' : 'info', kind: 'http', traceId,
    request: { method: 'GET', path: '/api/it/dashboard', pathTemplate: '/api/it/dashboard', userId: 'S112009', body: null },
    response: { status, durationMs, body: '{"ok":true}' },
    meta: { routeCode: 'it.dashboard.read', upstream },
  };
}

test('隔離：資料庫名稱帶部署區', () => {
  expect(require('../src/config/env').mongoDb).toBe('giga_observe_test');
});

test('BFF 紀錄 → 今日統計、上游健康、traceId 查詢', async () => {
  const logs = [
    ...Array.from({ length: 18 }, (_, i) => bffLog(200, 'itapp-api', 20 + i)),
    bffLog(502, 'itapp-api', 900, 'req-err-1'),
    bffLog(200, 'node-sample', 40),
  ];
  const r = await request().post('/api/v1/ingest/logs').set('X-API-Key', keys.bff).send({ logs });
  expect(r.status).toBe(202);
  expect(r.body.data.accepted).toBe(20);

  const today = await request().get('/api/v1/stats/today').set('X-API-Key', keys.read);
  expect(today.status).toBe(200);
  expect(today.body.data.today.total).toBe(20);
  expect(today.body.data.today.errors).toBe(1);
  expect(today.body.data.today.availability).toBe(0.95);
  expect(today.body.data.hourly.reduce((s, h) => s + h.total, 0)).toBe(20);

  const ups = await request().get('/api/v1/stats/upstreams').set('X-API-Key', keys.read);
  const itapp = ups.body.data.find((u) => u.upstream === 'itapp-api');
  expect(itapp.total).toBe(19);
  expect(itapp.errors).toBe(1);
  expect(itapp.p95Ms).toBeGreaterThanOrEqual(37);

  const byTrace = await request().get('/api/v1/logs').query({ traceId: 'req-err-1', from: new Date(Date.now() - 3600e3).toISOString() }).set('X-API-Key', keys.read);
  expect(byTrace.body.data).toHaveLength(1);
  expect(byTrace.body.data[0].meta.upstream).toBe('itapp-api');
});

test('Nginx 彙總 → 流量時序、來源 IP、資安告警；重送同一分鐘不重複', async () => {
  const minute = {
    ts: now(), total: 300, status: { '2xx': 250, '4xx': 50 }, codes: { 401: 10, 403: 5, 429: 25 },
    bytes: 1e6, p95Ms: 120, topIps: [{ ip: '10.10.112.50', count: 280, errors: 40, denied: 35 }], topPaths: [{ path: '/api/auth/login', count: 60 }],
  };
  for (let i = 0; i < 2; i += 1) {
    const r = await request().post('/api/v1/ingest/traffic').set('X-API-Key', keys.nginx).send({ minutes: [minute] });
    expect(r.status).toBe(202);
  }
  const series = await request().get('/api/v1/traffic').query({ bucket: 'minute' }).set('X-API-Key', keys.read);
  expect(series.body.data).toHaveLength(1);
  expect(series.body.data[0].total).toBe(300);
  expect(series.body.data[0].rateLimited).toBe(25);

  const ips = await request().get('/api/v1/traffic/top-ips').set('X-API-Key', keys.read);
  expect(ips.body.data[0]).toMatchObject({ ip: '10.10.112.50', count: 280 });

  const alerts = await request().get('/api/v1/alerts').set('X-API-Key', keys.read);
  expect(alerts.body.data.items.map((a) => a.id)).toContain('security:denied');
  expect(alerts.body.data.counts.security).toBeGreaterThanOrEqual(1);
});

test('前端事件 → 錯誤紀錄與效能；未登錄前端拒收', async () => {
  const events = [
    { ts: now(), app: 'itapp-web', type: 'error', page: '/it/gateway/routes', route: '/gateway/routes', name: 'TypeError', message: 'x is undefined', userId: 'S112009' },
    { ts: now(), app: 'itapp-web', type: 'vital', name: 'LCP', value: 1800, rating: 'good', route: '/' },
    { ts: now(), app: 'itapp-web', type: 'vital', name: 'LCP', value: 2600, rating: 'needs-improvement', route: '/' },
    { ts: now(), app: 'itapp-web', type: 'view', page: '/it/' },
    { ts: now(), app: 'evil-web', type: 'error', message: 'x' },
  ];
  const r = await request().post('/api/v1/ingest/web-events').set('X-API-Key', keys.web).send({ events });
  expect(r.status).toBe(202);
  expect(r.body.data.accepted).toBe(4);
  expect(r.body.data.rejected).toBe(1);

  const errs = await request().get('/api/v1/logs').query({ serviceId: 'itapp-web', kind: 'web', from: new Date(Date.now() - 3600e3).toISOString() }).set('X-API-Key', keys.read);
  expect(errs.body.data[0].errorMessage).toMatch(/TypeError/);

  const vitals = await request().get('/api/v1/web/vitals').set('X-API-Key', keys.read);
  expect(vitals.body.data.find((v) => v.name === 'LCP')).toMatchObject({ serviceId: 'itapp-web', count: 2 });
});

test('scope 隔離：ingest Key 不能送前端事件、不能查詢', async () => {
  expect((await request().post('/api/v1/ingest/web-events').set('X-API-Key', keys.bff).send({ events: [] })).status).toBe(403);
  expect((await request().get('/api/v1/alerts').set('X-API-Key', keys.bff)).status).toBe(403);
  expect((await request().post('/api/v1/ingest/logs').set('X-API-Key', keys.web).send({ logs: [] })).status).toBe(403);
});

test('Gateway Token 查詢（BFF 轉入），明細含 body', async () => {
  require('../src/middlewares/apiKeyAuth').setGatewayVerifier(async (t) => {
    if (t !== 'token-from-bff') throw new Error('bad');
    return { sub: 'u1', emp: 'S112009' };
  });
  const list = await request().get('/api/v1/logs').query({ traceId: 'req-err-1', from: new Date(Date.now() - 3600e3).toISOString() }).set('X-Internal-Token', 'token-from-bff');
  expect(list.status).toBe(200);
  const detail = await request().get(`/api/v1/logs/${list.body.data[0].id}`).set('X-Internal-Token', 'token-from-bff');
  expect(detail.status).toBe(200);
  expect(detail.body.data.response.body).toBe('{"ok":true}');
  expect((await request().get('/api/v1/alerts').set('X-Internal-Token', 'forged')).status).toBe(401);
});

test('/openapi.json 免認證，13 條查詢路由', async () => {
  const r = await request().get('/openapi.json');
  expect(r.status).toBe(200);
  expect(r.body['x-gateway'].system).toBe('observe');
  expect(Object.keys(r.body.paths)).toHaveLength(13);
});
