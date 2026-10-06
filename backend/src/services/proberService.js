/**
 * Pull 探測：主動打各服務的健康端點（ARCHITECTURE §1）
 * 用於服務整個掛掉、連 Push 心跳都發不出來的情況
 */
const env = require('../config/env');
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const topologyService = require('./topologyService');
const statusService = require('./statusService');

let probeTimer = null;

/**
 * 內建檢查：Mongo / Redis 沒有 HTTP 端點，改用平台既有的連線 ping
 * （與 /health 用的是同一組檢查）
 */
const INTERNAL_CHECKS = {
  mongo: () => mongo.ping(),
  redis: () => redis.ping(),
};

/**
 * 探測單一服務；只要求 2xx，不檢查回應內容
 */
async function probe(service) {
  const url = service.monitor.healthUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.probeTimeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      await statusService.recordHeartbeat(service.id, { source: 'probe' });
      return true;
    }
    await statusService.recordProbeFailure(service.id);
    return false;
  } catch (err) {
    clearTimeout(timer);
    await statusService.recordProbeFailure(service.id);
    return false;
  }
}

/**
 * 內建檢查的服務（dvd-mongo / dvd-redis）
 */
async function probeInternal(service) {
  const check = INTERNAL_CHECKS[service.monitor.check];
  if (!check) {
    console.warn(`[prober] ${service.id} 的 monitor.check "${service.monitor.check}" 不存在`);
    return false;
  }

  try {
    const result = await check();
    if (result.ok) {
      await statusService.recordHeartbeat(service.id, {
        source: 'probe',
        deps: [{ name: service.monitor.check, ok: true, latencyMs: result.latencyMs }],
      });
      return true;
    }
    await statusService.recordProbeFailure(service.id);
    return false;
  } catch (err) {
    await statusService.recordProbeFailure(service.id);
    return false;
  }
}

async function probeAll() {
  const httpTargets = topologyService.getProbeTargets();
  const internalTargets = topologyService.getInternalTargets();

  await Promise.all([
    ...httpTargets.map((svc) => probe(svc).catch(() => false)),
    ...internalTargets.map((svc) => probeInternal(svc).catch(() => false)),
  ]);
}

function start() {
  if (probeTimer) return;
  // 啟動後先探一次，不用等第一個間隔
  probeAll().catch(() => {});
  probeTimer = setInterval(() => {
    probeAll().catch((err) => console.warn('[prober] 探測失敗：', err.message));
  }, env.probeIntervalSec * 1000);
  console.log(`[prober] 已啟動，間隔 ${env.probeIntervalSec} 秒`);
}

function stop() {
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = null;
}

module.exports = { probe, probeInternal, probeAll, start, stop, INTERNAL_CHECKS };
