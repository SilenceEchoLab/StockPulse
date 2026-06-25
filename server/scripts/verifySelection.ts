// Phase 2 选股改造闭环验证
// 验证三条链路：P0 推荐器(盈亏比+仓位链) / P1-a 60分钟层 / P1-b 组合级风控回测
// 用法: npx tsx server/scripts/verifySelection.ts
import { getDb } from '../db/getDb.js';
import { createClient } from '@libsql/client';
import { klineDaily, klineMin, globalStrategyOptima } from '../db/schema.js';
import { eq, asc, and } from 'drizzle-orm';
import { generateRecommendation } from '../lib/recommender.js';
import { scoreMultiCycle } from '../lib/cycles.js';
import { backtestRecommendationEngine, type BacktestStrategy } from '../lib/recommendationBacktest.js';
import type { MinBar } from '../lib/cycles.js';
import type { KlineRow } from '../lib/signalEngine.js';

const db = getDb();
const raw = createClient({ url: 'file:data/market_data.db' });

const SAMPLE = 'sh600519';
const pct = (x: number | null | undefined) => (x == null ? '-' : (x * 100).toFixed(1) + '%');

// ── 加载全局策略参数 ──
const optimaRows = await db.select().from(globalStrategyOptima).where(eq(globalStrategyOptima.regime, 'all')).all() as any[];
const strategies: BacktestStrategy[] = optimaRows.map(r => ({ strategy: r.strategy, params: JSON.parse(r.paramsJson) }));
console.log(`▶ 加载 ${strategies.length} 个全局策略: ${strategies.map(s => s.strategy).join(', ')}\n`);

// ════════════════════════════════════════════════════════
// 验证 A：P0 推荐器 —— 盈亏比 + 仓位链（择时→仓位）
// ════════════════════════════════════════════════════════
console.log('═══ A. P0 推荐器：盈亏比门槛 + 择时→仓位链 ═══');
const optima = strategies.map(s => ({ strategy: s.strategy, params: s.params, compositeScore: 0.5 }));

for (const sample of ['sh600519', 'sh600000']) {
  const dailyRows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, sample)).orderBy(asc(klineDaily.date)).all() as any[];
  console.log(`\n样本 ${sample} (最新价 ${dailyRows[dailyRows.length - 1].close}):`);
  for (const [regime, maxPos] of [['bull', 0.75], ['range', 0.5], ['bear', 0.2]] as const) {
    const rec = generateRecommendation(dailyRows as KlineRow[], optima, regime, undefined, {
      maxPosition: maxPos, accountEquity: 100000, riskPerTrade: 0.01,
    });
    const cap = 100000 * Math.min(0.20, maxPos); // 单股上限金额
    console.log(`  [${regime} maxPos=${maxPos}] action=${rec.action} RR=${rec.riskReward} ` +
      `posSize=${rec.positionSize}股 (${pct(rec.positionValuePct)}) | 单股上限≈${cap.toFixed(0)}元`);
    console.log(`     reason: ${rec.reason}`);
  }
}

// ════════════════════════════════════════════════════════
// 验证 B：P1-a 三周期共振 60 分钟层
// ════════════════════════════════════════════════════════
console.log('\n═══ B. P1-a 三周期共振：60 分钟第三层 ═══');
const dailyRows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, SAMPLE)).orderBy(asc(klineDaily.date)).all() as any[];
const m60Rows = await db.select().from(klineMin).where(and(eq(klineMin.marketCode, SAMPLE), eq(klineMin.period, 'm60'))).orderBy(asc(klineMin.time)).all() as any[];
const intraday60: MinBar[] = m60Rows.map(r => ({ time: r.time, open: r.open, close: r.close, high: r.high, low: r.low, volume: r.volume }));
const without60 = scoreMultiCycle(dailyRows as KlineRow[]);
const with60 = scoreMultiCycle(dailyRows as KlineRow[], { intraday60 });
console.log(`60分钟样本: ${intraday60.length} 根`);
console.log(`不含60分: score=${without60.score} resonant=${without60.resonant}`);
console.log(`含60分钟: score=${with60.score} resonant=${with60.resonant} | 60分确认=${with60.intraday60?.confirmed} (${with60.intraday60?.signals.map(s => s.name).join('+') || '无信号'})`);
console.log(` → 第三层${with60.intraday60 ? (with60.intraday60.confirmed ? '已确认，共振判定更严格' : '未确认，resonant 被收紧') : '缺省降级'}`);

// ════════════════════════════════════════════════════════
// 验证 C：P1-b 组合级风控回测（portfolioRisk on vs off）
// ════════════════════════════════════════════════════════
console.log('\n═══ C. P1-b 组合级风控：回测对比（20只个股·全历史） ═══');
// 取 20 只可回测个股
const codeList = (await raw.execute("select market_code from (select market_code, count(*) n from kline_daily where market_code not like 'sh00%' and market_code not like 'sz39%' group by market_code having n > 250 limit 20)")).rows.map((r: any) => r.market_code);
const klineMap = new Map<string, KlineRow[]>();
for (const code of codeList) {
  const rows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all() as any[];
  klineMap.set(code, rows.map(r => ({ ...r, marketCode: code })) as KlineRow[]);
}
const benchmark = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).all() as any[];

const off = backtestRecommendationEngine(klineMap, benchmark as KlineRow[], strategies, { days: 400, portfolioRisk: false });
const on = backtestRecommendationEngine(klineMap, benchmark as KlineRow[], strategies, { days: 400, portfolioRisk: true });

const fmt = (r: any) => `trades=${r.totalTrades} winRate=${(r.winRate * 100).toFixed(1)}% avgRet=${(r.avgReturn * 100).toFixed(2)}% totalRet=${(r.totalReturn * 100).toFixed(1)}% sharpe=${r.sharpe.toFixed(2)} maxDD=${(r.maxDrawdown * 100).toFixed(1)}%`;
console.log('组合风控 OFF(原等权):', fmt(off));
console.log('组合风控 ON (仓位上限+单股≤20%+回撤熔断):', fmt(on));
console.log(`  → 平均占用仓位: ${pct(on.avgPositionUsed)} | 账户回撤熔断: ${on.accountHalted ? '触发' : '未触发'}`);
console.log('\nbyRegime (组合风控 ON):', JSON.stringify(on.byRegime));

console.log('\n✓ Phase 2 验证完成');
