# 策略实验室评审落定：过拟合四层防线 + LLM 反方辩护人

> 来源：2026-06-26 量化+AI 圆桌（洛佩斯·德·普拉多/法马/欧内斯特·陈/阿伦森/卡帕西）。
> 纪要：`~/Documents/notes/20260626T233729--圆桌-策略实验室评审__roundtable.org`

## 核心结论

策略实验室这套「网格搜索→walk-forward→调和均值→全局聚合→贝叶斯可信度→回放→回退」的机器，**一直在找 alpha，但缺过拟合的判定地基**。圆桌收敛：判断 alpha vs 过拟合需**四层防线**，此前只有半道（工程层且太慢）。本轮补齐**数学层（deflated Sharpe）+ 认知层（LLM 反方辩护人）**。

## 四层防线（现状）

```
   数学层  deflated Sharpe/PBO(多重检验校正)  [本轮补齐] ← López de Prado 地基
   统计层  permutation/bootstrap(优于随机)     [后续]    ← Aronson
   工程层  样本外崩塌→可信度降权→回退          [已有,提速] ← Chan
   认知层  LLM 反方辩护人(元层/语义批判)       [本轮补齐] ← Karpathy
   底线    技术策略 alpha 多为幻觉              ← Fama
```

## LLM 的正确定位（研究员，非预言家）

| 角色 | 价值 | 风险 | 状态 |
|------|------|------|------|
| ②结果解读 → caveat 主角 | 高 | 低 | ★已落地 |
| ③反过拟合批判（元层/语义层） | 高 | 中 | ★已落地 |
| ①假设生成 → 严验通道 | 中 | 高（叙事 mining） | 后续 |
| ✗预测股价 | — | LLM 语料=噪声 | 不做 |

铁律：**LLM 解读必须标注"解读非证据"，edge 显著性以 deflated Sharpe 为准**（法马）。

## 代码落点

**数学层**
- `server/lib/backtestEngine.ts`：`deflatedSharpeRatio()`（Bailey-López de Prado 2014，含 Lo(2002) 偏度/峰度校正的 SR 方差）；`BacktestMetrics.deflatedSharpe`；`BacktestConfig.trials`（多重检验试验数）。
- `optimizeStock` 传 `trials: combos.length`。
- schema：`strategy_optima.test_deflated_sharpe`、`global_strategy_optima.avg_deflated_sharpe`。
- `autoResearch.aggregateGlobalOptima` 聚合 `avgDeflatedSharpe`。

**认知层（LLM 审计员）**
- `server/lib/llmAuditor.ts`（新）：`auditStrategyLab(c, db)` 复用 `getAiClient`（系统配置的大模型），读 全局 deflated Sharpe + StrategyEdge + changelog + 护栏 → 反方批判 + 通俗解读。LLM 不可用 → 降级为规则解读（基于 deflated Sharpe 符号）。
- 路由 `POST /api/research/audit`：调审计 + 写 changelog(type=audit)。
- changelog 类型扩展 `audit`。

**前端**
- `AutoResearch.tsx` HERO 加「反方审计」按钮 + 解读展示（标注降级/解读非证据）。

## 闭环验证（2026-06-26）

- **deflated Sharpe 数学正确**：raw sharpe=-0.267；trials=25 → deflated=-1.817（多重检验严厉下调）；trials=1 → -0.267（无校正）。试越多越保守 ✓
- **LLM 审计员真实调用系统配置模型**（mimo-v2.5-pro），给出真正的过拟合批判：
  > "当前所有策略的 deflated Sharpe 均为 0，经多重检验校正后没有任何证据显示这些策略存在可盈利的'真实优势'，其历史表现极可能是数据挖掘产生的噪声……像'纸老虎'，回测时看着厉害，一实战就露馅。"
  并自动引用 regime 可信度(38%)+回退次数。写入 changelog(type=audit) ✓
- tsc + vite build 通过；dev server 实测正常 ✓

> 注：首次审计时 global_strategy_optima.avg_deflated_sharpe=0（历史 optima 在加列前存储，无 deflated 值）。重新运行一次策略优化后，真实 deflated Sharpe 会落库，审计批判将更精准。

## 开放问题（后续）

- **permutation test**（统计层）：打乱标签重跑给"优于随机的概率"，计算成本高，首版延后。
- **LLM 假设生成通道**：LLM 出策略假设 → 经同等 walk-forward 严验才入库（防叙事 mining）。
- deflated Sharpe 的 trials 精确计入：首版用参数组合数，可扩展到 ×策略数×股票数。
- 现有历史 optima 需重跑一次优化以填充 deflated 列。
