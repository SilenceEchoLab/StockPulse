// 基本面估值分层 —— 对应《选股交易操作手册》第二步 2.4「基本面叠加」
// 用 PE/PB（来自 daily_snapshot，已同步）做估值分层，规避极端高估、偏好低估值。
//
// 说明：手册要求 ROE/营收增速/毛利率/产业资本增持等，这些需财务报表数据（外部数据源），
// 当前腾讯 qt 接口仅提供 PE/PB/市值，故先实现估值分层；ROE/营收等留待接入财务数据源后补全。

export type ValuationTier = 'undervalued' | 'fair' | 'overvalued' | 'loss' | 'unknown';

export interface ValuationAssessment {
  tier: ValuationTier;
  pe: number | null;
  pb: number | null;
  label: string;           // 展示标签
  confidenceAdj: number;   // 置信度调整：低估 +，高估 −，中性 0
  risk: 'none' | 'caution' | 'danger';
}

/**
 * 按 A 股常见区间对 PE/PB 分层。
 * 阈值为经验值（非原书硬性数字），用于趋势票的基本面避险叠加。
 */
export function assessValuation(pe: number | null, pb: number | null): ValuationAssessment {
  const hasPE = pe !== null && isFinite(pe) && pe > 0;
  const hasPB = pb !== null && isFinite(pb) && pb > 0;

  // 亏损股（PE 为负或无意义）→ 避险
  if (pe !== null && isFinite(pe) && pe <= 0) {
    return { tier: 'loss', pe, pb, label: '亏损股', confidenceAdj: -0.10, risk: 'caution' };
  }
  if (!hasPE && !hasPB) {
    return { tier: 'unknown', pe, pb, label: '估值数据缺失', confidenceAdj: 0, risk: 'none' };
  }

  // 极端高估：PE>80 或 PB>10
  if ((hasPE && pe! > 80) || (hasPB && pb! > 10)) {
    return { tier: 'overvalued', pe, pb, label: '高估值(泡沫风险)', confidenceAdj: -0.15, risk: 'danger' };
  }
  // 偏高：PE 50-80
  if (hasPE && pe! > 50) {
    return { tier: 'overvalued', pe, pb, label: '估值偏高', confidenceAdj: -0.08, risk: 'caution' };
  }
  // 低估：PE≤15 且 PB≤2
  if (hasPE && pe! <= 15 && (!hasPB || pb! <= 2)) {
    return { tier: 'undervalued', pe, pb, label: '低估值', confidenceAdj: +0.05, risk: 'none' };
  }
  // 合理区间
  return { tier: 'fair', pe, pb, label: '估值合理', confidenceAdj: 0, risk: 'none' };
}
