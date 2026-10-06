/**
 * Pull 探測：HTTP 與內建檢查兩條路徑
 * 對應 heartbeat.feature 的探測場景
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';

jest.mock('../src/services/statusService', () => ({
  recordHeartbeat: jest.fn().mockResolvedValue(undefined),
  recordProbeFailure: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/config/mongo', () => ({
  ping: jest.fn(),
  isConnected: () => true,
  col: jest.fn(),
}));

jest.mock('../src/config/redis', () => ({
  ping: jest.fn(),
  isConnected: () => true,
  keys: {},
}));

const statusService = require('../src/services/statusService');
const mongo = require('../src/config/mongo');
const redis = require('../src/config/redis');
const proberService = require('../src/services/proberService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('內建檢查（dvd-mongo / dvd-redis 沒有 HTTP 端點）', () => {
  const mongoSvc = { id: 'dvd-mongo', monitor: { enabled: true, type: 'internal', check: 'mongo' } };
  const redisSvc = { id: 'dvd-redis', monitor: { enabled: true, type: 'internal', check: 'redis' } };

  test('Mongo 連線正常時記錄為探測成功', async () => {
    mongo.ping.mockResolvedValue({ ok: true, latencyMs: 3 });

    const result = await proberService.probeInternal(mongoSvc);

    expect(result).toBe(true);
    expect(statusService.recordHeartbeat).toHaveBeenCalledWith(
      'dvd-mongo',
      expect.objectContaining({ source: 'probe' })
    );
    expect(statusService.recordProbeFailure).not.toHaveBeenCalled();
  });

  test('探測成功時帶上連線延遲', async () => {
    mongo.ping.mockResolvedValue({ ok: true, latencyMs: 42 });

    await proberService.probeInternal(mongoSvc);

    const payload = statusService.recordHeartbeat.mock.calls[0][1];
    expect(payload.deps).toEqual([{ name: 'mongo', ok: true, latencyMs: 42 }]);
  });

  test('Mongo 連線失敗時記錄為探測失敗', async () => {
    mongo.ping.mockResolvedValue({ ok: false, latencyMs: null, error: 'ECONNREFUSED' });

    const result = await proberService.probeInternal(mongoSvc);

    expect(result).toBe(false);
    expect(statusService.recordProbeFailure).toHaveBeenCalledWith('dvd-mongo');
    expect(statusService.recordHeartbeat).not.toHaveBeenCalled();
  });

  test('Redis 走的是 redis 的 ping 而非 mongo 的', async () => {
    redis.ping.mockResolvedValue({ ok: true, latencyMs: 1 });

    await proberService.probeInternal(redisSvc);

    expect(redis.ping).toHaveBeenCalled();
    expect(mongo.ping).not.toHaveBeenCalled();
  });

  test('ping 拋例外時視為探測失敗而非讓探測迴圈崩潰', async () => {
    mongo.ping.mockRejectedValue(new Error('boom'));

    const result = await proberService.probeInternal(mongoSvc);

    expect(result).toBe(false);
    expect(statusService.recordProbeFailure).toHaveBeenCalledWith('dvd-mongo');
  });

  test('未知的 check 名稱只警告不崩潰', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bogus = { id: 'x', monitor: { enabled: true, type: 'internal', check: 'not-exist' } };

    const result = await proberService.probeInternal(bogus);

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('支援的內建檢查只有 mongo 與 redis', () => {
    expect(Object.keys(proberService.INTERNAL_CHECKS).sort()).toEqual(['mongo', 'redis']);
  });
});
