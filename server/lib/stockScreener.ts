// 全市场 LLM 选股锦标赛 —— 漏斗架构，逐轮淘汰
// Phase0 确定性预筛(全池→40, 无LLM) → Phase1 LLM批量排分(40→20) → Phase2 选股委员会终评(20→topN)
// 全程仅 ~5 次 LLM 调用，高效；基于趋势投资底层经验 + 确定性事实。
import { eq, and, asc, desc } from 'drizzle-orm';
import { stocks as stocksSchema, klineDaily, klineLongPeriod, dailySnapshot } from '../db/schema.js';
import { detectSignals } from './signalEngine.js';
import { assessMonthlyTrend, assessWeeklyTrend } from './cycles.js';
import { assessValuation } from './valuation.js';
import { chatStructured, BATCH_RANK_SCHEMA, COMMITTEE_SCHEMA } from './llmStructured.js';
import { TRADING_DOCTRINE } from './tradingDoctrine.js';
import { getAiClient, getAiModel } from '../ai/index.js';

export interface ScreenState {
  status: 'idle' | 'running' | 'completed' | 'error';
  phase: string;
  progress: number;       // 0-100
  startedAt: Date | null;
  result: any | null;
  error: string | null;
}

export const screenState: ScreenState = {
  status: 'idle', phase: '', progress: 0, startedAt: null, result: null, error: null,
};

export function resetScreenState() {
  screenState.status = 'idle'; screenState.phase = ''; screenState.progress = 0;
  screenState.startedAt = null; screenState.result = null; screenState.error = null;
}

/** Phase 0：确定性预筛——为全池每只股票构建紧凑事实卡 + 复合分，排序返回 */
async function buildCandidateCards(db: any) {
  const pool = await db.select().from(stocksSchema).all() as any[];
  const idxRows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).limit(300).all() as any[];
  const idxRet20 = idxRows.length >= 21 ? idxRows[idxRows.length - 1].close / idxRows[idxRows.length - 21].close - 1 : 0;
  const snaps = await db.select().from(dailySnapshot).orderBy(desc(dailySnapshot.date)).all() as any[];
  const snapMap = new Map<string, any>();
  for (const s of snaps) if (!snapMap.has(s.marketCode)) snapMap.set(s.marketCode, s);

  const cards: any[] = [];
  for (const s of pool) {
    const code = s.marketCode;
    try {
      const rows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).limit(120).all() as any[];
      if (!rows.length || rows.length < 60) continue;
      const snap = snapMap.get(code);
      const rowsT = rows.map(r => ({ ...r, turnoverRate: snap?.turnoverRate ?? null }));
      const engine = detectSignals(rowsT);
      const last = rows[rows.length - 1];
      const monthRows = await db.select().from(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, 'month'))).orderBy(asc(klineLongPeriod.date)).all() as any[];
      const m = assessMonthlyTrend(monthRows);
      const w = assessWeeklyTrend(rowsT);
      const v = snap ? assessValuation(snap.peRatio, snap.pbRatio) : null;
      const l60 = rows.slice(-60);
      const hi = Math.max(...l60.map(r => r.high)); const lo = Math.min(...l60.map(r => r.low));
      const pct = (hi - lo) > 0 ? (last.close - lo) / (hi - lo) * 100 : 50;
      const stkRet20 = rows.length >= 21 ? rows[rows.length - 1].close / rows[rows.length - 21].close - 1 : 0;
      const relStr = stkRet20 > idxRet20 + 0.03 ? '强于大盘' : stkRet20 < idxRet20 - 0.03 ? '弱于大盘' : '同步';
      // 复合分（确定性）
      let comp = engine.score;
      comp += m.bullish ? 20 : m.bearish ? -20 : 0;
      comp += w.bullish ? 10 : 0;
      comp += v?.tier === 'undervalued' ? 10 : v?.tier === 'overvalued' ? -10 : v?.tier === 'loss' ? -8 : 0;
      comp += (pct >= 20 && pct <= 70) ? 5 : pct > 85 ? -5 : 0;
      comp += Math.min(15, engine.buySignals.length * 3);
      const card = `${code} ${s.name}: 引擎${engine.score}(${engine.scoreLabel},${engine.alignment}) 月线[${m.label}] 周线[${w.bullish ? '多头' : w.label}] 估值[${v?.label ?? '缺失'},PE${snap?.peRatio?.toFixed(1) ?? '-'}] 位置${pct.toFixed(0)}%分位 买入${engine.buySignals.length}个[${engine.buySignals.map((b: any) => b.name).join(',')}] 风险[${engine.riskTags.map((t: any) => t.name).join(',')}] 相对强度[${relStr}]`;
      cards.push({ code, name: s.name, card, composite: comp, engineScore: engine.score });
    } catch { /* 单股失败跳过 */ }
  }
  return cards.sort((a, b) => b.composite - a.composite);
}

/** 一键选股锦标赛（后台异步执行，更新 screenState） */
export async function runScreening(c: any, db: any, topN: number = 10) {
  try {
    screenState.status = 'running'; screenState.phase = 'Phase 0 · 确定性预筛全市场'; screenState.progress = 5; screenState.result = null; screenState.error = null; screenState.startedAt = new Date();

    const all = await buildCandidateCards(db);
    const candidates = all.slice(0, 40);
    screenState.progress = 30; screenState.phase = `Phase 1 · LLM 批量排分（${candidates.length} 只候选）`;

    const ai = await getAiClient(c);
    const model = await getAiModel(c);

    // Phase 1：10 只/批，并行排分
    const batches: any[][] = [];
    for (let i = 0; i < candidates.length; i += 10) batches.push(candidates.slice(i, i + 10));
    const ranked: any[] = [];
    let doneBatches = 0;
    await Promise.all(batches.map(async (batch) => {
      const cards = batch.map(x => x.card).join('\n');
      try {
        const res = await chatStructured(ai, model, [
          { role: 'system', content: `${TRADING_DOCTRINE}\n你是趋势投资选股官。基于下列确定性事实，给每只候选一个 0-100 的"当前推荐度"（综合考虑趋势/结构/估值/位置/风险），并用一句话说明理由。code 字段必须原样复制每行开头的股票代码（如 sh600000）。` },
          { role: 'user', content: `候选:\n${cards}` }
        ], BATCH_RANK_SCHEMA, { temperature: 0.3 });
        for (const p of (res.picks || [])) {
          // 三路匹配：精确 code / 6 位数字前缀 / 名称
          const pc = String(p.code || '').trim();
          const hit = batch.find(x => x.code === pc || x.code.includes(pc) || pc.includes(x.code) || x.name === pc || x.name.includes(pc));
          if (hit) ranked.push({ ...hit, llmScore: typeof p.score === 'number' ? p.score : 0, llmReason: p.reason || '' });
        }
      } catch { /* 批次失败跳过 */ }
      doneBatches++;
      screenState.progress = 30 + Math.round((doneBatches / batches.length) * 40);
    }));

    // 兜底：若 LLM 排分全部未匹配，用确定性复合分补上
    if (ranked.length === 0) {
      for (const c of candidates) ranked.push({ ...c, llmScore: c.composite, llmReason: '确定性复合分(趋势+估值+位置+信号)' });
    }
    // 补足：若 LLM 只匹配了部分，用剩余候选的确定性分补齐至 20
    const rankedCodes = new Set(ranked.map(r => r.code));
    for (const c of candidates) {
      if (ranked.length >= 20) break;
      if (!rankedCodes.has(c.code)) ranked.push({ ...c, llmScore: c.composite, llmReason: '确定性复合分(趋势+估值+位置+信号)' });
    }

    ranked.sort((a, b) => (b.llmScore ?? 0) - (a.llmScore ?? 0));
    const top20 = ranked.slice(0, 20);
    screenState.phase = `Phase 2 · 选股委员会终评（${top20.length} 强 → Top ${topN}）`; screenState.progress = 75;

    // Phase 2：委员会终评
    const committeeCards = top20.map(x => `${x.code} ${x.name}: 初评${x.llmScore} | ${x.card}`).join('\n');
    let topPicks: any[] = [];
    try {
      const final = await chatStructured(ai, model, [
        { role: 'system', content: `${TRADING_DOCTRINE}\n你是选股委员会主席。从下列候选中选出当前 A 股市场最值得关注的 ${topN} 只，按推荐度排序，每只给一句话推荐理由，并标注投资价值/投机价值标签。输出 JSON {topPicks: [{rank, code, name, reason, investmentTag, speculationTag}]}。code 字段必须原样复制每行开头的代码。` },
        { role: 'user', content: `候选(${top20.length}强):\n${committeeCards}` }
      ], COMMITTEE_SCHEMA, { temperature: 0.3 });
      topPicks = (final.topPicks || []).filter((p: any) => p.code && p.name);
      // 三路匹配 committee 输出 code → top20 实体
      topPicks = topPicks.map(p => {
        const hit = top20.find(x => x.code === p.code || x.code.includes(p.code) || p.code.includes(x.code) || x.name === p.name || x.name.includes(p.name));
        return hit ? { ...p, code: hit.code, name: hit.name } : null;
      }).filter(Boolean);
    } catch { /* 委员会失败 → 确定性兜底 */ }

    // 确定性兜底：若委员会未返回有效结果，从 top20 按 llmScore 取 topN
    if (topPicks.length === 0) {
      topPicks = top20.slice(0, topN).map((x, i) => ({
        rank: i + 1, code: x.code, name: x.name,
        reason: x.llmReason || `引擎分${x.engineScore}·复合${x.composite}`,
        investmentTag: '中' as const, speculationTag: '中' as const,
      }));
    }

    screenState.result = {
      topPicks: topPicks.slice(0, topN),
      analyzed: all.length,
      candidates: candidates.length,
      semifinalists: top20.length,
      generatedAt: new Date(),
    };
    screenState.status = 'completed'; screenState.phase = '完成'; screenState.progress = 100;
  } catch (e: any) {
    screenState.status = 'error'; screenState.error = e?.message || String(e);
  }
}
