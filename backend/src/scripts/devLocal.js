/**
 * 本機示範環境(只供開發看畫面,不連任何測試區 / 正式區資源):npm run dev:local
 *
 *   - 記憶體 MongoDB(mongodb-memory-server),關閉即消失;不需要 Redis(統計改由 Mongo 計算)
 *   - 灌入近 24 小時的示範資料(BFF / itapp-api 紀錄、錯誤、Nginx 流量、前端事件),之後每 30 秒補新資料與心跳
 *   - 建立一把 read Key 寫到 .local-keys.json(不入版控),給 GigaItApp 開發伺服器的 OBSERVE_LOCAL_KEY 使用
 *   - 探測一律關閉(拓樸的 healthUrl 是測試區位址)
 */
const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  const mongod = await MongoMemoryServer.create();
  Object.assign(process.env, {
    MONGO_URI: mongod.getUri(),
    OBSERVE_ENV: 'dev',
    REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
    PROBE_INTERVAL_SEC: '86400',
    STATUS_EVAL_INTERVAL_SEC: '10',
  });
  const { start } = require('../index');
  await start();

  const apiKeyService = require('../services/apiKeyService');
  const { key } = await apiKeyService.createKey({ projectId: 'giganexus', serviceId: null, scopes: ['read'], label: '本機 GigaItApp' });
  const file = path.join(__dirname, '..', '..', '.local-keys.json');
  fs.writeFileSync(file, JSON.stringify({ read: key }, null, 2));
  console.log(`[dev-local] read Key 已寫入 ${file}`);

  const demo = require('./demoData');
  await demo.seedHistory();
  await demo.tick();
  setInterval(() => demo.tick().catch((err) => console.warn('[dev-local] 補資料失敗：', err.message)), 30_000);
  console.log(`[dev-local] 示範資料就緒:http://localhost:${process.env.PORT || 51202}/api/v1/topology(需 X-API-Key)`);

  const stop = async () => {
    await mongod.stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err) => {
  console.error('[dev-local] 啟動失敗：', err);
  process.exit(1);
});
