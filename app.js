// ============ 全局状态 ============
let stockPool = [];
let scanResults = [];
// 屏蔽退市 / 长期停牌股（默认开；true=剔除名称含"退"且 K 线最新交易日过旧者）
let blockDelisted = localStorage.getItem('sg_blockDelisted') !== '0';
let includeFlow = localStorage.getItem('sg_includeFlow') !== '0';
let flowOnlyIn = localStorage.getItem('sg_flowOnlyIn') === '1';
let currentFilter = 'all';
let currentType = 'stock';        // stock | cb | etf
let currentBoardFilter = 'all';   // all | main | cyb | kcb（仅 A股）
let klineChartInstance = null;
let derivativeChartInstance = null;

const DEFAULT_STOCKS = [
  { code: 'sz000001', name: '平安银行' },
  { code: 'sh600519', name: '贵州茅台' },
  { code: 'sz300750', name: '宁德时代' },
  { code: 'sz002594', name: '比亚迪' },
  { code: 'sh600036', name: '招商银行' },
  { code: 'sh601318', name: '中国平安' },
  { code: 'sz000858', name: '五粮液' },
  { code: 'sh601012', name: '隆基绿能' },
  { code: 'sz002475', name: '立讯精密' },
  { code: 'sz300015', name: '爱尔眼科' },
  { code: 'sh600276', name: '恒瑞医药' },
  { code: 'sz000063', name: '中兴通讯' },
  { code: 'sz002230', name: '科大讯飞' },
  { code: 'sh600887', name: '伊利股份' },
  { code: 'sz000725', name: '京东方A' },
  { code: 'sh601899', name: '紫金矿业' },
  { code: 'sz002415', name: '海康威视' },
  { code: 'sh600031', name: '三一重工' },
  { code: 'sz300059', name: '东方财富' },
  { code: 'sh601398', name: '工商银行' },
];

// 可转债默认池
const DEFAULT_BONDS = [
  { code: 'sh113053', name: '隆22转债' },
  { code: 'sh113021', name: '中信转债' },
  { code: 'sz123006', name: '东财转债' },
  { code: 'sh110059', name: '浦发转债' },
  { code: 'sz128111', name: '中矿转债' },
];

// ETF 默认池
const DEFAULT_ETFS = [
  { code: 'sh510300', name: '沪深300ETF' },
  { code: 'sz159915', name: '创业板ETF' },
  { code: 'sh510500', name: '中证500ETF' },
  { code: 'sh588000', name: '科创50ETF' },
  { code: 'sz159995', name: '芯片ETF' },
];

function getDefaultPool(type) {
  if (type === 'cb') return DEFAULT_BONDS;
  if (type === 'etf') return DEFAULT_ETFS;
  return DEFAULT_STOCKS;
}

// ============ 客户端数据层：直连腾讯金融 API（无需后端） ============
// 腾讯 qt.gtimg.cn / ifzq.gtimg.cn 均已开启 CORS(Access-Control-Allow-Origin: *)，浏览器可直接调用

// 板块/品种分类：cyb=创业板 kcb=科创板 main=主板 cb=可转债 etf=ETF
function getBoard(code) {
  if (/^sh(110|111|113)\d{3}$/.test(code)) return 'cb';
  if (/^sz(123|127|128)\d{3}$/.test(code)) return 'cb';
  if (/^sh(51|56)\d{4}$/.test(code)) return 'etf';
  if (/^sz(15|16)\d{4}$/.test(code)) return 'etf';
  if (/^sz30\d{4}$/.test(code)) return 'cyb';
  if (/^sh(688|689)\d{3}$/.test(code)) return 'kcb';
  return 'main';
}

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
  for (const g of groups) {
    for (let i = g.start; i <= g.end; i++) codes.push(g.market + String(i).padStart(6, '0'));
  }
  return codes;
}

// 客户端全市场列表缓存
const listCache = { stock: null, cb: null, etf: null };

async function fetchKlineClient(code, count = 150) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const primary = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`;
  const sina = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=5&datalen=${count}`;
  const tryOnce = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': ua }, signal: ctrl.signal });
      if (!resp.ok) return null;
      const json = await resp.json();
      const sd = json.data && json.data[code];
      if (sd) {
        const kline = sd.qfqday || sd.day;
        if (kline && kline.length > 0) {
          return kline.map(item => ({
            date: item[0],
            open: parseFloat(item[1]), close: parseFloat(item[2]),
            high: parseFloat(item[3]), low: parseFloat(item[4]),
            volume: parseFloat(item[5]) || 0,
          }));
        }
      }
      return null;
    } catch (e) { return null; } finally { clearTimeout(timer); }
  };
  // 限流 / 超时兜底：主接口重试 3 次，仍失败再用新浪兜底 2 次，显著提升全市场扫描成功率
  for (let i = 0; i < 3; i++) { const r = await tryOnce(primary); if (r) return r; await new Promise(s => setTimeout(s, 300 * (i + 1))); }
  for (let i = 0; i < 2; i++) { const r = await tryOnce(sina); if (r) return r; await new Promise(s => setTimeout(s, 300 * (i + 1))); }
  return null;
}

// qt.gtimg.cn 返回 GBK，需用 TextDecoder('gbk') 解码
async function fetchQuoteClient(code) {
  try {
    const resp = await fetch(`https://qt.gtimg.cn/q=${code}`);
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const match = text.match(/v_\w+="([^"]+)"/);
    if (!match) return null;
    const parts = match[1].split('~');
    return { name: (parts[1] || code).trim(), price: parseFloat(parts[3]) || 0 };
  } catch (e) { return null; }
}

function calculateMAClient(closes, period) {
  const ma = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) ma.push(null);
    else { let s = 0; for (let j = i - period + 1; j <= i; j++) s += closes[j]; ma.push(s / period); }
  }
  return ma;
}

function calculateDerivativeClient(ma) {
  const d = [];
  for (let i = 0; i < ma.length; i++) {
    if (i === 0 || ma[i] === null || ma[i - 1] === null) d.push(null);
    else d.push(ma[i] - ma[i - 1]);
  }
  return d;
}

function analyzeStockClient(code, name, klineData, maPeriods, primaryPeriod, minStrength = 0.003) {
  const closes = klineData.map(d => d.close);
  const dates = klineData.map(d => d.date);
  const n = closes.length;
  const periods = Array.isArray(maPeriods) ? maPeriods : [maPeriods];
  const maLines = {};
  periods.forEach(p => { maLines[p] = calculateMAClient(closes, p); });
  const maPeriod = primaryPeriod;
  const ma = maLines[maPeriod];
  const derivative = calculateDerivativeClient(ma);
  const curvature = [];
  for (let i = 0; i < derivative.length; i++) {
    if (i === 0 || derivative[i] === null || derivative[i - 1] === null) curvature.push(null);
    else curvature.push(Math.abs(derivative[i] - derivative[i - 1]));
  }
  const signals = [];
  for (let i = 1; i < derivative.length; i++) {
    if (derivative[i] === null || derivative[i - 1] === null) continue;
    let type = null;
    // 信号锁定在「趋势 = 0」的拐点：导数上穿 / 下穿 0 轴（最早的反转预兆），而非等明显转正负后才提示
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
    // 入场 / 出场 仅表示「开始关注」的时点，不构成真实交易建议
    if (latestSignal.type === 'BUY' && daysSince <= 5) { recommendation = '入场·关注'; recommendationType = 'BUY'; }
    else if (latestSignal.type === 'SELL' && daysSince <= 5) { recommendation = '出场·关注'; recommendationType = 'SELL'; }
    else if (latestSignal.type === 'BUY' && latestDerivative > 0) { recommendation = '持有观察'; recommendationType = 'HOLD'; }
    else if (latestSignal.type === 'SELL' && latestDerivative < 0) { recommendation = '观望观察'; recommendationType = 'HOLD'; }
  }
  const chartData = {
    dates, opens: klineData.map(d => d.open), closes,
    maLines: (() => { const o = {}; for (const p in maLines) o[p] = maLines[p].map(v => (v !== null ? parseFloat(v.toFixed(3)) : null)); return o; })(),
    ma: ma.map(v => (v !== null ? parseFloat(v.toFixed(3)) : null)),
    derivative: derivative.map(v => (v !== null ? parseFloat(v.toFixed(4)) : null)),
    highs: klineData.map(d => d.high), lows: klineData.map(d => d.low),
    volumes: klineData.map(d => d.volume),
  };
  return {
    code, name, maPeriod, board: getBoard(code),
    lastDate: dates[lastIdx], lastClose: parseFloat(latestClose.toFixed(2)),
    latestMa: latestMa !== null ? parseFloat(latestMa.toFixed(3)) : null,
    latestDerivative: latestDerivative !== null ? parseFloat(latestDerivative.toFixed(4)) : null,
    trend, trendLabel, latestSignal, recommendation, recommendationType,
    // 信号距最新交易日的天数（0=最新交易日当天出现），用于「信号日期」筛选
    signalDate: latestSignal ? latestSignal.date : null,
    signalDaysAgo: latestSignal ? lastIdx - latestSignal.index : null,
    signalCount: signals.length, signals: signals.slice(-10), chartData,
  };
}

// 判断是否退市 / 长期停牌：名称含"退"字，或 K 线最新交易日距今天数过长（>60 天）
function isDelistedStock(s, kline) {
  const nm = (s && s.name ? s.name : '').trim();
  if (nm.startsWith('退') || nm.includes('退市')) return true;
  if (kline && kline.length) {
    const last = kline[kline.length - 1];
    if (last && last.date) {
      const t = new Date(last.date.replace(/-/g, '/')).getTime();
      if (!isNaN(t) && (Date.now() - t) / 86400000 > 60) return true;
    }
  }
  return false;
}

// ============ 资金流向 & 易经八卦（娱乐）辅助 ============
// 东方财富主力资金流接口（已验证 CORS 对云端域名开放），纯前端可直连
function flowSecid(code) {
  const num = (code || '').replace(/^[a-zA-Z]+/, '');
  const mkt = (code || '').toLowerCase().startsWith('sh') ? '1' : '0';
  return `${mkt}.${num}`;
}
// 资金流代理（可选）：浏览器直连东方财富会被跨域拦截，配置自建后端代理（如 news-proxy 的 /api/flow 部署到 https 域名）后可稳定取数。
const FLOW_PROXY = '';
// 公共 CORS 代理（仅单只股票详情兜底用，非生产级，可能不稳定）
const FLOW_PUBLIC_PROXY = 'https://api.allorigins.win/raw?url=';

async function fetchFlowOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, signal: ctrl.signal });
    const j = await r.json();
    if (j && j.data && j.data.klines && j.data.klines.length) {
      const parts = j.data.klines[0].split(',');
      const main = parseFloat(parts[1]); // f52 = 主力净流入额(元) = 大单净额 + 特大单净额
      if (!isNaN(main)) return main;
    }
  } catch (e) { /* 跨域 / 限流 / 超时，忽略 */ }
  finally { clearTimeout(t); }
  return null;
}

// 主力净流入（元）。allowProxy=false 用于全市场扫描（快速失败不拖慢）；
// allowProxy=true 用于单只股票详情（被跨域拦截时走代理兜底）。
async function fetchFlow(code, opts = {}) {
  const allowProxy = !!opts.allowProxy;
  const secid = flowSecid(code);
  const base = `lmt=1&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62`;
  const directUrls = [
    `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?${base}`,   // 当前可用的端点
    `https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?${base}`, // 旧端点的兜底
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${base}`
  ];
  for (const u of directUrls) {
    const v = await fetchFlowOnce(u);
    if (typeof v === 'number') return v;
  }
  // 浏览器端被跨域拦截时，走代理兜底（仅单只股票详情启用，避免全市场扫描被拖慢）
  if (allowProxy) {
    if (FLOW_PROXY) {
      try {
        const r = await fetch(`${FLOW_PROXY}?code=${encodeURIComponent(code)}`);
        const j = await r.json();
        if (typeof j.flow === 'number') return j.flow;
      } catch (e) { /* 忽略 */ }
    }
    if (FLOW_PUBLIC_PROXY) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 9000);
        const r = await fetch(FLOW_PUBLIC_PROXY + encodeURIComponent(directUrls[0]), { signal: ctrl.signal });
        const j = JSON.parse(await r.text());
        if (j && j.data && j.data.klines && j.data.klines.length) {
          const main = parseFloat(j.data.klines[0].split(',')[1]);
          if (!isNaN(main)) return main;
        }
        clearTimeout(t);
      } catch (e) { /* 忽略 */ }
    }
  }
  return null;
}
function fmtMoney(yuan) {
  if (yuan === null || yuan === undefined || isNaN(yuan)) return '-';
  const v = Math.abs(yuan);
  const sign = yuan >= 0 ? '+' : '-';
  if (v >= 1e8) return sign + (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return sign + (v / 1e4).toFixed(1) + '万';
  return sign + v.toFixed(0);
}

// 易经八卦（娱乐标签）：基于「上市时间 + 股票代码 + 当日日期」的确定性映射，仅供娱乐，不构成任何建议
// 易经八卦娱乐标签：卦辞已改写为「股市观测语境」的隐喻解读（仅供娱乐，不构成建议）。
// t = 倾向标签：多(偏多/上行预期) / 空(偏空/回落预期) / 观(中性观望)
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
  // 返回推导要素，供「卜卦解析」弹窗逐步说明算法来源
  return { g: h.g, r: h.r, t: h.t, idx, codeNum, days, digitSum, listDate: listDate || '', today: today || '' };
}

// 卜卦解析弹窗：逐步说明「卦象结果如何得到」（确定性演算，仅供娱乐）
function openHexModal(code, listDate) {
  const hexModal = document.getElementById('hexModal');
  if (!hexModal) return;
  const today = new Date().toISOString().slice(0, 10);
  const h = computeHexagram(code, listDate, today);
  document.getElementById('hexModalTitle').textContent = `📿 运势卦象解析 · ${code}`;
  const ld = h.listDate || '未知（无上市日期时使用当日，结果仍确定）';
  document.getElementById('hexModalBody').innerHTML = `
    <p class="hex-note">易经八卦娱乐标签：结合「股票代码、上市日期、当日日期」做<b>确定性</b>演算——同一只股票同一天结果固定、不同天会变化。以下逐步展示卦象是怎么算出来的。<b>仅供娱乐，不构成任何投资建议。</b></p>
    <ol class="hex-steps">
      <li><b>输入</b>：代码 <code>${code}</code> · 上市日期 <code>${ld}</code> · 当日 <code>${today}</code></li>
      <li><b>取代码中的数字</b>：<code>${code}</code> → 数字串 <code>${h.codeNum}</code></li>
      <li><b>代码各位数字之和</b>：<code>${h.digitSum}</code></li>
      <li><b>上市到今日经历的天数</b>：<code>${h.days}</code> 天</li>
      <li><b>三者相加后对 64 取余</b>：(<code>${h.codeNum}</code> ＋ <code>${h.days}</code> ＋ <code>${h.digitSum}</code>) mod 64 ＝ <code>${h.idx}</code></li>
      <li><b>对应《易经》六十四卦</b>：序号 <code>${h.idx}</code> → 第 <code>${h.idx + 1}</code> 卦 → <b>${h.g}卦</b></li>
    </ol>
    <div class="hex-result"><span class="hex-result-g">${h.g}卦</span><span class="hex-tag-t ${h.t === '多' ? 'hex-t-up' : h.t === '空' ? 'hex-t-down' : 'hex-t-mid'}">${h.t === '多' ? '偏多 📈' : h.t === '空' ? '偏空 📉' : '中性观望 ⚖️'}</span><span class="hex-result-r">${h.r}</span></div>
    <p class="hex-note">以上「偏多/偏空/观望」仅为把六十四卦原始卦义<b>借喻到股市情绪与趋势的娱乐化映射</b>，与真实行情无因果关系，<b>绝不构成任何买卖建议</b>。</p>
  `;
  hexModal.classList.add('active');
}

// 生成全市场列表（客户端遍历代码段 + 腾讯 qt 批量验证取名称）
async function buildListClient(type) {
  if (listCache[type]) return listCache[type];
  const codes = genCodes(getCodeGroups(type));
  const stocks = [];
  const batchSize = 100;
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    try {
      let buf = null;
      for (let i = 0; i < 3; i++) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          const resp = await fetch(`https://qt.gtimg.cn/q=${batch.join(',')}`, { signal: ctrl.signal });
          buf = await resp.arrayBuffer();
          clearTimeout(timer);
          break;
        } catch (e) { if (i < 2) await new Promise(s => setTimeout(s, 300 * (i + 1))); }
      }
      if (!buf) continue;
      const text = new TextDecoder('gbk').decode(buf);
      const lines = text.split(';').filter(l => l.trim());
      for (const line of lines) {
        const m = line.match(/v_(\w+)="([^"]+)"/);
        if (!m) continue;
        const c = m[1];
        const parts = m[2].split('~');
        if (parts.length >= 2 && parts[1] && parts[1].trim() !== '') {
          const nm = parts[1].trim();
          // 屏蔽退市 / 长期停牌：名称含"退"字直接跳过
          if (blockDelisted && (nm.startsWith('退') || nm.includes('退市'))) continue;
          stocks.push({ code: c, name: nm, board: getBoard(c) });
        }
      }
    } catch (e) { /* 忽略单批失败 */ }
  }
  listCache[type] = stocks;
  return stocks;
}

// 批量分析（客户端，温和并发 + 进度回调 + 会话中止）
async function analyzeBatch(stocks, maPeriod, minStrength, recentDays, onProgress, session) {
  const results = [];
  const batchSize = 6;
  for (let i = 0; i < stocks.length; i += batchSize) {
    if (session && (session.aborted || scanSession !== session)) break;
    const batch = stocks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (s) => {
      try {
        const kline = await fetchKlineClient(s.code, 150);
        if (!kline || kline.length === 0) return null;
        // 屏蔽退市 / 长期停牌：K 线最新交易日过旧者直接跳过
        if (blockDelisted && isDelistedStock(s, kline)) return null;
        const r = analyzeStockClient(s.code, s.name || s.code, kline, maPeriod, minStrength);
        if (recentDays > 0) {
          if (!r.latestSignal) return null;
          const lastIdx = kline.length - 1;
          if (lastIdx - r.latestSignal.index > recentDays) return null;
        }
        // 资金流向（主力净流入），失败容错不阻塞主扫描
        if (includeFlow) { try { r.flow = await fetchFlow(s.code); } catch (e) { r.flow = null; } }
        // 易经八卦（娱乐标签）：基于上市时间 + 代码 + 当日日期
        try { r.hexagram = computeHexagram(s.code, kline[0] && kline[0].date, new Date().toISOString().slice(0, 10)); } catch (e) { r.hexagram = null; }
        return r;
      } catch (e) { return null; }
    }));
    results.push(...batchResults.filter(r => r !== null));
    // 每批之间轻微节流，降低被行情接口限流的概率
    await new Promise(s => setTimeout(s, 50));
    // 把实时累计的结果数组传出，供扫描页边扫边渲染（先看到已出现的标的）
    if (onProgress) onProgress(results, i + batch.length, stocks.length);
  }
  return results;
}

// ============ DOM 元素 ============
const stockInput = document.getElementById('stockInput');
const addBtn = document.getElementById('addBtn');
const maPeriodSelect = document.getElementById('maPeriod');
const scanBtn = document.getElementById('scanBtn');
const scanAllBtn = document.getElementById('scanAllBtn');
const scanStopBtn = document.getElementById('scanStopBtn');
let scanSession = null;   // 当前扫描会话：每次扫描新建，作为精准停止令牌，避免跨页/重复扫描串台
let scanSeq = 0;
const clearBtn = document.getElementById('clearBtn');
const resetBtn = document.getElementById('resetBtn');
const stockTags = document.getElementById('stockTags');
const poolCount = document.getElementById('poolCount');
const scanStatus = document.getElementById('scanStatus');
const scanStatusText = document.getElementById('scanStatusText');
const scanProgress = document.getElementById('scanProgress');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const progressDetail = document.getElementById('progressDetail');
const psBuy = document.getElementById('psBuy');
const psSell = document.getElementById('psSell');
const resultsSection = document.getElementById('resultsSection');
const resultsBody = document.getElementById('resultsBody');
const emptyState = document.getElementById('emptyState');
const buyCount = document.getElementById('buyCount');
const sellCount = document.getElementById('sellCount');
const totalCount = document.getElementById('totalCount');
const filterTabs = document.querySelectorAll('.filter-tab');
const chartModal = document.getElementById('chartModal');
const modalClose = document.getElementById('modalClose');
const chartTitle = document.getElementById('chartTitle');
const chartInfo = document.getElementById('chartInfo');
const signalRecords = document.getElementById('signalRecords');
const landscapeBtn = document.getElementById('landscapeBtn');
const guideLineBtn = document.getElementById('guideLineBtn');
// 信号指引虚线开关（记忆用户选择）
let showGuideLines = localStorage.getItem('sg_guideLines') !== '0';
// 缓存当前详情页数据，切换虚线时无需重新请求
let lastChartData = null;
const resultCards = document.getElementById('resultCards');
const minStrengthSlider = document.getElementById('minStrength');
const minStrengthVal = document.getElementById('minStrengthVal');
const viewBtns = document.querySelectorAll('.view-btn');
let currentView = 'list';
const sortSelect = document.getElementById('sortSelect');
let currentSort = 'signal';
const snapshotBarEl = document.getElementById('snapshotBar');
const snapRefreshBtn = document.getElementById('snapRefreshBtn');
const snapFlowChipEl = document.getElementById('snapFlowChip');
// —— 信号日期筛选 ——
const dateFilterSelect = document.getElementById('dateFilter');
const dateRangeBox = document.getElementById('dateRange');
const dateFromInput = document.getElementById('dateFrom');
const dateToInput = document.getElementById('dateTo');
const dateClearBtn = document.getElementById('dateClearBtn');
const resCount = document.getElementById('resCount');
const scanRangeHint = document.getElementById('scanRangeHint');
let dateFilterMode = 'all'; // all | 1|3|5|10|20 | custom
let lastScanRecentDays = 0; // 本次结果实际覆盖的信号时效窗口（0 = 不限）
// —— 详情页上/下一个导航 ——
const prevStockBtn = document.getElementById('prevStockBtn');
const nextStockBtn = document.getElementById('nextStockBtn');
const navIndex = document.getElementById('navIndex');
let displayedResults = []; // 当前「筛选+排序」后展示的列表，详情页翻页依此顺序
let currentChartIndex = -1;
let currentChartCode = null;
let chartSeq = 0; // 防止快速连点造成的渲染竞态
const typeTabs = document.querySelectorAll('.type-tab');
const boardFilter = document.getElementById('boardFilter');
const boardGroup = document.getElementById('boardGroup');

// ============ 初始化 ============
function init() {
  stockPool = [...DEFAULT_STOCKS];
  renderStockTags();

  addBtn.addEventListener('click', addStock);
  stockInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addStock();
  });
  scanBtn.addEventListener('click', scanStocks);
  scanAllBtn.addEventListener('click', scanAllMarkets);
  scanStopBtn.addEventListener('click', stopScan);
  clearBtn.addEventListener('click', clearPool);
  resetBtn.addEventListener('click', resetPool);
  modalClose.addEventListener('click', closeModal);
  landscapeBtn.addEventListener('click', toggleLandscape);
  guideLineBtn.addEventListener('click', toggleGuideLines);
  syncGuideBtn();
  // 订阅入口
  const subBtn = document.getElementById('subBtn');
  if (subBtn) subBtn.addEventListener('click', openSubModal);
  const pwSub = document.getElementById('pwSubscribeBtn');
  if (pwSub) pwSub.addEventListener('click', openSubModal);
  const subClose = document.getElementById('subCloseBtn');
  if (subClose) subClose.addEventListener('click', closeSubModal);
  const subCancel = document.getElementById('subCancelBtn');
  if (subCancel) subCancel.addEventListener('click', closeSubModal);
  const subConfirm = document.getElementById('subConfirmBtn');
  if (subConfirm) subConfirm.addEventListener('click', doSubscribe);
  const subModalEl = document.getElementById('subModal');
  if (subModalEl) subModalEl.addEventListener('click', e => { if (e.target === subModalEl) closeSubModal(); });
  // 价格档位：点击切换选中态（单选）
  const subPlans = document.querySelectorAll('.sub-plan');
  subPlans.forEach(p => p.addEventListener('click', () => {
    subPlans.forEach(x => x.classList.remove('selected'));
    p.classList.add('selected');
  }));
  updateSubBadge();
  chartModal.addEventListener('click', (e) => {
    if (e.target === chartModal) closeModal();
  });

  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderResults();
    });
  });

  // 卜卦解析弹窗关闭
  const hexModalEl = document.getElementById('hexModal');
  const hexModalClose = document.getElementById('hexModalClose');
  if (hexModalClose) hexModalClose.addEventListener('click', () => hexModalEl.classList.remove('active'));
  if (hexModalEl) hexModalEl.addEventListener('click', e => { if (e.target === hexModalEl) hexModalEl.classList.remove('active'); });

  // 筛选强度滑块
  minStrengthSlider.addEventListener('input', () => {
    minStrengthVal.textContent = parseFloat(minStrengthSlider.value).toFixed(1) + '%';
  });

  // 屏蔽退市 / 长期停牌开关
  const blockDelistedEl = document.getElementById('blockDelisted');
  if (blockDelistedEl) {
    blockDelistedEl.checked = blockDelisted;
    blockDelistedEl.addEventListener('change', () => {
      blockDelisted = blockDelistedEl.checked;
      localStorage.setItem('sg_blockDelisted', blockDelisted ? '1' : '0');
      if (currentType === 'stock') listCache.stock = null; // 下次全市场扫描重新生成列表，使开关即时生效
    });
  }

  // 资金流向开关
  const includeFlowEl = document.getElementById('includeFlow');
  if (includeFlowEl) {
    includeFlowEl.checked = includeFlow;
    includeFlowEl.addEventListener('change', () => {
      includeFlow = includeFlowEl.checked;
      localStorage.setItem('sg_includeFlow', includeFlow ? '1' : '0');
      renderResults();
    });
  }
  const flowOnlyInEl = document.getElementById('flowOnlyIn');
  if (flowOnlyInEl) {
    flowOnlyInEl.checked = flowOnlyIn;
    flowOnlyInEl.addEventListener('change', () => {
      flowOnlyIn = flowOnlyInEl.checked;
      localStorage.setItem('sg_flowOnlyIn', flowOnlyIn ? '1' : '0');
      renderResults();
    });
  }

  // 卡片/列表视图切换
  viewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      viewBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      renderResults();
    });
  });

  // 排序方式切换
  sortSelect.addEventListener('change', () => {
    currentSort = sortSelect.value;
    renderResults();
  });

  // 信号日期筛选
  dateFilterSelect.addEventListener('change', () => {
    dateFilterMode = dateFilterSelect.value;
    dateRangeBox.style.display = dateFilterMode === 'custom' ? 'flex' : 'none';
    renderResults();
  });
  dateFromInput.addEventListener('change', renderResults);
  dateToInput.addEventListener('change', renderResults);
  dateClearBtn.addEventListener('click', () => {
    dateFromInput.value = '';
    dateToInput.value = '';
    renderResults();
  });

  // 详情页上一个 / 下一个（按当前排序顺序切换）
  prevStockBtn.addEventListener('click', () => openChartAt(currentChartIndex - 1));
  nextStockBtn.addEventListener('click', () => openChartAt(currentChartIndex + 1));
  document.addEventListener('keydown', (e) => {
    if (!chartModal.classList.contains('active')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); openChartAt(currentChartIndex - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); openChartAt(currentChartIndex + 1); }
    else if (e.key === 'Escape') closeModal();
  });

  // 详情页均线周期切换（多选叠加显示，点击切换显隐）
  document.querySelectorAll('#chartMaBar .ma-btn').forEach(b => {
    b.addEventListener('click', () => toggleMaLine(parseInt(b.dataset.ma)));
  });

  // 类型切换（A股 / 可转债 / ETF / 持仓 / 收藏）
  typeTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type;
      if (t === 'position') {
        if (activeTab === 'position') return;
        if (activeTab === 'favorite') exitFavoriteView();
        typeTabs.forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        if (snapshotBarEl) snapshotBarEl.style.display = 'none';
        enterPositionView();
        return;
      }
      if (t === 'favorite') {
        if (activeTab === 'favorite') return;
        if (activeTab === 'position') exitPositionView();
        typeTabs.forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        if (snapshotBarEl) snapshotBarEl.style.display = 'none';
        enterFavoriteView();
        return;
      }
      if (activeTab === t) return;
      if (activeTab === 'position') exitPositionView();
      if (activeTab === 'favorite') exitFavoriteView();
      typeTabs.forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      switchType(t);
    });
  });

  // 市场范围筛选（仅 A股有效）
  boardFilter.addEventListener('change', () => {
    currentBoardFilter = boardFilter.value;
  });

  // 云端尾盘快照：刷新按钮 + 板块/资金流筛选 chips
  if (snapRefreshBtn) snapRefreshBtn.addEventListener('click', refreshSnapshot);
  const snapBoardChips = document.querySelectorAll('.snap-chip[data-board]');
  snapBoardChips.forEach(c => c.addEventListener('click', () => {
    snapBoardChips.forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    currentBoardFilter = c.dataset.board;
    renderResults();
  }));
  if (snapFlowChipEl) snapFlowChipEl.addEventListener('click', () => {
    flowOnlyIn = !flowOnlyIn;
    snapFlowChipEl.classList.toggle('active', flowOnlyIn);
    try { localStorage.setItem('sg_flowOnlyIn', flowOnlyIn ? '1' : '0'); } catch (e) {}
    renderResults();
  });

  // 持仓 / 模拟交易 / 微信提醒 模块
  initPositionModule();

  // 启动即拉取尾盘快照（A股 标签）
  loadSnapshot();
}

// 切换品种类型：重置默认池、清空结果、切换市场范围显隐、更新按钮文案
function switchType(type) {
  currentType = type;
  activeTab = type;
  if (favoriteSection) favoriteSection.style.display = 'none';
  if (snapshotBarEl) snapshotBarEl.style.display = 'block';
  // 复位板块筛选 chips 与「仅看主力净流入」
  currentBoardFilter = 'all';
  document.querySelectorAll('.snap-chip[data-board]').forEach(c => c.classList.toggle('active', c.dataset.board === 'all'));
  if (snapFlowChipEl) snapFlowChipEl.classList.toggle('active', flowOnlyIn);
  boardFilter.value = 'all';
  // 切页前先作废旧的后台扫描会话（标 aborted + 置空），防止串台与资源占用，并复位进度条 UI
  if (scanSession) {
    scanSession.aborted = true;
    scanSession = null;
  }
  scanProgress.style.display = 'none';
  document.getElementById('progressActions').style.display = 'none';
  scanStopBtn.textContent = '⏹ 停止扫描';
  scanStopBtn.disabled = false;
  scanAllBtn.disabled = false;
  scanBtn.disabled = false;
  // 重置股票池为对应默认标的
  stockPool = [...getDefaultPool(type)];
  renderStockTags();
  // 清空扫描结果 + 复位日期筛选与详情页导航
  scanResults = [];
  displayedResults = [];
  currentChartIndex = -1;
  currentChartCode = null;
  lastScanRecentDays = 0;
  dateFilterMode = 'all';
  dateFilterSelect.value = 'all';
  dateRangeBox.style.display = 'none';
  dateFromInput.value = '';
  dateToInput.value = '';
  if (scanRangeHint) scanRangeHint.style.display = 'none';
  resultsSection.style.display = 'none';
  emptyState.style.display = 'block';
  emptyState.querySelector('p').textContent = '正在加载尾盘快照…';
  const eh = emptyState.querySelector('.empty-hint'); if (eh) eh.style.display = 'none';
  updateStats();
  // 市场范围筛选仅 A股 显示（可转债/ETF 无板块概念）
  boardGroup.style.display = type === 'stock' ? 'block' : 'none';
  // 板块筛选 chips 仅 A股 显示
  const snapFiltersEl = document.getElementById('snapFilters');
  if (snapFiltersEl) snapFiltersEl.style.display = (type === 'stock') ? 'flex' : 'none';
  // 云端尾盘快照：按品种直接拉取对应快照浏览（不再由浏览器端扫描）
  loadSnapshot(type);
}

// ============ 股票池管理 ============
function addStock() {
  const code = stockInput.value.trim().toLowerCase();
  if (!code) return;

  if (stockPool.some(s => s.code === code)) {
    showToast('该股票已在股票池中');
    return;
  }

  // 简单验证格式
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
    showToast('代码格式不正确，应为 sh/sz/bj + 6位数字，如 sz000001');
    return;
  }

  stockPool.push({ code, name: code });
  stockInput.value = '';
  renderStockTags();
}

function removeStock(code) {
  stockPool = stockPool.filter(s => s.code !== code);
  renderStockTags();
}

function clearPool() {
  stockPool = [];
  renderStockTags();
  scanResults = [];
  resultsSection.style.display = 'none';
  emptyState.style.display = 'block';
  updateStats();
}

function resetPool() {
  stockPool = [...DEFAULT_STOCKS];
  renderStockTags();
}

function renderStockTags() {
  poolCount.textContent = stockPool.length;
  stockTags.innerHTML = stockPool.map(s => `
    <div class="stock-tag">
      <span>${s.name}</span>
      <span class="tag-code">${s.code}</span>
      <span class="tag-remove" onclick="removeStock('${s.code}')">&times;</span>
    </div>
  `).join('');
}

// ============ 扫描 ============
async function scanStocks() {
  if (stockPool.length === 0) {
    showToast('请先添加股票到股票池');
    return;
  }

  const maPeriod = parseInt(maPeriodSelect.value);
  const minStrength = parseFloat(minStrengthSlider.value) / 100;
  scanBtn.disabled = true;
  scanStatus.style.display = 'flex';
  showScanAd(true);
  scanStatusText.textContent = `正在扫描 ${stockPool.length} 只股票（MA${maPeriod}日均线导数分析）...`;
  emptyState.style.display = 'none';
  resultsSection.style.display = 'none';

  try {
    lastScanRecentDays = 0; // 股票池扫描不限时效，日期筛选可覆盖全部历史信号
    scanResults = await analyzeBatch(stockPool, maPeriod, minStrength, 0, null, null);
    renderResults();
    updateStats();
    resultsSection.style.display = 'block';
  } catch (err) {
    showToast('扫描失败: ' + err.message);
  } finally {
    scanBtn.disabled = false;
    scanStatus.style.display = 'none';
    showScanAd(false);
  }
}

// ============ 全市场扫描 ============
function stopScan() {
  if (scanSession) scanSession.aborted = true;   // 仅终止“当前”会话，不影响其它
  scanStopBtn.disabled = true;
  scanStopBtn.textContent = '⏹ 正在停止...';
  progressText.textContent = '正在停止扫描（完成当前批次后）...';
  progressDetail.textContent = '已扫描的结果将立即保留并显示在下方';
}

async function scanAllMarkets() {
  const maPeriod = parseInt(maPeriodSelect.value);
  // 新建本次扫描会话令牌：作废旧会话（包括切页遗留在后台的旧循环），保证任意时刻仅一个扫描运行
  const session = { id: ++scanSeq, aborted: false };
  scanSession = session;
  const typeLabel = currentType === 'cb' ? '可转债' : currentType === 'etf' ? 'ETF' : 'A股';
  scanAllBtn.disabled = true;
  scanBtn.disabled = true;
  scanProgress.style.display = 'block';
  document.getElementById('progressActions').style.display = 'block';
  scanStopBtn.disabled = false;
  scanStopBtn.textContent = '⏹ 停止扫描';
  emptyState.style.display = 'none';
  resultsSection.style.display = 'none';
  showScanAd(true);

  let allResults = [];
  let totalScanned = 0;
  let buySignals = 0;
  let sellSignals = 0;
  const startTime = Date.now();
  const minStrength = parseFloat(minStrengthSlider.value) / 100;
  // 信号时效窗口跟随「信号日期」筛选，保证筛选条件不会超出扫描到的数据范围
  const recentDays = wantedRecentDays();
  lastScanRecentDays = recentDays;

  try {
    // 第一步：客户端生成全市场列表（遍历代码段 + 腾讯验证）
    progressText.textContent = `正在生成全市场${typeLabel}列表...`;
    progressBar.style.width = '0%';
    progressDetail.textContent = '首次生成需要约10秒，请稍候';

    let allStocks = await buildListClient(currentType);
    if (session.aborted || scanSession !== session) {
      progressText.textContent = '已停止扫描';
      progressDetail.textContent = '列表尚未生成完成，未收集到结果，可重新点击全市场扫描。';
      return;
    }
    // 板块过滤（仅 A股，且非"全部"）
    if (currentType === 'stock' && currentBoardFilter !== 'all') {
      allStocks = allStocks.filter(s => s.board === currentBoardFilter);
    }
    progressText.textContent = `列表就绪：共 ${allStocks.length} 只 ${typeLabel}`;
    progressBar.style.width = '100%';

    const total = allStocks.length;

    // 第二步：分批扫描（客户端直连腾讯 + 进度 + 实时渲染）
    // onProgress 收到的是「当前已扫描到的实时结果数组」，扫描在后台继续，结果边出边显示
    let lastLiveRender = 0;
    const sortLive = (arr) => arr.slice().sort((a, b) => {
      const aHas = a.latestSignal ? 1 : 0, bHas = b.latestSignal ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.latestSignal && b.latestSignal) {
        if (a.latestSignal.type !== b.latestSignal.type) return a.latestSignal.type === 'BUY' ? -1 : 1;
        return b.latestSignal.index - a.latestSignal.index;
      }
      return 0;
    });
    const onProgress = (liveResults, scanned) => {
      totalScanned = scanned;
      const pct = Math.round((totalScanned / total) * 100);
      progressBar.style.width = pct + '%';
      progressText.textContent = '全市场扫描中…（结果实时显现，可先查看已出现的标的）';
      progressDetail.textContent = `已扫描 ${totalScanned}/${total} 只`;
      buySignals = liveResults.filter(r => r.latestSignal && r.latestSignal.type === 'BUY').length;
      sellSignals = liveResults.filter(r => r.latestSignal && r.latestSignal.type === 'SELL').length;
      psBuy.textContent = buySignals;
      psSell.textContent = sellSignals;
      // 节流：最多每 400ms 重渲染一次，避免结果很多时频繁重排卡顿（扫描结束那次必定渲染）
      const now = Date.now();
      if (now - lastLiveRender > 400 || scanned >= total) {
        lastLiveRender = now;
        scanResults = sortLive(liveResults);
        renderResults();
        updateStats();
        resultsSection.style.display = 'block';
      }
    };

    allResults = await analyzeBatch(allStocks, maPeriod, minStrength, recentDays, onProgress, session);

    // 完成或停止
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    progressBar.style.width = '100%';
    if (session.aborted || scanSession !== session) {
      progressText.textContent = `已停止 · 显示部分结果`;
      progressDetail.textContent = `已扫描约 ${totalScanned}/${total} 只，发现 ${buySignals} 个入场信号，${sellSignals} 个出场信号`;
      showToast(allResults.length > 0 ? `已停止，显示已扫描的 ${allResults.length} 只结果` : '已停止扫描，但未收集到结果');
    } else {
      progressText.textContent = `扫描完成！`;
      progressDetail.textContent = `共扫描 ${total} 只，耗时 ${elapsed}s，发现 ${buySignals} 个入场信号，${sellSignals} 个出场信号`;
    }

    scanResults = [...allResults].sort((a, b) => {
      const aHas = a.latestSignal ? 1 : 0, bHas = b.latestSignal ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.latestSignal && b.latestSignal) {
        if (a.latestSignal.type !== b.latestSignal.type) return a.latestSignal.type === 'BUY' ? -1 : 1;
        return b.latestSignal.index - a.latestSignal.index;
      }
      return 0;
    });
    renderResults();
    updateStats();
    resultsSection.style.display = 'block';

    if (allResults.length === 0) showToast(`未发现近${recentDays}个交易日内有信号的标的，可尝试切换MA周期或降低筛选强度`);
    else showToast(`扫描完成！发现 ${buySignals} 个入场信号，${sellSignals} 个出场信号`);
  } catch (err) {
    showToast('全市场扫描失败: ' + err.message);
    progressText.textContent = '扫描失败';
  } finally {
    // 仅当本会话仍是当前会话时才复位 UI，避免被作废旧循环的 finally 误开按钮/进度条
    if (scanSession === session) {
      scanAllBtn.disabled = false;
      scanBtn.disabled = false;
      scanStopBtn.textContent = '⏹ 停止扫描';
      scanStopBtn.disabled = false;
      document.getElementById('progressActions').style.display = 'none';
      setTimeout(() => {
        if (scanSession === session) { scanProgress.style.display = 'none'; showScanAd(false); }
      }, 5000);
    }
  }
}

// ============ 订阅门槛 + 广告位 ============
const LS_SUB = 'sg_subscribed';
const LS_PLAN = 'sg_plan';
const FREE_LIMIT = 3; // 免费版仅展示前 3 条扫描结果
function isSubscribed() { return localStorage.getItem(LS_SUB) === '1'; }
// 对展示列表应用订阅门槛：未订阅且超过限额则截断到前 FREE_LIMIT 条
function applySubGate(list) {
  const total = list.length;
  if (isSubscribed() || total <= FREE_LIMIT) return { list, total, paywalled: false };
  return { list: list.slice(0, FREE_LIMIT), total, paywalled: true };
}
function updatePaywall(gw) {
  const el = document.getElementById('paywall');
  if (!el) return;
  if (gw.paywalled) {
    el.style.display = '';
    const remain = el.querySelector('.pw-remain'); if (remain) remain.textContent = gw.total - FREE_LIMIT;
    const tot = el.querySelector('.pw-total'); if (tot) tot.textContent = gw.total;
  } else {
    el.style.display = 'none';
  }
}
function showScanAd(show) {
  const el = document.getElementById('scanAd');
  if (el) el.style.display = show ? '' : 'none';
}
function updateSubBadge() {
  const subscribed = isSubscribed();
  const badge = document.getElementById('subBadge');
  if (badge) { badge.textContent = subscribed ? '已订阅' : '未订阅'; badge.className = 'sub-badge ' + (subscribed ? 'on' : 'off'); }
  const subBtnEl = document.getElementById('subBtn');
  if (subBtnEl) subBtnEl.textContent = subscribed ? '管理订阅' : '订阅';
}
function openSubModal() {
  const el = document.getElementById('subModal');
  if (el) el.classList.add('active');
}
function closeSubModal() {
  const el = document.getElementById('subModal');
  if (el) el.classList.remove('active');
}
function doSubscribe() {
  // 演示解锁：真实付费需接入微信支付 / 后端订单校验，切勿在前端直接判定已支付
  const sel = document.querySelector('.sub-plan.selected');
  const plan = sel ? sel.dataset.plan : 'year';
  localStorage.setItem(LS_SUB, '1');
  localStorage.setItem(LS_PLAN, plan);
  closeSubModal();
  const planName = { month: '连续包月 ¥6.6', year: '包年 ¥68', buy: '买断 ¥100' }[plan] || '';
  showToast('订阅成功（' + planName + '），已解锁全部扫描结果 🎉');
  updateSubBadge();
  renderResults();
}

// ============ 云端尾盘快照浏览（服务端 14:30 自动生成，前端只排序/筛选） ============
let currentSnapshotMeta = null;

// 拉取服务端生成的快照（命中列表），灌入 scanResults 后复用既有渲染/排序/收藏逻辑
async function loadSnapshot(type = currentType) {
  if (snapshotBarEl) snapshotBarEl.style.display = 'block';
  try {
    const res = await fetch(`/snapshot_${type}.json?t=${Date.now()}`);
    if (!res.ok) throw new Error('no snapshot');
    const snap = await res.json();
    currentSnapshotMeta = snap;
    scanResults = Array.isArray(snap.stocks) ? snap.stocks : [];
    lastScanRecentDays = snap.recentDays || 5;
    updateStats();
    if (!scanResults.length) {
      resultsSection.style.display = 'none';
      emptyState.style.display = 'block';
      emptyState.querySelector('p').textContent = '今日尾盘快照暂无命中标的。可点「刷新快照」由服务端重新扫描，或稍后再看。';
    } else {
      emptyState.style.display = 'none';
      resultsSection.style.display = 'block';
      renderResults();
    }
    renderSnapshotBar(snap);
  } catch (e) {
    resultsSection.style.display = 'none';
    emptyState.style.display = 'block';
    const p = emptyState.querySelector('p');
    if (p) p.textContent = '尚未生成快照，点「刷新快照」由服务端生成（首次约 1–2 分钟）。';
    const hint = emptyState.querySelector('.empty-hint'); if (hint) hint.style.display = 'none';
    renderSnapshotBar(null);
  }
}

// 手动触发服务端重新扫描（兜底：云端若休眠可用此刷新）
async function refreshSnapshot() {
  if (!snapRefreshBtn) return;
  const old = snapRefreshBtn.textContent;
  snapRefreshBtn.disabled = true;
  snapRefreshBtn.textContent = '⏳ 生成中…';
  let triggered = false;
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    // 注意：纯静态托管下 /api/refresh 会被兜底返回 200 的 HTML（size=0），
    // 必须校验响应确实是 JSON 且非空，否则判定为「无扫描后端」。
    const ct = res.headers.get('content-type') || '';
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (res.ok && ct.includes('json') && len > 0) {
      const data = await res.json();
      if (data && data.ok) triggered = true;
    }
    if (triggered) {
      showToast('已触发服务端扫描，正在重新拉取最新快照…');
    } else {
      showToast('当前为静态托管，无自动扫描后端：刷新仅重新拉取已部署的快照。如需每日自动更新，需部署常驻 Node 后端。');
    }
  } catch (e) {
    showToast('刷新失败：未检测到扫描后端（服务端未运行）。');
  } finally {
    await loadSnapshot(); // 有后端 → 拿到新数据；无后端 → 重新拉取已部署文件
    snapRefreshBtn.disabled = false;
    snapRefreshBtn.textContent = old;
  }
}

function renderSnapshotBar(snap) {
  const meta = document.getElementById('snapMeta');
  if (!meta) return;
  if (!snap) {
    meta.innerHTML = '<span class="snap-warn">暂无快照数据</span>';
    return;
  }
  const typeName = { stock: 'A股', cb: '可转债', etf: 'ETF' }[currentType] || 'A股';
  const updated = snap.updatedAt ? new Date(snap.updatedAt).toLocaleString('zh-CN') : '-';
  meta.innerHTML = `
    <span class="snap-type">${typeName} · 尾盘快照</span>
    <span>更新于 <b>${updated}</b></span>
    <span>交易日 <b>${snap.tradeDate || '-'}</b></span>
    <span>命中 <b class="snap-count">${snap.count != null ? snap.count : scanResults.length}</b> 只</span>
    <span>MA${snap.maPeriod || ''} · 近${snap.recentDays || ''}日拐点</span>
    <span class="snap-note">${snap.note || ''}</span>
  `;
}

// ============ 结果渲染（卡片 / 列表 两种视图） ============
function renderResults() {
  let filtered = scanResults;
  if (currentFilter !== 'all') {
    filtered = scanResults.filter(r => r.latestSignal && r.latestSignal.type === currentFilter);
  }

  // 按信号出现日期筛选
  filtered = filtered.filter(passDateFilter);

  // 板块筛选（快照内按 board 细分：主板 / 创业板 / 科创板）
  if (currentBoardFilter !== 'all') {
    filtered = filtered.filter(r => r.board === currentBoardFilter);
  }

  // 仅看主力净流入的标的
  if (flowOnlyIn) {
    filtered = filtered.filter(r => typeof r.flow === 'number' && r.flow > 0);
  }

  // 按当前排序方式排序
  filtered = sortResults(filtered);

  // 记录当前展示顺序，供详情页「上一个/下一个」使用
  displayedResults = filtered;
  updateScanRangeHint();
  if (resCount) {
    const totalTxt = filtered.length === scanResults.length
      ? `(${filtered.length})`
      : `(${filtered.length} / ${scanResults.length})`;
    resCount.textContent = totalTxt;
  }
  // 订阅门槛：免费版仅展示前 FREE_LIMIT 条，其余需订阅解锁
  const gw = applySubGate(displayedResults);
  displayedResults = gw.list;
  filtered = gw.list;
  if (resCount) {
    resCount.textContent = filtered.length === scanResults.length
      ? `(${gw.total})`
      : `(${gw.total} / ${scanResults.length})`;
  }
  updatePaywall(gw);
  // 弹窗开着时，重新定位当前标的在新顺序中的位置
  if (chartModal.classList.contains('active') && currentChartCode) {
    currentChartIndex = displayedResults.findIndex(r => r.code === currentChartCode);
    updateChartNav();
  }

  if (filtered.length === 0) {
    resultCards.className = 'result-cards';
    // 「只看主力净流入」却为 0：区分「数据在浏览器端取不到」与「确实无此类标的」
    let emptyMsg = '暂无符合条件的股票';
    let emptySub = '';
    if (flowOnlyIn && scanResults.length > 0) {
      const anyFlowNum = scanResults.some(r => typeof r.flow === 'number');
      if (!anyFlowNum) {
        emptyMsg = '勾选「只看主力净流入」后没有结果';
        emptySub = '原因是：资金流接口（东方财富 / 新浪）<b>不返回跨域(CORS)头</b>，浏览器从本页面域名直接请求会被拦截，几乎所有标的的「主力净流入」都取不到（显示为空），并非「近期没有这类股票」。' +
          (FLOW_PROXY ? '' : ' 已对单只股票详情开启代理兜底；如需让全市场扫描也能按资金流筛选，需部署后端代理（news-proxy 的 /api/flow）并在 app.js 顶部填入 FLOW_PROXY 地址。');
      }
    }
    resultCards.innerHTML = `
      <div style="text-align:center;padding:40px;color:#8b8fa3;grid-column:1/-1;">
        <div>${emptyMsg}</div>
        ${emptySub ? `<div style="margin-top:10px;font-size:12px;line-height:1.7;max-width:560px;margin-left:auto;margin-right:auto;text-align:left;">${emptySub}</div>` : ''}
      </div>
    `;
    return;
  }

  if (currentView === 'list') {
    renderResultsTable(filtered);
  } else {
    renderResultsCards(filtered);
  }
}

// 信号日期筛选：快捷「近N个交易日」或自定义日期区间
function passDateFilter(r) {
  if (dateFilterMode === 'all') return true;
  const sig = r.latestSignal;
  if (!sig) return false; // 有日期条件时，无信号的一律排除

  if (dateFilterMode === 'custom') {
    const from = dateFromInput.value;
    const to = dateToInput.value;
    if (!from && !to) return true;
    const d = sig.date; // YYYY-MM-DD，可直接字典序比较
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  const n = parseInt(dateFilterMode, 10);
  if (isNaN(n)) return true;
  const ago = r.signalDaysAgo;
  if (ago === null || ago === undefined) return false;
  return ago < n; // 近N个交易日内（0 = 最新交易日当天）
}

// 全市场扫描时保留的信号时效窗口（跟随日期筛选，避免筛选条件超出数据范围）
function wantedRecentDays() {
  if (dateFilterMode === 'all') return 10;
  if (dateFilterMode === 'custom') return 60;
  const n = parseInt(dateFilterMode, 10);
  return isNaN(n) ? 10 : n;
}

// 当筛选范围超出本次扫描已覆盖的窗口时给出提示
function updateScanRangeHint() {
  if (!scanRangeHint) return;
  if (scanResults.length === 0 || lastScanRecentDays === 0) {
    scanRangeHint.style.display = 'none';
    return;
  }
  let need = 0;
  if (dateFilterMode === 'custom') need = 61;
  else if (dateFilterMode === 'all') need = 0;
  else need = parseInt(dateFilterMode, 10) || 0;

  if (need > lastScanRecentDays) {
    scanRangeHint.style.display = 'block';
    scanRangeHint.textContent = `⚠️ 当前结果仅覆盖近 ${lastScanRecentDays} 个交易日内的信号，要查看更早的信号请重新执行「全市场扫描」。`;
  } else {
    scanRangeHint.style.display = 'none';
  }
}

// 排序：按信号日期 / 曲率强度 / 默认（信号优先）
function sortResults(list) {
  const arr = [...list];
  if (currentSort === 'date-desc') {
    // 信号日期从新到旧；无信号排最后；同日期按曲率强度高的靠前
    arr.sort((a, b) => {
      const da = a.latestSignal ? a.latestSignal.date : '';
      const db = b.latestSignal ? b.latestSignal.date : '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      if (da !== db) return db.localeCompare(da);
      return strengthOf(b) - strengthOf(a);
    });
  } else if (currentSort === 'date-asc') {
    // 信号日期从旧到新；无信号排最后
    arr.sort((a, b) => {
      const da = a.latestSignal ? a.latestSignal.date : '';
      const db = b.latestSignal ? b.latestSignal.date : '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      if (da !== db) return da.localeCompare(db);
      return strengthOf(b) - strengthOf(a);
    });
  } else if (currentSort === 'strength-desc') {
    arr.sort((a, b) => strengthOf(b) - strengthOf(a));
  } else if (currentSort === 'strength-asc') {
    arr.sort((a, b) => strengthOf(a) - strengthOf(b));
  } else if (currentSort === 'change-desc') {
    arr.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  } else if (currentSort === 'change-asc') {
    arr.sort((a, b) => (a.changePct || 0) - (b.changePct || 0));
  } else {
    // 默认：有信号排前面，买入优先，再按信号日期倒序
    arr.sort((a, b) => {
      const aHas = a.latestSignal ? 1 : 0;
      const bHas = b.latestSignal ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.latestSignal && b.latestSignal) {
        if (a.latestSignal.type !== b.latestSignal.type) {
          return a.latestSignal.type === 'BUY' ? -1 : 1;
        }
        return b.latestSignal.index - a.latestSignal.index;
      }
      return 0;
    });
  }
  return arr;
}

function strengthOf(r) {
  return r.latestSignal ? r.latestSignal.strength : 0;
}

// 信号距今天数的可读文案：0 → 今日，其余 → T-N
function agoText(daysAgo) {
  if (daysAgo === null || daysAgo === undefined) return '';
  return daysAgo === 0 ? ' · 今日' : ` · T-${daysAgo}`;
}

function boardLabel(board) {
  return { main: '主板', cyb: '创业板', kcb: '科创板', cb: '可转债', etf: 'ETF' }[board] || board;
}

// 卡片视图
function renderResultsCards(filtered) {
  resultCards.className = 'result-cards';
  resultCards.innerHTML = filtered.map(r => {
    const signal = r.latestSignal;
    const signalBadge = signal
      ? `<span class="signal-badge ${signal.type.toLowerCase()}">${signal.type === 'BUY' ? '入场' : '出场'}</span>`
      : `<span class="signal-badge none">无信号</span>`;

    const trendClass = r.trend === 'UP' ? 'trend-up' : r.trend === 'DOWN' ? 'trend-down' : 'trend-flat';
    const trendIcon = r.trend === 'UP' ? '↑' : r.trend === 'DOWN' ? '↓' : '→';

    const derivClass = r.latestDerivative > 0 ? 'derivative-positive'
      : r.latestDerivative < 0 ? 'derivative-negative' : 'derivative-zero';
    const derivSign = r.latestDerivative > 0 ? '+' : '';

    const recClass = r.recommendationType === 'BUY' ? 'buy'
      : r.recommendationType === 'SELL' ? 'sell' : 'hold';
    const recColor = r.recommendationType === 'BUY' ? '#ef4444' : r.recommendationType === 'SELL' ? '#22c55e' : '#8b8fa3';

    const strengthHtml = signal
      ? `<div class="rc-item"><span class="label">曲率强度</span><span class="value strength-val">${signal.strength.toFixed(2)}%</span></div>`
      : '';

    const flowHtml = (typeof r.flow === 'number')
      ? `<div class="rc-item"><span class="label">主力净流入</span><span class="value ${r.flow >= 0 ? 'flow-in' : 'flow-out'}">${fmtMoney(r.flow)}</span></div>`
      : '';

    return `
      <div class="result-card">
        <div class="rc-top">
          <div class="rc-name">
            <span class="rc-code">${r.code}</span>
            <strong class="rc-title">${r.name}</strong>
            <span class="board-badge ${r.board}">${boardLabel(r.board)}</span>
            ${r.hexagram ? `<span class="hex-tag clickable" title="点击查看卦象如何得出" onclick="openHexModal('${r.code}','${r.hexagram.listDate}')">📿 ${r.hexagram.g}卦</span>` : ''}
          </div>
          <div class="rc-top-right">
            ${signalBadge}
            <button class="btn-fav-card ${isFav(r.code) ? 'on' : ''}" data-fav="${r.code}" onclick="window.toggleFav('${r.code}','${r.name}')" title="收藏观察">${isFav(r.code) ? '⭐' : '☆'}</button>
          </div>
        </div>
        <div class="rc-grid">
          <div class="rc-item">
            <span class="label">最新价</span>
            <span class="value" style="color:${r.lastClose > 0 ? '#ef4444' : '#22c55e'};">¥${r.lastClose.toFixed(2)}</span>
          </div>
          <div class="rc-item">
            <span class="label">涨跌幅</span>
            <span class="value" style="color:${r.changePct >= 0 ? '#ef4444' : '#22c55e'};">${r.changePct >= 0 ? '+' : ''}${r.changePct != null ? r.changePct.toFixed(2) : '0.00'}%</span>
          </div>
          <div class="rc-item">
            <span class="label">MA${r.maPeriod || ''}</span>
            <span class="value">${r.latestMa !== null ? '¥' + r.latestMa.toFixed(2) : '-'}</span>
          </div>
          <div class="rc-item">
            <span class="label">MA导数</span>
            <span class="value ${derivClass}">${derivSign}${r.latestDerivative !== null ? r.latestDerivative.toFixed(4) : '-'}</span>
          </div>
          <div class="rc-item">
            <span class="label">趋势</span>
            <span class="value ${trendClass}">${trendIcon} ${r.trendLabel}</span>
          </div>
          ${strengthHtml}
          ${flowHtml}
        </div>
        <div class="rc-bottom">
          <span class="rc-rec ${recClass}" style="color:${recColor};">建议: ${r.recommendation}</span>
          <span class="rc-date">${signal ? '信号: ' + signal.date + agoText(r.signalDaysAgo) : '无信号'}</span>
          <button class="btn-chart" onclick="showChart('${r.code}')">📊 查看K线</button>
        </div>
      </div>
    `;
  }).join('');
}

// 列表视图（紧凑表格，移动端可横向滚动）
function renderResultsTable(filtered) {
  resultCards.className = 'result-cards list-mode';
  const rows = filtered.map(r => {
    const signal = r.latestSignal;
    const badge = signal
      ? `<span class="signal-badge ${signal.type.toLowerCase()}">${signal.type === 'BUY' ? '进' : '出'}</span>`
      : `<span class="signal-badge none">—</span>`;
    const derivClass = r.latestDerivative > 0 ? 'derivative-positive'
      : r.latestDerivative < 0 ? 'derivative-negative' : 'derivative-zero';
    const derivSign = r.latestDerivative > 0 ? '+' : '';
    const recClass = r.recommendationType === 'BUY' ? 'buy'
      : r.recommendationType === 'SELL' ? 'sell' : 'hold';
    const recColor = r.recommendationType === 'BUY' ? '#ef4444' : r.recommendationType === 'SELL' ? '#22c55e' : '#8b8fa3';
    const strength = signal ? signal.strength.toFixed(2) + '%' : '—';
    const sigDate = signal
      ? `<span class="td-sigdate">${signal.date}</span><span class="td-ago">${agoText(r.signalDaysAgo).replace(' · ', '')}</span>`
      : '—';
    return `
      <tr>
        <td class="td-name"><strong>${r.name}</strong><span class="td-code">${r.code}</span> <span class="board-badge sm ${r.board}">${boardLabel(r.board)}</span></td>
        <td style="color:${r.lastClose > 0 ? '#ef4444' : '#22c55e'};">¥${r.lastClose.toFixed(2)}</td>
        <td style="color:${r.changePct >= 0 ? '#ef4444' : '#22c55e'};white-space:nowrap;">${r.changePct >= 0 ? '+' : ''}${(r.changePct != null ? r.changePct : 0).toFixed(2)}%</td>
        <td>${r.latestMa !== null ? '¥' + r.latestMa.toFixed(2) : '-'}</td>
        <td class="${derivClass}">${derivSign}${r.latestDerivative !== null ? r.latestDerivative.toFixed(4) : '-'}</td>
        <td>${r.trendLabel}</td>
        <td>${badge}</td>
        <td class="sigdate-cell">${sigDate}</td>
        <td class="strength-cell">${strength}</td>
        <td class="${typeof r.flow === 'number' ? (r.flow >= 0 ? 'flow-in' : 'flow-out') : ''}">${typeof r.flow === 'number' ? fmtMoney(r.flow) : '—'}</td>
        <td class="hex-cell clickable" ${r.hexagram ? `onclick="openHexModal('${r.code}','${r.hexagram.listDate}')" title="点击查看卦象如何得出"` : ''}>${r.hexagram ? r.hexagram.g + '卦' : '—'}</td>
        <td style="color:${recColor};white-space:nowrap;">${r.recommendation}</td>
        <td><button class="btn-fav-sm ${isFav(r.code) ? 'on' : ''}" data-fav="${r.code}" onclick="window.toggleFav('${r.code}','${r.name}')" title="收藏观察">${isFav(r.code) ? '⭐' : '☆'}</button></td>
        <td><button class="btn-chart-sm" onclick="showChart('${r.code}')">K线</button></td>
      </tr>
    `;
  }).join('');

  resultCards.innerHTML = `
    <div class="table-wrap">
      <table class="results-table">
        <thead>
          <tr>
            <th>名称/代码</th>
            <th>最新价</th>
            <th>涨跌幅</th>
            <th>MA</th>
            <th>导数</th>
            <th>趋势</th>
            <th>信号</th>
            <th>信号日期</th>
            <th>强度</th>
            <th>主力净流入</th>
            <th>运势</th>
            <th>建议</th>
            <th>收藏</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function updateStats() {
  const buys = scanResults.filter(r => r.latestSignal && r.latestSignal.type === 'BUY').length;
  const sells = scanResults.filter(r => r.latestSignal && r.latestSignal.type === 'SELL').length;
  buyCount.textContent = buys;
  sellCount.textContent = sells;
  totalCount.textContent = scanResults.length;
}

// ============ 详情页导航（按当前排序切换上一个 / 下一个） ============
function openChartAt(idx) {
  if (idx < 0 || idx >= displayedResults.length) return;
  showChart(displayedResults[idx].code);
}

function updateChartNav() {
  const total = displayedResults.length;
  if (total === 0 || currentChartIndex < 0) {
    navIndex.textContent = '-/-';
    prevStockBtn.disabled = true;
    nextStockBtn.disabled = true;
    return;
  }
  navIndex.textContent = `${currentChartIndex + 1}/${total}`;
  prevStockBtn.disabled = currentChartIndex <= 0;
  nextStockBtn.disabled = currentChartIndex >= total - 1;
}

// ============ 图表展示 ============
const MA_PERIODS = [3, 5, 10, 20, 60];
const MA_COLORS = { 3: '#f59e0b', 5: '#3b82f6', 10: '#a855f7', 20: '#22c55e', 60: '#ec4899' };
let chartVisibleMa = new Set(MA_PERIODS); // 同时显示哪些均线，用户可单独开关
let chartPrimaryMa = 5;                   // 信号 / 导数分析基准（固定 MA5）
let lastKline = null;
async function showChart(code) {
  const minStrength = parseFloat(minStrengthSlider.value) / 100;
  const seq = ++chartSeq; // 防止连点翻页时旧请求覆盖新页面

  // 定位当前标的在展示列表中的序号，驱动上一个/下一个按钮
  currentChartCode = code;
  currentChartIndex = displayedResults.findIndex(r => r.code === code);
  updateChartNav();

  const poolItem = displayedResults[currentChartIndex];
  chartTitle.textContent = `K线分析 - ${poolItem ? poolItem.name + ' (' + code + ')' : code}`;
  chartInfo.innerHTML = `<p style="color:#8b8fa3;padding:6px 0;">正在加载数据...</p>`;

  chartModal.classList.add('active');

  // 趋势分析原理（标题下方，仅作概略说明，「入场/出场」仅=开始关注点，非真实建议）
  const principleEl = document.getElementById('chartPrinciple');
  if (principleEl) {
    principleEl.innerHTML = `
      <b>趋势分析原理</b>：本工具基于全市场海量历史行情数据的多维度统计建模与量化因子挖掘，对价格走势的拐点进行数据化识别，将值得留意的时点提示为「入场/出场」关注点。
      <span class="cp-warn">⚠️ 入场/出场指标仅表示「开始关注」的时点，不构成真实出入场建议；本工具用于筛选出现反转预兆的股票，投资有风险，请自行判断。</span>`;
  }

  try {
    const klineData = await fetchKlineClient(code, 150);
    if (seq !== chartSeq) return;
    if (!klineData || klineData.length === 0) {
      chartInfo.innerHTML = `<p style="color:#ef4444;">无法获取股票数据，请检查代码是否正确</p>`;
      return;
    }
    let stockName = code;
    try { const q = await fetchQuoteClient(code); if (q && q.name) stockName = q.name; } catch (e) {}
    if (seq !== chartSeq) return;
    const data = analyzeStockClient(code, stockName, klineData, MA_PERIODS, chartPrimaryMa, minStrength);
    lastKline = { code, name: stockName, data: klineData };

    if (data.error) {
      chartInfo.innerHTML = `<p style="color:#ef4444;">${data.error}</p>`;
      return;
    }

    chartTitle.textContent = `K线分析 - ${data.name} (${data.code})`;

    // 渲染信息栏
    updateChartInfo(data);
    updateMaBarUI();

    // 渲染 K 线图
    renderKlineChart(data);
    // 渲染导数图
    renderDerivativeChart(data);
    // 渲染信号记录
    renderSignalRecords(data.signals);
    // 同步交易栏持仓状态
    syncTradeBar();
    // 易经八卦（娱乐标签）：上市时间 + 代码 + 当日日期
    const hex = computeHexagram(code, data.chartData.dates[0], new Date().toISOString().slice(0, 10));
    const hexEl = document.getElementById('chartHex');
    if (hexEl) hexEl.innerHTML = `📿 <b>运势卦象</b>：<a href="javascript:;" class="hex-click" onclick="openHexModal('${code}','${hex.listDate}')">${hex.g}卦</a> <span class="hex-tag-t ${hex.t === '多' ? 'hex-t-up' : hex.t === '空' ? 'hex-t-down' : 'hex-t-mid'}">${hex.t === '多' ? '偏多 📈' : hex.t === '空' ? '偏空 📉' : '中性观望 ⚖️'}</span> · ${hex.r} <span class="hex-fun">（点击卦名看如何得出 · 仅供娱乐，不构成任何建议）</span>`;
    // 资金流向（主力净流入）
    const flowEl = document.getElementById('chartFlow');
    if (flowEl) {
      if (includeFlow) {
        fetchFlow(code, { allowProxy: true }).then(f => {
          flowEl.innerHTML = (typeof f === 'number')
            ? `💰 <b>主力净流入</b>：<span class="${f >= 0 ? 'flow-in' : 'flow-out'}">${fmtMoney(f)}</span>`
            : `💰 <b>主力净流入</b>：<span class="muted">暂不可用</span>`;
        }).catch(() => { flowEl.innerHTML = `💰 <b>主力净流入</b>：<span class="muted">暂不可用</span>`; });
      } else { flowEl.innerHTML = ''; }
    }
  } catch (err) {
    chartInfo.innerHTML = `<p style="color:#ef4444;">加载失败: ${err.message}</p>`;
  }
}

// 切换信号指引虚线的显示/隐藏（记忆选择，立即重绘当前K线图）
function toggleGuideLines() {
  showGuideLines = !showGuideLines;
  localStorage.setItem('sg_guideLines', showGuideLines ? '1' : '0');
  syncGuideBtn();
  if (lastChartData) renderKlineChart(lastChartData);
}

function syncGuideBtn() {
  if (!guideLineBtn) return;
  guideLineBtn.textContent = showGuideLines ? '┆ 虚线：显示' : '┆ 虚线：隐藏';
  guideLineBtn.classList.toggle('off', !showGuideLines);
}

// 信息栏（最新价 / MA / 导数 / 趋势 / 信号 / 建议）—— 抽出来供切换 MA 周期时复用
function updateChartInfo(data) {
  const signal = data.latestSignal;
  chartInfo.innerHTML = `
    <div class="chart-info-item">
      <span class="label">最新价</span>
      <span class="value" style="color:#ef4444;">¥${data.lastClose.toFixed(2)}</span>
    </div>
    <div class="chart-info-item">
      <span class="label">MA${data.maPeriod}</span>
      <span class="value">¥${data.latestMa !== null ? data.latestMa.toFixed(2) : '-'}</span>
    </div>
    <div class="chart-info-item">
      <span class="label">导数</span>
      <span class="value" style="color:${data.latestDerivative > 0 ? '#ef4444' : data.latestDerivative < 0 ? '#22c55e' : '#8b8fa3'};">
        ${data.latestDerivative !== null ? (data.latestDerivative > 0 ? '+' : '') + data.latestDerivative.toFixed(4) : '-'}
      </span>
    </div>
    <div class="chart-info-item">
      <span class="label">趋势</span>
      <span class="value" style="color:${data.trend === 'UP' ? '#ef4444' : data.trend === 'DOWN' ? '#22c55e' : '#8b8fa3'};">
        ${data.trend === 'UP' ? '↑ 上行' : data.trend === 'DOWN' ? '↓ 下行' : '→ 横盘'}
      </span>
    </div>
    <div class="chart-info-item">
      <span class="label">最新信号</span>
      <span class="value" style="color:${signal ? (signal.type === 'BUY' ? '#ef4444' : '#22c55e') : '#8b8fa3'};">
        ${signal ? (signal.type === 'BUY' ? '入场' : '出场') + ' (' + signal.date + agoText(data.signalDaysAgo) + ')' : '无信号'}
      </span>
    </div>
    <div class="chart-info-item">
      <span class="label">建议</span>
      <span class="value" style="color:${data.recommendationType === 'BUY' ? '#ef4444' : data.recommendationType === 'SELL' ? '#22c55e' : '#8b8fa3'};">
        ${data.recommendation}
      </span>
    </div>
  `;
}

// MA 周期按钮：当前为「多选显示」模式——高亮=显示该均线，点击切换显隐（不重新联网）
function updateMaBarUI() {
  document.querySelectorAll('#chartMaBar .ma-btn').forEach(b => {
    const p = parseInt(b.dataset.ma);
    b.classList.toggle('active', chartVisibleMa.has(p));
    b.style.borderColor = chartVisibleMa.has(p) ? MA_COLORS[p] : '';
  });
}

// 切换某条均线的显隐：仅重绘叠加层，无需重新计算或联网
function toggleMaLine(period) {
  if (chartVisibleMa.has(period)) chartVisibleMa.delete(period);
  else chartVisibleMa.add(period);
  if (chartVisibleMa.size === 0) {
    chartVisibleMa.add(period); // 至少保留一条，避免空白
    showToast('至少保留一条均线');
  }
  updateMaBarUI();
  if (lastChartData) renderKlineChart(lastChartData);
}

function renderKlineChart(data) {
  lastChartData = data;
  if (klineChartInstance) klineChartInstance.dispose();
  klineChartInstance = echarts.init(document.getElementById('klineChart'));

  const cd = data.chartData;
  const showCount = Math.min(90, cd.dates.length);
  const startIdx = cd.dates.length - showCount;

  const dates = cd.dates.slice(startIdx);
  const opens = cd.opens.slice(startIdx);
  const closes = cd.closes.slice(startIdx);
  const highs = cd.highs.slice(startIdx);
  const lows = cd.lows.slice(startIdx);
  const volumes = cd.volumes.slice(startIdx);
  // 多条均线叠加：仅绘制被勾选的周期
  const visibleMaList = MA_PERIODS.filter(p => chartVisibleMa.has(p) && cd.maLines && cd.maLines[p]);

  // K 线蜡烛数据: [open, close, low, high]
  const candlestickData = [];
  for (let i = 0; i < dates.length; i++) {
    candlestickData.push([opens[i], closes[i], lows[i], highs[i]]);
  }

  // 成交量数据（红涨绿跌，A股惯例）
  const volumeData = [];
  for (let i = 0; i < dates.length; i++) {
    const isUp = closes[i] >= opens[i];
    volumeData.push({
      value: volumes[i],
      itemStyle: { color: isUp ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.6)' },
    });
  }

  // ===== 买卖信号：标识统一置于图表正上方，虚线向下指引到对应K线 =====
  // 用一根 0~1 的隐藏辅助纵轴承载标识，使其始终吸附在顶部，不随价格缩放而漂移、也不遮挡K线
  const BUY_COLOR = '#ef4444';
  const SELL_COLOR = '#22c55e';
  const ROW_Y = [0.965, 0.885]; // 两行错位，避免相邻信号标识叠在一起

  const visibleSignals = data.signals
    .map(s => ({ ...s, relIdx: s.index - startIdx }))
    .filter(s => s.relIdx >= 0 && s.relIdx < dates.length)
    .sort((a, b) => a.relIdx - b.relIdx);

  const signalPoints = [];  // 顶部标识
  const guideLines = [];    // 指引虚线
  let lastPlacedIdx = -99;
  let row = 0;
  visibleSignals.forEach(s => {
    // 相邻太近则换到第二行，避免标识互相压盖
    row = (s.relIdx - lastPlacedIdx) < 5 ? (row + 1) % 2 : 0;
    lastPlacedIdx = s.relIdx;

    const isBuy = s.type === 'BUY';
    const color = isBuy ? BUY_COLOR : SELL_COLOR;
    const dateStr = dates[s.relIdx];

    signalPoints.push({
      value: [dateStr, ROW_Y[row]],
      sigType: s.type,
      sigDate: s.date,
      itemStyle: { color, borderColor: '#0f1117', borderWidth: 1.5 },
      label: {
        show: true,
        position: 'inside',
        formatter: isBuy ? '进' : '出',
        color: '#fff',
        fontSize: 10,
        fontWeight: 'bold',
      },
    });

    if (showGuideLines) {
      guideLines.push({
        xAxis: dateStr,
        // 虚线颜色跟随买卖标识
        lineStyle: { color, type: 'dashed', width: 1, opacity: 0.65 },
        label: { show: false },
        emphasis: { disabled: true },
      });
    }
  });

  const option = {
    backgroundColor: 'transparent',
    title: { text: `${data.name} K线走势图`, left: 'center', textStyle: { color: '#e0e0e0', fontSize: 14 } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(26, 29, 41, 0.95)',
      borderColor: '#3a3d4a',
      textStyle: { color: '#e0e0e0' },
      formatter: function(params) {
        const date = params[0].axisValue;
        let html = `<div style="font-weight:bold;margin-bottom:4px;">${date}</div>`;
        params.forEach(p => {
          if (p.seriesName === 'K线') {
            const d = p.data;
            const change = d[1] - d[0];
            const pct = ((change / d[0]) * 100).toFixed(2);
            const color = change >= 0 ? '#ef4444' : '#22c55e';
            html += `<div>开：<span style="color:${color}">¥${d[0].toFixed(2)}</span></div>`;
            html += `<div>收：<span style="color:${color}">¥${d[1].toFixed(2)}</span></div>`;
            html += `<div>低：¥${d[2].toFixed(2)}</div>`;
            html += `<div>高：¥${d[3].toFixed(2)}</div>`;
            html += `<div>涨跌：<span style="color:${color}">${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pct}%)</span></div>`;
          } else if (p.seriesName === '信号') {
            const isBuy = p.data && p.data.sigType === 'BUY';
            html += `<div style="margin-top:3px;font-weight:bold;color:${isBuy ? '#ef4444' : '#22c55e'};">▲ ${isBuy ? '入场信号' : '出场信号'}</div>`;
          } else if (p.seriesName === '成交量') {
            html += `<div>成交量：${(p.data.value / 10000).toFixed(0)}万手</div>`;
          } else if (p.seriesName.startsWith('MA')) {
            html += `<div>${p.seriesName}：¥${p.data !== null && p.data !== undefined ? p.data.toFixed(2) : '-'}</div>`;
          }
        });
        return html;
      },
    },
    legend: {
      data: ['K线', ...visibleMaList.map(p => `MA${p}`), '成交量'],
      top: 28,
      textStyle: { color: '#8b8fa3' },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: '8%', right: '4%', top: 65, height: '50%' },
      { left: '8%', right: '4%', top: '72%', height: '12%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        scale: true,
        axisLabel: { color: '#8b8fa3', fontSize: 10 },
        axisLine: { lineStyle: { color: '#3a3d4a' } },
        splitLine: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#3a3d4a' } },
      },
    ],
    yAxis: [
      {
        scale: true,
        axisLabel: { color: '#8b8fa3', formatter: '¥{value}' },
        splitLine: { lineStyle: { color: '#252836' } },
      },
      {
        gridIndex: 1,
        splitNumber: 2,
        axisLabel: { color: '#8b8fa3', formatter: function(v) { return (v / 10000).toFixed(0) + '万'; } },
        splitLine: { show: false },
      },
      // 隐藏辅助轴（0~1）：让买卖标识恒定吸附在主图顶部
      {
        gridIndex: 0,
        min: 0,
        max: 1,
        show: false,
        axisPointer: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 30, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], start: 30, end: 100, height: 18, bottom: 8, textStyle: { color: '#8b8fa3' } },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: candlestickData,
        // A股惯例：红涨绿跌
        itemStyle: {
          color: '#ef4444',        // 阳线（涨）红色
          color0: '#22c55e',       // 阴线（跌）绿色
          borderColor: '#ef4444',
          borderColor0: '#22c55e',
        },
      },
      {
        // 顶部买卖标识 + 指引虚线（挂在隐藏辅助轴上，恒定贴顶）
        name: '信号',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 2,
        data: signalPoints,
        symbol: 'circle',
        symbolSize: 19,
        z: 12,
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: guideLines,
          animation: false,
        },
      },
      ...visibleMaList.map(p => ({
        name: `MA${p}`,
        type: 'line',
        data: cd.maLines[p].slice(startIdx),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: MA_COLORS[p], width: 2 },
        z: 5,
      })),
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumeData,
      },
    ],
  };

  klineChartInstance.setOption(option);
}

function renderDerivativeChart(data) {
  if (derivativeChartInstance) derivativeChartInstance.dispose();
  derivativeChartInstance = echarts.init(document.getElementById('derivativeChart'));

  const cd = data.chartData;
  const showCount = Math.min(60, cd.dates.length);
  const startIdx = cd.dates.length - showCount;

  const option = {
    backgroundColor: 'transparent',
    title: { text: `MA${data.maPeriod} 导数变化（日均线求导）`, left: 'center', textStyle: { color: '#e0e0e0', fontSize: 14 } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(26, 29, 41, 0.95)',
      borderColor: '#3a3d4a',
      textStyle: { color: '#e0e0e0' },
      formatter: function(params) {
        const p = params[0];
        const val = p.value;
        if (val === null || val === undefined) return `${p.axisValue}<br/>导数: 无数据`;
        const sign = val > 0 ? '+' : '';
        const signal = val > 0 ? '↗ 上行（多头）' : val < 0 ? '↘ 下行（空头）' : '→ 横盘';
        return `${p.axisValue}<br/>导数: <b style="color:${val > 0 ? '#ef4444' : '#22c55e'}">${sign}${val.toFixed(4)}</b><br/>${signal}`;
      },
    },
    grid: { left: '8%', right: '5%', top: 50, bottom: 60 },
    xAxis: {
      type: 'category',
      data: cd.dates.slice(startIdx),
      axisLabel: { color: '#8b8fa3', fontSize: 11 },
      axisLine: { lineStyle: { color: '#3a3d4a' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8b8fa3', formatter: '{value}' },
      splitLine: { lineStyle: { color: '#252836' } },
    },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { type: 'slider', start: 0, end: 100, height: 20, bottom: 10, textStyle: { color: '#8b8fa3' } },
    ],
    series: [
      {
        name: '导数',
        type: 'bar',
        data: cd.derivative.slice(startIdx).map(v => ({
          value: v,
          itemStyle: {
            color: v > 0 ? 'rgba(239, 68, 68, 0.7)' : v < 0 ? 'rgba(34, 197, 94, 0.7)' : 'rgba(139, 143, 163, 0.3)',
          },
        })),
        markLine: {
          symbol: 'none',
          data: [{ yAxis: 0, lineStyle: { color: '#8b8fa3', width: 2, type: 'dashed' } }],
          label: { show: false },
        },
      },
    ],
  };

  derivativeChartInstance.setOption(option);
}

function toggleLandscape() {
  const isLandscape = chartModal.classList.toggle('landscape');
  landscapeBtn.textContent = isLandscape ? '↩ 竖屏' : '⛶ 横屏';
  if (isLandscape) {
    showToast('已横屏，请横置手机查看最佳效果');
  }
  // 等待 CSS 过渡完成后再调整图表尺寸
  setTimeout(() => {
    if (klineChartInstance) klineChartInstance.resize();
    if (derivativeChartInstance) derivativeChartInstance.resize();
  }, 300);
}

function renderSignalRecords(signals) {
  if (!signals || signals.length === 0) {
    signalRecords.innerHTML = '<p style="color:#8b8fa3;padding:12px;">暂无信号记录</p>';
    return;
  }

  // 按日期倒序
  const sorted = [...signals].reverse();
  signalRecords.innerHTML = sorted.map(s => `
    <div class="signal-record">
      <span class="signal-date">${s.date}</span>
      <span class="signal-type ${s.type.toLowerCase()}">${s.type === 'BUY' ? '入场' : '出场'}</span>
      <span class="signal-price">¥${s.price.toFixed(2)}</span>
      <span class="signal-strength">强度 ${s.strength.toFixed(2)}%</span>
      <span class="signal-desc">${s.desc}</span>
      <span style="color:#8b8fa3;font-size:12px;">导数: ${s.prevDerivative.toFixed(4)} → ${s.derivative.toFixed(4)}</span>
    </div>
  `).join('');
}

function closeModal() {
  lastChartData = null;
  chartModal.classList.remove('active');
  chartModal.classList.remove('landscape');
  landscapeBtn.textContent = '⛶ 横屏';
  chartSeq++; // 作废进行中的加载，避免关闭后仍写入DOM
  currentChartCode = null;
  currentChartIndex = -1;
  updateChartNav();
  if (klineChartInstance) { klineChartInstance.dispose(); klineChartInstance = null; }
  if (derivativeChartInstance) { derivativeChartInstance.dispose(); derivativeChartInstance = null; }
}

// ============ 持仓 / 模拟交易 / 微信提醒 ============
const LS_POS = 'sg_positions';
const LS_TRADES = 'sg_trades';
const LS_NOTIFY = 'sg_notify';
const LS_FAV = 'sg_favorites';

let positions = lsGet(LS_POS, []);
let trades = lsGet(LS_TRADES, []);
let notifyCfg = lsGet(LS_NOTIFY, { channel: 'none', token: '', interval: 30, alsoIn: false, onlyTradeDay: true });
// 收藏（观察）清单：无需买入，纯观察。字段用于信号巡检与提醒
let favorites = lsGet(LS_FAV, []);   // [{code,name,addTime,lastPrice,latestSignal,signalDaysAgo,lastUpdate,baselineKey,fresh}]
let favBaselineSet = false;
let favLastRefresh = 0;
let favRefreshing = false;
let favPendingAlerts = [];
let posMonitorTimer = null;
let activeTab = currentType;
let pendingTrade = null;
let riskResolve = null;
let posRefreshing = false;
let posBaselineSet = false;
let posLastRefresh = 0;
let pendingAlerts = [];

const RISK_FOOTER = '——\n本提醒由技术演示工具自动发送，仅基于均线导数指标状态，不构成任何投资建议。是否交易请您自行判断，风险自担。';

// 持仓页 / 弹窗 DOM 引用
const positionSection = document.getElementById('positionSection');
const favoriteSection = document.getElementById('favoriteSection');
const riskModal = document.getElementById('riskModal');
const riskOkBtn = document.getElementById('riskOkBtn');
const riskAgreeCheck = document.getElementById('riskAgreeCheck');
const riskCancelBtn = document.getElementById('riskCancelBtn');
const riskCloseBtn = document.getElementById('riskCloseBtn');
const tradeModal = document.getElementById('tradeModal');
const tradeTitle = document.getElementById('tradeTitle');
const tradeTarget = document.getElementById('tradeTarget');
const tradeCode = document.getElementById('tradeCode');
const tradeUnit = document.getElementById('tradeUnit');
const tradePrice = document.getElementById('tradePrice');
const tradeQty = document.getElementById('tradeQty');
const tradeDate = document.getElementById('tradeDate');
const tradeNote = document.getElementById('tradeNote');
const tradeAmount = document.getElementById('tradeAmount');
const tradeQuick = document.getElementById('tradeQuick');
const tradeSubmitBtn = document.getElementById('tradeSubmitBtn');
const tradeCancelBtn = document.getElementById('tradeCancelBtn');
const tradeCloseBtn = document.getElementById('tradeCloseBtn');
const tradeInBtn = document.getElementById('tradeInBtn');
const tradeOutBtn = document.getElementById('tradeOutBtn');
const tradeHold = document.getElementById('tradeHold');
const notifyModal = document.getElementById('notifyModal');
const notifyChannel = document.getElementById('notifyChannel');
const notifyToken = document.getElementById('notifyToken');
const notifyInterval = document.getElementById('notifyInterval');
const notifyAlsoIn = document.getElementById('notifyAlsoIn');
const notifyOnlyTradeDay = document.getElementById('notifyOnlyTradeDay');
const notifyStatus = document.getElementById('notifyStatus');
const notifyTestBtn = document.getElementById('notifyTestBtn');
const notifySaveBtn = document.getElementById('notifySaveBtn');
const notifyCloseBtn = document.getElementById('notifyCloseBtn');
const notifyHelp = document.getElementById('notifyHelp');
const notifyTokenLabel = document.getElementById('notifyTokenLabel');

// ---------- 基础工具 ----------
function lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch (e) { return def; }
}
function savePositions() { localStorage.setItem(LS_POS, JSON.stringify(positions)); updatePosBadge(); }
function saveTrades() { localStorage.setItem(LS_TRADES, JSON.stringify(trades)); }
function saveNotifyCfg() { localStorage.setItem(LS_NOTIFY, JSON.stringify(notifyCfg)); }
function saveFavorites() { localStorage.setItem(LS_FAV, JSON.stringify(favorites)); updateFavBadge(); }

// ---------- 收藏（观察） ----------
function isFav(code) { return favorites.some(f => f.code === code); }
function updateFavBadge() {
  const b = document.getElementById('favTabBadge');
  if (!b) return;
  if (favorites.length) { b.textContent = String(favorites.length); b.style.display = ''; }
  else b.style.display = 'none';
}
// 切换收藏状态；收藏变化若开启了提醒，由 refreshFavorites 巡检触发推送
async function toggleFav(code, name) {
  if (!code) return;
  if (!name || name === code) { try { const q = await fetchQuoteClient(code); if (q && q.name) name = q.name; } catch (e) {} }
  const i = favorites.findIndex(f => f.code === code);
  if (i >= 0) {
    favorites.splice(i, 1);
    showToast('已取消收藏');
  } else {
    favorites.push({
      code, name: name || code, addTime: Date.now(),
      lastPrice: 0, latestSignal: null, signalDaysAgo: null,
      lastUpdate: 0, baselineKey: null, fresh: true
    });
    showToast('已加入收藏 ⭐');
  }
  saveFavorites();
  syncFavButtons();
  if (activeTab === 'favorite') renderFavorites();
}
// 同步所有收藏按钮（卡片 / 表格 / 详情栏）的视觉状态
function syncFavButtons() {
  document.querySelectorAll('[data-fav]').forEach(btn => {
    const c = btn.getAttribute('data-fav');
    const on = isFav(c);
    btn.textContent = on ? '⭐' : '☆';
    btn.classList.toggle('on', on);
  });
  const tf = document.getElementById('tradeFavBtn');
  if (tf && currentChartCode) {
    const on = isFav(currentChartCode);
    tf.textContent = on ? '⭐ 已收藏' : '☆ 收藏';
    tf.classList.toggle('on', on);
  }
}
window.toggleFav = toggleFav;
function unitOf(code) {
  const b = getBoard(code);
  if (b === 'cb') return '张';
  if (b === 'etf') return '份';
  return '股';
}
function money(n) {
  const s = n < 0 ? '-' : '';
  return s + '¥' + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function todayStr() {
  const d = new Date(), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtTime(d) {
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function findPos(code) { return positions.find(p => p.code === code) || null; }

// ---------- 风险提示 ----------
function requireRiskConsent() {
  return new Promise(resolve => {
    riskResolve = resolve;
    riskModal.classList.add('active');
    riskOkBtn.disabled = true;
    riskAgreeCheck.checked = false;
  });
}
function resolveRisk(agreed) {
  riskModal.classList.remove('active');
  const r = riskResolve; riskResolve = null;
  if (r) r(agreed);
}

// ---------- 模拟交易 ----------
async function startTrade(side, code, name, price) {
  const ok = await requireRiskConsent();
  if (!ok) return;
  openTradeForm({ side, code, name, price });
}
function openTradeForm({ side, code = '', name = '', price = 0 }) {
  pendingTrade = { side };
  tradeTitle.textContent = side === 'IN' ? '模拟入场' : '模拟出场';
  tradeTarget.innerHTML = code
    ? `标的：<strong>${name || code}</strong> <span style="color:#8b8fa3;">(${code})</span>`
    : '手动建仓：请填写标的代码与成交信息';
  tradeCode.value = code || '';
  tradeUnit.textContent = unitOf(code);
  tradePrice.value = price && price > 0 ? Number(price).toFixed(2) : '';
  tradeQty.value = '';
  tradeDate.value = todayStr();
  tradeNote.value = '';
  renderTradeQuick(code);
  updateTradeAmount();
  tradeModal.classList.add('active');
}
function renderTradeQuick(code) {
  const u = unitOf(code);
  const opts = u === '张' ? [10, 20, 50, 100] : [100, 200, 500, 1000];
  tradeQuick.innerHTML = opts.map(q => `<button type="button" data-q="${q}">${q}</button>`).join('');
  tradeQuick.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      tradeQty.value = (parseInt(tradeQty.value) || 0) + parseInt(b.dataset.q);
      updateTradeAmount();
    });
  });
}
function updateTradeAmount() {
  const p = parseFloat(tradePrice.value) || 0, q = parseFloat(tradeQty.value) || 0;
  tradeAmount.textContent = '预计金额：' + money(p * q);
}
async function submitTrade() {
  const side = pendingTrade ? pendingTrade.side : 'IN';
  const code = (tradeCode.value || '').trim();
  const price = parseFloat(tradePrice.value) || 0;
  const qty = parseFloat(tradeQty.value) || 0;
  const date = tradeDate.value || todayStr();
  const note = tradeNote.value.trim();
  if (!code) { showToast('请填写标的代码'); return; }
  if (!(price > 0)) { showToast('请填写有效成交价格'); return; }
  if (!(qty > 0)) { showToast('请填写有效数量'); return; }
  let name = (tradeTarget.textContent.match(/<strong>(.*?)<\/strong>/) || [])[1] || code;
  if (name === code) { try { const q = await fetchQuoteClient(code); if (q && q.name) name = q.name; } catch (e) {} }
  const unit = unitOf(code);
  const amount = price * qty;
  const trade = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), code, name, side, price, qty, date, note, unit, amount, time: Date.now() };
  trades.unshift(trade);
  if (side === 'IN') {
    let pos = findPos(code);
    if (!pos) { pos = { code, name, unit, qty: 0, avgCost: 0, openDate: date, openPrice: price, baselineKey: null, fresh: true }; positions.push(pos); }
    const newQty = pos.qty + qty;
    pos.avgCost = (pos.avgCost * pos.qty + price * qty) / newQty;
    pos.qty = newQty;
    pos.name = name; pos.unit = unit;
  } else {
    const pos = findPos(code);
    if (!pos) { showToast('该标的无持仓，无法出场'); return; }
    if (qty > pos.qty) { showToast('出场数量超过持仓'); return; }
    const realized = (price - pos.avgCost) * qty;
    trade.realizedPnl = realized;
    pos.qty -= qty;
    if (pos.qty <= 1e-9) positions = positions.filter(p => p.code !== code);
  }
  saveTrades(); savePositions();
  tradeModal.classList.remove('active');
  showToast(side === 'IN' ? '已记录模拟入场' : '已记录模拟出场');
  if (activeTab === 'position') renderPositions();
  syncTradeBar();
}
async function closePosition(code) {
  const pos = findPos(code);
  if (!pos) return;
  const price = pos.lastPrice && pos.lastPrice > 0 ? pos.lastPrice : pos.avgCost;
  const ok = await requireRiskConsent();
  if (!ok) return;
  const amount = price * pos.qty;
  trades.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    code, name: pos.name, side: 'OUT', price, qty: pos.qty,
    date: todayStr(), note: '一键平仓', unit: pos.unit,
    amount, realizedPnl: (price - pos.avgCost) * pos.qty, time: Date.now()
  });
  positions = positions.filter(p => p.code !== code);
  saveTrades(); savePositions();
  showToast('已平仓（模拟）');
  renderPositions(); syncTradeBar();
}

// ---------- 收藏（观察）渲染与巡检 ----------
function renderFavorites() {
  const list = document.getElementById('favList');
  const empty = document.getElementById('favEmpty');
  if (!list) return;
  if (!favorites.length) { list.innerHTML = ''; if (empty) empty.style.display = ''; renderFavMonitor(); updateFavBadge(); return; }
  if (empty) empty.style.display = 'none';
  let sigN = 0, buyN = 0, sellN = 0;
  const cards = favorites.map(f => {
    const price = f.lastPrice && f.lastPrice > 0 ? f.lastPrice : 0;
    const sig = f.latestSignal;
    if (sig) { sigN++; if (sig.type === 'SELL') sellN++; else buyN++; }
    const sigAlert = (sig && f.signalDaysAgo != null && f.signalDaysAgo <= 5)
      ? (sig.type === 'SELL'
          ? `<div class="pos-sig-alert">⚠️ 出现出场信号（${sig.date}，${f.signalDaysAgo} 日前），可留意减仓 / 出场时机</div>`
          : `<div class="pos-sig-alert in">出现入场信号（${sig.date}），可留意加仓时机</div>`)
      : '';
    return `
    <div class="pos-card">
      <div class="pos-card-head" onclick="showChart('${f.code}')" style="cursor:pointer;" title="点击查看 K 线">
        <span class="pos-name">${f.name}</span>
        <span class="pos-code">${f.code}</span>
      </div>
      <div class="pos-rows">
        <div><span>现价</span><b>${price > 0 ? '¥' + price.toFixed(2) : '—'}</b></div>
        <div><span>最新信号</span><b>${sig ? (sig.type === 'BUY' ? '入场' : '出场') + ' (' + sig.date + ')' : '无'}</b></div>
      </div>
      ${sigAlert}
      <div class="pos-card-actions">
        <button class="btn-mini chart" onclick="showChart('${f.code}')">📊 K线</button>
        <button class="btn-mini" onclick="window.toggleFav('${f.code}','${f.name}')">取消收藏</button>
      </div>
    </div>`;
  }).join('');
  list.innerHTML = cards;
  document.getElementById('favCount').textContent = favorites.length;
  document.getElementById('favSigCount').textContent = sigN;
  document.getElementById('favBuyCount').textContent = buyN;
  document.getElementById('favSellCount').textContent = sellN;
  renderFavMonitor();
  updateFavBadge();
}
async function refreshFavorites() {
  if (!favorites.length) { renderFavorites(); return; }
  if (favRefreshing) return;
  favRefreshing = true;
  try {
    const maPeriod = parseInt(maPeriodSelect.value);
    const minStrength = parseFloat(minStrengthSlider.value) / 100;
    await Promise.all(favorites.map(async f => {
      try {
        const [kline, quote] = await Promise.all([fetchKlineClient(f.code, 120), fetchQuoteClient(f.code)]);
        if (kline && kline.length) {
          const data = analyzeStockClient(f.code, f.name, kline, maPeriod, minStrength);
          const price = (quote && quote.price > 0) ? quote.price : data.lastClose;
          if (quote && quote.name) f.name = quote.name;
          f.lastPrice = price;
          f.latestSignal = data.latestSignal;
          f.signalDaysAgo = data.signalDaysAgo;
          f.lastUpdate = Date.now();
          const key = data.latestSignal ? (data.latestSignal.date + data.latestSignal.type) : null;
          if (!favBaselineSet) {
            f.baselineKey = key;
          } else if (f.fresh) {
            f.baselineKey = key; f.fresh = false;
          } else if (f.baselineKey !== key) {
            f.baselineKey = key;
            if (key) favPendingAlerts.push({ code: f.code, name: f.name, type: data.latestSignal.type, date: data.latestSignal.date, price });
          }
        } else if (quote && quote.price > 0) {
          f.lastPrice = quote.price; f.lastUpdate = Date.now();
        }
      } catch (e) { /* 忽略单标的错误 */ }
    }));
    favBaselineSet = true;
    favLastRefresh = Date.now();
    if (favPendingAlerts.length) { pushAlerts(favPendingAlerts, 'favorite'); favPendingAlerts = []; }
    renderFavorites();
  } finally { favRefreshing = false; }
}
function renderFavMonitor() {
  const el = document.getElementById('favMonitor');
  if (!el) return;
  if (notifyCfg.channel === 'none') {
    el.innerHTML = `<span class="mb-dot off"></span> 微信提醒未开启 · <a href="javascript:void(0)" id="favOpenNotify">去设置</a>`;
  } else {
    const t = new Date(favLastRefresh || Date.now());
    el.innerHTML = `<span class="mb-dot on"></span> 收藏巡检中：每 ${notifyCfg.interval} 分钟 · 通道 ${notifyCfg.channel === 'pushplus' ? 'PushPlus' : 'Server酱'} · 上次刷新 ${favLastRefresh ? fmtTime(t) : '—'}`;
  }
  const fbn = document.getElementById('favOpenNotify');
  if (fbn) fbn.addEventListener('click', openNotifySettings);
}
function enterFavoriteView() {
  activeTab = 'favorite';
  resultsSection.style.display = 'none';
  emptyState.style.display = 'none';
  if (positionSection) positionSection.style.display = 'none';
  if (favoriteSection) favoriteSection.style.display = '';
  renderFavorites();
  refreshFavorites();
  renderFavMonitor();
}
function exitFavoriteView() {
  if (favoriteSection) favoriteSection.style.display = 'none';
  if (displayedResults.length > 0) { resultsSection.style.display = ''; emptyState.style.display = 'none'; }
  else { resultsSection.style.display = 'none'; emptyState.style.display = ''; }
  typeTabs.forEach(x => x.classList.toggle('active', x.dataset.type === currentType));
  activeTab = currentType;
}

// ---------- 持仓渲染 ----------
function posPnl(pos, price) {
  const p = price && price > 0 ? price : pos.avgCost;
  const pnl = (p - pos.avgCost) * pos.qty;
  const pct = pos.avgCost > 0 ? pnl / (pos.avgCost * pos.qty) * 100 : 0;
  return { pnl, pct };
}
function renderPositions() {
  const list = document.getElementById('posList');
  const empty = document.getElementById('posEmpty');
  if (!list) return;
  if (!positions.length) { list.innerHTML = ''; if (empty) empty.style.display = ''; renderMonitorBar(); updatePosBadge(); return; }
  if (empty) empty.style.display = 'none';
  let totValue = 0, totCost = 0, totPnl = 0;
  const cards = positions.map(pos => {
    const price = pos.lastPrice && pos.lastPrice > 0 ? pos.lastPrice : pos.avgCost;
    const { pnl, pct } = posPnl(pos, price);
    totValue += price * pos.qty; totCost += pos.avgCost * pos.qty; totPnl += pnl;
    const cls = pnl >= 0 ? 'profit' : 'loss';
    const sig = pos.latestSignal;
    let sigAlert = '';
    if (sig && pos.signalDaysAgo != null && pos.signalDaysAgo <= 5) {
      sigAlert = sig.type === 'SELL'
        ? `<div class="pos-sig-alert">⚠️ 出现出场信号（${sig.date}，${pos.signalDaysAgo} 日前），可留意减仓 / 出场时机</div>`
        : `<div class="pos-sig-alert in">出现入场信号（${sig.date}），可留意加仓时机</div>`;
    }
    return `
    <div class="pos-card">
      <div class="pos-card-head" title="点击查看 K 线" onclick="showChart('${pos.code}')" style="cursor:pointer;">
        <span class="pos-name">${pos.name}</span>
        <span class="pos-code">${pos.code}</span>
        <span class="pos-qty">${pos.qty}${pos.unit}</span>
      </div>
      <div class="pos-rows">
        <div><span>成本</span><b>¥${pos.avgCost.toFixed(2)}</b></div>
        <div><span>现价</span><b>¥${price.toFixed(2)}</b></div>
        <div><span>市值</span><b>${money(price * pos.qty)}</b></div>
        <div><span>盈亏</span><b class="${cls}">${pnl >= 0 ? '+' : ''}${money(pnl)}</b></div>
        <div><span>盈亏比例</span><b class="${cls}">${pct.toFixed(2)}%</b></div>
        <div><span>建仓日</span><b>${pos.openDate || '-'}</b></div>
      </div>
      ${sigAlert}
      <div class="pos-card-actions">
        <button class="btn-mini chart" onclick="showChart('${pos.code}')">📊 K线</button>
        <button class="btn-mini" onclick="window.posTrade('in','${pos.code}','${pos.name.replace(/'/g, '')}',${price})">加仓</button>
        <button class="btn-mini" onclick="window.posTrade('out','${pos.code}','${pos.name.replace(/'/g, '')}',${price})">减仓</button>
        <button class="btn-mini danger" onclick="window.closePosition('${pos.code}')">平仓</button>
      </div>
    </div>`;
  }).join('');
  list.innerHTML = cards;
  document.getElementById('posTotalValue').textContent = money(totValue);
  document.getElementById('posTotalCost').textContent = money(totCost);
  const tp = totPnl >= 0 ? 'profit' : 'loss';
  const tpct = totCost > 0 ? totPnl / totCost * 100 : 0;
  const tv = document.getElementById('posTotalPnl'); tv.textContent = (totPnl >= 0 ? '+' : '') + money(totPnl); tv.className = 'ps-value ' + tp;
  const tp2 = document.getElementById('posTotalPnlPct'); tp2.textContent = (tpct >= 0 ? '+' : '') + tpct.toFixed(2) + '%'; tp2.className = 'ps-value ' + tp;
  document.getElementById('posTotalValue').className = 'ps-value';
  document.getElementById('posTotalCost').className = 'ps-value';
  renderMonitorBar(); updatePosBadge();
}
function updatePosBadge() {
  const badge = document.getElementById('posTabBadge');
  if (!badge) return;
  const n = positions.length;
  badge.style.display = n > 0 ? '' : 'none';
  badge.textContent = n;
}
function renderMonitorBar() {
  const el = document.getElementById('posMonitor');
  if (!el) return;
  if (notifyCfg.channel === 'none') {
    el.innerHTML = `<span class="mb-dot off"></span> 微信提醒未开启 · <a href="javascript:void(0)" id="mbOpenNotify">去设置</a>`;
  } else {
    const t = new Date(posLastRefresh || Date.now());
    el.innerHTML = `<span class="mb-dot on"></span> 巡检中：每 ${notifyCfg.interval} 分钟 · 通道 ${notifyCfg.channel === 'pushplus' ? 'PushPlus' : 'Server酱'} · 上次刷新 ${posLastRefresh ? fmtTime(t) : '—'}`;
  }
  const mbn = document.getElementById('mbOpenNotify');
  if (mbn) mbn.addEventListener('click', openNotifySettings);
}
function renderTradeHistory() {
  const box = document.getElementById('posHistoryBox');
  const list = document.getElementById('posHistoryList');
  if (!box || !list) return;
  if (!trades.length) { list.innerHTML = '<p style="color:#8b8fa3;padding:8px;">暂无交易记录</p>'; return; }
  list.innerHTML = trades.map(t => {
    const cls = t.side === 'IN' ? 'in' : 'out';
    const rp = t.realizedPnl != null
      ? `<span class="${t.realizedPnl >= 0 ? 'profit' : 'loss'}">盈亏 ${t.realizedPnl >= 0 ? '+' : ''}${money(t.realizedPnl)}</span>` : '';
    return `<div class="th-item th-${cls}">
      <span class="th-date">${t.date}</span>
      <span class="th-name">${t.name}(${t.code})</span>
      <span class="th-side">${t.side === 'IN' ? '入场' : '出场'}</span>
      <span class="th-price">¥${t.price.toFixed(2)} × ${t.qty}${t.unit}</span>
      <span class="th-amt">${money(t.amount)}</span>
      ${rp}
      ${t.note ? `<span class="th-note">${t.note}</span>` : ''}
    </div>`;
  }).join('');
}

// ---------- 刷新行情与信号 + 新信号推送 ----------
async function refreshPositions() {
  if (!positions.length) { renderPositions(); return; }
  if (posRefreshing) return;
  posRefreshing = true;
  try {
    const maPeriod = parseInt(maPeriodSelect.value);
    const minStrength = parseFloat(minStrengthSlider.value) / 100;
    await Promise.all(positions.map(async pos => {
      try {
        const [kline, quote] = await Promise.all([fetchKlineClient(pos.code, 120), fetchQuoteClient(pos.code)]);
        if (kline && kline.length) {
          const data = analyzeStockClient(pos.code, pos.name, kline, maPeriod, minStrength);
          const price = (quote && quote.price > 0) ? quote.price : data.lastClose;
          if (quote && quote.name) pos.name = quote.name;
          pos.lastPrice = price;
          pos.latestSignal = data.latestSignal;
          pos.signalDaysAgo = data.signalDaysAgo;
          pos.lastUpdate = Date.now();
          const key = data.latestSignal ? (data.latestSignal.date + data.latestSignal.type) : null;
          if (!posBaselineSet) {
            pos.baselineKey = key;
          } else if (pos.fresh) {
            pos.baselineKey = key; pos.fresh = false;
          } else if (pos.baselineKey !== key) {
            pos.baselineKey = key;
            if (key) {
              const isSell = data.latestSignal.type === 'SELL';
              const isBuy = data.latestSignal.type === 'BUY';
              if (isSell || (isBuy && notifyCfg.alsoIn)) {
                pendingAlerts.push({ code: pos.code, name: pos.name, type: data.latestSignal.type, date: data.latestSignal.date, price });
              }
            }
          }
        } else if (quote && quote.price > 0) {
          pos.lastPrice = quote.price; pos.lastUpdate = Date.now();
        }
      } catch (e) { /* 忽略单标的错误 */ }
    }));
    posBaselineSet = true;
    posLastRefresh = Date.now();
    if (pendingAlerts.length) { pushAlerts(pendingAlerts); pendingAlerts = []; }
    renderPositions();
  } finally { posRefreshing = false; }
}

// ---------- 微信推送（纯前端直连，CORS 已验证） ----------
async function sendWechat(title, content) {
  if (notifyCfg.channel === 'none' || !notifyCfg.token) return false;
  const text = content + '\n\n' + RISK_FOOTER;
  try {
    if (notifyCfg.channel === 'pushplus') {
      const url = `https://www.pushplus.plus/send?token=${encodeURIComponent(notifyCfg.token)}&title=${encodeURIComponent(title)}&content=${encodeURIComponent(text)}`;
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      return j.code === 200;
    } else if (notifyCfg.channel === 'serverchan') {
      const url = `https://sctapi.ftqq.com/${encodeURIComponent(notifyCfg.token)}.send?title=${encodeURIComponent(title)}&desp=${encodeURIComponent(text)}`;
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      return j.code === 0;
    }
  } catch (e) { return false; }
  return false;
}
async function pushAlerts(list, kind = 'position') {
  if (notifyCfg.channel === 'none' || !notifyCfg.token) return;
  if (notifyCfg.onlyTradeDay && !inTradingWindow()) return;
  const tag = kind === 'favorite' ? '收藏提醒' : '持仓提醒';
  const prefix = kind === 'favorite' ? '您收藏观察的' : '';
  for (const a of list) {
    const typeLabel = a.type === 'SELL' ? '出场' : '入场';
    const title = `【${tag}】${a.name}(${a.code}) 出现${typeLabel}信号`;
    const content = `${prefix}${a.name}（${a.code}）于 ${a.date} 出现${typeLabel}信号，现价约 ¥${a.price.toFixed(2)}。\n请打开应用查看详情，自行判断是否操作。`;
    await sendWechat(title, content);
  }
}
function inTradingWindow() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const hm = d.getHours() * 60 + d.getMinutes();
  return hm >= 570 && hm <= 910; // 09:30=570, 15:10=910
}

// ---------- 提醒设置 ----------
function openNotifySettings() {
  notifyChannel.value = notifyCfg.channel || 'none';
  notifyToken.value = notifyCfg.token || '';
  notifyInterval.value = String(notifyCfg.interval || 30);
  notifyAlsoIn.checked = !!notifyCfg.alsoIn;
  notifyOnlyTradeDay.checked = notifyCfg.onlyTradeDay !== false;
  notifyStatus.textContent = '';
  syncNotifyHelp();
  notifyModal.classList.add('active');
}
function syncNotifyHelp() {
  const ch = notifyChannel.value;
  if (ch === 'pushplus') {
    notifyTokenLabel.textContent = 'PushPlus Token';
    notifyHelp.innerHTML = '登录 pushplus.plus → 首页复制「token」。免费额度约每日 200 条。';
  } else if (ch === 'serverchan') {
    notifyTokenLabel.textContent = 'Server酱 SendKey';
    notifyHelp.innerHTML = '登录 sct.ftqq.com → 「SendKey」页面复制。免费额度约每日 5 条。';
  } else {
    notifyTokenLabel.textContent = 'Token / SendKey';
    notifyHelp.innerHTML = '开启提醒后需填写对应通道的 token。';
  }
}
function saveNotify() {
  notifyCfg = {
    channel: notifyChannel.value,
    token: notifyToken.value.trim(),
    interval: parseInt(notifyInterval.value) || 30,
    alsoIn: notifyAlsoIn.checked,
    onlyTradeDay: notifyOnlyTradeDay.checked,
  };
  saveNotifyCfg();
  startMonitor();
  notifyStatus.innerHTML = '<span style="color:#22c55e;">✓ 设置已保存</span>';
  renderMonitorBar();
  setTimeout(() => { notifyModal.classList.remove('active'); }, 800);
}
async function testNotify() {
  if (!notifyToken.value.trim()) { notifyStatus.innerHTML = '<span style="color:#ef4444;">请先填写 token</span>'; return; }
  notifyCfg.token = notifyToken.value.trim();
  notifyCfg.channel = notifyChannel.value;
  notifyStatus.innerHTML = '发送中…';
  const ok = await sendWechat('【测试】持仓提醒推送', '这是一条测试消息，说明推送通道已连通。');
  notifyStatus.innerHTML = ok
    ? '<span style="color:#22c55e;">✓ 测试推送已发送，请查收微信</span>'
    : '<span style="color:#ef4444;">✗ 发送失败，请检查 token 与通道</span>';
}

// ---------- 视图切换 ----------
function enterPositionView() {
  activeTab = 'position';
  resultsSection.style.display = 'none';
  emptyState.style.display = 'none';
  positionSection.style.display = '';
  renderPositions();
  refreshPositions();
  renderMonitorBar();
}
function exitPositionView() {
  positionSection.style.display = 'none';
  if (displayedResults.length > 0) { resultsSection.style.display = ''; emptyState.style.display = 'none'; }
  else { resultsSection.style.display = 'none'; emptyState.style.display = ''; }
  typeTabs.forEach(x => x.classList.toggle('active', x.dataset.type === currentType));
  activeTab = currentType;
}

// ---------- 图表弹窗交易栏 ----------
function syncTradeBar() {
  if (!tradeHold) return;
  const code = currentChartCode;
  if (!code) { tradeHold.textContent = '未持仓'; tradeHold.className = 'trade-hold'; return; }
  const pos = findPos(code);
  if (pos) { tradeHold.textContent = `持仓 ${pos.qty}${pos.unit} · 成本¥${pos.avgCost.toFixed(2)}`; tradeHold.className = 'trade-hold holding'; }
  else { tradeHold.textContent = '未持仓'; tradeHold.className = 'trade-hold'; }
  const tf = document.getElementById('tradeFavBtn');
  if (tf) {
    const on = isFav(code);
    tf.textContent = on ? '⭐ 已收藏' : '☆ 收藏';
    tf.classList.toggle('on', on);
  }
}
function posTrade(side, code, name, price) {
  code = code || currentChartCode;
  if (!code) { showToast('请先选择标的'); return; }
  name = name || (lastChartData && lastChartData.name) || code;
  price = price || (lastChartData && lastChartData.lastClose) || 0;
  startTrade(side === 'in' ? 'IN' : 'OUT', code, name, price);
}

// ---------- 巡检定时器 ----------
function startMonitor() {
  if (posMonitorTimer) clearInterval(posMonitorTimer);
  const iv = (notifyCfg.interval || 30) * 60 * 1000;
  posMonitorTimer = setInterval(() => {
    if (notifyCfg.channel === 'none') return;
    if (notifyCfg.onlyTradeDay && !inTradingWindow()) return;
    Promise.all([refreshPositions(), refreshFavorites()]);
  }, iv);
}

// ---------- 模块初始化 ----------
function initPositionModule() {
  // 风险声明
  riskAgreeCheck.addEventListener('change', () => { riskOkBtn.disabled = !riskAgreeCheck.checked; });
  riskOkBtn.addEventListener('click', () => resolveRisk(true));
  riskCancelBtn.addEventListener('click', () => resolveRisk(false));
  riskCloseBtn.addEventListener('click', () => resolveRisk(false));
  riskModal.addEventListener('click', e => { if (e.target === riskModal) resolveRisk(false); });
  // 交易表单
  tradeInBtn.addEventListener('click', () => posTrade('in'));
  tradeOutBtn.addEventListener('click', () => posTrade('out'));
  tradePrice.addEventListener('input', updateTradeAmount);
  tradeQty.addEventListener('input', updateTradeAmount);
  tradeSubmitBtn.addEventListener('click', submitTrade);
  tradeCancelBtn.addEventListener('click', () => tradeModal.classList.remove('active'));
  tradeCloseBtn.addEventListener('click', () => tradeModal.classList.remove('active'));
  tradeModal.addEventListener('click', e => { if (e.target === tradeModal) tradeModal.classList.remove('active'); });
  // 持仓页按钮
  document.getElementById('posRefreshBtn').addEventListener('click', refreshPositions);
  document.getElementById('posNotifyBtn').addEventListener('click', openNotifySettings);
  document.getElementById('posAddBtn').addEventListener('click', () => startTrade('IN'));
  document.getElementById('posHistoryBtn').addEventListener('click', () => {
    const box = document.getElementById('posHistoryBox');
    box.style.display = box.style.display === 'none' ? '' : 'none';
    renderTradeHistory();
  });
  document.getElementById('posHistoryClearBtn').addEventListener('click', () => {
    if (confirm('确定清空全部交易记录？此操作不可恢复。')) { trades = []; saveTrades(); renderTradeHistory(); }
  });
  // 提醒设置
  notifyCloseBtn.addEventListener('click', () => notifyModal.classList.remove('active'));
  notifyModal.addEventListener('click', e => { if (e.target === notifyModal) notifyModal.classList.remove('active'); });
  notifyChannel.addEventListener('change', syncNotifyHelp);
  notifySaveBtn.addEventListener('click', saveNotify);
  notifyTestBtn.addEventListener('click', testNotify);
  // 收藏页按钮
  const favRefreshBtn = document.getElementById('favRefreshBtn');
  if (favRefreshBtn) favRefreshBtn.addEventListener('click', refreshFavorites);
  const favNotifyBtn = document.getElementById('favNotifyBtn');
  if (favNotifyBtn) favNotifyBtn.addEventListener('click', openNotifySettings);
  const tradeFavBtn = document.getElementById('tradeFavBtn');
  if (tradeFavBtn) tradeFavBtn.addEventListener('click', () => window.toggleFav(currentChartCode, lastChartData ? lastChartData.name : currentChartCode));
  // 页面可见时补检
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && notifyCfg.channel !== 'none') { refreshPositions(); refreshFavorites(); }
  });
  // 启动巡检
  updateFavBadge();
  startMonitor();
  updatePosBadge();
}

// 暴露给全局（供持仓卡片内联 onclick 调用）
window.closePosition = closePosition;
window.posTrade = posTrade;

// ============ 工具函数 ============
function showToast(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #252836; color: #e0e0e0; padding: 12px 24px;
    border-radius: 8px; border: 1px solid #3a3d4a; z-index: 2000;
    font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// 暴露给全局
window.removeStock = removeStock;
window.showChart = showChart;

// 启动
init();
