// scanner.js —— 云端定时快照扫描器（Node 端运行，无浏览器）
// 职责：每天尾盘(14:30)由服务端跑一次全市场扫描，把「命中」的票写入 public/snapshot.json。
// 数据来源：东方财富 clist(一次性拿全市场行情+主力净流入) + 腾讯 gtimg(K线，仅对预筛票拉取算信号)。
// 注意：本文件为服务端代码，不要被前端直接引入。

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SNAPSHOT_PATHS = {
  stock: path.join(PUBLIC_DIR, 'snapshot_stock.json'),
  cb: path.join(PUBLIC_DIR, 'snapshot_cb.json'),
  etf: path.join(PUBLIC_DIR, 'snapshot_etf.json'),
};
const SNAPSHOT_PATH = SNAPSHOT_PATHS.stock; // 兼容旧引用

// ===== 配置 =====
const MA_PERIOD = 5;        // 均线周期（与前端默认一致）
const MIN_STRENGTH = 0.3;   // 曲率反转强度最小比例(%)，越小越聚焦
const RECENT_DAYS = 5;      // 信号时效窗口（最近 N 个交易日内的拐点算「命中」）
const KLINES = 150;         // 拉取的 K 线根数
const PRE_GATE_CHANGE = 1.5;// 预筛：涨跌幅绝对值 >= 此值 才拉 K 线（控制请求量）
const CONCURRENCY = 6;      // K 线并发
const THROTTLE_MS = 80;     // 每批之间节流

// ===== 纯函数（移植自前端 analyzeStockClient）=====
function getBoard(code) {
  if (/^sh(110|111|113)\d{3}$/.test(code)) return 'cb';
  if (/^sz(123|127|128)\d{3}$/.test(code)) return 'cb';
  if (/^sh(51|56)\d{4}$/.test(code)) return 'etf';
  if (/^sz(15|16)\d{4}$/.test(code)) return 'etf';
  if (/^sz30\d{4}$/.test(code)) return 'cyb';
  if (/^sh(688|689)\d{3}$/.test(code)) return 'kcb';
  return 'main';
}

function calculateMA(closes, period) {
  const ma = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) ma.push(null);
    else { let s = 0; for (let j = i - period + 1; j <= i; j++) s += closes[j]; ma.push(s / period); }
  }
  return ma;
}

function calculateDerivative(ma) {
  const d = [];
  for (let i = 0; i < ma.length; i++) {
    if (i === 0 || ma[i] === null || ma[i - 1] === null) d.push(null);
    else d.push(ma[i] - ma[i - 1]);
  }
  return d;
}

// 与前端 analyzeStockClient 同算法（不含 chartData，详情页按需实时拉）
function analyzeStock(code, name, klineData, maPeriod, minStrength = 0.003) {
  const closes = klineData.map(d => d.close);
  const dates = klineData.map(d => d.date);
  const n = closes.length;
  const ma = calculateMA(closes, maPeriod);
  const derivative = calculateDerivative(ma);
  const curvature = [];
  for (let i = 0; i < derivative.length; i++) {
    if (i === 0 || derivative[i] === null || derivative[i - 1] === null) curvature.push(null);
    else curvature.push(Math.abs(derivative[i] - derivative[i - 1]));
  }
  const signals = [];
  for (let i = 1; i < derivative.length; i++) {
    if (derivative[i] === null || derivative[i - 1] === null) continue;
    let type = null;
    if (derivative[i - 1] < 0 && derivative[i] >= 0) type = 'BUY';
    else if (derivative[i - 1] > 0 && derivative[i] <= 0) type = 'SELL';
    if (!type) continue;
    const cur = curvature[i];
    const priceRef = ma[i] || closes[i] || 1;
    const strengthPct = (cur / priceRef) * 100;
    if (strengthPct < minStrength) continue;
    signals.push({
      index: i, date: dates[i], type, price: closes[i],
      ma: parseFloat(ma[i].toFixed(3)),
      derivative: parseFloat(derivative[i].toFixed(4)),
      prevDerivative: parseFloat(derivative[i - 1].toFixed(4)),
      strength: parseFloat(strengthPct.toFixed(3)),
      desc: type === 'BUY'
        ? `日均线导数在 0 轴处上穿（趋势由降转升，拐点=反转预兆），标记为「入场」关注点（曲率强度 ${strengthPct.toFixed(2)}%）`
        : `日均线导数在 0 轴处下穿（趋势由升转降，拐点=反转预兆），标记为「出场」关注点（曲率强度 ${strengthPct.toFixed(2)}%）`,
    });
  }
  const lastIdx = n - 1;
  const latestMa = ma[lastIdx];
  const latestDerivative = derivative[lastIdx];
  const latestClose = closes[lastIdx];
  let trend = 'FLAT', trendLabel = '横盘';
  if (latestDerivative !== null) {
    if (latestDerivative > 0) { trend = 'UP'; trendLabel = '上行'; }
    else if (latestDerivative < 0) { trend = 'DOWN'; trendLabel = '下行'; }
  }
  const latestSignal = signals.length > 0 ? signals[signals.length - 1] : null;
  let recommendation = '观望', recommendationType = 'HOLD';
  if (latestSignal) {
    const daysSince = lastIdx - latestSignal.index;
    if (latestSignal.type === 'BUY' && daysSince <= 5) { recommendation = '入场·关注'; recommendationType = 'BUY'; }
    else if (latestSignal.type === 'SELL' && daysSince <= 5) { recommendation = '出场·关注'; recommendationType = 'SELL'; }
    else if (latestSignal.type === 'BUY' && latestDerivative > 0) { recommendation = '持有观察'; recommendationType = 'HOLD'; }
    else if (latestSignal.type === 'SELL' && latestDerivative < 0) { recommendation = '观望观察'; recommendationType = 'HOLD'; }
  }
  return {
    code, name, maPeriod, board: getBoard(code),
    lastClose: parseFloat(latestClose.toFixed(2)),
    latestMa: latestMa !== null ? parseFloat(latestMa.toFixed(3)) : null,
    latestDerivative: latestDerivative !== null ? parseFloat(latestDerivative.toFixed(4)) : null,
    trend, trendLabel, latestSignal, recommendation, recommendationType,
    signalDate: latestSignal ? latestSignal.date : null,
    signalDaysAgo: latestSignal ? lastIdx - latestSignal.index : null,
    signalCount: signals.length, signals: signals.slice(-10),
  };
}

// ===== 易经八卦（娱乐标签，与前端一致）=====
const HEXAGRAMS = [
  { g: '乾', t: '多', r: '强势上攻之象：趋势向上、量价配合，宜顺势关注' },
  { g: '坤', t: '观', r: '厚载蓄势之象：横盘整理、换手沉淀，适合持有观望' },
  { g: '屯', t: '观', r: '底部震荡之象：方向未明、反复磨底，宜轻仓试探' },
  { g: '蒙', t: '观', r: '信息不明之象：逻辑待验证，不宜盲目冒进' },
  { g: '需', t: '观', r: '缩量等待之象：时机未到、观望情绪浓，宜耐心' },
  { g: '讼', t: '空', r: '多空分歧之象：争执加剧、获利盘松动，易现回调' },
  { g: '师', t: '多', r: '资金集结之象：主力主导、筹码归集，或有行情' },
  { g: '比', t: '多', r: '跟涨强势之象：借势上行、领涨板块，宜顺势' },
  { g: '小畜', t: '观', r: '小幅回升之象：积少成多、慢热爬坡，不追急' },
  { g: '履', t: '观', r: '高位谨慎之象：欲进需稳，宜控仓、步步为营' },
  { g: '泰', t: '多', r: '趋势顺畅之象：多空和谐、通道完好，顺势而为' },
  { g: '否', t: '空', r: '低迷盘整之象：闭塞不畅、量能萎缩，宜防守' },
  { g: '同人', t: '多', r: '板块共振之象：协同上行、人气聚集，宜跟随' },
  { g: '大有', t: '多', r: '丰收兑现之象：盈利可观，宜落袋为安、不恋战' },
  { g: '谦', t: '观', r: '低调蓄势之象：不追高、稳健布局，等风口' },
  { g: '豫', t: '观', r: '蓄势待发之象：尚未启动、埋伏为主，不急躁' },
  { g: '随', t: '观', r: '跟随趋势之象：灵活应变、不逆势，顺水推舟' },
  { g: '蛊', t: '空', r: '整理风险之象：积弊待清、洗盘概率大，宜防守' },
  { g: '临', t: '多', r: '行情临近之象：拐点将现、异动初显，值得关注' },
  { g: '观', t: '观', r: '静观其变之象：方向未定，先看后动、不猜顶底' },
  { g: '噬嗑', t: '空', r: '遇阻震荡之象：需放量突破，否则易回落' },
  { g: '贲', t: '观', r: '表面繁荣之象：注意虚高、防诱多，看实质' },
  { g: '剥', t: '空', r: '阴跌下行之象：重心逐步下移，宜减仓避险' },
  { g: '复', t: '多', r: '触底回升之象：一阳来复、拐点可期，逢低关注' },
  { g: '无妄', t: '观', r: '不乱作为之象：顺其自然、不在震荡中折腾' },
  { g: '大畜', t: '多', r: '蓄力待发之象：中线逻辑在、逢低布局正当时' },
  { g: '颐', t: '观', r: '休整蓄能之象：休养生息、等待催化再出发' },
  { g: '大过', t: '空', r: '风险偏大之象：波动加剧、决策需审慎、控仓位' },
  { g: '坎', t: '空', r: '下行风险之象：险陷重重、资金谨慎，宜避险' },
  { g: '离', t: '多', r: '放量上行之象：光明附势、人气旺盛，宜持有' },
  { g: '咸', t: '多', r: '资金共振之象：感应交心、异动频现，或有戏' },
  { g: '恒', t: '多', r: '趋势延续之象：恒久向上、主升未改，宜持有' },
  { g: '遁', t: '空', r: '逢高减仓之象：盛极当退、落袋为安，不贪尾段' },
  { g: '大壮', t: '多', r: '强势过热之象：壮盛当头、防回撤，冲高需警惕' },
  { g: '晋', t: '多', r: '上攻升进之象：稳步抬升、台阶上行，宜跟进' },
  { g: '明夷', t: '空', r: '回调受伤之象：韬光养晦、暂避锋芒，等企稳' },
  { g: '家人', t: '观', r: '内部稳定之象：看基本面与业绩，价值待显' },
  { g: '睽', t: '空', r: '背离之象：量价/指标顶背离，注意反转风险' },
  { g: '蹇', t: '空', r: '上行受阻之象：遇阻回踩、动能不足，宜观望' },
  { g: '解', t: '多', r: '利空出尽之象：险难消解、缓和回升，宜低吸' },
  { g: '损', t: '空', r: '回调节制之象：损下益上、整理未完，宜收缩' },
  { g: '益', t: '多', r: '利好提振之象：损上益下、资金流入，上行可期' },
  { g: '夬', t: '多', r: '突破在即之象：果决向上、缺口将补，宜跟进' },
  { g: '姤', t: '观', r: '突发行情之象：不期而遇、防微杜渐，不追消息' },
  { g: '萃', t: '多', r: '资金聚集之象：热点荟萃、抱团取暖，人气旺' },
  { g: '升', t: '多', r: '稳步上行之象：旭日升腾、通道完好，宜持有' },
  { g: '困', t: '空', r: '低位盘整之象：困顿受限、等待援军与催化' },
  { g: '井', t: '观', r: '价值修复之象：慢牛井养、长线逻辑，宜拿住' },
  { g: '革', t: '多', r: '变盘之象：革故鼎新、新趋势将起，留意转势' },
  { g: '鼎', t: '多', r: '企稳回升之象：鼎新图变、震荡向上，宜低吸' },
  { g: '震', t: '空', r: '波动加大之象：震仓洗盘、急拉急跌，宜稳' },
  { g: '艮', t: '观', r: '见顶滞涨之象：适可而止、放量滞涨宜止盈' },
  { g: '渐', t: '多', r: '温和上行之象：循序渐进、按部就班，拿得住' },
  { g: '归妹', t: '观', r: '时机性行情之象：顺理而行、不勉强追涨' },
  { g: '丰', t: '多', r: '放量盛势之象：丰大光明、防盛极而衰，冲高出' },
  { g: '旅', t: '观', r: '短线波动之象：行旅在外、快进快出，不恋战' },
  { g: '巽', t: '多', r: '顺势慢涨之象：谦顺致远、渗透式上行，宜跟' },
  { g: '兑', t: '多', r: '乐观活跃之象：和悦相通、量价齐升，情绪好' },
  { g: '涣', t: '空', r: '分歧涣散之象：散而难聚、资金分流，注意回落' },
  { g: '节', t: '观', r: '控仓有度之象：节制中正、不贪不惧，守纪律' },
  { g: '中孚', t: '多', r: '信心恢复之象：诚信企稳、预期改善，宜布局' },
  { g: '小过', t: '观', r: '小幅波动之象：谨小慎微、不追涨杀跌' },
  { g: '既济', t: '多', r: '行情兑现之象：事已成济、防高位回落，分批出' },
  { g: '未济', t: '观', r: '未完待续之象：慎终如始、留有余地，谨慎持有' },
];

function computeHexagram(code, listDate, today) {
  const codeNum = parseInt((code || '').replace(/\D/g, ''), 10) || 0;
  const ld = listDate ? Date.parse(listDate.replace(/-/g, '/')) : 0;
  const td = today ? Date.parse(today.replace(/-/g, '/')) : Date.now();
  const days = Math.max(0, Math.floor((td - ld) / 86400000));
  let digitSum = 0; String(codeNum).split('').forEach(d => { digitSum += (+d); });
  const idx = ((codeNum + days + digitSum) % 64 + 64) % 64;
  const h = HEXAGRAMS[idx];
  return { g: h.g, r: h.r, t: h.t, idx, codeNum, days, digitSum, listDate: listDate || '', today: today || '' };
}

// ===== 抓取工具 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 9000);
  try {
    const r = await fetch(url, { headers: opts.headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

function parseGtimgKline(json, code) {
  const sd = json.data && json.data[code];
  const k = sd && (sd.qfqday || sd.day);
  if (!k || !k.length) return null;
  return k.map(it => ({
    date: it[0],
    open: parseFloat(it[1]), close: parseFloat(it[2]),
    high: parseFloat(it[3]), low: parseFloat(it[4]),
    volume: parseFloat(it[5]) || 0,
  })).filter(x => !isNaN(x.close));
}

async function fetchKline(code, count = KLINES) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const primary = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`;
  const sina = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=5&datalen=${count}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetchJson(primary, { headers: { 'User-Agent': ua } });
    if (r) { const k = parseGtimgKline(r, code); if (k) return k; }
    await sleep(300 * (i + 1));
  }
  for (let i = 0; i < 2; i++) {
    const r = await fetchJson(sina, { headers: { 'User-Agent': ua } });
    if (r && Array.isArray(r)) {
      const k = r.map(it => ({
        date: it.day, open: parseFloat(it.open), close: parseFloat(it.close),
        high: parseFloat(it.high), low: parseFloat(it.low), volume: parseFloat(it.volume) || 0,
      })).filter(x => !isNaN(x.close));
      if (k.length) return k;
    }
    await sleep(300 * (i + 1));
  }
  return null;
}

// ===== 行情列表：腾讯 gtimg 批量行情（恒可达）为主，东方财富仅做资金流/市盈率增强（可达时）=====
function getCodeGroups(type) {
  if (type === 'cb') return [
    { market: 'sh', start: 110000, end: 113999 },
    { market: 'sz', start: 123000, end: 128999 },
  ];
  if (type === 'etf') return [
    { market: 'sh', start: 510000, end: 519999 },
    { market: 'sh', start: 560000, end: 569999 },
    { market: 'sz', start: 159000, end: 159999 },
    { market: 'sz', start: 160000, end: 169999 },
  ];
  return [
    { market: 'sh', start: 600000, end: 603999 },
    { market: 'sh', start: 605000, end: 605999 },
    { market: 'sh', start: 688000, end: 689999 },
    { market: 'sz', start: 1, end: 3999 },
    { market: 'sz', start: 300001, end: 301999 },
  ];
}
function genCodes(groups) {
  const codes = [];
  for (const g of groups) for (let i = g.start; i <= g.end; i++) codes.push(g.market + String(i).padStart(6, '0'));
  return codes;
}

// gtimg v_ 字段（实测下标）：[1]名称 [3]现价 [4]昨收 [32]涨跌幅% [38]换手% [43]量比 [44]总市值(亿)
async function fetchGtimgBatch(codes) {
  let text = '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://qt.gtimg.cn/q=${codes.join(',')}`);
    const buf = await r.arrayBuffer();
    text = new TextDecoder('gbk').decode(buf);
  } catch (e) { /* 单批失败忽略 */ }
  finally { clearTimeout(t); }

  const out = [];
  for (const line of text.split(';')) {
    const m = line.match(/v_(\w+)="([^"]+)"/);
    if (!m) continue;
    const arr = m[2].split('~');
    const name = (arr[1] || '').trim();
    if (!name || /退/.test(name)) continue;
    const price = parseFloat(arr[3]);
    if (isNaN(price)) continue;
    out.push({
      code: m[1], name,
      price,
      changePct: parseFloat(arr[32]) || 0,
      turnover: parseFloat(arr[38]) || null,
      volumeRatio: parseFloat(arr[43]) || null,
      marketCap: parseFloat(arr[44]) || null,
      flow: null, pe: null,
    });
  }
  return out;
}

// 东方财富增强：一次拿全市场主力净流入(f62)+市盈率(f9)，可达时按代码合并；不可达则静默跳过
async function enrichWithEastMoney(quotes) {
  const map = new Map(quotes.map(q => [q.code, q]));
  const fs2 = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs2}&fields=f12,f13,f62,f9`;
  const j = await fetchJson(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
  if (!j || !j.data || !j.data.diff) return;
  for (const d of j.data.diff) {
    const code = (d.f13 === 1 ? 'sh' : 'sz') + d.f12;
    const q = map.get(code);
    if (!q) continue;
    if (d.f62 != null && !isNaN(d.f62)) q.flow = +d.f62;
    if (d.f9 != null && !isNaN(d.f9)) q.pe = +d.f9;
  }
}

async function getAllQuotes(type = 'stock') {
  const codes = genCodes(getCodeGroups(type));
  const quotes = [];
  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    const q = await fetchGtimgBatch(batch);
    quotes.push(...q);
    await sleep(20);
  }
  await enrichWithEastMoney(quotes);
  return quotes;
}

// ===== 主扫描 =====
async function runScan(opts = {}) {
  const scanType = (opts && opts.type) || 'stock';
  const quotes = await getAllQuotes(scanType);
  if (!quotes.length) throw new Error('行情列表获取失败（可能网络受限）');

  // 交易日（仅作快照标记，调度在 server.js 里判断）
  const tradeDate = new Date().toISOString().slice(0, 10);

  // 预筛：只对有潜在信号/资金流入的票拉 K 线，控制请求总量
  const cands = quotes.filter(q =>
    Math.abs(q.changePct) >= PRE_GATE_CHANGE || (q.flow != null && q.flow > 0)
  );

  const hits = [];
  for (let i = 0; i < cands.length; i += CONCURRENCY) {
    const batch = cands.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (q) => {
      const kline = await fetchKline(q.code, KLINES);
      if (!kline || kline.length < MA_PERIOD + 2) return null;
      const a = analyzeStock(q.code, q.name, kline, MA_PERIOD, MIN_STRENGTH);
      // 命中：近 RECENT_DAYS 个交易日内出现均线导数拐点信号
      if (a.latestSignal && a.signalDaysAgo != null && a.signalDaysAgo <= RECENT_DAYS) {
        const hex = computeHexagram(q.code, kline[0] && kline[0].date, tradeDate);
        return {
          code: q.code, name: q.name, board: getBoard(q.code),
          lastClose: q.price, changePct: q.changePct,
          latestMa: a.latestMa, latestDerivative: a.latestDerivative,
          trend: a.trend, trendLabel: a.trendLabel,
          recommendation: a.recommendation, recommendationType: a.recommendationType,
          latestSignal: a.latestSignal, signalDaysAgo: a.signalDaysAgo, signalDate: a.signalDate,
          signals: a.signals, maPeriod: MA_PERIOD,
          flow: q.flow, turnover: q.turnover, pe: q.pe, volumeRatio: q.volumeRatio, marketCap: q.marketCap,
          hexagram: { g: hex.g, t: hex.t, r: hex.r, listDate: hex.listDate },
          reasons: [a.latestSignal.type === 'BUY' ? 'signal-buy' : 'signal-sell'],
        };
      }
      return null;
    }));
    hits.push(...results.filter(Boolean));
    await sleep(THROTTLE_MS);
    if (opts.onProgress) opts.onProgress(hits.length, i + batch.length, cands.length);
  }

  // 排序：信号日期倒序，同日期强度高在前
  hits.sort((a, b) => {
    if (a.signalDate !== b.signalDate) return (b.signalDate || '').localeCompare(a.signalDate || '');
    return (b.latestSignal ? b.latestSignal.strength : 0) - (a.latestSignal ? a.latestSignal.strength : 0);
  });

  const snap = {
    type: scanType,
    updatedAt: new Date().toISOString(),
    tradeDate,
    isTail: true,
    recentDays: RECENT_DAYS,
    maPeriod: MA_PERIOD,
    minStrength: MIN_STRENGTH,
    count: hits.length,
    source: '腾讯行情 + 东方财富资金流（服务端聚合）',
    note: '尾盘 14:30 云端快照，数据为盘中数据，仅供研究参考，不构成任何投资建议。',
    stocks: hits,
  };
  fs.writeFileSync(SNAPSHOT_PATHS[scanType], JSON.stringify(snap));
  return snap;
}

module.exports = { runScan, getAllQuotes, computeHexagram, SNAPSHOT_PATHS };

// 直接 `node scanner.js [stock|cb|etf]` 可运行一次（便于本地/手动生成；缺省扫全部三类）
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    const types = arg ? [arg] : ['stock', 'cb', 'etf'];
    for (const type of types) {
      console.log(`[scanner] 开始扫描 ${type}...`);
      const t0 = Date.now();
      const snap = await runScan({ type, onProgress: (h, i, n) => console.log(`  命中 ${h} / 已扫 ${i}/${n}`) });
      console.log(`[scanner] ${type} 完成，命中 ${snap.count} 只，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${SNAPSHOT_PATHS[type]}`);
    }
    console.log('[scanner] 全部完成');
  })().catch(e => { console.error('[scanner] 失败:', e.message); process.exit(1); });
}
