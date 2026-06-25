// 推荐引擎 —— 将优化后的策略参数应用于实时数据，生成可执行的买卖推荐
//
// 核心流程：
//   1. 读取每只股票每个策略的最优参数（strategy_optima）
//   2. 用最新 K 线 + generateSignal 产生 BUY/SELL/HOLD 信号
//   3. 多策略投票共识（≥2 策略 BUY → 强推）
//   4. 结合三周期共振打分、技术信号，计算综合置信度
//   5. 计算止损/止盈位，写入 recommendations 表
//
// 绩效追踪闭环：
//   每日扫描 active 推荐的标的，检查是否触及止盈/止损/过期，
//   记录实际收益，回写 returnPct，形成 AutoResearch 反馈数据

import type { KlineRow } from './signalEngine.js';
import type { BacktestParams, StrategyType } from './backtestEngine.js';
import { generateSignal } from './backtestEngine.js';
import { scoreMultiCycle, type MinBar } from './cycles.js';
import { scoreStock, detectSignals } from './signalEngine.js';

const safe = (v: number | null | undefined): number | null =>
  (typeof v === 'number' && isFinite(v)) ? v : null;

export interface StockRecommendation {
  marketCode: string;
  action: 'buy' | 'sell' | 'hold';
  consensusStrength: number;   // 投票策略数 / 总策略数
  voteDetail: { strategy: StrategyType; signal: 'buy' | 'sell' | 'hold'; score: number }[];
  confidence: number;          // 0-1
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;     // 盈亏比 = (tp−entry)/(entry−sl)，手册要求 ≥2:1
  positionSize: number | null;   // 建议持仓股数（头寸反推，受大盘仓位上限与单股≤20%约束）
  positionValuePct: number | null; // 建议仓位占账户净值比例
  reason: string;
  signals: { type: 'bullish' | 'bearish'; name: string; confidence: number }[];
}

// 仓位/风控选项：接通择时→仓位链（手册 1.3 + 5.3）
export interface RecommendationRiskOptions {
  maxPosition?: number;       // 大盘择时给出的总仓位上限（0~1），来自 marketTiming
  accountEquity?: number;     // 账户净值（元），默认 10 万
  riskPerTrade?: number;      // 单笔风险占比（默认 0.01 = 1%），手册 5.3
  minRiskReward?: number;     // 最低盈亏比门槛（默认 1.5，<此值不发买）
}

/**
 * 对单只股票生成多策略共识推荐
 * @param rows 最新日K数据（升序，至少 72 行）
 * @param optima 该股票各策略的最优参数，key=strategy
 * @param marketRegime 当前大盘环境
 * @param credibility 各策略的融合可信度（回测先验+真实后验），用于投票加权；缺失则按 1 中性处理
 */
export function generateRecommendation(
  rows: KlineRow[],
  optima: { strategy: StrategyType; params: BacktestParams; compositeScore: number }[],
  marketRegime: 'bull' | 'range' | 'bear',
  credibility?: Partial<Record<StrategyType, number>>,
  riskOpts?: RecommendationRiskOptions,
  intraday60?: MinBar[],   // 60分钟K线（来自 kline_min），用于三周期共振第三层确认；缺省退化为两周期
  monthlyRows?: KlineRow[], // 月线K线（来自 kline_long_period month），第一层硬过滤；缺省不启用
): StockRecommendation {
  const code = (rows[0] as any)?.marketCode ?? '';
  const last = rows[rows.length - 1];
  const i = rows.length; // 当日信号位置

  // 多策略投票
  const votes: { strategy: StrategyType; signal: 'buy' | 'sell' | 'hold'; score: number }[] = [];
  let buyCount = 0, sellCount = 0;

  for (const opt of optima) {
    const params = { ...opt.params, marketRegime };
    const signal = generateSignal(opt.strategy, params, rows, i);
    // 可信度加权：真实表现差的策略即使发信号，对共识置信度的贡献也被压低
    const cred = credibility?.[opt.strategy] ?? 1;
    const effScore = opt.compositeScore * cred;
    votes.push({ strategy: opt.strategy, signal, score: effScore });
    if (signal === 'buy') buyCount++;
    if (signal === 'sell') sellCount++;
  }

  const totalStrategies = votes.length || 1;
  const consensusStrength = Math.max(buyCount, sellCount) / totalStrategies;

  // 三周期共振打分补充（含月线第一层硬过滤 + 60 分钟第三层，若提供）
  const cycleResult = scoreMultiCycle(rows, {
    ...(intraday60 ? { intraday60 } : {}),
    ...(monthlyRows ? { monthly: monthlyRows } : {}),
  });
  const signalReport = detectSignals(rows);

  // 综合判定 - 圆桌会议优化：加权连续打分制 (Continuous Net Scoring)
  let action: 'buy' | 'sell' | 'hold' = 'hold';
  let confidence = 0;

  // 1. 计算加权净置信度 (Net Conviction)
  let netScore = 0;
  for (const v of votes) {
    // v.score 已经包含了该策略的回测综合分和贝叶斯可信度
    if (v.signal === 'buy') netScore += v.score;
    else if (v.signal === 'sell') netScore -= v.score;
  }
  
  // 归一化一下，避免多策略直接爆表
  const normalizedNetScore = votes.length > 0 ? netScore / Math.sqrt(votes.length) : 0;

  // 2. Regime-Dependent Strictness (大盘环境自适应门槛)
  const isBull = marketRegime === 'bull';
  const isBear = marketRegime === 'bear';
  const minNetScore = isBull ? 0.20 : isBear ? 0.60 : 0.35; 

  const cycleBoost = cycleResult.score > 60 ? 0.15 : cycleResult.score > 50 ? 0.05 : 0;
  const signalBoost = Math.min(0.1, signalReport.buySignals.length * 0.03);
  const sellBoost = signalReport.sellSignals.filter(s => s.urgency === 'high').length * 0.1;

  if (normalizedNetScore >= minNetScore) {
    action = 'buy';
    confidence = Math.min(0.95, normalizedNetScore + cycleBoost + signalBoost);
  } else if (normalizedNetScore <= -minNetScore) {
    action = 'sell';
    confidence = Math.min(0.95, Math.abs(normalizedNetScore) + sellBoost);
  } else if (buyCount >= 1 && sellCount === 0 && !isBear) {
    // 单策略买入信号兜底（非熊市允许，降级置信度）
    action = 'buy';
    confidence = Math.max(0.3, Math.min(0.6, normalizedNetScore + cycleBoost));
  }

  // 止损/止盈计算（取所有 BUY 策略的参数均值，或用默认值）
  const buyOpts = optima.filter((_, idx) => votes[idx]?.signal === 'buy');
  const avgParam = (key: keyof BacktestParams, fallback: number) => {
    const vals = buyOpts.map(o => o.params[key]).filter(v => typeof v === 'number') as number[];
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : fallback;
  };

  const entryPrice = safe(last.close);
  const stopLossPct = avgParam('stopLoss', 0.08);
  const takeProfitPct = avgParam('takeProfit', 0.25);
  const atr14 = safe(last.atr14);

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  if (entryPrice !== null) {
    stopLoss = atr14 !== null
      ? Math.max(entryPrice - 2 * atr14, entryPrice * (1 - stopLossPct))
      : entryPrice * (1 - stopLossPct);
    takeProfit = entryPrice * (1 + takeProfitPct);
  }

  // ── 盈亏比（手册铁律3：EV>0 才执行；盈亏比≥2:1）──
  const riskReward = (entryPrice !== null && stopLoss !== null && takeProfit !== null && entryPrice > stopLoss)
    ? (takeProfit - entryPrice) / (entryPrice - stopLoss)
    : null;

  // ── 头寸反推 + 仓位上限（手册 5.3：头寸=允许亏损金额÷(入场−止损)；单股≤20%；大盘决定总仓位）──
  const equity = riskOpts?.accountEquity ?? 100000;
  const riskPct = riskOpts?.riskPerTrade ?? 0.01;
  const maxPos = riskOpts?.maxPosition ?? 0.5;
  let positionSize: number | null = null;
  let positionValuePct: number | null = null;
  if (entryPrice !== null && stopLoss !== null && entryPrice > stopLoss) {
    const riskAmount = equity * riskPct;                 // 单笔可承受亏损金额
    const perShareRisk = entryPrice - stopLoss;
    let shares = Math.floor(riskAmount / perShareRisk / 100) * 100; // 按 1 手=100 股取整
    // 单股上限：账户 × min(20%, 大盘总仓位上限)。手册两条独立约束：单股≤20% + 总仓位≤maxPosition
    // （总仓位的组合层约束由 recommendationBacktest 的权重分配保证，单股推荐这里取两者较紧者）
    const maxStockValue = equity * Math.min(0.20, maxPos);
    const maxShares = Math.floor(maxStockValue / entryPrice / 100) * 100;
    if (shares > maxShares) shares = maxShares;
    if (shares >= 100) {
      positionSize = shares;
      positionValuePct = Math.round((shares * entryPrice) / equity * 10000) / 10000;
    }
  }

  // ── 盈亏比门槛：负期望/低盈亏比交易坚决不做（手册：盈亏比<1 坚决不做；<2 降级）──
  const minRR = riskOpts?.minRiskReward ?? 1.5;
  if (action === 'buy') {
    if (riskReward !== null && riskReward < minRR) {
      action = 'hold';        // 盈亏比不足，放弃本次买入
      confidence = 0;
    } else if (riskReward !== null && riskReward < 2) {
      confidence = Math.round(confidence * 0.7 * 100) / 100; // 未达 2:1，降级置信度
    }
  }

  // 推荐理由
  const reasons: string[] = [];
  if (buyCount > 0) reasons.push(`${buyCount}策略看多`);
  if (sellCount > 0) reasons.push(`${sellCount}策略看空`);
  if (cycleResult.resonant) reasons.push('三周期共振');
  if (signalReport.buySignals.length >= 3) reasons.push(`${signalReport.buySignals.length}重买入信号`);
  if (riskReward !== null) reasons.push(`盈亏比${riskReward.toFixed(2)}:1`);
  if (positionSize !== null && action === 'buy') reasons.push(`建议${positionSize}股(≈${(positionValuePct! * 100).toFixed(1)}%仓位)`);
  const riskTags = signalReport.riskTags.filter(r => r.level === 'danger');
  if (riskTags.length > 0) reasons.push(riskTags[0].name);
  if (action === 'hold' && riskReward !== null && riskReward < minRR) reasons.push(`盈亏比${riskReward.toFixed(2)}<${minRR}放弃`);

  return {
    marketCode: code,
    action,
    consensusStrength,
    voteDetail: votes,
    confidence: Math.round(confidence * 100) / 100,
    entryPrice,
    stopLoss,
    takeProfit,
    riskReward: riskReward !== null ? Math.round(riskReward * 100) / 100 : null,
    positionSize,
    positionValuePct,
    reason: reasons.join(' / ') || '信号不足',
    signals: [...cycleResult.signals, ...signalReport.buySignals.map(s => ({ type: 'bullish' as const, name: s.name, confidence: s.confidence }))].slice(0, 5),
  };
}
