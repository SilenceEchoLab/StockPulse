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
  reason: 'tp' | 'sl' | 'expire';
  holdDays: number;
  buyVotes: string[];
  regime: string;
}

export interface EngineBacktestResult {
  totalTrades: number;
  winRate: number;
  avgReturn: number;
  totalReturn: number;     // 等权月度组合复利收益
  sharpe: number;          // 月度年化夏普
  maxDrawdown: number;     // 月度最大回撤
  avgHoldDays: number;
  byStrategy: Record<string, { trades: number; winRate: number; avgReturn: number }>;
  byRegime: Record<string, { trades: number; winRate: number; avgReturn: number }>;
  byMonth: { month: string; trades: number; avgReturn: number }[];
  range: { start: string; end: string };
  durationMs: number;
}

interface Options {
  days?: number;          // 回放交易日数（从最新往前），默认 120
  maxHoldDays?: number;   // 每笔最大持有天数，默认 30
  minBuyCount?: number;   // 最低看多策略数，默认 1（与实时单策略降级一致）
  fees?: { buy: number; sell: number };
}

const safe = (v: any): number => (typeof v === 'number' && isFinite(v)) ? v : 0;
const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

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

  for (let d = startIdx; d < allDates.length; d++) {
    const D = allDates[d];
    // 大盘环境（截至 D，严格防未来函数）
    const regime = assessMarketTiming(benchmark.slice(0, d + 1), 'sh000300').regime;
    const Dts = new Date(D).getTime();

    for (const [code, rows] of klineMap) {
      if (code.startsWith('sh00') || code.startsWith('sz39')) continue; // 跳过指数
      const idx = codeDateIdx.get(code)!.get(D);
      if (idx === undefined || idx < 72) continue;

      // 持仓期未结束则跳过（避免同一只票重复进场）
      const lastExit = lastExitTs.get(code);
      if (lastExit !== undefined && Dts <= lastExit) continue;

      // 全局验证策略 generateSignal（截至 D 的数据，i = idx+1 表示 D 当日信号位）
      let buyCount = 0, sellCount = 0;
      const buyVotes: string[] = [];
      for (const gs of strategies) {
        const sig = generateSignal(gs.strategy, { ...gs.params, marketRegime: regime } as BacktestParams, rows, idx + 1);
        if (sig === 'buy') { buyCount++; buyVotes.push(gs.strategy); }
        else if (sig === 'sell') sellCount++;
      }
      if (buyCount < minBuy || sellCount > 0) continue;

      // 入场 + 风控位（用看多策略的全局参数均值）
      const entryRow = rows[idx];
      const entry = safe(entryRow.close);
      if (entry <= 0) continue;
      const voteStrategies = strategies.filter(s => buyVotes.includes(s.strategy));
      const stopPct = voteStrategies.length ? avg(voteStrategies.map(s => safe(s.params.stopLoss) || 0.08)) : 0.08;
      const tpPct = voteStrategies.length ? avg(voteStrategies.map(s => safe(s.params.takeProfit) || 0.25)) : 0.25;
      const atr = safe((entryRow as any).atr14) || entry * 0.03;
      const stop = Math.max(entry - 2 * atr, entry * (1 - stopPct));
      const take = entry * (1 + tpPct);

      // 结算：D+1 起的真实 K 线，判定止盈/止损/过期
      const future = rows.slice(idx + 1, idx + 1 + maxHold);
      let exitPrice = entry, reason: 'tp' | 'sl' | 'expire' = 'expire', exitDate = D, holdDays = 0;
      let settled = false;
      for (let j = 0; j < future.length; j++) {
        const day = future[j];
        if (safe(day.high) >= take) { exitPrice = take; reason = 'tp'; exitDate = day.date; holdDays = j + 1; settled = true; break; }
        if (safe(day.low) <= stop) { exitPrice = stop; reason = 'sl'; exitDate = day.date; holdDays = j + 1; settled = true; break; }
      }
      if (!settled) {
        if (future.length > 0) {
          exitPrice = safe(future[future.length - 1].close);
          exitDate = future[future.length - 1].date;
          holdDays = future.length;
        }
      }

      // 扣除双边费率
      const buyCost = entry * (1 + fees.buy);
      const sellRev = exitPrice * (1 - fees.sell);
      const returnPct = buyCost > 0 ? (sellRev - buyCost) / buyCost : 0;

      trades.push({ code, entryDate: D, exitDate, entry, exit: exitPrice, returnPct, reason, holdDays, buyVotes, regime });
      lastExitTs.set(code, new Date(exitDate).getTime());
    }
  }

  return computeEngineStats(trades, range, Date.now() - t0);
}

function computeEngineStats(
  trades: EngineTrade[], range: { start: string; end: string }, durationMs: number
): EngineBacktestResult {
  const total = trades.length;
  const wins = trades.filter(t => t.returnPct > 0);
  const winRate = total ? wins.length / total : 0;
  const avgReturn = total ? trades.reduce((s, t) => s + t.returnPct, 0) / total : 0;
  const avgHoldDays = total ? trades.reduce((s, t) => s + t.holdDays, 0) / total : 0;

  // 按入场月份聚合（等权月度组合）
  const byMonthMap = new Map<string, number[]>();
  for (const t of trades) {
    const m = t.entryDate.slice(0, 7);
    if (!byMonthMap.has(m)) byMonthMap.set(m, []);
    byMonthMap.get(m)!.push(t.returnPct);
  }
  const byMonth = [...byMonthMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, rets]) => ({
    month, trades: rets.length, avgReturn: avg(rets),
  }));

  // 月度组合收益序列 → 复利累计、年化夏普、最大回撤
  const monthlyReturns = byMonth.map(b => b.avgReturn);
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

  // 按策略归因（每笔收益归因到所有看多该笔的策略）
  const stratStats: Record<string, { trades: number; wins: number; sum: number }> = {};
  for (const t of trades) {
    for (const v of t.buyVotes) {
      if (!stratStats[v]) stratStats[v] = { trades: 0, wins: 0, sum: 0 };
      stratStats[v].trades++;
      stratStats[v].sum += t.returnPct;
      if (t.returnPct > 0) stratStats[v].wins++;
    }
  }
  const byStrategy: Record<string, { trades: number; winRate: number; avgReturn: number }> = {};
  for (const [v, s] of Object.entries(stratStats)) {
    byStrategy[v] = { trades: s.trades, winRate: s.trades ? s.wins / s.trades : 0, avgReturn: s.trades ? s.sum / s.trades : 0 };
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

  return { totalTrades: total, winRate, avgReturn, totalReturn, sharpe, maxDrawdown: maxDd, avgHoldDays, byStrategy, byRegime, byMonth, range, durationMs };
}
