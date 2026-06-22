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
import { researchRuns, strategyOptima, recommendations, stocks as stocksSchema, klineDaily } from '../db/schema.js';
import { eq, desc, asc, and, sql } from 'drizzle-orm';
import {
  optimizeStock, researchState, resetResearchState, addResearchLog
} from '../lib/autoResearch.js';
import type { StrategyType } from '../lib/backtestEngine.js';
import { generateRecommendation } from '../lib/recommender.js';
import { assessMarketTiming } from '../lib/marketTiming.js';
import { resolveRecommendations, getPerformanceStats } from '../lib/performanceTracker.js';

const app = new Hono();

const ALL_STRATEGIES: StrategyType[] = ['three_cycle', 'macd_cross', 'rsi_reversal', 'ma520'];

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
async function runOptimization(db: any, strategies: StrategyType[], maxSamples: number) {
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

  // 预加载全部股票K线，避免逐只查询
  const allKlines = await db.select().from(klineDaily).orderBy(asc(klineDaily.date)).all() as any[];
  const klineMap = new Map<string, any[]>();
  for (const row of allKlines) {
    if (!klineMap.has(row.marketCode)) klineMap.set(row.marketCode, []);
    klineMap.get(row.marketCode)!.push(row);
  }

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

    for (const code of stockCodes) {
      researchState.strategy = strategy;
      const rows = klineMap.get(code);
      if (!rows || rows.length < 150) {
        researchState.current++;
        continue;
      }

      try {
        const optimum = optimizeStock(rows, strategy, benchmark, {
          maxSamples,
          marketRegime: timing.regime,
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
    }

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
  addResearchLog('全部优化完成');
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

// ── POST /recommend: 生成当日推荐 ──
app.post('/recommend', async (c) => {
  try {
    const db = getDb(c);
    const today = new Date().toISOString().slice(0, 10);

    // 检查今日是否已生成推荐
    const existing = await db.select().from(recommendations)
      .where(eq(recommendations.date, today)).all();
    if (existing.length > 0) {
      return c.json({ success: false, message: `今日已生成 ${existing.length} 条推荐，请先结算或清理` });
    }

    // 读取沪深300用于大盘择时
    const benchmark = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, 'sh000300'))
      .orderBy(asc(klineDaily.date)).limit(300).all() as any[];
    if (benchmark.length < 60) {
      return c.json({ success: false, error: '沪深300数据不足，无法判定大盘择时' });
    }
    const timing = assessMarketTiming(benchmark, 'sh000300');

    // 读取所有有最优参数的股票
    const optimaRows = await db.select().from(strategyOptima)
      .orderBy(desc(strategyOptima.compositeScore)).all() as any[];

    if (optimaRows.length === 0) {
      return c.json({ success: false, error: '请先运行策略优化（POST /optimize）' });
    }

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

    // 预加载近期K线
    const allKlines = await db.select().from(klineDaily)
      .orderBy(asc(klineDaily.date)).all() as any[];
    const klineMap = new Map<string, any[]>();
    for (const row of allKlines) {
      if (!klineMap.has(row.marketCode)) klineMap.set(row.marketCode, []);
      klineMap.get(row.marketCode)!.push(row);
    }

    const buyRecs: any[] = [];
    let totalAnalyzed = 0;

    for (const [code, optima] of optimaByCode) {
      const rows = klineMap.get(code);
      if (!rows || rows.length < 72) continue;
      totalAnalyzed++;

      const rec = generateRecommendation(rows, optima, timing.regime);
      if (rec.action === 'buy' && rec.confidence >= 0.3) {
        buyRecs.push(rec);
      }
    }

    // 按置信度排序，取 Top 10 写入推荐表
    buyRecs.sort((a, b) => b.confidence - a.confidence);
    const topPicks = buyRecs.slice(0, 10);

    for (const rec of topPicks) {
      await db.insert(recommendations).values({
        date: today,
        marketCode: rec.marketCode,
        action: rec.action,
        strategy: 'consensus',
        confidence: rec.confidence,
        entryPrice: rec.entryPrice,
        stopLoss: rec.stopLoss,
        takeProfit: rec.takeProfit,
        reason: rec.reason,
        status: 'active',
        createdAt: new Date(),
      }).run();
    }

    return c.json({
      success: true,
      data: {
        analyzed: totalAnalyzed,
        buySignals: buyRecs.length,
        recommended: topPicks.length,
        timing: { regime: timing.regime, regimeLabel: timing.regimeLabel, maxPosition: timing.maxPosition },
        picks: topPicks,
      }
    });
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
    return c.json({ success: true, data: result });
  } catch (e: any) {
    console.error('Resolve error:', e);
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
