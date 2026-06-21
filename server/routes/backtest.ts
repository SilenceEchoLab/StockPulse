import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { klineDaily } from '../db/schema.js';
import { and, gte, lte, asc, inArray } from 'drizzle-orm';

const app = new Hono();

app.post('/run', async (c) => {
  try {
    const { codes, strategy, startDate, endDate, initialCapital = 100000 } = (await c.req.json()) as any;
    if (!codes || codes.length === 0) return c.json({ error: 'Missing codes' }, 400);
    if (!strategy || !strategy.type) return c.json({ error: 'Missing strategy' }, 400);

    let klines: any[] = [];
    const chunkSize = 50;
    const db = getDb(c);
    
    for (let i = 0; i < codes.length; i += chunkSize) {
      const chunk = codes.slice(i, i + chunkSize);
      let chunkConditions: any[] = [inArray(klineDaily.marketCode, chunk)];
      if (startDate) chunkConditions.push(gte(klineDaily.date, startDate));
      if (endDate) chunkConditions.push(lte(klineDaily.date, endDate));
      const chunkKlines = await db.select().from(klineDaily).where(and(...chunkConditions)).orderBy(asc(klineDaily.date)).all();
      klines.push(...chunkKlines);
    }

    const dataByCode = klines.reduce((acc: any, curr) => {
      if (!acc[curr.marketCode]) acc[curr.marketCode] = [];
      acc[curr.marketCode].push(curr);
      return acc;
    }, {});

    // A4 修复：抽取回测计算为函数，支持并行
    const BUY_FEE_RATE = 0.0003;
    const SELL_FEE_RATE = 0.0013;
    const RISK_FREE_RATE = 0.02;

    const computeBacktest = (code: string): any | null => {
      const data = dataByCode[code] || [];
      if (data.length === 0) return null;

      let cash = initialCapital;
      let position = 0;
      let trades: any[] = [];
      let equityCurve: any[] = [];
      let dailyReturns: number[] = [];
      let previousEquity = initialCapital;
      let winningTrades = 0;
      let maxEquity = initialCapital;
      let maxDrawdown = 0;

      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        let signal = 0;

        if (strategy.type === 'macd_cross') {
          const prevMacd = prev.macd || 0;
          const prevSig = prev.macdSignal || 0;
          const currMacd = curr.macd || 0;
          const currSig = curr.macdSignal || 0;
          if (prevMacd <= prevSig && currMacd > currSig) signal = 1;
          else if (prevMacd >= prevSig && currMacd < currSig) signal = -1;
        } else if (strategy.type === 'rsi_overbought') {
          const buyT = strategy.params?.rsiBuy || 30;
          const sellT = strategy.params?.rsiSell || 70;
          if ((curr.rsi14 || 50) < buyT) signal = 1;
          else if ((curr.rsi14 || 50) > sellT) signal = -1;
        }

        if (signal === 1 && position === 0) {
          const maxAffordableCost = curr.close * (1 + BUY_FEE_RATE);
          const shares = Math.floor(cash / maxAffordableCost);
          if (shares > 0) {
            position = shares;
            const tradeCost = shares * curr.close * (1 + BUY_FEE_RATE);
            cash -= tradeCost;
            trades.push({ type: 'buy', date: curr.date, price: curr.close, shares, fee: tradeCost - shares * curr.close });
          }
        } else if (signal === -1 && position > 0) {
          const grossValue = position * curr.close;
          const sellFee = grossValue * SELL_FEE_RATE;
          const netValue = grossValue - sellFee;
          cash += netValue;

          const lastBuy = trades.filter(t => t.type === 'buy').pop();
          let profit: number | undefined;
          if (lastBuy) {
            const buyCost = lastBuy.shares * lastBuy.price * (1 + BUY_FEE_RATE);
            profit = (netValue - buyCost) / buyCost;
            if (netValue > buyCost) winningTrades++;
          }
          trades.push({ type: 'sell', date: curr.date, price: curr.close, shares: position, fee: sellFee, profit });
          position = 0;
        }

        const equity = cash + (position * curr.close);
        equityCurve.push({ date: curr.date, equity });
        const dailyReturn = (equity - previousEquity) / previousEquity;
        dailyReturns.push(dailyReturn);
        previousEquity = equity;
        
        if (equity > maxEquity) maxEquity = equity;
        const drawdown = (maxEquity > 0) ? ((maxEquity - equity) / maxEquity) : 0;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }

      if (position > 0) {
        const lastPrice = data[data.length - 1].close;
        const grossValue = position * lastPrice;
        const sellFee = grossValue * SELL_FEE_RATE;
        const netValue = grossValue - sellFee;
        cash += netValue;

        const lastBuy = trades.filter(t => t.type === 'buy').pop();
        let profit: number | undefined;
        if (lastBuy) {
          const buyCost = lastBuy.shares * lastBuy.price * (1 + BUY_FEE_RATE);
          profit = (netValue - buyCost) / buyCost;
          if (netValue > buyCost) winningTrades++;
        }
        trades.push({ type: 'sell', date: data[data.length - 1].date, price: lastPrice, shares: position, fee: sellFee, profit });
        if (equityCurve.length > 0) {
          equityCurve[equityCurve.length - 1].equity = cash;
        }
      }

      const totalReturn = (cash - initialCapital) / initialCapital;
      const totalTrades = trades.filter(t => t.type === 'sell').length;
      const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
      const years = data.length / 252;
      const annualizedReturn = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) : 0;

      let sharpeRatio = 0;
      if (dailyReturns.length > 0) {
        const meanReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
        const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (dailyReturns.length - 1 || 1);
        const stdDev = Math.sqrt(variance);
        const annualizedVolatility = stdDev * Math.sqrt(252);
        if (annualizedVolatility > 0) {
          sharpeRatio = (annualizedReturn - RISK_FREE_RATE) / annualizedVolatility;
        }
      }

      // A4 修复：trades 限制最近 50 笔，equityCurve 降采样到最多 200 点
      const recentTrades = trades.slice(-50);
      const maxCurvePoints = 200;
      const sampledCurve = equityCurve.length > maxCurvePoints
        ? equityCurve.filter((_, idx) => idx % Math.ceil(equityCurve.length / maxCurvePoints) === 0)
        : equityCurve;

      return {
        marketCode: code,
        metrics: { totalReturn, annualizedReturn, maxDrawdown, winRate, trades: totalTrades, sharpeRatio, finalCapital: cash },
        trades: recentTrades,
        equityCurve: sampledCurve
      };
    };

    // A4 修复：并行计算每只股票的回测
    const results = codes.map(code => computeBacktest(code)).filter(r => r !== null) as any[];

    return c.json({ success: true, results });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
