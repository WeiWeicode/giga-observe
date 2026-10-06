/**
 * 心跳回報（API_CONTRACT §2.3）
 */
const express = require('express');
const env = require('../config/env');
const statusService = require('../services/statusService');
const topologyService = require('../services/topologyService');
const { ok } = require('../utils/response');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const { version, uptimeSec, deps } = req.body || {};
    const serviceId = req.auth.serviceId;

    topologyService.markUnregistered(serviceId);
    await statusService.recordHeartbeat(serviceId, {
      version, uptimeSec, deps, source: 'push',
    });
    const status = await statusService.evaluate(serviceId);

    return ok(res, {
      serviceId,
      status: status.status,
      nextExpectedWithinSec: env.heartbeatTimeoutSec,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
