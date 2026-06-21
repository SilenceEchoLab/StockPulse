import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { stocks as stocksSchema, klineDaily, klineMin, dailySnapshot, settings } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { fetchWithRetry } from '../lib/tencent.js';
import { calculateIndicators } from '../lib/indicators.js';
import { syncProcess, addLog } from '../lib/state.js';

const app = new Hono();

// 同步单只股票：日K（含技术指标）+ m30/m60 分钟K，均为增量写入
async function syncOneStock(code: string, db: any) {
  // 日K线
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,250,qfq`;
  const resJson: any = await fetchWithRetry(url);
  if (resJson.code !== 0) throw new Error(resJson.msg || 'Unknown API Error');

  const dataObj = resJson.data[code];
  const klineKey = dataObj['qfqday'] ? 'qfqday' : 'day';
  const kData = dataObj[klineKey];
  if (!kData || !Array.isArray(kData) || kData.length === 0) {
    throw new Error('No K-line data found in response');
  }

  db.insert(stocksSchema).values({
    marketCode: code,
    name: code,
    lastSyncTime: new Date()
  }).onConflictDoUpdate({
    target: stocksSchema.marketCode,
    set: { lastSyncTime: new Date() }
  }).run();

  const closePrices: number[] = [];
  const highPrices: number[] = [];
  const lowPrices: number[] = [];
  const parsedRows: any[] = [];

  for (const row of kData) {
    const date = row[0];
    const open = parseFloat(row[1]);
    const close = parseFloat(row[2]);
    const high = parseFloat(row[3]);
    const low = parseFloat(row[4]);
    const volume = parseFloat(row[5]);
    closePrices.push(close);
    highPrices.push(high);
    lowPrices.push(low);
    parsedRows.push({ marketCode: code, date, open, close, high, low, volume });
  }

  const { pMacd, pRsi, pBb, pKdj, pMa, pBias } = calculateIndicators(closePrices, highPrices, lowPrices);

  const dbRecords = parsedRows.map((r, i) => {
    const j = (pKdj[i] && pKdj[i].k !== null) ? 3 * pKdj[i].k - 2 * pKdj[i].d : null;
    const safeNum = (val: any) => (typeof val === 'number' && isFinite(val)) ? val : null;
    return {
      ...r,
      macd: safeNum(pMacd[i]?.MACD),
      macdSignal: safeNum(pMacd[i]?.signal),
      macdHist: safeNum(pMacd[i]?.histogram),
      rsi14: safeNum(pRsi[i]),
      bollMid: safeNum(pBb[i]?.middle),
      bollUpper: safeNum(pBb[i]?.upper),
      bollLower: safeNum(pBb[i]?.lower),
      kdjK: safeNum(pKdj[i]?.k),
      kdjD: safeNum(pKdj[i]?.d),
      kdjJ: safeNum(j),
      ma5: safeNum(pMa.ma5[i]),
      ma10: safeNum(pMa.ma10[i]),
      ma20: safeNum(pMa.ma20[i]),
      ma60: safeNum(pMa.ma60[i]),
      ma120: safeNum(pMa.ma120[i]),
      ma250: safeNum(pMa.ma250[i]),
      bias6: safeNum(pBias.bias6[i]),
      bias12: safeNum(pBias.bias12[i]),
      bias24: safeNum(pBias.bias24[i]),
    };
  });

  // 增量同步：仅保留 >= 最新日期的记录，并删除当日以便用新数据覆盖
  // 注意：若当日停牌无数据，不删除已有记录，避免丢数据（E1 修复）
  const latestDaily = await db.select({ date: klineDaily.date })
    .from(klineDaily)
    .where(eq(klineDaily.marketCode, code))
    .orderBy(desc(klineDaily.date))
    .limit(1).get();
  const maxDate = latestDaily ? latestDaily.date : null;

  let recordsToInsert = dbRecords;
  if (maxDate) {
    // 只删除确认在新数据中存在的日期行，避免停牌时删掉唯一记录
    const hasMaxDateData = dbRecords.some(r => r.date === maxDate);
    recordsToInsert = dbRecords.filter(r => r.date >= maxDate);
    if (hasMaxDateData) {
      await db.delete(klineDaily).where(and(eq(klineDaily.marketCode, code), eq(klineDaily.date, maxDate))).run();
    }
  } else {
    await db.delete(klineDaily).where(eq(klineDaily.marketCode, code)).run();
  }
  const chunkSize = 500;
  for (let s = 0; s < recordsToInsert.length; s += chunkSize) {
    await db.insert(klineDaily).values(recordsToInsert.slice(s, s + chunkSize)).run();
  }

  addLog('SUCCESS', 'DATABASE_WRITE:', `Synced ${parsedRows.length} rows for ${code}`);

  // 分钟K（m30/m60），失败不阻断整体流程
  for (const period of ['m30', 'm60']) {
    try {
      const minUrl = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,,2000`;
      const minData = await fetchWithRetry(minUrl);
      if (minData && minData.code === 0 && minData.data[code] && Array.isArray(minData.data[code][period]) && minData.data[code][period].length > 0) {
        const mData = minData.data[code][period];
        const mRecords = mData.map((row: any[]) => ({
          marketCode: code,
          period,
          time: String(row[0]),
          open: parseFloat(row[1]),
          close: parseFloat(row[2]),
          high: parseFloat(row[3]),
          low: parseFloat(row[4]),
          volume: parseFloat(row[5])
        }));

        const latestMin = await db.select({ time: klineMin.time })
          .from(klineMin)
          .where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period)))
          .orderBy(desc(klineMin.time))
          .limit(1).get();
        const maxTime = latestMin ? latestMin.time : null;

        let minToInsert = mRecords;
        if (maxTime) {
          minToInsert = mRecords.filter((r: any) => r.time >= maxTime);
          await db.delete(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period), eq(klineMin.time, maxTime))).run();
        } else {
          await db.delete(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period))).run();
        }
        const minChunkSize = 500;
        for (let s = 0; s < minToInsert.length; s += minChunkSize) {
          await db.insert(klineMin).values(minToInsert.slice(s, s + minChunkSize)).run();
        }
        addLog('SUCCESS', `${period.toUpperCase()}_DB:`, `Synced ${mRecords.length} rows for ${code}`);
      }
    } catch {
      // 分钟线拉取失败忽略，不影响日K同步结果
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function runScraper(codes: string[], c: any, options: { concurrency?: number, mode?: string } = {}) {
  if (syncProcess.status === 'syncing') return;

  Object.assign(syncProcess, {
    status: 'syncing',
    total: codes.length,
    current: 0,
    progress: 0,
    logs: [],
    totalRequests: 0,
    errorCount: 0,
    diskUsageBytes: 0,
    startTime: new Date(),
  });

  const concurrency = Math.max(1, Math.min(10, options.concurrency || 1));
  const mode = options.mode || 'incremental';
  addLog('INFO', 'INIT_MARKET_MONITOR:', `Starting ${mode} sync for ${codes.length} stocks. Concurrency: ${concurrency}`);

  // 后台异步执行：Cloudflare Workers 下可能被中断，本地 dev 下可正常完成
  return (async () => {
    try {
      const db = getDb(c);
      let cursor = 0;

      // 并发 worker 池：多 worker 共享 cursor 直到所有标的处理完毕
      const worker = async () => {
        while (syncProcess.status === 'syncing') {
          const idx = cursor++;
          if (idx >= codes.length) break;
          const code = codes[idx];

          syncProcess.current++;
          syncProcess.progress = (syncProcess.current / syncProcess.total) * 100;
          syncProcess.totalRequests++;

          try {
            await syncOneStock(code, db);
          } catch (err: any) {
            syncProcess.errorCount++;
            addLog('ERROR', 'API_ERROR:', `Failed for ${code} - ${err.message || err.toString()}`);
          }

          // 随机延迟，降低被限流风险
          const delay = Math.floor(Math.random() * 2000) + 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      syncProcess.status = 'completed';
      addLog('SUCCESS', 'PROCESS_COMPLETE:', `All ${syncProcess.total} stocks processed.`);
    } catch (e: any) {
      syncProcess.status = 'error';
      addLog('ERROR', 'FATAL:', e.message);
    }
  })();
}

app.post('/start', async (c) => {
  const body = (await c.req.json()) as any;
  const codes = body.codes;
  if (!Array.isArray(codes) || codes.length === 0) {
    return c.json({ error: 'Array of stock codes required.' }, 400);
  }
  // C3/B9 修复：校验代码格式与数量上限
  const CODE_REGEX = /^(sh|sz|bj)\d{6}$/;
  const validCodes = codes.filter((code: string) => CODE_REGEX.test(code));
  if (validCodes.length === 0) {
    return c.json({ error: 'No valid stock codes provided' }, 400);
  }
  if (validCodes.length > 1000) {
    return c.json({ error: 'Too many codes (max 1000)' }, 400);
  }
  if (syncProcess.status === 'syncing') {
    return c.json({ success: false, message: 'Sync already in progress.' });
  }

  const promise = runScraper(validCodes, c, body.options || {});
  if (c.executionCtx && c.executionCtx.waitUntil) {
    c.executionCtx.waitUntil(promise);
  }

  return c.json({ success: true, message: 'Sync started.' });
});

app.get('/overview', async (c) => {
  try {
    const { sql } = await import('drizzle-orm');
    const db = getDb(c);
    // 显式别名 + Number 转换，避免 libsql 驱动返回字符串/BigInt 导致计数丢失
    const stocksRow = await db.select({ count: sql`count(*) as count` }).from(stocksSchema).get();
    const snapshotRow = await db.select({ count: sql`count(*) as count` }).from(dailySnapshot).get();
    const settingsRow = await db.select({ count: sql`count(*) as count` }).from(settings).get();
    return c.json({
      success: true,
      data: {
        stocks: stocksRow ? Number(stocksRow.count) : 0,
        snapshots: snapshotRow ? Number(snapshotRow.count) : 0,
        settings: settingsRow ? Number(settingsRow.count) : 0,
        csvCount: 0,
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.post('/clean-cache', async (c) => {
  return c.json({ success: true, message: '缓存清理成功' });
});

app.get('/status', async (c) => {
  return c.json({
    status: syncProcess.status,
    progress: syncProcess.progress,
    current: syncProcess.current,
    total: syncProcess.total,
    logs: syncProcess.logs,
    totalRequests: syncProcess.totalRequests,
    errorCount: syncProcess.errorCount,
    diskUsageBytes: 0
  });
});

app.get('/export', async (c) => {
  return c.text('Export is not supported in Serverless environment', 400);
});

export default app;
