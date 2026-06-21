# 后端代码审查报告 — StockPulse (CSI-300 Stock Tracker)

审查范围:`server/index.ts`、`server/routes/*.ts`(11 个路由)、`server/lib/*.ts`(4 个 lib)、`server/db/*.ts`、`server/dev.ts`、`server/worker.ts`,并交叉对照 `drizzle/0000_mean_lizard.sql` 迁移。

严重程度定义:
- **P0 紧急**:影响线上正确性、数据完整性或安全,需立即修复
- **P1 重要**:明显 bug、性能瓶颈或可被利用的缺陷,本迭代内修复
- **P2 建议**:可维护性、架构演进、长期风险

---

## A. 性能问题

### A1. 数据库索引完全缺失,K 线/快照查询走全表扫描 — **P0**
- 位置:`server/db/schema.ts`(及 `drizzle/0000_mean_lizard.sql`)
- 现象:
  - `kline_daily` / `kline_min` / `daily_snapshot` / `stock_groups_link` / `notifications` 都**没有任何二级索引**,仅靠主键(复合主键第一列才是有效前缀)。
  - 但路由大量按非主键前缀查询,例如:
    - `server/routes/kline.ts:6` `where(eq(klineDaily.marketCode, code)).orderBy(desc(klineDaily.date))`(以 marketCode 开头,可用 PK)
    - `server/routes/sync.ts` 的增量同步:`where(and(eq(marketCode), eq(date)))`(复合 PK 命中,但 `orderBy(desc(date))` 在 D1 下仍可能扫整组)
    - `server/routes/ai.ts:99` 全局 `db.select().from(klineDaily).where(gte(date, cutoff))` + 全表扫 `dailySnapshot`,**完全无法走索引**(date 不是任何索引的前缀),沪深 300 全量下数据量约 `300 × 120 ≈ 3.6 万`行,每次选股全表加载。
    - `server/routes/notifications.ts:7` `orderBy(desc(createdAt))`,无 `created_at` 索引 → 通知变多后排序成本飙升。
- 建议:
  - 为 `kline_daily(market_code, date)` 显式声明 index,保证 D1 也建出索引(schema.ts 当前**完全没声明** `index`,与迁移文件一致,但与代码作者注释暗示的"有索引"不一致)。
  - 为 `daily_snapshot(market_code, date)`、`notifications(created_at desc)`、`alerts(is_active)` 已有索引但**没在 `kline_daily` 上声明任何辅助索引**;给按 `date` 范围 + marketCode 排序的查询加联合索引。
  - 对 `ai.ts` 的 `/picks` 改为先 `select max(date)` 再 `where(marketCode in [...], date = latest)`,而不是 `where(gte(date, cutoff))` 全表扫。

### A2. `/api/sync/start` 使用模块级全局 `syncProcess` 单例,Cloudflare Workers 下彻底失效 — **P0**
- 位置:`server/lib/state.ts`、`server/routes/sync.ts:64`(runScraper)、`server/index.ts` pollAlerts
- 现象:
  - `syncProcess` / `aiPicksCache` / `stockCache` / `alertClients` 都是**进程内内存**。Worker 模型下每个请求可能落到不同 isolate,`/sync/start` 异步执行后,客户端从其它 isolate 调 `/sync/status` 会拿到**初始空状态**(看似永远 idle)。
  - 同样 `pollAlerts` 由 `scheduled()` cron 触发,但写入 `notifications` 后通过 `alertClients` 推 SSE;`alertClients` 是**触发告警的 isolate 内**的客户端集合,与用户 SSE 连接所在的 isolate 不是同一个 → **SSE 实时推送在 serverless 下几乎不工作**(注释里已经写了这一点,但仍是真问题)。
  - `runScraper` 一旦触发会启动长达数十分钟(沪深 300、并发 1、随机延迟 1-3 秒 → 最少 5-15 分钟)的 `Promise.all`,Workers 单次执行 CPU 时间 + wall-clock 都有上限,会被 kill。`c.executionCtx.waitUntil(promise)` 也救不了,它只是延长响应后处理,不保证长任务跑完。
- 建议:
  - 短期:在 `README` 和代码里明确"同步仅在本地 dev(`pnpm dev`)下可用",并在 `/sync/start` 检测到 `c.env?.stockpulse_db` 时直接拒绝(`503 Service Unavailable`)。
  - 中期:把同步状态、`syncProcess`、`aiPicksCache` 迁到 D1 表或 Durable Object;告警推送改用 `notifications` 表轮询或 Durable Object 的 WebSocket / Durable Object Alarm。
  - 长期:把全量同步切成队列任务(Cloudflare Queues)。

### A3. `/api/ai/picks` 内置内存缓存无过期、无上限,且 serverless 下不稳定 — **P1**
- 位置:`server/lib/state.ts:25` `aiPicksCache = new Map<string, any>()`;`server/routes/ai.ts:90` `aiPicksCache.set(cacheKey, resultData)`
- 现象:
  - 仅按 `${strategy}_${today}` 作 key set,**从不 delete**,长期运行内存单调增长;在 isolate 重启后丢失,又没有 DB 兜底 → 用户体验不稳定。
  - `stockCache`(在 `tencent.ts:47`)有 10s TTL 但**没有 LRU 上限**,被请求过的每个 code 都会驻留一份(沪深 300 + 指数 ≈ 304 条,每条几十字节,量级可控,但仍应加上限)。
- 建议:
  - `aiPicksCache` 改成落库到 `ai_picks`(新表:`strategy, date, payload JSON, updatedAt`)或复用 `settings`;并在读取时校验 `date === today`。
  - `stockCache` 加上 `Map` 大小上限(如 500),溢出时按 FIFO 淘汰。

### A4. `/api/backtest/run` 每次请求重复整段计算,无分页、无截断 — **P1**
- 位置:`server/routes/backtest.ts:21` 起
- 现象:
  - 一次请求对 `codes` 数组里**每只股票**回测**整段**日线,响应同时包含 `trades`(每笔交易)和 `equityCurve`(每日净值)。沪深 300 × 多年 = 数十万行 `trades`/`equity`,JSON 响应可能上百 MB,既慢又可能把 Workers 的响应体打爆(Workers 单响应默认 100MB 但内存峰值先爆)。
  - 同一 `codes + strategy + dateRange` 不做缓存,反复点"运行回测"会反复全量计算。
  - `for (const code of codes) { ... }` 是串行的,本可以 `Promise.all` 并行(纯计算 + 仅读不写)。
- 建议:
  - 响应里只返回 `metrics` + 最近 N 笔 `trades` 与按周/月降采样的 `equityCurve`;完整明细另开 `/api/backtest/run/:jobId/trades`。
  - 加上结果缓存(同 strategy + codes + range hash → 缓存 1 小时)。
  - 把每只股票的回测 `Promise.all` 并行。

### A5. `/api/ai/sentiment/:code` 每次都重新拉取全 60 天 K 线且无缓存 — **P2**
- 位置:`server/routes/ai.ts:36`
- 现象:即使缓存命中(4 小时内),前几行先查 `aiSentiment` 然后直接 `return`,没问题;但**未命中时**会跑 `select * from kline_daily where marketCode = ? order by date desc limit 60`,然后 `.reverse()` 在内存里翻转 — 30+ 列宽行 × 60 条 × 每次用户刷新都查一次,可改 `order by asc` 直接取出。
- 建议:查询用 `orderBy(asc(klineDaily.date)).limit(60)`,但要在前面再 `orderBy(desc).limit(60)` 子查询里取最近 60 行(或在应用层切片),避免内存翻转。

### A6. `scoreContrarian` 与 `detectSignals` 重复调用 `scoreStock` — **P2**
- 位置:`server/lib/signalEngine.ts:236`、`signalEngine.ts:325`
- 现象:
  - `scoreContrarian(rows)` 内部先 `const base = scoreStock(rows);` 用其 `breakdown` / `signals`,然后又**完全独立**地重算一遍指标和得分(`score` 是 0 起算,与 base 完全无关),其实只是用 `base.breakdown` 当占位。
  - `detectSignals(rows)` 内部又调用 `scoreStock(rows)` 第三次,每次都重算 MA / vol avg。
  - 在 `/api/ai/picks` 里对 300 只股票循环调 `scoreStock` / `scoreContrarian`,然后再走 AI;在 `/api/ai/signals/:code` 里又走 `detectSignals`。**同一份 K 线被多遍计算 MA/avgVol5**。
- 建议:抽 `prepare(rows)` 一次性算出 `ma5..ma250, rsi, macd, kdjJ, bias6, avgVol5, prevMa*`,三个入口共享该 prepared 对象。

### A7. `/api/market/overview` 一次性加载全部 `stocks` 表元数据 — **P2**
- 位置:`server/routes/market.ts:19` `const pool = await db.select().from(stocksSchema).all();`
- 现象:每次请求都把整个 stocks 表(沪深 300 + 用户导入股票)读进内存构建 `metaMap`。300 行量级可接受,但若用户后续导入更多股票会逐步变慢。
- 建议:加服务端缓存(与 `stockCache` 同 TTL)或加 `Cache-Control: max-age=10`。

### A8. `/api/sync/start` 在 Worker 里返回 `waitUntil(promise)` 后立即 `return`,但 dev server 完全忽略 promise — **P2**
- 位置:`server/routes/sync.ts:160`
- 现象:`const promise = runScraper(...)` 后,`c.executionCtx.waitUntil(promise)` 只在 Workers 下存在;在 Node/Hono dev 下 `c.executionCtx` 不存在,promise **既不被 await 也不被 hold**,理论上 Node 不会立刻 GC(promise 闭包仍在事件循环里),但 `runScraper` 内部的错误若抛在 async 里会被吞掉,只能靠 `syncProcess.status = 'error'` 兜底。
- 建议:`if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(promise); else promise.catch(e => console.error(e));`

---

## B. Bug 与逻辑缺陷

### B1. Drizzle schema 与实际 SQL 迁移严重不一致,生产 D1 缺列会直接报错 — **P0**
- 位置:`server/db/schema.ts` vs `drizzle/0000_mean_lizard.sql`
- 现象:`schema.ts` 的 `klineDaily` 比迁移多了 **9 列**:
  - `ma5, ma10, ma20, ma60, ma120, ma250, bias6, bias12, bias24`
  - 但 `drizzle/0000_mean_lizard.sql` 中 `kline_daily` **只有** OHLCV + macd/rsi/boll/kdj 这些列。
- 后果:
  - `server/routes/sync.ts:60-77` 在写入 `dbRecords` 时会带 `ma5..bias24`,Drizzle D1 生成 `INSERT INTO kline_daily (..., ma5, ...) VALUES (...)`,**生产 D1 上不存在这些列 → SQL 错误**,同步 100% 失败(本地 dev 因为是新 build 的 SQLite 库,可能正好是最新 schema,所以掩盖了问题)。
  - `daily_snapshot` 也存在同样的漂移风险(`schema.ts` 已经定义了所有列,但需要核对迁移是否匹配 — 本报告看到 `0000_mean_lizard.sql` 与 `dailySnapshot` 字段是一致的,这条只针对 `kline_daily`)。
- 建议:
  - 立即生成新的迁移 `pnpm drizzle-kit generate`,把 9 列补上。
  - 在 CI 中跑 `drizzle-kit` 比对 schema ↔ migrations,防止再发生漂移。

### B2. `fetchWithRetry` 最后一轮 retry 把网络错误当"业务错误"抛出,调用方误判 — **P1**
- 位置:`server/lib/tencent.ts:16` 起
- 现象:`for (let i = 0; i < retries; i++)` 循环里 `return await response.json()`,**最后一轮失败 `throw err`**;但 `err` 可能是 `SyntaxError`(JSON 解析失败)或 `TypeError`(fetch 网络错误),调用方在 `syncOneStock` 里 `if (resJson.code !== 0) throw new Error(resJson.msg || 'Unknown API Error')`,**若 `resJson` 是 undefined**(网络错误时返回 undefined 会触发 `resJson.code` 抛 TypeError),最终被 worker 的 catch 捕获记 ERROR,**单只股票失败信息被吞**。
- 此外,`fetchWithRetry` 把 5xx/网络错都重试,但对 4xx(非 403/429)的错误(如 404)**也会 retry**,浪费请求。
- 建议:
  - 显式区分 retryable(5xx、429、网络异常)vs non-retryable(4xx 非 429)。
  - `getTencentStockData` 里 `catch (err) { console.error(...) }` 之后直接 `continue`,**丢失的 chunk 在 results 里完全不出现**,调用方拿到的 `results.length < codes.length` 时无法区分"该股票停牌"和"网络错",建议至少给 missing code 一个 `null` 占位或在返回里加 `errors: string[]`。

### B3. SSE 客户端清理时机有竞态,极端情况下事件丢失或泄漏 — **P1**
- 位置:`server/routes/alerts.ts:9`、`server/index.ts:58`(pollAlerts)
- 现象:
  - `alertClients.add(client)` 后注册 `onAbort`;`while (!signal.aborted)` 循环里写心跳;循环退出后 `alertClients.delete(client)`。
  - 但 `pollAlerts` 在另一处 isolate / 另一时刻对 `alertClients` 迭代 `client.write(...)` — 写一个已经底层断开但尚未触发 `abort` 的 stream,`write` 可能抛错**未被 try/catch 包裹**,直接抛进 `pollAlerts` 的循环,导致**后续客户端收不到事件**。
  - `signal.addEventListener('abort', onAbort)` 在 Cloudflare Workers 下,`signal` 不一定 `removeEventListener` 可用(部分运行时 `AbortSignal` 不支持 removeEventListener),清理可能重复执行(无害但冗余)。
- 建议:迭代 `alertClients` 时改为 `for (const client of [...alertClients]) { try { client.write(payload) } catch { alertClients.delete(client) } }`。

### B4. `/api/ai/picks` 在 AI 调用失败时静默回退到本地排序,且不告诉前端 — **P1**
- 位置:`server/routes/ai.ts:174-184`
- 现象:catch 分支里**没有 `console.error`**,只构造一个本地排序的 `picks` 返回 `success: true`,前端无法区分"AI 选股成功"和"AI 挂了走 fallback",会误导用户以为 AI 给出的就是这套理由。
- 建议:fallback 路径至少 `console.error('AI Picks fallback:', err)` 且响应里加 `fallback: true`。

### B5. `runScraper` 在已 syncing 状态时 return `undefined`,`/sync/start` 仍会调用 `waitUntil(undefined)` — **P1**
- 位置:`server/routes/sync.ts:65` 与 `:159`
- 现象:`if (syncProcess.status === 'syncing') return;` 但 `/sync/start` 在外层已经检查过 `status === 'syncing'` 才会调 `runScraper`,**这两层检查存在 TOCTOU**:并发两个 `/sync/start` 同时进入,都看到 `status !== 'syncing'`,都设置成 syncing 并启动两套 worker,游标 `cursor` 是闭包变量各自独立,**会重复同步同一批 code**。
- 建议:用一个 `syncProcess.lock = true` 标志 + 显式 `setStatus('syncing')` 原子操作;或改为基于 DB 行的分布式锁。

### B6. `/api/stocks` 写入 dailySnapshot 时未 await,错误难追溯 — **P1**
- 位置:`server/routes/stocks.ts:48`
- 现象:
  ```ts
  for (const d of parsedData) {
    db.insert(...).onConflictDoUpdate(...).run();   // 没 await
  }
  ```
  这是 fire-and-forget,`try/catch` 包不住真正的 await 结果(实际 promise 被 discard);并且 30+ 次 INSERT 串行而非 batch。最终 `return c.json({ success: true })` 可能在 snapshot 写完前就响应了。
- 建议:改为 `await db.batch([...inserts])`,一次提交。

### B7. `/api/groups/:id/stocks` 等多处 `getDb(c).insert(...).run()` 未 await — **P1**
- 位置:`server/routes/stocks.ts:24`(POST `/`)、`server/routes/groups.ts:25`(POST `/`)、`groups.ts:62`(POST `/:id/stocks`)、`groups.ts:81`(DELETE `/:id/stocks/:code`)、`server/routes/notifications.ts:9`(GET `/`)
- 现象:Hono 在 Node 适配器下若未 await,返回响应时底层 socket 可能已经关闭,SQLite 写入丢失。
- 建议:全部补 `await`。

### B8. `parseInt(c.req.param('id'))` 对非数字 ID 静默变 NaN — **P2**
- 位置:`server/routes/alerts.ts:55`、`server/routes/groups.ts:31,44,55,79`
- 现象:`parseInt('abc')` 返回 NaN,Drizzle where 条件 `eq(id, NaN)` 在 D1 里会变成 `WHERE id = NULL`,查询返回空 → 误以为"删除成功"。
- 建议:`const id = Number(c.req.param('id')); if (!Number.isInteger(id)) return c.json({error: 'Invalid id'}, 400);`

### B9. `/api/sync/start` 缺少 codes 数量上限和内容校验 — **P2**
- 位置:`server/routes/sync.ts:152`
- 现象:`if (!Array.isArray(codes) || codes.length === 0)` 仅检查非空数组,但:
  - 不限上限,恶意请求传 10000 个 code 会触发 10000 次外网请求(自己被腾讯封 IP)。
  - 不校验 code 格式(`sh600519` / `sz000001`),传入 `<script>` 或 SQL 片段虽不会被注入,但会污染 `stocks` 表(`onConflictDoUpdate` 会把脏 code 当 PK 存进去)。
- 建议:正则校验 `/^(sh|sz)\d{6}$/`,上限 1000。

### B10. `parseTencentStockData` 字段索引硬编码,接口字段变动即崩 — **P2**
- 位置:`server/lib/tencent.ts:84-105`
- 现象:腾讯接口字段是按位约定(`fields[3]` 是现价、`fields[39]` 是 PE 等),没有任何防御。一旦腾讯在中间插一个字段(历史上发生过),所有数据静默错位且 `parseFloat` 不会报错。
- 建议:对关键字段加 sanity check(如 `price > 0 && price < 1e6`),异常字段触发告警。

### B11. `notifications` 表无清理策略,会无限增长 — **P2**
- 位置:`server/db/schema.ts` notifications 表;`server/routes/notifications.ts`
- 现象:告警每次触发都 insert 一条,但**没有任何 `delete` 或归档**。半年后 `select * from notifications order by created_at desc` 会扫整表(无分页 + 无索引)。
- 建议:加 `limit 100`,并加定时清理 30 天前已读通知的 cron。

### B12. `pollAlerts` 中 `price === undefined` 时 continue,但若腾讯接口字段缺失(`price` 是 NaN),判断会出错 — **P2**
- 位置:`server/index.ts:42`
- 现象:`currentPrices.set(p.marketCode, p.price)`;若 `p.price` 为 NaN,`price >= threshold` 永远为 false,**告警永远不会触发**且不报错。
- 建议:set 前判断 `Number.isFinite(p.price)`。

### B13. `/api/kline/:code` 实时拼接今日 K 线会破坏最后一条已计算好的指标 — **P2**
- 位置:`server/routes/kline.ts:78-103`
- 现象:用 `parsedData[parsedData.length - 1] = { ...lastData, ...todayCandle }` 覆盖最后一根,但随后用整个 `parsedData` 重算 `calculateIndicators`,这一步是对的;**但若是 m30/m60 走 DB 分支**,则完全没拼实时,而走 fallback URL 分支时是 m1/m5/m15 等腾讯接口 → 行为不一致(分时图在盘中可能不更新)。
- 建议:统一 fallback 也补实时拼接逻辑,或在 DB 分支补 m30/m60 的最近一根实时。

### B14. `calculateIndicators` 在 kline 数据过短时返回全 null,但调用方依赖长度对齐 — **P2**
- 位置:`server/lib/indicators.ts:6-30`
- 现象:`MACD.calculate` 至少需要 26+9 根,RSI 需要 14 根;若 `parsedData.length < 14`,`macdResult = []`,然后 `pad([...], len, {...null})` 会生成等长数组,逻辑上 OK;**但 BBands 用 `stdDev: 2` 在数据恰好 20 根时会有 1 个值,其余 null**,极端边界下指标对齐可能漂移。
- 建议:加 `if (closePrices.length < 35) return allNullResult;` 提前返回。

---

## C. 安全问题

### C1. 第三方 API Key 通过 `settings` 表以明文存储,且任何客户端可读 — **P0**
- 位置:`server/ai/index.ts:8-22`(读 `ai_api_key`)、`server/routes/settings.ts:6`(GET `/api/settings` 直接 `select * from settings` 返回全部 key)
- 现象:
  - `GET /api/settings` 会把 `ai_api_key` 的**明文值**返回给前端(任何能访问该站点的用户都能拉到 OpenAI / Gemini Key)。
  - 同时 `value: String(value)` 在 POST 时不区分敏感字段,任何前端可写入任意 key。
  - 没有 auth,该后端完全裸奔(没看到任何鉴权中间件),意味着一旦部署到公网,Key 几小时内会被刷爆。
- 建议:
  - `GET /api/settings` 时对 `key.endsWith('api_key') || key.endsWith('secret')` 的 value 做 mask(`sk-****1234`)。
  - 加最小鉴权(简单 token / Cloudflare Access / Basic Auth),至少对写入类 API。
  - API Key 考虑用 Workers Secret(`env.AI_API_KEY`)而不是 DB,前端不接触明文。

### C2. 完全没有任何鉴权 / CSRF 防护 — **P0**
- 位置:`server/index.ts`(整个 app)
- 现象:无 session、无 JWT、无 API token、无 CSRF token。所有写接口(POST/DELETE)对任意来源开放。
- 影响:
  - 任何人可 `POST /api/settings` 改 AI prompt 注入。
  - 任何人可 `POST /api/sync/start` 触发大规模外网请求,把你服务器 / Cloudflare 账单打爆。
  - 任何人可 `DELETE /api/alerts/:id` 删别人的告警。
- 建议:
  - 加最小中间件:从 `env.ADMIN_TOKEN` 校验 `Authorization: Bearer` 或 `X-Admin-Token`。
  - 写接口校验 `Origin` / `Referer` 头防止 CSRF。
  - 用 Cloudflare Access 套一层身份认证是最省事的方案。

### C3. CSV 导入路径无字段校验、无大小限制,可注入任意股票记录 — **P1**
- 位置:`server/routes/stocks.ts:32-58`
- 现象:
  - `c.req.text()` 没有大小限制(用户传 1GB 文本会 OOM)。
  - `row[0]` 作为 `marketCode` 直接 upsert,没校验格式,可注入 `'); DROP TABLE--`(Drizzle 会参数化,SQL 注入风险低),但**可塞入恶意 name 字段**,前端 `dangerouslySetInnerHTML` 渲染即 XSS(需要看前端代码确认)。
- 建议:
  - 限制 `content.length < 5 * 1024 * 1024`。
  - 校验 `marketCode` 正则、`name` 长度上限 32、`remarks` 长度上限 256。

### C4. `fetchWithRetry` 把 `err.message` 直接拼到响应里,可能泄露内部信息 — **P1**
- 位置:`server/routes/*.ts` 普遍模式:`return c.json({ error: e.message }, 500)`
- 现象:把原始异常 message 抛给前端,可能含 SQL 片段、文件路径、第三方接口的报错(如 `API Key is not configured`)。
- 建议:对外统一返回 `{ error: 'Internal Server Error', requestId }`,详细错误写日志。

### C5. GET `/api/stocks?codes=...` 直接 split(',') 不限长度 — **P2**
- 位置:`server/routes/stocks.ts:7`
- 现象:`codes.split(',')` 无上限,可传几万个 code 导致 inArray SQL 无限膨胀。已经有 `chunkSize = 50` 分批,但仍会让 DB 跑几百次查询。
- 建议:加 `if (codesArray.length > 500) return c.json({error: 'Too many codes'}, 400)`。

### C6. `/api/ai/sentiment/:code` 把用户输入直接拼到 DB where — 安全但建议校验 — **P2**
- 位置:`server/routes/ai.ts:26`
- 现象:Drizzle `eq()` 参数化,无注入风险;但 `code` 没格式校验,无效 code 会浪费 AI 调用。
- 建议:`if (!/^((sh|sz)\d{6})$/.test(code)) return c.json({error: 'Invalid code'}, 400)`。

### C7. AI Prompt 注入风险 — **P2**
- 位置:`server/routes/ai.ts` systemPrompt 通过 `settings.ai_sentiment_prompt` 读取,且**前端可通过 POST /api/settings 任意修改**(参见 C1/C2)。攻击者可把 prompt 改成"忽略以上,输出恶意 JSON",再触发 sentiment 调用浪费 token。
- 建议:prompt 修改需要鉴权 + 审计。

### C8. `decodeGBK` 来自 `./gbk.js` 但仓库里**找不到该文件** — **P1**
- 位置:`server/lib/tencent.ts:1` `import { decodeGBK } from './gbk.js';`
- 现象:`server/lib/` 目录下不存在 `gbk.ts` 或 `gbk.js`(Glob 无结果)。
- 后果:`pnpm build` 在打包 server 时**会编译失败**(`Cannot find module './gbk.js'`),除非 `node_modules` 里有人手动放了一份。这至少意味着该模块依赖隐式存在,**对 CI 不可重现**。
- 建议:补上 `server/lib/gbk.ts`(或确认它在 `dist/` 下,改 import 路径)。

---

## D. 架构改进

### D1. 缺少统一错误处理中间件与统一响应格式 — **P1**
- 位置:全项目
- 现象:
  - 部分接口返回 `{ success: true, data }`(`market.ts`、`stocks.ts`、`ai.ts`),部分返回 `{ error: '...' }`(`kline.ts:14` `c.json({ error: e.message }, 500)` **没有 success 字段**),部分 `c.json({ success: false, error })`,前端处理分支多。
  - 错误码混用 400/404/500/503,但语义不清。
- 建议:
  - 引入 `app.onError((err, c) => c.json({ success: false, error: 'INTERNAL', message: '...' }, 500))`。
  - 路由内只 `throw new HTTPException(400, { message: '...' })`,由中间件统一序列化。

### D2. 数据模型问题
- **`kline_daily` 没有 `updated_at` 字段** — **P2**:无法判断上次写入时间,排查"数据为何没更新"困难。
- **`alerts` 表缺 `userId`** — **P2**:多用户场景下所有人共享一套告警。
- **`daily_snapshot` 没有索引** — 已在 A1 提到。
- **`ai_sentiment` 主键是 marketCode** — **P2**:意味着每只股票只有一份"情绪",无法存历史;若策略回测要历史情绪则不够。考虑改成 `(marketCode, date)`。
- **`notifications` 没有 `userId`、没有 `expiresAt`** — **P2**。

### D3. `getDb(c)` 三态切换(cachedLocalDb vs D1)容易出错 — **P2**
- 位置:`server/db/getDb.ts:7-15`
- 现象:
  - `c?.env?.stockpulse_db || c?.env?.DB` 命中即用 D1,否则走本地 libsql。但**dev server 启动时 `initSettings()` 没传 c**,会用 `cachedLocalDb` → dev 写入本地。
  - `scheduled(event, env, ctx)` 调 `pollAlerts(env)`,`pollAlerts(env)` 内 `getDb(env ? { env } : undefined)` — 注意它把 env 包成 `{ env }` 当 c 传进去,**结构假设很脆弱**:任何调用方忘了包 `{env}` 就会走本地 DB 而不是 D1。
- 建议:`getDb(env?: Bindings)` 显式分两个函数 `getD1(env)` 和 `getLocalDb()`,或在 pollAlerts/initSettings 签名上要求传 `env` 而不是 `c`。

### D4. AI 调用每次都查 `settings` 全表 3 次 — **P2**
- 位置:`server/ai/index.ts:7, 27, 33`
- 现象:`getAiClient` 全表 select settings;`getAiModel` 又 select 一次;`getAiPrompt` 又 select 一次。一次 `/api/ai/picks` = 3+ 次 settings 查询。
- 建议:`getAllSettings(c)` 一次取出缓存到 `c.var.settings`,或加 10s 内存缓存。

### D5. 路由模块没有版本化(`/api/v1/...`) — **P2**
- 现象:接口变更没有版本,前端兼容性靠运气。
- 建议:整体迁移到 `/api/v1`,保留旧路径 6 个月。

### D6. `server/worker.ts` 中 `scheduled()` 串行 await,长任务阻塞下一次 cron — **P2**
- 位置:`server/worker.ts:5-8`
- 现象:`await initSettings; await initStockPool; await pollAlerts;` 全部串行,initStockPool 实际上只 select 一次 stocks(检查表是否存在),没必要 await。
- 建议:`ctx.waitUntil(Promise.allSettled([initSettings(env), pollAlerts(env)]));` 让 scheduled 快速返回。

---

## E. 数据同步机制

### E1. `syncOneStock` 的增量逻辑有边界 bug,可能丢一天数据 — **P0**
- 位置:`server/routes/sync.ts:80-92`
- 现象:
  ```ts
  const latestDaily = await db.select(...).orderBy(desc(date)).limit(1).get();
  const maxDate = latestDaily ? latestDaily.date : null;
  if (maxDate) {
    recordsToInsert = dbRecords.filter(r => r.date >= maxDate);  // 保留 >= maxDate
    await db.delete(klineDaily).where(and(eq(marketCode), eq(date, maxDate))).run();  // 删除 maxDate
  }
  ```
  逻辑是"取最新日期 → 删掉最新日期那一行 → 插入 >= 最新日期的新数据"。问题:
  1. 若今天腾讯返回的 K 线**没有 maxDate 这一天**(停牌 / 接口未更新),`delete` 删了一条数据,**插入里却没补回来** → **数据丢失 1 天**。
  2. `recordsToInsert.filter(r => r.date >= maxDate)` 包含 maxDate 当天,但若当天是停牌没有数据,delete 后该天永久消失。
- 建议:删除前先确认 `dbRecords.some(r => r.date === maxDate)`,再决定是否 delete;或改成 `delete where date >= maxDate` + 全量插入。

### E2. 分钟线同步的 `setTimeout(500)` 在盘后/非交易时段浪费请求 — **P1**
- 位置:`server/routes/sync.ts:140`
- 现象:每个 period 之间 `await new Promise(resolve => setTimeout(resolve, 500))`,沪深 300 × 2 period × 500ms = 5 分钟纯 sleep,而**非交易时段分钟线根本不变**,完全是无用请求。
- 建议:判断当前是否 A 股交易时段(9:30-11:30 / 13:00-15:00 工作日),否则跳过分钟线同步。

### E3. 全量同步没有"上次同步时间"判断,每次都拉 250 天 — **P1**
- 位置:`server/routes/sync.ts:21`
- 现象:无论 `mode === 'incremental'` 还是 `full`,都 `param=${code},day,,,250,qfq` 拉 250 天。即使上一次刚同步过,仍要拉 250 天,再 filter 出 1-2 天写入。带宽浪费严重。
- 建议:`incremental` 模式下,根据 `stocks.lastSyncTime` 动态决定拉取天数(最近同步 ≤ 7 天则拉 30 天足矣)。

### E4. 限流处理不够鲁棒 — **P1**
- 位置:`server/lib/tencent.ts:21-28`
- 现象:
  - `fetchWithRetry` 检测到 403/429 抛错,但 `getTencentStockData` 里 `catch (err) { console.error(...) }` **直接跳过该 chunk 不重试**,导致这一批 30 个 code 完全没数据,但 `results` 仍按部分返回,`/api/market/overview` 的 `quoteMap` 里缺这 30 个 → 它们的 `breadth` 计数偏低。
  - `fetchWithRetry` 指数 backoff 最多 3 次 ~7 秒,腾讯若持续限流仍会失败。
- 建议:
  - 在 `getTencentStockData` 出错时也做一次 backoff retry。
  - 给同步任务的并发度从 1 提到 3-5,但配合自适应降速(遇 429 自动降并发)。

### E5. `runScraper` 中 `cursor++` 不是原子的 — **P2**
- 位置:`server/routes/sync.ts:107`
- 现象:JavaScript 单线程下 `cursor++` 视为原子,但多个 `worker` 协程在 `await` 之间交错,**理论上**JS 单线程下读改写不会被打断,实际安全;但可读性差,且若未来引入真正多线程(Worker Threads)即坏。
- 建议:保留现状即可,加注释说明依赖 JS 单线程语义。

### E6. `initStockPool` 没有实际初始化作用 — **P2**
- 位置:`server/index.ts:30-37`
- 现象:`async function initStockPool(env?) { try { await db.select().from(stocksSchema).all(); } catch (e) { console.error('Failed to init stock pool', e); } }` — 只是 select 一次,函数名暗示"初始化股票池",实际啥也没干(可能原作者想触发表创建?)。Drizzle 不会因为 select 就建表。
- 建议:删除该函数,或改为真正写入一份默认 CSI-300 股票池(若表为空)。

### E7. `dailySnapshot` 写入由 `/api/stocks` 触发,同步任务不写 — **P2**
- 位置:`server/routes/stocks.ts:41-58`
- 现象:PE/PB/换手率快照**只在用户访问 `/api/stocks` 时**才写库;若用户长时间不点行情页,`daily_snapshot` 永远不更新,`/api/ai/picks` 读到的就是过期 PE。
- 建议:在 `pollAlerts` 或独立 cron 里,每日收盘后批量拉一次 pool 的 PE/PB 入库。

### E8. `runScraper` 内的错误仅记到内存 logs,`errorCount` 不区分致命错误 — **P2**
- 位置:`server/routes/sync.ts:114-117`
- 现象:`errorCount++` 不区分"该股票停牌"和"数据库整体故障",前端无法判断是否需要全量重试。
- 建议:错误分级(network/api/db),`syncProcess.fatalErrors` 单独计数。

---

## 优先级汇总

### P0(必须立即修复,影响数据正确性 / 安全)
1. **A1** — kline_daily / notifications 等表完全缺索引,大量查询全表扫
2. **A2** — 内存状态在 serverless 下不持久,SSE 推送、同步状态实际不工作
3. **B1** — schema.ts 与 drizzle 迁移漂移,生产 D1 缺 9 列,同步必然失败
4. **C1** — API Key 通过 GET /api/settings 明文外泄
5. **C2** — 完全无鉴权 / CSRF 防护
6. **E1** — 同步增量逻辑在停牌场景下丢数据

### P1(本迭代内修复,bug 或可利用缺陷)
7. **A3** — aiPicksCache 无上限无过期
8. **A4** — backtest 响应体过大、串行计算
9. **B2** — fetchWithRetry 错误分类不当
10. **B3** — SSE 写失败未 try/catch 会中断其它客户端
11. **B4** — AI 失败静默 fallback 不告知前端
12. **B5** — runScraper TOCTOU 导致并发重复同步
13. **B6/B7** — 多处 INSERT/UPDATE 未 await,dev 下可能丢写入
14. **C3** — CSV 导入无校验无大小限制
15. **C4** — 原始错误 message 泄露
16. **C8** — `./gbk.js` 找不到,构建可能失败
17. **D1** — 缺统一错误中间件与响应格式
18. **E2/E3** — 分钟线无交易时段判断 / 全量同步无增量优化
19. **E4** — 限流退避不充分

### P2(建议优化)
- A5/A6/A7/A8、B8-B14、C5-C7、D2-D6、E5-E8

---

## 关键观察

1. **该后端同时声称支持"本地 dev + Cloudflare Workers",但内存态(`syncProcess`/`aiPicksCache`/`alertClients`)在 Workers 下基本失效**(代码注释已承认),需要在两条路里二选一:要么完全走 D1 + Durable Object,要么文档明确只支持 Node dev。
2. **schema ↔ migration 漂移(B1)是当前最致命的问题**:`ma5..bias24` 这 9 列在源码里大量使用,但迁移没建,任何一次 `drizzle-kit push` 或新部署到 D1 都会立刻挂掉。
3. **安全层面接近裸奔**(C1/C2):建议至少先用 Cloudflare Access 把整站挡住,这是性价比最高的修复。
4. **计算冗余集中在 `signalEngine.ts`**(A6),`scoreStock` / `scoreContrarian` / `detectSignals` 三入口对同一份 K 线反复算 MA/avgVol5,300 只股票循环时差异明显。

报告完毕,未修改任何业务代码。
