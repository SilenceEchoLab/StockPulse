import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { stocks as stocksSchema, alerts, klineDaily } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { getTencentStockData } from '../lib/tencent.js';
import { assessMarketTiming } from '../lib/marketTiming.js';
import { getPolicy } from '../lib/policy.js';

const app = new Hono();

// 主要市场指数（腾讯行情接口支持指数代码）
const INDICES = [
  { code: 'sh000300', label: '沪深300' },
  { code: 'sh000001', label: '上证指数' },
  { code: 'sz399001', label: '深证成指' },
  { code: 'sz399006', label: '创业板指' },
];

// 投资大盘综合门户聚合接口：指数 / 涨跌宽度 / 行业热度 / 涨跌幅排行 / 活跃告警
app.get('/overview', async (c) => {
  try {
    const db = getDb(c);

    // 股票池元数据
    const pool = await db.select().from(stocksSchema).all();
    const poolCodes = pool.map((s: any) => s.marketCode);
    const metaMap: Record<string, any> = {};
    for (const s of pool) metaMap[s.marketCode] = s;

    // 一次性拉取指数 + 股票池行情（getTencentStockData 内部已分块 + 缓存）
    const indexCodes = INDICES.map((i) => i.code);
    const quotes = await getTencentStockData([...indexCodes, ...poolCodes]);
    const quoteMap: Record<string, any> = {};
    for (const q of quotes) quoteMap[q.marketCode] = q;

    // 指数行情
    const indices = INDICES.map((idx) => {
      const q = quoteMap[idx.code];
      if (!q) return null;
      return {
        marketCode: idx.code,
        name: idx.label,
        price: q.price,
        changeAmount: q.changeAmount,
        changePercentage: q.changePercentage,
        volume: q.volume,
        turnover: q.turnover,
      };
    }).filter(Boolean);

    // 仅股票池参与涨跌统计
    const poolQuotes = poolCodes.map((code) => quoteMap[code]).filter(Boolean);

    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
    for (const q of poolQuotes) {
      const pct = q.changePercentage;
      // 涨停判断：科创板/创业板 20%，其余 10%（保守取 9.8 阈值避免四舍五入误差）
      const isKcb = q.marketCode.startsWith('sh688') || q.marketCode.startsWith('sz30');
      const limitThreshold = isKcb ? 19.8 : 9.8;
      if (pct > 0.01) up++;
      else if (pct < -0.01) down++;
      else flat++;
      if (pct >= limitThreshold) limitUp++;
      if (pct <= -limitThreshold) limitDown++;
    }

    // 行业热度聚合
    const industryAgg: Record<string, { changes: number[]; count: number }> = {};
    for (const q of poolQuotes) {
      const ind = metaMap[q.marketCode]?.industry || '其他';
      if (!industryAgg[ind]) industryAgg[ind] = { changes: [], count: 0 };
      industryAgg[ind].changes.push(q.changePercentage);
      industryAgg[ind].count++;
    }
    const industries = Object.entries(industryAgg).map(([name, v]) => ({
      name,
      count: v.count,
      avgChange: v.changes.reduce((a, b) => a + b, 0) / v.changes.length,
    })).sort((a, b) => b.avgChange - a.avgChange);

    // 涨跌幅排行
    const sorted = [...poolQuotes].sort((a, b) => b.changePercentage - a.changePercentage);
    const enrich = (q: any) => {
      const m = metaMap[q.marketCode];
      return {
        marketCode: q.marketCode,
        name: m?.name || q.name,
        price: q.price,
        changePercentage: q.changePercentage,
        turnoverRate: q.turnoverRate,
        industry: m?.industry || '',
      };
    };
    const topGainers = sorted.slice(0, 8).map(enrich);
    const topLosers = sorted.slice(-8).reverse().map(enrich);

    // 活跃告警（关联当前价与股票名，便于前端展示接近度）
    const activeAlertRows = await db.select().from(alerts).where(eq(alerts.isActive, true)).all();
    const activeAlerts = activeAlertRows.map((a: any) => {
      const q = quoteMap[a.marketCode];
      const m = metaMap[a.marketCode];
      const currentPrice = q?.price;
      return {
        id: a.id,
        marketCode: a.marketCode,
        name: m?.name || a.marketCode,
        type: a.type,
        threshold: a.threshold,
        currentPrice,
        // 距离触发阈值的方向（价格越接近阈值，接近度越高）
        distance: (typeof currentPrice === 'number')
          ? Math.abs(currentPrice - a.threshold) / (a.threshold || 1)
          : null,
      };
    }).sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));

    return c.json({
      success: true,
      data: {
        indices,
        breadth: { up, down, flat, limitUp, limitDown, total: poolQuotes.length },
        industries,
        topGainers,
        topLosers,
        activeAlerts,
        poolCount: poolCodes.length,
      },
    });
  } catch (e: any) {
    console.error('Market overview error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// 大盘择时：基于沪深300四指标共振判定牛/震/熊，映射仓位上限（手册第一步）
app.get('/timing', async (c) => {
  try {
    const db = getDb(c);
    const indexCode = (c.req.query('code') as string) || 'sh000300';
    const rows = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, indexCode))
      .orderBy(asc(klineDaily.date))
      .limit(300)
      .all();
    if (!rows.length) {
      return c.json({ success: false, error: '指数数据未同步，请先在同步页同步大盘指数' }, 400);
    }
    // regime→仓位上限读取策略护栏 policy（圆桌「用户可驭层」）；失败回退默认
    let policy: any = null;
    try { policy = await getPolicy(db); } catch { /* policy 表未就绪则用默认 */ }
    const timing = assessMarketTiming(rows as any[], indexCode, policy
      ? { bull: policy.regimeBullPos, range: policy.regimeRangePos, bear: policy.regimeBearPos }
      : undefined);
    return c.json({ success: true, data: timing });
  } catch (e: any) {
    console.error('Market timing error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default app;
