/**
 * 前端事件（MONITORING-PLAN D5）：POST /api/v1/ingest/web-events
 * 只接受 scope ingest-web 的 Key（BFF 轉送用）；瀏覽器不直接呼叫本服務
 */
const express = require('express');
const statusService = require('../services/statusService');
const sseHub = require('../services/sseHub');
const webService = require('../services/webService');
const { ok, fail } = require('../utils/response');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const events = req.body && req.body.events;
    if (!Array.isArray(events)) return fail(res, 400, 'VALIDATION_ERROR', 'events 必須為陣列');
    if (events.length > 100) return fail(res, 400, 'BATCH_TOO_LARGE', `一次最多 100 筆，收到 ${events.length} 筆`);

    const result = await webService.ingest(events, req.auth);
    const services = new Set();
    for (const doc of result.errorDocs) {
      services.add(doc.serviceId);
      sseHub.broadcast('error', {
        logId: String(doc._id), serviceId: doc.serviceId, method: doc.request.method,
        path: doc.request.path, status: doc.response.status, ts: doc.ts, message: doc.error ? doc.error.message : null,
      });
    }
    for (const id of services) statusService.onErrorReported(id).catch(() => {});

    const payload = { accepted: result.accepted };
    if (result.rejected > 0) Object.assign(payload, { rejected: result.rejected, errors: result.errors });
    return ok(res, payload, 202);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
