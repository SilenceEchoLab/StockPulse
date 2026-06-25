// 数据库巡检脚本 —— 闭环验证用
// 用法: npx tsx server/scripts/inspectDb.ts [marketCode]
// 打印各周期表/分组的行数，确认多粒度同步是否落盘
import { createClient } from '@libsql/client';

const code = process.argv[2]; // 可选：只看某只标的

const c = createClient({ url: 'file:data/market_data.db' });

function rows(map: any[], key: string) {
  return map.map((x: any) => `${x[key]}=${x.n}`).join(', ');
}

console.log('=== 表清单 ===');
const tables = await c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log(tables.rows.map((x: any) => x.name).join(', '));

console.log('\n=== kline_daily ===');
const daily = await c.execute('SELECT count(*) as n FROM kline_daily');
console.log('总行数:', daily.rows[0].n);
if (code) {
  const d = await c.execute({ sql: 'SELECT count(*) as n, min(date) as lo, max(date) as hi FROM kline_daily WHERE market_code=?', args: [code] });
  console.log(`${code}:`, d.rows[0].n, '行, 日期', d.rows[0].lo, '→', d.rows[0].hi);
}

console.log('\n=== kline_min (分钟) ===');
const minAll = await c.execute('SELECT period, count(*) as n FROM kline_min GROUP BY period');
console.log('按周期:', rows(minAll.rows as any, 'period') || '(空)');
if (code) {
  const m = await c.execute({ sql: 'SELECT period, count(*) as n FROM kline_min WHERE market_code=? GROUP BY period', args: [code] });
  console.log(`${code} 分钟:`, rows(m.rows as any, 'period') || '(空)');
}

console.log('\n=== kline_long_period (周/月) ===');
const lpAll = await c.execute('SELECT period, count(*) as n FROM kline_long_period GROUP BY period');
console.log('按周期:', rows(lpAll.rows as any, 'period') || '(空)');
if (code) {
  const lp = await c.execute({ sql: 'SELECT period, count(*) as n, min(date) as lo, max(date) as hi FROM kline_long_period WHERE market_code=? GROUP BY period', args: [code] });
  for (const r of lp.rows as any[]) {
    console.log(`${code} ${r.period}:`, r.n, '行, 日期', r.lo, '→', r.hi);
  }
}

console.log('\n=== recommendations ===');
const rec = await c.execute('SELECT count(*) as n FROM recommendations');
console.log('总行数:', rec.rows[0].n);
