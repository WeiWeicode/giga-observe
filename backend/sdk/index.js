/**
 * devops-reporter — DevOpsDiagram 回報 SDK
 *
 * 設計鐵則（AGENT.md §9.5）：
 *   1. 非同步：紀錄進記憶體佇列，不在請求路徑上等待網路
 *   2. 1 秒逾時：平台慢不能拖慢原服務
 *   3. 失敗進緩衝：送不出去保留重送，滿了丟最舊並 console.warn
 *
 * 這是全專案唯一允許靜默失敗的地方 —— 它跑在別人的正式環境裡。
 * 無外部相依，只用 Node 內建模組，可整個資料夾複製進任何專案。
 */

const DEFAULTS = {
  flushIntervalMs: 5000,
  batchSize: 50,
  bufferSize: 500,
  timeoutMs: 1000,
  heartbeatSec: 30,
  ignorePaths: ['/health', '/favicon.ico'],
  errorOnly: false,
  sampleRate: 1,
  maskFields: [],
  bodySummaryBytes: 1024,
  bodyMaxBytes: 32768,
  enabled: true,
  version: null,
  deps: null,
};

const SENSITIVE = [
  'password', 'passwd', 'token', 'authorization',
  'apikey', 'api_key', 'secret', 'credential',
];
const HEADER_ALLOWLIST = ['content-type', 'user-agent', 'referer', 'x-request-id'];

// ── 遮蔽與截斷 ──────────────────────────────────────────

function isSensitiveKey(key, extra) {
  const lower = String(key).toLowerCase().replace(/[-_]/g, '');
  if (SENSITIVE.some((p) => lower.includes(p.replace(/_/g, '')))) return true;
  return extra.some((f) => String(f).toLowerCase() === String(key).toLowerCase());
}

// 單次處理的節點上限 —— 無論結構多離譜，成本都有天花板
const MAX_NODES = 5000;

/**
 * 遞迴遮蔽敏感欄位
 *
 * 三道保護，缺一不可（都是踩過才加的）：
 *  1. 先呼叫 toJSON() —— ORM 的 model 實例（Sequelize 等）直接列舉屬性會挖出
 *     dataValues、_previousDataValues 與關聯的循環參考，那些是 res.json 永遠
 *     看不到的內部結構。少了這道，一篇帶 10 個關聯的文章要跑 1.6 秒。
 *  2. 循環參考偵測 —— 沒有它，同一批物件會被不同路徑重複走訪，成本呈指數成長。
 *  3. 節點預算 —— 就算結構不循環但極深極寬，也不能無上限地吃 CPU。
 */
function maskDeep(value, extra, depth = 0, ctx = null) {
  const c = ctx || { seen: new WeakSet(), nodes: 0 };

  if (depth > 12 || value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (c.nodes++ > MAX_NODES) return '[truncated: too large]';

  // 有 toJSON 的先轉成純資料（Sequelize model、Date、Mongoose document…）
  if (typeof value.toJSON === 'function') {
    try {
      value = value.toJSON();
    } catch {
      return '[unserializable]';
    }
    if (value === null || typeof value !== 'object') return value;  // Date → 字串
  }

  if (c.seen.has(value)) return '[circular]';
  c.seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => maskDeep(v, extra, depth + 1, c));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k, extra) ? '***' : maskDeep(v, extra, depth + 1, c);
  }
  return out;
}

function pickHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (HEADER_ALLOWLIST.includes(String(k).toLowerCase())) out[String(k).toLowerCase()] = v;
  }
  return out;
}

/**
 * 安全序列化：任何情況都不拋例外
 * 回傳 null 表示這個值無法序列化，呼叫端自行決定怎麼處理
 */
function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function sizeOf(value) {
  if (value === null || value === undefined) return 0;
  const str = safeStringify(value);
  return str === null ? 0 : Buffer.byteLength(str, 'utf8');
}

function prepareBody(body, isError, cfg, contentType) {
  if (body === null || body === undefined) {
    return { body: null, bodySize: 0, bodyTruncated: false };
  }

  // 檔案上傳只留檔案資訊
  if (contentType && String(contentType).includes('multipart/form-data')) {
    return { body: '[multipart]', bodySize: sizeOf(body), bodyTruncated: false };
  }

  const str = safeStringify(body);
  if (str === null) {
    // 序列化不了就放棄記錄 body，其餘欄位照常 —— 不能讓一個怪結構
    // 害整筆紀錄消失，也不能讓它拋到原服務的 finish handler
    return { body: '[unserializable]', bodySize: 0, bodyTruncated: false };
  }

  const originalSize = Buffer.byteLength(str, 'utf8');
  const limit = isError ? cfg.bodyMaxBytes : cfg.bodySummaryBytes;
  if (originalSize <= limit) {
    return { body, bodySize: originalSize, bodyTruncated: false };
  }

  const sliced = Buffer.from(str, 'utf8').subarray(0, limit).toString('utf8');
  return { body: sliced, bodySize: originalSize, bodyTruncated: true };
}

// ── 送出佇列 ────────────────────────────────────────────

class Reporter {
  constructor(options) {
    this.cfg = { ...DEFAULTS, ...options };
    this.buffer = [];
    this.timer = null;
    this.heartbeatTimer = null;
    this.startedAt = Date.now();
    this.warned = false;

    if (!this.cfg.apiKey) {
      this.cfg.enabled = false;
      console.warn('[devops-reporter] 未設定 apiKey，回報已停用');
      return;
    }
    if (!this.cfg.endpoint || !this.cfg.serviceId) {
      this.cfg.enabled = false;
      console.warn('[devops-reporter] 未設定 endpoint 或 serviceId，回報已停用');
      return;
    }
    if (!this.cfg.enabled) return;

    this.startFlushLoop();
    if (this.cfg.heartbeatSec > 0) this.startHeartbeat();
  }

  push(log) {
    if (!this.cfg.enabled) return;
    this.buffer.push(log);
    if (this.buffer.length > this.cfg.bufferSize) {
      this.buffer.shift();
      if (!this.warned) {
        console.warn('[devops-reporter] 緩衝已滿，開始丟棄最舊的紀錄');
        this.warned = true;
      }
    }
    if (this.buffer.length >= this.cfg.batchSize) this.flush();
  }

  startFlushLoop() {
    this.timer = setInterval(() => this.flush(), this.cfg.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async flush() {
    if (!this.cfg.enabled || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.cfg.batchSize);

    const sent = await this.post('/api/v1/ingest/logs', { logs: batch });
    if (!sent) {
      // 送不出去放回緩衝前面等下一輪重送
      this.buffer = batch.concat(this.buffer).slice(0, this.cfg.bufferSize);
    } else {
      this.warned = false;
    }
  }

  async post(path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(`[devops-reporter] 認證失敗（${res.status}），請確認 API Key`);
        }
        // 429 表示平台要我們丟棄，不重送
        return res.status === 429;
      }
      return true;
    } catch (err) {
      clearTimeout(timer);
      return false;
    }
  }

  startHeartbeat() {
    const send = async () => {
      let deps = [];
      if (typeof this.cfg.deps === 'function') {
        try { deps = await this.cfg.deps(); } catch { deps = []; }
      }
      await this.post('/api/v1/heartbeat', {
        ts: new Date().toISOString(),
        version: this.cfg.version,
        uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
        deps,
      });
    };
    send();
    this.heartbeatTimer = setInterval(send, this.cfg.heartbeatSec * 1000);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * 服務關閉時盡力送出剩餘紀錄，但不阻擋關閉超過 3 秒
   */
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.cfg.enabled || this.buffer.length === 0) return;
    await Promise.race([
      this.flush(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

let singleton = null;

function shouldIgnore(path, ignorePaths) {
  return ignorePaths.some((p) =>
    p instanceof RegExp ? p.test(path) : String(path).startsWith(p));
}

/**
 * Express middleware
 * 注意：要註冊在 body parser 之後、所有路由之前
 */
function reporter(options = {}) {
  const instance = new Reporter(options);
  singleton = instance;
  const cfg = instance.cfg;

  if (!cfg.enabled) {
    // 停用時仍掛一個空的 req.devops，讓 req.devops?.action() 不會噴錯
    return (req, res, next) => next();
  }

  process.once('SIGTERM', () => instance.shutdown());
  process.once('SIGINT', () => instance.shutdown());

  return function devopsReporter(req, res, next) {
    if (shouldIgnore(req.path, cfg.ignorePaths)) return next();

    const startedAt = Date.now();
    const actions = [];
    let manualError = null;

    req.devops = {
      action(type, target, durationMs, note) {
        actions.push({
          seq: actions.length + 1,
          type: type || 'other',
          target: target || '',
          durationMs: durationMs != null ? durationMs : null,
          note: note || '',
          ok: true,
        });
      },
      failedAction(type, target, durationMs, note) {
        actions.push({
          seq: actions.length + 1,
          type: type || 'other',
          target: target || '',
          durationMs: durationMs != null ? durationMs : null,
          note: note || '',
          ok: false,
        });
      },
      error(err, note) {
        manualError = {
          name: (err && err.name) || 'Error',
          message: (err && err.message) || String(err),
          stack: (err && err.stack) || '',
          code: (err && err.code) || null,
        };
        if (note) manualError.message += `（${note}）`;
      },
    };

    // 攔截回應 body
    let responseBody = null;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      try {
        const status = res.statusCode;
        const isError = status >= 500 || manualError !== null;

        if (cfg.errorOnly && !isError) return;
        // 抽樣只作用於成功請求，錯誤永遠 100% 回報
        if (!isError && cfg.sampleRate < 1 && Math.random() > cfg.sampleRate) return;

        const reqBody = prepareBody(
          maskDeep(req.body, cfg.maskFields), isError, cfg, req.get('content-type')
        );
        const respBody = prepareBody(
          maskDeep(responseBody, cfg.maskFields), isError, cfg, res.get('content-type')
        );

        const fullPath = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;

        instance.push({
          ts: new Date(startedAt).toISOString(),
          level: isError ? 'error' : (status >= 400 ? 'warn' : 'info'),
          kind: 'http',
          request: {
            method: req.method,
            path: fullPath,
            // 沒進到 route handler 時（例如被認證中介層擋下）req.route 是 undefined，
            // 此時不能退回 req.path —— 在掛載的 router 內它已被去掉 baseUrl 變成 "/"，
            // 會讓不同端點的 401 全被聚合成同一組
            pathTemplate: (req.route && req.baseUrl != null)
              ? `${req.baseUrl}${req.route.path}` : fullPath,
            query: maskDeep(req.query, cfg.maskFields),
            body: reqBody.body,
            bodySize: reqBody.bodySize,
            bodyTruncated: reqBody.bodyTruncated,
            headers: pickHeaders(req.headers),
            ip: req.ip,
            userId: (req.user && (req.user.id || req.user.userId)) || null,
          },
          actions,
          response: {
            status,
            body: respBody.body,
            bodySize: respBody.bodySize,
            bodyTruncated: respBody.bodyTruncated,
            durationMs: Date.now() - startedAt,
          },
          error: manualError,
        });
      } catch (err) {
        // 任何例外都不能往外拋
        console.warn('[devops-reporter] 組裝紀錄失敗：', err.message);
      }
    });

    next();
  };
}

/**
 * 排程任務回報（PRD D-08）
 * 一次執行 = 一筆紀錄，沿用同一套 schema
 */
function reportJob({ name, trigger = 'cron', cronExpr = null, params = {} } = {}) {
  const startedAt = Date.now();
  const actions = [];

  const finish = async (status, body, error) => {
    if (!singleton || !singleton.cfg.enabled) return;
    singleton.push({
      ts: new Date(startedAt).toISOString(),
      level: status >= 500 ? 'error' : 'info',
      kind: 'job',
      request: {
        method: 'JOB',
        path: name,
        pathTemplate: name,
        query: {},
        body: { trigger, cronExpr, params },
        bodySize: sizeOf({ trigger, cronExpr, params }),
        bodyTruncated: false,
        headers: {},
        ip: null,
      },
      actions,
      response: {
        status,
        body: body || null,
        bodySize: sizeOf(body),
        bodyTruncated: false,
        durationMs: Date.now() - startedAt,
      },
      error: error ? {
        name: error.name || 'Error',
        message: error.message || String(error),
        stack: error.stack || '',
        code: error.code || null,
      } : null,
    });
    await singleton.flush();
  };

  return {
    action(type, target, durationMs, note) {
      actions.push({
        seq: actions.length + 1,
        type: type || 'other',
        target: target || '',
        durationMs: durationMs != null ? durationMs : null,
        note: note || '',
        ok: true,
      });
    },
    success(result) { return finish(200, result); },
    fail(error, result) { return finish(500, result, error); },
  };
}

function getReporter() {
  return singleton;
}

module.exports = { reporter, reportJob, getReporter, Reporter, maskDeep, prepareBody };
