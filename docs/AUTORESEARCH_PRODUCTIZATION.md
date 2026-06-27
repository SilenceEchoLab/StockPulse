# AutoResearch 产品化重构：从仪表盘到「策略生命力 primitive」

> 来源：2026-06-26 产品经理圆桌（张小龙/乔布斯/特涅夫/科利森/方三文）。
> 纪要：`~/Documents/notes/20260626T231009--圆桌-AutoResearch产品化__roundtable.org`
> 上一版设计：`docs/AUTORESEARCH_REDESIGN.md`（四区仪表盘——本次被推翻）

## 核心转向（推翻上一版四区仪表盘）

圆桌收敛：**好产品不是堆砌功能，是直击痛点的一个功能 + 高价值反馈。** AutoResearch 的本质不是"给人盯的仪表盘"，而是**给系统用的能力（capability）**——其产出的「策略生命力」作为 primitive 注入全应用，页面本身降级为极简的"引擎健康面板"。

ONE feature = **策略生命力（StrategyEdge）**：一个状态词（非 0-100 分数，防游戏化）+ 一句人话 + **caveat 主角**（"你最该警惕什么"）。

```
   底层：自主进化引擎(后台无界面) → 产出 primitive
     ▼
   StrategyEdge { status: 脆弱|观察|可信|强劲, trend, reason, caveat(主角), sampleN, asOf }
     ├── 首页（生命力角标，可点入 AutoResearch）
     ├── AI选股（横幅带生命力）
     └── AutoResearch 页（一屏四物 · 引擎健康面板）
            ① 引擎心跳  ② 生命力+caveat  ③ 最近一次升级  ④ 证据折叠
   护栏：保守/平衡/激进 三档预设（取代数字输入框）
```

## 代码落点

**后端**
- `server/lib/strategyEdge.ts`（新）：`computeStrategyEdge(db)` 综合可信度(regime分桶)+样本量+近期回退+regime落差 → `{ status, trend, reason, caveat, weakest, sampleN, revertsRecent, regime, asOf }`。**状态词不用 0-100**（乔布斯）；**caveat 是主角**（方三文）。
- `server/lib/policy.ts`：新增 `POLICY_PRESETS`（保守/平衡/激进）+ `detectPreset`。
- `server/routes/research.ts`：
  - `GET /api/research/strategy-edge`（primitive，多处消费）
  - `GET /api/research/policy` 返回 `preset`（当前匹配档位）
  - `POST /api/research/policy/preset`（一秒切换三档）

**前端**
- `src/pages/AutoResearch.tsx`（**推翻重构**）：四区仪表盘 → 一屏四物 HERO 面板（心跳/生命力+caveat/最近升级/证据折叠）+ 三档护栏预设 + 折叠「策略实验室」（原优化/回放/推荐，高级用户展开）。
- `src/pages/MarketOverview.tsx`：首页注入生命力角标（链接到 AutoResearch）。
- `src/pages/AiPicks.tsx`：AI选股横幅带生命力。

## 闭环验证（2026-06-26）

- `GET /strategy-edge`：`status=观察 trend=up regime=bull reverts=3`；caveat="macd_cross 可信度仅 38%，已被降权；引擎近 20 次升级回退 3 次——市场在变，策略正在重新校准" ✓
- `POST /policy/preset conservative`：riskPerTrade=0.005 / minRiskReward=2 / bearPos=0.1 ✓
- `GET /policy`：preset=conservative（正确识别）✓
- tsc + vite build 通过；dev server 路由实测正常 ✓

## 设计原则（圆桌留痕）

- **乔布斯**：状态词不用 0-100（防游戏化）；"focus is saying no"——砍掉四区，只留一屏四物。
- **方三文**：caveat 是主角（"最该警惕什么"才是反直觉、高价值、值得每天回来看的反馈）。
- **科利森**：AutoResearch 是 primitive/page 二分——生命力一次计算、多处消费。
- **特涅夫**：护栏三档预设（个人投资者不填 0.01）；复杂度藏引擎。
- **张小龙**：用完即走——一屏三秒拿到生命力 + caveat。

## 开放问题（后续）

- 个股级生命力：当前 primitive 是全局的；个股注入暂用全局生命力作上下文，per-stock 覆盖需 per-stock 可信度（待数据积累）。
- caveat 润色：首版从数据自动拼装；未来可接 AI 复盘教练生成更自然的"一句话"。
- status 阈值标定：脆弱/观察/可信/强劲 的分界用经验值，随样本积累校准。
