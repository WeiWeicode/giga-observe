/**
 * 統一回應格式（API_CONTRACT §1.3）
 */

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function okList(res, data, pagination) {
  return res.status(200).json({ success: true, data, pagination });
}

function fail(res, status, code, message, details) {
  const error = { code, message };
  if (details) error.details = details;
  return res.status(status).json({ success: false, error });
}

/**
 * 小時 key，例如 2026091808
 */
function hourKey(date = new Date()) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

function minuteKey(date = new Date()) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${hourKey(d)}${pad(d.getUTCMinutes())}`;
}

module.exports = { ok, okList, fail, hourKey, minuteKey };
