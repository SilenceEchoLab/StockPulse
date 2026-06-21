export interface StockData {
  marketCode: string; // e.g., sh600519
  name: string;
  code: string;
  view?: string;
  industry?: string;
  remarks?: string;
  price: number;
  previousClose: number;
  open: number;
  volume: number;
  high: number;
  low: number;
  changePercentage: number;
  changeAmount: number;
  turnoverRate: number;
  turnover: number;
  peRatio: number;
  pbRatio: number;
  totalMarketValue: number;
  circulatingMarketValue: number;
  outerDisc: number; // 外盘（主动买盘，手）
  innerDisc: number; // 内盘（主动卖盘，手）
  updateTime: string;
}

// D1 修复：共享领域类型定义

export interface KlineData {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  macd?: number;
  macdSignal?: number;
  macdHist?: number;
  rsi14?: number;
  bollMid?: number;
  bollUpper?: number;
  bollLower?: number;
  kdjK?: number;
  kdjD?: number;
  kdjJ?: number;
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma60?: number;
}

export interface SignalItem {
  type: 'bullish' | 'bearish';
  name: string;
  confidence: number;
}

export interface AIPick {
  marketCode: string;
  name: string;
  score: number;
  reason: string;
  signals: SignalItem[];
  trendScore?: number | null;
  scoreBreakdown?: { trend: number; structure: number; volumePrice: number; timing: number } | null;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  cached?: boolean;
  needsGeneration?: boolean;
  generatedAt?: string;
}
