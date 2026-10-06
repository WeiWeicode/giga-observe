/**
 * MongoDB 連線單例
 * 連線中斷時不讓服務崩潰 —— Ingest 仍可寫 Redis，等 Mongo 回來再補（ARCHITECTURE §9）
 */
const { MongoClient } = require('mongodb');
const env = require('./env');

let client = null;
let db = null;
let connected = false;

async function connect() {
  client = new MongoClient(env.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
  });

  client.on('serverHeartbeatFailed', () => { connected = false; });
  client.on('serverHeartbeatSucceeded', () => { connected = true; });

  await client.connect();
  db = client.db(env.mongoDb);
  connected = true;
  console.log(`[mongo] 已連線 ${env.mongoDb}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('MongoDB 尚未連線');
  return db;
}

function col(name) {
  return getDb().collection(name);
}

function isConnected() {
  return connected;
}

async function ping() {
  const start = Date.now();
  try {
    await getDb().command({ ping: 1 });
    connected = true;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    connected = false;
    return { ok: false, latencyMs: null, error: err.message };
  }
}

async function close() {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = null;
  if (client) await client.close();
  connected = false;
}

let reconnectTimer = null;

/**
 * 背景重連：Mongo 晚啟動或中途掛掉時自動補上
 * 沒有這個的話，首次連線失敗就永遠不會再連，待補佇列也永遠不會被消化
 */
function startReconnectLoop(onReconnect) {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (connected) return;
    try {
      await connect();
      console.log('[mongo] 重連成功');
      if (onReconnect) await onReconnect();
    } catch (err) {
      // 靜默重試，避免每 10 秒洗版
    }
  }, 10000);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

module.exports = { connect, getDb, col, isConnected, ping, close, startReconnectLoop };
