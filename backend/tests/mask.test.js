/**
 * 敏感欄位遮蔽（對應 ingest.feature 的遮蔽場景）
 */
const { maskDeep, maskHeaders, isSensitiveKey } = require('../src/utils/mask');

describe('敏感欄位遮蔽', () => {
  test.each([
    'password', 'passwd', 'token', 'authorization',
    'apiKey', 'api_key', 'secret', 'credential',
    'PASSWORD', 'Api_Key',
  ])('欄位 %s 應被遮蔽', (field) => {
    const result = maskDeep({ [field]: 'sensitive-value' });
    expect(result[field]).toBe('***');
  });

  test('一般欄位不應被遮蔽', () => {
    const result = maskDeep({ account: 'S112009', title: '太陽能板規格' });
    expect(result.account).toBe('S112009');
    expect(result.title).toBe('太陽能板規格');
  });

  test('巢狀物件中的敏感欄位也要遮蔽', () => {
    const result = maskDeep({ user: { profile: { token: 'eyJhbG' } } });
    expect(result.user.profile.token).toBe('***');
  });

  test('陣列中的敏感欄位也要遮蔽', () => {
    const result = maskDeep({
      accounts: [{ name: 'a', password: 'p1' }, { name: 'b', password: 'p2' }],
    });
    expect(result.accounts[0].password).toBe('***');
    expect(result.accounts[1].password).toBe('***');
    expect(result.accounts[0].name).toBe('a');
  });

  test('額外指定的欄位也要遮蔽', () => {
    const result = maskDeep({ idNumber: 'A123456789' }, ['idNumber']);
    expect(result.idNumber).toBe('***');
  });

  test('深度過深時不應無限遞迴', () => {
    let deep = { value: 'leaf' };
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    expect(() => maskDeep(deep)).not.toThrow();
  });

  test('null 與基本型別原樣返回', () => {
    expect(maskDeep(null)).toBeNull();
    expect(maskDeep('text')).toBe('text');
    expect(maskDeep(42)).toBe(42);
  });

  test('isSensitiveKey 認得連字號寫法', () => {
    expect(isSensitiveKey('api-key')).toBe(true);
    expect(isSensitiveKey('x-request-id')).toBe(false);
  });
});

describe('Headers 白名單', () => {
  test('只保留白名單內的 header', () => {
    const result = maskHeaders({
      'content-type': 'application/json',
      'user-agent': 'curl/8.0',
      authorization: 'Bearer secret',
      cookie: 'session=abc',
      'x-custom': 'value',
    });
    expect(result['content-type']).toBe('application/json');
    expect(result['user-agent']).toBe('curl/8.0');
    expect(result.authorization).toBeUndefined();
    expect(result.cookie).toBeUndefined();
    expect(result['x-custom']).toBeUndefined();
  });

  test('大小寫不同的 header 也要正規化保留', () => {
    const result = maskHeaders({ 'Content-Type': 'text/html' });
    expect(result['content-type']).toBe('text/html');
  });

  test('空值回傳空物件', () => {
    expect(maskHeaders(null)).toEqual({});
    expect(maskHeaders(undefined)).toEqual({});
  });
});

describe('循環參考與 ORM 物件（2026-09-18 生產延遲事故的回歸測試）', () => {
  /** 模擬 Sequelize model：有 toJSON，但直接列舉會碰到內部循環參考 */
  function makeModel(data, associations = {}) {
    const inst = {
      dataValues: { ...data },
      _previousDataValues: { ...data },
      _options: { include: [] },
      ...data,
      ...associations,
      toJSON() { return { ...data, ...associations }; },
    };
    return inst;
  }

  test('有 toJSON 的物件應走 toJSON，不挖出內部結構', () => {
    const model = makeModel({ id: 1, title: '文章' });
    const result = maskDeep(model);
    expect(result).toEqual({ id: 1, title: '文章' });
    expect(result.dataValues).toBeUndefined();
    expect(result._previousDataValues).toBeUndefined();
  });

  test('toJSON 後的內容仍要遮蔽敏感欄位', () => {
    const model = makeModel({ account: 'S112009', password: 'secret' });
    expect(maskDeep(model).password).toBe('***');
  });

  test('Date 轉成字串而非被拆成物件', () => {
    const result = maskDeep({ createdAt: new Date('2026-09-18T00:00:00.000Z') });
    expect(result.createdAt).toBe('2026-09-18T00:00:00.000Z');
  });

  test('直接的循環參考不拋例外且標記為 [circular]', () => {
    const a = { name: 'a' };
    a.self = a;
    const result = maskDeep(a);
    expect(result.name).toBe('a');
    expect(result.self).toBe('[circular]');
  });

  test('互相參照的循環結構不拋例外', () => {
    const parent = { name: 'parent' };
    const child = { name: 'child', parent };
    parent.children = [child];
    expect(() => maskDeep(parent)).not.toThrow();
  });

  test('結果必定可序列化', () => {
    const a = {};
    a.self = a;
    expect(() => JSON.stringify(maskDeep(a))).not.toThrow();
  });

  test('循環結構的處理成本要有上限（事故當時是 3.1 秒）', () => {
    // 重現當時的形狀：一篇文章帶多個互相回指的關聯
    const article = makeModel({ id: 1, title: '太陽能板規格' });
    const tags = [];
    for (let i = 0; i < 12; i += 1) {
      const tag = makeModel({ id: i, name: `標籤${i}` });
      tag.through = { parent: article };
      tag.parent = article;
      tags.push(tag);
    }
    article.Tags = tags;
    for (let i = 0; i < 6; i += 1) {
      const ed = makeModel({ id: i });
      ed.parent = article;
      ed.article = article;
      tags.push(ed);
    }

    const start = Date.now();
    expect(() => maskDeep(article)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(100);
  });

  test('超大結構會被節點預算截斷而非無限吃 CPU', () => {
    const wide = {};
    for (let i = 0; i < 8000; i += 1) wide[`k${i}`] = { nested: { value: i } };

    const start = Date.now();
    const result = maskDeep(wide);
    expect(Date.now() - start).toBeLessThan(500);
    expect(JSON.stringify(result)).toContain('[truncated: too large]');
  });
});
