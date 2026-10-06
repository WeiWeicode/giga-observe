/**
 * body 保存規則（PRD D-05 / DB_SCHEMA §4）
 *   成功請求 → 只存前 1KB 摘要
 *   錯誤請求 → 存完整，超過 32KB 截斷
 */
const env = require('../config/env');

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

/**
 * 依序列化後的大小截斷字串（以位元組計）
 */
function truncateToBytes(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  // 避免切在多位元組字元中間
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}

/**
 * 處理單一 body
 * @param {*} body 原始 body（物件或字串）
 * @param {boolean} isError 是否為錯誤紀錄
 * @param {number|null} reportedSize SDK 回報的原始大小（優先採用）
 * @returns {{ body: *, bodySize: number, bodyTruncated: boolean }}
 */
function processBody(body, isError, reportedSize = null) {
  if (body === null || body === undefined) {
    return { body: null, bodySize: reportedSize || 0, bodyTruncated: false };
  }

  // 平台端收到的是 JSON 解析後的資料，理論上必可序列化；
  // 但有服務直接 curl 回報，不能假設 —— 失敗就放棄記錄 body，不讓整筆紀錄消失
  let serialized;
  if (typeof body === 'string') {
    serialized = body;
  } else {
    try {
      serialized = JSON.stringify(body);
    } catch {
      return { body: '[unserializable]', bodySize: reportedSize || 0, bodyTruncated: false };
    }
  }
  if (serialized === undefined) {
    return { body: null, bodySize: reportedSize || 0, bodyTruncated: false };
  }

  const originalSize = reportedSize != null ? reportedSize : byteLength(serialized);
  const limit = isError ? env.bodyMaxBytes : env.bodySummaryBytes;

  if (byteLength(serialized) <= limit) {
    return { body, bodySize: originalSize, bodyTruncated: originalSize > limit };
  }

  return {
    body: truncateToBytes(serialized, limit),
    bodySize: originalSize,
    bodyTruncated: true,
  };
}

module.exports = { processBody, truncateToBytes, byteLength };
