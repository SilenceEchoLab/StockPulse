// 推荐引擎历史回放 —— 用历史数据验证「全局策略推荐引擎」的实战盈利能力
//
// 与 backtestEngine（单股参数回测）不同，这是「推荐引擎级」回放：
// 在历史区间每个交易日，用截至该日的数据 + 全局验证策略跑 generateSignal 选股，
// 用后续真实 K 线结算止盈止损，统计整个推荐引擎的胜率/收益/夏普/回撤。
//
// 这是 Karpathy 闭环的终极验证：证明调出的「最稳定策略」组合起来在历史上真的赚钱。

import { generateSignal } from './backtestEngine.js';
import type { BacktestParams, StrategyType } from './backtestEngine.js';
import type { KlineRow } from './signalEngine.js';
import { assessMarketTiming } from './marketTiming.js';

export interface BacktestStrategy {
  strategy: StrategyType;
  params: BacktestParams;
}

export interface EngineTrade {
  code: string;
  entryDate: string;
  exitDate: string;
  entry: number;
  exit: number;
  returnPct: number;
  reason: 'tp' | 'sl' | 'expire' | 'signal';
  holdDays: number;
  buyVotes: string[];
  regime: string;
  weight: number;         // 组合权重（受单股≤maxStockWeight 与总仓位≤maxPosition 约束）
}

export interface EngineBacktestResult {
  totalTrades: number;
  winRate: number;
  avgReturn: number;
  totalReturn: number;     // 加权月度组合复利收益
  sharpe: number;          // 月度年化夏普
  maxDrawdown: number;     // 月度最大回撤
  avgHoldDays: number;
  avgPositionUsed: number; // 平均实际占用仓位（权重和的均值）
  accountHalted: boolean;  // 是否曾触发账户级回撤熔断
  haltDays: number;        // 熔断冷却占用交易日数（停手复盘期）
  byStrategy: Record<string, { trades: number; winRate: number; avgReturn: number }>;
  byRegime: Record<string, { trades: number; winRate: number; avgReturn: number }>;
  byStrategyRegime: Record<string, { trades: number; winRate: number; avgReturn: number }>;
  byMonth: { month: string; trades: number; avgReturn: number }[];
  range: { start: string; end: string };
  durationMs: number;
}

interface Options {
  days?: number;          // 回放交易日数（从最新往前），默认 120
  maxHoldDays?: number;   // 每笔最大持有天数，默认 30
  minBuyCount?: number;   // 最低看多策略数，默认 1（与实时单策略降级一致）
  fees?: { buy: number; sell: number };
  maxStockWeight?: number;     // 单股最大权重，默认 0.20（手册：单股≤20%）
  accountDrawdownHalt?: number; // 账户级回撤熔断阈值，默认 0.15（手册 5.3：10-15%）
  haltCooldownDays?: number;   // 熔断后冷却交易日数（停手复盘期），默认 20；0=永久停手
  portfolioRisk?: boolean;     // 是否启用组合级风控（仓位上限/集中度/回撤熔断），默认 true
  positionMap?: { bull: number; range: number; bear: number }; // policy：regime→仓位上限
}

const safe = (v: any): number => (typeof v === 'number' && isFinite(v)) ? v : 0;
const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// 单笔结算：D+1 起的真实 K 线，判定止盈/止损/过期/信号卖出（含手册「强势板块见顶」「MA20 防守」纪律）
function settleTrade(
  rows: KlineRow[], idx: number, entry: number, stop: number, take: number,
  maxHold: number, regime: string, strategies: BacktestStrategy[], voteStrategies: BacktestStrategy[],
): { exitPrice: number; reason: 'tp' | 'sl' | 'expire' | 'signal'; exitDate: string; holdDays: number } {
  const future = rows.slice(idx + 1, idx + 1 + maxHold);
  let exitPrice = entry, reason: 'tp' | 'sl' | 'expire' | 'signal' = 'expire';
  let exitDate = rows[idx]?.date ?? '', holdDays = 0;
  let settled = false;

  for (let j = 0; j < future.length; j++) {
    const day = future[j];
    if (safe(day.high) >= take) { exitPrice = take; reason = 'tp'; exitDate = day.date; holdDays = j + 1; settled = true; break; }
    if (safe(day.low) <= stop) { exitPrice = stop; reason = 'sl'; exitDate = day.date; holdDays = j + 1; settled = true; break; }

    // 强势板块见顶法则：大阴线放量跌破5日线，坚决离场
    const ma5 = safe(day.ma5);
    if (ma5 !== null && j > 1) {
      let volSum = 0, volCount = 0;
      for (let k = 1; k <= 5; k++) { if (idx + 1 + j - k >= 0) { volSum += rows[idx + 1 + j - k].volume; volCount++; } }
      const volMa5 = volCount > 0 ? volSum / volCount : day.volume;
      const isBigYin = day.close < day.open && (day.open - day.close) / day.open > 0.02;
      if (isBigYin && day.close < ma5 && day.volume > volMa5 * 1.5) {
        exitPrice = safe(day.close); reason = 'signal'; exitDate = day.date; holdDays = j + 1; settled = true; break;
      }
    }

    // 手册核心纪律：MA20 防守线 + 动态信号止损（持仓 3 天后启用）
    if (j > 2) {
      const ma20 = safe(day.ma20);
      if (ma20 !== null && safe(day.close) < ma20) {
        exitPrice = safe(day.close); reason = 'signal'; exitDate = day.date; holdDays = j + 1; settled = true; break;
      }
      let sellVotes = 0;
      for (const gs of voteStrategies) {
        if (generateSignal(gs.strategy, { ...gs.params, marketRegime: regime } as BacktestParams, rows, idx + 1 + j) === 'sell') sellVotes++;
      }
      if (sellVotes > 0) {
        exitPrice = safe(day.close); reason = 'signal'; exitDate = day.date; holdDays = j + 1; settled = true; break;
      }
    }
  }
  if (!settled && future.length > 0) {
    exitPrice = safe(future[future.length - 1].close);
    exitDate = future[future.length - 1].date;
    holdDays = future.length;
  }
  return { exitPrice, reason, exitDate, holdDays };
}

/**
 * 推荐引擎历史回放（纯函数）
 * @param klineMap  按股票分组的全量日K（升序，含指标）
 * @param benchmark 基准指数日K（升序），用于大盘择时
 * @param strategies 经回测验证的全局策略（来自 global_strategy_optima）
 * @param options 回放参数
 */
export function backtestRecommendationEngine(
  klineMap: Map<string, KlineRow[]>,
  benchmark: KlineRow[],
  strategies: BacktestStrategy[],
  options: Options = {}
): EngineBacktestResult {
  const t0 = Date.now();
  const maxHold = options.maxHoldDays ?? 30;
  const minBuy = options.minBuyCount ?? 1;
  const fees = options.fees ?? { buy: 0.0003, sell: 0.0013 };

  // 回测日期：取 benchmark 交易日，最近 N 个（保留前 60 个用于择时预热）
  const allDates = benchmark.map(r => r.date);
  const days = Math.min(options.days ?? 120, Math.max(0, allDates.length - 60));
  const startIdx = Math.max(60, allDates.length - days);
  const range = { start: allDates[startIdx] ?? '', end: allDates[allDates.length - 1] ?? '' };

  // 预建每只股票的 date -> index，加速「截至 D」定位
  const codeDateIdx = new Map<string, Map<string, number>>();
  for (const [code, rows] of klineMap) {
    const m = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) m.set(rows[i].date, i);
    codeDateIdx.set(code, m);
  }

  const trades: EngineTrade[] = [];
  const lastExitTs = new Map<string, number>(); // code -> 上笔结算时间戳，持仓期内不重复买入
  const usePortfolioRisk = options.portfolioRisk !== false;
  const maxStockWeight = options.maxStockWeight ?? 0.20;
  const ddHalt = options.accountDrawdownHalt ?? 0.15;
  const cooldownDays = options.haltCooldownDays ?? 20;

  // 账户级回撤熔断（手册 5.3：触及红线全面降仓/停手复盘）——滚动冷却，冷却期内不开新仓
  let haltCooldown = 0;
  let everHalted = false;
  let haltDays = 0;
  let cumPnl = 0;       // 累计加权盈亏（近似账户净值偏离基准）
  let peakPnl = 0;
  let posUsedSum = 0, posUsedCount = 0;

  for (let d = startIdx; d < allDates.length; d++) {
    const D = allDates[d];
    // 冷却期倒计时（停手复盘），冷却结束自动恢复开仓
    if (haltCooldown > 0) { haltCooldown--; haltDays++; }
    // 大盘环境（截至 D，严格防未来函数）—— regime→仓位上限来自 policy（若提供）
    const timing = assessMarketTiming(benchmark.slice(0, d + 1), 'sh000300', options.positionMap);
    const regime = timing.regime;
    const dayMaxPos = usePortfolioRisk ? timing.maxPosition : 1.0;
    const Dts = new Date(D).getTime();

    // Phase 1：收集当日候选买入
    const candidates: { code: string; rows: KlineRow[]; idx: number; entry: number; stop: number; take: number; buyVotes: string[]; voteStrategies: BacktestStrategy[]; confidence: number }[] = [];
    for (const [code, rows] of klineMap) {
      if (code.startsWith('sh00') || code.startsWith('sz39')) continue; // 跳过指数
      const idx = codeDateIdx.get(code)!.get(D);
      if (idx === undefined || idx < 72) continue;
      const lastExit = lastExitTs.get(code);
      if (lastExit !== undefined && Dts <= lastExit) continue;

      let buyCount = 0, sellCount = 0;
      const buyVotes: string[] = [];
      for (const gs of strategies) {
        const sig = generateSignal(gs.strategy, { ...gs.params, marketRegime: regime } as BacktestParams, rows, idx + 1);
        if (sig === 'buy') { buyCount++; buyVotes.push(gs.strategy); }
        else if (sig === 'sell') sellCount++;
      }
      if (buyCount < minBuy || sellCount > 0) continue;

      const entryRow = rows[idx];
      const entry = safe(entryRow.close);
      if (entry <= 0) continue;
      const voteStrategies = strategies.filter(s => buyVotes.includes(s.strategy));
      const stopPct = voteStrategies.length ? avg(voteStrategies.map(s => safe(s.params.stopLoss) || 0.08)) : 0.08;
      const tpPct = voteStrategies.length ? avg(voteStrategies.map(s => safe(s.params.takeProfit) || 0.25)) : 0.25;
      const atr = safe((entryRow as any).atr14) || entry * 0.03;
      const stop = Math.max(entry - 2 * atr, entry * (1 - stopPct));
      const take = entry * (1 + tpPct);

      candidates.push({ code, rows, idx, entry, stop, take, buyVotes, voteStrategies, confidence: buyVotes.length });
    }

    // Phase 2：组合级风控——按置信度分配权重（单股≤maxStockWeight，当日总仓位≤dayMaxPos）
    candidates.sort((a, b) => b.confidence - a.confidence);
    let remaining = haltCooldown > 0 ? 0 : dayMaxPos;  // 冷却期内不开新仓
    let dayWeightSum = 0;
    for (const cand of candidates) {
      const weight = usePortfolioRisk ? Math.min(maxStockWeight, remaining) : Math.min(maxStockWeight, 1);
      if (weight <= 0.001) break;
      if (usePortfolioRisk) remaining -= weight;

      const st = settleTrade(cand.rows, cand.idx, cand.entry, cand.stop, cand.take, maxHold, regime, strategies, cand.voteStrategies);
      const buyCost = cand.entry * (1 + fees.buy);
      const sellRev = st.exitPrice * (1 - fees.sell);
      const returnPct = buyCost > 0 ? (sellRev - buyCost) / buyCost : 0;

      trades.push({ code: cand.code, entryDate: D, exitDate: st.exitDate, entry: cand.entry, exit: st.exitPrice, returnPct, reason: st.reason, holdDays: st.holdDays, buyVotes: cand.buyVotes, regime, weight });
      lastExitTs.set(cand.code, new Date(st.exitDate).getTime());

      // 账户净值近似：累计加权盈亏；触及回撤红线则进入冷却（停手复盘）
      cumPnl += weight * returnPct;
      if (cumPnl > peakPnl) peakPnl = cumPnl;
      dayWeightSum += weight;
      if ((peakPnl - cumPnl) >= ddHalt) { haltCooldown = cooldownDays; everHalted = true; }
    }
    if (candidates.length > 0) { posUsedSum += dayWeightSum; posUsedCount++; }
  }

  return computeEngineStats(trades, range, Date.now() - t0, {
    avgPositionUsed: posUsedCount ? posUsedSum / posUsedCount : 0,
    accountHalted: everHalted,
    haltDays,
  });
}

function computeEngineStats(
  trades: EngineTrade[], range: { start: string; end: string }, durationMs: number,
  extra?: { avgPositionUsed?: number; accountHalted?: boolean; haltDays?: number },
): EngineBacktestResult {
  const total = trades.length;
  const wins = trades.filter(t => t.returnPct > 0);
  const winRate = total ? wins.length / total : 0;
  const avgReturn = total ? trades.reduce((s, t) => s + t.returnPct, 0) / total : 0;
  const avgHoldDays = total ? trades.reduce((s, t) => s + t.holdDays, 0) / total : 0;

  // 按入场月份聚合（加权组合：当月组合收益 = Σ weight×return）
  const byMonthMap = new Map<string, { wr: number; w: number; n: number }>();
  for (const t of trades) {
    const m = t.entryDate.slice(0, 7);
    const e = byMonthMap.get(m) ?? { wr: 0, w: 0, n: 0 };
    e.wr += t.weight * t.returnPct;
    e.w += t.weight;
    e.n += 1;
    byMonthMap.set(m, e);
  }
  const sortedMonths = [...byMonthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const byMonth = sortedMonths.map(([month, e]) => ({
    month, trades: e.n, avgReturn: e.w > 0 ? e.wr / e.w : 0, // 权重加权平均收益率（展示用）
  }));

  // 月度组合收益序列（组合实际月收益）→ 复利累计、年化夏普、最大回撤
  const monthlyReturns = sortedMonths.map(([, e]) => e.wr);
  let equity = 1;
  for (const r of monthlyReturns) equity *= (1 + r);
  const totalReturn = equity - 1;

  const mAvg = avg(monthlyReturns);
  const mStd = monthlyReturns.length > 1
    ? Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - mAvg) ** 2, 0) / (monthlyReturns.length - 1)) : 0;
  const sharpe = mStd > 0 ? (mAvg / mStd) * Math.sqrt(12) : 0;

  let cum = 0, peak = 0, maxDd = 0;
  for (const r of monthlyReturns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  // 按策略归因（每笔收益归因到所有看多该笔的策略）+ 按策略×regime 归因（反脆弱：同策略在不同 regime 表现不同）
  const stratStats: Record<string, { trades: number; wins: number; sum: number }> = {};
  const stratRegimeStats: Record<string, { trades: number; wins: number; sum: number }> = {};
  for (const t of trades) {
    for (const v of t.buyVotes) {
      if (!stratStats[v]) stratStats[v] = { trades: 0, wins: 0, sum: 0 };
      stratStats[v].trades++;
      stratStats[v].sum += t.returnPct;
      if (t.returnPct > 0) stratStats[v].wins++;
      const srKey = `${v}|${t.regime || 'range'}`;
      if (!stratRegimeStats[srKey]) stratRegimeStats[srKey] = { trades: 0, wins: 0, sum: 0 };
      stratRegimeStats[srKey].trades++;
      stratRegimeStats[srKey].sum += t.returnPct;
      if (t.returnPct > 0) stratRegimeStats[srKey].wins++;
    }
  }
  const byStrategy: Record<string, { trades: number; winRate: number; avgReturn: number }> = {};
  for (const [v, s] of Object.entries(stratStats)) {
    byStrategy[v] = { trades: s.trades, winRate: s.trades ? s.wins / s.trades : 0, avgReturn: s.trades ? s.sum / s.trades : 0 };
  }
  const byStrategyRegime: Record<string, { trades: number; winRate: number; avgReturn: number }> = {};
  for (const [k, s] of Object.entries(stratRegimeStats)) {
    byStrategyRegime[k] = { trades: s.trades, winRate: s.trades ? s.wins / s.trades : 0, avgReturn: s.trades ? s.sum / s.trades : 0 };
  }

  // 按大盘环境
  const byRegimeMap = new Map<string, number[]>();
  for (const t of trades) {
    if (!byRegimeMap.has(t.regime)) byRegimeMap.set(t.regime, []);
    byRegimeMap.get(t.regime)!.push(t.returnPct);
  }
  const byRegime: Record<string, { trades: number; winRate: number; avgReturn: number }> = {};
  for (const [reg, rets] of byRegimeMap) {
    byRegime[reg] = { trades: rets.length, winRate: rets.filter(r => r > 0).length / rets.length, avgReturn: avg(rets) };
  }

  return {
    totalTrades: total, winRate, avgReturn, totalReturn, sharpe, maxDrawdown: maxDd, avgHoldDays,
    avgPositionUsed: extra?.avgPositionUsed ?? 0, accountHalted: extra?.accountHalted ?? false,
    haltDays: extra?.haltDays ?? 0,
    byStrategy, byRegime, byStrategyRegime, byMonth, range, durationMs,
  };
}
