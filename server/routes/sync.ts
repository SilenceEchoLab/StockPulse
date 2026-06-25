import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { stocks as stocksSchema, klineDaily, klineMin, klineLongPeriod, dailySnapshot, settings } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { fetchWithRetry } from '../lib/tencent.js';
import { calculateIndicators } from '../lib/indicators.js';
import { syncProcess, addLog } from '../lib/state.js';

const app = new Hono();

// 全量历史深度（约 3 年交易日），用于长期回测与稳定 MA250 计算
const FULL_HISTORY_DAYS = 800;
// 增量同步默认窗口（近期补数）
const INCREMENTAL_DAYS = 30;
// 指标预热所需最小数据量：MA250 需 250+ 日，MACD(26)/BIAS24 等也需充足窗口
const INDICATOR_WARMUP_DAYS = 300;

// ── 支持的同步粒度 ──
// day     日线（fqkline，可取 3 年+，含全套指标）—— 策略主数据
// week    周线（fqkline）—— 三周期共振「大周期定方向」层
// month   月线（fqkline）—— 月线看周期
// m5/m15/m30/m60 分钟线（mkline）—— 「小周期抓时机」层
//   注：腾讯 mkline 仅保留近期分钟数据（m5≈近 1-2 月、m30/m60≈近 1 年），无法取 3 年
export const ALL_GRANULARITIES = ['day', 'week', 'month', 'm5', 'm15', 'm30', 'm60'] as const;
export type Granularity = typeof ALL_GRANULARITIES[number];
const LONG_PERIODS: Granularity[] = ['week', 'month'];
const MINUTE_PERIODS: Granularity[] = ['m5', 'm15', 'm30', 'm60'];
// 分钟线默认拉取根数（腾讯 mkline 上限约 3200）
const DEFAULT_MINUTE_COUNT = 2000;
// 周/月线默认拉取根数（覆盖 5 年周线 / 10 年月线，API 会按实际截断）
const DEFAULT_LONG_PERIOD_COUNT = 320;

// 指数代码（沪深300/上证/深成/创业板）—— 与 market.ts 的 INDICES 保持一致，存入同一张 kline_daily
export const INDEX_CODES = ['sh000300', 'sh000001', 'sz399001', 'sz399006'];

// 指数代码判定：sh000xxx / sz399xxx
export function isIndexCode(code: string): boolean {
  return /^(sh000|sz399)\d{3}$/.test(code);
}

// 同步单只标的（个股或指数）：可配置粒度（day/week/month/m5/m15/m30/m60）与时间范围，均为增量写入
export async function syncOneStock(code: string, db: any, options: {
  mode?: string; days?: number; granularities?: string[]; minuteCount?: number; longPeriodCount?: number;
} = {}) {
  const mode = options.mode || 'incremental';
  const isIndex = isIndexCode(code);

  // 动态决定拉取天数：full 拉满历史；incremental 需保证指标预热数据量
  // 否则 calculateIndicators 在 len<35 时返回全 null，导致近期行指标缺失
  let days = options.days || (mode === 'full' ? FULL_HISTORY_DAYS : Math.max(INCREMENTAL_DAYS, INDICATOR_WARMUP_DAYS));

  // 解析要同步的粒度；未指定则默认 day+m30+m60（兼容旧调用）
  const grans = (options.granularities && options.granularities.length > 0
    ? options.granularities
    : ['day', 'm30', 'm60']) as Granularity[];
  const longPeriodCount = options.longPeriodCount ?? DEFAULT_LONG_PERIOD_COUNT;
  const minuteCount = options.minuteCount ?? DEFAULT_MINUTE_COUNT;

  // 仅个股写 stocks 元数据（指数不入 stocks 表）—— 无论同步哪个粒度都更新
  if (!isIndex) {
    db.insert(stocksSchema).values({
      marketCode: code,
      name: code,
      lastSyncTime: new Date()
    }).onConflictDoUpdate({
      target: stocksSchema.marketCode,
      set: { lastSyncTime: new Date() }
    }).run();
  }

  // ── 日K线 + 周/月长周期线：均走 fqkline，结构一致，统一处理 ──
  // fqkline 对个股与指数均要求带 qfq 后缀（指数无复权语义但接口必需）
  const fqPeriods = (['day', ...LONG_PERIODS] as Granularity[]).filter(p => grans.includes(p));
  for (const period of fqPeriods) {
    const isDaily = period === 'day';
    const count = isDaily ? days : longPeriodCount;
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`;
    let resJson: any;
    try {
      resJson = await fetchWithRetry(url);
    } catch (e: any) {
      // 长周期拉取失败不阻断日K（保持向后兼容的容错语义）
      if (isDaily) throw e;
      addLog('WARN', `${period.toUpperCase()}_FETCH:`, `Failed for ${code} - ${e.message}`);
      continue;
    }
    if (resJson.code !== 0) {
      if (isDaily) throw new Error(resJson.msg || 'Unknown API Error');
      addLog('WARN', `${period.toUpperCase()}_FETCH:`, `Upstream rejected ${code} - ${resJson.msg}`);
      continue;
    }

    const dataObj = resJson.data[code];
    const klineKey = dataObj[`qfq${period}`] ? `qfq${period}` : (dataObj[period] ? period : (dataObj['underlying'] ? 'underlying' : period));
    const kData = dataObj[klineKey];
    if (!kData || !Array.isArray(kData) || kData.length === 0) {
      if (isDaily) throw new Error('No K-line data found in response');
      continue;
    }

    const closePrices: number[] = [];
    const highPrices: number[] = [];
    const lowPrices: number[] = [];
    const volumePrices: number[] = [];
    const parsedRows: any[] = [];

    for (const row of kData) {
      const date = row[0];
      const open = parseFloat(row[1]);
      const close = parseFloat(row[2]);
      const high = parseFloat(row[3]);
      const low = parseFloat(row[4]);
      // OHLC 为 NOT NULL 列：停牌/异常行可能返回空串，parseFloat 得 NaN，
      // 经 JSON 序列化变 null 会违反约束导致整批 upsert 失败，跳过无效行
      if (!isFinite(open) || !isFinite(close) || !isFinite(high) || !isFinite(low)) continue;
      const volume = parseFloat(row[5]) || 0;
      closePrices.push(close);
      highPrices.push(high);
      lowPrices.push(low);
      volumePrices.push(volume);
      parsedRows.push({ marketCode: code, date, open, close, high, low, volume });
    }

    // 计算涨跌幅 pctChg（仅日K需要，用于涨跌停判定与市场宽度统计）
    if (isDaily) {
      for (let i = 0; i < parsedRows.length; i++) {
        if (i === 0) {
          parsedRows[i].pctChg = 0;
        } else {
          const prevClose = parsedRows[i - 1].close;
          parsedRows[i].pctChg = prevClose > 0 ? ((parsedRows[i].close - prevClose) / prevClose) * 100 : 0;
        }
      }
    }

    const { pMacd, pRsi, pBb, pKdj, pMa, pBias, pAtr, pObv, pVolMa5, pVolRatio } =
      calculateIndicators(closePrices, highPrices, lowPrices, volumePrices);

    const safeNum = (val: any) => (typeof val === 'number' && isFinite(val)) ? val : null;
    const dbRecords = parsedRows.map((r, i) => {
      const j = (pKdj[i] && pKdj[i].k !== null) ? 3 * pKdj[i].k - 2 * pKdj[i].d : null;
      const base: any = {
        ...r,
        macd: safeNum(pMacd[i]?.MACD),
        macdSignal: safeNum(pMacd[i]?.signal),
        macdHist: safeNum(pMacd[i]?.histogram),
        rsi14: safeNum(pRsi[i]),
        bollMid: safeNum(pBb[i]?.middle),
        bollUpper: safeNum(pBb[i]?.upper),
        bollLower: safeNum(pBb[i]?.lower),
        kdjK: safeNum(pKdj[i]?.k),
        kdjD: safeNum(pKdj[i]?.d),
        kdjJ: safeNum(j),
        ma5: safeNum(pMa.ma5[i]),
        ma10: safeNum(pMa.ma10[i]),
        ma20: safeNum(pMa.ma20[i]),
        ma60: safeNum(pMa.ma60[i]),
        ma120: safeNum(pMa.ma120[i]),
        ma250: safeNum(pMa.ma250[i]),
        bias6: safeNum(pBias.bias6[i]),
        bias12: safeNum(pBias.bias12[i]),
        bias24: safeNum(pBias.bias24[i]),
        atr14: safeNum(pAtr[i]),
        obv: safeNum(pObv[i]),
        volMa5: safeNum(pVolMa5[i]),
        volRatio: safeNum(pVolRatio[i]),
      };
      if (isDaily) base.pctChg = safeNum(r.pctChg);
      return base;
    });

    // 增量同步：仅保留 >= 最新日期的记录，并删除当日以便用新数据覆盖
    // 注意：若当日停牌无数据，不删除已有记录，避免丢数据（E1 修复）
    // 长周期表多一个 period 维度
    const latestRow = isDaily
      ? await db.select({ date: klineDaily.date }).from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(desc(klineDaily.date)).limit(1).get()
      : await db.select({ date: klineLongPeriod.date }).from(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, period))).orderBy(desc(klineLongPeriod.date)).limit(1).get();
    const maxDate = latestRow ? (latestRow as any).date : null;

    let recordsToInsert = dbRecords;
    if (!isDaily) recordsToInsert = dbRecords.map((r: any) => ({ ...r, period }));
    if (maxDate && mode === 'incremental') {
      // 增量：只删除确认在新数据中存在的日期行，避免停牌时删掉唯一记录
      const hasMaxDateData = dbRecords.some(r => r.date === maxDate);
      recordsToInsert = recordsToInsert.filter((r: any) => r.date >= maxDate);
      if (hasMaxDateData) {
        if (isDaily) {
          await db.delete(klineDaily).where(and(eq(klineDaily.marketCode, code), eq(klineDaily.date, maxDate))).run();
        } else {
          await db.delete(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, period), eq(klineLongPeriod.date, maxDate))).run();
        }
      }
    } else if (mode === 'full') {
      // full 模式：清空该标的该周期全部历史后重写
      if (isDaily) {
        await db.delete(klineDaily).where(eq(klineDaily.marketCode, code)).run();
      } else {
        await db.delete(klineLongPeriod).where(and(eq(klineLongPeriod.marketCode, code), eq(klineLongPeriod.period, period))).run();
      }
    }
    const chunkSize = 500;
    for (let s = 0; s < recordsToInsert.length; s += chunkSize) {
      if (isDaily) {
        await db.insert(klineDaily).values(recordsToInsert.slice(s, s + chunkSize)).onConflictDoUpdate({
          target: [klineDaily.marketCode, klineDaily.date],
          set: {
            open: sql`excluded.open`, close: sql`excluded.close`, high: sql`excluded.high`, low: sql`excluded.low`, volume: sql`excluded.volume`,
            macd: sql`excluded.macd`, macdSignal: sql`excluded.macd_signal`, macdHist: sql`excluded.macd_hist`, rsi14: sql`excluded.rsi14`,
            bollMid: sql`excluded.boll_mid`, bollUpper: sql`excluded.boll_upper`, bollLower: sql`excluded.boll_lower`,
            kdjK: sql`excluded.kdj_k`, kdjD: sql`excluded.kdj_d`, kdjJ: sql`excluded.kdj_j`,
            ma5: sql`excluded.ma5`, ma10: sql`excluded.ma10`, ma20: sql`excluded.ma20`, ma60: sql`excluded.ma60`, ma120: sql`excluded.ma120`, ma250: sql`excluded.ma250`,
            bias6: sql`excluded.bias6`, bias12: sql`excluded.bias12`, bias24: sql`excluded.bias24`,
            atr14: sql`excluded.atr14`, obv: sql`excluded.obv`, volMa5: sql`excluded.vol_ma5`, volRatio: sql`excluded.vol_ratio`, pctChg: sql`excluded.pct_chg`,
          }
        }).run();
      } else {
        await db.insert(klineLongPeriod).values(recordsToInsert.slice(s, s + chunkSize)).onConflictDoUpdate({
          target: [klineLongPeriod.marketCode, klineLongPeriod.period, klineLongPeriod.date],
          set: {
            open: sql`excluded.open`, close: sql`excluded.close`, high: sql`excluded.high`, low: sql`excluded.low`, volume: sql`excluded.volume`,
            macd: sql`excluded.macd`, macdSignal: sql`excluded.macd_signal`, macdHist: sql`excluded.macd_hist`, rsi14: sql`excluded.rsi14`,
            kdjK: sql`excluded.kdj_k`, kdjD: sql`excluded.kdj_d`, kdjJ: sql`excluded.kdj_j`,
            ma5: sql`excluded.ma5`, ma10: sql`excluded.ma10`, ma20: sql`excluded.ma20`, ma60: sql`excluded.ma60`, ma120: sql`excluded.ma120`, ma250: sql`excluded.ma250`,
            bias6: sql`excluded.bias6`, bias12: sql`excluded.bias12`, bias24: sql`excluded.bias24`,
            atr14: sql`excluded.atr14`, obv: sql`excluded.obv`, volMa5: sql`excluded.vol_ma5`, volRatio: sql`excluded.vol_ratio`,
          }
        }).run();
      }
    }
    addLog('SUCCESS', isDaily ? 'DATABASE_WRITE:' : `${period.toUpperCase()}_DB:`, `Synced ${parsedRows.length} rows for ${code}`);
  }

  // ── 分钟K（m5/m15/m30/m60），失败不阻断整体流程；指数无分钟线意义，跳过 ──
  if (!isIndex) {
    const minPeriods = MINUTE_PERIODS.filter(p => grans.includes(p));
    for (const period of minPeriods) {
      try {
        const minUrl = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,,${minuteCount}`;
        const minData = await fetchWithRetry(minUrl);
        if (minData && minData.code === 0 && minData.data[code] && Array.isArray(minData.data[code][period]) && minData.data[code][period].length > 0) {
          const mData = minData.data[code][period];
          const mRecords = mData.map((row: any[]) => ({
            marketCode: code,
            period,
            time: String(row[0]),
            open: parseFloat(row[1]),
            close: parseFloat(row[2]),
            high: parseFloat(row[3]),
            low: parseFloat(row[4]),
            volume: parseFloat(row[5])
          // 过滤 OHLC 无效行（停牌/异常），避免 NOT NULL 约束失败
          })).filter((r: any) => isFinite(r.open) && isFinite(r.close) && isFinite(r.high) && isFinite(r.low));

          const latestMin = await db.select({ time: klineMin.time })
            .from(klineMin)
            .where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period)))
            .orderBy(desc(klineMin.time))
            .limit(1).get();
          const maxTime = latestMin ? latestMin.time : null;

          let minToInsert = mRecords;
          if (maxTime) {
            minToInsert = mRecords.filter((r: any) => r.time >= maxTime);
            await db.delete(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period), eq(klineMin.time, maxTime))).run();
          } else {
            await db.delete(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period))).run();
          }
          const minChunkSize = 500;
          for (let s = 0; s < minToInsert.length; s += minChunkSize) {
            await db.insert(klineMin)
              .values(minToInsert.slice(s, s + minChunkSize))
              .onConflictDoUpdate({
                target: [klineMin.marketCode, klineMin.period, klineMin.time],
                set: {
                  open: sql`excluded.open`,
                  close: sql`excluded.close`,
                  high: sql`excluded.high`,
                  low: sql`excluded.low`,
                  volume: sql`excluded.volume`
                }
              })
              .run();
          }
          addLog('SUCCESS', `${period.toUpperCase()}_DB:`, `Synced ${mRecords.length} rows for ${code}`);
        }
      } catch {
        // 分钟线拉取失败忽略，不影响日K同步结果
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

async function runScraper(codes: string[], c: any, options: { concurrency?: number; mode?: string; days?: number; granularities?: string[]; minuteCount?: number; longPeriodCount?: number } = {}) {
  if (syncProcess.status === 'syncing') return;

  Object.assign(syncProcess, {
    status: 'syncing',
    total: codes.length,
    current: 0,
    progress: 0,
    logs: [],
    totalRequests: 0,
    errorCount: 0,
    diskUsageBytes: 0,
    startTime: new Date(),
  });

  const concurrency = Math.max(1, Math.min(10, options.concurrency || 1));
  const mode = options.mode || 'incremental';
  addLog('INFO', 'INIT_MARKET_MONITOR:', `Starting ${mode} sync for ${codes.length} symbols. Concurrency: ${concurrency}`);

  // 后台异步执行：Cloudflare Workers 下可能被中断，本地 dev 下可正常完成
  return (async () => {
    try {
      const db = getDb(c);
      let cursor = 0;

      // 并发 worker 池：多 worker 共享 cursor 直到所有标的处理完毕
      const worker = async () => {
        while (syncProcess.status === 'syncing') {
          const idx = cursor++;
          if (idx >= codes.length) break;
          const code = codes[idx];

          syncProcess.current++;
          syncProcess.progress = (syncProcess.current / syncProcess.total) * 100;
          syncProcess.totalRequests++;

          try {
            await syncOneStock(code, db, {
              mode, days: options.days,
              granularities: options.granularities,
              minuteCount: options.minuteCount,
              longPeriodCount: options.longPeriodCount,
            });
          } catch (err: any) {
            syncProcess.errorCount++;
            // DrizzleQueryError 把真正的 SQLite 错误放在 cause 里，只 log message 会丢失根因
            const rootCause = err?.cause?.message || err?.cause || '';
            const msg = rootCause ? `${err.message} | cause: ${rootCause}` : (err.message || err.toString());
            addLog('ERROR', 'API_ERROR:', `Failed for ${code} - ${msg}`);
          }

          // 随机延迟，降低被限流风险
          const delay = Math.floor(Math.random() * 2000) + 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      syncProcess.status = 'completed';
      addLog('SUCCESS', 'PROCESS_COMPLETE:', `All ${syncProcess.total} symbols processed.`);
    } catch (e: any) {
      syncProcess.status = 'error';
      addLog('ERROR', 'FATAL:', e.message);
    }
  })();
}

app.post('/start', async (c) => {
  const body = (await c.req.json()) as any;
  const codes = body.codes;
  if (!Array.isArray(codes) || codes.length === 0) {
    return c.json({ error: 'Array of stock codes required.' }, 400);
  }
  // C3/B9 修复：校验代码格式与数量上限（允许个股 + 指数代码）
  const CODE_REGEX = /^(sh|sz|bj)\d{6}$/;
  const INDEX_REGEX = /^(sh000|sz399)\d{3}$/;
  const validCodes = codes.filter((code: string) => CODE_REGEX.test(code) || INDEX_REGEX.test(code));
  if (validCodes.length === 0) {
    return c.json({ error: 'No valid stock codes provided' }, 400);
  }
  if (validCodes.length > 1000) {
    return c.json({ error: 'Too many codes (max 1000)' }, 400);
  }
  if (syncProcess.status === 'syncing') {
    return c.json({ success: false, message: 'Sync already in progress.' });
  }

  // 规范化同步选项：粒度白名单过滤，时间范围/根数兜底
  const rawOpts = body.options || {};
  const granularities = Array.isArray(rawOpts.granularities)
    ? rawOpts.granularities.filter((g: string) => (ALL_GRANULARITIES as readonly string[]).includes(g))
    : undefined;
  const normOpts = {
    ...rawOpts,
    granularities: granularities && granularities.length > 0 ? granularities : undefined,
  };

  // 后台异步执行（本地 Node 环境，无需 Cloudflare waitUntil）
  runScraper(validCodes, c, normOpts).catch(e => addLog('ERROR', 'FATAL:', e?.message || String(e)));

  return c.json({ success: true, message: 'Sync started.' });
});

// 同步大盘指数（沪深300/上证/深成/创业板），供择时模块使用
app.post('/index', async (c) => {
  const body = ((await c.req.json().catch(() => ({}))) as any) || {};
  const mode = body.mode || 'incremental';
  if (syncProcess.status === 'syncing') {
    return c.json({ success: false, message: 'Sync already in progress.' });
  }
  runScraper([...INDEX_CODES], c, { mode, concurrency: 2 }).catch(e => addLog('ERROR', 'FATAL:', e?.message || String(e)));
  return c.json({ success: true, message: `Index sync started (${mode}).` });
});

app.get('/overview', async (c) => {
  try {
    const db = getDb(c);
    // 显式别名 + Number 转换，避免 libsql 驱动返回字符串/BigInt 导致计数丢失
    const stocksRow = await db.select({ count: sql`count(*) as count` }).from(stocksSchema).get();
    const snapshotRow = await db.select({ count: sql`count(*) as count` }).from(dailySnapshot).get();
    const settingsRow = await db.select({ count: sql`count(*) as count` }).from(settings).get();
    // 指数同步状态
    const indexCountRow = await db.select({ count: sql`count(*) as count` })
      .from(klineDaily)
      .where(sql`market_code LIKE 'sh000%' OR market_code LIKE 'sz399%'`).get();
    return c.json({
      success: true,
      data: {
        stocks: stocksRow ? Number(stocksRow.count) : 0,
        snapshots: snapshotRow ? Number(snapshotRow.count) : 0,
        settings: settingsRow ? Number(settingsRow.count) : 0,
        indexSymbols: indexCountRow ? Number(indexCountRow.count) : 0,
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.get('/status', async (c) => {
  return c.json({
    status: syncProcess.status,
    progress: syncProcess.progress,
    current: syncProcess.current,
    total: syncProcess.total,
    logs: syncProcess.logs,
    totalRequests: syncProcess.totalRequests,
    errorCount: syncProcess.errorCount,
    diskUsageBytes: 0
  });
});

app.get('/export', async (c) => {
  return c.text('Export is not supported in Serverless environment', 400);
});

export default app;
