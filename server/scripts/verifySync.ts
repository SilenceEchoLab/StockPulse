// 多粒度同步闭环验证：对样本股实跑全粒度同步，再查库确认各周期落盘
// 用法: npx tsx server/scripts/verifySync.ts [code]
import { getDb } from '../db/getDb.js';
import { syncOneStock } from '../routes/sync.js';
import { klineDaily, klineMin, klineLongPeriod } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';

const code = process.argv[2] || 'sh600519';
const db = getDb();

console.log(`▶ 全量同步 ${code}（day/week/month/m5/m30/m60）...`);
const t0 = Date.now();
try {
  await syncOneStock(code, db, {
    mode: 'full',
    granularities: ['day', 'week', 'month', 'm5', 'm30', 'm60'],
    days: 800,
    minuteCount: 2000,
    longPeriodCount: 320,
  });
} catch (e: any) {
  console.error('同步失败:', e.message);
  process.exit(1);
}
console.log(`▶ 同步耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// 查库确认
const probe = async (label: string, q: any) => {
  const rows = await q;
  const r = (rows as any[])[0] || {};
  console.log(`${label.padEnd(22)} 行数=${String(rows.length).padStart(5)}  范围=${r.lo ?? '-'} → ${r.hi ?? '-'}`);
};

await probe('日线 day', db.select({ lo: klineDaily.date }).from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(desc(klineDaily.date)).limit(1).all()
  .then(async (d) => {
    const n = await db.select({ n: klineDaily.date }).from(klineDaily).where(eq(klineDaily.marketCode, code)).all();
    return [{ lo: n[n.length - 1]?.date, hi: n[0]?.date }];
  }));

for (const p of ['week', 'month']) {
  const all = await db.select().from(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, p))).orderBy(desc(klineLongPeriod.date)).all() as any[];
  console.log(`${(p === 'week' ? '周线 week' : '月线 month').padEnd(22)} 行数=${String(all.length).padStart(5)}  范围=${all[all.length - 1]?.date ?? '-'} → ${all[0]?.date ?? '-'}`);
  // 抽样：最后一根的 MA5/MA20/MACD 是否算出
  if (all[0]) console.log(`  最新一根: close=${all[0].close} ma5=${all[0].ma5} ma20=${all[0].ma20} macd=${all[0].macd}`);
}

for (const p of ['m5', 'm30', 'm60']) {
  const all = await db.select().from(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, p))).orderBy(desc(klineMin.time)).all() as any[];
  console.log(`${('分钟 ' + p).padEnd(22)} 行数=${String(all.length).padStart(5)}  范围=${all[all.length - 1]?.time ?? '-'} → ${all[0]?.time ?? '-'}`);
}

console.log('\n✓ 验证完成');
