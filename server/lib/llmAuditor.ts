// LLM 审计员（反方辩护人）—— 圆桌卡帕西/洛佩斯·德·普拉多/阿伦森收敛
// 复用系统已配置的大模型（getAiClient），不预测股价，只做：①反过拟合批判（基于 deflated Sharpe）
// ②把指标翻译成个人投资者的人话。始终标注"解读非证据"。LLM 不可用时降级为规则解读。

import { getAiClient, getAiModel } from '../ai/index.js';
import { desc } from 'drizzle-orm';
import { globalStrategyOptima, researchChangelog } from '../db/schema.js';
import { getPolicy } from './policy.js';
import { computeStrategyEdge } from './strategyEdge.js';

export interface AuditResult {
  critique: string;     // 反方批判 + 通俗解读（人话，含"解读非证据"标注）
  model: string;        // 使用的模型（空=降级）
  fallback: boolean;    // true=LLM 不可用，降级为规则生成
  deflatedAvg: number | null;
  edgeStatus: string;
}

export async function auditStrategyLab(c: any, db: any): Promise<AuditResult> {
  // 收集上下文：全局策略(含 deflated Sharpe) + 当前生命力 + 最近 changelog + 护栏
  const globals = await db.select().from(globalStrategyOptima)
    .orderBy(desc(globalStrategyOptima.stabilityScore)).all() as any[];
  const edge = await computeStrategyEdge(db);
  const log = await db.select().from(researchChangelog)
    .orderBy(desc(researchChangelog.createdAt)).limit(8).all() as any[];
  const policy = await getPolicy(db);

  const deflatedAvg = globals.length
    ? globals.reduce((s, g) => s + (g.avgDeflatedSharpe ?? 0), 0) / globals.length
    : null;

  const ctx = `
当前大盘 regime: ${edge.regime}
策略生命力: ${edge.status}（趋势 ${edge.trend}，样本 ${edge.sampleN}，近期回退 ${edge.revertsRecent} 次）
全局策略 deflated Sharpe 均值: ${deflatedAvg != null ? deflatedAvg.toFixed(2) : '未知'}（>0=多重检验后仍有 edge；<0=很可能是数据挖掘噪声）
各策略 deflated Sharpe: ${globals.map(g => `${g.strategy}=${(g.avgDeflatedSharpe ?? 0).toFixed(2)}`).join(', ')}
最近升级记录: ${log.slice(0, 5).map(l => l.message).join(' | ') || '无'}
护栏: 单笔风险 ${policy.riskPerTrade * 100}%，最低盈亏比 ${policy.minRiskReward}
规则生成的 caveat: ${edge.caveat}
`;

  try {
    const ai = await getAiClient(c);
    const model = await getAiModel(c);
    const completion = await ai.chat.completions.create({
      model: model || 'gpt-4o-mini',
      temperature: 0.4,
      messages: [{
        role: 'system',
        content: `你是这个量化策略引擎的「反方辩护人」(devil's advocate)。职责只有两条：①指出当前 edge 可能是过拟合/regime 特定/数据挖掘的嫌疑——若 deflated Sharpe<0，必须明确说"多重检验校正后无显著 edge，当前表现很可能是噪声"；②把上面这些指标翻译成 A 股个人投资者一听就懂的一句话。
铁律：绝不预测股价、绝不给具体买卖点或个股推荐；80-150 字中文；结尾必须附"（解读非证据，edge 显著性以 deflated Sharpe 为准）"。
数据上下文:
${ctx}`,
      }],
    });
    return {
      critique: completion.choices[0]?.message?.content || '',
      model: model || 'gpt-4o-mini', fallback: false,
      deflatedAvg, edgeStatus: edge.status,
    };
  } catch (e: any) {
    // LLM 不可用 → 降级为基于 deflated Sharpe 的规则解读
    const low = deflatedAvg != null && deflatedAvg < 0;
    const critique = low
      ? `多重检验校正后 deflated Sharpe 为负(${deflatedAvg!.toFixed(2)})——当前"edge"很可能是数据挖掘噪声而非真 alpha，建议对各策略降权、轻仓观望。${edge.caveat}（解读非证据，edge 显著性以 deflated Sharpe 为准）`
      : `各策略 deflated Sharpe 均值 ${deflatedAvg?.toFixed(2) ?? '未知'}，多重检验后 ${deflatedAvg != null && deflatedAvg > 0 ? '仍有一定 edge' : 'edge 不明确'}。${edge.caveat}（解读非证据，edge 显著性以 deflated Sharpe 为准）`;
    return { critique, model: '', fallback: true, deflatedAvg, edgeStatus: edge.status };
  }
}
