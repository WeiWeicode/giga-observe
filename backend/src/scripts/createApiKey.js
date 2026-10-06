/**
 * 建立 API Key（ARCHITECTURE §7.1）
 *
 * 用法：
 *   node src/scripts/createApiKey.js --service gigaks-backend --scope ingest
 *   node src/scripts/createApiKey.js --scope read --label 前端查詢
 *   node src/scripts/createApiKey.js --scope admin --label 管理
 */
const mongo = require('../config/mongo');
const env = require('../config/env');
const apiKeyService = require('../services/apiKeyService');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const scope = args.scope || 'ingest';
  const serviceId = args.service || null;

  if (scope === 'ingest' && !serviceId) {
    console.error('ingest 權限必須指定 --service <serviceId>');
    process.exit(1);
  }

  await mongo.connect();

  const created = await apiKeyService.createKey({
    projectId: args.project || env.projectId,
    serviceId,
    scopes: [scope],
    label: args.label || `${scope} key`,
    createdBy: 'cli',
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('  API Key 已建立（明文只顯示這一次）');
  console.log('='.repeat(60));
  console.log(`  serviceId : ${serviceId || '(全專案)'}`);
  console.log(`  scope     : ${scope}`);
  console.log(`  key       : ${created.key}`);
  console.log('='.repeat(60));
  console.log('');

  await mongo.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('建立失敗：', err.message);
  process.exit(1);
});
