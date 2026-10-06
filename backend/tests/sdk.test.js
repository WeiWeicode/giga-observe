/**
 * SDK 故障安全（對應 sdk-failsafe.feature）
 * SDK 跑在別人的正式環境裡，這裡驗的是「絕不影響原服務」
 */
const { Reporter, maskDeep, prepareBody, reporter, reportJob, getReporter } = require('../sdk');

const BASE = {
  endpoint: 'http://localhost:9999',
  apiKey: 'dvd_devops_test_xxx',
  serviceId: 'test-service',
  heartbeatSec: 0,        // 測試中關掉心跳排程
  flushIntervalMs: 999999, // 不要自動送出
};

describe('設定與停用', () => {
  test('未設定 apiKey 時自動停用', () => {
    const r = new Reporter({ ...BASE, apiKey: undefined });
    expect(r.cfg.enabled).toBe(false);
  });

  test('未設定 serviceId 時自動停用', () => {
    const r = new Reporter({ ...BASE, serviceId: undefined });
    expect(r.cfg.enabled).toBe(false);
  });

  test('明確停用時 middleware 不掛任何東西', () => {
    const mw = reporter({ ...BASE, enabled: false });
    const req = { path: '/api/test' };
    const next = jest.fn();
    mw(req, {}, next);
    expect(next).toHaveBeenCalled();
    expect(req.devops).toBeUndefined();
  });
});

describe('緩衝行為', () => {
  test('超過上限時丟棄最舊的紀錄', () => {
    const r = new Reporter({ ...BASE, bufferSize: 5, batchSize: 999 });
    for (let i = 0; i < 8; i += 1) r.push({ seq: i });
    expect(r.buffer.length).toBe(5);
    expect(r.buffer[0].seq).toBe(3);     // 最舊的 0,1,2 已被丟棄
    expect(r.buffer[4].seq).toBe(7);
  });

  test('緩衝滿時印出警告但不拋例外', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new Reporter({ ...BASE, bufferSize: 2, batchSize: 999 });
    expect(() => { for (let i = 0; i < 5; i += 1) r.push({ seq: i }); }).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('停用狀態下 push 不累積', () => {
    const r = new Reporter({ ...BASE, apiKey: undefined });
    r.push({ seq: 1 });
    expect(r.buffer.length).toBe(0);
  });
});

describe('送出失敗處理', () => {
  test('平台不可用時紀錄保留在緩衝等重送', async () => {
    const r = new Reporter({ ...BASE, batchSize: 10 });
    r.post = jest.fn().mockResolvedValue(false);   // 模擬送出失敗
    for (let i = 0; i < 3; i += 1) r.push({ seq: i });

    await r.flush();
    expect(r.buffer.length).toBe(3);               // 原樣保留
  });

  test('送出成功後緩衝清空', async () => {
    const r = new Reporter({ ...BASE, batchSize: 10 });
    r.post = jest.fn().mockResolvedValue(true);
    for (let i = 0; i < 3; i += 1) r.push({ seq: i });

    await r.flush();
    expect(r.buffer.length).toBe(0);
  });

  test('重送時緩衝不會超過上限', async () => {
    const r = new Reporter({ ...BASE, batchSize: 2, bufferSize: 4 });
    r.post = jest.fn().mockResolvedValue(false);
    for (let i = 0; i < 4; i += 1) r.push({ seq: i });

    await r.flush();
    expect(r.buffer.length).toBeLessThanOrEqual(4);
  });

  test('flush 對空緩衝不發請求', async () => {
    const r = new Reporter({ ...BASE });
    r.post = jest.fn();
    await r.flush();
    expect(r.post).not.toHaveBeenCalled();
  });
});

describe('middleware 行為', () => {
  function fakeReqRes(overrides = {}) {
    const listeners = {};
    const req = {
      method: 'GET',
      path: '/api/v1/articles',
      originalUrl: '/api/v1/articles?draft=1',
      baseUrl: '/api/v1/articles',
      route: { path: '/' },
      query: {},
      body: {},
      headers: { 'content-type': 'application/json' },
      ip: '10.10.112.50',
      get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : undefined),
      ...overrides,
    };
    const res = {
      statusCode: 200,
      json: (b) => b,
      get: () => 'application/json',
      on: (evt, cb) => { listeners[evt] = cb; },
    };
    return { req, res, fire: () => listeners.finish && listeners.finish() };
  }

  test('排除的路徑不產生紀錄', () => {
    const mw = reporter({ ...BASE, ignorePaths: ['/health'] });
    const { req, res } = fakeReqRes({ path: '/health' });
    const next = jest.fn();
    mw(req, res, next);
    expect(req.devops).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  test('req.devops.action 記錄執行動作', () => {
    const mw = reporter({ ...BASE });
    const { req, res } = fakeReqRes();
    mw(req, res, () => {});
    req.devops.action('db', 'mssql.articles', 12, 'insert');
    req.devops.failedAction('http', 'qdrant', 340, 'sync');
    expect(() => req.devops.error(new Error('boom'), '同步失敗')).not.toThrow();
  });

  test('組裝紀錄時發生例外不往外拋', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mw = reporter({ ...BASE });
    // 刻意讓 req.get 爆掉，模擬「組裝過程出任何意外」
    const { req, res, fire } = fakeReqRes({
      get: () => { throw new Error('模擬的意外'); },
    });
    mw(req, res, () => {});
    expect(() => fire()).not.toThrow();
    warn.mockRestore();
  });

  test('body 是循環結構時仍能產生紀錄（不是靜默丟棄）', () => {
    const mw = reporter({ ...BASE });
    const inst = getReporter();
    inst.buffer.length = 0;

    const circular = { name: 'x' };
    circular.self = circular;
    const { req, res, fire } = fakeReqRes({ body: circular });

    mw(req, res, () => {});
    fire();

    expect(inst.buffer).toHaveLength(1);
    expect(inst.buffer[0].request.body.self).toBe('[circular]');
  });
});

describe('排程回報 reportJob（DAS 用）', () => {
  function setupReporter() {
    // reportJob 用的是 reporter() 建立的 singleton
    reporter({ ...BASE });
    const rep = getReporter();
    rep.buffer.length = 0;
    rep.post = jest.fn().mockResolvedValue(true);
    return rep;
  }

  test('成功執行產生一筆 job 紀錄', async () => {
    const rep = setupReporter();
    const job = reportJob({ name: 'contractExpiryNotify', trigger: 'cron', cronExpr: '0 9 15,28 * *' });
    job.action('db', 'mssql.contracts', 320, '找到 12 筆');
    await job.success({ processed: 12 });

    const sentBatch = rep.post.mock.calls[0][1].logs;
    expect(sentBatch).toHaveLength(1);

    const log = sentBatch[0];
    expect(log.kind).toBe('job');
    expect(log.level).toBe('info');
    expect(log.request.method).toBe('JOB');
    expect(log.request.path).toBe('contractExpiryNotify');
    expect(log.request.pathTemplate).toBe('contractExpiryNotify');
    expect(log.request.body.trigger).toBe('cron');
    expect(log.request.body.cronExpr).toBe('0 9 15,28 * *');
    expect(log.response.status).toBe(200);
    expect(log.response.body).toEqual({ processed: 12 });
    expect(log.actions).toHaveLength(1);
    expect(log.error).toBeNull();
  });

  test('失敗執行標記為 error 並帶上例外內容', async () => {
    const rep = setupReporter();
    const job = reportJob({ name: 'contractExpiryNotify', trigger: 'cron' });
    await job.fail(new Error('SMTP 連線逾時'), { processed: 0 });

    const log = rep.post.mock.calls[0][1].logs[0];
    expect(log.level).toBe('error');
    expect(log.response.status).toBe(500);
    expect(log.error.message).toBe('SMTP 連線逾時');
    expect(log.error.name).toBe('Error');
  });

  test('手動觸發與排程觸發要能區分', async () => {
    const rep = setupReporter();
    await reportJob({ name: 'j', trigger: 'manual' }).success({});
    expect(rep.post.mock.calls[0][1].logs[0].request.body.trigger).toBe('manual');
  });

  test('記錄執行時間', async () => {
    const rep = setupReporter();
    const job = reportJob({ name: 'j', trigger: 'cron' });
    await new Promise((r) => setTimeout(r, 30));
    await job.success({});

    const log = rep.post.mock.calls[0][1].logs[0];
    expect(log.response.durationMs).toBeGreaterThanOrEqual(25);
  });

  test('SDK 停用時呼叫 reportJob 不拋例外', async () => {
    reporter({ ...BASE, apiKey: undefined });
    const job = reportJob({ name: 'j', trigger: 'cron' });
    job.action('db', 'x', 1, 'y');
    await expect(job.success({})).resolves.toBeUndefined();
    await expect(job.fail(new Error('boom'))).resolves.toBeUndefined();
  });
});

describe('body 處理', () => {
  test('multipart 不記錄檔案內容', () => {
    const result = prepareBody({ file: 'binary…' }, false,
      { bodySummaryBytes: 1024, bodyMaxBytes: 32768 }, 'multipart/form-data; boundary=x');
    expect(result.body).toBe('[multipart]');
  });

  test('SDK 端遮蔽與平台端一致', () => {
    const result = maskDeep({ password: 'x', nested: { token: 'y' } }, []);
    expect(result.password).toBe('***');
    expect(result.nested.token).toBe('***');
  });
});

describe('SDK 端的循環參考防護（同 mask.test.js 的事故回歸）', () => {
  function makeModel(data, associations = {}) {
    return {
      dataValues: { ...data },
      _previousDataValues: { ...data },
      ...data,
      ...associations,
      toJSON() { return { ...data, ...associations }; },
    };
  }

  const CFG = { bodySummaryBytes: 1024, bodyMaxBytes: 32768 };

  test('Sequelize 式物件走 toJSON 不挖出內部結構', () => {
    const result = maskDeep(makeModel({ id: 1, title: '文章' }), []);
    expect(result).toEqual({ id: 1, title: '文章' });
    expect(result.dataValues).toBeUndefined();
  });

  test('循環參考不拋例外', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(() => maskDeep(a, [])).not.toThrow();
    expect(maskDeep(a, []).self).toBe('[circular]');
  });

  test('重現事故形狀時成本要有上限', () => {
    const article = makeModel({ id: 1, title: '太陽能板規格' });
    const tags = [];
    for (let i = 0; i < 12; i += 1) {
      const tag = makeModel({ id: i });
      tag.through = { parent: article };
      tag.parent = article;
      tags.push(tag);
    }
    article.Tags = tags;

    const start = Date.now();
    const masked = maskDeep(article, []);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(() => JSON.stringify(masked)).not.toThrow();
  });

  test('prepareBody 對無法序列化的值不拋例外', () => {
    const a = {};
    a.self = a;   // 未經 maskDeep 處理的原始循環結構
    const result = prepareBody(a, false, CFG, 'application/json');
    expect(result.body).toBe('[unserializable]');
    expect(result.bodyTruncated).toBe(false);
  });

  test('回應是 ORM 實例時走 toJSON，紀錄仍要產生', () => {
    const mw = reporter({ ...BASE });
    const inst = getReporter();
    inst.buffer.length = 0;

    const listeners = {};
    const article = makeModel({ id: 1, title: '太陽能板規格' });
    const tag = makeModel({ id: 9, name: '標籤' });
    tag.parent = article;            // 回指，直接列舉會循環
    article.Tags = [tag];

    const req = {
      method: 'GET', path: '/api/v1/articles/1',
      originalUrl: '/api/v1/articles/1', baseUrl: '/api/v1/articles',
      route: { path: '/:id' }, query: {}, body: {}, headers: {}, ip: '10.0.0.1',
      get: () => 'application/json',
    };
    const res = {
      statusCode: 200,
      json: (b) => b,
      get: () => 'application/json',
      on: (evt, cb) => { listeners[evt] = cb; },
    };

    mw(req, res, () => {});
    res.json({ success: true, data: article });
    expect(() => listeners.finish()).not.toThrow();

    expect(inst.buffer).toHaveLength(1);
    expect(inst.buffer[0].request.path).toBe('/api/v1/articles/1');
    expect(inst.buffer[0].response.status).toBe(200);
    // body 要是 toJSON 後的乾淨資料，不能含 Sequelize 內部欄位
    expect(JSON.stringify(inst.buffer[0].response.body)).not.toContain('_previousDataValues');
  });
});
