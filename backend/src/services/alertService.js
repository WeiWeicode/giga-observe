/**
 * 告警（MONITORING-PLAN §5.4）：查詢時即時計算，只在畫面顯示，不寄信（Email 另列工作項目）
 *
 *   system    服務失聯（down）、錯誤率超標（degraded）、前端錯誤突增
 *   security  401 / 403 / 429 突增、單一 IP 請求異常（Nginx 彙總）、登入失敗突增（BFF 紀錄）
 *
 * 門檻見 env：ALERT_SECURITY_PER_MIN、ALERT_IP_PER_MIN、ALERT_WEB_ERRORS_PER_15M
 */
const mongo = require('../config/mongo');
const env = require('../config/env');
const statusService = require('./statusService');
const topologyService = require('./topologyService');
const trafficService = require('./trafficService');
const statsService = require('./statsService');

const WINDOW_MIN = 15;

/** 由近 15 分鐘的 Nginx 彙總找出資安異常（純函式，方便測試） */
function securityFromTraffic(minutes, thresholds) {
  const items = [];
  let worst = null;
  for (const m of minutes) {
    const denied = (m.codes?.['401'] || 0) + (m.codes?.['403'] || 0) + (m.codes?.['429'] || 0);
    if (denied >= thresholds.securityPerMin && (!worst || denied > worst.denied)) worst = { ts: m.ts, denied, codes: m.codes };
  }
  if (worst) {
    items.push({
      id: 'security:denied',
      category: 'security',
      severity: 'warning',
      title: '拒絕請求突增',
      detail: `單一分鐘內 401 / 403 / 429 最多 ${worst.denied} 次`,
      since: worst.ts,
    });
  }
  const ips = new Map();
  for (const m of minutes) {
    for (const x of m.topIps || []) {
      if (x.count >= thresholds.ipPerMin) {
        const cur = ips.get(x.ip);
        if (!cur || x.count > cur.count) ips.set(x.ip, { count: x.count, ts: m.ts, realIp: m.realIp !== false });
      }
    }
  }
  for (const [ip, v] of ips) {
    items.push({
      id: `security:ip:${ip}`,
      category: 'security',
      severity: 'warning',
      title: '單一 IP 請求異常',
      detail: `${ip} 一分鐘內 ${v.count} 次請求${v.realIp ? '' : '（未經 PROXY protocol，可能是轉送位址）'}`,
      since: v.ts,
      ip,
    });
  }
  return items;
}

async function loginFailures(since) {
  if (!mongo.isConnected()) return 0;
  return mongo.col('api_logs').countDocuments({
    projectId: env.projectId,
    serviceId: statsService.entryServiceId(),
    'request.pathTemplate': '/api/auth/login',
    'response.status': 401,
    ts: { $gte: since },
  });
}

async function webErrors(since) {
  if (!mongo.isConnected()) return [];
  return mongo.col('error_logs').aggregate([
    { $match: { projectId: env.projectId, kind: 'web', ts: { $gte: since } } },
    { $group: { _id: '$serviceId', count: { $sum: 1 }, first: { $min: '$ts' } } },
  ]).toArray();
}

async function list() {
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
  const items = [];

  const statusMap = await statusService.getAllStatus();
  for (const svc of topologyService.getServices()) {
    const st = statusMap[svc.id];
    if (!st || svc.status === 'planned') continue;
    if (st.status === 'down') {
      items.push({ id: `system:down:${svc.id}`, category: 'system', severity: 'critical', title: `${svc.name} 失聯`, detail: '超過心跳逾時沒有心跳或探測成功', serviceId: svc.id, since: st.since });
    } else if (st.status === 'degraded') {
      const rate = st.stats5m ? Math.round(st.stats5m.errorRate * 100) : null;
      items.push({ id: `system:degraded:${svc.id}`, category: 'system', severity: 'warning', title: `${svc.name} 錯誤率偏高`, detail: rate != null ? `近 5 分鐘錯誤率 ${rate}%` : '近 5 分鐘錯誤率超過門檻', serviceId: svc.id, since: st.since });
    }
  }

  const [minutes, logins, web] = await Promise.all([trafficService.recentMinutes(WINDOW_MIN), loginFailures(since), webErrors(since)]);
  items.push(...securityFromTraffic(minutes, { securityPerMin: env.alertSecurityPerMin, ipPerMin: env.alertIpPerMin }));
  if (logins >= env.alertSecurityPerMin) {
    items.push({ id: 'security:login', category: 'security', severity: 'warning', title: '登入失敗突增', detail: `近 ${WINDOW_MIN} 分鐘登入失敗 ${logins} 次`, since });
  }
  for (const w of web) {
    if (w.count >= env.alertWebErrorsPer15m) {
      const svc = topologyService.getService(w._id);
      items.push({ id: `system:web:${w._id}`, category: 'system', severity: 'warning', title: `${svc ? svc.name : w._id} 前端錯誤突增`, detail: `近 ${WINDOW_MIN} 分鐘 ${w.count} 筆前端錯誤`, serviceId: w._id, since: w.first });
    }
  }

  const rank = { critical: 0, warning: 1 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || new Date(b.since) - new Date(a.since));
  return {
    items,
    counts: {
      system: items.filter((i) => i.category === 'system').length,
      security: items.filter((i) => i.category === 'security').length,
    },
    windowMin: WINDOW_MIN,
  };
}

module.exports = { list, securityFromTraffic };
