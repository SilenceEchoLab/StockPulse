// 绩效追踪引擎 —— AutoResearch 闭环的数据反馈层
//
// 职责：扫描所有 active 的买入推荐，用最新 K 线判定是否触及止盈/止损/过期，
// 结算实际收益并回写 returnPct/holdDays/status，形成策略优化的反馈数据。

import { eq, and, lte, sql } from 'drizzle-orm';
import { klineDaily, recommendations } from '../db/schema.js';

const DEFAULT_MAX_HOLD = 30; // 默认最大持仓天数

export interface ResolveResult {
  resolved: number;
  hitTP: number;
  hitSL: number;
  expired: number;
}

/**
 * 结算所有 active 买入推荐
 * 对每条推荐读取推荐日之后的 K 线，检查是否触及止盈/止损/时间过期
 */
export async function resolveRecommendations(db: any): Promise<ResolveResult> {
  const active = await db.select().from(recommendations)
    .where(and(
      eq(recommendations.status, 'active'),
      eq(recommendations.action, 'buy')
    ))
    .all() as any[];

  let hitTP = 0, hitSL = 0, expired = 0;

  for (const rec of active) {
    if (!rec.entryPrice || rec.entryPrice <= 0) continue;

    // 读取推荐日之后的所有 K 线（含当日）
    const klines = await db.select().from(klineDaily)
      .where(and(
        eq(klineDaily.marketCode, rec.marketCode),
        sql`date >= ${rec.date}`
      ))
      .orderBy(sql`date ASC`)
      .all() as any[];

    if (!klines || klines.length === 0) continue;

    const entryIdx = klines.findIndex(k => k.date === rec.date);
    // 从推荐日后一天开始检查（推荐日 T+1 成交）
    const startIdx = entryIdx >= 0 ? entryIdx + 1 : 0;
    const futureKlines = klines.slice(startIdx);

    if (futureKlines.length === 0) continue;

    const tp = rec.takeProfit;
    const sl = rec.stopLoss;
    const maxHold = DEFAULT_MAX_HOLD;

    let resolved = false;
    let resolvedPrice: number | null = null;
    let status: string = 'active';
    let holdDays = 0;

    for (let i = 0; i < futureKlines.length; i++) {
      const day = futureKlines[i];
      holdDays = i + 1;

      // 检查止盈：日内最高价 >= 止盈价
      if (tp && day.high >= tp) {
        resolvedPrice = tp;
        status = 'hit_tp';
        resolved = true;
        break;
      }
      // 检查止损：日内最低价 <= 止损价
      if (sl && day.low <= sl) {
        resolvedPrice = sl;
        status = 'hit_sl';
        resolved = true;
        break;
      }
      // 时间过期
      if (holdDays >= maxHold) {
        resolvedPrice = day.close;
        status = 'expired';
        resolved = true;
        break;
      }
    }

    if (resolved && resolvedPrice !== null) {
      const returnPct = (resolvedPrice - rec.entryPrice) / rec.entryPrice;
      await db.update(recommendations).set({
        status,
        resolvedPrice: Math.round(resolvedPrice * 100) / 100,
        returnPct: Math.round(returnPct * 10000) / 10000,
        holdDays,
        resolvedAt: new Date(),
      }).where(eq(recommendations.id, rec.id)).run();

      if (status === 'hit_tp') hitTP++;
      else if (status === 'hit_sl') hitSL++;
      else expired++;
    }
  }

  const total = hitTP + hitSL + expired;
  return { resolved: total, hitTP, hitSL, expired };
}

/**
 * 汇总推荐绩效统计，供仪表盘和 AI 复盘使用
 */
export async function getPerformanceStats(db: any) {
  const stats = await db.select({
    total: sql`count(*)`,
    active: sql`sum(case when status = 'active' then 1 else 0 end)`,
    resolved: sql`sum(case when status != 'active' then 1 else 0 end)`,
    hitTP: sql`sum(case when status = 'hit_tp' then 1 else 0 end)`,
    hitSL: sql`sum(case when status = 'hit_sl' then 1 else 0 end)`,
    expired: sql`sum(case when status = 'expired' then 1 else 0 end)`,
    avgReturn: sql`avg(case when return_pct is not null then return_pct end)`,
    avgHoldDays: sql`avg(case when hold_days is not null then hold_days end)`,
    winRate: sql`sum(case when return_pct > 0 then 1 else 0 end) * 1.0 / nullif(sum(case when return_pct is not null then 1 else 0 end), 0)`,
  }).from(recommendations).get();

  // 按策略分组
  const byStrategy = await db.select({
    strategy: recommendations.strategy,
    total: sql`count(*)`,
    winRate: sql`sum(case when return_pct > 0 then 1 else 0 end) * 1.0 / nullif(sum(case when return_pct is not null then 1 else 0 end), 0)`,
    avgReturn: sql`avg(return_pct)`,
  }).from(recommendations)
    .where(sql`return_pct is not null`)
    .groupBy(recommendations.strategy)
    .all();

  return { overview: stats, byStrategy };
}
