import { MACD, RSI, BollingerBands, Stochastic, SMA, ATR, OBV } from 'technicalindicators';

const MA_PERIODS = [5, 10, 20, 60, 120, 250];
const BIAS_PERIODS = [6, 12, 24];

// 将指标结果数组左对齐补 null，保证与原始 K 线长度一致（指标有 warmup 期）
function pad<T>(arr: T[], len: number, val: T): T[] {
  const front = Math.max(0, len - arr.length);
  return [...new Array(front).fill(val), ...arr];
}

export interface IndicatorResult {
  pMacd: ({ MACD: number | null; signal: number | null; histogram: number | null })[];
  pRsi: (number | null)[];
  pBb: ({ lower: number | null; middle: number | null; upper: number | null })[];
  pKdj: ({ k: number | null; d: number | null })[];
  pMa: Record<string, (number | null)[]>;
  pBias: Record<string, (number | null)[]>;
  // 新增：风控与资金流指标
  pAtr: (number | null)[];       // ATR(14) 真实波动幅度 —— 止损位 = 1.5~2 倍 ATR
  pObv: (number | null)[];       // OBV 能量潮 —— 量价背离判断主力资金进出
  pVolMa5: (number | null)[];    // 5 日成交量均量 —— 量比基准
  pVolRatio: (number | null)[];  // 量比 = 当日量 / 5 日均量（>1.5 为放量，手册要求）
}

/**
 * 计算全部技术指标。
 * @param closePrices 收盘价序列
 * @param highPrices  最高价序列
 * @param lowPrices   最低价序列
 * @param volumePrices 成交量序列（可选，缺失时 OBV/量比为 null）
 */
export function calculateIndicators(
  closePrices: number[],
  highPrices: number[],
  lowPrices: number[],
  volumePrices?: number[],
): IndicatorResult {
  const len = closePrices.length;

  // 数据过短直接返回全 null，避免 warmup 期对齐漂移（B14 修复）
  if (len < 35) {
    const nullArr = closePrices.map(() => null);
    const nullObj = { MACD: null, signal: null, histogram: null };
    const nullBb = { lower: null, middle: null, upper: null };
    const nullKdj = { k: null, d: null };
    const pMa: Record<string, (number | null)[]> = {};
    for (const p of MA_PERIODS) pMa[`ma${p}`] = [...nullArr];
    const pBias: Record<string, (number | null)[]> = {};
    for (const p of BIAS_PERIODS) pBias[`bias${p}`] = [...nullArr];
    return {
      pMacd: closePrices.map(() => ({ ...nullObj })),
      pRsi: [...nullArr],
      pBb: closePrices.map(() => ({ ...nullBb })),
      pKdj: closePrices.map(() => ({ ...nullKdj })),
      pMa, pBias,
      pAtr: [...nullArr], pObv: [...nullArr], pVolMa5: [...nullArr], pVolRatio: [...nullArr],
    };
  }

  const macdResult = MACD.calculate({ values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const rsiResult = RSI.calculate({ values: closePrices, period: 14 });
  const bbResult = BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });
  const kdjResult = Stochastic.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 9, signalPeriod: 3 });

  // 均线系统 MA5/10/20/60/120/250 —— 趋势投资核心趋势判断依据
  const pMa: Record<string, (number | null)[]> = {};
  for (const period of MA_PERIODS) {
    const vals = SMA.calculate({ period, values: closePrices });
    pMa[`ma${period}`] = pad(vals, len, null as any);
  }

  // 乖离率 BIAS —— 衡量价格偏离均线的超买超卖程度
  const pBias: Record<string, (number | null)[]> = {};
  for (const period of BIAS_PERIODS) {
    const maVals = SMA.calculate({ period, values: closePrices });
    const padded = pad(maVals, len, null as any);
    pBias[`bias${period}`] = closePrices.map((c, i) =>
      padded[i] !== null ? ((c - (padded[i] as number)) / (padded[i] as number)) * 100 : null
    );
  }

  // ATR(14) —— 真实波动幅度，原书止损位标准：1.5~2 倍 ATR
  const atrVals = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });
  const pAtr = pad(atrVals, len, null);

  // OBV 能量潮 / 5 日均量 / 量比 —— 需要成交量
  let pObv: (number | null)[] = closePrices.map(() => null);
  let pVolMa5: (number | null)[] = closePrices.map(() => null);
  let pVolRatio: (number | null)[] = closePrices.map(() => null);
  if (volumePrices && volumePrices.length === len) {
    const obvVals = OBV.calculate({ close: closePrices, volume: volumePrices });
    pObv = pad(obvVals, len, null);
    const volMa5Vals = SMA.calculate({ period: 5, values: volumePrices });
    pVolMa5 = pad(volMa5Vals, len, null);
    pVolRatio = closePrices.map((_, i) => {
      const ma = pVolMa5[i];
      return ma && ma > 0 ? volumePrices[i] / ma : null;
    });
  }

  const pMacd = pad(macdResult as any, len, { MACD: null, signal: null, histogram: null });
  const pRsi = pad(rsiResult, len, null);
  const pBb = pad(bbResult as any, len, { lower: null, middle: null, upper: null });
  const pKdj = pad(kdjResult, len, { k: null, d: null });

  return { pMacd, pRsi, pBb, pKdj, pMa, pBias, pAtr, pObv, pVolMa5, pVolRatio };
}
