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
import { scoreMultiCycle } from './cycles.js';
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
  reason: string;
  signals: { type: 'bullish' | 'bearish'; name: string; confidence: number }[];
}

/**
 * 对单只股票生成多策略共识推荐
 * @param rows 最新日K数据（升序，至少 72 行）
 * @param optima 该股票各策略的最优参数，key=strategy
 * @param marketRegime 当前大盘环境
 */
export function generateRecommendation(
  rows: KlineRow[],
  optima: { strategy: StrategyType; params: BacktestParams; compositeScore: number }[],
  marketRegime: 'bull' | 'range' | 'bear',
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
    const weightedScore = signal === 'buy' ? opt.compositeScore : signal === 'sell' ? -opt.compositeScore : 0;
    votes.push({ strategy: opt.strategy, signal, score: opt.compositeScore });
    if (signal === 'buy') buyCount++;
    if (signal === 'sell') sellCount++;
  }

  const totalStrategies = votes.length || 1;
  const consensusStrength = Math.max(buyCount, sellCount) / totalStrategies;

  // 三周期共振打分补充
  const cycleResult = scoreMultiCycle(rows);
  const signalReport = detectSignals(rows);

  // 综合判定
  let action: 'buy' | 'sell' | 'hold' = 'hold';
  let confidence = 0;

  if (buyCount >= 2 && buyCount > sellCount) {
    action = 'buy';
    // 置信度 = 投票共识 * 均值评分 * 技术面加权
    const avgScore = votes.filter(v => v.signal === 'buy').reduce((s, v) => s + v.score, 0) / buyCount;
    const cycleBoost = cycleResult.score > 60 ? 0.15 : cycleResult.score > 50 ? 0.05 : 0;
    const signalBoost = Math.min(0.1, signalReport.buySignals.length * 0.03);
    confidence = Math.min(0.95, consensusStrength * avgScore + cycleBoost + signalBoost);
  } else if (sellCount >= 2 && sellCount > buyCount) {
    action = 'sell';
    const avgScore = votes.filter(v => v.signal === 'sell').reduce((s, v) => s + v.score, 0) / sellCount;
    const sellBoost = signalReport.sellSignals.filter(s => s.urgency === 'high').length * 0.1;
    confidence = Math.min(0.95, consensusStrength * avgScore + sellBoost);
  } else if (buyCount === 1 && sellCount === 0) {
    action = 'hold'; // 单策略信号不够强，仅观望
    confidence = consensusStrength * 0.3;
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

  // 推荐理由
  const reasons: string[] = [];
  if (buyCount > 0) reasons.push(`${buyCount}策略看多`);
  if (sellCount > 0) reasons.push(`${sellCount}策略看空`);
  if (cycleResult.resonant) reasons.push('三周期共振');
  if (signalReport.buySignals.length >= 3) reasons.push(`${signalReport.buySignals.length}重买入信号`);
  const riskTags = signalReport.riskTags.filter(r => r.level === 'danger');
  if (riskTags.length > 0) reasons.push(riskTags[0].name);

  return {
    marketCode: code,
    action,
    consensusStrength,
    voteDetail: votes,
    confidence: Math.round(confidence * 100) / 100,
    entryPrice,
    stopLoss,
    takeProfit,
    reason: reasons.join(' / ') || '信号不足',
    signals: [...cycleResult.signals, ...signalReport.buySignals.map(s => ({ type: 'bullish' as const, name: s.name, confidence: s.confidence }))].slice(0, 5),
  };
}
