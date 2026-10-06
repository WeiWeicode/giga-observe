/**
 * GigaNexus 擴充（MONITORING-PLAN §5.4）
 *   - Nginx 流量彙總：驗證、正規化（同一分鐘冪等、Top N 上限、TTL 90 天）
 *   - 資安告警規則
 *   - 錯誤 body 90 天後裁成摘要（D13）
 *   - 前端事件轉成錯誤紀錄
 *   - meta 標籤清理
 *   - 經 Gateway 轉入：X-Internal-Token 取代 API Key
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';

const express = require('express');
const request = require('supertest');
const env = require('../src/config/env');
const trafficService = require('../src/services/trafficService');
const { securityFromTraffic } = require('../src/services/alertService');
const { trimBody } = require('../src/services/retentionService');
const { toErrorLog } = require('../src/services/webService');
const { sanitizeMeta, normalize, validate } = require('../src/services/ingestService');
const { gatewayOrApiKey, requireScope, setGatewayVerifier } = require('../src/middlewares/apiKeyAuth');
const { startOfTpeDay } = require('../src/services/statsService');

const AUTH = { projectId: 'giganexus', serviceId: 'gw-nginx', scopes: ['ingest'] };

describe('部署區隔離（D2）', () => {
  test('資料庫與 Redis 前綴預設帶部署區', () => {
    expect(env.mongoDb).toBe(`giga_observe_${env.observeEnv}`);
    expect(env.redisPrefix).toBe(`gno-${env.observeEnv}`);
    expect(env.port).toBe(51202);
  });
});

describe('Nginx 流量彙總', () => {
  const minute = {
    ts: '2026-10-06T08:15:42.000Z',
    total: 120,
    status: { '2xx': 100, '4xx': 18, '5xx': 2, bogus: 9 },
    codes: { 401: 5, 403: 3, 429: 10, abc: 1 },
    bytes: 50000,
    p95Ms: 230,
    topIps: [{ ip: '10.10.112.50', count: 80, errors: 2 }, { ip: 'not an ip!', count: 1 }],
    topPaths: [{ path: '/api/admin/users', count: 40 }],
  };

  test('缺 total 或 ts 錯誤時拒收', () => {
    expect(trafficService.validate({ ts: 'x', total: 1 })).toMatch(/ts/);
    expect(trafficService.validate({ ts: minute.ts })).toMatch(/total/);
    expect(trafficService.validate(minute)).toBeNull();
  });

  test('對齊到分鐘、_id 冪等、只收合法計數與 IP、TTL 90 天', () => {
    const doc = trafficService.normalize(minute, AUTH);
    expect(doc._id).toBe('gw-nginx:2026-10-06T08:15:00.000Z');
    expect(doc.status).toEqual({ '2xx': 100, '4xx': 18, '5xx': 2 });
    expect(doc.codes).toEqual({ 401: 5, 403: 3, 429: 10 });
    expect(doc.topIps).toHaveLength(1);
    expect(doc.realIp).toBe(true);
    const days = (doc.expireAt - doc.ts) / 86400000;
    expect(days).toBe(env.trafficTtlDays);
  });

  test('Top N 最多 20 筆', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ip: `10.0.0.${i}`, count: 1 }));
    expect(trafficService.normalize({ ...minute, topIps: many }, AUTH).topIps).toHaveLength(20);
  });
});

describe('資安告警', () => {
  const th = { securityPerMin: 30, ipPerMin: 600 };

  test('401 / 403 / 429 一分鐘達門檻 → 拒絕請求突增', () => {
    const items = securityFromTraffic([
      { ts: new Date(), codes: { 401: 2 }, topIps: [] },
      { ts: new Date(), codes: { 401: 10, 403: 10, 429: 15 }, topIps: [] },
    ], th);
    expect(items.map((i) => i.id)).toEqual(['security:denied']);
    expect(items[0].detail).toMatch(/35 次/);
  });

  test('單一 IP 超過門檻 → 列出 IP；未經 PROXY protocol 時註明', () => {
    const items = securityFromTraffic([{ ts: new Date(), codes: {}, realIp: false, topIps: [{ ip: '172.18.0.1', count: 900 }] }], th);
    expect(items[0].ip).toBe('172.18.0.1');
    expect(items[0].detail).toMatch(/PROXY protocol/);
  });

  test('正常流量不產生告警', () => {
    expect(securityFromTraffic([{ ts: new Date(), codes: { 401: 1 }, topIps: [{ ip: '10.0.0.1', count: 50 }] }], th)).toEqual([]);
  });
});

describe('錯誤 body 保存（D13）', () => {
  test('超過 1 KB 的 body 裁成摘要；小 body 不動', () => {
    const big = { data: 'x'.repeat(5000) };
    const r = trimBody(big, 1024);
    expect(r.changed).toBe(true);
    expect(typeof r.body).toBe('string');
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(1024);
    expect(trimBody({ a: 1 }, 1024)).toEqual({ body: { a: 1 }, changed: false });
    expect(trimBody(null, 1024).changed).toBe(false);
  });
});

describe('前端事件', () => {
  test('JS 錯誤轉成 kind web 的錯誤紀錄，通過 ingest 驗證', () => {
    const log = toErrorLog({ ts: '2026-10-06T08:00:00Z', app: 'itapp-web', type: 'error', page: '/it/gateway/routes', route: '/gateway/routes', name: 'TypeError', message: 'x is undefined', stack: 'at y', userId: 'S112009' });
    expect(validate(log)).toBeNull();
    const { doc, isError } = normalize(log, { projectId: 'giganexus', serviceId: 'itapp-web' });
    expect(isError).toBe(true);
    expect(doc.kind).toBe('web');
    expect(doc.request.pathTemplate).toBe('/gateway/routes');
    expect(doc.error.name).toBe('TypeError');
    expect(doc.meta.page).toBe('/it/gateway/routes');
  });

  test('API 失敗帶 requestId → traceId，可對到後端紀錄；匿名事件不記使用者', () => {
    const log = toErrorLog({ ts: '2026-10-06T08:00:00Z', app: 'itapp-web', type: 'api', method: 'post', url: '/api/admin/roles', status: 502, requestId: 'req-1', message: 'Bad Gateway', userId: 'S1', anonymous: true });
    const { doc } = normalize(log, { projectId: 'giganexus', serviceId: 'itapp-web' });
    expect(doc.traceId).toBe('req-1');
    expect(doc.request.method).toBe('POST');
    expect(doc.response.status).toBe(502);
    expect(doc.request.userId).toBeNull();
  });
});

describe('meta 標籤', () => {
  test('只留平面的字串 / 數字 / 布林，最多 20 個', () => {
    expect(sanitizeMeta({ routeCode: 'it.dashboard.read', upstream: 'itapp-api', n: 1, ok: true, obj: { a: 1 }, 'bad key!': 'x' }))
      .toEqual({ routeCode: 'it.dashboard.read', upstream: 'itapp-api', n: 1, ok: true });
    expect(sanitizeMeta('x')).toBeUndefined();
    expect(Object.keys(sanitizeMeta(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))))).toHaveLength(20);
  });
});

describe('經 Gateway 轉入（X-Internal-Token）', () => {
  const app = express();
  app.get('/q', gatewayOrApiKey(), requireScope('read'), (req, res) => res.json({ via: req.auth.viaGateway, emp: req.auth.user.emp }));

  afterAll(() => setGatewayVerifier(null));

  test('Token 有效 → 只給 read，帶使用者', async () => {
    setGatewayVerifier(async (t) => {
      if (t !== 'good') throw new Error('bad');
      return { sub: 'u1', emp: 'S112009', name: '蔣佳緯' };
    });
    const res = await request(app).get('/q').set('X-Internal-Token', 'good');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ via: true, emp: 'S112009' });
  });

  test('Token 無效 → 401 INVALID_INTERNAL_TOKEN', async () => {
    const res = await request(app).get('/q').set('X-Internal-Token', 'forged');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_INTERNAL_TOKEN');
  });
});

describe('台灣時間日界線', () => {
  test('UTC 2026-10-06 17:00（台灣 10/7 01:00）→ 台灣 10/7 00:00 = UTC 10/6 16:00', () => {
    expect(startOfTpeDay(new Date('2026-10-06T17:00:00Z')).toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(startOfTpeDay(new Date('2026-10-06T08:00:00Z')).toISOString()).toBe('2026-10-05T16:00:00.000Z');
  });
});
