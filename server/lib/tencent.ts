import { decodeGBK } from './gbk.js';
import { stockCache } from './state.js';

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0'
];

export async function fetchWithRetry(url: string, retries: number = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const response = await fetch(url, {
        headers: { 'User-Agent': userAgent, 'Accept': 'application/json, text/plain, */*' }
      });
      if (!response.ok) {
        // B2 修复：4xx(非429)不重试，5xx/429/403 重试
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
           throw new Error(`Retryable: ${response.status}`);
        }
        // 4xx 非 429，不重试直接抛出
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err: any) {
      // B2 修复：不可重试错误（4xx 非 429）直接抛出
      if (err.message && err.message.startsWith('HTTP ') && !err.message.includes('Retryable')) {
        throw err;
      }
      if (i === retries - 1) throw err;
      const backoff = (Math.pow(2, i) * 1000) + Math.floor(Math.random() * 1000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

const CACHE_TTL = 10 * 1000;

export async function getTencentStockData(codes: string[]) {
  const now = Date.now();
  const codesToFetch: string[] = [];
  const results: any[] = [];

  for (const code of codes) {
    const cached = stockCache.get(code);
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
      results.push(cached.data);
    } else {
      codesToFetch.push(code);
    }
  }

  if (codesToFetch.length > 0) {
    const chunkSize = 30;
    for (let i = 0; i < codesToFetch.length; i += chunkSize) {
      const chunk = codesToFetch.slice(i, i + chunkSize);
      const url = `http://qt.gtimg.cn/q=${chunk.join(",")}`;
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] },
        });

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const dataStr = decodeGBK(buffer);
          const parsedData = parseTencentStockData(dataStr);
          for (const data of parsedData) {
            stockCache.set(data.marketCode, { timestamp: now, data });
            results.push(data);
          }
        }
      } catch (err) {
        console.error("Failed to fetch GT stock data for chunk:", err);
      }
    }
  }

  return results;
}

export function parseTencentStockData(dataStr: string) {
  const results: any[] = [];
  const lines = dataStr.split("\n").filter((line) => line.trim() !== "");

  for (const line of lines) {
    if (line.includes('="')) {
      const parts = line.split('="');
      const varName = parts[0]; // e.g., v_sh600519
      const rawData = parts[1].replace('";', "");
      const fields = rawData.split("~");
      
      if (fields.length > 20) {
        results.push({
          marketCode: varName.replace('v_', ''), // sh600519
          name: fields[1],
          code: fields[2],
          price: parseFloat(fields[3]),
          previousClose: parseFloat(fields[4]),
          open: parseFloat(fields[5]),
          volume: parseInt(fields[6], 10), // in hands (手)
          outerDisc: parseInt(fields[7], 10),
          innerDisc: parseInt(fields[8], 10),
          high: parseFloat(fields[33]),
          low: parseFloat(fields[34]),
          changePercentage: parseFloat(fields[32]),
          changeAmount: parseFloat(fields[31]),
          turnover: parseFloat(fields[37]),
          turnoverRate: parseFloat(fields[38]),
          peRatio: parseFloat(fields[39]),
          pbRatio: parseFloat(fields[46]),
          totalMarketValue: parseFloat(fields[45]), // 100 million
          circulatingMarketValue: parseFloat(fields[44]),
          updateTime: fields[30],
        });
      }
    }
  }

  return results;
}
