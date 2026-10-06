/**
 * 錯誤分流與 body 保存規則
 * 對應 ingest.feature 的分流、TTL、body 場景，以及 PRD D-04 / D-05
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';

const { isError, normalize, validate } = require('../src/services/ingestService');
const { processBody } = require('../src/utils/truncate');
const env = require('../src/config/env');

const AUTH = { projectId: 'devops', serviceId: 'gigaks-backend', scopes: ['ingest'] };

function makeLog(overrides = {}) {
  return {
    ts: '2026-09-18T08:00:00.000Z',
    level: 'info',
    request: { method: 'GET', path: '/api/v1/test' },
    response: { status: 200, durationMs: 10 },
    ...overrides,
  };
}

describe('欄位驗證', () => {
  test('完整紀錄通過驗證', () => {
    expect(validate(makeLog())).toBeNull();
  });

  test.each([
    ['ts', { ts: undefined }],
    ['level', { level: undefined }],
  ])('缺少 %s 應被拒絕', (_name, override) => {
    expect(validate(makeLog(override))).not.toBeNull();
  });

  test('缺少 response.status 應被拒絕', () => {
    expect(validate(makeLog({ response: { durationMs: 10 } }))).toMatch(/response.status/);
  });

  test('ts 格式錯誤應被拒絕', () => {
    expect(validate(makeLog({ ts: 'not-a-date' }))).toMatch(/ts/);
  });
});

describe('錯誤分流（D-04）', () => {
  test.each([
    [200, 'info', false],
    [201, 'info', false],
    [304, 'info', false],
    [400, 'warn', false],
    [401, 'warn', false],
    [404, 'warn', false],
    [500, 'error', true],
    [502, 'error', true],
    [503, 'error', true],
    [200, 'error', true],   // HTTP 200 但服務自報 error
  ])('status %i + level %s → 錯誤=%s', (status, level, expected) => {
    const log = makeLog({ level, response: { status, durationMs: 10 } });
    expect(isError(log)).toBe(expected);
  });
});

describe('TTL 設定', () => {
  test('一般紀錄設 7 天後到期', () => {
    const { doc } = normalize(makeLog(), AUTH);
    expect(doc.expireAt).toBeDefined();
    const days = (doc.expireAt - doc.ts) / 86400000;
    expect(days).toBe(env.logTtlDays);
  });

  test('錯誤紀錄不設到期時間', () => {
    const log = makeLog({ level: 'error', response: { status: 500, durationMs: 10 } });
    const { doc } = normalize(log, AUTH);
    expect(doc.expireAt).toBeUndefined();
  });
});

describe('serviceId 防偽（US-06）', () => {
  test('client 自報的 serviceId 一律被忽略', () => {
    const log = makeLog({ serviceId: 'bpm-backend', projectId: 'other' });
    const { doc } = normalize(log, AUTH);
    expect(doc.serviceId).toBe('gigaks-backend');
    expect(doc.projectId).toBe('devops');
  });
});

describe('body 保存規則（D-05）', () => {
  test('成功請求的大 body 只留摘要', () => {
    const big = 'x'.repeat(5000);
    const result = processBody(big, false);
    expect(Buffer.byteLength(result.body)).toBe(env.bodySummaryBytes);
    expect(result.bodySize).toBe(5000);
    expect(result.bodyTruncated).toBe(true);
  });

  test('成功請求的小 body 完整保留', () => {
    const small = { title: 'hello' };
    const result = processBody(small, false);
    expect(result.body).toEqual(small);
    expect(result.bodyTruncated).toBe(false);
  });

  test('錯誤請求保留完整 body', () => {
    const body = 'y'.repeat(20000);
    const result = processBody(body, true);
    expect(result.body.length).toBe(20000);
    expect(result.bodyTruncated).toBe(false);
  });

  test('錯誤請求的超大 body 於上限截斷', () => {
    const body = 'z'.repeat(50000);
    const result = processBody(body, true);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(env.bodyMaxBytes);
    expect(result.bodySize).toBe(50000);
    expect(result.bodyTruncated).toBe(true);
  });

  test('截斷不應切壞多位元組字元', () => {
    const body = '太'.repeat(2000); // 每字 3 bytes
    const result = processBody(body, false);
    expect(result.body).not.toMatch(/�/);
  });

  test('null body 不報錯', () => {
    expect(processBody(null, false)).toEqual({ body: null, bodySize: 0, bodyTruncated: false });
  });
});

describe('正規化其他欄位', () => {
  test('actions 依 seq 排序並補上預設值', () => {
    const log = makeLog({
      actions: [
        { seq: 2, type: 'http', target: 'api' },
        { seq: 1, type: 'db', target: 'mssql', ok: false },
      ],
    });
    const { doc } = normalize(log, AUTH);
    expect(doc.actions[0].seq).toBe(1);
    expect(doc.actions[0].ok).toBe(false);
    expect(doc.actions[1].ok).toBe(true);
  });

  test('未提供 pathTemplate 時退回 path', () => {
    const { doc } = normalize(makeLog(), AUTH);
    expect(doc.request.pathTemplate).toBe('/api/v1/test');
  });

  test('kind 只接受 http 或 job', () => {
    expect(normalize(makeLog({ kind: 'job' }), AUTH).doc.kind).toBe('job');
    expect(normalize(makeLog({ kind: 'weird' }), AUTH).doc.kind).toBe('http');
  });

  test('記錄平台收到時間以便偵測時鐘偏移', () => {
    const { doc } = normalize(makeLog(), AUTH);
    expect(doc.receivedAt).toBeInstanceOf(Date);
    expect(doc.ts.toISOString()).toBe('2026-09-18T08:00:00.000Z');
  });
});
