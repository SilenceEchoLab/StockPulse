// 大盘择时引擎 —— 对应《选股交易操作手册》第一步：择时（判断大盘环境，决定仓位上限）
// 核心认知：不要跳出大盘看板块和个股。大盘是风向标，逆水行舟必覆。
//
// 四指标共振判定（手册 1.1）：
//   1. 均线：站稳 60 日线 + 5>20>60 多头排列 = 多头；跌破 60 日线空头排列 = 空头
//   2. MACD：零轴上方金叉红柱 = 多头；零轴下方死叉绿柱 = 空头
//   3. 量能：放量上涨 = 多头；缩量阴跌 = 空头
//   4. 高低点（道氏）：高点抬高+低点抬高 = 多头；反之空头
//
// 共振映射仓位上限（手册 1.3）：
//   牛市主升(≥3 多) → 70-80%   震荡市(2 多或分歧) → 50%   弱势(≥3 空) → 0-30%

import type { KlineRow } from './signalEngine.js';
import { sma, safe } from './indicatorUtil.js';

export type Regime = 'bull' | 'range' | 'bear';

export interface TimingSignal {
  name: string;            // 均线 / MACD / 量能 / 高低点
  status: 'bull' | 'bear' | 'neutral';
  score: number;           // +1 / 0 / -1
  detail: string;
}

export interface MarketTiming {
  regime: Regime;
  regimeLabel: string;     // 牛市主升 / 震荡市 / 弱势下跌
  maxPosition: number;     // 仓位上限 0~1
  score: number;           // -4 ~ +4
  bullishCount: number;
  bearishCount: number;
  signals: TimingSignal[];
  indexCode: string;
  asOf: string;            // 判定基准日
  indexTrend: {
    close: number; ma5: number | null; ma20: number | null;
    ma60: number | null; ma250: number | null;
  };
  suggestion: string;      // 操作建议
}

/**
 * 评估大盘择时状态。输入指数（建议沪深300 sh000300）日线，至少 60 行。
 */
export function assessMarketTiming(rows: KlineRow[], indexCode = 'sh000300'): MarketTiming {
  const signals: TimingSignal[] = [];

  if (rows.length < 60) {
    return {
      regime: 'range', regimeLabel: '数据不足', maxPosition: 0.3, score: 0,
      bullishCount: 0, bearishCount: 0, signals: [],
      indexCode, asOf: rows[rows.length - 1]?.date ?? '',
      indexTrend: { close: rows[rows.length - 1]?.close ?? 0, ma5: null, ma20: null, ma60: null, ma250: null },
      suggestion: '指数历史数据不足 60 日，无法判定大盘环境，默认保守 30% 仓位。',
    };
  }

  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const closes = rows.map(r => r.close);
  const price = last.close;

  const ma5 = safe(last.ma5) ?? sma(closes, 5);
  const ma20 = safe(last.ma20) ?? sma(closes, 20);
  const ma60 = safe(last.ma60) ?? sma(closes, 60);
  const ma250 = safe(last.ma250) ?? sma(closes, 250);
  const prevMa60 = safe(prev?.ma60) ?? (closes.length >= 61 ? sma(closes.slice(0, -1), 60) : null);

  const macd = safe(last.macd);
  const macdSignal = safe(last.macdSignal);
  const prevMacd = safe(prev?.macd);
  const prevMacdSignal = safe(prev?.macdSignal);
  const macdHist = (macd !== null && macdSignal !== null) ? macd - macdSignal : null;

  const volRatio = safe(last.volRatio);
  const vols = rows.map(r => r.volume);

  // ── 指标 1：均线系统 ──
  let maScore = 0;
  let maStatus: 'bull' | 'bear' | 'neutral' = 'neutral';
  let maDetail = '';
  const above60 = ma60 !== null && price > ma60;
  const bullishAlign = ma5 !== null && ma20 !== null && ma60 !== null && ma5 > ma20 && ma20 > ma60;
  const below60 = ma60 !== null && price < ma60;
  const bearishAlign = ma5 !== null && ma20 !== null && ma60 !== null && ma5 < ma20 && ma20 < ma60;
  if (above60 && bullishAlign) {
    maScore = 1; maStatus = 'bull';
    maDetail = `站稳 60 日线且 5>20>60 多头排列（价 ${price.toFixed(0)} > MA60 ${ma60!.toFixed(0)}）`;
  } else if (below60 && bearishAlign) {
    maScore = -1; maStatus = 'bear';
    maDetail = `跌破 60 日线且空头排列（价 ${price.toFixed(0)} < MA60 ${ma60!.toFixed(0)}）`;
  } else if (above60) {
    maScore = 0.5; maStatus = 'neutral';
    maDetail = `站上 60 日线但未形成多头排列，偏强震荡`;
  } else if (below60) {
    maScore = -0.5; maStatus = 'neutral';
    maDetail = `位于 60 日线下方，偏弱`;
  }
  // 60 日线方向加分
  if (ma60 !== null && prevMa60 !== null && ma60 > prevMa60 && maScore > 0) {
    maDetail += '，60 日线向上';
  }
  signals.push({ name: '均线系统', status: maStatus, score: maScore, detail: maDetail });

  // ── 指标 2：MACD ──
  let macdScore = 0;
  let macdStatus: 'bull' | 'bear' | 'neutral' = 'neutral';
  let macdDetail = '';
  if (macd !== null && macdSignal !== null) {
    const aboveZero = macd > 0 && macdSignal > 0;
    const belowZero = macd < 0 && macdSignal < 0;
    const goldenCross = prevMacd !== null && prevMacdSignal !== null && prevMacd <= prevMacdSignal && macd > macdSignal;
    const deathCross = prevMacd !== null && prevMacdSignal !== null && prevMacd >= prevMacdSignal && macd < macdSignal;
    if (aboveZero && (goldenCross || (macdHist !== null && macdHist > 0))) {
      macdScore = 1; macdStatus = 'bull';
      macdDetail = `零轴上方${goldenCross ? '金叉' : '红柱'}，多头动能（DIF ${macd.toFixed(1)}）`;
    } else if (belowZero && (deathCross || (macdHist !== null && macdHist < 0))) {
      macdScore = -1; macdStatus = 'bear';
      macdDetail = `零轴下方${deathCross ? '死叉' : '绿柱'}，空头动能（DIF ${macd.toFixed(1)}）`;
    } else if (aboveZero) {
      macdScore = 0.5; macdStatus = 'neutral';
      macdDetail = 'MACD 位于零轴上方但动能减弱';
    } else {
      macdScore = -0.5; macdStatus = 'neutral';
      macdDetail = 'MACD 位于零轴下方';
    }
  }
  signals.push({ name: 'MACD', status: macdStatus, score: macdScore, detail: macdDetail });

  // ── 指标 3：量能 ──
  let volScore = 0;
  let volStatus: 'bull' | 'bear' | 'neutral' = 'neutral';
  let volDetail = '';
  const avgVol5 = vols.length >= 5 ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const priceUp = price > (prev?.close ?? price);
  const ratio = volRatio ?? (avgVol5 && avgVol5 > 0 ? last.volume / avgVol5 : null);
  if (ratio !== null) {
    if (ratio >= 1.2 && priceUp) {
      volScore = 1; volStatus = 'bull';
      volDetail = `放量上涨（量比 ${ratio.toFixed(2)}），健康上行`;
    } else if (ratio < 0.7 && !priceUp) {
      volScore = -1; volStatus = 'bear';
      volDetail = `缩量阴跌（量比 ${ratio.toFixed(2)}），抛压减弱但动能不足`;
    } else if (ratio >= 1.5 && !priceUp) {
      volScore = -1; volStatus = 'bear';
      volDetail = `放量下跌（量比 ${ratio.toFixed(2)}），高位警惕出货`;
    } else {
      volScore = 0; volStatus = 'neutral';
      volDetail = `量能平稳（量比 ${ratio.toFixed(2)}）`;
    }
  }
  signals.push({ name: '量能', status: volStatus, score: volScore, detail: volDetail });

  // ── 指标 4：高低点（道氏理论）──
  let dowScore = 0;
  let dowStatus: 'bull' | 'bear' | 'neutral' = 'neutral';
  let dowDetail = '';
  if (rows.length >= 40) {
    const recent = rows.slice(-20);
    const prev20 = rows.slice(-40, -20);
    const recentHigh = Math.max(...recent.map(r => r.high));
    const recentLow = Math.min(...recent.map(r => r.low));
    const prevHigh = Math.max(...prev20.map(r => r.high));
    const prevLow = Math.min(...prev20.map(r => r.low));
    const higherHigh = recentHigh > prevHigh;
    const higherLow = recentLow > prevLow;
    const lowerHigh = recentHigh < prevHigh;
    const lowerLow = recentLow < prevLow;
    if (higherHigh && higherLow) {
      dowScore = 1; dowStatus = 'bull';
      dowDetail = '近 20 日高点与低点双双抬高，上升趋势（道氏）';
    } else if (lowerHigh && lowerLow) {
      dowScore = -1; dowStatus = 'bear';
      dowDetail = '近 20 日高点与低点双双降低，下降趋势（道氏）';
    } else {
      dowScore = 0; dowStatus = 'neutral';
      dowDetail = '高低点结构混乱，趋势不明';
    }
  }
  signals.push({ name: '高低点(道氏)', status: dowStatus, score: dowScore, detail: dowDetail });

  // ── 综合判定 ──
  const totalScore = signals.reduce((s, x) => s + x.score, 0);
  const bullishCount = signals.filter(s => s.score >= 1).length;
  const bearishCount = signals.filter(s => s.score <= -1).length;

  let regime: Regime;
  let regimeLabel: string;
  let maxPosition: number;
  if (totalScore >= 2) {
    regime = 'bull'; regimeLabel = '牛市主升（多头共振）'; maxPosition = 0.75;
  } else if (totalScore <= -2) {
    regime = 'bear'; regimeLabel = '弱势下跌（空头共振）'; maxPosition = 0.2;
  } else {
    regime = 'range'; regimeLabel = '震荡市（分歧轮动）'; maxPosition = 0.5;
  }

  const suggestion =
    regime === 'bull'
      ? `大盘多头共振，仓位上限 ${Math.round(maxPosition * 100)}%。配置：中长线龙头 50-60% + 波段 30-40% + 短线 10-20%。`
      : regime === 'bear'
      ? `大盘空头共振，仓位上限 ${Math.round(maxPosition * 100)}%。防御为主（红利/高股息），或空仓等待，宁可少做不做。`
      : `大盘震荡，仓位上限 ${Math.round(maxPosition * 100)}%。半仓滚动，30%-70% 区间高抛低吸。`;

  return {
    regime, regimeLabel, maxPosition, score: Number(totalScore.toFixed(2)),
    bullishCount, bearishCount, signals,
    indexCode, asOf: last.date,
    indexTrend: { close: price, ma5, ma20, ma60, ma250 },
    suggestion,
  };
}
