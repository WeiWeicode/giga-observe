/**
 * Ingest 壓測（DEPLOYMENT.md §10.3）
 *
 * 用法：
 *   node src/scripts/loadTest.js --key <ingest key> --rps 50 --seconds 30
 *   node src/scripts/loadTest.js --key <ingest key> --rps 200 --seconds 60 --batch 20 --errorRate 0.05
 *
 * 以指定速率送出批次紀錄，印出 p50 / p95 / p99 與錯誤率。
 * 送出的紀錄會真的寫進資料庫，測完記得清理（腳本結尾有指令）。
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);
const KEY = args.key;
const ENDPOINT = args.endpoint || 'http://localhost:5132';
const RPS = parseInt(args.rps || '50', 10);
const SECONDS = parseInt(args.seconds || '30', 10);
const BATCH = parseInt(args.batch || '10', 10);
const ERROR_RATE = parseFloat(args.errorRate || '0.01');
const PATH_POOL = ['/api/v1/articles/:id', '/api/v1/tags', '/api/v1/meta', '/api/v1/search'];

if (!KEY) {
  console.error('請以 --key <ingest key> 指定 API Key');
  console.error('用法：node src/scripts/loadTest.js --key gno_giganexus_xxx --rps 50 --seconds 30');
  process.exit(1);
}

function makeLog(i) {
  const isError = Math.random() < ERROR_RATE;
  const template = PATH_POOL[i % PATH_POOL.length];
  return {
    ts: new Date().toISOString(),
    level: isError ? 'error' : 'info',
    kind: 'http',
    request: {
      method: 'GET',
      path: template.replace(':id', String(1000 + (i % 500))),
      pathTemplate: template,
      query: { page: i % 10 },
      body: { note: 'loadtest', seq: i },
      headers: { 'content-type': 'application/json' },
      ip: '10.10.112.99',
    },
    actions: [
      { seq: 1, type: 'db', target: 'mssql.loadtest', durationMs: 5 + (i % 20), note: 'select', ok: true },
    ],
    response: {
      status: isError ? 500 : 200,
      body: { success: !isError },
      durationMs: 20 + (i % 180),
    },
    error: isError ? { name: 'LoadTestError', message: '壓測產生的模擬錯誤' } : null,
  };
}

const latencies = [];
let sent = 0;
let ok = 0;
let failed = 0;
let rateLimited = 0;
let counter = 0;

async function sendBatch() {
  const logs = Array.from({ length: BATCH }, () => makeLog(counter++));
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(`${ENDPOINT}/api/v1/ingest/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ logs }),
    });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    latencies.push(ms);
    sent += 1;
    if (res.status === 429) rateLimited += 1;
    else if (res.ok) ok += 1;
    else failed += 1;
  } catch (err) {
    sent += 1;
    failed += 1;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const batchesPerSec = Math.max(1, Math.round(RPS / BATCH));
  const intervalMs = 1000 / batchesPerSec;

  console.log('='.repeat(56));
  console.log('  Ingest 壓測');
  console.log('='.repeat(56));
  console.log(`  目標      : ${ENDPOINT}`);
  console.log(`  批次大小  : ${BATCH} 筆/次`);
  console.log(`  送出速率  : ${batchesPerSec} 次/秒（約 ${batchesPerSec * BATCH} 筆/秒）`);
  console.log(`  持續時間  : ${SECONDS} 秒`);
  console.log(`  模擬錯誤率: ${(ERROR_RATE * 100).toFixed(1)}%`);
  console.log('='.repeat(56));

  const startedAt = Date.now();
  const inflight = [];

  const timer = setInterval(() => {
    inflight.push(sendBatch());
  }, intervalMs);

  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  進行中… ${elapsed}/${SECONDS} 秒，已送 ${sent} 批`);
  }, 1000);

  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  clearInterval(timer);
  clearInterval(progress);
  await Promise.all(inflight);

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const totalLogs = sent * BATCH;

  console.log('\n');
  console.log('='.repeat(56));
  console.log('  結果');
  console.log('='.repeat(56));
  console.log(`  送出批次  : ${sent}（約 ${totalLogs} 筆紀錄）`);
  console.log(`  實際速率  : ${(totalLogs / elapsedSec).toFixed(1)} 筆/秒`);
  console.log(`  成功      : ${ok}`);
  console.log(`  被限流    : ${rateLimited}${rateLimited ? '  ← 調高 RATE_LIMIT_INGEST_PER_MIN 或降低 rps' : ''}`);
  console.log(`  失敗      : ${failed}`);
  console.log('  ─────────────────────────');
  console.log(`  p50       : ${percentile(sorted, 50).toFixed(1)} ms`);
  console.log(`  p95       : ${percentile(sorted, 95).toFixed(1)} ms${percentile(sorted, 95) > 50 ? '  ← 超過 PRD 的 p95 < 50ms 目標' : ''}`);
  console.log(`  p99       : ${percentile(sorted, 99).toFixed(1)} ms`);
  console.log(`  最慢      : ${(sorted[sorted.length - 1] || 0).toFixed(1)} ms`);
  console.log('='.repeat(56));
  console.log('');
  console.log('  測試資料清理（壓測紀錄的 path 都帶 loadtest 標記）：');
  console.log('  docker exec dvd-mongo mongosh "$MONGO_URI" --quiet --eval \\');
  console.log('    \'db.api_logs.deleteMany({"request.body.note":"loadtest"}); db.error_logs.deleteMany({"error.name":"LoadTestError"})\'');
  console.log('');
}

main().catch((err) => {
  console.error('壓測失敗：', err.message);
  process.exit(1);
});
