// 绩效追踪引擎 —— AutoResearch 闭环的数据反馈层
//
// 职责：扫描所有 active 的买入推荐，用最新 K 线判定是否触及止盈/止损/过期，
// 结算实际收益并回写 returnPct/holdDays/status，形成策略优化的反馈数据。

import { eq, and, sql } from 'drizzle-orm';
import { klineDaily, recommendations, strategyOptima, strategyCredibility, strategyCredibilityByRegime } from '../db/schema.js';
import { computeBacktestPrior } from './autoResearch.js';

// 贝叶斯先验强度：需积累 N 个真实样本，后验权重才升至 0.5
// 样本越多越信真实表现；样本不足时退化为回测先验
const PRIOR_STRENGTH = 20;

const DEFAULT_MAX_HOLD = 30; // 默认最大持仓天数

const safe = (v: number | null | undefined): number | null =>
  (typeof v === 'number' && isFinite(v)) ? v : null;

export interface ResolveResult {
  resolved: number;
  hitTP: number;
  hitSL: number;
  hitSignal: number;
  expired: number;
}

/**
 * 结算所有 active 买入推荐
 * 对每条推荐读取推荐日之后的 K 线，检查是否触及止盈/止损/时间过期
 */
export async function resolveRecommendations(db: any): Promise<ResolveResult> {
  const active = await db.select().from(recommendations)
    .where(and(
      eq(recommendations.status, 'active'),
      eq(recommendations.action, 'buy')
    ))
    .all() as any[];

  let hitTP = 0, hitSL = 0, hitSignal = 0, expired = 0;

  for (const rec of active) {
    if (!rec.entryPrice || rec.entryPrice <= 0) continue;

    // 读取推荐日之后的所有 K 线（含当日）
    const klines = await db.select().from(klineDaily)
      .where(and(
        eq(klineDaily.marketCode, rec.marketCode),
        sql`date >= ${rec.date}`
      ))
      .orderBy(sql`date ASC`)
      .all() as any[];

    if (!klines || klines.length === 0) continue;

    const entryIdx = klines.findIndex(k => k.date === rec.date);
    // 从推荐日后一天开始检查（推荐日 T+1 成交）
    const startIdx = entryIdx >= 0 ? entryIdx + 1 : 0;
    const futureKlines = klines.slice(startIdx);

    if (futureKlines.length === 0) continue;

    const tp = rec.takeProfit;
    const sl = rec.stopLoss;
    const maxHold = DEFAULT_MAX_HOLD;

    let resolved = false;
    let resolvedPrice: number | null = null;
    let status: string = 'active';
    let holdDays = 0;

    for (let i = 0; i < futureKlines.length; i++) {
      const day = futureKlines[i];
      holdDays = i + 1;

      // 检查止盈：日内最高价 >= 止盈价
      if (tp && day.high >= tp) {
        resolvedPrice = tp;
        status = 'hit_tp';
        resolved = true;
        break;
      }
      // 检查止损：日内最低价 <= 止损价
      if (sl && day.low <= sl) {
        resolvedPrice = sl;
        status = 'hit_sl';
        resolved = true;
        break;
      }
      
      // 强势板块见顶法则：大阴线放量跌破5日线，坚决离场
      const ma5 = safe(day.ma5);
      if (ma5 !== null && i > 1) {
         let volSum = 0, volCount = 0;
         for (let k = 1; k <= 5; k++) {
           if (i - k >= 0) { volSum += futureKlines[i - k].volume; volCount++; }
           else if (entryIdx + 1 + i - k >= 0) { volSum += klines[entryIdx + 1 + i - k].volume; volCount++; }
         }
         const volMa5 = volCount > 0 ? volSum / volCount : day.volume;
         const isBigYin = day.close < day.open && (day.open - day.close) / day.open > 0.02; // 实体>2%的大阴线
         if (isBigYin && day.close < ma5 && day.volume > volMa5 * 1.5) {
            resolvedPrice = day.close;
            status = 'hit_signal';
            resolved = true;
            break;
         }
      }
      
      // 增加手册核心纪律：MA20 防守线。持仓3天后跌破MA20果断止损/止盈
      if (i > 2) { 
        const ma20 = safe(day.ma20);
        if (ma20 !== null && day.close < ma20) {
          resolvedPrice = day.close;
          status = 'hit_signal';
          resolved = true;
          break;
        }
      }

      // 时间过期
      if (holdDays >= maxHold) {
        resolvedPrice = day.close;
        status = 'expired';
        resolved = true;
        break;
      }
    }

    if (resolved && resolvedPrice !== null) {
      const returnPct = (resolvedPrice - rec.entryPrice) / rec.entryPrice;
      await db.update(recommendations).set({
        status,
        resolvedPrice: Math.round(resolvedPrice * 100) / 100,
        returnPct: Math.round(returnPct * 10000) / 10000,
        holdDays,
        resolvedAt: new Date(),
      }).where(eq(recommendations.id, rec.id)).run();

      if (status === 'hit_tp') hitTP++;
      else if (status === 'hit_sl') hitSL++;
      else if (status === 'hit_signal') hitSignal++;
      else expired++;
    }
  }

  const total = hitTP + hitSL + hitSignal + expired;
  return { resolved: total, hitTP, hitSL, hitSignal, expired };
}

/**
 * 汇总推荐绩效统计，供仪表盘和 AI 复盘使用
 */
export async function getPerformanceStats(db: any) {
  const stats = await db.select({
    total: sql`count(*)`,
    active: sql`sum(case when status = 'active' then 1 else 0 end)`,
    resolved: sql`sum(case when status != 'active' then 1 else 0 end)`,
    hitTP: sql`sum(case when status = 'hit_tp' then 1 else 0 end)`,
    hitSL: sql`sum(case when status = 'hit_sl' then 1 else 0 end)`,
    hitSignal: sql`sum(case when status = 'hit_signal' then 1 else 0 end)`,
    expired: sql`sum(case when status = 'expired' then 1 else 0 end)`,
    avgReturn: sql`avg(case when return_pct is not null then return_pct end)`,
    avgHoldDays: sql`avg(case when hold_days is not null then hold_days end)`,
    winRate: sql`sum(case when return_pct > 0 then 1 else 0 end) * 1.0 / nullif(sum(case when return_pct is not null then 1 else 0 end), 0)`,
  }).from(recommendations).get();

  // 按策略分组
  const byStrategy = await db.select({
    strategy: recommendations.strategy,
    total: sql`count(*)`,
    winRate: sql`sum(case when return_pct > 0 then 1 else 0 end) * 1.0 / nullif(sum(case when return_pct is not null then 1 else 0 end), 0)`,
    avgReturn: sql`avg(return_pct)`,
  }).from(recommendations)
    .where(sql`return_pct is not null`)
    .groupBy(recommendations.strategy)
    .all();

  return { overview: stats, byStrategy };
}

/**
 * 重算策略可信度 —— AutoResearch 闭环的「learn」环节
 *
 * 1. 读所有已结算推荐，把真实收益归因到 strategyDetail 中记录的投票策略
 * 2. 聚合每个策略的真实胜率/收益（后验）
 * 3. 读 strategy_optima 算回测先验
 * 4. 贝叶斯收缩融合：blended = prior·(1-w) + posterior·w，w = N/(N+PRIOR_STRENGTH)
 *
 * 结果写入 strategy_credibility，供 recommender 加权 & 下一轮优化参考
 */
export async function recomputeStrategyCredibility(db: any) {
  // ── 1. 归因：把每条已结算推荐的真实收益，分配给参与投票的策略 ──
  const resolved = await db.select().from(recommendations)
    .where(sql`return_pct is not null`).all() as any[];

  const stat = new Map<string, { wins: number; total: number; sumReturn: number }>();
  for (const rec of resolved) {
    let strategies: string[] = [];
    try {
      if (rec.strategyDetail) {
        const d = JSON.parse(rec.strategyDetail);
        strategies = Array.isArray(d.buyVotes) ? d.buyVotes : [];
      }
    } catch { /* 损坏的 JSON 跳过 */ }
    if (strategies.length === 0) continue;
    for (const s of strategies) {
      if (!stat.has(s)) stat.set(s, { wins: 0, total: 0, sumReturn: 0 });
      const st = stat.get(s)!;
      st.total++;
      st.sumReturn += rec.returnPct ?? 0;
      if ((rec.returnPct ?? 0) > 0) st.wins++;
    }
  }

  // ── 2. 对每个策略融合先验(回测)与后验(真实) ──
  const KNOWN_STRATEGIES = ['three_cycle', 'macd_cross', 'rsi_reversal', 'ma520'];
  const allStrategies = new Set<string>([...stat.keys(), ...KNOWN_STRATEGIES]);
  const results: any[] = [];

  for (const strategy of allStrategies) {
    // 先验：回测聚合
    const optimaRows = await db.select().from(strategyOptima)
      .where(eq(strategyOptima.strategy, strategy)).all() as any[];
    const prior = computeBacktestPrior(optimaRows.map((r: any) => ({
      paramsJson: r.paramsJson, testReturn: r.testReturn, testSharpe: r.testSharpe,
      overfitScore: r.overfitScore, tradeCount: r.tradeCount,
      maxDrawdown: r.maxDrawdown, compositeScore: r.compositeScore,
    })));

    // 后验：真实推荐归因
    const s = stat.get(strategy);
    const realSampleCount = s?.total ?? 0;
    const realWinRate = s && s.total > 0 ? s.wins / s.total : null;
    const realAvgReturn = s && s.total > 0 ? s.sumReturn / s.total : null;

    // 后验得分 = 真实胜率 × 真实收益因子
    const winFactor = realWinRate ?? 0;
    const retFactor = realAvgReturn !== null
      ? Math.max(0, Math.min(1, (realAvgReturn + 0.1) / 0.3)) : 0;
    const postScore = realSampleCount > 0 ? winFactor * retFactor : null;

    // 贝叶斯收缩：样本越多后验权重越大
    const w = realSampleCount / (realSampleCount + PRIOR_STRENGTH);
    const blended = postScore !== null
      ? prior.score * (1 - w) + postScore * w
      : prior.score;

    const row = {
      strategy,
      realSampleCount,
      realWinRate,
      realAvgReturn,
      backtestStockCount: prior.stockCount,
      backtestAvgScore: prior.score,
      backtestAvgReturn: prior.avgReturn,
      backtestAvgSharpe: prior.avgSharpe,
      blendedCredibility: Math.round(blended * 1000) / 1000,
      updatedAt: new Date(),
    };

    await db.insert(strategyCredibility).values(row)
      .onConflictDoUpdate({ target: strategyCredibility.strategy, set: row }).run();

    results.push({
      strategy,
      realSampleCount, realWinRate, realAvgReturn,
      priorScore: prior.score,
      blendedCredibility: row.blendedCredibility,
      backtestStockCount: prior.stockCount,
    });
  }

  return results;
}

/**
 * 用历史回放结果反哺策略可信度 —— 最强 learn 信号
 *
 * 回放是「推荐引擎级」的数百笔历史实战，远比稀疏的实时推荐归因可信。
 * 回放揭示的真实胜率/收益直接驱动可信度：实战亏钱的策略（如频繁假信号的
 * MACD 金叉）credibility 大降，被推荐引擎自动边缘化；实战赚钱的策略加权。
 */
export async function applyBacktestCredibility(
  db: any,
  byStrategy: Record<string, { trades: number; winRate: number; avgReturn: number }>,
  byStrategyRegime?: Record<string, { trades: number; winRate: number; avgReturn: number }>,
) {
  const results: any[] = [];
  // 先聚合每个策略的先验（复用）
  const priorCache = new Map<string, { score: number; avgReturn: number; avgSharpe: number; stockCount: number }>();
  for (const strategy of Object.keys(byStrategy)) {
    const stat = byStrategy[strategy];

    // 先验：参数回测聚合（来自 strategy_optima）
    const optimaRows = await db.select().from(strategyOptima)
      .where(eq(strategyOptima.strategy, strategy)).all() as any[];
    const prior = computeBacktestPrior(optimaRows.map((r: any) => ({
      paramsJson: r.paramsJson, testReturn: r.testReturn, testSharpe: r.testSharpe,
      overfitScore: r.overfitScore, tradeCount: r.tradeCount,
      maxDrawdown: r.maxDrawdown, compositeScore: r.compositeScore,
    })));
    priorCache.set(strategy, prior);

    // 后验：历史回放（数百笔实战，w 接近 1，主导 blended）
    const realSampleCount = stat.trades;
    const realWinRate = stat.winRate;
    const realAvgReturn = stat.avgReturn;
    const winFactor = realWinRate;
    const retFactor = Math.max(0, Math.min(1, (realAvgReturn + 0.1) / 0.3));
    const postScore = realSampleCount > 0 ? winFactor * retFactor : null;
    const w = realSampleCount / (realSampleCount + PRIOR_STRENGTH);
    const blended = postScore !== null ? prior.score * (1 - w) + postScore * w : prior.score;

    const row = {
      strategy,
      realSampleCount, realWinRate, realAvgReturn,
      backtestStockCount: prior.stockCount,
      backtestAvgScore: prior.score, backtestAvgReturn: prior.avgReturn, backtestAvgSharpe: prior.avgSharpe,
      blendedCredibility: Math.round(blended * 1000) / 1000,
      updatedAt: new Date(),
    };
    await db.insert(strategyCredibility).values(row)
      .onConflictDoUpdate({ target: strategyCredibility.strategy, set: row }).run();

    results.push({
      strategy, realSampleCount, realWinRate, realAvgReturn,
      priorScore: prior.score, blendedCredibility: row.blendedCredibility,
    });
  }

  // 反脆弱：按 regime 分桶写入 strategy_credibility_by_regime（同策略在牛/熊是不同策略）
  if (byStrategyRegime) {
    for (const [key, stat] of Object.entries(byStrategyRegime)) {
      const [strategy, regime] = key.split('|');
      if (!['bull', 'range', 'bear'].includes(regime)) continue;
      const prior = priorCache.get(strategy) ?? { score: 0, avgReturn: 0, avgSharpe: 0, stockCount: 0 };
      const winFactor = stat.winRate;
      const retFactor = Math.max(0, Math.min(1, (stat.avgReturn + 0.1) / 0.3));
      const postScore = stat.trades > 0 ? winFactor * retFactor : null;
      // regime 桶样本可能稀疏，提高先验强度（PRIOR_STRENGTH ×2）避免稀疏后验主导
      const w = stat.trades / (stat.trades + PRIOR_STRENGTH * 2);
      const blended = postScore !== null ? prior.score * (1 - w) + postScore * w : prior.score;
      const row = {
        strategy, regime,
        realSampleCount: stat.trades, realWinRate: stat.winRate, realAvgReturn: stat.avgReturn,
        blendedCredibility: Math.round(blended * 1000) / 1000,
        source: 'backtest', updatedAt: new Date(),
      };
      await db.insert(strategyCredibilityByRegime).values(row)
        .onConflictDoUpdate({ target: [strategyCredibilityByRegime.strategy, strategyCredibilityByRegime.regime], set: row }).run();
    }
  }
  return results;
}
