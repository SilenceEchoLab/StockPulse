// 最终达标闭环验证：WARMUP / 分批建仓 / 新信号 / 估值因子
// 用法: npx tsx server/scripts/verifyFinal.ts
import { getDb } from '../db/getDb.js';
import { klineDaily, globalStrategyOptima } from '../db/schema.js';
import { eq, asc, sql } from 'drizzle-orm';
import { runBacktest } from '../lib/backtestEngine.js';
import { detectSignals } from '../lib/signalEngine.js';
import { assessValuation } from '../lib/valuation.js';
import type { KlineRow } from '../lib/signalEngine.js';

const db = getDb();
const dailyOf = async (code: string) => (await db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all() as any[]).map(r => ({ ...r, marketCode: code })) as KlineRow[];

// ══ 1. WARMUP=260：回测仍可跑出交易（数据 803 > 262） ══
console.log('═══ 1. WARMUP=260 回测完整性 ═══');
const tcParams = (await db.select().from(globalStrategyOptima).where(eq(globalStrategyOptima.strategy, 'three_cycle')).all() as any[])[0];
const params = tcParams ? JSON.parse(tcParams.paramsJson) : { stopLoss: 0.08, takeProfit: 0.1, maxHoldDays: 15 };
const cfg = (p: any) => ({ strategy: 'three_cycle' as const, params: p, fees: { buy: 0.0003, sell: 0.0013 }, slippage: 0.001, initialCapital: 1000000 });
const rows519 = await dailyOf('sh600519');
const bt = runBacktest(rows519, cfg({ ...params, marketRegime: 'range' }));
console.log(`  sh600519: trades=${bt.metrics.tradeCount} totalRet=${(bt.metrics.totalReturn*100).toFixed(1)}% winRate=${(bt.metrics.winRate*100).toFixed(0)}% maxDD=${(bt.metrics.maxDrawdown*100).toFixed(1)}${bt.metrics.tradeCount > 0 ? ' OK' : ' (warmup 过长?)'}`);

// ══ 2. 分批/金字塔建仓（opt-in）——用低价股确保买得起试错仓 ══
console.log('\n═══ 2. 分批/金字塔建仓（stagedEntry） ═══');
const rowsLow = await dailyOf('sh600000'); // 浦发 ~8.85 元，试错仓可买
const single = runBacktest(rowsLow, cfg({ ...params, marketRegime: 'range' }));
const staged = runBacktest(rowsLow, cfg({ ...params, marketRegime: 'range', stagedEntry: true, trialFraction: 0.4 }));
console.log(`  sh600000 单次建仓: trades=${single.metrics.tradeCount} totalRet=${(single.metrics.totalReturn*100).toFixed(1)}% avgHold=${single.metrics.avgHoldDays.toFixed(0)}日`);
console.log(`  sh600000 分批建仓: trades=${staged.metrics.tradeCount} totalRet=${(staged.metrics.totalReturn*100).toFixed(1)}% avgHold=${staged.metrics.avgHoldDays.toFixed(0)}日`);
console.log(`  → 分批模式首仓试错(40%)+盈利3%后加仓一次、亏损不补`);

// ══ 3. 新增信号历史触发扫描（全历史滑窗，证代码路径会触发） ══
console.log('\n═══ 3. 新增信号历史触发（5 只 × 全历史滑窗） ═══');
const codes = (await db.select({ code: klineDaily.marketCode }).from(klineDaily)
  .where(sql`market_code NOT LIKE 'sh00%' AND market_code NOT LIKE 'sz39%'`)
  .groupBy(klineDaily.marketCode).limit(5).all() as any[]).map(r => r.code);
const newSignalNames = ['天量天价', '地量见地价', '连板', '放量下跌', '量价背离'];
const hit: Record<string, number> = {}; newSignalNames.forEach(n => hit[n] = 0);
for (const code of codes) {
  const all = await dailyOf(code);
  for (let i = 100; i < all.length; i++) {  // 滑窗扫每个历史交易日
    const rep = detectSignals(all.slice(0, i));
    const names = [...rep.buySignals.map(s => s.name), ...rep.sellSignals.map(s => s.name), ...rep.riskTags.map(t => t.name)];
    for (const n of newSignalNames) if (names.some(x => x.includes(n))) hit[n]++;
  }
}
console.log('  历史触发次数: ' + newSignalNames.map(n => `${n}=${hit[n]}`).join('  '));

// ══ 4. 估值因子分层 ══
console.log('\n═══ 4. 估值因子分层（PE/PB 样例） ═══');
for (const [pe, pb, name] of [[4.7, 0.44, '平安银行'], [13.18, 2.51, '美的'], [60, 5, '偏高'], [120, 8, '泡沫'], [-370, 0.94, '亏损'], [null, null, '缺失']] as const) {
  const v = assessValuation(pe as any, pb as any);
  console.log(`  PE=${pe} PB=${pb} (${name}): ${v.tier} / ${v.label} / confAdj=${v.confidenceAdj} / risk=${v.risk}`);
}

console.log('\n✓ 最终验证完成');
