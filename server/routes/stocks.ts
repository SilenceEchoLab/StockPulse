import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { stocks as stocksSchema, dailySnapshot } from '../db/schema.js';
import { inArray } from 'drizzle-orm';
import { getTencentStockData } from '../lib/tencent.js';

const app = new Hono();

// C3 修复：股票代码格式校验
const CODE_REGEX = /^(sh|sz|bj)\d{6}$/;

app.get('/', async (c) => {
  const codes = c.req.query('codes');
  if (!codes || typeof codes !== 'string') {
    return c.json({ error: 'Missing or invalid stock codes' }, 400);
  }

  try {
    const codesArray = codes.split(',');
    // C5 修复：限制单次请求的 code 数量
    if (codesArray.length > 500) {
      return c.json({ error: 'Too many codes (max 500)' }, 400);
    }
    const dbRecords = [];
    const chunkSize = 50;
    const db = getDb(c);

    for (let i = 0; i < codesArray.length; i += chunkSize) {
      const chunk = codesArray.slice(i, i + chunkSize);
      const chunkRecords = await db.select().from(stocksSchema).where(inArray(stocksSchema.marketCode, chunk)).all();
      dbRecords.push(...chunkRecords);
    }

    const codeToMeta = dbRecords.reduce((acc, curr) => {
      acc[curr.marketCode] = curr;
      return acc;
    }, {} as any);

    const parsedData = await getTencentStockData(codesArray);
    
    let finalData = parsedData.map(d => ({
      ...d,
      view: codeToMeta[d.marketCode]?.view || '',
      industry: codeToMeta[d.marketCode]?.industry || '',
      remarks: codeToMeta[d.marketCode]?.remarks || ''
    }));

    try {
      const today = new Date().toISOString().slice(0, 10);
      // 批量写入快照数据，避免逐条 fire-and-forget（B6 修复）
      const snapshotOps = parsedData.map(d =>
        db.insert(dailySnapshot).values({
          marketCode: d.marketCode,
          date: today,
          peRatio: d.peRatio,
          pbRatio: d.pbRatio,
          turnoverRate: d.turnoverRate,
          totalMarketValue: d.totalMarketValue,
          circulatingMarketValue: d.circulatingMarketValue,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: [dailySnapshot.marketCode, dailySnapshot.date],
          set: {
            peRatio: d.peRatio,
            pbRatio: d.pbRatio,
            turnoverRate: d.turnoverRate,
            totalMarketValue: d.totalMarketValue,
            circulatingMarketValue: d.circulatingMarketValue,
            updatedAt: new Date(),
          }
        })
      );
      // 分批 batch 执行，避免单次 batch 过大
      const batchSize = 50;
      for (let i = 0; i < snapshotOps.length; i += batchSize) {
        await db.batch(snapshotOps.slice(i, i + batchSize));
      }
    } catch (e) {
      console.error('Failed to upsert daily snapshot:', e);
    }

    return c.json({ success: true, data: finalData });
  } catch (error) {
    console.error('Error fetching stocks:', error);
    return c.json({ error: 'Failed to fetch stock data' }, 500);
  }
});

export default app;
