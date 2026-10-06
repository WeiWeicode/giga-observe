/**
 * SSE 端點（API_CONTRACT §4），掛在獨立的 5133
 */
const express = require('express');
const sseHub = require('../services/sseHub');
const statusService = require('../services/statusService');
const { fail } = require('../utils/response');

const router = express.Router();

router.get('/stream', async (req, res) => {
  if (sseHub.isFull()) {
    return fail(res, 503, 'SSE_LIMIT_REACHED', 'SSE 並行連線已達上限');
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  sseHub.add(res);

  // 連線建立時先送一次全量快照
  try {
    const snapshot = await statusService.buildSnapshot();
    sseHub.send(res, 'snapshot', snapshot);
  } catch (err) {
    console.warn('[sse] 初始快照失敗：', err.message);
  }

  req.on('close', () => {
    try { res.end(); } catch { /* 忽略 */ }
  });
});

module.exports = router;
