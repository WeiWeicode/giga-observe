/**
 * 給 Gateway 匯入的 OpenAPI（BACKEND-GUIDE §6.1）：GET /openapi.json
 *
 * 只列 GigaItApp 架構觀測頁經 BFF 讀取的查詢 API；Ingest、Admin、SSE 不經 Gateway。
 * 對外路徑以 x-gateway-path 指定為 /api/observe/*（上游路徑是 /api/v1/*）。
 * 權限：observe.data.read（狀態、統計、紀錄摘要）、observe.log.body（含 request / response body 的明細，可能有個資）
 */
const pkg = require('../package.json');

const PERMISSIONS = [
  { code: 'observe.data.read', name: '架構觀測:查詢狀態、統計與紀錄摘要' },
  { code: 'observe.log.body', name: '架構觀測:查看請求 / 回應內容(可能含個資)' },
];

const list = { type: 'array', items: { type: 'object', additionalProperties: true } };
const obj = { type: 'object', additionalProperties: true };
const envelope = (data) => ({
  200: {
    description: '成功',
    content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data } } } },
  },
});
const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const p = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });

const OPS = [
  {
    path: '/api/v1/topology', gw: '/api/observe/topology', id: 'observe.topology.read', perm: 'observe.data.read', summary: '架構圖',
    description: '所有服務(節點)與連線、各服務目前健康狀態(healthy / degraded / down / unknown)與近 5 分鐘、近 1 小時統計。架構觀測頁的架構圖用。',
    gherkin: ['場景: 架構圖顯示服務狀態', '  假如 itapp-api 30 秒內有心跳且近 5 分鐘錯誤率低於 5%', '  當 呼叫 GET /api/observe/topology', '  那麼 回應 200', '  而且 itapp-api 的 health.status 為 healthy'],
    data: obj,
  },
  {
    path: '/api/v1/services/{id}', gw: '/api/observe/services/:id', id: 'observe.service.read', perm: 'observe.data.read', summary: '服務詳情',
    description: '單一服務的狀態、版本、最後心跳、相依服務狀態、近 50 筆紀錄與近 20 筆錯誤(摘要,不含 body)、上下游連線。',
    params: [p('id', '服務代碼,例 itapp-api')],
    gherkin: ['場景: 查看服務詳情', '  當 呼叫 GET /api/observe/services/itapp-api', '  那麼 回應 200', '  而且 包含 recentLogs、recentErrors 與 dependencies'],
    data: obj,
  },
  {
    path: '/api/v1/logs', gw: '/api/observe/logs', id: 'observe.log.list', perm: 'observe.data.read', summary: '紀錄查詢',
    description: '依服務、時間、狀態碼、方法、路徑、traceId(X-Request-Id)查詢請求紀錄摘要,cursor 分頁。不含 body。',
    params: [q('serviceId', '服務代碼,逗號分隔'), q('from', 'ISO 時間'), q('to', 'ISO 時間'), q('status', '例 500、5xx、4xx'), q('method', 'HTTP 方法'), q('path', '路徑關鍵字'), q('traceId', 'X-Request-Id'), q('level', 'info / warn / error'), q('kind', 'http / job / web'), q('limit', '筆數', { type: 'integer' }), q('cursor', '分頁游標')],
    gherkin: ['場景: 以 requestId 串接前後端紀錄', '  假如 前端回報的 API 失敗事件帶 requestId req-1', '  當 呼叫 GET /api/observe/logs?traceId=req-1', '  那麼 回應包含 BFF、下游後端與前端同一請求的紀錄'],
    data: list,
  },
  {
    path: '/api/v1/logs/{id}', gw: '/api/observe/logs/:id', id: 'observe.log.detail', perm: 'observe.log.body', summary: '紀錄明細(含內容)',
    description: '單筆紀錄完整明細:request / response headers 與 body(已遮罩密碼、Token 等欄位)、步驟、錯誤堆疊。可能含個資,權限另列。',
    params: [p('id', '紀錄 ID')],
    gherkin: ['場景: 沒有 observe.log.body 不能看內容', '  假如 使用者只有 observe.data.read', '  當 呼叫 GET /api/observe/logs/{id}', '  那麼 回應 403 PERMISSION_DENIED'],
    data: obj,
  },
  {
    path: '/api/v1/errors', gw: '/api/observe/errors', id: 'observe.error.list', perm: 'observe.data.read', summary: '錯誤聚合',
    description: '依服務 + 方法 + 路徑樣板 + 狀態碼聚合錯誤(預設 7 天),含次數、首次 / 最後發生時間與範例訊息。',
    params: [q('serviceId', '服務代碼,逗號分隔'), q('from', 'ISO 時間'), q('to', 'ISO 時間'), q('status', '例 5xx'), q('sort', 'count / latest'), q('limit', '筆數', { type: 'integer' })],
    gherkin: ['場景: 同一 API 的錯誤合併顯示', '  假如 itapp-api GET /api/it/dashboard 近 1 小時回 500 三次', '  當 呼叫 GET /api/observe/errors', '  那麼 該組 count 為 3'],
    data: list,
  },
  {
    path: '/api/v1/errors/{groupKey}/events', gw: '/api/observe/errors/:groupKey/events', id: 'observe.error.events', perm: 'observe.data.read', summary: '錯誤事件清單',
    description: '某組錯誤(groupKey = 服務|方法|路徑樣板|狀態碼)的個別事件摘要,最新在前。',
    params: [p('groupKey', 'serviceId|method|pathTemplate|status,需 URL 編碼')],
    gherkin: ['場景: 展開錯誤群組', '  當 呼叫 GET /api/observe/errors/{groupKey}/events', '  那麼 回應該組最多 100 筆事件摘要'],
    data: list,
  },
  {
    path: '/api/v1/stats/overview', gw: '/api/observe/stats/overview', id: 'observe.stats.overview', perm: 'observe.data.read', summary: '總覽統計',
    description: '服務狀態計數、近 1 / 24 小時請求數與錯誤率、前 5 名錯誤、最慢 API。',
    gherkin: ['場景: 總覽', '  當 呼叫 GET /api/observe/stats/overview', '  那麼 回應包含 services、last1h、last24h、topErrors、slowest'],
    data: obj,
  },
  {
    path: '/api/v1/stats/today', gw: '/api/observe/stats/today', id: 'observe.stats.today', perm: 'observe.data.read', summary: '今日 API 統計',
    description: '儀表板:今日 API 呼叫數(以入口 BFF 計,台灣時間)、與昨日同時段比較、可用率(非 5xx 比例)、平均與 p95 回應時間、每小時請求數與錯誤數。',
    gherkin: ['場景: 儀表板今日統計', '  假如 今日經 BFF 有 1000 次請求、其中 5 次 5xx', '  當 呼叫 GET /api/observe/stats/today', '  那麼 today.total 為 1000', '  而且 today.availability 為 0.995'],
    data: obj,
  },
  {
    path: '/api/v1/stats/upstreams', gw: '/api/observe/stats/upstreams', id: 'observe.stats.upstreams', perm: 'observe.data.read', summary: '上游服務健康',
    description: '依 BFF 轉送的上游(upstream)彙總近 N 小時的呼叫數、錯誤率、可用率與 p95 回應時間。',
    params: [q('hours', '小時數,1–168,預設 1', { type: 'integer' })],
    gherkin: ['場景: 上游服務健康', '  當 呼叫 GET /api/observe/stats/upstreams?hours=1', '  那麼 每個上游一列,含 p95Ms 與 availability'],
    data: list,
  },
  {
    path: '/api/v1/alerts', gw: '/api/observe/alerts', id: 'observe.alert.list', perm: 'observe.data.read', summary: '系統 / 資安告警',
    description: '即時計算近 15 分鐘的告警:服務失聯、錯誤率偏高、前端錯誤突增(system);401 / 403 / 429 突增、單一 IP 請求異常、登入失敗突增(security)。',
    gherkin: ['場景: 服務失聯產生告警', '  假如 itapp-api 超過 90 秒沒有心跳也探測失敗', '  當 呼叫 GET /api/observe/alerts', '  那麼 items 包含 category system、severity critical 的「IT 管理系統後端 失聯」'],
    data: obj,
  },
  {
    path: '/api/v1/traffic', gw: '/api/observe/traffic', id: 'observe.traffic.series', perm: 'observe.data.read', summary: 'Nginx 流量時序',
    description: 'Nginx 每分鐘彙總依小時或分鐘加總:請求數、4xx / 5xx、401 / 403 / 429、傳輸量、p95。預設近 24 小時。',
    params: [q('from', 'ISO 時間'), q('to', 'ISO 時間'), q('bucket', 'hour / minute')],
    gherkin: ['場景: 依小時看流量', '  當 呼叫 GET /api/observe/traffic?bucket=hour', '  那麼 每小時一筆,含 total 與 rateLimited'],
    data: list,
  },
  {
    path: '/api/v1/traffic/top-ips', gw: '/api/observe/traffic/top-ips', id: 'observe.traffic.ips', perm: 'observe.data.read', summary: '來源 IP 排行',
    description: '期間內請求數最多的來源 IP(由每分鐘 Top 20 合併,為近似值),含錯誤數與被拒次數。',
    params: [q('from', 'ISO 時間'), q('to', 'ISO 時間'), q('limit', '筆數,最多 100', { type: 'integer' })],
    gherkin: ['場景: 找出異常來源', '  當 呼叫 GET /api/observe/traffic/top-ips?limit=10', '  那麼 回應依 count 由大到小'],
    data: list,
  },
  {
    path: '/api/v1/web/vitals', gw: '/api/observe/web/vitals', id: 'observe.web.vitals', perm: 'observe.data.read', summary: '前端效能',
    description: '各前端各 Web Vitals 指標(LCP、INP、CLS、FCP、TTFB、load)近 N 小時的 p75 與樣本數。',
    params: [q('hours', '小時數,1–168,預設 24', { type: 'integer' })],
    gherkin: ['場景: 前端效能', '  當 呼叫 GET /api/observe/web/vitals', '  那麼 每個前端每個指標一列,含 p75'],
    data: list,
  },
];

function buildOpenApi({ serviceCode = 'observe-api', project = 'giga-observe' } = {}) {
  const paths = {};
  for (const op of OPS) {
    paths[op.path] = paths[op.path] || {};
    paths[op.path].get = {
      operationId: op.id,
      summary: op.summary,
      description: op.description,
      tags: ['架構觀測'],
      parameters: op.params || [],
      'x-permission': op.perm,
      'x-gateway-path': op.gw,
      'x-gherkin': op.gherkin.join('\n'),
      'x-timeout-ms': 15000,
      responses: envelope(op.data),
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'giga-observe 觀測服務', version: pkg.version },
    'x-gateway': { upstream: serviceCode, system: 'observe', project },
    'x-permissions': PERMISSIONS,
    paths,
  };
}

module.exports = { buildOpenApi, PERMISSIONS, OPS };
