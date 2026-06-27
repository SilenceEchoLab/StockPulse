// AutoResearch 后端验证：regime 分桶可信度 + 演进日志 + policy（纯函数直调，不导入 research.js）
import { getDb } from '../db/getDb.js';
import { createClient } from '@libsql/client';
import { klineDaily, globalStrategyOptima } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { backtestRecommendationEngine, type BacktestStrategy } from '../lib/recommendationBacktest.js';
import { applyBacktestCredibility } from '../lib/performanceTracker.js';
import { appendChangelog, getChangelog } from '../lib/changelog.js';
import { getPolicy } from '../lib/policy.js';

const db = getDb();
const raw = createClient({ url: 'file:data/market_data.db' });

// 1) policy 可读
const policy = await getPolicy(db);
console.log('[policy] enabled=', policy.enabledStrategies.length, 'riskPerTrade=', policy.riskPerTrade);

// 2) 跑回放 → applyBacktestCredibility 写 regime 分桶可信度
const codes = (await raw.execute("SELECT DISTINCT market_code FROM kline_daily WHERE market_code NOT LIKE 'sh00%' AND market_code NOT LIKE 'sz39%' LIMIT 15")).rows.map((r: any) => r.market_code);
const klineMap = new Map<string, any[]>();
for (const code of codes) {
  const rows = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all() as any[];
  klineMap.set(code, rows.map(r => ({ ...r, marketCode: code })));
}
const benchmark = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).all() as any[];
const optimaRows = await db.select().from(globalStrategyOptima).all() as any[];
const strategies: BacktestStrategy[] = optimaRows.map(r => ({ strategy: r.strategy, params: JSON.parse(r.paramsJson) }));
const result = backtestRecommendationEngine(klineMap, benchmark, strategies, { days: 300 });
console.log('[replay] trades=', result.totalTrades, 'byStrategyRegime keys=', Object.keys(result.byStrategyRegime).length);
await applyBacktestCredibility(db, result.byStrategy, result.byStrategyRegime);
const regRows = (await raw.execute("SELECT strategy, regime, real_sample_count n, blended_credibility FROM strategy_credibility_by_regime ORDER BY strategy, regime")).rows;
console.log('[credibility-by-regime] 行数=', regRows.length);
console.log('  sample:', regRows.slice(0, 6).map((r: any) => `${r.strategy}/${r.regime}=${r.blended_credibility}(n=${r.n})`).join('  '));

// 3) changelog 往返
await appendChangelog(db, { type: 'discipline', strategy: 'consensus', regime: 'all', message: '验证用纪律复盘条目', details: { resolved: 5, hitTP: 2 } });
const log = await getChangelog(db, 5);
console.log('[changelog] 最新', log.length, '条, 首条:', log[0]?.type, '-', log[0]?.message?.slice(0, 40));

// 4) 回退契约（31）的样本外比较逻辑——展示 byStrategyRegime 揭示同策略跨regime差异
const threeCycle = regRows.filter((r: any) => r.strategy === 'three_cycle');
if (threeCycle.length) console.log('[anti-fragile] three_cycle 跨regime:', threeCycle.map((r: any) => `${r.regime}=${r.blended_credibility}`).join(' '));

console.log('\n✓ 后端验证完成');
process.exit(0);
