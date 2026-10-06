/**
 * SSE 連線管理與事件廣播（ARCHITECTURE §5）
 */
const env = require('../config/env');

const connections = new Set();
let snapshotTimer = null;
let snapshotProvider = null;

function setSnapshotProvider(fn) {
  snapshotProvider = fn;
}

function count() {
  return connections.size;
}

function isFull() {
  return connections.size >= env.sseMaxConnections;
}

function add(res) {
  connections.add(res);
  res.on('close', () => connections.delete(res));
  return () => connections.delete(res);
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    connections.delete(res);
  }
}

function broadcast(event, data) {
  for (const res of connections) {
    send(res, event, data);
  }
}

/**
 * 定期送出 snapshot，兼作 keep-alive 防止 Nginx 斷線
 */
function startSnapshotLoop() {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(async () => {
    if (connections.size === 0 || !snapshotProvider) return;
    try {
      const data = await snapshotProvider();
      broadcast('snapshot', data);
    } catch (err) {
      console.warn('[sse] snapshot 產生失敗：', err.message);
    }
  }, env.sseSnapshotIntervalSec * 1000);
}

function stop() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = null;
  for (const res of connections) {
    try { res.end(); } catch { /* 忽略 */ }
  }
  connections.clear();
}

module.exports = {
  add, send, broadcast, count, isFull,
  setSnapshotProvider, startSnapshotLoop, stop,
};
