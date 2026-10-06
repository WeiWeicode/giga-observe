/**
 * Admin API（API_CONTRACT §5）
 */
const express = require('express');
const apiKeyService = require('../services/apiKeyService');
const topologyService = require('../services/topologyService');
const env = require('../config/env');
const { ok, fail } = require('../utils/response');

const router = express.Router();

const VALID_SCOPES = ['ingest', 'read', 'admin'];

// POST /api/v1/admin/keys — 建立 Key
router.post('/keys', async (req, res, next) => {
  try {
    const { projectId, serviceId, scopes, label } = req.body || {};

    if (!Array.isArray(scopes) || scopes.length === 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'scopes 必填且須為陣列');
    }
    const invalid = scopes.filter((s) => !VALID_SCOPES.includes(s));
    if (invalid.length) {
      return fail(res, 400, 'VALIDATION_ERROR', `不支援的權限：${invalid.join(', ')}`);
    }
    if (scopes.includes('ingest') && !serviceId) {
      return fail(res, 400, 'VALIDATION_ERROR', 'ingest 權限的 Key 必須指定 serviceId');
    }

    const created = await apiKeyService.createKey({
      projectId: projectId || env.projectId,
      serviceId: serviceId || null,
      scopes,
      label,
      createdBy: req.auth.keyId,
    });

    return ok(res, {
      id: String(created.id),
      key: created.key,
      keyPrefix: created.keyPrefix,
      warning: '明文 Key 只顯示這一次，請立即保存',
    }, 201);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/keys — 列出 Key（不回明文與雜湊）
router.get('/keys', async (req, res, next) => {
  try {
    const keys = await apiKeyService.listKeys(req.query.projectId || null);
    return ok(res, keys);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/admin/keys/:id — 啟用 / 停用
router.patch('/keys/:id', async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return fail(res, 400, 'VALIDATION_ERROR', 'enabled 必須為布林值');
    }
    const updated = await apiKeyService.setEnabled(req.params.id, enabled);
    if (!updated) return fail(res, 404, 'NOT_FOUND', '找不到該 Key');
    return ok(res, { id: req.params.id, enabled });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/admin/keys/:id
router.delete('/keys/:id', async (req, res, next) => {
  try {
    const removed = await apiKeyService.deleteKey(req.params.id);
    if (!removed) return fail(res, 404, 'NOT_FOUND', '找不到該 Key');
    return ok(res, { id: req.params.id, deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/topology/reload — 重載拓樸
router.post('/topology/reload', async (req, res, next) => {
  try {
    const result = await topologyService.load();
    return ok(res, { ...result, removed: 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
