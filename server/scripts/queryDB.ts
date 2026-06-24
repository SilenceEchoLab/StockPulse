import { getDb } from '../db/getDb';
const db = getDb();
import { strategyOptima, globalStrategyOptima } from '../db/schema';
import { sql } from 'drizzle-orm';

async function run() {
  console.log("Clearing old optima to force the new relaxed parameters...");
  await db.run(sql`DELETE FROM strategy_optima`);
  await db.run(sql`DELETE FROM global_strategy_optima`);
  console.log("Cleared.");
}
run();
