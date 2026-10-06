/**
 * API Key 驗證與權限檢查
 * serviceId / projectId 一律由 Key 反查決定，不採信 client 自報（AGENT.md §9.2）
 */
const apiKeyService = require('../services/apiKeyService');
const { fail } = require('../utils/response');
const env = require('../config/env');

/**
 * 從 header 取 Key；SSE 端點額外接受 query 參數
 * （EventSource 無法帶自訂 header，API_CONTRACT §4.1）
 */
function extractKey(req, allowQuery = false) {
  const header = req.get('X-API-Key');
  if (header) return header;
  if (allowQuery && req.query && req.query.apiKey) return String(req.query.apiKey);
  return null;
}

function apiKeyAuth(options = {}) {
  const allowQuery = options.allowQuery === true;

  return async (req, res, next) => {
    const plain = extractKey(req, allowQuery);
    if (!plain) {
      return fail(res, 401, 'MISSING_API_KEY', '未提供 API Key');
    }

    let auth;
    try {
      auth = await apiKeyService.verifyKey(plain);
    } catch (err) {
      console.error('[auth] 驗證失敗：', err.message);
      return fail(res, 500, 'INTERNAL_ERROR', 'API Key 驗證發生錯誤');
    }

    if (!auth) {
      return fail(res, 401, 'INVALID_API_KEY', 'API Key 無效或已停用');
    }

    req.auth = auth;
    next();
  };
}

/**
 * 權限檢查
 */
function requireScope(...scopes) {
  return (req, res, next) => {
    if (!req.auth) {
      return fail(res, 401, 'MISSING_API_KEY', '未提供 API Key');
    }
    const has = scopes.some((s) => req.auth.scopes.includes(s));
    if (!has) {
      return fail(res, 403, 'INSUFFICIENT_SCOPE',
        `此端點需要 ${scopes.join(' 或 ')} 權限`);
    }
    next();
  };
}

/**
 * 查詢端點的 IP 白名單
 * Ingest 端點不套用 —— 各服務都要能回報（ARCHITECTURE §6.1）
 */
function ipAllowlist(req, res, next) {
  if (env.allowedQueryIps.length === 0) return next();

  const raw = req.ip || req.connection.remoteAddress || '';
  const ip = raw.replace(/^::ffff:/, '');

  if (env.allowedQueryIps.includes(ip)) return next();

  return fail(res, 403, 'IP_NOT_ALLOWED', `來源 IP ${ip} 不在允許清單中`);
}

// ── 經 Gateway BFF 轉入（GigaItApp 架構觀測頁）────────────────
// 以 X-Internal-Token 取代 API Key：ES256、iss = giganexus-bff、aud = GW_SERVICE_CODE、exp（容許 30 秒）。
// 頁面權限（observe.data.read / observe.log.body）已由 BFF 依路由表檢查，這裡只確認請求真的來自 Gateway。
let verifier = null;

function getVerifier() {
  if (verifier) return verifier;
  if (!env.gwJwksUrl) return null;
  // jose 只有 ESM 版本；Node 22.12+ 可直接 require（不含 top-level await）
  const { createRemoteJWKSet, jwtVerify } = require('jose');
  const jwks = createRemoteJWKSet(new URL(env.gwJwksUrl));
  verifier = async (token) => (await jwtVerify(token, jwks, {
    issuer: 'giganexus-bff', audience: env.gwServiceCode, algorithms: ['ES256'], clockTolerance: 30,
  })).payload;
  return verifier;
}

/** 測試用：替換 Token 驗證函式 */
function setGatewayVerifier(fn) {
  verifier = fn;
}

/**
 * 查詢端點：帶 X-Internal-Token 走 Gateway 驗證（只給 read），否則走 API Key
 */
function gatewayOrApiKey(options = {}) {
  const keyAuth = apiKeyAuth(options);
  return async (req, res, next) => {
    const token = req.get('X-Internal-Token');
    if (!token) return keyAuth(req, res, next);
    const verify = getVerifier();
    if (!verify) return fail(res, 401, 'GATEWAY_AUTH_DISABLED', '未設定 GW_JWKS_URL，不接受 Gateway Token');
    try {
      const p = await verify(token);
      req.auth = {
        projectId: env.projectId, serviceId: null, scopes: ['read'], viaGateway: true,
        user: { sub: p.sub, emp: p.emp || null, name: p.name || null },
      };
      return next();
    } catch {
      return fail(res, 401, 'INVALID_INTERNAL_TOKEN', '內部 Token 無效');
    }
  };
}

module.exports = { apiKeyAuth, requireScope, ipAllowlist, extractKey, gatewayOrApiKey, setGatewayVerifier };
