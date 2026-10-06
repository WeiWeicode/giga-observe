/**
 * 敏感欄位遮蔽（DB_SCHEMA §4）
 * SDK 端已遮過一次，這裡是第二道 —— 有服務會用 curl 直接回報（AGENT.md §9.4）
 */

const SENSITIVE_PATTERNS = [
  'password', 'passwd', 'token', 'authorization',
  'apikey', 'api_key', 'secret', 'credential',
];

const MASK = '***';

// headers 白名單：Authorization 與 Cookie 一律不落地
const HEADER_ALLOWLIST = ['content-type', 'user-agent', 'referer', 'x-request-id'];

function isSensitiveKey(key) {
  // 連字號與底線都要去掉，兩邊用同一套正規化：
  // 只去連字號的話 api_key 會比對不到 apikey 而漏遮
  const normalized = String(key).toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_PATTERNS.some((p) => normalized.includes(p.replace(/[-_]/g, '')));
}

// 單次處理的節點上限 —— 無論結構多離譜，成本都有天花板
const MAX_NODES = 5000;

/**
 * 遞迴遮蔽物件與陣列中的敏感欄位
 *
 * 三道保護（與 SDK 端同一套，理由見 sdk/index.js 的 maskDeep）：
 *  1. 先呼叫 toJSON()，避免挖出 ORM model 的內部循環參考
 *  2. 循環參考偵測，避免同一批物件被重複走訪導致成本指數成長
 *  3. 節點預算，替最壞情況設上限
 *
 * @param {*} value 任意值
 * @param {string[]} extraFields 額外要遮蔽的欄位名
 * @param {number} depth 深度上限
 * @param {{seen: WeakSet, nodes: number}} ctx 內部遞迴狀態
 */
function maskDeep(value, extraFields = [], depth = 0, ctx = null) {
  const c = ctx || { seen: new WeakSet(), nodes: 0 };

  if (depth > 12) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (c.nodes++ > MAX_NODES) return '[truncated: too large]';

  if (typeof value.toJSON === 'function') {
    try {
      value = value.toJSON();
    } catch {
      return '[unserializable]';
    }
    if (value === null || typeof value !== 'object') return value;
  }

  if (c.seen.has(value)) return '[circular]';
  c.seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, extraFields, depth + 1, c));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const extraHit = extraFields.some(
      (f) => String(f).toLowerCase() === String(key).toLowerCase()
    );
    if (isSensitiveKey(key) || extraHit) {
      out[key] = MASK;
    } else {
      out[key] = maskDeep(val, extraFields, depth + 1, c);
    }
  }
  return out;
}

/**
 * headers 只保留白名單
 */
function maskHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(headers)) {
    if (HEADER_ALLOWLIST.includes(String(key).toLowerCase())) {
      out[String(key).toLowerCase()] = val;
    }
  }
  return out;
}

module.exports = { maskDeep, maskHeaders, isSensitiveKey, MASK, HEADER_ALLOWLIST };
