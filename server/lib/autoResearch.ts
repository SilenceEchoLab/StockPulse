// AutoResearch 引擎 —— Karpathy generate-test-learn 闭环
//
// 核心循环：
//   1. Generate: 从参数网格中采样候选参数组合
//   2. Test: 对每组参数执行 walk-forward 回测（Train 60% / Test 40%）
//   3. Evaluate: 用调和均值评分，惩罚 train/test 分歧（过拟合检测）
//   4. Learn: 选出最优参数，存入 strategy_optima 供推荐引擎使用
//
// 防过拟合核心：调和均值(Harmonic Mean)
//   若 train 表现极好但 test 极差，调和均值趋近较小值，自动拒绝过拟合方案

import { runBacktest, type StrategyType, type BacktestParams, type BacktestMetrics, type BacktestConfig } from './backtestEngine.js';
import type { KlineRow } from './signalEngine.js';

const WARMUP = 70;
// 测试段最低交易笔数：低于此数统计意义不足，评分打折；不达标的方案不进入全局稳健聚合
const MIN_TEST_TRADES = 5;

// ── 参数搜索网格 ──
// 每个策略定义一组离散参数候选值，覆盖合理范围
const PARAM_GRIDS: Record<StrategyType, Partial<Record<keyof BacktestParams, number[]>>> = {
  three_cycle: {
    stopLoss: [0.05, 0.08, 0.10],
    takeProfit: [0.05, 0.08, 0.10],
    trailingStop: [0.03, 0.05],
    maxHoldDays: [10, 15, 20],
    scoreThreshold: [60, 65, 70],
  },
  macd_cross: {
    stopLoss: [0.05, 0.08, 0.10],
    takeProfit: [0.05, 0.08, 0.10],
    trailingStop: [0.03, 0.05],
    maxHoldDays: [10, 15],
  },
  rsi_reversal: {
    stopLoss: [0.05, 0.08, 0.10],
    takeProfit: [0.05, 0.08, 0.10],
    trailingStop: [0.03, 0.05],
    maxHoldDays: [10, 15],
    rsiBuy: [30, 35],
    rsiSell: [65, 70],
  },
  ma520: {
    stopLoss: [0.05, 0.08, 0.10],
    takeProfit: [0.05, 0.08, 0.10],
    trailingStop: [0.03, 0.05],
    maxHoldDays: [10, 15],
  },
};

// 从网格生成参数组合的笛卡尔积
function generateCombos(grid: Partial<Record<string, number[]>>): Record<string, number>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];
  const combos: Record<string, number>[] = [];
  function recurse(idx: number, current: Record<string, number>) {
    if (idx === keys.length) { combos.push({ ...current }); return; }
    const key = keys[idx];
    for (const val of grid[key]!) { current[key] = val; recurse(idx + 1, current); }
  }
  recurse(0, {});
  return combos;
}

// 从全量组合中均匀采样（避免组合爆炸）
function sampleCombos(combos: Record<string, number>[], maxSamples: number): Record<string, number>[] {
  if (combos.length <= maxSamples) return combos;
  const step = combos.length / maxSamples;
  const result: Record<string, number>[] = [];
  for (let i = 0; i < maxSamples; i++) result.push(combos[Math.floor(i * step)]);
  return result;
}

export interface OptimumResult {
  params: BacktestParams;
  trainMetrics: BacktestMetrics;
  testMetrics: BacktestMetrics;
  compositeScore: number;
  overfitScore: number;
}

// 归一化指标到 0-1 区间
function normSharpe(m: BacktestMetrics): number {
  return Math.max(0, Math.min(1, (m.sharpeRatio + 0.5) / 2.5));
}
function normReturn(m: BacktestMetrics): number {
  return Math.max(0, Math.min(1, (m.totalReturn + 0.3) / 0.8));
}
function normWinRate(m: BacktestMetrics): number {
  return m.winRate;
}
function normDrawdown(m: BacktestMetrics): number {
  return Math.max(0, 1 - m.maxDrawdown);
}

// 综合评分：调和均值惩罚 train/test 分歧
function scoreOptimum(train: BacktestMetrics, test: BacktestMetrics): { composite: number; overfit: number } {
  const w = { sharpe: 0.35, return: 0.25, winRate: 0.20, drawdown: 0.10, profit: 0.10 };
  const score = (m: BacktestMetrics) =>
    w.sharpe * normSharpe(m) + w.return * normReturn(m) + w.winRate * normWinRate(m) + w.drawdown * normDrawdown(m) + w.profit * (m.totalReturn > 0 ? 1 : 0);

  const trainScore = score(train);
  const testScore = score(test);

  // 交易笔数置信度：test 段交易太少 → 统计不可信，调和均值打折（最低 0.4）
  const tradeConf = test.tradeCount >= MIN_TEST_TRADES
    ? 1
    : Math.max(0.4, (test.tradeCount || 0) / MIN_TEST_TRADES);

  // 调和均值：train=0.9 / test=0.1 → 0.18（远低于算术均值0.5），自动拒绝过拟合
  const composite = trainScore > 0 && testScore > 0
    ? (2 * trainScore * testScore) / (trainScore + testScore) * tradeConf
    : Math.min(trainScore, testScore) * 0.3;

  // 过拟合度：train/test 得分差异比例
  const overfit = Math.max(trainScore, testScore) > 0
    ? Math.abs(trainScore - testScore) / Math.max(trainScore, testScore)
    : 1;

  return { composite, overfit };
}

export interface OptimizeOptions {
  maxSamples?: number; // 每只股票最多测试的参数组合数（默认 25）
  positionPct?: number;
  marketRegime?: 'bull' | 'range' | 'bear';
}

/**
 * 对单只股票执行 walk-forward 参数优化
 * @param rows 日K数据（升序，至少 72 行）
 * @param strategy 策略类型
 * @param benchmark 基准指数K线
 * @param options 搜索选项
 * @returns 最优参数结果，或 null（无盈利方案）
 */
export function optimizeStock(
  rows: KlineRow[],
  strategy: StrategyType,
  benchmark: KlineRow[],
  options: OptimizeOptions = {}
): OptimumResult | null {
  if (rows.length < WARMUP * 2 + 10) return null; // 数据不足以做 walk-forward

  const grid = PARAM_GRIDS[strategy];
  const allCombos = generateCombos(grid);
  const combos = sampleCombos(allCombos, options.maxSamples ?? 25);

  // walk-forward 分割点：前 60% 训练，后 40% 测试（测试段回退 WARMUP 行以覆盖指标预热）
  const splitIdx = Math.floor(rows.length * 0.6);
  const trainRows = rows.slice(0, splitIdx);
  const testRows = rows.slice(splitIdx - WARMUP);

  const trainBench = benchmark.slice(0, splitIdx);
  const testBench = benchmark.slice(splitIdx - WARMUP);

  const baseConfig = {
    strategy,
    fees: { buy: 0.0003, sell: 0.0013 },
    slippage: 0.001,
    initialCapital: 1000000,
  };

  let best: OptimumResult | null = null;

  for (const combo of combos) {
    const params: BacktestParams = {
      ...combo,
      positionPct: options.positionPct ?? 1.0,
      marketRegime: options.marketRegime,
    };

    const trainResult = runBacktest(trainRows, { ...baseConfig, params }, trainBench);
    const testResult = runBacktest(testRows, { ...baseConfig, params }, testBench);

    const { composite, overfit } = scoreOptimum(trainResult.metrics, testResult.metrics);

    // 拒绝过拟合严重（overfit > 0.6）或 train/test 均亏损的方案
    if (overfit > 0.6) continue;
    if (trainResult.metrics.totalReturn < 0 && testResult.metrics.totalReturn < 0) continue;

    const candidate: OptimumResult = {
      params,
      trainMetrics: trainResult.metrics,
      testMetrics: testResult.metrics,
      compositeScore: composite,
      overfitScore: overfit,
    };

    if (!best || candidate.compositeScore > best.compositeScore) {
      best = candidate;
    }
  }

  // 最终过滤：最优方案必须在测试期（样本外）盈利才算通过
  if (best && best.testMetrics.totalReturn <= 0) return null;

  return best;
}

// ── 批量优化进度追踪（内存态，供 API 轮询）──
export interface ResearchProgress {
  status: 'idle' | 'running' | 'completed' | 'error';
  strategy: string;
  total: number;
  current: number;
  profitable: number;
  logs: { time: string; msg: string }[];
  startedAt: Date | null;
}

export const researchState: ResearchProgress = {
  status: 'idle',
  strategy: '',
  total: 0,
  current: 0,
  profitable: 0,
  logs: [],
  startedAt: null,
};

export function resetResearchState() {
  researchState.status = 'idle';
  researchState.strategy = '';
  researchState.total = 0;
  researchState.current = 0;
  researchState.profitable = 0;
  researchState.logs = [];
  researchState.startedAt = null;
}

export function addResearchLog(msg: string) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  researchState.logs.unshift({ time, msg });
  if (researchState.logs.length > 50) researchState.logs.pop();
}

// ── 全局稳健策略聚合（Karpathy learn：从大量 per-stock 结果提炼通用规律）──
//
// 思路：单只股票的最优参数含运气成分；当某组参数在「多数股票」上都通过
// walk-forward 验证时，它才具备跨股票泛化能力 —— 这才是「最稳定的策略」。
// 方法：取稳健子集（盈利+低过拟合+交易充分），对每个参数取中位数。

export interface OptimaRow {
  paramsJson: string;
  testReturn: number | null;
  testSharpe: number | null;
  overfitScore: number | null;
  tradeCount: number | null;
  maxDrawdown: number | null;
  compositeScore: number | null;
}

export interface GlobalOptimum {
  params: Record<string, number>;
  avgTestReturn: number;
  avgTestSharpe: number;
  avgMaxDrawdown: number;
  stabilityScore: number;   // 稳定率 = 稳健子集 / 参与股票，越高策略越普适
  coverageStocks: number;
  sampleStocks: number;
}

const median = (vals: number[]): number => {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 从一批 per-stock optima 聚合出全局稳健策略（纯函数）
 * @param rows 同一策略在多只股票上的 walk-forward 最优结果
 * @returns 全局参数与稳健性统计，或 null（无任何稳健样本）
 */
export function aggregateGlobalOptima(rows: OptimaRow[]): GlobalOptimum | null {
  const sampleStocks = rows.length;
  if (sampleStocks === 0) return null;

  // 稳健子集：测试段真实盈利 + 过拟合可控 + 交易笔数充分
  const robust = rows.filter(r =>
    (r.testReturn ?? -1) > 0 &&
    (r.overfitScore ?? 1) < 0.4 &&
    (r.tradeCount ?? 0) >= MIN_TEST_TRADES
  );
  if (robust.length === 0) return null;

  // 忽略非策略参数（positionPct/marketRegime 由组合层控制）
  const SKIP_KEYS = new Set(['positionPct', 'marketRegime']);
  const paramSets = robust.map(r => JSON.parse(r.paramsJson) as Record<string, number>);
  const numericKeys = new Set<string>();
  for (const p of paramSets) {
    for (const k of Object.keys(p)) {
      if (!SKIP_KEYS.has(k) && typeof p[k] === 'number') numericKeys.add(k);
    }
  }
  // 每个参数取中位数 —— 代表「大多数股票都适配」的值，抗极值
  const params: Record<string, number> = {};
  for (const k of numericKeys) {
    params[k] = median(paramSets.map(p => p[k]).filter(v => typeof v === 'number'));
  }

  const avg = (f: (r: OptimaRow) => number | null) => {
    const vs = robust.map(f).filter((v): v is number => v !== null && isFinite(v));
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
  };

  return {
    params,
    avgTestReturn: avg(r => r.testReturn),
    avgTestSharpe: avg(r => r.testSharpe),
    avgMaxDrawdown: avg(r => r.maxDrawdown),
    stabilityScore: robust.length / sampleStocks,
    coverageStocks: robust.length,
    sampleStocks,
  };
}

/**
 * 计算策略的回测先验可信度（来自 strategy_optima 聚合，0-1）
 * 与 performanceTracker 的真实后验融合，形成最终 blendedCredibility
 */
export function computeBacktestPrior(rows: OptimaRow[]): {
  score: number; avgReturn: number; avgSharpe: number; stockCount: number;
} {
  const stockCount = rows.length;
  if (stockCount === 0) return { score: 0, avgReturn: 0, avgSharpe: 0, stockCount: 0 };
  const profitable = rows.filter(r => (r.testReturn ?? -1) > 0).length;
  const valid = rows.filter(r => r.testReturn !== null);
  const avgReturn = valid.length
    ? valid.reduce((s, r) => s + (r.testReturn as number), 0) / valid.length : 0;
  const sharped = rows.filter(r => r.testSharpe !== null);
  const avgSharpe = sharped.length
    ? sharped.reduce((s, r) => s + (r.testSharpe as number), 0) / sharped.length : 0;
  // 先验得分 = 盈利股票占比（普适性） × 收益因子，归一化到 0-1
  const profitRatio = profitable / stockCount;
  const returnFactor = Math.max(0, Math.min(1, (avgReturn + 0.1) / 0.5));
  return {
    score: Math.round(profitRatio * returnFactor * 100) / 100,
    avgReturn, avgSharpe, stockCount,
  };
}
