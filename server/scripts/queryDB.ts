import { getDb } from '../db/getDb';
const db = getDb();
import { sql } from 'drizzle-orm';

async function run() {
  console.log("Clearing ALL optima and credibility to force the new relaxed parameters...");
  await db.run(sql`DELETE FROM strategy_optima`);
  await db.run(sql`DELETE FROM global_strategy_optima`);
  await db.run(sql`DELETE FROM strategy_credibility`);
  console.log("Cleared all.");
}
run();
