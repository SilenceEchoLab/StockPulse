import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { klineDaily, klineMin } from '../db/schema.js';
import { eq, and, asc, desc } from 'drizzle-orm';
import { calculateIndicators } from '../lib/indicators.js';
import { fetchWithRetry, getTencentStockData } from '../lib/tencent.js';

const app = new Hono();

app.get('/:code/daily', async (c) => {
  try {
    const records = await getDb(c).select().from(klineDaily)
      .where(eq(klineDaily.marketCode, c.req.param('code')))
      .orderBy(desc(klineDaily.date))
      .all();
    return c.json({ success: true, data: records.reverse() });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.get('/:code', async (c) => {
  const code = c.req.param('code');
  const period = c.req.query('period') || 'day';

  try {
    let dbData = [];
    if (period === 'day') {
      dbData = await getDb(c).select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all();
    } else if (period === 'm30' || period === 'm60') {
      dbData = await getDb(c).select().from(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period as string))).orderBy(asc(klineMin.time)).all();
    }

    let parsedData: any[] = [];
    let isDailyFromDb = false;

    if (period === 'day' && dbData.length > 0) {
       parsedData = dbData;
       isDailyFromDb = true;
    } else if ((period === 'm30' || period === 'm60') && dbData.length > 0) {
       parsedData = dbData.map(d => ({
          date: d.time.length === 12 ? `${d.time.substring(0,4)}-${d.time.substring(4,6)}-${d.time.substring(6,8)} ${d.time.substring(8,10)}:${d.time.substring(10,12)}` : d.time,
          open: d.open,
          close: d.close,
          high: d.high,
          low: d.low,
          volume: d.volume
       }));
    } else {
      let url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,250,qfq`;
      const isMinPeriod = ['m1', 'm5', 'm15', 'm30', 'm60'].includes(period as string);
      if (isMinPeriod) {
        url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,250`;
      } else if (period === 'time') {
        url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m1,,250`;
      }
      
      const resJson: any = await fetchWithRetry(url);
      if (resJson.code !== 0) throw new Error(resJson.msg || "Unknown API error");
      
      const dataObj = resJson.data[code];
      const actualPeriod = period === 'time' ? 'm1' : period;
      const klineKey = dataObj[`qfq${actualPeriod}`] ? `qfq${actualPeriod}` : actualPeriod;
      const kData = dataObj[klineKey as string] || [];
      
      parsedData = kData.map((item: any[]) => {
        let dateStr = item[0];
        if (dateStr.length === 12) {
          dateStr = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)} ${dateStr.substring(8,10)}:${dateStr.substring(10,12)}`;
        }
        return {
          date: dateStr,
          open: parseFloat(item[1]),
          close: parseFloat(item[2]),
          high: parseFloat(item[3]),
          low: parseFloat(item[4]),
          volume: parseFloat(item[5])
        };
      });
    }

    if (period === 'day' && isDailyFromDb) {
      try {
        const todayQuotes = await getTencentStockData([code]);
        if (todayQuotes && todayQuotes.length > 0) {
          const tq = todayQuotes[0];
          let tDateStr = new Date().toISOString().slice(0, 10);
          if (tq.updateTime && tq.updateTime.length >= 8) {
             tDateStr = `${tq.updateTime.substring(0,4)}-${tq.updateTime.substring(4,6)}-${tq.updateTime.substring(6,8)}`;
          }
          const todayCandle = {
            date: tDateStr, open: tq.open, close: tq.price, high: tq.high, low: tq.low, volume: tq.volume
          };
          if (parsedData.length > 0) {
            const lastData = parsedData[parsedData.length - 1];
            if (lastData.date === tDateStr) {
               parsedData[parsedData.length - 1] = { ...lastData, ...todayCandle };
            } else {
               parsedData.push(todayCandle);
            }
          } else {
            parsedData.push(todayCandle);
          }
        }
      } catch(e) {
        console.error("Failed to append realtime daily candle", e);
      }
    }

    const closePrices = parsedData.map((d: any) => d.close);
    const highPrices = parsedData.map((d: any) => d.high);
    const lowPrices = parsedData.map((d: any) => d.low);
    const volumePrices = parsedData.map((d: any) => d.volume ?? 0);

    const { pMacd, pRsi, pBb, pKdj, pMa, pBias, pAtr, pObv, pVolMa5, pVolRatio } =
      calculateIndicators(closePrices, highPrices, lowPrices, volumePrices);

    const finalData = parsedData.map((r: any, i: number) => {
      const j = (pKdj[i] && pKdj[i].k !== null) ? 3 * pKdj[i].k - 2 * pKdj[i].d : null;
      return {
        ...r,
        macd: pMacd[i]?.MACD ?? null,
        macdSignal: pMacd[i]?.signal ?? null,
        macdHist: pMacd[i]?.histogram ?? null,
        rsi14: pRsi[i] ?? null,
        bollMid: pBb[i]?.middle ?? null,
        bollUpper: pBb[i]?.upper ?? null,
        bollLower: pBb[i]?.lower ?? null,
        kdjK: pKdj[i]?.k ?? null,
        kdjD: pKdj[i]?.d ?? null,
        kdjJ: j,
        ma5: pMa.ma5[i] ?? null,
        ma10: pMa.ma10[i] ?? null,
        ma20: pMa.ma20[i] ?? null,
        ma60: pMa.ma60[i] ?? null,
        ma120: pMa.ma120[i] ?? null,
        ma250: pMa.ma250[i] ?? null,
        bias6: pBias.bias6[i] ?? null,
        bias12: pBias.bias12[i] ?? null,
        bias24: pBias.bias24[i] ?? null,
        atr14: pAtr[i] ?? null,
        obv: pObv[i] ?? null,
        volMa5: pVolMa5[i] ?? null,
        volRatio: pVolRatio[i] ?? null,
      };
    });

    return c.json({ success: true, data: finalData });
  } catch (e: any) {
    console.error(e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default app;
