/**
 * Ingest API（API_CONTRACT §2）
 */
const express = require('express');
const env = require('../config/env');
const ingestService = require('../services/ingestService');
const statusService = require('../services/statusService');
const topologyService = require('../services/topologyService');
const sseHub = require('../services/sseHub');
const trafficService = require('../services/trafficService');
const { ok, fail } = require('../utils/response');

const router = express.Router();

async function handleBatch(logs, auth, res) {
  if (!Array.isArray(logs)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'logs 必須為陣列');
  }
  if (logs.length > env.ingestBatchMax) {
    return fail(res, 400, 'BATCH_TOO_LARGE',
      `一次最多 ${env.ingestBatchMax} 筆，收到 ${logs.length} 筆`);
  }

  topologyService.markUnregistered(auth.serviceId);

  const result = await ingestService.ingestBatch(logs, auth);

  // 有錯誤時推播並立即重算狀態
  if (result.errorDocs.length > 0) {
    for (const doc of result.errorDocs) {
      sseHub.broadcast('error', {
        logId: doc._id ? String(doc._id) : null,
        serviceId: doc.serviceId,
        method: doc.request.method,
        path: doc.request.path,
        status: doc.response.status,
        ts: doc.ts,
        message: doc.error ? doc.error.message : null,
      });
    }
    statusService.onErrorReported(auth.serviceId).catch(() => {});
  }

  const payload = { accepted: result.accepted };
  if (result.rejected > 0) {
    payload.rejected = result.rejected;
    payload.errors = result.errors;
  }
  return ok(res, payload, 202);
}

// POST /api/v1/ingest/logs — 批次
router.post('/logs', async (req, res, next) => {
  try {
    await handleBatch(req.body && req.body.logs, req.auth, res);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ingest/log — 單筆
router.post('/log', async (req, res, next) => {
  try {
    await handleBatch([req.body], req.auth, res);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ingest/traffic — Nginx 每分鐘流量彙總（nginx-log-agent，MONITORING-PLAN D4）
router.post('/traffic', async (req, res, next) => {
  try {
    const minutes = req.body && req.body.minutes;
    if (!Array.isArray(minutes)) return fail(res, 400, 'VALIDATION_ERROR', 'minutes 必須為陣列');
    if (minutes.length > env.ingestBatchMax) {
      return fail(res, 400, 'BATCH_TOO_LARGE', `一次最多 ${env.ingestBatchMax} 筆，收到 ${minutes.length} 筆`);
    }
    topologyService.markUnregistered(req.auth.serviceId);
    const result = await trafficService.ingest(minutes, req.auth);
    const payload = { accepted: result.accepted };
    if (result.rejected > 0) Object.assign(payload, { rejected: result.rejected, errors: result.errors });
    return ok(res, payload, 202);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
