# 选股辅助能力优化 · 实施计划

> 基于 `docs/CODE_VS_MANUAL_GAP_ANALYSIS.md` 的差距分析，聚焦"选股辅助能力"打磨 + 回测闭环验证。
> 前置：Phase 1 已补齐 day/week/month/m5/m30/m60 全粒度数据同步，**60 分钟层所需数据已就绪**。

## 改造范围（按 ROI，本轮聚焦 P0+P1）

### P0-a　接通择时 → 仓位链 + 头寸反推（核心风控断点）
- **现状**：`marketTiming.maxPosition` 仅作展示文本；`generateRecommendation` 只收 `regime`，输出无 `positionSize`。
- **改造**：
  - `recommender.generateRecommendation` 增加入参 `maxPosition`、`accountEquity`、`riskPerTrade`（默认 0.01）。
  - 用手册头寸反推公式：`股数 = floor(账户×风险% ÷ (entry−stop) / 100) × 100`，再受 `单股上限 = 账户 × maxPosition × 20%` 约束（手册：单股≤20%）。
  - 输出 `positionSize`（股数）+ `positionValuePct`（占账户比例）。
  - `research.ts:361` 透传 `timing.maxPosition`；recommendations 表写 `position_size`（已加列）。
- **验收**：bear 市场 maxPosition=0.2 时单股仓位明显受限；头寸反推数值正确。

### P0-b　买入盈亏比门槛（期望值纪律）
- **现状**：算出 entry/stop/take 却不计算盈亏比，会推负期望交易。
- **改造**：`recommender` 计算 `riskReward = (tp−entry)/(entry−sl)`：
  - `riskReward < 1.5` → 不发 buy（降级 hold）；
  - `1.5 ≤ riskReward < 2` → 允许 buy 但置信度 ×0.7 降级；
  - `≥ 2` → 正常（手册要求 ≥2:1）。
- **验收**：回测中盈亏比 <1.5 的信号被过滤。

### P1-a　三周期共振接入真实 60 分钟层（"三周期"名副其实）
- **现状**：`scoreMultiCycle` 只有周线+日线，60 分钟层缺失；`resonant` 实为两周期。
- **改造**：`cycles.ts` 新增第三层入参 `intradayRows`（m60），判定 MACD 金叉 / 放量突破 / KDJ 超跌金叉；`resonant` 要求 `周线向上 + 日线结构成立 + 60分确认` 三层齐备。`recommender`/路由读取 m60 注入。
- **降级**：m60 数据缺失时退化为当前两周期逻辑，保持兼容。
- **验收**：有 m60 数据的个股 `resonant` 判定包含第三层。

### P1-b　组合级风控回测（账户级红线）
- **现状**：`recommendationBacktest` 等权组合，无单股集中度/总仓位/回撤熔断。
- **改造**：在引擎回放中，按入场日组合：
  - 单股权重 ≤ 20%；同日组合总仓位 ≤ 当日 `maxPosition`；
  - 等权分配剩余额度，超出额度的票跳过；
  - 账户层面累计回撤 ≥ 15% 时当周停手（手册 5.3）。
  - 输出含组合级回撤/夏普/实际占用仓位。
- **验收**：回测产出组合级 maxDrawdown、仓位占用曲线。

## 回测闭环验证（Task 16）
用 `backtestRecommendationEngine` 对同一批股票、同一历史区间，跑 **改造前 vs 改造后** 对比：
- 胜率、平均收益、月度夏普、最大回撤、交易笔数（门槛过滤后应减少但质量提升）。
- 断言：盈亏比门槛生效（低 RR 交易被剔除）、仓位链生效（bear 市仓位下降）。
- 产出 `docs/SELECTION_OPTIMIZATION_RESULTS.md` 验证报告。

## 不在本轮（P2/P3，留待后续）
基本面因子（ROE/营收，需新数据源）、分批/金字塔建仓、量价四象限补全、连板情绪周期。
