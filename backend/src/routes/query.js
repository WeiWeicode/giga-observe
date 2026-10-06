/**
 * 查詢 API（API_CONTRACT §3）
 */
const express = require('express');
const queryService = require('../services/queryService');
const statusService = require('../services/statusService');
const topologyService = require('../services/topologyService');
const trafficService = require('../services/trafficService');
const statsService = require('../services/statsService');
const alertService = require('../services/alertService');
const webService = require('../services/webService');
const { ok, okList, fail } = require('../utils/response');

const router = express.Router();

function parseList(value) {
  if (!value) return null;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseParams(q) {
  return {
    serviceId: parseList(q.serviceId),
    from: q.from || null,
    to: q.to || null,
    level: q.level || null,
    status: q.status || null,
    method: q.method || null,
    path: q.path || null,
    q: q.q || null,
    kind: q.kind || null,
    traceId: q.traceId || null,
    limit: q.limit ? parseInt(q.limit, 10) : undefined,
    cursor: q.cursor || null,
    sort: q.sort || null,
  };
}

// GET /api/v1/services — 服務清單與狀態（架構圖用）
router.get('/services', async (req, res, next) => {
  try {
    let list = await statusService.buildSnapshot();

    const statusFilter = parseList(req.query.status);
    if (statusFilter) list = list.filter((s) => statusFilter.includes(s.health.status));

    const typeFilter = parseList(req.query.type);
    if (typeFilter) list = list.filter((s) => typeFilter.includes(s.type));

    const layerFilter = parseList(req.query.layer);
    if (layerFilter) list = list.filter((s) => layerFilter.includes(s.layer));

    return ok(res, list);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/services/:id — 單一服務詳情
router.get('/services/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = topologyService.getService(id);
    if (!svc) return fail(res, 404, 'NOT_FOUND', `找不到服務 ${id}`);

    const snapshot = await statusService.buildSnapshot();
    const base = snapshot.find((s) => s.id === id);

    const [recentLogs, recentErrors] = await Promise.all([
      queryService.recentForService(id, { limit: 50 }),
      queryService.recentForService(id, { limit: 20, onlyError: true }),
    ]);

    const statusMap = await statusService.getAllStatus();
    const edges = topologyService.getEdges();
    const upstream = edges.filter((e) => e.to === id).map((e) => ({
      id: e.from,
      status: statusMap[e.from] ? statusMap[e.from].status : 'unknown',
      label: e.label,
    }));
    const downstream = edges.filter((e) => e.from === id).map((e) => ({
      id: e.to,
      status: statusMap[e.to] ? statusMap[e.to].status : 'unknown',
      label: e.label,
    }));

    return ok(res, {
      ...base,
      description: svc.description || '',
      monitor: svc.monitor || { enabled: false },
      recentLogs,
      recentErrors,
      dependencies: { upstream, downstream },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/logs — 紀錄查詢
router.get('/logs', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    const result = await queryService.queryLogs(params);
    res.set('X-Data-Source', result.source);
    return okList(res, result.items, {
      limit: params.limit || queryService.DEFAULT_LIMIT,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/logs/:id — 單筆明細
router.get('/logs/:id', async (req, res, next) => {
  try {
    const doc = await queryService.getLogById(req.params.id);
    if (!doc) return fail(res, 404, 'NOT_FOUND', '找不到該筆紀錄');
    return ok(res, { ...doc, id: String(doc._id), _id: undefined });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/errors — 錯誤聚合
router.get('/errors', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    const groups = await queryService.aggregateErrors(params);
    return ok(res, groups);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/errors/:groupKey/events — 某組錯誤的個別事件
router.get('/errors/:groupKey/events', async (req, res, next) => {
  try {
    const groupKey = decodeURIComponent(req.params.groupKey);
    const events = await queryService.errorGroupEvents(groupKey);
    return ok(res, events);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/stats/overview — 總覽統計
router.get('/stats/overview', async (req, res, next) => {
  try {
    const statusMap = await statusService.getAllStatus();
    const data = await queryService.overview(statusMap);
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/topology — 架構圖定義
router.get('/topology', async (req, res, next) => {
  try {
    const services = await statusService.buildSnapshot();
    return ok(res, {
      services,
      edges: topologyService.getEdges(),
      unregistered: topologyService.getUnregistered(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GigaNexus 擴充（MONITORING-PLAN §5.4）────────────────────

// GET /api/v1/stats/today — 儀表板：今日 API 呼叫、可用率、回應時間、每小時流量
router.get('/stats/today', async (req, res, next) => {
  try {
    return ok(res, await statsService.today());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/stats/upstreams?hours=1 — 依上游彙總（Gateway 概況「上游服務健康」）
router.get('/stats/upstreams', async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 1, 1), 168);
    return ok(res, await statsService.upstreams(hours));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/alerts — 系統 / 資安告警（即時計算，近 15 分鐘）
router.get('/alerts', async (req, res, next) => {
  try {
    return ok(res, await alertService.list());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/traffic?from&to&bucket=hour|minute — Nginx 流量時序
router.get('/traffic', async (req, res, next) => {
  try {
    return ok(res, await trafficService.series({ from: req.query.from, to: req.query.to, bucket: req.query.bucket }));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/traffic/top-ips?from&to&limit — 來源 IP 排行
router.get('/traffic/top-ips', async (req, res, next) => {
  try {
    return ok(res, await trafficService.topIps({ from: req.query.from, to: req.query.to, limit: req.query.limit }));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/web/vitals?hours=24 — 前端效能（各指標 p75）
router.get('/web/vitals', async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 168);
    return ok(res, await webService.vitalsSummary(hours));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
