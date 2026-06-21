import { MACD, RSI, BollingerBands, Stochastic, SMA } from 'technicalindicators';

const MA_PERIODS = [5, 10, 20, 60, 120, 250];
const BIAS_PERIODS = [6, 12, 24];

export function calculateIndicators(closePrices: number[], highPrices: number[], lowPrices: number[]) {
  const macdResult = MACD.calculate({ values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const rsiResult = RSI.calculate({ values: closePrices, period: 14 });
  const bbResult = BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });
  const kdjResult = Stochastic.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 9, signalPeriod: 3 });

  const pad = (arr: any[], len: number, val: any) => [...new Array(Math.max(0, len - arr.length)).fill(val), ...arr];

  // 均线系统 MA5/10/20/60/120/250 —— 趋势投资核心趋势判断依据
  const pMa: Record<string, (number | null)[]> = {};
  for (const period of MA_PERIODS) {
    const vals = SMA.calculate({ period, values: closePrices });
    pMa[`ma${period}`] = pad(vals, closePrices.length, null);
  }

  // 乖离率 BIAS —— 衡量价格偏离均线的超买超卖程度
  const pBias: Record<string, (number | null)[]> = {};
  for (const period of BIAS_PERIODS) {
    const maVals = SMA.calculate({ period, values: closePrices });
    const padded = pad(maVals, closePrices.length, null);
    pBias[`bias${period}`] = closePrices.map((c, i) =>
      padded[i] !== null ? ((c - (padded[i] as number)) / (padded[i] as number)) * 100 : null
    );
  }

  const pMacd = pad(macdResult, closePrices.length, { MACD: null, signal: null, histogram: null });
  const pRsi = pad(rsiResult, closePrices.length, null);
  const pBb = pad(bbResult, closePrices.length, { lower: null, middle: null, upper: null });
  const pKdj = pad(kdjResult, closePrices.length, { k: null, d: null });

  return { pMacd, pRsi, pBb, pKdj, pMa, pBias };
}
