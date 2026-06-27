// policy 层验证（直接调纯函数，避开 research.js 导入会拉起 worker 线程）
import { getDb } from '../db/getDb.js';
import { getPolicy, savePolicy, DEFAULT_POLICY, regimePosition } from '../lib/policy.js';
import { assessMarketTiming } from '../lib/marketTiming.js';
import { klineDaily } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';

const db = getDb();

const def = await getPolicy(db);
console.log('默认 policy:', { regimeBullPos: def.regimeBullPos, riskPerTrade: def.riskPerTrade, minRiskReward: def.minRiskReward, enabled: def.enabledStrategies.length });

const saved = await savePolicy(db, { regimeBullPos: 0.6, riskPerTrade: 0.008 });
console.log('写入后:', { regimeBullPos: saved.regimeBullPos, riskPerTrade: saved.riskPerTrade });

const reread = await getPolicy(db);
console.log('重读一致:', reread.regimeBullPos === 0.6 && reread.riskPerTrade === 0.008);

// assessMarketTiming 接受 positionMap
const idx = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300')).orderBy(asc(klineDaily.date)).limit(300).all() as any[];
const tDef = assessMarketTiming(idx, 'sh000300');
const tPol = assessMarketTiming(idx, 'sh000300', { bull: saved.regimeBullPos, range: saved.regimeRangePos, bear: saved.regimeBearPos });
console.log('timing regime=', tDef.regime, '默认maxPos=', tDef.maxPosition, 'policy下maxPos=', tPol.maxPosition, '(若regime=bull应=' + regimePosition(saved, tPol.regime) + ')');

// 恢复默认
await savePolicy(db, { regimeBullPos: DEFAULT_POLICY.regimeBullPos, riskPerTrade: DEFAULT_POLICY.riskPerTrade });
console.log('已恢复默认');
process.exit(0);
