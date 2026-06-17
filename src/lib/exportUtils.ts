import { StockData } from "../types";

export function exportToCSV(data: StockData[], filename = "stock_data.csv") {
  // Define CSV headers
  const headers = [
    "股票代码 (Code)",
    "股票名称 (Name)",
    "当前价 (Price)",
    "涨跌幅 (Change %)",
    "涨跌额 (Change Amt)",
    "今开 (Open)",
    "昨收 (Prev Close)",
    "最高 (High)",
    "最低 (Low)",
    "成交量(手) (Volume)",
    "换手率 (Turnover %)",
    "市盈率 (PE TTM)",
    "总市值(亿) (Market Cap)",
    "更新时间 (Update Time)"
  ];

  // Map data to rows
  const rows = data.map((stock) => [
    stock.marketCode,
    stock.name,
    stock.price.toFixed(2),
    stock.changePercentage.toFixed(2) + "%",
    stock.changeAmount.toFixed(2),
    stock.open.toFixed(2),
    stock.previousClose.toFixed(2),
    stock.high.toFixed(2),
    stock.low.toFixed(2),
    stock.volume,
    stock.turnoverRate.toFixed(2) + "%",
    stock.peRatio.toFixed(2),
    stock.totalMarketValue.toFixed(2),
    stock.updateTime
  ]);

  // Combine headers and rows
  const csvContent = [
    headers.join(","),
    ...rows.map((row) => row.join(","))
  ].join("\n");

  // Create a Blob and trigger download
  // Add BOM for Excel to properly read UTF-8 characters
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
