// server.js —— 一体后端（静态托管 + 资金流代理 + 尾盘定时快照）
// 运行： node server.js   （监听 PORT，默认 8787）
// 职责：
//   1) 托管 public/ 下的 H5（index.html / app.js / style.css / snapshot.json）
//   2) /api/flow?code=  服务端代理东方财富主力资金流（绕开浏览器 CORS）
//   3) /api/snapshot    返回最新快照（也直接用静态 /snapshot.json 访问）
//   4) POST /api/refresh 手动触发一次全市场扫描并写快照
//   5) 进程内调度：每天 14:30（本地）若为交易日则自动扫描一次
//
// 部署说明：本服务需常驻运行（云主机 / 云函数常驻 / 本机常开）。CloudStudio 纯静态托管无法运行 Node，
// 故「云端每日自动刷新」建议由常驻 Node 或定时任务触发；本仓库也提供「本地跑 scanner.js + 重新部署静态站点」的方案。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runScan, SNAPSHOT_PATHS } = require('./scanner');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SNAPSHOT_PATH = path.join(PUBLIC_DIR, 'snapshot.json');
const PORT = process.env.PORT || 8787;

// ===== 静态文件 =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  // 防目录穿越
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ===== 资金流代理（东方财富，服务端取数绕开 CORS）=====
function flowSecid(code) {
  const num = (code || '').replace(/^[a-zA-Z]+/, '');
  const mkt = (code || '').toLowerCase().startsWith('sh') ? '1' : '0';
  return `${mkt}.${num}`;
}
async function fetchFlowServer(code) {
  const secid = flowSecid(code);
  const base = `lmt=1&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62`;
  const urls = [
    `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?${base}`,
    `https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?${base}`,
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${base}`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Referer: 'https://quote.eastmoney.com/' } });
      const j = await r.json();
      if (j && j.data && j.data.klines && j.data.klines.length) {
        const main = parseFloat(j.data.klines[0].split(',')[1]);
        if (!isNaN(main)) return main;
      }
    } catch (e) { /* 尝试下一个端点 */ }
  }
  return null;
}

// ===== 交易日判断 =====
// 周末跳过；节假日跳过（下方为 2026 年主要节假日，请按需更新；宁可漏判也不要错杀交易日）。
const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-22',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);
function isTradingDay(d = new Date()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return !HOLIDAYS.has(ymd);
}

let scanning = false;
async function doScan(res) {
  if (scanning) {
    if (res) { res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'scanning', msg: '正在扫描中' })); }
    return;
  }
  scanning = true;
  try {
    const summary = [];
    for (const type of ['stock', 'cb', 'etf']) {
      const snap = await runScan({ type });
      summary.push(`${type}:${snap.count}`);
    }
    console.log(`[scan] 完成 [${summary.join(' ')}]`);
    if (res) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, summary })); }
  } catch (e) {
    console.error('[scan] 失败:', e.message);
    if (res) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
  } finally { scanning = false; }
}

// 每天 14:30 检查一次（每分钟轮询）
function schedule() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 14 && now.getMinutes() === 30) {
      if (isTradingDay(now)) {
        console.log('[schedule] 14:30 交易日，触发扫描');
        doScan(null);
      } else {
        console.log('[schedule] 14:30 非交易日，跳过');
      }
    }
  }, 60 * 1000);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/flow') {
    const code = url.searchParams.get('code') || '';
    let flow = null;
    try { flow = await fetchFlowServer(code); } catch (e) { flow = null; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ code, flow }));
  }

  if (url.pathname === '/api/snapshot') {
    return fs.readFile(SNAPSHOT_PATH, (e, d) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'no snapshot' })); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(d);
    });
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    return doScan(res);
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`[server] 监听 http://localhost:${PORT}`);
  schedule();
  // 启动时若任一快照缺失则生成一次，便于部署后立即有数据
  const missing = ['stock', 'cb', 'etf'].filter(t => !fs.existsSync(SNAPSHOT_PATHS[t]));
  if (missing.length) {
    console.log(`[server] 未检测到快照(${missing.join(',')})，启动时生成一次...`);
    doScan(null);
  }
});
