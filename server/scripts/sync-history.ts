// 独立数据同步脚本：绕过 dev server，直接操作本地 SQLite。
// 用法：
//   tsx server/scripts/sync-history.ts --index --full   # 全量同步指数(800天)
//   tsx server/scripts/sync-history.ts --stocks --full  # 全量重同步个股(800天)
//   tsx server/scripts/sync-history.ts --full           # 指数 + 个股全量
//   tsx server/scripts/sync-history.ts                  # 增量补数
import { getDb } from '../db/getDb.js';
import { syncOneStock, INDEX_CODES } from '../routes/sync.js';
import { stocks as stocksSchema } from '../db/schema.js';

const db = getDb(undefined);

const args = process.argv.slice(2);
const mode = args.includes('--full') ? 'full' : 'incremental';
const onlyIndex = args.includes('--index');
const onlyStocks = args.includes('--stocks');
const concurrency = Number(args.find((_, i, a) => a[i - 1] === '--concurrency')) || 3;

async function main() {
  const codes: string[] = [];
  if (!onlyStocks) codes.push(...INDEX_CODES);
  if (!onlyIndex) {
    const all = await db.select().from(stocksSchema).all();
    codes.push(...all.map((s: any) => s.marketCode));
  }

  console.log(`[${mode}] concurrency=${concurrency} 同步 ${codes.length} 个标的...`);
  const t0 = Date.now();
  let ok = 0, fail = 0;
  let cursor = 0;

  const worker = async (wid: number) => {
    while (cursor < codes.length) {
      const i = cursor++;
      const code = codes[i];
      try {
        await syncOneStock(code, db, { mode });
        ok++;
        if (ok % 10 === 0 || i === codes.length - 1) {
          console.log(`  [${ok + fail}/${codes.length}] ${code} OK (${((ok + fail) / codes.length * 100).toFixed(0)}%)`);
        }
      } catch (e: any) {
        fail++;
        console.error(`  [FAIL] ${code}: ${e.message}`);
      }
      const delay = Math.floor(Math.random() * 1200) + 600;
      await new Promise(r => setTimeout(r, delay));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n完成: 成功 ${ok}, 失败 ${fail}, 耗时 ${sec}s, 模式 ${mode}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
