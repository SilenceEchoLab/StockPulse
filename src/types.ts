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
  updateTime: string;
}
