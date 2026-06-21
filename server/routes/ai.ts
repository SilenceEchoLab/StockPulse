import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { aiSentiment, klineDaily, dailySnapshot, stocks as stocksSchema } from '../db/schema.js';
import { eq, desc, isNotNull, gte, asc } from 'drizzle-orm';
import { getAiClient, getAiModel, getAiPrompt } from '../ai/index.js';
import { aiPicksCache } from '../lib/state.js';
import { scoreStock, scoreContrarian, detectSignals } from '../lib/signalEngine.js';

const app = new Hono();

const DEFAULT_SENTIMENT_PROMPT = `你是一位资深的量化金融分析师。请基于以下提供的个股近期 60 天 K线数据和技术指标，进行全面的情绪面与走势分析，并输出纯 JSON 格式。
JSON 必须严格遵守以下结构：
{
  "score": 数字(0-100，0为极度悲观，100为极度乐观),
  "label": "短文本(如：强烈看多 / 震荡整理 / 风险累积)",
  "summary": "一段约50字的精简中文分析总结",
  "signals": [
    { "type": "bullish" 或者 "bearish", "name": "中文信号名称(如：MACD金叉)", "confidence": 数字(0-1) }
  ]
}
要求：
1. 必须使用纯正的中文金融术语。
2. 不要包含任何 \`\`\`json 等 Markdown 标签，仅返回合法的 JSON 字符串。`;

const DEFAULT_PICKS_PROMPT = `你是一位资深的A股量化基金经理。请基于提供的股票池技术面综合评分(trendScore, scoreBreakdown, signals)和基本面(PE, PB)数据，执行多因子选股。
策略方向：{{strategy}}。
trendScore 是三周期共振引擎的综合评分(0-100)，scoreBreakdown 包含大周期趋势(trend)、中周期结构(structure)、量价配合(volumePrice)、入场时机(timing)四个维度得分。
你需要综合打分(0-100)，并严格选出最优的 {{count}} 只股票。
务必只返回合法的 JSON 格式，结构要求如下：
{
  "picks": [
    {
      "marketCode": "股票代码",
      "name": "股票名称",
      "score": 综合得分(数字),
      "reason": "15字以内的精简选股逻辑",
      "signals": [
        { "type": "bullish" | "bearish", "name": "信号名称", "confidence": 0.90 }
      ]
    }
  ]
}`;

export { DEFAULT_SENTIMENT_PROMPT, DEFAULT_PICKS_PROMPT };

app.get('/sentiment/:code', async (c) => {
  try {
    const code = c.req.param('code');
    const cached = await getDb(c).select().from(aiSentiment).where(eq(aiSentiment.marketCode, code)).get();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

    if (cached && new Date(cached.updatedAt) > fourHoursAgo) {
      return c.json({
        success: true,
        data: {
          score: cached.score,
          label: cached.label,
          summary: cached.summary,
          signals: JSON.parse(cached.signals),
          updatedAt: cached.updatedAt
        }
      });
    }

    const klineData = await getDb(c).select()
      .from(klineDaily)
      .where(eq(klineDaily.marketCode, code))
      .orderBy(desc(klineDaily.date))
      .limit(60)
      .all();

    if (!klineData || klineData.length === 0) {
      return c.json({ success: false, error: 'No kline data found for this stock' }, 404);
    }

    klineData.reverse();
    const dataContext = klineData.map(d => 
      `Date: ${d.date}, Close: ${d.close}, Vol: ${d.volume}, MACD: ${d.macd}, RSI: ${d.rsi14}`
    ).join('\n');

    let responseText = '{}';
    try {
      const aiClient = await getAiClient(c);
      const aiModel = await getAiModel(c);
      const customPrompt = await getAiPrompt('ai_sentiment_prompt', DEFAULT_SENTIMENT_PROMPT, c);
      
      const response = await aiClient.chat.completions.create({
         model: aiModel,
         response_format: { type: 'json_object' },
         messages: [
            { role: 'system', content: customPrompt },
            { role: 'user', content: `Data:\n${dataContext}` }
         ]
      });

      responseText = response.choices[0]?.message?.content || '{}';
    } catch (err: any) {
      if (err.message.includes('API Key is not configured')) {
         return c.json({ success: false, error: 'AI_NOT_CONFIGURED', message: 'Please configure your AI Provider in Settings.' }, 400);
      }
      throw err;
    }
    
    const parsed = JSON.parse(responseText);
    const db = getDb(c);
    await db.batch([
      db.delete(aiSentiment).where(eq(aiSentiment.marketCode, code)),
      db.insert(aiSentiment).values({
        marketCode: code,
        score: parsed.score,
        label: parsed.label,
        summary: parsed.summary,
        signals: JSON.stringify(parsed.signals),
        updatedAt: new Date()
      })
    ]);

    return c.json({ success: true, data: { ...parsed, updatedAt: new Date() } });

  } catch (e: any) {
    console.error('AI Sentiment Error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.post('/picks', async (c) => {
  try {
    const { strategy, count = 5, forceRefresh = false } = (await c.req.json()) as any;
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `${strategy}_${today}`;
    
    if (!forceRefresh) {
      if (aiPicksCache.has(cacheKey)) {
        return c.json({ success: true, cached: true, ...aiPicksCache.get(cacheKey) });
      } else {
        return c.json({ success: true, needsGeneration: true });
      }
    }

    // 获取最近交易日的全部K线（含均线与技术指标），按个股分组供打分引擎使用
    const db = getDb(c);
    const latestRow = await db.select({ date: klineDaily.date })
      .from(klineDaily).orderBy(desc(klineDaily.date)).limit(1).get();
    if (!latestRow) {
      return c.json({ success: false, error: 'No kline data available' }, 400);
    }
    const cutoff = new Date(latestRow.date);
    cutoff.setDate(cutoff.getDate() - 120);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const allKlines = await db.select().from(klineDaily)
      .where(gte(klineDaily.date, cutoffDate))
      .orderBy(asc(klineDaily.date))
      .all();

    const snapshotData = await db.select().from(dailySnapshot).all();
    const snapshotMap = snapshotData.reduce((acc: any, curr) => {
      acc[curr.marketCode] = curr;
      return acc;
    }, {});

    const dataByCode = new Map<string, any[]>();
    for (const row of allKlines) {
      if (!dataByCode.has(row.marketCode)) dataByCode.set(row.marketCode, []);
      const arr = dataByCode.get(row.marketCode)!;
      arr.push({
        ...row,
        turnoverRate: snapshotMap[row.marketCode]?.turnoverRate ?? null,
      });
    }

    // 三周期共振打分引擎对每只股票评分
    let scored: any[] = [];
    for (const [code, rows] of dataByCode) {
      if (rows.length < 10) continue;
      const snap = snapshotMap[code];
      let result;
      if (strategy === 'contrarian') {
        result = scoreContrarian(rows);
      } else {
        result = scoreStock(rows);
      }
      scored.push({
        marketCode: code,
        close: rows[rows.length - 1].close,
        scoreResult: result,
        pe: snap?.peRatio,
        pb: snap?.pbRatio,
      });
    }

    // 策略筛选与排序
    if (strategy === 'value') {
      scored = scored.filter(s => s.pe && s.pe > 0);
      // 价值策略：趋势打分作为安全过滤器，PE 从低到高
      scored.sort((a, b) => (a.pe || 0) - (b.pe || 0));
    } else {
      // momentum / contrarian：按引擎综合评分降序
      scored.sort((a, b) => b.scoreResult.score - a.scoreResult.score);
    }
    const candidates = scored.slice(0, 30);

    const stockMeta = await db.select().from(stocksSchema).all();
    const metaMap = stockMeta.reduce((acc, curr) => {
      acc[curr.marketCode] = curr;
      return acc;
    }, {} as any);

    const promptData = candidates.map(s => ({
      code: s.marketCode,
      name: metaMap[s.marketCode]?.name || s.marketCode,
      price: s.close?.toFixed(2),
      trendScore: s.scoreResult.score,
      scoreBreakdown: s.scoreResult.breakdown,
      signals: s.scoreResult.signals.map((sig: any) => `${sig.name}(${(sig.confidence * 100).toFixed(0)}%)`),
      pe: s.pe?.toFixed(2) || 'N/A',
      pb: s.pb?.toFixed(2) || 'N/A',
    }));

    const rawPrompt = await getAiPrompt('ai_picks_prompt', DEFAULT_PICKS_PROMPT, c);
    const strategyName = strategy === 'momentum' ? '动量突破' : strategy === 'contrarian' ? '逆向反转' : '价值回归';
    const systemPrompt = rawPrompt.replace(/{{strategy}}/g, strategyName).replace(/{{count}}/g, String(count));

    let responseText = '{}';
    try {
      const aiClient = await getAiClient(c);
      const aiModel = await getAiModel(c);
      
      const response = await aiClient.chat.completions.create({
         model: aiModel,
         response_format: { type: 'json_object' },
         messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Data:\n${JSON.stringify(promptData)}` }
         ]
      });

      responseText = response.choices[0]?.message?.content || '{}';
    } catch (err: any) {
      if (err.message.includes('API Key is not configured')) {
         return c.json({ success: false, error: 'AI_NOT_CONFIGURED', message: 'Please configure your AI Provider in Settings.' }, 400);
      }
      
      const picks = candidates.slice(0, count).map(item => ({
        marketCode: item.marketCode,
        name: metaMap[item.marketCode]?.name || item.marketCode,
        score: item.scoreResult.score,
        reason: item.scoreResult.signals[0]?.name || '多因子共振',
        signals: item.scoreResult.signals,
      }));
      return c.json({ success: true, generatedAt: new Date(), picks });
    }
    
    const parsed = JSON.parse(responseText);
    // 将引擎评分明细合并到 AI 返回结果中，供前端展示评分维度
    const scoredMap = new Map(scored.map(s => [s.marketCode, s]));
    const picks = (parsed.picks || []).map((p: any) => {
      const sc = scoredMap.get(p.marketCode);
      return {
        ...p,
        trendScore: sc?.scoreResult.score ?? null,
        scoreBreakdown: sc?.scoreResult.breakdown ?? null,
      };
    });
    const resultData = { generatedAt: new Date(), picks };
    aiPicksCache.set(cacheKey, resultData);
    return c.json({ success: true, cached: false, ...resultData });

  } catch (e: any) {
    console.error('AI Picks Error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// 量化买卖信号检测 —— 基于《选股交易操作手册》的完整买卖点/风险信号引擎
// 无需 AI Key，纯本地计算，毫秒级响应
app.get('/signals/:code', async (c) => {
  try {
    const code = c.req.param('code');
    const db = getDb(c);

    const klineData = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, code))
      .orderBy(asc(klineDaily.date))
      .limit(120)
      .all();

    if (!klineData || klineData.length === 0) {
      return c.json({ success: false, error: 'No kline data found for this stock' }, 404);
    }

    // 关联快照中的换手率
    const snapshot = await db.select().from(dailySnapshot)
      .where(eq(dailySnapshot.marketCode, code))
      .orderBy(desc(dailySnapshot.date))
      .limit(1).get();

    const rows = klineData.map((r: any) => ({
      ...r,
      turnoverRate: snapshot?.turnoverRate ?? null,
    }));

    const report = detectSignals(rows);
    return c.json({ success: true, data: report });
  } catch (e: any) {
    console.error('Signal detection error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default app;
