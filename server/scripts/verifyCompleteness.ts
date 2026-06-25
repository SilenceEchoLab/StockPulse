// 全量数据完整性检查：统计每只标的在各粒度的覆盖情况，找出缺失/不足
// 用法: npx tsx server/scripts/verifyCompleteness.ts [minDailyRows=250] [minMinuteRows=200]
import { createClient } from '@libsql/client';

const c = createClient({ url: 'file:data/market_data.db' });
const minDaily = Number(process.argv[2]) || 250;
const minMinute = Number(process.argv[3]) || 200;

const stocks = (await c.execute(
  "SELECT DISTINCT market_code FROM kline_daily WHERE market_code NOT LIKE 'sh00%' AND market_code NOT LIKE 'sz39%' ORDER BY market_code"
)).rows.map((r: any) => r.market_code);

const one = async (sql: string, args: any[] = []): Promise<any> => {
  const r = await c.execute({ sql, args });
  return r.rows[0];
};

const gran = ['day', 'week', 'month', 'm30', 'm60'] as const;
const missing: Record<string, string[]> = { day: [], week: [], month: [], m30: [], m60: [] };
const low: Record<string, string[]> = { day: [], week: [], month: [], m30: [], m60: [] };
const sumRows: Record<string, number> = { day: 0, week: 0, month: 0, m30: 0, m60: 0 };
let minDateAll = '9999', maxDateAll = '0000';

for (const code of stocks) {
  const d = await one(`SELECT count(*) n, min(date) lo, max(date) hi FROM kline_daily WHERE market_code=?`, [code]);
  if (d) {
    sumRows.day += Number(d.n);
    if (d.lo && d.lo < minDateAll) minDateAll = d.lo;
    if (d.hi && d.hi > maxDateAll) maxDateAll = d.hi;
    if (!Number(d.n)) missing.day.push(code); else if (Number(d.n) < minDaily) low.day.push(`${code}(${d.n})`);
  } else missing.day.push(code);
  for (const p of ['week', 'month'] as const) {
    const r = await one(`SELECT count(*) n FROM kline_long_period WHERE market_code=? AND period=?`, [code, p]);
    const n = r ? Number(r.n) : 0;
    sumRows[p] += n;
    if (!n) missing[p].push(code); else if (p === 'week' && n < 100) low[p].push(`${code}(${n})`);
  }
  for (const p of ['m30', 'm60'] as const) {
    const r = await one(`SELECT count(*) n FROM kline_min WHERE market_code=? AND period=?`, [code, p]);
    const n = r ? Number(r.n) : 0;
    sumRows[p] += n;
    if (!n) missing[p].push(code); else if (n < minMinute) low[p].push(`${code}(${n})`);
  }
}

const lines: string[] = [];
lines.push(`[Data Completeness] stocks=${stocks.length}  dailyRange=${minDateAll}..${maxDateAll}`);
for (const g of gran) {
  const avg = stocks.length ? (sumRows[g] / stocks.length).toFixed(0) : '0';
  const ok = missing[g].length === 0;
  lines.push(`  ${g.padEnd(6)} avg=${avg.padStart(5)}/stock  missing=${missing[g].length} ${ok ? 'OK' : 'MISSING'}`);
  if (missing[g].length) lines.push(`         missing: ${missing[g].slice(0, 20).join(', ')}${missing[g].length > 20 ? ' ...' : ''}`);
  if (low[g].length) lines.push(`         low(<${g === 'day' ? minDaily : g === 'week' ? 100 : minMinute}): ${low[g].slice(0, 12).join(', ')}${low[g].length > 12 ? ' ...' : ''}`);
}
// 抽样指标存在性（取有周线数据的前3只）
const sampleCodes: string[] = [];
for (const code of stocks) {
  if (sampleCodes.length >= 3) break;
  const w = await one(`SELECT close, ma5, ma20, macd FROM kline_long_period WHERE market_code=? AND period='week' ORDER BY date DESC LIMIT 1`, [code]);
  if (w) { sampleCodes.push(`${code}(close=${w.close},ma5=${w.ma5},macd=${w.macd})`); }
}
lines.push(`  weeklySample: ${sampleCodes.join(' | ') || 'none'}`);
const allComplete = gran.every(g => missing[g].length === 0);
lines.push(allComplete ? `=> COMPLETE: all granularities covered, ready for next steps`
                       : `=> INCOMPLETE: some granularities missing, re-sync needed`);
console.log(lines.join('\n'));
