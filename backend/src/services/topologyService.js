/**
 * 架構圖拓樸：從 config/topology.json 載入，寫入 Mongo 並常駐記憶體
 * 修改後呼叫 reload 即可，不需重啟容器（ARCHITECTURE §10）
 */
const fs = require('fs');
const path = require('path');
const mongo = require('../config/mongo');
const env = require('../config/env');

const TOPOLOGY_PATH = path.join(__dirname, '..', '..', 'config', 'topology.json');

let services = [];
let edges = [];
const unregistered = new Set();

function readFile() {
  if (!fs.existsSync(TOPOLOGY_PATH)) {
    console.warn(`[topology] 找不到 ${TOPOLOGY_PATH}，以空拓樸啟動`);
    return { services: [], edges: [] };
  }
  const raw = fs.readFileSync(TOPOLOGY_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * 載入拓樸並同步進 Mongo
 */
async function load() {
  const data = readFile();
  services = data.services || [];
  edges = data.edges || [];

  if (mongo.isConnected()) {
    for (const svc of services) {
      await mongo.col('services').updateOne(
        { _id: svc.id },
        {
          $set: {
            projectId: env.projectId,
            name: svc.name,
            type: svc.type,
            layer: svc.layer,
            description: svc.description || '',
            stack: svc.stack || [],
            team: svc.team || '',
            owner: svc.owner || '',
            status: svc.status || 'active',
            links: svc.links || {},
            monitor: svc.monitor || { enabled: false },
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      ).catch((err) => console.warn('[topology] 服務寫入失敗：', err.message));
    }

    await mongo.col('topology').deleteMany({ projectId: env.projectId }).catch(() => {});
    if (edges.length) {
      await mongo.col('topology').insertMany(
        edges.map((e) => ({ projectId: env.projectId, from: e.from, to: e.to, label: e.label || '' })),
        { ordered: false }
      ).catch(() => {});
    }
  }

  console.log(`[topology] 已載入 ${services.length} 個服務、${edges.length} 條連線`);
  return { services: services.length, edges: edges.length };
}

function getServices() {
  return services;
}

function getEdges() {
  return edges;
}

function getService(id) {
  return services.find((s) => s.id === id) || null;
}

function has(id) {
  return services.some((s) => s.id === id);
}

/**
 * 有回報但未登錄的服務，提示補設定
 */
function markUnregistered(serviceId) {
  if (!has(serviceId) && !unregistered.has(serviceId)) {
    unregistered.add(serviceId);
    console.warn(`[topology] 收到未登錄服務的回報：${serviceId}`);
  }
}

function getUnregistered() {
  return Array.from(unregistered);
}

/**
 * 需要被 HTTP 探測的服務
 */
function getProbeTargets() {
  return services.filter(
    (s) => s.monitor && s.monitor.enabled && s.monitor.healthUrl
      && s.monitor.type !== 'internal'
  );
}

/**
 * 以平台自身的連線檢查判定狀態的服務（Mongo / Redis）
 * 這類元件沒有 HTTP 端點，但平台本來就在 /health 裡 ping 它們
 */
function getInternalTargets() {
  return services.filter(
    (s) => s.monitor && s.monitor.enabled && s.monitor.type === 'internal'
  );
}

module.exports = {
  load, getServices, getEdges, getService, has,
  markUnregistered, getUnregistered, getProbeTargets, getInternalTargets,
  TOPOLOGY_PATH,
};
