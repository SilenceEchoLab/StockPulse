// 多周期共振引擎 —— 对应《选股交易操作手册》第二步：三周期共振选股法
// 核心口诀：大周期定方向，中周期选结构，小周期抓节奏。三者共振出黄金点。
//
// 第一层 大周期(周线/月线)定方向 —— 过滤器：周线站稳 MA60、多头排列
// 第二层 中周期(日线)选结构 —— 找形态：多头排列、回踩20日线、突破、缩量回调
// 第三层 小周期(时机)抓节奏 —— 确认入场：MACD金叉、KDJ金叉、放量、RSI健康

import type { KlineRow } from './signalEngine.js';
import { calculateIndicators } from './indicators.js';
import { sma, safe } from './indicatorUtil.js';

// 分钟线一根（与 kline_min 表结构对齐，仅取 OHLCV + time）
export interface MinBar {
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

// ─────────────────────────────────────────────
// 月线趋势判定 —— 对应《选股交易操作手册》第二步 2.1 第一层「大周期定方向」硬过滤
// 原书：月线均线多头排列，或月线 MACD 金叉；不满足（月线空头）直接淘汰。
// 输入为月线 K 线（kline_long_period period=month，已含指标），读取最后 1~2 根判定。
// ─────────────────────────────────────────────
export interface MonthlyTrend {
  score: number;       // 0~30
  bullish: boolean;    // 月线多头排列 / MACD 金叉
  bearish: boolean;    // 月线空头排列 / 跌破 MA20 —— 触发硬过滤
  label: string;
}

export function assessMonthlyTrend(monthRows: KlineRow[]): MonthlyTrend {
  if (!monthRows || monthRows.length < 3) {
    return { score: 0, bullish: false, bearish: false, label: '月线数据不足' };
  }
  const last = monthRows[monthRows.length - 1];
  const prev = monthRows[monthRows.length - 2];
  const price = last.close;
  const ma5 = safe(last.ma5), ma10 = safe(last.ma10), ma20 = safe(last.ma20);
  const macd = safe(last.macd), sig = safe(last.macdSignal);
  const pMacd = safe(prev?.macd), pSig = safe(prev?.macdSignal);

  const bullAlign = ma5 !== null && ma10 !== null && ma20 !== null && ma5 > ma10 && ma10 > ma20;
  const bearAlign = ma5 !== null && ma10 !== null && ma20 !== null && ma5 < ma10 && ma10 < ma20;
  const goldenCross = pMacd !== null && pSig !== null && macd !== null && sig !== null && pMacd <= pSig && macd > sig;
  const aboveMa20 = ma20 !== null && price > ma20;

  if (bullAlign && aboveMa20) return { score: 30, bullish: true, bearish: false, label: '月线多头排列' };
  if (goldenCross || (aboveMa20 && macd !== null && macd > 0)) {
    return { score: 22, bullish: true, bearish: false, label: goldenCross ? '月线MACD金叉' : '月线偏强' };
  }
  if (bearAlign || (ma20 !== null && price < ma20)) {
    return { score: 0, bullish: false, bearish: true, label: bearAlign ? '月线空头排列' : '月线跌破MA20' };
  }
  if (aboveMa20) return { score: 14, bullish: false, bearish: false, label: '月线站上MA20' };
  return { score: 8, bullish: false, bearish: false, label: '月线中性' };
}

// ─────────────────────────────────────────────
// 小周期（60 分钟）时机确认 —— 对应《选股交易操作手册》第二步 2.3 第三层
// 「小周期抓节奏」：放量突破 / MACD 金叉 / KDJ 超跌金叉任一出现即确认入场
// 这是三周期共振真正的第三层（此前由日线时机信号近似替代）
// ─────────────────────────────────────────────
export interface IntradayAssessment {
  confirmed: boolean;        // 60 分钟是否出现买入确认信号
  score: number;             // 0-8，并入时机分
  signals: { type: 'bullish' | 'bearish'; name: string; confidence: number }[];
  sampleBars: number;
}

export function assessIntraday60(bars: MinBar[]): IntradayAssessment {
  const signals: IntradayAssessment['signals'] = [];
  if (bars.length < 35) {
    return { confirmed: false, score: 0, signals, sampleBars: bars.length };
  }
  const close = bars.map(b => b.close);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const vol = bars.map(b => b.volume);
  const ind = calculateIndicators(close, high, low, vol);
  const n = close.length - 1;
  const p = n - 1;

  const macd = safe(ind.pMacd[n]?.MACD);
  const sig = safe(ind.pMacd[n]?.signal);
  const pMacd = safe(ind.pMacd[p]?.MACD);
  const pSig = safe(ind.pMacd[p]?.signal);
  const ma20 = safe(ind.pMa.ma20[n]);
  const k = safe(ind.pKdj[n]?.k);
  const d = safe(ind.pKdj[n]?.d);
  const pk = safe(ind.pKdj[p]?.k);
  const pd = safe(ind.pKdj[p]?.d);
  const price = close[n];
  const avgVol5 = vol.slice(-5).reduce((a, b) => a + b, 0) / 5;

  let score = 0;
  let confirmed = false;

  // 60 分 MACD 金叉
  if (pMacd !== null && pSig !== null && macd !== null && sig !== null && pMacd <= pSig && macd > sig) {
    score += 6; confirmed = true;
    signals.push({ type: 'bullish', name: '60分MACD金叉', confidence: 0.8 });
  }
  // 60 分放量突破 MA20（站上 MA20 且量比≥1.2）
  if (ma20 !== null && price > ma20 && avgVol5 > 0 && vol[n] > avgVol5 * 1.2 && (pMacd === null || close[p] <= (ma20 + 0.001))) {
    score += 4; confirmed = true;
    signals.push({ type: 'bullish', name: '60分放量突破', confidence: 0.72 });
  }
  // 60 分 KDJ 低位金叉（K<50）
  if (k !== null && d !== null && pk !== null && pd !== null && pk <= pd && k > d && k < 50) {
    score += 4; confirmed = true;
    signals.push({ type: 'bullish', name: '60分KDJ低位金叉', confidence: 0.7 });
  }

  return { confirmed, score: Math.min(8, score), signals, sampleBars: bars.length };
}

// ISO 周键（年-周），用于把日线聚合成自然周（周一为周首）
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7; // 周日=7
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - day)); // 本周四（ISO 周以包含周四的那周计）
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface WeeklyRow {
  weekKey: string;
  date: string;        // 周最后交易日
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** 把日线聚合成周线（按自然周，周一为周首） */
export function aggregateWeekly(dailyRows: KlineRow[]): WeeklyRow[] {
  const groups = new Map<string, KlineRow[]>();
  for (const r of dailyRows) {
    const key = isoWeekKey(r.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const weekly: WeeklyRow[] = [];
  for (const days of groups.values()) {
    days.sort((a, b) => a.date.localeCompare(b.date));
    weekly.push({
      weekKey: isoWeekKey(days[0].date),
      date: days[days.length - 1].date,
      open: days[0].open,
      close: days[days.length - 1].close,
      high: Math.max(...days.map(d => d.high)),
      low: Math.min(...days.map(d => d.low)),
      volume: days.reduce((s, d) => s + d.volume, 0),
    });
  }
  return weekly.sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────
// 周线趋势判定（大周期方向过滤器）
// 返回: { score 0|10|20|30, label, signals }
// ─────────────────────────────────────────────
export interface WeeklyTrend {
  score: number;
  bullish: boolean;     // 周线多头（方向向上）
  label: string;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
}

export function assessWeeklyTrend(dailyRows: KlineRow[]): WeeklyTrend {
  const weekly = aggregateWeekly(dailyRows);
  const closes = weekly.map(w => w.close);
  const last = weekly[weekly.length - 1];
  const prev = weekly[weekly.length - 2];

  if (weekly.length < 20) {
    return { score: 0, bullish: false, label: '周线数据不足', ma5: null, ma10: null, ma20: null, ma60: null };
  }

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);   // 周MA10 ≈ 月线
  const ma20 = sma(closes, 20);   // 周MA20 ≈ 季线
  const ma60 = sma(closes, 60) ?? sma(closes, Math.min(closes.length, 60)); // 周MA60 ≈ 年线
  const prevMa10 = closes.length >= 11 ? sma(closes.slice(0, -1), 10) : null;
  const price = last.close;

  let score = 0;
  let label = '';

  // 周线站稳 MA60（年线级别）+ 多头排列：周MA5 > MA10 > MA20
  const aboveMa60 = ma60 !== null && price > ma60;
  const bullishAlign = ma5 !== null && ma10 !== null && ma20 !== null && ma5 > ma10 && ma10 > ma20;

  if (aboveMa60 && bullishAlign) {
    score = 30;
    label = '周线多头排列且站上年线';
  } else if (bullishAlign) {
    score = 20;
    label = '周线多头排列';
  } else if (aboveMa60) {
    score = 15;
    label = '周线站上年线';
  } else if (ma10 !== null && price > ma10) {
    score = 10;
    label = '周线站上月线';
  } else {
    score = 0;
    label = '周线偏弱';
  }

  // MA10 向上加分（已在 score 内体现方向）
  const ma10Up = prevMa10 !== null && ma10 !== null && ma10 > prevMa10;
  void ma10Up;

  const bullish = score >= 20;
  return { score, bullish, label, ma5, ma10, ma20, ma60 };
}

// ─────────────────────────────────────────────
// 三周期共振综合评分
// 输入: 日线 KLineRow[]（升序，建议 120+ 行）
// 输出: 0-100 综合评分 + 四维明细（大周期/中周期/量价/时机）
// ─────────────────────────────────────────────
export interface MultiCycleBreakdown {
  weeklyTrend: number;    // 大周期（满分 30）
  structure: number;      // 中周期日线结构（满分 30）
  volumePrice: number;    // 量价（满分 20）
  timing: number;         // 时机（满分 20）
}

export interface MultiCycleResult {
  score: number;
  breakdown: MultiCycleBreakdown;
  resonant: boolean;      // 是否三周期共振（大周期向上 + 中周期结构成立 + 时机确认 + 60分确认 + 月线非空）
  signals: { type: 'bullish' | 'bearish'; name: string; confidence: number }[];
  weekly: WeeklyTrend;
  monthly: MonthlyTrend | null;   // 月线趋势（第一层硬过滤）；无数据为 null
  atr14: number | null;
  stopLossPrice: number | null;  // 基于 ATR 的建议止损位
  intraday60: IntradayAssessment | null;  // 60分钟确认（无数据时为 null，退化为两周期）
}

/**
 * 三周期共振评分。resonant=true 表示大周期向上 + 日线结构成立 + 时机确认同时满足（手册"黄金点"）。
 * intraday60（60分钟）：要求第三层「小周期抓节奏」确认。
 * monthly（月线）：第一层硬过滤——月线空头则大周期近淘汰、resonant=false。
 */
export function scoreMultiCycle(rows: KlineRow[], opts?: { intraday60?: MinBar[]; monthly?: KlineRow[] }): MultiCycleResult {
  const signals: MultiCycleResult['signals'] = [];

  if (rows.length < 30) {
    return {
      score: 0, breakdown: { weeklyTrend: 0, structure: 0, volumePrice: 0, timing: 0 },
      resonant: false, signals, weekly: assessWeeklyTrend(rows),
      monthly: opts?.monthly ? assessMonthlyTrend(opts.monthly) : null,
      atr14: null, stopLossPrice: null,
      intraday60: opts?.intraday60 ? assessIntraday60(opts.intraday60) : null,
    };
  }

  const closes = rows.map(r => r.close);
  const vols = rows.map(r => r.volume);
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const price = last.close;

  const ma5 = safe(last.ma5) ?? sma(closes, 5);
  const ma10 = safe(last.ma10) ?? sma(closes, 10);
  const ma20 = safe(last.ma20) ?? sma(closes, 20);
  const ma60 = safe(last.ma60) ?? sma(closes, 60);
  const prevMa5 = safe(prev?.ma5) ?? (closes.length >= 6 ? sma(closes.slice(0, -1), 5) : null);
  const prevMa20 = safe(prev?.ma20) ?? (closes.length >= 21 ? sma(closes.slice(0, -1), 20) : null);

  const macd = safe(last.macd);
  const macdSignal = safe(last.macdSignal);
  const prevMacd = safe(prev?.macd);
  const prevMacdSignal = safe(prev?.macdSignal);
  const rsi = safe(last.rsi14);
  const kdjJ = safe(last.kdjJ);
  const prevKdjJ = safe(prev?.kdjJ);
  const kdjK = safe(last.kdjK);
  const prevKdjK = safe(prev?.kdjK);
  const bias6 = safe(last.bias6) ?? (ma5 ? ((price - ma5) / ma5) * 100 : null);
  const volRatio = safe(last.volRatio);
  const atr14 = safe(last.atr14);

  // ── 1. 大周期（周线趋势 + 月线硬过滤，满分 30）── 手册 2.1 第一层
  const weekly = assessWeeklyTrend(rows);
  const monthly = opts?.monthly ? assessMonthlyTrend(opts.monthly) : null;
  let weeklyTrend = weekly.score;
  if (weekly.bullish) signals.push({ type: 'bullish', name: '周线多头', confidence: 0.85 });
  // 月线第一层硬过滤：月线空头 → 大周期分近淘汰；月线多头 → 加成
  if (monthly) {
    if (monthly.bearish) {
      weeklyTrend = Math.min(weeklyTrend, 8);
      signals.push({ type: 'bearish', name: monthly.label, confidence: 0.85 });
    } else if (monthly.bullish) {
      weeklyTrend = Math.min(30, weeklyTrend + 5);
      signals.push({ type: 'bullish', name: monthly.label, confidence: 0.85 });
    }
  }

  // ── 2. 中周期（日线结构，满分 30）──
  let structure = 0;
  const bullishAlign = ma5 !== null && ma10 !== null && ma20 !== null && ma60 !== null
    && ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
  if (bullishAlign) {
    structure += 15;
    signals.push({ type: 'bullish', name: '日线多头排列', confidence: 0.9 });
  } else if (ma5 !== null && ma10 !== null && ma20 !== null && ma5 > ma10 && ma10 > ma20) {
    structure += 8;
  }
  if (ma20 !== null && price > ma20) structure += 6;
  if (ma60 !== null && price > ma60) structure += 4;
  // MACD 零轴上方
  if (macd !== null && macdSignal !== null && macd > 0 && macdSignal > 0) structure += 5;
  structure = Math.min(structure, 30);

  // ── 3. 量价（满分 20）──
  let volumePrice = 0;
  const avgVol5 = vols.length >= 5 ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const priceUp = price > (prev?.close ?? price);
  const ratio = volRatio ?? (avgVol5 && avgVol5 > 0 ? last.volume / avgVol5 : null);
  // 放量上涨（手册：突破需 1.5 倍量）
  if (ratio !== null && ratio >= 1.5 && priceUp) {
    volumePrice += 8;
    signals.push({ type: 'bullish', name: '放量上涨', confidence: 0.85 });
  } else if (priceUp && ratio !== null && ratio > 1.0) {
    volumePrice += 4;
  }
  // 缩量回调（健康休息）
  if (rows.length >= 4) {
    const recent3 = rows.slice(-3);
    const ref = rows[rows.length - 4]?.close ?? price;
    if (recent3.every(r => r.close <= ref) && recent3[2].volume < recent3[0].volume * 0.8) {
      volumePrice += 6;
      signals.push({ type: 'bullish', name: '缩量回调', confidence: 0.7 });
    }
  }
  // 换手率健康区间（3%-15% 主力资金流入）
  const turnover = safe(last.turnoverRate);
  if (turnover !== null && turnover >= 3 && turnover <= 15) volumePrice += 6;
  else if (turnover !== null && turnover > 25) signals.push({ type: 'bearish', name: '换手率过高', confidence: 0.7 });
  volumePrice = Math.min(volumePrice, 20);

  // ── 4. 时机（满分 20）──
  let timing = 0;
  // MACD 金叉
  if (prevMacd !== null && prevMacdSignal !== null && macd !== null && macdSignal !== null
    && prevMacd <= prevMacdSignal && macd > macdSignal) {
    const zeroAxis = macd > 0 && macdSignal > 0;
    timing += zeroAxis ? 8 : 5;
    signals.push({ type: 'bullish', name: zeroAxis ? 'MACD零轴上金叉' : 'MACD金叉', confidence: zeroAxis ? 0.88 : 0.75 });
  }
  // 520 金叉（MA5 上穿 MA20）
  if (ma5 && ma20 && prevMa5 && prevMa20 && prevMa5 <= prevMa20 && ma5 > ma20) {
    timing += 5;
    signals.push({ type: 'bullish', name: '520金叉', confidence: 0.8 });
  }
  // KDJ 低位金叉
  if (prevKdjJ !== null && kdjJ !== null && prevKdjK !== null && kdjK !== null
    && prevKdjJ <= prevKdjK && kdjJ > kdjK && kdjJ < 50) {
    timing += 4;
    signals.push({ type: 'bullish', name: 'KDJ低位金叉', confidence: 0.72 });
  }
  // RSI 健康区间
  if (rsi !== null) {
    if (rsi >= 50 && rsi <= 70) timing += 3;
    else if (rsi < 30) { timing += 4; signals.push({ type: 'bullish', name: 'RSI超卖', confidence: 0.7 }); }
    else if (rsi > 80) signals.push({ type: 'bearish', name: 'RSI超买', confidence: 0.75 });
  }
  timing = Math.min(timing, 20);

  // ── 5. 小周期（60 分钟）时机确认（若提供 intraday60）── 第三层「小周期抓节奏」
  const intraday60 = opts?.intraday60 ? assessIntraday60(opts.intraday60) : null;
  if (intraday60) {
    timing = Math.min(20, timing + intraday60.score);
    signals.push(...intraday60.signals);
  }

  const score = Math.round(weeklyTrend + structure + volumePrice + timing);

  // 三周期共振：大周期向上 + 日线结构成立（多头排列或站上MA20）+ 时机确认（有买入信号）
  // 若提供了 60 分钟数据，还要求第三层确认；月线空头（第一层硬过滤）则否决共振
  const structureValid = structure >= 14; // 至少多头排列+站上MA20
  const timingValid = timing >= 5;        // 至少一个时机信号
  const resonant = weekly.bullish && structureValid && timingValid
    && (intraday60 === null || intraday60.confirmed)
    && (monthly === null || !monthly.bearish);

  // 基于 ATR 的建议止损位（手册：1.5~2 倍 ATR，取 2 倍）
  const stopLossPrice = atr14 !== null ? price - 2 * atr14 : (ma20 !== null ? ma20 * 0.97 : null);

  return {
    score, resonant, signals, weekly, monthly, atr14,
    breakdown: { weeklyTrend, structure, volumePrice, timing },
    stopLossPrice, intraday60,
  };
}
