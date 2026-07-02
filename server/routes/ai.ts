import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { aiSentiment, klineDaily, klineMin, klineLongPeriod, dailySnapshot, stocks as stocksSchema, strategyOptima, recommendations, globalStrategyOptima, strategyCredibility } from '../db/schema.js';
import { eq, desc, isNotNull, gte, asc, and, sql } from 'drizzle-orm';
import { getAiClient, getAiModel, getAiPrompt } from '../ai/index.js';
import { aiPicksCache } from '../lib/state.js';
import { scoreStock, scoreContrarian, detectSignals } from '../lib/signalEngine.js';
import { scoreMultiCycle, assessWeeklyTrend, assessMonthlyTrend, assessIntraday60 } from '../lib/cycles.js';
import { assessMarketTiming } from '../lib/marketTiming.js';
import { generateSignal } from '../lib/backtestEngine.js';
import { getPolicy } from '../lib/policy.js';
import { assessValuation } from '../lib/valuation.js';
import { TRADING_DOCTRINE } from '../lib/tradingDoctrine.js';
import { chatStructured, SENTIMENT_SCHEMA, CRITIQUE_SCHEMA, SYNTHESIS_SCHEMA } from '../lib/llmStructured.js';
import { getTencentStockData } from '../lib/tencent.js';
import { runScreening, screenState, resetScreenState } from '../lib/stockScreener.js';
import type { BacktestParams, StrategyType } from '../lib/backtestEngine.js';
import { logger } from '../lib/logger.js';

const app = new Hono();

// ════════════════════════════════════════════════════════════
// AI 角色 1: 趋势诊断师 —— 个股深度分析
// 基于趋势投资六步系统，输出完整交易计划
// ════════════════════════════════════════════════════════════
const DEFAULT_SENTIMENT_PROMPT = `你是"AI 诊股师"。下面是【确定性信号引擎】已基于《趋势投资》规则识别的事实（不可推翻）。

${TRADING_DOCTRINE}

你的职责严格限定为四件：
① 综合诊断：把引擎分数/多空排列/买卖信号/风险标签 + 大盘/月周线/估值/资金流/位置，讲成一段 A 股个人投资者一听就懂的人话（趋势方向 + 核心信号 + 关键风险，约90字）。
② 震仓 vs 出货（你的核心价值，引擎盲区）：依据打压后有无承接/放量缩量/是否破位/换手/资金流向 给出判断。
③ 双轴价值评估（各自独立打分，一只股可能兼具或皆无）：
   - 投资价值(长线)：估值/大周期趋势/基本面稳健/走势可控。
   - 投机价值(短线)：情绪/动量/三周期共振/主力资金流入/短期弹性。
④ 综合评分：0-100 分，须落在【引擎分 ±10】内。

铁律：不许重新推导 MA/MACD 等指标（引擎已给）；不许预测股价/给买卖价位（止损以 ATR 系统值为准）；全程基于给定事实，你是解读员不是预言家。
**输出必须是完整 JSON，6 个字段缺一不可**：score, label, summary, diagnosis, investmentValue, speculationValue。若某轴无明显依据，score 给低分、tag 给"无"、reason 说明，但字段必须存在。

输出纯 JSON（禁止 Markdown）：
{
  "score": 0-100,
  "label": "状态标签",
  "summary": "约90字综合诊断",
  "diagnosis": { "isWashing": bool, "isDistributing": bool, "reason": "震仓/出货依据(20字内)" },
  "investmentValue": { "score": 0-100, "tag": "高/中/低/无", "reason": "投资价值判定依据(25字内)" },
  "speculationValue": { "score": 0-100, "tag": "高/中/低/无", "reason": "投机价值判定依据(25字内)" }
}`;

// ════════════════════════════════════════════════════════════
// AI 角色 2: 量化选股官 —— 组合配置建议
// 基于大盘择时 + 产业周期 + 三周期共振，输出核心+卫星配置
// ════════════════════════════════════════════════════════════
const DEFAULT_PICKS_PROMPT = `你是"量化选股官"，一位严格遵循趋势投资体系的基金经理。

${TRADING_DOCTRINE}

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

### 第五步：AutoResearch 策略验证（历史回测反哺）
每只候选股附带 researchConsensus —— 经过 3.3 年 walk-forward 回测验证的全局稳健策略（稳定率≥30%）的实时多策略共识：
- buyCount/totalStrategies：当前有多少个已验证策略看多
- consensusScore：加权共识分（稳定率×可信度），越高越可靠
- buyVotes：看多的具体策略（如 ma520 / macd_cross / three_cycle）
优先选择 buyCount≥2 或 consensusScore 高的标的 —— 这些是经历史检验的策略共同认可的方向，可信度更高。

### 第六步：配置输出
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
    const db = getDb(c);
    const cached = await db.select().from(aiSentiment).where(eq(aiSentiment.marketCode, code)).get();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

    // 缓存命中（force=true 时绕过缓存强制重跑）：从 signals JSON 重建完整结构化结果
    const force = c.req.query('force') === 'true';
    if (!force && cached && new Date(cached.updatedAt) > fourHoursAgo) {
      const payload = JSON.parse(cached.signals || '{}');
      return c.json({
        success: true,
        data: {
          score: cached.score, label: cached.label, summary: cached.summary,
          engineScore: payload.engineScore, engineLabel: payload.engineLabel, alignment: payload.alignment,
          signals: payload.engineSignals || [], sellSignals: payload.sellSignals || [], riskTags: payload.riskTags || [],
          diagnosis: payload.diagnosis || null,
          investmentValue: payload.investmentValue || null, speculationValue: payload.speculationValue || null,
          agreement: payload.agreement || null,
          updatedAt: cached.updatedAt,
        }
      });
    }

    // ① 确定性事实：跑信号引擎（可靠锚，基于《趋势投资》规则）
    const klineData = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).limit(120).all();
    if (!klineData || klineData.length === 0) {
      return c.json({ success: false, error: 'No kline data found for this stock' }, 404);
    }
    const snapshot = await db.select().from(dailySnapshot)
      .where(eq(dailySnapshot.marketCode, code)).orderBy(desc(dailySnapshot.date)).limit(1).get();
    const rows = klineData.map((r: any) => ({ ...r, turnoverRate: snapshot?.turnoverRate ?? null }));
    const engine = detectSignals(rows);
    const engineScore = engine.score;

    // ② 丰富确定性事实：大盘择时 + 月/周线趋势 + 基本面估值 + 价格位置 + 量价 + 引擎（覆盖手册全链路）
    const last = rows[rows.length - 1] as any;
    const price = last.close;

    // 大盘环境（手册 STEP1：不跳出大盘看个股）
    let regimeLabel = '未知';
    try {
      const policy = await getPolicy(db);
      const idx = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).limit(300).all();
      if (idx.length >= 60) {
        const t = assessMarketTiming(idx as any, 'sh000300', { bull: policy.regimeBullPos, range: policy.regimeRangePos, bear: policy.regimeBearPos });
        regimeLabel = `${t.regimeLabel}（仓位上限${Math.round(t.maxPosition * 100)}%）`;
      }
    } catch { /* 大盘数据缺失忽略 */ }

    // 月线(第一层硬过滤)/周线(大周期定方向) —— 三周期共振的"大周期"
    let monthLine = '数据不足', weekLine = '数据不足';
    try {
      const monthRows = await db.select().from(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, 'month'))).orderBy(asc(klineLongPeriod.date)).all();
      const m = assessMonthlyTrend(monthRows as any);
      monthLine = m.bearish ? `${m.label}（空头，第一层淘汰）` : m.bullish ? `${m.label}（多头）` : m.label;
      const w = assessWeeklyTrend(rows as any);
      weekLine = w.bullish ? `${w.label}（多头，大周期向上）` : w.label;
    } catch { /* 周月线缺失忽略 */ }

    // 基本面估值（手册 2.4）
    const snap = snapshot as any;
    const valAssess = snap ? assessValuation(snap.peRatio, snap.pbRatio) : null;
    const valuation = valAssess ? `${valAssess.label}（PE=${snap.peRatio?.toFixed(1) ?? '-'}, PB=${snap.pbRatio?.toFixed(2) ?? '-'}）` : '估值数据缺失';

    // 价格位置：vs MA + 近60日分位（手册：高位/低位判定）
    const posVs = (ma: any) => (ma == null) ? '-' : (price > ma ? `站上${((price - ma) / ma * 100).toFixed(1)}%` : `跌破${((ma - price) / ma * 100).toFixed(1)}%`);
    const last60 = rows.slice(-60);
    const hi60 = last60.length ? Math.max(...last60.map((r: any) => r.high)) : price;
    const lo60 = last60.length ? Math.min(...last60.map((r: any) => r.low)) : price;
    const pctile60 = (hi60 - lo60) > 0 ? ((price - lo60) / (hi60 - lo60) * 100) : 50;

    // 量价（手册 3.6/3.7）
    const vols = rows.map((r: any) => r.volume);
    const avgVol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, vols.length);
    const avgVol60 = vols.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, vols.length);
    const volRatio5_60 = avgVol60 > 0 ? avgVol5 / avgVol60 : 1;
    const turnover = snap?.turnoverRate ?? null;
    const turnoverTier = turnover == null ? '未知' : turnover > 25 ? '高位出货风险' : turnover >= 3 ? '主力活跃' : '沉寂';

    const recent10 = rows.slice(-10).map((r: any) =>
      `${r.date}: 收${r.close}(${(r.pctChg ?? 0).toFixed(1)}%) 量比${(r.volRatio ?? 0).toFixed(2)} 换手${(r.turnoverRate ?? 0).toFixed(1)}% | MA5:${r.ma5?.toFixed(2)} MA20:${r.ma20?.toFixed(2)} MACD:${r.macd?.toFixed(3)} KDJ_J:${r.kdjJ?.toFixed(1)} RSI:${r.rsi14?.toFixed(1)}`
    ).join('\n');

    // 主力资金流向（手册 3.7/资金流）—— 腾讯实时行情内/外盘
    let capitalFlow = '数据缺失';
    try {
      const q = await getTencentStockData([code]);
      if (q && q[0]) {
        const net = (q[0].innerDisc ?? 0) - (q[0].outerDisc ?? 0);
        capitalFlow = net > 0 ? `主动买盘占优（内盘>外盘）` : net < 0 ? `主动卖盘占优（外盘>内盘）` : '买卖均衡';
      }
    } catch { /* 实时行情缺失忽略 */ }

    // 60分钟趋势（三周期第三层·小周期抓节奏）
    let intraday60Line = '数据不足';
    try {
      const m60 = await db.select().from(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, 'm60'))).orderBy(asc(klineMin.time)).all();
      const bars = m60.map((r: any) => ({ time: r.time, open: r.open, close: r.close, high: r.high, low: r.low, volume: r.volume }));
      const ia = assessIntraday60(bars);
      intraday60Line = ia.confirmed ? `确认偏多（${ia.signals.map(s => s.name).join('+') || '信号'}）` : '未确认/偏弱';
    } catch { /* 60分缺失忽略 */ }

    // 关键价位（前高压力/前低/支撑）+ 相对强度（近20日 vs 沪深300）
    const last120 = rows.slice(-120);
    const prevHigh = last120.length > 1 ? Math.max(...last120.slice(0, -1).map((r: any) => r.high)) : price;
    const prevLow = last120.length > 1 ? Math.min(...last120.slice(0, -1).map((r: any) => r.low)) : price;
    const support = last.ma20 ?? last.ma60 ?? prevLow;
    let relStrength = '未知';
    try {
      const idxClose = (await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(desc(klineDaily.date)).limit(21).all()).map((r: any) => r.close).reverse();
      if (rows.length >= 21 && idxClose.length >= 21) {
        const stkRet = rows[rows.length - 1].close / rows[rows.length - 21].close - 1;
        const idxRet = idxClose[idxClose.length - 1] / idxClose[0] - 1;
        relStrength = stkRet > idxRet + 0.03 ? `强于大盘（超额${((stkRet - idxRet) * 100).toFixed(1)}%）` : stkRet < idxRet - 0.03 ? `弱于大盘（${((stkRet - idxRet) * 100).toFixed(1)}%）` : '同步大盘';
      }
    } catch { /* 忽略 */ }

    const facts = `【大盘环境】 ${regimeLabel}
【月线·第一层硬过滤】 ${monthLine}
【周线·大周期定方向】 ${weekLine}
【60分钟·小周期抓节奏】 ${intraday60Line}
【基本面估值】 ${valuation}
【主力资金】 ${capitalFlow}
【价格位置】 现价${price}：vs MA5 ${posVs(last.ma5)}, vs MA20 ${posVs(last.ma20)}, vs MA60 ${posVs(last.ma60)}, vs MA250 ${posVs(last.ma250)}；近60日分位 ${pctile60.toFixed(0)}%（0=最低/100=最高）
【关键价位】 前高/压力 ${prevHigh.toFixed(2)}｜前低 ${prevLow.toFixed(2)}｜支撑 ${support != null ? support.toFixed(2) : '-'}｜距支撑 ${support != null ? ((price - support) / support * 100).toFixed(1) : '-'}%
【相对强度(近20日)】 ${relStrength}
【量价】 近5日均量/60日均量=${volRatio5_60.toFixed(2)}（>1.2放量/<0.7缩量）；换手率${turnover?.toFixed(1) ?? '-'}%（${turnoverTier}）
【确定性引擎事实 · 不可推翻】
综合分: ${engineScore} (${engine.scoreLabel})
多空排列: ${engine.alignment === 'bullish' ? '多头' : engine.alignment === 'bearish' ? '空头' : '中性'}
买入信号: ${engine.buySignals.map((s: any) => s.name).join('、') || '无'}
卖出信号: ${engine.sellSignals.map((s: any) => `${s.name}(${s.urgency})`).join('、') || '无'}
风险标签: ${engine.riskTags.map((t: any) => `${t.name}(${t.level})`).join('、') || '无'}
【近10日量价（供震仓/出货判断）】
${recent10}`;

    // 投机/投资双轴确定性评分（手册：投资=估值+大周期+基本面；投机=情绪+动量+共振）—— 可靠兜底
    const tagOf = (s: number) => s >= 65 ? '高' : s >= 40 ? '中' : s >= 20 ? '低' : '无';
    let detInvest = 40;
    if (valAssess) detInvest += valAssess.tier === 'undervalued' ? 15 : valAssess.tier === 'fair' ? 8 : valAssess.tier === 'loss' ? -10 : -5;
    if (monthLine.includes('空头')) detInvest -= 15; else if (monthLine.includes('多头')) detInvest += 15;
    if (weekLine.includes('多头')) detInvest += 10;
    if (last.ma250 != null && price > last.ma250) detInvest += 10;
    if (last.ma60 != null && price > last.ma60) detInvest += 5;
    if (pctile60 > 90) detInvest -= 5; else if (pctile60 < 80) detInvest += 5;
    detInvest = Math.max(0, Math.min(100, Math.round(detInvest)));
    let detSpec = 35;
    const buyN = engine.buySignals.length;
    if (buyN >= 3) detSpec += 15; else if (buyN >= 1) detSpec += 8;
    if (engine.riskTags.some((t: any) => String(t.name).includes('连板'))) detSpec += 10;
    if (intraday60Line.includes('确认') && (weekLine.includes('多头') || monthLine.includes('多头'))) detSpec += 10;
    if (capitalFlow.includes('买盘占优')) detSpec += 8;
    if (pctile60 > 85) detSpec -= 8; else if (pctile60 >= 20 && pctile60 <= 70) detSpec += 5;
    if (relStrength.includes('强于')) detSpec += 8;
    detSpec = Math.max(0, Math.min(100, Math.round(detSpec)));

    let aiScore = engineScore, aiLabel = engine.scoreLabel, aiSummary = '', diagnosis: any = null;
    // 双轴默认用确定性评分；LLM 若返回结构化双轴则覆盖
    let investmentValue: any = { score: detInvest, tag: tagOf(detInvest), reason: '确定性评估(估值/大周期/基本面)' };
    let speculationValue: any = { score: detSpec, tag: tagOf(detSpec), reason: '确定性评估(情绪/动量/共振)' };
    try {
      const aiClient = await getAiClient(c);
      const aiModel = await getAiModel(c);
      const customPrompt = await getAiPrompt('ai_sentiment_prompt', DEFAULT_SENTIMENT_PROMPT, c);
      // 结构化调用：json_schema 强约束全字段（provider 不支持则降级 json_object+coerce）
      const parsed = await chatStructured(aiClient, aiModel, [
        { role: 'system', content: customPrompt },
        { role: 'user', content: `${facts}\n\n请输出 JSON（score 须在引擎分 ${engineScore} ±10 内；investmentValue/speculationValue 各自独立打分）。` }
      ], SENTIMENT_SCHEMA, { temperature: 0.4 });
      aiScore = typeof parsed.score === 'number' && parsed.score > 0 ? parsed.score : engineScore;
      aiLabel = parsed.label || engine.scoreLabel;
      aiSummary = parsed.summary || '';
      // 仅当 LLM 给了实质内容才覆盖确定性默认（coerce 会把省略字段填成默认值，不可信）
      diagnosis = (parsed.diagnosis && parsed.diagnosis.reason) ? parsed.diagnosis : null;
      if (parsed.investmentValue && (parsed.investmentValue.score > 0 || parsed.investmentValue.reason)) investmentValue = parsed.investmentValue;
      if (parsed.speculationValue && (parsed.speculationValue.score > 0 || parsed.speculationValue.reason)) speculationValue = parsed.speculationValue;
    } catch (err: any) {
      if (err.message?.includes('API Key is not configured')) {
        return c.json({ success: false, error: 'AI_NOT_CONFIGURED', message: 'Please configure your AI Provider in Settings.' }, 400);
      }
      // LLM 失败：降级为纯引擎事实（无解读），仍可用
      aiSummary = '（AI 解读暂不可用，以上为确定性引擎事实）';
    }

    const delta = Math.round(aiScore - engineScore);
    const result = {
      score: aiScore, label: aiLabel, summary: aiSummary,
      engineScore, engineLabel: engine.scoreLabel, alignment: engine.alignment,
      signals: engine.buySignals, sellSignals: engine.sellSignals, riskTags: engine.riskTags,
      diagnosis, investmentValue, speculationValue,
      agreement: { delta, conflict: Math.abs(delta) > 10 },
      updatedAt: new Date(),
    };

    // 缓存：signals 列存完整 payload（结构化）
    await db.batch([
      db.delete(aiSentiment).where(eq(aiSentiment.marketCode, code)),
      db.insert(aiSentiment).values({
        marketCode: code,
        score: aiScore, label: aiLabel, summary: aiSummary,
        signals: JSON.stringify({
          engineScore, engineLabel: engine.scoreLabel, alignment: engine.alignment,
          engineSignals: engine.buySignals, sellSignals: engine.sellSignals, riskTags: engine.riskTags,
          diagnosis, investmentValue, speculationValue, agreement: result.agreement,
        }),
        updatedAt: new Date(),
      })
    ]);

    return c.json({ success: true, data: result });

  } catch (e: any) {
    logger.error('API', 'AI Sentiment Error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ══ 多轮深度诊断（诊断→反方→综合 闭环工作流，opt-in，3× LLM 成本）══
// 紧凑确定性事实（供诊断上下文，与 /sentiment 的丰富版略有取舍，避免大段重复）
async function buildStockFactsCompact(db: any, code: string) {
  const klineData = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).limit(120).all();
  if (!klineData || klineData.length === 0) throw new Error('No kline data');
  const snapshot = await db.select().from(dailySnapshot).where(eq(dailySnapshot.marketCode, code)).orderBy(desc(dailySnapshot.date)).limit(1).get() as any;
  const rows = klineData.map((r: any) => ({ ...r, turnoverRate: snapshot?.turnoverRate ?? null }));
  const engine = detectSignals(rows);
  const last = rows[rows.length - 1] as any; const price = last.close;
  let regime = '未知';
  try {
    const policy = await getPolicy(db);
    const idx = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).limit(300).all();
    if (idx.length >= 60) regime = assessMarketTiming(idx as any, 'sh000300', { bull: policy.regimeBullPos, range: policy.regimeRangePos, bear: policy.regimeBearPos }).regimeLabel;
  } catch { /* 忽略 */ }
  let monthL = '未知', weekL = '未知';
  try {
    const mr = await db.select().from(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, 'month'))).orderBy(asc(klineLongPeriod.date)).all();
    const m = assessMonthlyTrend(mr as any);
    monthL = m.bearish ? `${m.label}(空头)` : m.bullish ? `${m.label}(多头)` : m.label;
    const w = assessWeeklyTrend(rows as any);
    weekL = w.bullish ? `${w.label}(多头)` : w.label;
  } catch { /* 忽略 */ }
  const v = snapshot ? assessValuation(snapshot.peRatio, snapshot.pbRatio) : null;
  const val = v ? `${v.label}(PE=${snapshot.peRatio?.toFixed(1) ?? '-'},PB=${snapshot.pbRatio?.toFixed(2) ?? '-'})` : '估值缺失';
  const pos = (ma: any) => ma == null ? '-' : (price > ma ? `站上${((price - ma) / ma * 100).toFixed(1)}%` : `跌破${((ma - price) / ma * 100).toFixed(1)}%`);
  const l60 = rows.slice(-60);
  const hi = l60.length ? Math.max(...l60.map((r: any) => r.high)) : price;
  const lo = l60.length ? Math.min(...l60.map((r: any) => r.low)) : price;
  const pct = (hi - lo) > 0 ? (price - lo) / (hi - lo) * 100 : 50;
  const vols = rows.map((r: any) => r.volume);
  const a5 = vols.slice(-5).reduce((a: number, b: number) => a + b, 0) / Math.min(5, vols.length);
  const a60 = vols.slice(-60).reduce((a: number, b: number) => a + b, 0) / Math.min(60, vols.length);
  const facts = `【大盘】${regime}\n【月线】${monthL}  【周线】${weekL}\n【估值】${val}\n【位置】vs MA20 ${pos(last.ma20)}, MA60 ${pos(last.ma60)}, MA250 ${pos(last.ma250)}; 近60日分位 ${pct.toFixed(0)}%\n【量价】5/60日均量=${(a60 > 0 ? a5 / a60 : 1).toFixed(2)}, 换手${snapshot?.turnoverRate?.toFixed(1) ?? '-'}%\n【引擎】综合分${engine.score}(${engine.scoreLabel}), ${engine.alignment}; 买入[${engine.buySignals.map((s: any) => s.name).join(',') || '无'}] 卖出[${engine.sellSignals.map((s: any) => s.name).join(',') || '无'}] 风险[${engine.riskTags.map((t: any) => t.name).join(',') || '无'}]`;
  return { facts, engine };
}

app.post('/diagnose/:code', async (c) => {
  try {
    const code = c.req.param('code');
    const db = getDb(c);
    const { facts, engine } = await buildStockFactsCompact(db, code);
    const ai = await getAiClient(c);
    const model = await getAiModel(c);
    const prompt = await getAiPrompt('ai_sentiment_prompt', DEFAULT_SENTIMENT_PROMPT, c);

    // Round 1：分析师（结构化诊断）
    const round1 = await chatStructured(ai, model, [
      { role: 'system', content: prompt },
      { role: 'user', content: `${facts}\n\nRound1 分析师诊断（score 须在引擎分 ${engine.score} ±10 内）。` }
    ], SENTIMENT_SCHEMA);

    // Round 2：反方辩护人（纯文本批判——叙述性内容不强制 JSON，最大化模型遵从度）
    const r2Messages = [
      { role: 'system', content: `${TRADING_DOCTRINE}\n你是反方辩护人。针对下面的分析师诊断，用 100-150 字中文指出它可能错在哪（过拟合/体制特定/数据噪声/情绪偏差），并给出你对分析师结论的信心（低/中/高）。直接输出文字，不要 JSON、不要标题。` },
      { role: 'user', content: `事实:\n${facts}\n\n分析师诊断:\n${JSON.stringify(round1)}` }
    ];
    const r2StartTime = Date.now();
    logger.llm.request('critique', model, { messages: r2Messages });
    const r2 = await ai.chat.completions.create({
      model, temperature: 0.5,
      messages: r2Messages as any
    });
    const round2 = r2.choices[0]?.message?.content?.trim() || '';
    logger.llm.response('critique', Date.now() - r2StartTime, round2);

    // Round 3：首席策略师（纯文本综合）
    const r3Messages = [
      { role: 'system', content: `${TRADING_DOCTRINE}\n你是首席策略师。综合分析师诊断与反方意见，给最终评估：是否修正分析师的判断、最关键的一点建议、最大的不确定性。120-180 字中文，直接输出文字，不要 JSON、不要标题。` },
      { role: 'user', content: `事实:\n${facts}\n分析师:\n${JSON.stringify(round1)}\n反方:\n${round2}` }
    ];
    const r3StartTime = Date.now();
    logger.llm.request('synthesis', model, { messages: r3Messages });
    const r3 = await ai.chat.completions.create({
      model, temperature: 0.4,
      messages: r3Messages as any
    });
    const round3 = r3.choices[0]?.message?.content?.trim() || '';
    logger.llm.response('synthesis', Date.now() - r3StartTime, round3);

    return c.json({ success: true, data: { round1, round2, round3, engineScore: engine.score } });
  } catch (e: any) {
    if (e?.message?.includes('API Key is not configured')) {
      return c.json({ success: false, error: 'AI_NOT_CONFIGURED', message: 'Please configure your AI Provider in Settings.' }, 400);
    }
    logger.error('API', 'Diagnose error:', e);
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

    // ── 大盘择时（提前算，供 research 共识与 prompt 共用）──
    const indexRows = await db.select().from(klineDaily)
      .where(eq(klineDaily.marketCode, 'sh000300'))
      .orderBy(asc(klineDaily.date)).limit(300).all() as any[];
    const timing = indexRows.length >= 60 ? assessMarketTiming(indexRows, 'sh000300') : null;
    const regime = timing?.regime as 'bull' | 'range' | 'bear' | undefined;

    // ── AutoResearch 反哺：经回测验证的全局稳健策略 + 贝叶斯可信度 ──
    // 用这些「最稳定策略」的实时多策略共识，作为 AI 选股的历史验证依据
    const globalRows = await db.select().from(globalStrategyOptima).all() as any[];
    const credRows = await db.select().from(strategyCredibility).all() as any[];
    const credibility: Partial<Record<string, number>> = {};
    for (const cr of credRows) credibility[cr.strategy] = cr.blendedCredibility ?? 1;
    const validatedStrategies = globalRows
      .filter((g: any) => (g.stabilityScore ?? 0) >= 0.3)
      .map((g: any) => ({
        strategy: g.strategy as StrategyType,
        params: JSON.parse(g.paramsJson) as BacktestParams,
        stability: g.stabilityScore ?? 0,
      }));

    const dataByCode = new Map<string, any[]>();
    for (const row of allKlines) {
      if (!dataByCode.has(row.marketCode)) dataByCode.set(row.marketCode, []);
      const arr = dataByCode.get(row.marketCode)!;
      arr.push({
        ...row,
        turnoverRate: snapshotMap[row.marketCode]?.turnoverRate ?? null,
      });
    }

    // 打分引擎评分 + AutoResearch 多策略共识（用全局验证参数跑 generateSignal）
    let scored: any[] = [];
    for (const [code, rows] of dataByCode) {
      if (rows.length < 10) continue;
      const snap = snapshotMap[code];
      const result = strategy === 'contrarian' ? scoreContrarian(rows) : scoreStock(rows);

      // AutoResearch 共识：经回测验证的策略当前是否看多（稳定率×可信度加权）
      const i = rows.length;
      let researchBuy = 0, researchScore = 0;
      const researchVotes: string[] = [];
      for (const vs of validatedStrategies) {
        const params = { ...vs.params, marketRegime: regime } as BacktestParams;
        if (generateSignal(vs.strategy, params, rows, i) === 'buy') {
          researchBuy++;
          researchScore += vs.stability * (credibility[vs.strategy] ?? 1);
          researchVotes.push(vs.strategy);
        }
      }

      scored.push({
        marketCode: code,
        close: rows[rows.length - 1].close,
        scoreResult: result,
        pe: snap?.peRatio,
        pb: snap?.pbRatio,
        researchBuy, researchScore, researchVotes,
      });
    }

    // 策略筛选与排序（momentum/contrarian 叠加 AutoResearch 共识加分）
    if (strategy === 'value') {
      scored = scored.filter(s => s.pe && s.pe > 0);
      // 价值策略：趋势打分作为安全过滤器，PE 从低到高
      scored.sort((a, b) => (a.pe || 0) - (b.pe || 0));
    } else {
      // momentum / contrarian：经回测验证的策略看多者优先（反哺驱动推荐），
      // 同 buyCount 再按「引擎评分 + 共识加权」
      scored.sort((a, b) => {
        if (b.researchBuy !== a.researchBuy) return b.researchBuy - a.researchBuy;
        return (b.scoreResult.score + b.researchScore * 10) - (a.scoreResult.score + a.researchScore * 10);
      });
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
      // AutoResearch 反哺：经回测验证的策略共识，供 LLM 选股参考
      researchConsensus: {
        buyCount: s.researchBuy,
        totalStrategies: validatedStrategies.length,
        consensusScore: Number(s.researchScore.toFixed(2)),
        buyVotes: s.researchVotes,
      },
    }));

    const regimeLabel = timing ? `${timing.regime}(${timing.regimeLabel})` : 'unknown';

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
      
      const picksMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Data:\n${JSON.stringify(promptData)}` }
      ];
      const picksStartTime = Date.now();
      logger.llm.request('ai_picks', aiModel, { messages: picksMessages });

      const response = await aiClient.chat.completions.create({
         model: aiModel,
         response_format: { type: 'json_object' },
         messages: picksMessages as any
      });

      responseText = response.choices[0]?.message?.content || '{}';
      logger.llm.response('ai_picks', Date.now() - picksStartTime, responseText);
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
        researchConsensus: {
          buyCount: item.researchBuy,
          totalStrategies: validatedStrategies.length,
          consensusScore: Number(item.researchScore.toFixed(2)),
          buyVotes: item.researchVotes,
        },
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
        researchConsensus: sc ? {
          buyCount: sc.researchBuy,
          totalStrategies: validatedStrategies.length,
          consensusScore: Number(sc.researchScore.toFixed(2)),
          buyVotes: sc.researchVotes,
        } : null,
      };
    });
    const resultData = { generatedAt: new Date(), picks, timing: timing ? { regime: timing.regime, regimeLabel: timing.regimeLabel, maxPosition: timing.maxPosition } : null };
    aiPicksCache.set(cacheKey, resultData);
    return c.json({ success: true, cached: false, ...resultData });

  } catch (e: any) {
    logger.error('API', 'AI Picks Error:', e);
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
    logger.error('API', 'Signal detection error:', e);
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

      const reviewMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `以下是近${days}天的推荐绩效数据：\n${dataContext}` },
      ];
      const reviewStartTime = Date.now();
      logger.llm.request('ai_review', aiModel, { messages: reviewMessages });

      const response = await aiClient.chat.completions.create({
        model: aiModel,
        response_format: { type: 'json_object' },
        messages: reviewMessages as any,
      });

      responseText = response.choices[0]?.message?.content || '{}';
      logger.llm.response('ai_review', Date.now() - reviewStartTime, responseText);
    } catch (err: any) {
      if (err.message.includes('API Key is not configured')) {
        return c.json({ success: false, error: 'AI_NOT_CONFIGURED', message: 'Please configure your AI Provider in Settings.' }, 400);
      }
      throw err;
    }

    const parsed = JSON.parse(responseText);
    return c.json({ success: true, data: { ...parsed, statsSummary: stats, generatedAt: new Date() } });
  } catch (e: any) {
    logger.error('API', 'AI Review Error:', e);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ══ 全市场 LLM 选股锦标赛（一键并行，逐轮淘汰）══
app.post('/screen', async (c) => {
  try {
    const { topN = 10 } = (await c.req.json().catch(() => ({}))) as any;
    if (screenState.status === 'running') {
      return c.json({ success: false, message: '选股锦标赛正在执行中' });
    }
    resetScreenState();
    const db = getDb(c);
    // 后台异步执行（本地 Node 环境）
    runScreening(c, db, Math.min(Math.max(topN, 5), 20)).catch(e => logger.error('API', 'Screening error:', e));
    return c.json({ success: true, message: `选股锦标赛已启动（目标 Top ${topN}）` });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.get('/screen/status', (c) => {
  return c.json({ success: true, data: screenState });
});

app.get('/screen/result', (c) => {
  if (screenState.result) return c.json({ success: true, data: screenState.result });
  return c.json({ success: false, error: '暂无结果，请先执行选股' });
});

export default app;
