// 策略护栏（policy）—— 圆桌收敛的「用户可驭层」
// 机器（机制层）永不可自动放宽这些值；用户收紧立即生效、放宽需显式确认。
// recommender / backtest / 择时 均读取此层。

import { eq } from 'drizzle-orm';
import { strategyPolicy } from '../db/schema.js';

export interface StrategyPolicy {
  riskPerTrade: number;
  maxStockWeight: number;
  accountDrawdownHalt: number;
  haltCooldownDays: number;
  minRiskReward: number;
  enabledStrategies: string[];
  regimeBullPos: number;
  regimeRangePos: number;
  regimeBearPos: number;
  updatedAt: Date | null;
}

export const DEFAULT_POLICY: StrategyPolicy = {
  riskPerTrade: 0.01,
  maxStockWeight: 0.20,
  accountDrawdownHalt: 0.15,
  haltCooldownDays: 20,
  minRiskReward: 1.5,
  enabledStrategies: ['three_cycle', 'macd_cross', 'rsi_reversal', 'ma520'],
  regimeBullPos: 0.75,
  regimeRangePos: 0.50,
  regimeBearPos: 0.20,
  updatedAt: null,
};

// 圆桌（特涅夫）：护栏改三档预设，个人投资者一秒切换，复杂度藏引擎
export type PolicyPreset = 'conservative' | 'balanced' | 'aggressive';
export const POLICY_PRESETS: Record<PolicyPreset, Partial<StrategyPolicy>> = {
  conservative: {
    riskPerTrade: 0.005, maxStockWeight: 0.15, accountDrawdownHalt: 0.10,
    haltCooldownDays: 30, minRiskReward: 2.0,
    regimeBullPos: 0.50, regimeRangePos: 0.30, regimeBearPos: 0.10,
  },
  balanced: {
    riskPerTrade: 0.01, maxStockWeight: 0.20, accountDrawdownHalt: 0.15,
    haltCooldownDays: 20, minRiskReward: 1.5,
    regimeBullPos: 0.75, regimeRangePos: 0.50, regimeBearPos: 0.20,
  },
  aggressive: {
    riskPerTrade: 0.02, maxStockWeight: 0.30, accountDrawdownHalt: 0.20,
    haltCooldownDays: 10, minRiskReward: 1.2,
    regimeBullPos: 0.85, regimeRangePos: 0.65, regimeBearPos: 0.35,
  },
};

/** 探测当前 policy 最接近哪档预设（供前端高亮） */
export function detectPreset(p: StrategyPolicy): PolicyPreset | 'custom' {
  for (const k of Object.keys(POLICY_PRESETS) as PolicyPreset[]) {
    const preset = POLICY_PRESETS[k];
    const match = (Object.keys(preset) as (keyof StrategyPolicy)[])
      .every(k2 => Math.abs((p[k2] as number) - (preset[k2] as number)) < 1e-6);
    if (match) return k;
  }
  return 'custom';
}

/** 读取策略护栏：DB 覆盖默认值（缺字段回退默认，保证向后兼容） */
export async function getPolicy(db: any): Promise<StrategyPolicy> {
  const row = await db.select().from(strategyPolicy).where(eq(strategyPolicy.id, 1)).get() as any;
  if (!row) return { ...DEFAULT_POLICY };
  const parseArr = (v: any, fb: string[]) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim()) { try { const j = JSON.parse(v); return Array.isArray(j) ? j : fb; } catch { return v.split(',').map((x: string) => x.trim()).filter(Boolean); } }
    return fb;
  };
  const num = (v: any, fb: number) => (typeof v === 'number' && isFinite(v) ? v : fb);
  return {
    riskPerTrade: num(row.riskPerTrade, DEFAULT_POLICY.riskPerTrade),
    maxStockWeight: num(row.maxStockWeight, DEFAULT_POLICY.maxStockWeight),
    accountDrawdownHalt: num(row.accountDrawdownHalt, DEFAULT_POLICY.accountDrawdownHalt),
    haltCooldownDays: num(row.haltCooldownDays, DEFAULT_POLICY.haltCooldownDays),
    minRiskReward: num(row.minRiskReward, DEFAULT_POLICY.minRiskReward),
    enabledStrategies: parseArr(row.enabledStrategies, DEFAULT_POLICY.enabledStrategies),
    regimeBullPos: num(row.regimeBullPos, DEFAULT_POLICY.regimeBullPos),
    regimeRangePos: num(row.regimeRangePos, DEFAULT_POLICY.regimeRangePos),
    regimeBearPos: num(row.regimeBearPos, DEFAULT_POLICY.regimeBearPos),
    updatedAt: row.updatedAt ?? null,
  };
}

/** regime → 仓位上限 */
export function regimePosition(policy: StrategyPolicy, regime: 'bull' | 'range' | 'bear'): number {
  return regime === 'bull' ? policy.regimeBullPos : regime === 'bear' ? policy.regimeBearPos : policy.regimeRangePos;
}

/** 写入策略护栏（单例 upsert）。放宽类变更由调用方（路由）负责确认语义。 */
export async function savePolicy(db: any, partial: Partial<StrategyPolicy>): Promise<StrategyPolicy> {
  const cur = await getPolicy(db);
  const merged: StrategyPolicy = { ...cur, ...partial, updatedAt: new Date() };
  const row: any = {
    id: 1,
    riskPerTrade: merged.riskPerTrade,
    maxStockWeight: merged.maxStockWeight,
    accountDrawdownHalt: merged.accountDrawdownHalt,
    haltCooldownDays: merged.haltCooldownDays,
    minRiskReward: merged.minRiskReward,
    enabledStrategies: JSON.stringify(merged.enabledStrategies),
    regimeBullPos: merged.regimeBullPos,
    regimeRangePos: merged.regimeRangePos,
    regimeBearPos: merged.regimeBearPos,
    updatedAt: merged.updatedAt,
  };
  await db.insert(strategyPolicy).values(row)
    .onConflictDoUpdate({ target: strategyPolicy.id, set: row }).run();
  return merged;
}
