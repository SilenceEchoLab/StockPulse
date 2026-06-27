# AutoResearch 重新设计：策略副驾（圆桌收敛方案落定）

> 来源：2026-06-26 圆桌会议（西蒙斯/塔勒布/利弗莫尔/库珀/卡马克）。
> 纪要：`~/Documents/notes/20260626T222441--圆桌-AutoResearch重设计__roundtable.org`

## 重新定位

从「量化优化仪表盘」→ **「策略副驾：受护栏约束的自我演进闭环」**。

一句话不变量：
> **机制自主进化，策略用户可驭，过程全程可读，失败自动回退，永远让人看见尾巴。**

## 四支柱（圆桌收敛）

| 支柱 | 主张者 | 落地 |
|------|--------|------|
| **机制自主** | 西蒙斯/卡马克 | auto-cycle 自主跑优化→聚合→可信度→推荐（机制层无需人介入） |
| **策略可驭（policy）** | 卡马克/利弗莫尔 | `strategy_policy` 表：单笔风险/单股上限/回撤熔断/最低盈亏比/regime→仓位/策略开关。**机器永不可自动放宽** |
| **失败可退（revert）** | 西蒙斯 | 可证伪契约：新聚合 vs 在用版的样本外夏普对比，变差⇒自动回退 |
| **反脆弱（regime 分桶）** | 塔勒布 | `strategy_credibility_by_regime`：同策略按 bull/range/bear 分桶；推荐取当前 regime 桶 |
| **过程可读（changelog）** | 库珀/卡马克 | `research_changelog`：每次升级的不可伪造 diff（参数 before/after、回退标记、纪律复盘） |

## 代码落点

**后端**
- `server/lib/policy.ts`（新）：`getPolicy/savePolicy/regimePosition`，默认护栏 + DB 覆盖
- `server/lib/changelog.ts`（新）：`appendChangelog/getChangelog`
- `server/db/schema.ts`：新增 `strategy_policy`、`research_changelog`、`strategy_credibility_by_regime`
- `server/lib/marketTiming.ts`：`assessMarketTiming` 接收 `positionMap`（regime→仓位来自 policy）
- `server/lib/recommendationBacktest.ts`：新增 `byStrategyRegime` 归因 + `positionMap` 选项
- `server/lib/performanceTracker.ts`：`applyBacktestCredibility` 写 regime 分桶可信度（稀疏样本先验收缩 ×2）
- `server/routes/research.ts`：
  - `aggregateGlobalForAll` 实现回退契约（incumbent vs new 样本外夏普）+ 写 changelog
  - 新路由 `GET/POST /policy`、`GET /changelog`、`GET /credibility-by-regime`
  - 推荐/回放/auto-cycle 全部读 policy 护栏；可信度按当前 regime 取桶
  - `/resolve` 写纪律复盘 changelog
- `server/routes/market.ts`：`/timing` 读 policy 的 regime→仓位

**前端**（`src/pages/AutoResearch.tsx`）
- 重定位为「AutoResearch 策略副驾」，四区分层导航：
  - **决策与实验室**（默认）：原闭环流程/优化/全局策略/可信度/推荐/回放
  - **演进日志**（新）：changelog 时间线，type 色标（revert 红/update 绿/discipline 黄）
  - **护栏设置**（新）：policy 表单，可改风险参数/regime 仓位/最低盈亏比
  - **Regime 可信度**（新）：策略×regime 表，揭示同策略跨 regime 差异

## 闭环验证（2026-06-26，132 只真实数据）

- `GET /policy` 返回默认护栏 ✓
- `GET /credibility-by-regime` 10 行；**反脆弱证据**：three_cycle bull=0.566/range=0.743；macd_cross bull=0.38（低）/range=0.504——同策略在不同 regime 确实不同 ✓
- `POST /aggregate-global` 触发回退契约，**3/4 策略本轮回退** ✓
- 演进日志真实 diff：`revert | three_cycle: 样本外夏普 0.39 < 在用 0.45，已回退在用版` 等 ✓
- tsc + vite build 通过；dev server 路由实测正常 ✓

## 开放问题（后续）

- 纪律执行率：当前为"信号纪律"（触及止盈/止损的分布）；"交易纪律"（用户实际手动执行）需用户回填。
- regime 分桶稀疏样本：已用先验收缩 ×2 缓解；bull/bear 样本仍偏少，随闭环积累会改善。
- policy 放宽变更：当前直接生效；可加"确认+冷却"防情绪化松纪律。
- 历史回溯：changelog 仅记录改造后的新循环；历史无回填。
