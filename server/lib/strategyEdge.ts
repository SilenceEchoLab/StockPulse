// 策略生命力 primitive —— 圆桌收敛：AutoResearch 的 ONE feature
// 一次计算，多处消费（首页/AI选股/个股/AutoResearch 健康面板）。
// 设计原则（乔布斯/方三文）：用状态词不用 0-100 分数（防游戏化）；caveat 是主角（"最该警惕什么"）。

import { eq, desc, asc } from 'drizzle-orm';
import { strategyCredibility, strategyCredibilityByRegime, researchChangelog, klineDaily } from '../db/schema.js';
import { getPolicy } from './policy.js';
import { assessMarketTiming } from './marketTiming.js';

export type StrategyStatus = '脆弱' | '观察' | '可信' | '强劲';

export interface StrategyEdge {
  status: StrategyStatus;
  trend: 'up' | 'down' | 'flat';
  reason: string;          // 人话解释当前状态
  caveat: string;          // 主角：用户最该警惕什么（反直觉、高价值反馈）
  weakest: { strategy: string; credibility: number } | null;
  sampleN: number;         // 全策略真实样本总量（可信度底气）
  revertsRecent: number;   // 近 20 次升级中的回退次数（市场在变的信号）
  regime: 'bull' | 'range' | 'bear';
  enabledCount: number;
  asOf: string;
}

const REGIME_LABEL = { bull: '牛市', range: '震荡', bear: '弱势' } as const;

/**
 * 计算策略生命力。综合：可信度（当前 regime 分桶，回退到 all）+ 样本量 + 近期回退 + regime 落差。
 * 无外部依赖参数；regime 自动从大盘择时判定。
 */
export async function computeStrategyEdge(db: any): Promise<StrategyEdge> {
  const policy = await getPolicy(db);
  const enabled = policy.enabledStrategies;

  // 当前 regime（用 policy 的仓位映射）
  const idx = await db.select().from(klineDaily).where(eq(klineDaily.marketCode, 'sh000300'))
    .orderBy(asc(klineDaily.date)).limit(300).all() as any[];
  const regime: 'bull' | 'range' | 'bear' = idx.length >= 60
    ? assessMarketTiming(idx, 'sh000300', { bull: policy.regimeBullPos, range: policy.regimeRangePos, bear: policy.regimeBearPos }).regime
    : 'range';

  const allCred = await db.select().from(strategyCredibility).all() as any[];
  const regCred = await db.select().from(strategyCredibilityByRegime)
    .where(eq(strategyCredibilityByRegime.regime, regime)).all() as any[];

  // 每个启用策略的可信度：优先 regime 桶，回退 all
  const credOf = (s: string): number | null => {
    const r = regCred.find(c => c.strategy === s);
    if (r && r.blendedCredibility != null) return r.blendedCredibility;
    const a = allCred.find(c => c.strategy === s);
    return a?.blendedCredibility ?? null;
  };
  const allOf = (s: string): number | null => allCred.find(c => c.strategy === s)?.blendedCredibility ?? null;

  const rows = enabled.map(s => ({ strategy: s, cred: credOf(s), allCred: allOf(s) })).filter(x => x.cred !== null) as { strategy: string; cred: number; allCred: number | null }[];
  const avg = rows.length ? rows.reduce((s, x) => s + x.cred, 0) / rows.length : null;
  const avgAll = rows.length ? rows.reduce((s, x) => s + (x.allCred ?? x.cred), 0) / rows.length : null;
  const sampleN = allCred.reduce((s, c) => s + (c.realSampleCount || 0), 0);

  // 状态词（非分数）
  let status: StrategyStatus;
  if (avg === null) status = '脆弱';
  else if (avg < 0.35) status = '脆弱';
  else if (avg < 0.50) status = '观察';
  else if (avg < 0.70) status = '可信';
  else status = '强劲';

  // 趋势：当前 regime 均值 vs 全局均值（市场对策略友好度）
  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (avg !== null && avgAll !== null) {
    if (avg < avgAll - 0.08) trend = 'down';
    else if (avg > avgAll + 0.05) trend = 'up';
  }

  // caveat 主角：最弱策略 + regime 落差 + 回退频率
  const weakest = rows.length ? rows.slice().sort((a, b) => a.cred - b.cred)[0] : null;
  const recentLog = await db.select().from(researchChangelog).orderBy(desc(researchChangelog.createdAt)).limit(20).all() as any[];
  const revertsRecent = recentLog.filter(c => c.type === 'revert').length;

  const reason = avg === null
    ? '尚无足够的实战样本支撑可信度，引擎仍在积累（多跑几轮日常闭环）'
    : `${rows.length} 个启用策略在当前「${REGIME_LABEL[regime]}」环境平均可信度 ${(avg * 100).toFixed(0)}%，基于 ${sampleN} 笔样本`;

  const caveats: string[] = [];
  if (weakest && weakest.cred < 0.40) {
    caveats.push(`${weakest.strategy} 在当前环境可信度仅 ${(weakest.cred * 100).toFixed(0)}%，已被降权，注意其对推荐的影响`);
  }
  if (trend === 'down') {
    caveats.push(`当前市场环境下策略整体弱于历史平均，宜轻仓观望`);
  }
  if (revertsRecent >= 3) {
    caveats.push(`引擎近 20 次自我升级中回退 ${revertsRecent} 次——市场在变，策略正在重新校准`);
  }
  if (caveats.length === 0) caveats.push('各启用策略在当前环境表现稳健，暂无显著盲区');
  const caveat = caveats.join('；');

  return {
    status, trend, reason, caveat,
    weakest: weakest ? { strategy: weakest.strategy, credibility: weakest.cred } : null,
    sampleN, revertsRecent, regime, enabledCount: enabled.length,
    asOf: new Date().toISOString().slice(0, 10),
  };
}
