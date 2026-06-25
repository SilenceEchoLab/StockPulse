// 去重幂等验证：增量重跑后各周期行数应保持稳定
import { createClient } from '@libsql/client';
import { getDb } from '../db/getDb.js';
import { syncOneStock } from '../routes/sync.js';

const c = createClient({ url: 'file:data/market_data.db' });
const code = 'sh600519';
const q = async (sql: string) => (await c.execute({ sql })).rows[0] as any;

const before = {
  week: (await q(`select count(*) n from kline_long_period where market_code='${code}' and period='week'`)).n,
  month: (await q(`select count(*) n from kline_long_period where market_code='${code}' and period='month'`)).n,
  m5: (await q(`select count(*) n from kline_min where market_code='${code}' and period='m5'`)).n,
  daily: (await q(`select count(*) n from kline_daily where market_code='${code}'`)).n,
};
console.log('before:', JSON.stringify(before));

await syncOneStock(code, getDb(), { mode: 'incremental', granularities: ['day', 'week', 'month', 'm5', 'm30', 'm60'] });

const after = {
  week: (await q(`select count(*) n from kline_long_period where market_code='${code}' and period='week'`)).n,
  month: (await q(`select count(*) n from kline_long_period where market_code='${code}' and period='month'`)).n,
  m5: (await q(`select count(*) n from kline_min where market_code='${code}' and period='m5'`)).n,
  daily: (await q(`select count(*) n from kline_daily where market_code='${code}'`)).n,
};
console.log('after :', JSON.stringify(after));
const ok = before.week === after.week && before.month === after.month && before.m5 === after.m5 && before.daily === after.daily;
console.log(ok ? '✓ 去重幂等：增量重跑行数稳定' : '✗ 行数变化，去重异常');
