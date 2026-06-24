// AutoResearch API —— 闭环优化的控制面板
//
// POST /optimize   —— 启动批量 walk-forward 参数优化（后台异步执行）
// GET  /status      —— 轮询优化进度
// POST /recommend   —— 生成当日多策略共识推荐
// GET  /recommendations —— 获取最新推荐列表
// GET  /optima      —— 查看各股票优化后的最优参数
// POST /resolve     —— 手动触发绩效结算
// GET  /performance —— 推荐绩效统计
// GET  /runs        —— 优化运行历史

import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import {
  researchRuns, strategyOptima, recommendations, stocks as stocksSchema,
  klineDaily, globalStrategyOptima, strategyCredibility,
} from '../db/schema.js';
import { eq, desc, asc, and, sql } from 'drizzle-orm';
import {
  researchState, resetResearchState, addResearchLog,
  aggregateGlobalOptima, optimizeStock, type OptimumResult,
} from '../lib/autoResearch.js';
import type { StrategyType, BacktestParams } from '../lib/backtestEngine.js';
import { generateRecommendation } from '../lib/recommender.js';
import { assessMarketTiming } from '../lib/marketTiming.js';
import { resolveRecommendations, getPerformanceStats, recomputeStrategyCredibility, applyBacktestCredibility } from '../lib/performanceTracker.js';
import { backtestRecommendationEngine } from '../lib/recommendationBacktest.js';
import { generateDailyDigest } from '../lib/aiDigest.js';
import { optimizeWorkerPool } from '../lib/workerPool.js';

const app = new Hono();

const ALL_STRATEGIES: StrategyType[] = ['three_cycle', 'macd_cross', 'rsi_reversal', 'ma520'];

// 从 strategy_optima 聚合每个策略的全局稳健参数，写入 global_strategy_optima
// 这是「提炼最稳定策略」的核心：跨股票取中位数参数 + 稳健性统计
async function aggregateGlobalForAll(db: any, regime = 'all') {
  const results: any[] = [];
  for (const strategy of ALL_STRATEGIES) {
    const rows = await db.select().from(strategyOptima)
      .where(eq(strategyOptima.strategy, strategy)).all() as any[];
    const optimaRows = rows.map((r: any) => ({
      paramsJson: r.paramsJson, testReturn: r.testReturn, testSharpe: r.testSharpe,
      overfitScore: r.overfitScore, tradeCount: r.tradeCount,
      maxDrawdown: r.maxDrawdown, compositeScore: r.compositeScore,
    }));
    const g = aggregateGlobalOptima(optimaRows);
    if (g) {
      const row = {
        strategy, regime,
        paramsJson: JSON.stringify(g.params),
        avgTestReturn: g.avgTestReturn, avgTestSharpe: g.avgTestSharpe,
        avgMaxDrawdown: g.avgMaxDrawdown, stabilityScore: g.stabilityScore,
        coverageStocks: g.coverageStocks, sampleStocks: g.sampleStocks,
        aggregatedAt: new Date(),
      };
      await db.insert(globalStrategyOptima).values(row).onConflictDoUpdate({
        target: [globalStrategyOptima.strategy, globalStrategyOptima.regime], set: row,
      }).run();
    }
    results.push({
      strategy,
      stability: g?.stabilityScore ?? 0,
      coverage: g?.coverageStocks ?? 0,
      sample: rows.length,
      avgTestReturn: g?.avgTestReturn ?? null,
    });
  }
  return results;
}

// ── POST /optimize: 启动批量优化 ──
app.post('/optimize', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const strategies: StrategyType[] = body.strategies?.length
    ? body.strategies.filter((s: string) => ALL_STRATEGIES.includes(s as StrategyType))
    : ALL_STRATEGIES;
  const maxSamples = Math.min(body.maxSamples ?? 25, 50);

  if (researchState.status === 'running') {
    return c.json({ success: false, message: '优化任务正在执行中' });
  }

  const db = getDb(c);
  const promise = runOptimization(db, strategies, maxSamples);

  try { c.executionCtx.waitUntil(promise); } catch { promise.catch(console.error); }

  return c.json({ success: true, message: `优化已启动: ${strategies.join(', ')}` });
});

// ── 后台批量优化 ──
export async function runOptimization(db: any, strategies: StrategyType[], maxSamples: number) {
  // 读取沪深300作为基准
  const benchmark = await db.select().from(klineDaily)
    .where(eq(klineDaily.marketCode, 'sh000300'))
    .orderBy(asc(klineDaily.date)).all() as any[];

  if (benchmark.length < 150) {
    researchState.status = 'error';
    addResearchLog('沪深300数据不足，无法优化');
    return;
  }

  // 大盘择时
  const timing = assessMarketTiming(benchmark, 'sh000300');

  const pool = await db.select().from(stocksSchema).all();
  const stockCodes = pool.map((s: any) => s.marketCode);

  // Instead of loading all KLines into memory upfront, we'll query them per stock inside the loop
  // to avoid V8 GC spikes and out-of-memory errors on large datasets.

  const totalRuns = strategies.length * stockCodes.length;
  resetResearchState();
  researchState.status = 'running';
  researchState.total = totalRuns;
  researchState.startedAt = new Date();
  addResearchLog(`开始优化 ${totalRuns} 个组合（${strategies.length} 策略 x ${stockCodes.length} 股票），大盘: ${timing.regimeLabel}`);

  for (const strategy of strategies) {
    // 创建运行记录
    const runRecord = await db.insert(researchRuns).values({
      strategy,
      status: 'running',
      startedAt: new Date(),
    }).returning().get();
    const runId = runRecord.id;

    let profitableCount = 0;
    let bestScore = 0;
    const trainReturns: number[] = [];
    const testReturns: number[] = [];

    const tasks = stockCodes.map(async (code) => {
      const rows = await db.select().from(klineDaily)
        .where(eq(klineDaily.marketCode, code))
        .orderBy(asc(klineDaily.date)).all() as any[];

      if (!rows || rows.length < 150) {
        researchState.current++;
        return;
      }

      try {
        const optimum = await optimizeWorkerPool.runTask({
          rows,
          strategy,
          benchmark,
          options: {
            maxSamples,
            marketRegime: timing.regime,
          }
        });

        if (optimum) {
          profitableCount++;
          bestScore = Math.max(bestScore, optimum.compositeScore);
          trainReturns.push(optimum.trainMetrics.totalReturn);
          testReturns.push(optimum.testMetrics.totalReturn);

          // 写入/更新最优参数
          await db.insert(strategyOptima).values({
            marketCode: code,
            strategy,
            paramsJson: JSON.stringify(optimum.params),
            trainSharpe: optimum.trainMetrics.sharpeRatio,
            testSharpe: optimum.testMetrics.sharpeRatio,
            trainReturn: optimum.trainMetrics.totalReturn,
            testReturn: optimum.testMetrics.totalReturn,
            trainWinRate: optimum.trainMetrics.winRate,
            testWinRate: optimum.testMetrics.winRate,
            maxDrawdown: optimum.testMetrics.maxDrawdown,
            compositeScore: optimum.compositeScore,
            overfitScore: optimum.overfitScore,
            tradeCount: optimum.testMetrics.tradeCount,
            validatedAt: new Date(),
          }).onConflictDoUpdate({
            target: [strategyOptima.marketCode, strategyOptima.strategy],
            set: {
              paramsJson: JSON.stringify(optimum.params),
              trainSharpe: optimum.trainMetrics.sharpeRatio,
              testSharpe: optimum.testMetrics.sharpeRatio,
              trainReturn: optimum.trainMetrics.totalReturn,
              testReturn: optimum.testMetrics.totalReturn,
              trainWinRate: optimum.trainMetrics.winRate,
              testWinRate: optimum.testMetrics.winRate,
              maxDrawdown: optimum.testMetrics.maxDrawdown,
              compositeScore: optimum.compositeScore,
              overfitScore: optimum.overfitScore,
              tradeCount: optimum.testMetrics.tradeCount,
              validatedAt: new Date(),
            }
          }).run();
        }
      } catch (e: any) {
        // 单只股票优化失败不影响整体
      }

      researchState.current++;
      researchState.profitable = profitableCount;
      if (researchState.current % 20 === 0) {
        addResearchLog(`[${strategy}] ${researchState.current}/${totalRuns} | 盈利方案: ${profitableCount}`);
      }
    });

    await Promise.all(tasks);

    // 更新运行记录
    const avgTrain = trainReturns.length > 0 ? trainReturns.reduce((a, b) => a + b, 0) / trainReturns.length : 0;
    const avgTest = testReturns.length > 0 ? testReturns.reduce((a, b) => a + b, 0) / testReturns.length : 0;
    await db.update(researchRuns).set({
      status: 'completed',
      stocksOptimized: stockCodes.length,
      stocksProfitable: profitableCount,
      bestCompositeScore: bestScore,
      avgTrainReturn: avgTrain,
      avgTestReturn: avgTest,
      completedAt: new Date(),
    }).where(eq(researchRuns.id, runId)).run();

    researchState.profitable = profitableCount;
    addResearchLog(`[${strategy}] 完成: ${profitableCount}/${stockCodes.length} 盈利 | 平均训练收益: ${(avgTrain * 100).toFixed(1)}% | 平均测试收益: ${(avgTest * 100).toFixed(1)}%`);
  }

  researchState.status = 'completed';
  addResearchLog('全部优化完成，开始提炼全局稳健策略');
  // 闭环关键：优化结果自动提炼为全局稳健策略 + 刷新策略可信度（先验部分）
  try {
    const agg = await aggregateGlobalForAll(db);
    const stable = agg.filter((a: any) => a.stability > 0).length;
    addResearchLog(`全局策略聚合完成: ${stable}/${ALL_STRATEGIES.length} 个策略提炼出稳健参数`);
    await recomputeStrategyCredibility(db);
    addResearchLog('策略可信度已刷新（先验+真实后验融合）');
  } catch (e: any) {
    addResearchLog(`聚合/可信度刷新失败: ${e.message}`);
  }
}

// ── GET /status: 轮询优化进度 ──
app.get('/status', (c) => {
  const progress = researchState.current > 0 ? (researchState.current / researchState.total) * 100 : 0;
  return c.json({
    success: true,
    data: {
      ...researchState,
      progress: Math.round(progress * 10) / 10,
    }
  });
});

// ── 生成当日推荐（核心逻辑，供 /recommend 与 /auto-cycle 复用）──
// 闭环关键：全局策略兜底缺失策略 + 可信度加权投票 + 写入投票归因（learn 数据源）
async function generateTodayRecommendations(db: any, opts: { force?: boolean } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  if (!opts.force) {
    const existing = await db.select().from(recommendations)
      .where(eq(recommendations.date, today)).all();
    if (existing.length > 0) {
      return { success: false, message: `今日已生成 ${existing.length} 条推荐，请先结算或清理`, today };
    }
  }

  // 读取沪深300用于大盘择时
  const benchmark = await db.select().from(klineDaily)
    .where(eq(klineDaily.marketCode, 'sh000300'))
    .orderBy(asc(klineDaily.date)).limit(300).all() as any[];
  if (benchmark.length < 60) {
    return { success: false, error: '沪深300数据不足，无法判定大盘择时', today };
  }
  const timing = assessMarketTiming(benchmark, 'sh000300');

  // 读取所有有最优参数的股票
  const optimaRows = await db.select().from(strategyOptima)
    .orderBy(desc(strategyOptima.compositeScore)).all() as any[];
  if (optimaRows.length === 0) {
    return { success: false, error: '请先运行策略优化（POST /optimize）', today };
  }

  // 全局稳健策略 —— 兜底：某策略在该股无 per-stock 参数时，用全局中位数参数投票
  const globalRows = await db.select().from(globalStrategyOptima).all() as any[];
  const globalParams = new Map<string, BacktestParams>();
  for (const g of globalRows) globalParams.set(g.strategy, JSON.parse(g.paramsJson));

  // 策略可信度 —— 融合先验(回测)+后验(真实推荐)，用于投票加权
  const credRows = await db.select().from(strategyCredibility).all() as any[];
  const credibility: Partial<Record<StrategyType, number>> = {};
  for (const cr of credRows) credibility[cr.strategy as StrategyType] = cr.blendedCredibility ?? 1;

  // 按股票分组最优参数
  const optimaByCode = new Map<string, any[]>();
  for (const row of optimaRows) {
    if (!optimaByCode.has(row.marketCode)) optimaByCode.set(row.marketCode, []);
    optimaByCode.get(row.marketCode)!.push({
      strategy: row.strategy,
      params: JSON.parse(row.paramsJson),
      compositeScore: row.compositeScore,
    });
  }

  // Instead of preloading all K-lines, we will query them per stock below

  // 宏观层：计算板块资金热图 (Sector Momentum)
  const pool = await db.select().from(stocksSchema).all() as any[];
  const industryMap = new Map<string, string>();
  for (const s of pool) {
    if (s.industry) industryMap.set(s.marketCode, s.industry);
  }

  const sectorReturns = new Map<string, number[]>();
  const allStockCodes = Array.from(industryMap.keys());
  for (const code of allStockCodes) {
    const rows = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, code))
      .orderBy(desc(klineDaily.date))
      .limit(4).all() as any[];
      
    if (rows.length >= 4) {
      // Because we ordered by desc, rows[0] is latest, rows[3] is prev3
      const latest = rows[0];
      const prev3 = rows[3];
      const ret = (latest.close - prev3.close) / prev3.close;
      const ind = industryMap.get(code) || '未知';
      if (!sectorReturns.has(ind)) sectorReturns.set(ind, []);
      sectorReturns.get(ind)!.push(ret);
    }
  }

  const sectorMomentum = Array.from(sectorReturns.entries()).map(([ind, rets]) => ({
    industry: ind,
    avgReturn: rets.reduce((a, b) => a + b, 0) / rets.length,
  })).sort((a, b) => b.avgReturn - a.avgReturn);

  const topSectors = new Set(sectorMomentum.slice(0, 3).map(s => s.industry));

  const buyRecs: any[] = [];
  let totalAnalyzed = 0;

  for (const [code, optima] of optimaByCode) {
    const rows = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, code))
      .orderBy(asc(klineDaily.date)).all() as any[];
    if (!rows || rows.length < 72) continue;
    totalAnalyzed++;

    // 合并：per-stock optima + 缺失策略用全局稳健参数兜底，保证多策略共识完整
    const have = new Set(optima.map((o: any) => o.strategy));
    const merged = [...optima];
    for (const strat of ALL_STRATEGIES) {
      if (!have.has(strat) && globalParams.has(strat)) {
        const g = globalRows.find((x: any) => x.strategy === strat);
        merged.push({
          strategy: strat,
          params: globalParams.get(strat)!,
          compositeScore: g?.stabilityScore ?? 0.3, // 全局兜底用稳定率近似评分
        });
      }
    }

    const rec = generateRecommendation(rows, merged, timing.regime, credibility);
    if (rec.action === 'buy' && rec.confidence >= 0.3) {
      const ind = industryMap.get(code);
      if (ind && topSectors.has(ind)) {
        rec.confidence = Math.min(0.95, rec.confidence + 0.20);
        rec.reason += `\n[板块共振] ${ind}板块为近期强势主线，置信度获得额外溢价加成。`;
      }
      buyRecs.push(rec);
    }
  }

  // 按置信度排序，取 Top 10 写入推荐表
  buyRecs.sort((a, b) => b.confidence - a.confidence);
  const topPicks = buyRecs.slice(0, 10);

  for (const rec of topPicks) {
    // 记录投票归因：哪些策略投了 buy —— 真实绩效结算时把收益归因到这些策略（learn 数据源）
    const buyVotes = (rec.voteDetail || [])
      .filter((v: any) => v.signal === 'buy').map((v: any) => v.strategy);
    await db.insert(recommendations).values({
      date: today,
      marketCode: rec.marketCode,
      action: rec.action,
      strategy: 'consensus',
      confidence: rec.confidence,
      entryPrice: rec.entryPrice,
      stopLoss: rec.stopLoss,
      takeProfit: rec.takeProfit,
      strategyDetail: JSON.stringify({ buyVotes, votes: rec.voteDetail }),
      reason: rec.reason,
      status: 'active',
      createdAt: new Date(),
    }).run();
  }

  return {
    success: true,
    today,
    data: {
      analyzed: totalAnalyzed,
      buySignals: buyRecs.length,
      recommended: topPicks.length,
      timing: { regime: timing.regime, regimeLabel: timing.regimeLabel, maxPosition: timing.maxPosition },
      picks: topPicks,
    }
  };
}

// ── POST /recommend: 生成当日推荐 ──
app.post('/recommend', async (c) => {
  try {
    const db = getDb(c);
    const result = await generateTodayRecommendations(db);
    return c.json(result);
  } catch (e: any) {
    console.error('Recommend error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── GET /recommendations: 获取推荐列表 ──
app.get('/recommendations', async (c) => {
  try {
    const status = c.req.query('status') || 'active';
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    const db = getDb(c);

    const rows = await db.select().from(recommendations)
      .where(eq(recommendations.status, status))
      .orderBy(desc(recommendations.createdAt))
      .limit(limit).all();

    // 关联股票名称
    const stockMeta = await db.select().from(stocksSchema).all();
    const metaMap = new Map(stockMeta.map((s: any) => [s.marketCode, s.name]));

    const data = rows.map((r: any) => ({
      ...r,
      name: metaMap.get(r.marketCode) || r.marketCode,
    }));

    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── GET /optima: 查看最优参数 ──
app.get('/optima', async (c) => {
  try {
    const strategy = c.req.query('strategy');
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    const db = getDb(c);

    let query = db.select().from(strategyOptima).orderBy(desc(strategyOptima.compositeScore)).limit(limit);
    const rows = strategy
      ? await query.where(eq(strategyOptima.strategy, strategy)).all()
      : await query.all();

    // 关联股票名称
    const stockMeta = await db.select().from(stocksSchema).all();
    const metaMap = new Map(stockMeta.map((s: any) => [s.marketCode, s.name]));

    const data = rows.map((r: any) => ({
      ...r,
      name: metaMap.get(r.marketCode) || r.marketCode,
      params: JSON.parse(r.paramsJson),
    }));

    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── POST /resolve: 手动触发绩效结算 ──
app.post('/resolve', async (c) => {
  try {
    const db = getDb(c);
    const result = await resolveRecommendations(db);
    // 结算出新数据后，自动重算策略可信度（真实后验反哺）—— Karpathy learn 环节
    const credibility = await recomputeStrategyCredibility(db);
    return c.json({ success: true, data: { ...result, credibility } });
  } catch (e: any) {
    console.error('Resolve error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── POST /aggregate-global: 提炼全局稳健策略（从 per-stock optima 中位数聚合）──
app.post('/aggregate-global', async (c) => {
  try {
    const db = getDb(c);
    const result = await aggregateGlobalForAll(db);
    return c.json({ success: true, data: result });
  } catch (e: any) {
    console.error('Aggregate error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── GET /global-optima: 查看全局稳健策略 ──
app.get('/global-optima', async (c) => {
  try {
    const db = getDb(c);
    const rows = await db.select().from(globalStrategyOptima)
      .orderBy(desc(globalStrategyOptima.stabilityScore)).all() as any[];
    const data = rows.map((r: any) => ({ ...r, params: JSON.parse(r.paramsJson) }));
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── GET /credibility: 策略可信度（先验回测 + 后验真实融合）──
app.get('/credibility', async (c) => {
  try {
    const db = getDb(c);
    const rows = await db.select().from(strategyCredibility)
      .orderBy(desc(strategyCredibility.blendedCredibility)).all();
    return c.json({ success: true, data: rows });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── 一键日常闭环（不含耗时的 optimize）── 供 API 与定时调度复用
// 编排：聚合全局策略 → 生成今日推荐 → 结算历史推荐 → 刷新可信度 → 生成 AI 每日内参
// 耗时的参数重优化请用 POST /optimize（完成后会自动聚合+刷新可信度）
export async function runAutoCycle(c: any, db: any) {
  const aggregate = await aggregateGlobalForAll(db);
  const recommend = await generateTodayRecommendations(db);
  const resolved = await resolveRecommendations(db);
  const credibility = await recomputeStrategyCredibility(db);
  
  const cycleData = {
    aggregate,
    recommend: recommend.data ?? { message: recommend.message },
    resolved,
    credibility,
  };

  const digest = await generateDailyDigest(c, cycleData);

  return {
    ...cycleData,
    digest,
  };
}

// ── POST /auto-cycle: 一键日常闭环 ──
app.post('/auto-cycle', async (c) => {
  try {
    const db = getDb(c);
    const data = await runAutoCycle(c, db);
    return c.json({ success: true, data });
  } catch (e: any) {
    console.error('Auto-cycle error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── GET /performance: 绩效统计 ──
app.get('/performance', async (c) => {
  try {
    const db = getDb(c);
    const stats = await getPerformanceStats(db);
    return c.json({ success: true, data: stats });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── POST /backtest-engine: 推荐引擎历史回放（验证实战盈利能力）──
// 用历史区间每个交易日的数据 + 全局验证策略跑选股，再用后续真实K线结算，
// 证明「调出的最稳定策略」组合起来在历史上是否真的赚钱
app.post('/backtest-engine', async (c) => {
  try {
    const { days = 120, maxHoldDays = 30, minBuyCount = 1 } = (await c.req.json().catch(() => ({}))) as any;
    const db = getDb(c);

    const benchmark = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, 'sh000300'))
      .orderBy(asc(klineDaily.date)).all() as any[];
    if (benchmark.length < 120) {
      return c.json({ success: false, error: '基准数据不足 120 天，无法回放' });
    }
    
    // Lazy query inside backtest engine instead of loading all into map
    const klineMap = new Map<string, any[]>();
    const allStockCodes = (await db.select().from(stocksSchema).all()).map((s:any) => s.marketCode);
    for (const code of allStockCodes) {
       // Yield to event loop to avoid blocking during heavy data load
       await new Promise(resolve => setImmediate(resolve));
       
       const rows = await db.select().from(klineDaily)
        .where(eq(klineDaily.marketCode, code))
        .orderBy(asc(klineDaily.date)).all() as any[];
       klineMap.set(code, rows);
    }

    // 经回测验证的全局策略（稳定率≥0.3 才参与）
    const globalRows = await db.select().from(globalStrategyOptima).all() as any[];
    const strategies = globalRows
      .filter((g: any) => (g.stabilityScore ?? 0) >= 0.3)
      .map((g: any) => ({ strategy: g.strategy as StrategyType, params: JSON.parse(g.paramsJson) as BacktestParams }));
    if (strategies.length === 0) {
      return c.json({ success: false, error: '请先运行策略优化提炼全局策略' });
    }

    const result = backtestRecommendationEngine(klineMap, benchmark, strategies, { days, maxHoldDays, minBuyCount });
    // 回放结果反哺策略可信度 —— 用数百笔历史实战淘汰亏钱策略（最强 learn）
    const credibility = await applyBacktestCredibility(db, result.byStrategy);
    return c.json({ success: true, data: { ...result, strategies: strategies.map(s => s.strategy), credibility } });
  } catch (e: any) {
    console.error('Backtest engine error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ── GET /runs: 优化运行历史 ──
app.get('/runs', async (c) => {
  try {
    const db = getDb(c);
    const rows = await db.select().from(researchRuns)
      .orderBy(desc(researchRuns.startedAt)).limit(20).all();
    return c.json({ success: true, data: rows });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default app;
