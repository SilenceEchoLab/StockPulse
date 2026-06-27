// 回测引擎 —— 对应《选股交易操作手册》第三~六步的完整买卖与风控体系
//
// 核心原则：
//   1. 防未来函数：T 日收盘产生信号，T+1 日开盘成交（信号用 rows[0..i-1]，成交用 rows[i]）
//   2. 完整风控：ATR止损 + 固定止损 + 移动止盈(让利润奔跑) + 固定止盈 + 时间止损 + 信号止损
//   3. 涨跌停处理：开盘涨停买不进、一字跌停卖不出
//   4. 完整指标：夏普/Sortino/Calmar/盈亏比/最大连亏/平均持仓/超额收益(alpha)
//
// 策略：
//   three_cycle —— 三周期共振（周线趋势+日线结构+时机确认，手册黄金点）
//   macd_cross  —— MACD 金叉买/死叉卖（保留）
//   rsi_reversal—— RSI 超卖买/超买卖（保留）
//   ma520       —— 520 战法 MA5/MA20 金叉买/死叉卖

import type { KlineRow } from './signalEngine.js';
import { scoreMultiCycle } from './cycles.js';

const safe = (v: number | null | undefined): number | null =>
  (typeof v === 'number' && isFinite(v)) ? v : null;

export type StrategyType = 'three_cycle' | 'macd_cross' | 'rsi_reversal' | 'ma520';

export interface BacktestParams {
  scoreThreshold?: number;    // 三周期共振得分阈值（默认 60）
  requireResonant?: boolean;  // 是否要求 resonant=true（默认 false）
  stopLoss?: number;          // 固定止损比例（默认 0.08）
  takeProfit?: number;        // 固定止盈比例（默认 0.30）
  trailingStop?: number;      // 移动止盈回撤比例（默认 0.12）
  atrMultiple?: number;       // ATR 止损倍数（默认 2）
  maxHoldDays?: number;       // 时间止损天数（默认 30）
  positionPct?: number;       // 单次开仓占总资金比例（默认 0.3）
  rsiBuy?: number;            // RSI 买入阈值（默认 30）
  rsiSell?: number;           // RSI 卖出阈值（默认 70）
  marketRegime?: 'bull' | 'range' | 'bear'; // 大盘择时：bear市禁买
  // 分批/金字塔建仓（手册 4.3）：首仓试错 + 盈利后加仓 + 亏损绝不补。默认关，开启时分批入场
  stagedEntry?: boolean;
  trialFraction?: number;     // 首仓占 positionPct 的比例（默认 0.4，即 ~12% 若 positionPct=0.30）
}

export interface BacktestConfig {
  strategy: StrategyType;
  params: BacktestParams;
  fees: { buy: number; sell: number }; // 费率（含佣金+印花税等）
  slippage?: number;                   // 滑点（默认 0.001）
  initialCapital: number;
  trials?: number;                     // 多重检验试验数（参数组合×策略数），用于 deflated Sharpe 校正
}

// deflated Sharpe Ratio（Bailey & López de Prado 2014）—— 多重检验校正
// 在 N 次试验下，即使零假设(无 edge)，最大夏普的期望 = SE * sqrt(2·ln N)。
// deflated = 实际年化夏普 - 该期望。>0 才说明校正多重检验后仍有 edge。
function deflatedSharpeRatio(annualSharpe: number, dailyRets: number[], trials: number): number {
  const n = dailyRets.length;
  if (n < 10 || !trials || trials <= 1) return annualSharpe;
  const mean = dailyRets.reduce((a, b) => a + b, 0) / n;
  const m2 = dailyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const m3 = dailyRets.reduce((s, r) => s + (r - mean) ** 3, 0) / n;
  const m4 = dailyRets.reduce((s, r) => s + (r - mean) ** 4, 0) / n;
  const std = Math.sqrt(m2);
  if (std === 0) return annualSharpe;
  const skew = m3 / (std ** 3);
  const kurt = m4 / (m2 * m2);             // 原始峰度（正态=3）
  const dailySR = mean / std;
  // Lo(2002) 夏普方差（日频），含偏度/峰度校正
  const varSRdaily = (1 - skew * dailySR + (kurt - 1) / 4 * dailySR * dailySR) / (n - 1);
  const seAnnual = Math.sqrt(Math.max(varSRdaily, 1e-12)) * Math.sqrt(252);
  const SR0 = seAnnual * Math.sqrt(2 * Math.log(trials));  // 零假设下 N 次试验的期望最大夏普
  return annualSharpe - SR0;
}

export interface Trade {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  cost: number;       // 买入总成本（含费）
  revenue: number;    // 卖出净收入（扣费）
  pnl: number;        // 绝对盈亏
  pnlPct: number;     // 收益率
  holdDays: number;
  exitReason: string;
}

export interface BacktestMetrics {
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  winRate: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  profitFactor: number;        // 盈亏比 = 总盈利/总亏损
  avgWin: number;              // 平均盈利笔收益率
  avgLoss: number;             // 平均亏损笔收益率
  maxConsecutiveLosses: number;// 最大连续亏损笔数
  avgHoldDays: number;
  tradeCount: number;
  finalCapital: number;
  alpha: number | null;        // 超额收益（相对基准，无基准则 null）
  benchmarkReturn: number | null;
  deflatedSharpe: number | null; // deflated Sharpe（多重检验校正后）—— edge 显著性地基
}

export interface BacktestResult {
  marketCode: string;
  metrics: BacktestMetrics;
  trades: Trade[];
  equityCurve: { date: string; equity: number }[];
}

// 涨停幅度判定（主板10% / 创业板科创板20% / 北交所30%）
function limitPctOf(code: string): number {
  if (code.startsWith('bj')) return 0.30;
  if (code.startsWith('sh688') || code.startsWith('sz30')) return 0.20;
  return 0.10;
}

// 判定 T+1 开盘是否涨停（买不进）
function isOpenLimitUp(code: string, openPrice: number, prevClose: number): boolean {
  if (!prevClose || prevClose <= 0) return false;
  const limit = limitPctOf(code);
  return openPrice / prevClose - 1 >= limit - 0.005;
}

// 判定 T+1 是否一字跌停（卖不出）
function isLockLimitDown(code: string, day: KlineRow, prevClose: number): boolean {
  if (!prevClose || prevClose <= 0) return false;
  const limit = limitPctOf(code);
  const limitDownPrice = prevClose * (1 - limit);
  // 一字跌停：开=高=低=收 且 接近跌停价
  return day.open === day.high && day.high === day.low && day.low <= limitDownPrice * 1.005;
}

// 策略信号：基于 rows[0..i-1]（T日及之前）产生 BUY/SELL/HOLD
// 防未来函数：信号用 rows[0..i-1]，成交用 rows[i]（T+1 开盘）
// 导出供 recommender 实时生成当日信号使用
export function generateSignal(
  strategy: StrategyType, params: BacktestParams, rows: KlineRow[], i: number
): 'buy' | 'sell' | 'hold' {
  const prev = rows[i - 1]; // T 日
  const prev2 = rows[i - 2];
  if (!prev) return 'hold';

  if (strategy === 'three_cycle') {
    // 大盘择时：bear 市不开新仓
    const regime = params.marketRegime;
    if (regime === 'bear') return 'hold';
    // 用截至 T 日的数据评分
    const result = scoreMultiCycle(rows.slice(0, i));
    const threshold = params.scoreThreshold ?? 55;
    const requireResonant = params.requireResonant === true;
    // range 市提高阈值 5 分
    const effectiveThreshold = regime === 'range' ? threshold + 5 : threshold;
    // 买入：得分达标（range 市提高阈值 5 分）
    if (result.score >= effectiveThreshold
        && (!requireResonant || result.resonant)) return 'buy';

    // 卖出信号已移除：数据证明信号卖出(2日破MA20)净亏，依赖系统化风控（ATR止损/移动止盈/止盈/时间止损）
    return 'hold';
  }

  // 基础过滤与量能确认
  const ma20 = safe(prev.ma20);
  const ma60 = safe(prev.ma60);
  const isBearish = ma20 !== null && ma60 !== null && ma20 < ma60;
  const isBelowMA60 = ma60 !== null && prev.close < ma60;
  
  // 核心风控：严禁在绝对空头排列或 MA60 下方买入
  // 除非是极左侧的超跌反弹（RSI）或者 MACD 底部反转
  if (strategy !== 'rsi_reversal' && strategy !== 'macd_cross' && (isBearish || isBelowMA60)) {
    return 'hold';
  }
  
  // 大盘风控：如果大盘处于熊市，彻底空仓右侧趋势策略，只做左侧
  const regime = params.marketRegime || 'range';
  if (regime === 'bear' && strategy !== 'rsi_reversal' && strategy !== 'macd_cross') {
    return 'hold';
  }
  
  // 计算 5日均量
  let volSum = 0;
  let volCount = 0;
  for (let k = 1; k <= 5; k++) {
    if (i - k < 0) break;
    volSum += rows[i - k].volume;
    volCount++;
  }
  const volMa5 = volCount > 0 ? volSum / volCount : prev.volume;
  // 放量确认：突破时量比前均量至少 1.2 倍以上（缓解无票可买的问题）
  const isVolumeExpanded = prev.volume >= volMa5 * 1.2;

  // 极高胜率全局过滤：移除之前过于死板的全盘 MA20 封锁，交由各策略自行判断
  const ma20Global = safe(prev.ma20);

  if (strategy === 'macd_cross') {
    const macd = safe(prev.macd) ?? 0;
    const sig = safe(prev.macdSignal) ?? 0;
    
    let recentCross = false;
    for (let k = 1; k <= 3; k++) {
      if (i - k - 1 < 0) break;
      const cMacd = safe(rows[i - k].macd) ?? 0;
      const cSig = safe(rows[i - k].macdSignal) ?? 0;
      const pMacd = safe(rows[i - k - 1].macd) ?? 0;
      const pSig = safe(rows[i - k - 1].macdSignal) ?? 0;
      if (pMacd <= pSig && cMacd > cSig) {
        recentCross = true;
        break;
      }
    }
    // MACD Cross with momentum and slight volume expansion
    const isVolumeBump = prev.volume > volMa5 * 1.1;
    if (recentCross && macd > sig && isVolumeBump) return 'buy';
    
    let recentDeathCross = false;
    for (let k = 1; k <= 3; k++) {
      if (i - k - 1 < 0) break;
      const cMacd = safe(rows[i - k].macd) ?? 0;
      const cSig = safe(rows[i - k].macdSignal) ?? 0;
      const pMacd = safe(rows[i - k - 1].macd) ?? 0;
      const pSig = safe(rows[i - k - 1].macdSignal) ?? 0;
      if (pMacd >= pSig && cMacd < cSig) {
        recentDeathCross = true;
        break;
      }
    }
    if (recentDeathCross && macd < sig) return 'sell';
    
    return 'hold';
  }

  if (strategy === 'rsi_reversal') {
    const buyT = params.rsiBuy ?? 30;
    const sellT = params.rsiSell ?? 70;
    const rsi = safe(prev.rsi14) ?? 50;
    const prevRsi = safe(rows[i-2]?.rsi14) ?? 50;
    
    const rsiTurningUp = rsi > prevRsi; 
    const volMa5_ = safe(prev.volMa5) ?? prev.volume;
    const panicStopping = prev.volume < volMa5_ * 2;
    
    if (rsi < buyT && rsiTurningUp && panicStopping) return 'buy';
    if (rsi > sellT) return 'sell';
    return 'hold';
  }

  if (strategy === 'ma520') {
    const ma5 = safe(prev.ma5);
    const ma20 = safe(prev.ma20);
    const prevMa20 = safe(rows[i-2]?.ma20);
    
    if (ma5 !== null && ma20 !== null && prevMa20 !== null) {
      let recentCross = false;
      let recentDeathCross = false;
      for (let k = 1; k <= 3; k++) {
        if (i - k - 1 < 0) break;
        const cMa5 = safe(rows[i - k].ma5);
        const cMa20 = safe(rows[i - k].ma20);
        const pMa5 = safe(rows[i - k - 1].ma5);
        const pMa20 = safe(rows[i - k - 1].ma20);
        if (cMa5 !== null && cMa20 !== null && pMa5 !== null && pMa20 !== null) {
          if (pMa5 <= pMa20 && cMa5 > cMa20) recentCross = true;
          if (pMa5 >= pMa20 && cMa5 < cMa20) recentDeathCross = true;
        }
      }
      
      const ma20Rising = ma20 >= prevMa20 * 0.995; 
      
      // Calculate a localized 5-day volume MA instead of global volMa5 if we can
      let volSum = 0;
      let volCount = 0;
      for (let k = 1; k <= 5; k++) {
        if (i - k < 0) break;
        volSum += rows[i - k].volume;
        volCount++;
      }
      const localVolMa5 = volCount > 0 ? volSum / volCount : prev.volume;
      const isVolumeBump = prev.volume >= localVolMa5 * 1.05;

      // 只要 520 金叉且 MA20 没有极速下跌，且略微放量
      if (recentCross && ma5 > ma20 && ma20Rising && isVolumeBump) return 'buy';
      if (recentDeathCross && ma5 < ma20) return 'sell';
      
      const isUptrend = ma5 > ma20 * 1.01;
      const nearSupport = Math.abs(prev.low - ma20) / ma20 < 0.015;
      const bounced = prev.close > prev.open && prev.close > ma20;
      if (isUptrend && nearSupport && bounced) return 'buy';
    }
    return 'hold';
  }

  return 'hold';
}

// 指标预热：须覆盖 MA250（年线，250 日）才能让「站上年线 +15」等长期趋势分稳定，
// 否则回测前 ~180 天 MA250/MA120 为 null，大周期层持续失真。
// 周线 MA60（年线级别）需约 60 周 ≈ 300 天，略晚于 WARMUP 激活——多头排列（周 MA5/10/20，≈100 天）已先行有效。
const WARMUP = 260;

/** 对单只股票运行回测（纯函数） */
export function runBacktest(
  rows: KlineRow[], config: BacktestConfig, benchmark?: KlineRow[]
): BacktestResult {
  const { strategy, params, fees, initialCapital } = config;
  const slippage = config.slippage ?? 0.001;
  const code = (rows[0] as any)?.marketCode ?? '';

  const empty: BacktestResult = {
    marketCode: code,
    metrics: {
      totalReturn: 0, annualizedReturn: 0, maxDrawdown: 0, winRate: 0,
      sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0, profitFactor: 0,
      avgWin: 0, avgLoss: 0, maxConsecutiveLosses: 0, avgHoldDays: 0,
      tradeCount: 0, finalCapital: initialCapital, alpha: null, benchmarkReturn: null, deflatedSharpe: null,
    },
    trades: [], equityCurve: [],
  };

  if (rows.length < WARMUP + 2) return empty;

  let cash = initialCapital;
  let position = 0;          // 持有股数
  let entryPrice = 0;
  let entryDate = '';
  let entryIdx = 0;
  let entryATR = 0;
  let highestSinceEntry = 0;
  let buyCost = 0;            // 当前持仓的买入总成本（含费），用于卖出时算盈亏
  let stagedFilled = false;   // 分批建仓：是否已完成金字塔加仓（每次开仓重置）

  const trades: Trade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const dailyReturns: number[] = [];
  let prevEquity = initialCapital;
  let maxEquity = initialCapital;
  let maxDrawdown = 0;

  const stopLossPct = params.stopLoss ?? 0.08;
  const takeProfitPct = params.takeProfit ?? 0.25;
  const trailingPct = params.trailingStop ?? 0.10;
  const atrMult = params.atrMultiple ?? 2;
  const maxHold = params.maxHoldDays ?? 30;
  const positionPct = params.positionPct ?? 0.30;

  for (let i = WARMUP; i < rows.length; i++) {
    const execDay = rows[i];       // T+1（成交日）
    const prevClose = rows[i - 1].close;

    // ── 持仓中：先检查离场（用 execDay 的 high/low/open）──
    if (position > 0) {
      // 分批/金字塔加仓（手册 4.3）：盈利后才加，亏损绝不补，仅加一次
      if (params.stagedEntry && !stagedFilled && cash > 0) {
        const trialFrac = params.trialFraction ?? 0.4;
        const profitEmerging = entryPrice > 0 && execDay.close >= entryPrice * 1.03;
        const withinWindow = (i - entryIdx) <= Math.floor(maxHold / 2);
        if (profitEmerging && withinWindow) {
          const addBudget = cash * positionPct * (1 - trialFrac);
          const addPrice = execDay.close * (1 + slippage);
          const addShares = Math.floor(addBudget / (addPrice * (1 + fees.buy)) / 100) * 100;
          if (addShares >= 100) {
            const addCost = addShares * addPrice * (1 + fees.buy);
            if (addCost <= cash) {
              cash -= addCost;
              const totalShares = position + addShares;
              entryPrice = (buyCost + addCost) / totalShares; // 加权成本基准
              buyCost += addCost;
              position = totalShares;
            }
          }
          stagedFilled = true; // 仅加一次，避免无限补仓
        }
      }
      highestSinceEntry = Math.max(highestSinceEntry, execDay.high);
      const holdDays = i - entryIdx;

      const atrStop = entryPrice - atrMult * entryATR;
      const fixedStop = entryPrice * (1 - stopLossPct);
      const initialStop = Math.max(atrStop, fixedStop);          // 初始止损（较保守者）
      // 渐进式移动止盈：盈利越大、追踪越紧，锁定利润
      // 盈利 <10%: 用初始止损（给趋势发展空间）
      // 盈利 10-20%: 追踪回撤 12%
      // 盈利 >20%: 追踪回撤 8%（利润奔跑后收紧）
      const gainPct = (highestSinceEntry - entryPrice) / entryPrice;
      const adaptiveTrail = gainPct > 0.20 ? 0.08 : gainPct > 0.10 ? 0.12 : trailingPct;
      const trailingPrice = highestSinceEntry * (1 - adaptiveTrail);
      const effectiveStop = Math.max(initialStop, trailingPrice); // 移动止盈线随最高价上移
      const takeProfitPrice = entryPrice * (1 + takeProfitPct);

      let exitPrice: number | null = null;
      let exitReason = '';

      // 一字跌停卖不出，跳过当日离场判定
      const lockedDown = isLockLimitDown(code, execDay, prevClose);
      const isLimitUp = (execDay.close / prevClose - 1) >= limitPctOf(code) - 0.005 && execDay.close === execDay.high;

      if (!lockedDown) {
        // A股特供：涨停板信仰 (Limit-Up Override)
        // 如果今日收盘牢牢封死涨停，且没有开板（close == high），则无视任何移动止盈信号，继续锁仓享受溢价
        if (isLimitUp) {
          // 不做任何卖出判定
        } else if (execDay.low <= effectiveStop) {
          // 触及止损/移动止盈：开盘跳空则按开盘价，否则按止损线
          exitPrice = execDay.open <= effectiveStop ? execDay.open : effectiveStop;
          exitReason = trailingPrice > initialStop ? '移动止盈' : '止损';
        } else if (execDay.high >= takeProfitPrice) {
          // 触及固定止盈
          exitPrice = execDay.open >= takeProfitPrice ? execDay.open : takeProfitPrice;
          exitReason = '止盈';
        } else if (holdDays >= maxHold) {
          // 时间止损
          exitPrice = execDay.close;
          exitReason = '时间止损';
        } else {
          // 信号止损：持仓超过 3 日后才启用，避免建仓初期被正常回调洗出
          if (holdDays > 3) {
            const sig = generateSignal(strategy, params, rows, i);
            if (sig === 'sell') { exitPrice = execDay.open; exitReason = '信号卖出'; }
          }
        }
      }

      if (exitPrice !== null) {
        const sellPrice = exitPrice * (1 - slippage);
        const revenue = position * sellPrice * (1 - fees.sell);
        const cost = buyCost;
        cash += revenue;
        const pnl = revenue - cost;
        const pnlPct = cost > 0 ? pnl / cost : 0;
        trades.push({
          entryDate, entryPrice, exitDate: execDay.date, exitPrice: sellPrice,
          shares: position, cost, revenue, pnl, pnlPct, holdDays, exitReason,
        });
        position = 0;
        entryPrice = 0;
        highestSinceEntry = 0;
      }
    }

    // ── 空仓：检查买入信号（T 日信号 → T+1 开盘成交）──
    if (position === 0) {
      const signal = generateSignal(strategy, params, rows, i);
      if (signal === 'buy') {
        const lockedUp = isOpenLimitUp(code, execDay.open, prevClose);
        
        // A股特供：T+1 防追高机制 (Gap-Up Skip)
        // 如果 T+1 日开盘直接高开超过 3%，且不是涨停板，此时追入往往是接盘被套，直接放弃本次交易信号
        const gapUpPct = (execDay.open - prevClose) / prevClose;
        const tooHigh = gapUpPct > 0.03;

        if (!lockedUp && !tooHigh) {
          const buyPrice = execDay.open * (1 + slippage);
          const frac = params.stagedEntry ? (params.trialFraction ?? 0.4) : 1; // 分批建仓：首仓试错
          const budget = cash * positionPct * frac;
          const maxAffordable = Math.floor(budget / (buyPrice * (1 + fees.buy)));
          if (maxAffordable >= 100) { // 至少 1 手
            const shares = Math.floor(maxAffordable / 100) * 100;
            const cost = shares * buyPrice * (1 + fees.buy);
            if (cost <= cash && shares > 0) {
              cash -= cost;
              position = shares;
              entryPrice = buyPrice;
              entryDate = execDay.date;
              entryIdx = i;
              entryATR = safe(execDay.atr14) ?? (buyPrice * 0.03); // ATR 兜底
              highestSinceEntry = execDay.high;
              buyCost = cost;
              stagedFilled = !params.stagedEntry; // 分批模式首仓后允许加仓；普通模式视为已满
            }
          }
        }
      }
    }

    // ── 记录每日净值 ──
    const equity = cash + position * execDay.close;
    equityCurve.push({ date: execDay.date, equity });
    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity > 0 ? (maxEquity - equity) / maxEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 收盘强平未结头寸
  if (position > 0) {
    const last = rows[rows.length - 1];
    const sellPrice = last.close * (1 - slippage);
    const revenue = position * sellPrice * (1 - fees.sell);
    const cost = buyCost;
    cash += revenue;
    trades.push({
      entryDate, entryPrice, exitDate: last.date, exitPrice: sellPrice,
      shares: position, cost, revenue, pnl: revenue - cost,
      pnlPct: cost > 0 ? (revenue - cost) / cost : 0,
      holdDays: rows.length - 1 - entryIdx, exitReason: '期末平仓',
    });
    position = 0;
    if (equityCurve.length > 0) equityCurve[equityCurve.length - 1].equity = cash;
  }

  return {
    marketCode: code,
    metrics: computeMetrics(trades, dailyReturns, equityCurve, cash, initialCapital, benchmark, config.trials),
    trades,
    equityCurve,
  };
}

// ── 指标计算 ──
function computeMetrics(
  trades: Trade[], dailyReturns: number[], equityCurve: { date: string; equity: number }[],
  finalCapital: number, initialCapital: number, benchmark?: KlineRow[], trials?: number
): BacktestMetrics {
  const totalReturn = (finalCapital - initialCapital) / initialCapital;
  const tradingDays = equityCurve.length;
  const years = tradingDays / 252;
  const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;

  // 最大回撤
  let maxEquity = initialCapital, maxDrawdown = 0;
  for (const p of equityCurve) {
    if (p.equity > maxEquity) maxEquity = p.equity;
    const dd = maxEquity > 0 ? (maxEquity - p.equity) / maxEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 交易统计
  const closedTrades = trades.filter(t => t.exitReason !== '期末平仓' || true);
  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);
  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgHoldDays = closedTrades.length > 0 ? closedTrades.reduce((s, t) => s + t.holdDays, 0) / closedTrades.length : 0;

  // 最大连续亏损
  let maxConsecLoss = 0, curConsec = 0;
  for (const t of closedTrades) {
    if (t.pnl <= 0) { curConsec++; maxConsecLoss = Math.max(maxConsecLoss, curConsec); }
    else curConsec = 0;
  }

  // 夏普 / Sortino
  const RISK_FREE = 0.02;
  let sharpe = 0, sortino = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
    const std = Math.sqrt(variance);
    const annVol = std * Math.sqrt(252);
    if (annVol > 0) sharpe = (annualizedReturn - RISK_FREE) / annVol;
    // Sortino：仅用下行波动
    const downside = dailyReturns.filter(r => r < 0);
    if (downside.length > 0) {
      const dVar = downside.reduce((s, r) => s + r * r, 0) / downside.length;
      const dStd = Math.sqrt(dVar) * Math.sqrt(252);
      if (dStd > 0) sortino = (annualizedReturn - RISK_FREE) / dStd;
    }
  }

  // Calmar
  const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  // 超额收益 alpha（相对基准）
  let alpha: number | null = null;
  let benchmarkReturn: number | null = null;
  if (benchmark && benchmark.length >= 2) {
    const b0 = benchmark[0].close;
    const b1 = benchmark[benchmark.length - 1].close;
    benchmarkReturn = b0 > 0 ? b1 / b0 - 1 : 0;
    alpha = totalReturn - benchmarkReturn;
  }

  return {
    totalReturn, annualizedReturn, maxDrawdown, winRate, sharpeRatio: sharpe,
    sortinoRatio: sortino, calmarRatio: calmar,
    profitFactor: profitFactor === Infinity ? 99 : profitFactor,
    avgWin, avgLoss, maxConsecutiveLosses: maxConsecLoss, avgHoldDays,
    tradeCount: closedTrades.length, finalCapital, alpha, benchmarkReturn,
    deflatedSharpe: deflatedSharpeRatio(sharpe, dailyReturns, trials ?? 0),
  };
}
