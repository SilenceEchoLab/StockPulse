// 共享指标小工具 —— 消除 marketTiming/signalEngine/cycles 三处重复的 sma()/safe() 定义
// （「多头兼容的冗余选型」收口）

/** 尾部简单移动平均；数据不足返回 null */
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** 安全数值：非有限数 → null */
export function safe(v: number | null | undefined): number | null {
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
