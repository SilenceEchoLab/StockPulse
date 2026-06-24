## Champion System

当前最优策略：

research/champion/

所有新策略必须挑战Champion。

---

## Promotion Rule

满足以下条件才能晋级：

Sharpe > Champion + 5%

且

Max Drawdown 不恶化超过10%

且

Walk Forward 得分提升

否则失败。

---

## Anti-Lazy Rules

禁止：

* 只提出建议
* 不修改代码
* 不执行回测
* 不分析结果
* 不记录知识

禁止输出：

"可能会提升"

"理论上更好"

"应该有效"

必须提供实际验证结果。

---

## Anti-Overfitting Rules

必须进行：

Walk Forward Validation

训练集：

2018-2021

验证集：

2022

然后：

2019-2022

验证：

2023

然后：

2020-2023

验证：

2024

最终取平均值。

---

## Research Quality Score

每轮研究评分：

Hypothesis Quality

Experiment Quality

Novelty

Generalization

Performance Improvement

Knowledge Gain

低于60分：

视为低质量研究。

必须重新设计实验。

---

## Long-Term Goal

目标不是找到一个最佳参数。

目标是建立：

可持续进化的选股平台。

系统能力优先于单策略收益。
