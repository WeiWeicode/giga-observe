/**
 * 錯誤 body 保存期限（MONITORING-PLAN D13）
 *
 * 錯誤紀錄永久保存，但完整 request / response body 只留 ERROR_BODY_DAYS 天（預設 90），
 * 之後裁成前 BODY_SUMMARY_BYTES（1 KB）摘要並標記 bodyTrimmedAt，降低個資風險與儲存量。
 * 每小時檢查一次，每批最多 500 筆，不一次鎖住大量資料。
 */
const mongo = require('../config/mongo');
const env = require('../config/env');
const { truncateToBytes } = require('../utils/truncate');

const BATCH = 500;
let timer = null;

/** 單一 body 裁成摘要（純函式） */
function trimBody(body, maxBytes) {
  if (body === null || body === undefined) return { body, changed: false };
  let s;
  if (typeof body === 'string') s = body;
  else {
    try {
      s = JSON.stringify(body);
    } catch {
      return { body: '[unserializable]', changed: true };
    }
  }
  if (s === undefined) return { body: null, changed: body !== null };
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { body, changed: false };
  return { body: truncateToBytes(s, maxBytes), changed: true };
}

async function trimOnce(now = new Date()) {
  if (!mongo.isConnected()) return 0;
  const cutoff = new Date(now.getTime() - env.errorBodyDays * 86400 * 1000);
  const col = mongo.col('error_logs');
  const docs = await col
    .find({ projectId: env.projectId, ts: { $lt: cutoff }, bodyTrimmedAt: { $exists: false } })
    .project({ 'request.body': 1, 'response.body': 1 })
    .limit(BATCH)
    .toArray();
  if (!docs.length) return 0;

  const ops = docs.map((d) => {
    const req = trimBody(d.request && d.request.body, env.bodySummaryBytes);
    const res = trimBody(d.response && d.response.body, env.bodySummaryBytes);
    const set = { bodyTrimmedAt: now };
    if (req.changed) {
      set['request.body'] = req.body;
      set['request.bodyTruncated'] = true;
    }
    if (res.changed) {
      set['response.body'] = res.body;
      set['response.bodyTruncated'] = true;
    }
    return { updateOne: { filter: { _id: d._id }, update: { $set: set } } };
  });
  await col.bulkWrite(ops, { ordered: false });
  return docs.length;
}

/** 一次清完積壓（每批之間讓出事件迴圈） */
async function run() {
  let total = 0;
  for (let i = 0; i < 200; i += 1) {
    const n = await trimOnce();
    total += n;
    if (n < BATCH) break;
    await new Promise((r) => setImmediate(r));
  }
  if (total) console.log(`[retention] 已將 ${total} 筆超過 ${env.errorBodyDays} 天的錯誤 body 裁成摘要`);
  return total;
}

function start() {
  const tick = () => run().catch((err) => console.warn('[retention] 執行失敗：', err.message));
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, 3600 * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { trimBody, trimOnce, run, start, stop };
