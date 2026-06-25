// 批量补同步周线+月线（仅 week/month，不动日/分钟线）
// 用法: npx tsx server/scripts/bulkSyncLongPeriod.ts
import { createClient } from '@libsql/client';
import { getDb } from '../db/getDb.js';
import { syncOneStock } from '../routes/sync.js';

const c = createClient({ url: 'file:data/market_data.db' });
const db = getDb();

const stocks = (await c.execute(
  "SELECT DISTINCT market_code FROM kline_daily WHERE market_code NOT LIKE 'sh00%' AND market_code NOT LIKE 'sz39%' ORDER BY market_code"
)).rows.map((r: any) => r.market_code);

console.log(`[bulkSync] ${stocks.length} stocks, syncing week+month...`);
let ok = 0, fail = 0;
const failures: string[] = [];
const t0 = Date.now();

for (let i = 0; i < stocks.length; i++) {
  const code = stocks[i];
  try {
    await syncOneStock(code, db, { mode: 'full', granularities: ['week', 'month'], longPeriodCount: 320 });
    ok++;
  } catch (e: any) {
    fail++; failures.push(`${code}: ${e.message}`);
  }
  if ((i + 1) % 20 === 0 || i === stocks.length - 1) {
    console.log(`  [${i + 1}/${stocks.length}] ok=${ok} fail=${fail} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await new Promise(r => setTimeout(r, 250)); // 轻微限流
}

console.log(`\n[bulkSync] done: ok=${ok} fail=${fail} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failures.length) console.log('failures:\n' + failures.slice(0, 20).join('\n'));
