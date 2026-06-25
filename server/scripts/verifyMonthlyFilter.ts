// 月线硬过滤 + 冷却熔断 闭环验证
// 1) 选股层：132 只股票 scoreMultiCycle 含/不含月线过滤，统计被月线空头淘汰的数量
// 2) 回测层：组合风控(冷却恢复) vs 旧(永久停手) 对比
// 用法: npx tsx server/scripts/verifyMonthlyFilter.ts
import { getDb } from '../db/getDb.js';
import { klineDaily, klineLongPeriod, globalStrategyOptima } from '../db/schema.js';
import { eq, asc, and, sql } from 'drizzle-orm';
import { scoreMultiCycle, assessMonthlyTrend } from '../lib/cycles.js';
import { backtestRecommendationEngine, type BacktestStrategy } from '../lib/recommendationBacktest.js';
import type { KlineRow } from '../lib/signalEngine.js';

const db = getDb();

// 132 只个股
const stocks = (await db.select({ code: klineDaily.marketCode }).from(klineDaily)
  .where(sql`market_code NOT LIKE 'sh00%' AND market_code NOT LIKE 'sz39%'`)
  .groupBy(klineDaily.marketCode).all() as any[]).map(r => r.code);

console.log(`▶ ${stocks.length} 只个股\n`);

// ══ 1) 月线硬过滤效果 ══
let monthBear = 0, monthBull = 0, monthNeutral = 0, monthMissing = 0;
let flippedResonant = 0;       // 因月线空头从「本可共振」被否决
let avgScoreDrop = 0; let dropN = 0;
const bearSamples: string[] = [];

for (const code of stocks) {
  const daily = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all() as any[];
  const month = await db.select().from(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, 'month'))).orderBy(asc(klineLongPeriod.date)).all() as any[];

  if (month.length < 3) { monthMissing++; continue; }
  const m = assessMonthlyTrend(month as KlineRow[]);
  if (m.bearish) { monthBear++; if (bearSamples.length < 8) bearSamples.push(`${code}(${m.label})`); }
  else if (m.bullish) monthBull++; else monthNeutral++;

  const without = scoreMultiCycle(daily as KlineRow[]);
  const withM = scoreMultiCycle(daily as KlineRow[], { monthly: month as KlineRow[] });
  if (without.score !== withM.score) { avgScoreDrop += (without.score - withM.score); dropN++; }
  // 月线空头本可共振(无月线时 resonant) → 被否决
  if (m.bearish && without.resonant && !withM.resonant) flippedResonant++;
}

console.log('═══ 1. 月线第一层硬过滤效果 ═══');
console.log(`月线判定: 多头=${monthBull} 中性=${monthNeutral} 空头=${monthBear} 数据不足=${monthMissing}`);
console.log(`月线空头样本: ${bearSamples.join(', ') || '无'}`);
console.log(`含月线后平均分变化: ${dropN ? (-avgScoreDrop / dropN).toFixed(1) : '0'} 分/只 (空头降分、多头加成)`);
console.log(`因月线空头被否决共振的个股: ${flippedResonant} 只`);

// ══ 2) 冷却熔断 vs 永久停手 ══
console.log('\n═══ 2. 组合风控：冷却恢复 vs 永久停手 ═══');
const optimaRows = await db.select().from(globalStrategyOptima).where(eq(globalStrategyOptima.regime, 'all')).all() as any[];
const strategies: BacktestStrategy[] = optimaRows.map(r => ({ strategy: r.strategy, params: JSON.parse(r.paramsJson) }));
const klineMap = new Map<string, KlineRow[]>();
for (const code of stocks.slice(0, 40)) {  // 取 40 只加速
  const rows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all() as any[];
  klineMap.set(code, rows.map(r => ({ ...r, marketCode: code })) as KlineRow[]);
}
const benchmark = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).all() as any[];

const permanent = backtestRecommendationEngine(klineMap, benchmark as KlineRow[], strategies, { days: 400, portfolioRisk: true, haltCooldownDays: 9999 });
const cooldown = backtestRecommendationEngine(klineMap, benchmark as KlineRow[], strategies, { days: 400, portfolioRisk: true, haltCooldownDays: 20 });
const fmt = (r: any) => `trades=${r.totalTrades} winRate=${(r.winRate*100).toFixed(1)}% totalRet=${(r.totalReturn*100).toFixed(1)}% sharpe=${r.sharpe.toFixed(2)} maxDD=${(r.maxDrawdown*100).toFixed(1)}% avgPos=${(r.avgPositionUsed*100).toFixed(1)}% haltDays=${r.haltDays}`;
console.log(`永久停手(旧): ${fmt(permanent)}`);
console.log(`冷却20日(新): ${fmt(cooldown)}`);
console.log(`  → 冷却恢复后 trades ${permanent.totalTrades}→${cooldown.totalTrades}，停手日 ${permanent.haltDays}→${cooldown.haltDays}`);

console.log('\n✓ 验证完成');
