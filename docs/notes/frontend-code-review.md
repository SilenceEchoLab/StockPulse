# 前端代码审查报告 · StockPulse

> 审查范围:`src/` 目录下的页面、组件、lib 工具与全局样式
> 审查日期:2026-06-21
> 严重程度图例:**P0 紧急** / **P1 重要** / **P2 建议**
> 说明:本报告仅做分析,未修改任何业务代码。

---

## 总览

整体架构清晰(Vite + React 19 + React Router 7 + SWR + Tailwind v4),设计令牌(`index.css`)与基础组件(`Button`/`Card`)抽象到位,大部分页面有 loading/empty 状态。主要问题集中在:

1. **全应用无 ErrorBoundary**,任意渲染期异常会白屏;
2. **涨跌配色语义不一致**(图表用中国惯例红涨绿跌,文字 UI 用西方惯例绿涨红跌);
3. **无 API 层封装**,`fetch` 散落各处、`fetcher` 重复 4 份;
4. **无代码分割**,重型图表库(recharts / lightweight-charts)被首屏同步加载;
5. **`any` 泛滥、关键数据无类型**,`KlineData` 等接口重复定义;
6. **Settings 页样式令牌断裂**(`bg-panel` / `bg-dark` 未定义);
7. **大量 catch 静默吞错**,用户无任何失败反馈。

---

## A. 性能问题

### A1. [P1] 全应用无路由级代码分割(lazy load)

- **位置**:`src/App.tsx`
- **描述**:7 个页面全部在 `App.tsx` 顶部同步 `import`,其中 `Backtest.tsx` / `KLineChart.tsx` 依赖体积较大的 `lightweight-charts`,`Dashboard.tsx` 依赖 `recharts`。首屏(默认渲染 `MarketOverview`)被迫把这些重型库一并打进主 bundle,拖慢首屏加载。
- **建议**:用 `React.lazy()` + `<Suspense>` 对非首屏路由(`backtest`、`sync`、`settings`、`ai-picks`、`pool/:code`)做路由级分割,让 `lightweight-charts` / `recharts` 仅在访问对应页面时按需加载。

### A2. [P2] `filteredStocks` / `industries` 等派生数据每次渲染重算

- **位置**:`src/pages/StockPool.tsx`(约 `const filteredStocks = stocks.filter(...)`、`const industries = [...]`)
- **描述**:`filteredStocks`(全量过滤)、`industries`(基于 `new Set` 去重)、`totalPages` / `paginatedStocks`(slice)均未 `useMemo`,每次 parent/自身 re-render 都重算。300 只标的下尚可接受,但列表增长后会成为瓶颈。
- **建议**:对 `filteredStocks`、`industries`、`paginatedStocks` 用 `useMemo` 包裹,依赖 `[stocks, selectedIndustry, selectedView, searchTerm, currentPage]`。

### A3. [P2] `CustomTooltip` 定义在组件函数体内,每次渲染重建

- **位置**:`src/components/StockDetails.tsx`(`const CustomTooltip = ({ active, payload, label }: any) => {...}`)
- **描述**:`CustomTooltip` 作为内层组件在 `StockDetails` 每次渲染时重新创建,引用每次都变,会破坏下游图表组件(若 memo)的浅比较,并造成不必要的子树重渲染。
- **建议**:将 `CustomTooltip` 提取到模块顶层(或独立文件),接收 props。

### A4. [P2] `getFormatForChange` 类工具函数重复且每次重建

- **位置**:`src/pages/StockPool.tsx`、`src/components/StockDetails.tsx`
- **描述**:两个文件各自定义了逻辑几乎相同的 `getFormatForChange` / `getFormatForChangeBg`,且定义在组件体内(每次渲染重建)。`StockDetails` 内还混入大段关于"红涨绿跌"的注释和一段不可达的死代码(见 B6)。
- **建议**:抽到 `src/lib/format.ts`,导出纯函数,全应用复用。

### A5. [P2] `StockDetails` 每个详情页发起 3+ 串行请求,且"检查是否在自选"拉取整个池

- **位置**:`src/components/StockDetails.tsx`(3 个 `useEffect` + `checkPool`)
- **描述**:进入个股详情会并发触发:`/api/ai/sentiment/:code`、`/api/ai/signals/:code`、以及为了判断 `inPool` 而请求 **整个** `/api/pool` 再在前端 `includes()`。后者是明显的浪费:仅判断一只股票是否在池中,却拉取全部自选数据。
- **建议**:后端提供 `GET /api/pool/:code`(或 `/api/pool/has/:code`)返回布尔;前端 SWR 化该请求。

### A6. [P2] 轮询用 `setInterval` 而非流式推送

- **位置**:`src/pages/Dashboard.tsx`(同步中每 1s 轮询 `/api/sync/status`)
- **描述**:`syncState.status === "syncing"` 时每秒轮询状态。`Layout` 已经在用 SSE(`/api/alerts/stream`)做通知,说明后端具备 SSE 能力,同步进度同样可走 SSE,减少无效请求。
- **建议**:同步进度通过 SSE 推送,或至少把 1s 间隔放宽到 2~3s。

### A7. [P2] 布局未做组件级 memo 化

- **位置**:`src/components/Layout.tsx`、各列表行
- **描述**:`StockPool` 表格行、`MarketOverview` 龙虎榜行等直接 inline 渲染,行未抽成 memo 子组件。SWR 60s 刷新数据时,即便行内容未变也会整体重渲染。
- **建议**:将"行"抽成 `React.memo` 子组件(如 `StockRow`、`RankRow`),配合稳定的 `key`。

---

## B. Bug 与逻辑缺陷

### B1. [P0] 全应用无 ErrorBoundary,渲染异常即白屏

- **位置**:`src/App.tsx` / `src/main.tsx`
- **描述**:项目里搜不到任何 `ErrorBoundary` / `componentDidCatch`。图表库(`lightweight-charts`、`recharts`)或后端返回非预期结构时(大量 `any` 场景下极易发生),任一组件 render 抛错都会让**整个应用**白屏,且 `HashRouter` 下无法恢复。
- **建议**:在 `<Router>` 外层加一个全局 `ErrorBoundary`(带"回到首页/刷新"按钮);并对图表区域(`/pool/:code`、`/backtest`)单独再包一层局部 ErrorBoundary,避免图表崩溃拖垮整页。

### B2. [P1] 涨跌配色语义不一致(图表 vs 文字 UI)

- **位置**:
  - `src/index.css`:`--color-trading-up: #0ecb81`(绿)、`--color-trading-down: #f6465d`(红)
  - `src/components/KLineChart.tsx`:`colorUp = '#f23645'`(红涨)、`colorDown = '#1bb154'`(绿跌)
  - `src/components/StockDetails.tsx`、`StockPool.tsx`、`MarketOverview.tsx`:文字用 `text-trading-up`(绿)表示上涨
- **描述**:这是一个面向 A 股(沪深 300)的应用。K 线蜡烛图采用**中国惯例(红涨绿跌)**,但所有文字/数字 UI 却采用**西方惯例(绿涨红跌)**。同一只上涨股票,在详情页大字价格是**绿色**,切到 K 线却变成**红色**蜡烛,严重误导用户。`StockDetails.tsx` 中 `getFormatForChange` 里那段冗长的自我争论注释,正是这一混乱的遗留证据。此外 `StockDetails.tsx` 里定义的 `colorUp = "var(--color-trading-down)"` / `colorDown = "var(--color-trading-up)"` 实际是**死代码**(图表颜色由 `KLineChart` 自行管理,这两个变量未被使用)。
- **建议**:统一选一套语义。既然是 A 股产品,建议全应用统一为**红涨绿跌**:把 `--color-trading-up` 调整为红、`--color-trading-down` 调整为绿(或新增 `--color-up-a`/`--color-down-a` 令牌),并删除 `StockDetails` 中的死代码 `colorUp/colorDown` 与 `getFormatForChange` 内的不可达分支。

### B3. [P1] `catch (e) {}` 静默吞错,失败无任何用户反馈

- **位置**:
  - `src/pages/Dashboard.tsx`:`fetchSyncStatus`、`fetchOverview`、`handleCleanCache` 均为 `catch (e) {}` 空体
  - `src/pages/AiPicks.tsx`:`fetchPicks` 仅 `console.error(e)`,`addToPool` **完全没有 try/catch**
  - `src/pages/StockPool.tsx`:`addToPool`/`removeFromPool` 仅 `console.error`
  - `src/components/StockDetails.tsx`:`togglePool`/`createAlert` 仅 `console.error`
  - `src/components/Layout.tsx`:通知拉取 `.catch(console.error)`
- **描述**:大量关键操作(启停同步、清理缓存、加入自选、设置预警、导入)在请求失败时既不 `alert` 也不展示 toast,用户以为操作成功了。其中 `AiPicks.addToPool` 最严重:请求失败但 `setAddedCodes` 已把 code 标成"已加入",状态与后端不一致。
- **建议**:统一一个轻量 toast/通知机制(可复用 `StockDetails` 里的 `alertToast` 模式),在所有写操作失败时给用户反馈;`addToPool` 必须把 `setAddedCodes` 移到请求成功之后。

### B4. [P1] Settings 页样式令牌断裂(`bg-panel` / `bg-dark` 未定义)

- **位置**:`src/pages/Settings.tsx`(`bg-panel`、`bg-dark/50`、`border-white/5` 等)、`src/pages/StockDetail.tsx` 错误态(`bg-red-50 text-red-600 rounded-2xl`)
- **描述**:`@theme` 中只定义了 `canvas-dark`、`surface-card-dark` 等令牌,并未定义 `panel` 或 `dark` 颜色。Tailwind v4 下 `bg-panel` / `bg-dark` 不会生成任何样式,导致 Settings 整页背景/输入框背景**失效**(呈现透明/默认色),与其它深色页面视觉割裂。`StockDetail` 的错误回退用了浅色 `bg-red-50`/`text-red-600`,在深色主题里同样突兀。此外 Settings 大量使用 `text-gray-300/400/500/600` 默认色而非主题令牌。
- **建议**:Settings 页改用项目既有令牌(`bg-surface-card-dark`、`bg-canvas-dark`、`border-hairline-dark`、`text-muted` 等);`StockDetail` 错误态改用 `bg-trading-down/10 text-trading-down` 风格。

### B5. [P1] SSE `onmessage` 未做 JSON 容错,非 JSON 帧会抛错中断

- **位置**:`src/components/Layout.tsx`(`eventSource.onmessage`)
- **描述**:`const data = JSON.parse(event.data);` 没有 try/catch。SSE 通道常会发送心跳/注释行(如 `: keepalive`),一旦服务端推送了非 JSON 内容,`JSON.parse` 抛错会打断当前 `onmessage` 回调,虽然 EventSource 本身不重连失败,但该条消息的后续逻辑(更新通知、`new Notification`)被跳过。
- **建议**:用 try/catch 包裹 `JSON.parse`,解析失败时静默忽略。

### B6. [P2] `getFormatForChange` 含不可达死代码与误导性注释

- **位置**:`src/components/StockDetails.tsx`
- **描述**:函数体首行 `if (val > 0) return "text-trading-up";` 已提前返回,其后大段关于"红涨绿跌"的注释,以及第二个 `if (val > 0) return "text-trading-up";` 永远不会执行(死代码)。功能虽不出错,但极易让后续维护者误读配色逻辑。
- **建议**:清理注释与重复分支(与 B2 一并处理)。

### B7. [P2] `Dashboard` 轮询 `intervalId` 类型与未赋值清理

- **位置**:`src/pages/Dashboard.tsx`(`let intervalId: NodeJS.Timeout;` + `return () => clearInterval(intervalId);`)
- **描述**:浏览器环境 `setInterval` 返回 `number`,这里用 `NodeJS.Timeout` 类型标注不准确(仅因安装了 `@types/node` 才不报错)。且当 `syncState.status !== "syncing"` 时 `intervalId` 未赋值,`clearInterval(undefined)` 虽是 no-op,但语义不清。
- **建议**:类型改为 `ReturnType<typeof setInterval>`,并在条件分支外初始化。

### B8. [P2] `Backtest` / 列表用数组下标作 key

- **位置**:`src/pages/Backtest.tsx`(`result.trades?.map((t, i) => <tr key={i}>`)、`src/pages/Dashboard.tsx`(日志 `key={i}`)、`AiPicks` 信号 `key={idx}`
- **描述**:交易记录、日志等用索引作 key。这些列表不会重排,问题不大;但若后续支持过滤/排序,索引 key 会引发状态错乱。
- **建议**:优先用业务字段(日期+类型、时间戳等)作 key。

### B9. [P2] `AiPicks` 前端缓存永不失效

- **位置**:`src/pages/AiPicks.tsx`(模块级 `frontendCache`)
- **描述**:`frontendCache` 是模块级变量,跨路由切换命中后会一直展示旧 `picks`,没有 TTL。若用户上午生成、下午再来,仍可能看到"上午"的选股而日期未更新。
- **建议**:缓存条目带 `generatedAt`,命中时校验是否同日(或可接受时长),过期则重新静默检查。

### B10. [P2] `StockPool` 过滤切换后分页未归位

- **位置**:`src/pages/StockPool.tsx`(`if (currentPage > totalPages) setCurrentPage(1)`)
- **描述**:仅在当前页超出总页数时才回第 1 页。用户在第 5 页时改了搜索词/行业,若结果仍有 ≥5 页则停留在第 5 页(语境已变,体验割裂)。
- **建议**:任何过滤条件(`searchTerm`/`selectedIndustry`/`selectedView`/`activeGroupId`)变化时,主动重置 `currentPage = 1`。

---

## C. 用户体验问题

### C1. [P1] 无移动端导航(侧边栏不可折叠)

- **位置**:`src/components/Layout.tsx`(固定 `w-[220px]` 侧边栏 + 顶部搜索 `hidden sm:flex`)
- **描述**:侧边栏在小屏始终占据 220px,顶部搜索在 `< sm` 直接隐藏且无替代入口,移动端既无法收起菜单也无法搜索,可用性很差。
- **建议**:小屏下侧边栏改为抽屉式(汉堡按钮触发),搜索框在移动端提供独立入口或保留缩小版。

### C2. [P1] 大量写操作无成功反馈

- **位置**:见 B3。加入自选、移出分组、删除、导入、清理缓存等均无"成功"提示。
- **描述**:用户点击"删除自选"后表格行直接消失(或不变),没有 toast 确认,操作不放心、易误操作。
- **建议**:统一 toast 反馈成功/失败(成功可用 `StockDetails` 里 `alertToast` 同款绿色 toast)。

### C3. [P2] 危险操作仅用原生 `confirm`/`prompt`

- **位置**:`src/pages/Dashboard.tsx`(`confirm("确定要清理...")`)、`src/pages/StockPool.tsx`(`prompt('输入分组名称:')`)
- **描述**:清理全部 CSV 缓存这类高危操作用浏览器原生 `confirm`,与精心设计的深色 UI 风格割裂;新建分组用原生 `prompt`,无法校验、不可取消输入聚焦。
- **建议**:改用项目内联弹窗(可复用 `StockDetails` 的 `showAlertModal` / `StockPool` 的 `groupPickerCode` 同款 Modal)。

### C4. [P2] `Settings` 初始加载无 loading,字段会闪空

- **位置**:`src/pages/Settings.tsx`
- **描述**:`useEffect` 里 fetch 配置,期间表单显示空字符串,数据回来后值跳变。用户可能误以为配置为空并保存覆盖。
- **建议**:增加 `loading` 态,数据未就绪时表单 disabled 或显示骨架。

### C5. [P2] 表格无虚拟化(已用分页缓解)

- **位置**:`src/pages/StockPool.tsx`
- **描述**:每页 50 行已能避免一次性渲染过大列表,当前可接受。但若后续去掉分页或池规模大幅增长,缺少虚拟化方案会成为瓶颈。
- **建议**:保持分页;若未来要"无限滚动",再引入虚拟列表(如 `@tanstack/react-virtual`)。

### C6. [P2] `Backtest` 配置列在小屏不折叠

- **位置**:`src/pages/Backtest.tsx`(`w-[300px] shrink-0` 左栏 + flex 右栏)
- **描述**:窄屏下左栏固定 300px 不收缩,右侧结果区被严重挤压。
- **建议**:小屏下改为上下堆叠(`flex-col lg:flex-row`)。

---

## D. 代码质量

### D1. [P1] `any` 泛滥,API 响应与领域模型缺少类型

- **位置**:全仓(约 40+ 处 `: any` / `as any`),典型:
  - `Dashboard.tsx`:`overviewData: any`
  - `Backtest.tsx`:`result: any`、`equityCurve.map((d: any)...)`
  - `StockDetails.tsx`:`aiSentiment: any`、`signalReport: any`、`CustomTooltip` props `any`
  - `MarketOverview.tsx`:indices/industries/alerts 全 `any`
  - `Layout.tsx`:`notifications: any[]`、`searchResults: any[]`
- **描述**:`types.ts` 只定义了 `StockData`。`AIPick`、`KlineData`、`MarketOverview`、`Backtest` 结果、通知、分组等全部无共享类型,直接 `await res.json()` 当 `any` 用,失去了 TS 的核心价值,也是 B 系列运行时 bug 的温床。
- **建议**:在 `src/types.ts` 补齐 `AIPick`、`KlineData`、`MarketOverviewData`、`BacktestResult`、`Notification`、`Group`、`ApiResponse<T>` 等接口;fetch 处用 `const json: ApiResponse<T> = await res.json()`。

### D2. [P1] `fetcher` 重复定义 4 份

- **位置**:`src/pages/StockPool.tsx`、`src/pages/StockDetail.tsx`、`src/components/StockDetails.tsx`、`src/pages/MarketOverview.tsx`(四处完全相同的 `const fetcher = (url) => fetch(url).then(...)`)
- **描述**:完全相同的 SWR fetcher 复制粘贴四遍,后续要加统一错误处理/鉴权头/日志需改四处。
- **建议**:抽到 `src/lib/api.ts` 统一导出(见 E2)。

### D3. [P2] `KlineData` 接口在两处重复定义

- **位置**:`src/components/StockDetails.tsx`、`src/components/KLineChart.tsx`
- **描述**:两份 `KlineData`(字段还不完全一致:`KLineChart` 版多了 `ma5/10/20/60`)各自定义,维护时极易漂移。
- **建议**:合并到 `src/types.ts`,两处统一引用。

### D4. [P2] `StockDetails.tsx` 过大(~600 行),职责过多

- **位置**:`src/components/StockDetails.tsx`
- **描述**:单文件承担:顶部行情头、详情网格、K 线容器、AI 情绪卡、量化信号卡、主力资金卡、预警 Modal、Toast。可读性与可维护性差。
- **建议**:按区块拆分子组件(`StockHeader`、`StockStatGrid`、`AiSentimentCard`、`SignalReportCard`、`CapitalFlowCard`、`AlertModal`)。

### D5. [P2] 大量未使用的 import

- **位置**:`src/components/Layout.tsx`(约 11 个未用图标:`Star`、`HelpCircle`、`LineChart`、`Briefcase`、`Globe`、`Newspaper`、`Library`、`FileText`、`PieChart`、`Users`、`MessageSquare`)、`src/pages/Dashboard.tsx`(`ShieldCheck`、`RefreshCw` 未使用)
- **描述**:生产构建会被 tree-shake,但污染编辑体验、增加 review 噪音。
- **建议**:清理未使用 import;可在 `tsconfig` 开启 `"noUnusedLocals": true` 长效防护。

### D6. [P2] 数据获取策略不统一(SWR vs 原生 fetch)

- **位置**:`Dashboard`、`AiPicks`、`Backtest`、`Settings`、`Layout` 用原生 `fetch`;`StockPool`、`StockDetail`、`MarketOverview`、`StockDetails(kline)` 用 SWR
- **描述**:同一项目两套数据获取范式,缓存/重试/去重行为不一致,认知成本高。
- **建议**:读操作尽量统一收敛到 SWR(配合 D2 的统一 fetcher),写操作走封装的 mutation 辅助函数。

---

## E. 架构与设计

### E1. [P1] 无 API 调用层封装

- **位置**:全仓(每个组件各自 `fetch('/api/...')`)
- **描述**:不存在统一的 API 客户端。URL 字符串散落各处,没有:统一 base URL、请求/响应拦截、集中错误处理、鉴权头注入、请求取消(AbortController)。这与 D1/D2/B3 互相强化:无类型 + 无封装 + 无统一错误处理。
- **建议**:新建 `src/lib/api.ts`,提供:
  - 统一 `fetcher`(供 SWR);
  - `api.get/post/delete` 辅助,内置 `!res.ok` 抛错、JSON 解析、类型泛型;
  - 集中处理业务错误码(如 `AI_NOT_CONFIGURED`)。

### E2. [P2] 路由命名与文案不完全一致

- **位置**:`src/App.tsx`(`/sync` 渲染 `Dashboard`)、`src/components/Layout.tsx`(侧栏"数据控制台"、面包屑 `/pool`→"我的自选"但侧栏叫"核心股池")
- **描述**:`Dashboard` 挂在 `/sync` 语义不直观;侧栏、面包屑、页面 H1 三处对同一页面的称呼不完全统一("核心股池" vs "我的自选"、"投资大盘" vs `MarketOverview`)。
- **建议**:统一命名表(单一数据源),路由 slug 与展示文案对齐。

### E3. [P2] 缺少全局错误回退路由体验

- **位置**:`src/App.tsx`(`<Route path="*" element={<Navigate to="/" replace />} />`)
- **描述**:未匹配路由直接静默跳首页,用户不知道为何跳转。
- **建议**:可保留跳转,或提供一个轻量"页面不存在"提示后再跳。

---

## 优先级修复建议(汇总)

| 级别 | 编号 | 摘要 |
| --- | --- | --- |
| **P0** | B1 | 引入全局 + 局部 ErrorBoundary,避免渲染异常白屏 |
| **P1** | A1 | 路由级 `React.lazy` 代码分割,延迟加载图表库 |
| **P1** | B2 | 统一涨跌配色语义(图表与文字一致) |
| **P1** | B3 | 消除静默 catch,写操作失败/成功给 toast 反馈;修复 `addToPool` 状态错乱 |
| **P1** | B4 | 修复 Settings 页断裂的 `bg-panel`/`bg-dark` 等未定义令牌 |
| **P1** | B5 | SSE `JSON.parse` 加 try/catch 容错 |
| **P1** | C1 | 移动端侧边栏抽屉化 + 搜索入口 |
| **P1** | D1 | 补齐领域类型,消除 `any` |
| **P1** | D2 / E1 | 抽统一 API 层与 SWR fetcher |
| **P2** | A2~A7 | memo 化派生数据、提取 `CustomTooltip`、详情页精简请求、同步进度走 SSE |
| **P2** | B6~B10 | 清理死代码、修正类型、缓存 TTL、分页归位 |
| **P2** | C3~C6 | 原生 confirm/prompt 改内联 Modal、Settings loading、Backtest 响应式 |
| **P2** | D3~D6 | 合并重复接口、拆分大组件、清理未用 import、统一数据获取 |
| **P2** | E2~E3 | 统一路由/文案命名 |

---

*报告结束。本审查仅产出分析文档,未改动任何业务代码。*
