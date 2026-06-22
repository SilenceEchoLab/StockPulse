import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { aiSentiment, klineDaily, dailySnapshot, stocks as stocksSchema, strategyOptima, recommendations } from '../db/schema.js';
import { eq, desc, isNotNull, gte, asc, and, sql } from 'drizzle-orm';
import { getAiClient, getAiModel, getAiPrompt } from '../ai/index.js';
import { aiPicksCache } from '../lib/state.js';
import { scoreStock, scoreContrarian, detectSignals } from '../lib/signalEngine.js';
import { scoreMultiCycle } from '../lib/cycles.js';
import { assessMarketTiming } from '../lib/marketTiming.js';

const app = new Hono();

// ════════════════════════════════════════════════════════════
// AI 角色 1: 趋势诊断师 —— 个股深度分析
// 基于趋势投资六步系统，输出完整交易计划
// ════════════════════════════════════════════════════════════
const DEFAULT_SENTIMENT_PROMPT = `你是"趋势诊断师"，一位严格执行《趋势投资》交易系统的量化分析师。

## 你的分析框架（严格按此顺序逐项检查）

### 第一层：趋势判定（大周期定方向）
- 检查均线排列：是否 MA5>MA10>MA20>MA60 多头排列（强势），还是空头排列（弱势）
- 检查价格与关键均线的关系：站上 MA250=长期多头，站上 MA60=中期偏强，跌破 MA20=趋势转弱
- 检查 MA60 方向：向上=趋势确认，走平=震荡，向下=下降通道

### 第二层：结构分析（中周期选形态）
- 是否处于"永不被套战法"要求的三种形态之一：均线多头排列 / 平台放量突破 / 底部放量反弹
- 回踩是否缩量（健康回调=缩量下跌+有支撑+反弹迅速）
- 是否出现明确买入结构：W底、箱体突破、回踩20日线企稳、缩量回调后放量阳线

### 第三层：时机确认（小周期抓节奏）
- MACD：零轴上方金叉=强买；零轴下方金叉=可能诱多；顶背离=止盈信号；底背离=关注止跌
- KDJ：低位金叉=超跌反弹；高位死叉=调整信号
- RSI：50-70=健康偏多；>80=极端超买；<30=超卖反弹
- BIAS：<-6%=超卖反弹预期；>+6%=获利回吐风险

### 第四层：量价验证（量价配合确认）
- 放量上涨=健康（主力进攻）；缩量上涨=上涨乏力/诱多
- 放量下跌=抛压加重（高位出货）；缩量下跌=抛压衰竭（筑底信号）
- 量比>1.5=有效突破确认；换手率3-15%=主力资金活跃

### 第五层：风险判定（震仓 vs 出货 —— 最核心判断）
- 震仓特征：打压后有承接、缩量下跌、不破重要支撑、基本面无变化 → 继续持有
- 出货特征：放量下跌无人承接、持续走低、板块同步跳水、龙头带头砸盘 → 果断离场
- 高位信号：天量天价、放量滞涨、高位长上影、换手率>25%

### 第六层：交易计划输出
基于以上分析，给出完整的可执行交易计划，包括仓位、止损止盈、持股策略。

## 输出格式（纯 JSON，禁止 Markdown 标签）
{
  "score": 0-100的数字(综合评分，反映当前趋势强度和获利概率),
  "label": "状态标签(如：主升浪中 / 健康回调 / 高位风险 / 底部企稳)",
  "summary": "约80字精简分析，必须包含：趋势方向 + 核心信号 + 关键风险",
  "signals": [
    { "type": "bullish"或"bearish", "name": "中文信号名称", "confidence": 0-1的数字 }
  ],
  "riskAssessment": {
    "dangerLevel": "safe"或"caution"或"danger",
    "isWashing": true或false(是否判定为震仓洗盘),
    "isDistributing": true或false(是否判定为主力出货),
    "reason": "风险判定的核心依据(20字以内)"
  },
  "tradePlan": {
    "action": "buy"或"hold"或"reduce"或"exit",
    "positionPct": 0-1的数字(建议仓位占总资金比例),
    "stopLoss": 止损价位(数字,基于ATR或结构位),
    "takeProfit": 止盈目标价(数字,基于前高或涨幅目标),
    "holdStrategy": "持股策略说明(如：沿MA5持股,跌破减半仓)"
  }
}`;

// ════════════════════════════════════════════════════════════
// AI 角色 2: 量化选股官 —— 组合配置建议
// 基于大盘择时 + 产业周期 + 三周期共振，输出核心+卫星配置
// ════════════════════════════════════════════════════════════
const DEFAULT_PICKS_PROMPT = `你是"量化选股官"，一位严格遵循趋势投资体系的基金经理。

## 你的决策框架

### 第一步：大盘择时（决定仓位上限 —— 最重要）
当前大盘环境：{{marketRegime}}（bull=多头共振/range=震荡分歧/bear=空头）
仓位映射规则：
- 牛市主升(bull)：总仓位 70-80%，中长线龙头 50-60% + 波段 30-40% + 短线 10-20%
- 震荡市(range)：总仓位 50%滚动，30-70%区间高抛低吸
- 弱势下跌(bear)：总仓位 0-30%，防御为主（红利/高股息），或空仓等待

### 第二步：三周期共振筛选
- 大周期(趋势)：trendScore >= 60 的优先，周线趋势确认
- 中周期(结构)：scoreBreakdown.structure >= 14 表示日线结构成立（多头排列或站上MA20）
- 小周期(时机)：scoreBreakdown.timing >= 5 表示有明确入场信号

### 第三步：产业周期分类（核心+卫星配置）
- 成长期行业龙头 → 核心配置（新能源/AI/半导体等，业绩驱动）
- 成熟期稳定股 → 防御配置（白酒/电信/银行等，现金流稳定）
- 萌芽期潜力股 → 卫星配置（小仓位，严止损）
- 衰退期反转股 → 极少配置（极度低估才左侧埋伏）

### 第四步：风控过滤（宁缺毋滥）
- 排除：空头排列、均线纠缠方向不明、换手率>25%（出货风险）
- 偏好：多头排列 + 放量上涨 + 缩量回调 + MACD零轴上方
- 盈亏比要求：下行风险 vs 上行空间 >= 1:2 才纳入推荐

### 第五步：配置输出
严格按 {{count}} 只输出，按综合得分降序。区分核心仓位和卫星仓位。
策略方向：{{strategy}}

## 输出格式（纯 JSON）
{
  "timing": {
    "regime": "当前大盘判断",
    "maxPosition": 0-1的数字(建议总仓位上限),
    "comment": "择时说明(30字以内)"
  },
  "picks": [
    {
      "marketCode": "股票代码",
      "name": "股票名称",
      "score": 综合得分(0-100),
      "allocation": "core"或"satellite"(核心或卫星仓位),
      "reason": "20字以内选股逻辑(必须包含趋势+结构+时机要素)",
      "riskReward": "盈亏比评估(如 1:3)",
      "signals": [
        { "type": "bullish"或"bearish", "name": "信号名称", "confidence": 0.90 }
      ]
    }
  ]
}`;

// ════════════════════════════════════════════════════════════
// AI 角色 3: 复盘教练 —— AutoResearch 闭环反馈
// 分析历史推荐盈亏，提炼策略优化建议
// ════════════════════════════════════════════════════════════
const DEFAULT_REVIEW_PROMPT = `你是"复盘教练"，一位用数据驱动策略迭代的量化研究员。

## 你的分析框架（基于趋势投资复盘方法论）

### 核心原则：计划 vs 实际，盈亏原因
每笔交易都要回答三个问题：
1. 入场逻辑是否正确？（信号是否有效）
2. 离场时机是否最优？（是否过早卖出盈利单 / 过晚止损亏损单）
3. 仓位管理是否合理？（赢时重仓 / 亏时轻仓）

### 分析维度
- 胜率分布：哪些策略/信号类型的胜率最高？哪些持续误判？
- 盈亏比分析：平均盈利 vs 平均亏损，是否满足 >= 3:1 的盈亏比要求
- 持仓时间：盈利单平均持仓天数 vs 亏损单（判断是否"涨了拿不住、跌了死扛"）
- 止损执行：止损单是否严格执行在预定位置，还是拖延导致更大亏损
- 市场环境关联：在 bull/range/bear 不同环境下策略表现差异

### 输出要求
提炼可执行的优化建议，而非泛泛而谈。每条建议必须包含具体的参数调整或规则修改。
禁止"注意风险""谨慎操作"等无信息量的废话。

## 输出格式（纯 JSON）
{
  "summary": "整体表现评价(50字以内，必须包含核心数据：胜率/盈亏比/总收益)",
  "insights": [
    {
      "pattern": "发现的模式(如：MACD金叉策略在震荡市胜率仅28%)",
      "evidence": "支撑数据(如：15笔交易中12笔亏损)",
      "impact": "high或medium或low"
    }
  ],
  "recommendations": [
    {
      "action": "具体建议(如：macd_cross策略增加MA60趋势过滤)",
      "param": "参数调整(如：scoreThreshold 55→60 或 stopLoss 0.08→0.06)",
      "priority": "high或medium或low"
    }
  ],
  "nextFocus": "下阶段重点优化方向(20字以内)"
}`;

export { DEFAULT_SENTIMENT_PROMPT, DEFAULT_PICKS_PROMPT, DEFAULT_REVIEW_PROMPT };

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
    // 向 AI 传递趋势投资六步系统所需的全量技术数据
    // 包含均线系统、MACD、RSI、KDJ、BIAS、ATR、OBV、量比等核心指标
    const dataContext = klineData.map(d =>
      `Date: ${d.date}, O:${d.open} H:${d.high} L:${d.low} C:${d.close} Vol:${d.volume} | MA5:${d.ma5} MA10:${d.ma10} MA20:${d.ma20} MA60:${d.ma60} MA120:${d.ma120} MA250:${d.ma250} | MACD:${d.macd}/${d.macdSignal}/${d.macdHist} RSI:${d.rsi14} KDJ:${d.kdjK}/${d.kdjD}/${d.kdjJ} | BIAS6:${d.bias6} BIAS12:${d.bias12} ATR:${d.atr14} OBV:${d.obv} VolRatio:${d.volRatio} PctChg:${d.pctChg}`
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
      industry: metaMap[s.marketCode]?.industry || '',
    }));

    // 大盘择时数据注入 prompt
    const indexRows = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, 'sh000300'))
      .orderBy(asc(klineDaily.date)).limit(300).all() as any[];
    const timing = indexRows.length >= 60 ? assessMarketTiming(indexRows, 'sh000300') : null;
    const regimeLabel = timing ? `${timing.regime}(${timing.regimeLabel})` : 'unknown';
    const maxPosition = timing ? timing.maxPosition : 0.5;

    const rawPrompt = await getAiPrompt('ai_picks_prompt', DEFAULT_PICKS_PROMPT, c);
    const strategyName = strategy === 'momentum' ? '动量突破' : strategy === 'contrarian' ? '逆向反转' : '价值回归';
    const systemPrompt = rawPrompt
      .replace(/{{strategy}}/g, strategyName)
      .replace(/{{count}}/g, String(count))
      .replace(/{{marketRegime}}/g, regimeLabel);

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
    const resultData = { generatedAt: new Date(), picks, timing: timing ? { regime: timing.regime, regimeLabel: timing.regimeLabel, maxPosition: timing.maxPosition } : null };
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

// ════════════════════════════════════════════════════════════
// AI 角色 3: 复盘教练 —— AutoResearch 闭环反馈
// 分析已结算推荐记录，生成策略优化建议
// ════════════════════════════════════════════════════════════
app.post('/review', async (c) => {
  try {
    const { days = 30 } = (await c.req.json().catch(() => ({}))) as any;
    const db = getDb(c);

    // 读取已结算的推荐记录（有 returnPct 的）
    const resolved = await db.select().from(recommendations)
      .where(and(
        sql`status IS NOT 'active'`,
        sql`return_pct IS NOT NULL`
      ))
      .orderBy(desc(recommendations.createdAt))
      .limit(200)
      .all() as any[];

    if (!resolved || resolved.length === 0) {
      return c.json({ success: false, error: '暂无已结算推荐记录，请先运行推荐引擎并等待绩效追踪' }, 400);
    }

    // 汇总统计供 AI 分析
    const stats = {
      totalTrades: resolved.length,
      winRate: resolved.filter(r => (r.returnPct ?? 0) > 0).length / resolved.length,
      avgReturn: resolved.reduce((s, r) => s + (r.returnPct ?? 0), 0) / resolved.length,
      avgHoldDays: resolved.reduce((s, r) => s + (r.holdDays ?? 0), 0) / resolved.length,
      byStrategy: {} as Record<string, { count: number; wins: number; avgReturn: number }>,
      byAction: {} as Record<string, { count: number; wins: number; avgReturn: number }>,
    };

    for (const r of resolved) {
      const sk = r.strategy || 'unknown';
      if (!stats.byStrategy[sk]) stats.byStrategy[sk] = { count: 0, wins: 0, avgReturn: 0 };
      stats.byStrategy[sk].count++;
      if ((r.returnPct ?? 0) > 0) stats.byStrategy[sk].wins++;
      stats.byStrategy[sk].avgReturn += r.returnPct ?? 0;

      const ak = r.action || 'unknown';
      if (!stats.byAction[ak]) stats.byAction[ak] = { count: 0, wins: 0, avgReturn: 0 };
      stats.byAction[ak].count++;
      if ((r.returnPct ?? 0) > 0) stats.byAction[ak].wins++;
      stats.byAction[ak].avgReturn += r.returnPct ?? 0;
    }

    for (const k of Object.keys(stats.byStrategy)) stats.byStrategy[k].avgReturn /= stats.byStrategy[k].count;
    for (const k of Object.keys(stats.byAction)) stats.byAction[k].avgReturn /= stats.byAction[k].count;

    // 最近 20 笔明细
    const recentDetail = resolved.slice(0, 20).map(r => ({
      code: r.marketCode,
      action: r.action,
      strategy: r.strategy,
      entryPrice: r.entryPrice,
      resolvedPrice: r.resolvedPrice,
      returnPct: r.returnPct,
      holdDays: r.holdDays,
      status: r.status,
      reason: r.reason,
    }));

    const dataContext = JSON.stringify({ stats, recentDetail }, null, 2);
    const systemPrompt = await getAiPrompt('ai_review_prompt', DEFAULT_REVIEW_PROMPT, c);

    let responseText = '{}';
    try {
      const aiClient = await getAiClient(c);
      const aiModel = await getAiModel(c);

      const response = await aiClient.chat.completions.create({
        model: aiModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `以下是近${days}天的推荐绩效数据：\n${dataContext}` },
        ],
      });

      responseText = response.choices[0]?.message?.content || '{}';
    } catch (err: any) {
      if (err.message.includes('API Key is not configured')) {
        return c.json({ success: false, error: 'AI_NOT_CONFIGURED', message: 'Please configure your AI Provider in Settings.' }, 400);
      }
      throw err;
    }

    const parsed = JSON.parse(responseText);
    return c.json({ success: true, data: { ...parsed, statsSummary: stats, generatedAt: new Date() } });
  } catch (e: any) {
    console.error('AI Review Error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default app;
