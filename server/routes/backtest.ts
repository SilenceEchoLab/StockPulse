import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { klineDaily } from '../db/schema.js';
import { and, gte, lte, asc, inArray, eq } from 'drizzle-orm';
import { runBacktest, type StrategyType, type BacktestConfig } from '../lib/backtestEngine.js';
import { assessMarketTiming, type Regime } from '../lib/marketTiming.js';

const app = new Hono();

const BUY_FEE = 0.0003;
const SELL_FEE = 0.0013;

const VALID_STRATEGIES: StrategyType[] = ['three_cycle', 'macd_cross', 'rsi_reversal', 'ma520'];

app.post('/run', async (c) => {
  try {
    const body = await c.req.json();
    const {
      codes, strategy = 'three_cycle', startDate, endDate,
      initialCapital = 100000, params = {},
      benchmarkCode = 'sh000300', useMarketTiming = false,
    } = body;

    if (!codes || codes.length === 0) return c.json({ error: 'Missing codes' }, 400);
    if (!VALID_STRATEGIES.includes(strategy)) {
      return c.json({ error: `Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(', ')}` }, 400);
    }

    const db = getDb(c);

    // 读取大盘数据（用于择时和基准）
    const idxRows = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, benchmarkCode))
      .orderBy(asc(klineDaily.date)).all() as any[];

    // 大盘择时
    let marketRegime: Regime | undefined;
    let maxPosition = 1.0;
    if (useMarketTiming && strategy === 'three_cycle') {
      const timing = assessMarketTiming(idxRows, benchmarkCode);
      marketRegime = timing.regime;
      maxPosition = timing.maxPosition;
    }

    // 读取股票数据
    const allCodes = [...new Set([...codes, benchmarkCode])];
    const chunkSize = 50;
    let klines: any[] = [];
    for (let i = 0; i < allCodes.length; i += chunkSize) {
      const chunk = allCodes.slice(i, i + chunkSize);
      const conditions: any[] = [inArray(klineDaily.marketCode, chunk)];
      if (startDate) conditions.push(gte(klineDaily.date, startDate));
      if (endDate) conditions.push(lte(klineDaily.date, endDate));
      const rows = await db.select().from(klineDaily).where(and(...conditions)).orderBy(asc(klineDaily.date)).all();
      klines.push(...rows);
    }

    const dataByCode = klines.reduce((acc: any, curr) => {
      if (!acc[curr.marketCode]) acc[curr.marketCode] = [];
      acc[curr.marketCode].push(curr);
      return acc;
    }, {});

    const benchmark = dataByCode[benchmarkCode] || [];

    // 为每只股票运行回测
    const results = codes.map((code: string) => {
      const rows = dataByCode[code];
      if (!rows || rows.length < 72) return null;

      const config: BacktestConfig = {
        strategy,
        params: {
          ...params,
          positionPct: useMarketTiming ? maxPosition : (params.positionPct ?? 1.0),
          marketRegime,
        },
        fees: { buy: BUY_FEE, sell: SELL_FEE },
        slippage: 0.001,
        initialCapital,
      };

      const result = runBacktest(rows, config, benchmark);

      // 节省传输：只返回最近 50 笔，曲线降采样到 200 点
      const recentTrades = result.trades.slice(-50);
      const maxCurvePoints = 200;
      const curve = result.equityCurve;
      const sampledCurve = curve.length > maxCurvePoints
        ? curve.filter((_, idx) => idx % Math.ceil(curve.length / maxCurvePoints) === 0)
        : curve;

      return {
        marketCode: code,
        metrics: result.metrics,
        trades: recentTrades,
        equityCurve: sampledCurve,
      };
    }).filter(Boolean);

    return c.json({
      success: true,
      strategy,
      marketTiming: useMarketTiming ? { regime: marketRegime, maxPosition } : null,
      results,
    });
  } catch (e: any) {
    console.error('[Backtest] Error:', e.message);
    return c.json({ error: e.message || 'Internal error' }, 500);
  }
});

export default app;
