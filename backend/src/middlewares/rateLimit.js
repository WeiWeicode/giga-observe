/**
 * 速率限制（API_CONTRACT §1.6）
 * Ingest 超限時丟棄該批次但不要求服務重送 —— 不讓我們的限流卡住被監控服務
 */
const redis = require('../config/redis');
const { fail } = require('../utils/response');
const { minuteKey } = require('../utils/response');

function rateLimit(scope, limitPerMin) {
  return async (req, res, next) => {
    if (!redis.isConnected()) return next();

    const id = req.auth ? (req.auth.serviceId || req.auth.keyId) : 'anonymous';
    const key = redis.keys.rate(scope, id, minuteKey());

    try {
      const count = await redis.getClient().incr(key);
      if (count === 1) {
        await redis.getClient().expire(key, 120);
      }
      if (count > limitPerMin) {
        res.set('Retry-After', '60');
        return fail(res, 429, 'RATE_LIMITED',
          `超過每分鐘 ${limitPerMin} 次的限制`);
      }
    } catch (err) {
      // 限流機制本身故障時放行，不能因此擋住正常回報
      return next();
    }

    next();
  };
}

module.exports = { rateLimit };
