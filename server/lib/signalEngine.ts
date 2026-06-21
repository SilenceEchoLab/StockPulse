// 三周期共振打分引擎 —— 基于《趋势投资》核心理念
// 大周期定方向(40分) + 中周期选结构(30分) + 量价配合(15分) + 入场时机(15分)
// 输入: 最近N天的日K数据(含OHLCV + 技术指标)
// 输出: 0-100综合评分 + 结构化买卖信号列表

export interface KlineRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  macd: number | null;
  macdSignal: number | null;
  rsi14: number | null;
  kdjK: number | null;
  kdjD: number | null;
  kdjJ: number | null;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  ma120?: number | null;
  ma250?: number | null;
  bias6?: number | null;
  turnoverRate?: number | null;
}

export interface SignalItem {
  type: 'bullish' | 'bearish';
  name: string;
  confidence: number;
}

export interface ScoreBreakdown {
  trend: number;       // 大周期趋势 (满分40)
  structure: number;   // 中周期结构 (满分30)
  volumePrice: number; // 量价配合 (满分15)
  timing: number;      // 入场时机 (满分15)
}

export interface ScoreResult {
  score: number;
  signals: SignalItem[];
  breakdown: ScoreBreakdown;
}

// 从收盘价序列计算简单移动平均（DB 无 MA 字段时的降级方案）
function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}

function safe(val: number | null | undefined): number | null {
  return (typeof val === 'number' && isFinite(val)) ? val : null;
}

/**
 * 对单只股票的近期K线数据进行三周期共振打分
 * @param rows K线数据（按日期升序，至少需要20行，建议60+行）
 */
export function scoreStock(rows: KlineRow[]): ScoreResult {
  const signals: SignalItem[] = [];

  if (rows.length < 5) {
    return { score: 0, signals, breakdown: { trend: 0, structure: 0, volumePrice: 0, timing: 0 } };
  }

  const closes = rows.map(r => r.close);
  const vols = rows.map(r => r.volume);
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  // 优先使用 DB 预计算的 MA，降级为实时计算
  const ma5 = safe(last.ma5) ?? sma(closes, 5);
  const ma10 = safe(last.ma10) ?? sma(closes, 10);
  const ma20 = safe(last.ma20) ?? sma(closes, 20);
  const ma60 = safe(last.ma60) ?? sma(closes, 60);
  const ma120 = safe(last.ma120) ?? sma(closes, 120);
  const ma250 = safe(last.ma250) ?? sma(closes, 250);
  const prevMa60 = safe(prev?.ma60) ?? (closes.length >= 65 ? sma(closes.slice(0, -1), 60) : null);

  const price = last.close;
  const rsi = safe(last.rsi14);
  const macd = safe(last.macd);
  const macdSignal = safe(last.macdSignal);
  const prevMacd = safe(prev?.macd);
  const prevMacdSignal = safe(prev?.macdSignal);
  const kdjJ = safe(last.kdjJ);
  const kdjK = safe(last.kdjK);
  const prevKdjJ = safe(prev?.kdjJ);
  const prevKdjK = safe(prev?.kdjK);
  const bias6 = safe(last.bias6) ?? (ma5 ? ((price - ma5) / ma5) * 100 : null);
  const turnover = safe(last.turnoverRate);

  // ─── 1. 大周期趋势（满分40）───
  let trend = 0;

  // 站上年线(250日) = 长期多头（原书：新手极简系统要求所有均线在250日线上）
  if (ma250 && price > ma250) {
    trend += 15;
    signals.push({ type: 'bullish', name: '站上年线', confidence: 0.85 });
  }

  // 站上半年线(120日) = 中长期偏强
  if (ma120 && price > ma120) {
    trend += 10;
  }

  // 站上60日线 = 波段趋势确认（原书：突破60/120日线 = 趋势启动）
  if (ma60 && price > ma60) {
    trend += 10;
    signals.push({ type: 'bullish', name: '60日线之上', confidence: 0.7 });
  }

  // 60日线上升趋势（原书：顺大势，均线方向向上）
  if (ma60 && prevMa60 && ma60 > prevMa60) {
    trend += 5;
  }

  trend = Math.min(trend, 40);

  // ─── 2. 中周期结构（满分30）───
  let structure = 0;

  // 多头排列 MA5 > MA10 > MA20（原书核心：多头排列 = 强势多头）
  if (ma5 && ma10 && ma20 && ma5 > ma10 && ma10 > ma20) {
    structure += 15;
    signals.push({ type: 'bullish', name: '均线多头排列', confidence: 0.9 });
  } else if (ma5 && ma10 && ma5 > ma10) {
    structure += 6;
  }

  // 站上20日线 = 机构生命线之上（原书：稳在20日线上方 = 机构持仓）
  if (ma20 && price > ma20) {
    structure += 8;
  }

  // MACD 零轴上方（原书：零轴上方金叉 = 强势买入）
  if (macd !== null && macdSignal !== null) {
    if (macd > 0 && macdSignal > 0) {
      structure += 4;
    }
    // MACD 金叉（DIF 上穿 DEA）
    if (prevMacd !== null && prevMacdSignal !== null && prevMacd <= prevMacdSignal && macd > macdSignal) {
      structure += 3;
      signals.push({ type: 'bullish', name: 'MACD金叉', confidence: 0.8 });
    }
    // MACD 死叉
    if (prevMacd !== null && prevMacdSignal !== null && prevMacd >= prevMacdSignal && macd < macdSignal) {
      signals.push({ type: 'bearish', name: 'MACD死叉', confidence: 0.75 });
    }
  }

  structure = Math.min(structure, 30);

  // ─── 3. 量价配合（满分15）───
  let volumePrice = 0;

  // 放量上涨（原书：价涨量增 = 健康上涨；突破需1.5倍量）
  const avgVol5 = vols.length >= 5 ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const priceUp = price > (prev?.close ?? price);
  if (avgVol5 && last.volume > avgVol5 * 1.5 && priceUp) {
    volumePrice += 5;
    signals.push({ type: 'bullish', name: '放量上涨', confidence: 0.85 });
  } else if (priceUp && last.volume > (avgVol5 ?? 0)) {
    volumePrice += 2;
  }

  // 换手率健康区间（原书：3%-15% = 主力资金流入）
  if (turnover !== null) {
    if (turnover >= 3 && turnover <= 15) {
      volumePrice += 5;
    } else if (turnover > 25) {
      // 高位高换手 = 出货风险
      signals.push({ type: 'bearish', name: '换手率过高', confidence: 0.7 });
    }
  }

  // 近3日缩量回调（原书：回调缩量 = 主力未出货，健康休息）
  if (rows.length >= 4) {
    const recent3 = rows.slice(-3);
    const allDown = recent3.every(r => r.close <= (rows[rows.length - 4]?.close ?? r.close));
    const volsShrinking = recent3[2].volume < recent3[0].volume;
    if (allDown && volsShrinking) {
      volumePrice += 5;
      signals.push({ type: 'bullish', name: '缩量回调', confidence: 0.7 });
    }
  }

  volumePrice = Math.min(volumePrice, 15);

  // ─── 4. 入场时机（满分15）───
  let timing = 0;

  // RSI 健康区间（原书：50-70 偏多，30-50 可反弹）
  if (rsi !== null) {
    if (rsi >= 50 && rsi <= 70) {
      timing += 5;
    } else if (rsi >= 30 && rsi < 50) {
      timing += 3;
    } else if (rsi > 80) {
      signals.push({ type: 'bearish', name: 'RSI超买', confidence: 0.75 });
    } else if (rsi < 20) {
      timing += 4;
      signals.push({ type: 'bullish', name: 'RSI超卖', confidence: 0.7 });
    }
  }

  // KDJ 金叉（J 上穿 K 或 J 从负转正）
  if (kdjJ !== null && prevKdjJ !== null && kdjK !== null && prevKdjK !== null) {
    if (prevKdjJ <= prevKdjK && kdjJ > kdjK) {
      timing += 5;
      signals.push({ type: 'bullish', name: 'KDJ金叉', confidence: 0.75 });
    }
  }

  // 乖离率超卖反弹（原书：BIAS6 < -6% = 技术性反弹买入）
  if (bias6 !== null) {
    if (bias6 < -6) {
      timing += 5;
      signals.push({ type: 'bullish', name: 'BIAS超卖', confidence: 0.7 });
    } else if (bias6 > 6) {
      signals.push({ type: 'bearish', name: 'BIAS超买', confidence: 0.65 });
    }
  }

  timing = Math.min(timing, 15);

  const score = Math.round(trend + structure + volumePrice + timing);

  return {
    score,
    signals,
    breakdown: { trend, structure, volumePrice, timing },
  };
}

/**
 * 逆向反转策略评分：寻找超跌底部结构（原书：超卖 + 底部信号）
 */
export function scoreContrarian(rows: KlineRow[]): ScoreResult {
  const base = scoreStock(rows);
  const signals: SignalItem[] = [];
  let score = 0;

  if (rows.length < 10) return { score: 0, signals: [], breakdown: { ...base.breakdown } };

  const last = rows[rows.length - 1];
  const rsi = safe(last.rsi14);
  const ma20 = safe(last.ma20) ?? sma(rows.map(r => r.close), 20);
  const bias6 = safe(last.bias6) ?? (ma20 ? ((last.close - ma20) / ma20) * 100 : null);

  // RSI 超卖（原书：< 20 = 极端超卖买入，20-30 = 考虑买入）
  if (rsi !== null && rsi < 30) {
    score += 30;
    signals.push({ type: 'bullish', name: 'RSI超卖反弹', confidence: 0.8 });
  } else if (rsi !== null && rsi < 40) {
    score += 15;
  }

  // BIAS 超卖（原书：BIAS6 < -6% = 技术性反弹买入）
  if (bias6 !== null && bias6 < -6) {
    score += 25;
    signals.push({ type: 'bullish', name: '乖离率超卖', confidence: 0.75 });
  } else if (bias6 !== null && bias6 < -4) {
    score += 12;
  }

  // 近期缩量企稳（原书：价跌量缩 = 抛压衰竭/筑底）
  const recent5 = rows.slice(-5);
  const avgVol = recent5.reduce((s, r) => s + r.volume, 0) / 5;
  const prevAvgVol = rows.length >= 10
    ? rows.slice(-10, -5).reduce((s, r) => s + r.volume, 0) / 5
    : avgVol;
  if (avgVol < prevAvgVol * 0.7) {
    score += 20;
    signals.push({ type: 'bullish', name: '缩量企稳', confidence: 0.7 });
  }

  // 价格接近20日线下方（回踩支撑，原书：回调至20日均线企稳 = 低吸）
  if (ma20 && Math.abs(last.close - ma20) / ma20 < 0.03) {
    score += 15;
    signals.push({ type: 'bullish', name: '回踩20日线', confidence: 0.65 });
  }

  // KDJ 底部金叉
  const kdjJ = safe(last.kdjJ);
  const prevKdjJ = safe(rows[rows.length - 2]?.kdjJ);
  if (kdjJ !== null && prevKdjJ !== null && prevKdjJ < 0 && kdjJ > prevKdjJ) {
    score += 10;
    signals.push({ type: 'bullish', name: 'KDJ底部回升', confidence: 0.7 });
  }

  score = Math.min(score, 100);

  return {
    score,
    signals: signals.length > 0 ? signals : base.signals,
    breakdown: base.breakdown,
  };
}

// ─────────────────────────────────────────────
// 买卖信号检测 —— 对应《选股交易操作手册》第三~六步
// 返回买点信号、卖点信号、风险信号分类列表，供个股详情页展示
// ─────────────────────────────────────────────

export interface BuySignal {
  name: string;
  detail: string;
  confidence: number;
}

export interface SellSignal {
  name: string;
  detail: string;
  urgency: 'high' | 'medium' | 'low';
}

export interface RiskTag {
  name: string;
  level: 'danger' | 'warning' | 'caution';
  detail: string;
}

export interface FullSignalReport {
  score: number;
  scoreLabel: string;
  breakdown: ScoreBreakdown;
  maStatus: { ma5: number | null; ma10: number | null; ma20: number | null; ma60: number | null; ma120: number | null; ma250: number | null };
  alignment: 'bullish' | 'bearish' | 'neutral';
  buySignals: BuySignal[];
  sellSignals: SellSignal[];
  riskTags: RiskTag[];
  suggestion: string;
}

function maxOf(arr: number[]): number {
  return arr.length > 0 ? Math.max(...arr) : 0;
}

/**
 * 完整买卖信号检测 —— 买入点、卖出/逃顶信号、风险标签
 * 对应手册: 买点(13类) / 卖点(9类) / 逃顶信号(15类) / 风险标签
 */
export function detectSignals(rows: KlineRow[]): FullSignalReport {
  const buySignals: BuySignal[] = [];
  const sellSignals: SellSignal[] = [];
  const riskTags: RiskTag[] = [];

  if (rows.length < 10) {
    return {
      score: 0, scoreLabel: '数据不足', breakdown: { trend: 0, structure: 0, volumePrice: 0, timing: 0 },
      maStatus: { ma5: null, ma10: null, ma20: null, ma60: null, ma120: null, ma250: null },
      alignment: 'neutral', buySignals, sellSignals, riskTags, suggestion: '数据不足,无法分析',
    };
  }

  const { score, breakdown } = scoreStock(rows);
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const closes = rows.map(r => r.close);
  const highs = rows.map(r => r.high);
  const vols = rows.map(r => r.volume);
  const price = last.close;

  const ma5 = safe(last.ma5) ?? sma(closes, 5);
  const ma10 = safe(last.ma10) ?? sma(closes, 10);
  const ma20 = safe(last.ma20) ?? sma(closes, 20);
  const ma60 = safe(last.ma60) ?? sma(closes, 60);
  const ma120 = safe(last.ma120) ?? sma(closes, 120);
  const ma250 = safe(last.ma250) ?? sma(closes, 250);
  const prevMa5 = safe(prev?.ma5) ?? (closes.length >= 6 ? sma(closes.slice(0, -1), 5) : null);
  const prevMa20 = safe(prev?.ma20) ?? (closes.length >= 21 ? sma(closes.slice(0, -1), 20) : null);

  const rsi = safe(last.rsi14);
  const macd = safe(last.macd);
  const macdSignal = safe(last.macdSignal);
  const prevMacd = safe(prev?.macd);
  const prevMacdSignal = safe(prev?.macdSignal);
  const kdjJ = safe(last.kdjJ);
  const prevKdjJ = safe(prev?.kdjJ);
  const kdjK = safe(last.kdjK);
  const prevKdjK = safe(prev?.kdjK);
  const bias6 = safe(last.bias6) ?? (ma5 ? ((price - ma5) / ma5) * 100 : null);
  const turnover = safe(last.turnoverRate);

  const avgVol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, vols.length);

  // ──── 多空排列判定 ────
  let alignment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (ma5 && ma10 && ma20 && ma60) {
    if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) alignment = 'bullish';
    else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) alignment = 'bearish';
  }

  // ════ 买入信号检测 ════

  // 1. MACD 金叉
  if (prevMacd !== null && prevMacdSignal !== null && macd !== null && macdSignal !== null) {
    if (prevMacd <= prevMacdSignal && macd > macdSignal) {
      const zeroAxis = macd > 0 && macdSignal > 0;
      buySignals.push({
        name: zeroAxis ? 'MACD零轴上方金叉' : 'MACD金叉',
        detail: zeroAxis ? '强势多头调整结束,零轴上方金叉,可靠性高' : 'DIF上穿DEA,短期转多信号',
        confidence: zeroAxis ? 0.85 : 0.7,
      });
    }
  }

  // 2. KDJ 金叉
  if (prevKdjJ !== null && kdjJ !== null && prevKdjK !== null && kdjK !== null) {
    if (prevKdjJ <= prevKdjK && kdjJ > kdjK && kdjJ < 50) {
      buySignals.push({ name: 'KDJ低位金叉', detail: 'KDJ在低位金叉,超跌反弹信号', confidence: 0.7 });
    }
  }

  // 3. BIAS 超卖反弹
  if (bias6 !== null && bias6 < -6) {
    buySignals.push({ name: '乖离率超卖', detail: `BIAS6=${bias6.toFixed(1)}%,短期超跌,技术性反弹预期`, confidence: 0.7 });
  }

  // 4. RSI 超卖
  if (rsi !== null && rsi < 20) {
    buySignals.push({ name: 'RSI极端超卖', detail: `RSI=${rsi.toFixed(0)},极端超卖,反弹概率大`, confidence: 0.7 });
  }

  // 5. 回踩5日线企稳(主升浪中)
  if (ma5 && prevMa5 && prev && last.low <= ma5 * 1.005 && price > ma5 && prev.close > prevMa5) {
    buySignals.push({ name: '回踩5日线企稳', detail: '主升浪中回踩5日线不破,短线买点', confidence: 0.7 });
  }

  // 6. 回踩20日线企稳(波段买点)
  if (ma20 && Math.abs(last.low - ma20) / ma20 < 0.02 && price > ma20 && alignment === 'bullish') {
    buySignals.push({ name: '回踩20日线', detail: '上升趋势中回踩20日线(机构生命线)企稳,波段低吸点', confidence: 0.75 });
  }

  // 7. 放量突破
  if (last.volume > avgVol5 * 1.5 && price > last.open && vols.slice(-3, -1).every(v => v < avgVol5 * 1.2)) {
    buySignals.push({ name: '放量突破', detail: '成交量放大1.5倍以上且收阳,有效突破信号', confidence: 0.8 });
  }

  // 8. 520战法金叉(MA5上穿MA20)
  if (ma5 && ma20 && prevMa5 && prevMa20 && prevMa5 <= prevMa20 && ma5 > ma20) {
    buySignals.push({ name: '520金叉', detail: 'MA5上穿MA20,波段做多信号(520战法)', confidence: 0.75 });
  }

  // 9. 站上60日线(趋势启动)
  if (ma60 && prev && prev.close <= ma60 && price > ma60) {
    buySignals.push({ name: '突破60日线', detail: '放量站上60日线,波段趋势启动确认', confidence: 0.7 });
  }

  // 10. 缩量回调(健康休息)
  if (rows.length >= 4) {
    const recent3 = rows.slice(-3);
    const ref = rows[rows.length - 4]?.close ?? price;
    if (recent3.every(r => r.close <= ref) && recent3[2].volume < recent3[0].volume * 0.8) {
      buySignals.push({ name: '缩量回调', detail: '连续回调但成交量萎缩,主力未出货,属健康休息', confidence: 0.65 });
    }
  }

  // 11. MACD 底背离
  if (rows.length >= 30 && macd !== null) {
    const recent20 = rows.slice(-20);
    const firstHalf = recent20.slice(0, 10);
    const minPrice1 = Math.min(...firstHalf.map(r => r.low));
    const minPrice2 = Math.min(...recent20.slice(10).map(r => r.low));
    const minMacd1 = Math.min(...firstHalf.map(r => safe(r.macd) ?? 0));
    const minMacd2 = Math.min(...recent20.slice(10).map(r => safe(r.macd) ?? 0));
    if (minPrice2 < minPrice1 && minMacd2 > minMacd1) {
      buySignals.push({ name: 'MACD底背离', detail: '股价新低但MACD未新低,下跌动能衰竭,关注止跌', confidence: 0.75 });
    }
  }

  // ════ 卖出信号检测 ════

  // 1. 3天不创新高
  if (rows.length >= 4) {
    const recent3Highs = highs.slice(-3);
    const refHigh = highs[highs.length - 4] ?? 0;
    if (maxOf(recent3Highs) <= refHigh) {
      sellSignals.push({ name: '3天不创新高', detail: '连续3个交易日未突破前高,强势股动能减弱,需关注卖点', urgency: 'medium' });
    }
  }

  // 2. 放量跌破5日线
  if (ma5 && prev && prev.close >= (safe(prev.ma5) ?? prev.close) && price < ma5 && last.volume > avgVol5) {
    sellSignals.push({ name: '放量跌破5日线', detail: '强势股沿5日线上涨,放量跌破5日线 = 短期见顶信号,坚决离场', urgency: 'high' });
  }

  // 3. MACD 死叉
  if (prevMacd !== null && prevMacdSignal !== null && macd !== null && macdSignal !== null) {
    if (prevMacd >= prevMacdSignal && macd < macdSignal) {
      const zeroAxis = macd < 0 && macdSignal < 0;
      sellSignals.push({
        name: zeroAxis ? 'MACD零轴下方死叉' : 'MACD死叉',
        detail: zeroAxis ? '零轴下方死叉+放量 = 加速杀跌前兆,不宜抄底' : 'DIF下穿DEA,短期转空',
        urgency: zeroAxis ? 'high' : 'medium',
      });
    }
  }

  // 4. MACD 顶背离
  if (rows.length >= 30 && macd !== null) {
    const recent20 = rows.slice(-20);
    const firstHalf = recent20.slice(0, 10);
    const maxPrice1 = Math.max(...firstHalf.map(r => r.high));
    const maxPrice2 = Math.max(...recent20.slice(10).map(r => r.high));
    const maxMacd1 = Math.max(...firstHalf.map(r => safe(r.macd) ?? 0));
    const maxMacd2 = Math.max(...recent20.slice(10).map(r => safe(r.macd) ?? 0));
    if (maxPrice2 > maxPrice1 && maxMacd2 < maxMacd1) {
      sellSignals.push({ name: 'MACD顶背离', detail: '股价新高但MACD未新高,上涨乏力,止盈/减仓,不追高', urgency: 'high' });
    }
  }

  // 5. RSI 超买回落
  if (rsi !== null && rsi > 80) {
    sellSignals.push({ name: 'RSI极端超买', detail: `RSI=${rsi.toFixed(0)},极端超买,回调概率大,减仓`, urgency: 'medium' });
  }

  // 6. 放量滞涨(出货信号)
  if (last.volume > avgVol5 * 1.5 && Math.abs(price - last.open) / last.open < 0.01) {
    sellSignals.push({ name: '放量滞涨', detail: '成交量放大但价格不涨,主力出货特征,卖出', urgency: 'high' });
  }

  // 7. 520战法死叉(MA5下穿MA20)
  if (ma5 && ma20 && prevMa5 && prevMa20 && prevMa5 >= prevMa20 && ma5 < ma20) {
    sellSignals.push({ name: '520死叉', detail: 'MA5下穿MA20,波段做空信号(520战法),卖出', urgency: 'high' });
  }

  // 8. 跌破20日线(趋势转弱)
  if (ma20 && prev && prev.close >= (safe(prev.ma20) ?? prev.close) && price < ma20) {
    sellSignals.push({ name: '跌破20日线', detail: '跌破20日线(机构生命线),机构减仓/止盈,趋势转弱', urgency: 'high' });
  }

  // 9. 高位长上影(射击之星)
  const upperShadow = last.high - Math.max(price, last.open);
  const body = Math.abs(price - last.open);
  if (upperShadow > body * 2 && (price / ma20 > 1.1) && last.volume > avgVol5) {
    sellSignals.push({ name: '高位长上影', detail: '高位放量长上影线(射击之星),冲高受阻,涨势将尽', urgency: 'medium' });
  }

  // 10. BIAS 超买
  if (bias6 !== null && bias6 > 6) {
    sellSignals.push({ name: '乖离率超买', detail: `BIAS6=${bias6.toFixed(1)}%,短期涨幅过大,获利回吐风险`, urgency: 'low' });
  }

  // ════ 风险标签 ════

  // 换手率过高 = 出货风险
  if (turnover !== null && turnover > 25) {
    const level = turnover > 70 ? 'danger' : turnover > 50 ? 'warning' : 'caution';
    riskTags.push({ name: turnover > 70 ? '换手率极高' : '换手率偏高', level, detail: `换手率${turnover.toFixed(1)}%,${turnover > 70 ? '主力疯狂出逃' : '高位出货风险'}` });
  }

  // 价格远离20日线 = 悬空风险
  if (ma20 && bias6 !== null && Math.abs(bias6) > 10) {
    riskTags.push({ name: '价格偏离均线', level: 'warning', detail: `偏离20日线过大,短线回调风险` });
  }

  // 空头排列
  if (alignment === 'bearish') {
    riskTags.push({ name: '均线空头排列', level: 'danger', detail: 'MA5<MA10<MA20<MA60,下跌趋势,不宜介入' });
  }

  // 均线纠缠(方向不明)
  if (ma5 && ma10 && ma20 && Math.abs(ma5 - ma20) / ma20 < 0.02 && Math.abs(ma10 - ma20) / ma20 < 0.02) {
    riskTags.push({ name: '均线纠缠', level: 'caution', detail: '短期均线纠缠,方向不明,等待突破' });
  }

  // ─── 综合建议 ───
  let suggestion = '';
  const hasHighSell = sellSignals.some(s => s.urgency === 'high');
  const hasDanger = riskTags.some(r => r.level === 'danger');
  if (hasHighSell || hasDanger) {
    suggestion = '出现高危卖出信号或风险标签,建议减仓/离场观望';
  } else if (sellSignals.length > 0) {
    suggestion = '出现卖出信号,密切关注,做好减仓准备';
  } else if (buySignals.length >= 3 && alignment === 'bullish') {
    suggestion = '多重买入信号共振且多头排列,可考虑分批建仓(首仓不超过10%)';
  } else if (buySignals.length > 0) {
    suggestion = '出现买入信号,可轻仓关注,等待更多确认';
  } else if (alignment === 'neutral') {
    suggestion = '趋势不明,观望为主,等待方向选择';
  } else {
    suggestion = '暂无明显信号,维持观望';
  }

  const scoreLabel = score >= 75 ? '强势多头' : score >= 55 ? '偏多震荡' : score >= 35 ? '偏弱观望' : '弱势回避';

  return {
    score,
    scoreLabel,
    breakdown,
    maStatus: { ma5, ma10, ma20, ma60, ma120, ma250 },
    alignment,
    buySignals,
    sellSignals,
    riskTags,
    suggestion,
  };
}
