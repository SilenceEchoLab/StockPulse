import express from "express";

import path from "path";

import fs from "fs";

import fsPromises from "fs/promises";

import { createServer as createViteServer } from "vite";

import { createRequire } from "module";

import { eq } from "drizzle-orm";

import { db } from "./db/index.js";

import { klineDaily, klineMin, stocks as stocksSchema, groups, stockGroupsLink, aiSentiment, alerts, notifications, settings, dailySnapshot } from "./db/schema.js";

import { MACD, RSI, BollingerBands, Stochastic } from "technicalindicators";

import { getAiClient, getAiModel, getAiPrompt } from "./ai/index.js";



const require = createRequire(import.meta.url);

const archiver = require("archiver");

const iconv = require("iconv-lite");



const DATA_DIR = path.join(process.cwd(), "data", "historical");



// Ensure data directory exists

if (!fs.existsSync(DATA_DIR)) {

  fs.mkdirSync(DATA_DIR, { recursive: true });

}



// Global Sync State

let syncProcess = {

  status: "idle" as "idle" | "syncing" | "completed" | "error",

  total: 0,

  current: 0,

  progress: 0,

  logs: [] as { time: string; type: string; message: string; sub: string }[],

  totalRequests: 0,

  errorCount: 0,

  diskUsageBytes: 0,

  startTime: null as Date | null,

};



function addLog(type: string, message: string, sub: string = "") {

  const time = new Date().toLocaleTimeString('en-US', { hour12: false });

  syncProcess.logs.unshift({ time, type, message, sub });

  if (syncProcess.logs.length > 100) syncProcess.logs.pop();

}



const USER_AGENTS = [

  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',

  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0'

];



// --- 在内存中建立腾讯行情缓存（TTL: 10秒） ---

const stockCache = new Map<string, { timestamp: number, data: any }>();

const CACHE_TTL = 10 * 1000;



async function getTencentStockData(codes: string[]) {

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

          const buffer = Buffer.from(await response.arrayBuffer());

          const dataStr = iconv.decode(buffer, "gbk");

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





async function fetchWithRetry(url: string, retries: number = 3): Promise<any> {

  for (let i = 0; i < retries; i++) {

    try {

      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

      const response = await fetch(url, {

        headers: { 'User-Agent': userAgent, 'Accept': 'application/json, text/plain, */*' }

      });

      if (!response.ok) {

        if (response.status === 403 || response.status === 429) {

           throw new Error(`Rate limit/Forbidden: ${response.status}`);

        }

        throw new Error(`HTTP ${response.status}`);

      }

      return await response.json();

    } catch (err: any) {

      if (i === retries - 1) throw err;

      const backoff = (Math.pow(2, i) * 1000) + Math.floor(Math.random() * 1000);

      await new Promise(r => setTimeout(r, backoff));

    }

  }

}



async function runScraper(codes: string[], options: { concurrency?: number, mode?: string } = {}) {

  if (syncProcess.status === "syncing") return;

  

  syncProcess = {

    status: "syncing",

    total: codes.length,

    current: 0,

    progress: 0,

    logs: [],

    totalRequests: 0,

    errorCount: 0,

    diskUsageBytes: await getDirSize(DATA_DIR),

    startTime: new Date(),

  };



  const concurrency = options.concurrency || 1;
  const mode = options.mode || "incremental";
  addLog("INFO", "INIT_MARKET_MONITOR:", `Starting ${mode} sync for ${codes.length} stocks. Concurrency: ${concurrency}`);



  (async () => {

    try {

      for (const code of codes) {

        if (syncProcess.status !== "syncing") break; // Allow interruption if needed



        syncProcess.current++;

        syncProcess.progress = (syncProcess.current / syncProcess.total) * 100;

        syncProcess.totalRequests++;



        try {

          const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,250,qfq`;

          const resJson: any = await fetchWithRetry(url);

          

          if (resJson.code !== 0) throw new Error(resJson.msg || "Unknown API Error");



          // The key might be 'qfqday' or 'day'

          const dataObj = resJson.data[code];

          const klineKey = dataObj['qfqday'] ? 'qfqday' : 'day';

          const kData = dataObj[klineKey];



          if (kData && Array.isArray(kData) && kData.length > 0) {

            // Write to CSV

            const csvRows = ["date,open,close,high,low,volume"];

            for (const row of kData) {

              csvRows.push(row.slice(0, 6).join(","));

            }

            

            const filePath = path.join(DATA_DIR, `${code}.csv`);

            await fsPromises.writeFile(filePath, csvRows.join("\n"), "utf-8");



            db.insert(stocksSchema).values({

              marketCode: code,

              name: code,

              lastSyncTime: new Date()

            }).onConflictDoUpdate({

              target: stocksSchema.marketCode,

              set: { lastSyncTime: new Date() }

            }).run();



            const closePrices = [];

            const highPrices = [];

            const lowPrices = [];

            const parsedRows = [];



            for (const row of kData) {

               const date = row[0];

               const open = parseFloat(row[1]);

               const close = parseFloat(row[2]);

               const high = parseFloat(row[3]);

               const low = parseFloat(row[4]);

               const volume = parseFloat(row[5]);

               closePrices.push(close);

               highPrices.push(high);

               lowPrices.push(low);

               parsedRows.push({ marketCode: code, date, open, close, high, low, volume });

            }



            const macdResult = MACD.calculate({ values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });

            const rsiResult = RSI.calculate({ values: closePrices, period: 14 });

            const bbResult = BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });

            const kdjResult = Stochastic.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 9, signalPeriod: 3 });



            const pad = (arr, len, val) => [...new Array(len - arr.length).fill(val), ...arr];

            const pMacd = pad(macdResult, parsedRows.length, { MACD: null, signal: null, histogram: null });

            const pRsi = pad(rsiResult, parsedRows.length, null);

            const pBb = pad(bbResult, parsedRows.length, { lower: null, middle: null, upper: null });

            const pKdj = pad(kdjResult, parsedRows.length, { k: null, d: null });



            const dbRecords = parsedRows.map((r, i) => {

              const j = (pKdj[i] && pKdj[i].k !== null) ? 3 * pKdj[i].k - 2 * pKdj[i].d : null;

              return {

                ...r,

                macd: pMacd[i]?.MACD ?? null,

                macdSignal: pMacd[i]?.signal ?? null,

                macdHist: pMacd[i]?.histogram ?? null,

                rsi14: pRsi[i] ?? null,

                bollMid: pBb[i]?.middle ?? null,

                bollUpper: pBb[i]?.upper ?? null,

                bollLower: pBb[i]?.lower ?? null,

                kdjK: pKdj[i]?.k ?? null,

                kdjD: pKdj[i]?.d ?? null,

                kdjJ: j

              };

            });



            const { eq, and, desc } = await import('drizzle-orm');

            

            const latestDaily = db.select({ date: klineDaily.date })

                                  .from(klineDaily)

                                  .where(eq(klineDaily.marketCode, code))

                                  .orderBy(desc(klineDaily.date))

                                  .limit(1).get();

            const maxDate = latestDaily ? latestDaily.date : null;



            let recordsToInsert = dbRecords;

            if (maxDate) {

              recordsToInsert = dbRecords.filter(r => r.date >= maxDate);

            }



            db.transaction((tx) => {

              if (maxDate) {

                tx.delete(klineDaily).where(and(eq(klineDaily.marketCode, code), eq(klineDaily.date, maxDate))).run();

              } else {

                tx.delete(klineDaily).where(eq(klineDaily.marketCode, code)).run();

              }

              const chunkSize = 500;

              for (let c = 0; c < recordsToInsert.length; c += chunkSize) {

                tx.insert(klineDaily).values(recordsToInsert.slice(c, c + chunkSize)).run();

              }

            });





            addLog("SUCCESS", "DATABASE_WRITE:", `Synced ${csvRows.length - 1} rows for ${code} including sqlite`);

          } else {

             throw new Error("No K-line data found in response");

          }



        } catch (err: any) {

          syncProcess.errorCount++;

          addLog("ERROR", "API_ERROR:", `Failed for ${code} - ${err.message}`);

        }



        // Sleep to avoid rate limits and IP bans (random 1-3 seconds)

        const delay = Math.floor(Math.random() * 2000) + 1000;

        await new Promise(resolve => setTimeout(resolve, delay));

        

        // Also fetch m30 and m60

        for (const period of ['m30', 'm60']) {

          try {

            const minUrl = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,,2000`;

            const minData = await fetchWithRetry(minUrl);

            if (minData) {

               if (minData.code === 0 && minData.data[code] && Array.isArray(minData.data[code][period]) && minData.data[code][period].length > 0) {

                  const mData = minData.data[code][period];

                  const mRecords = mData.map((row: any[]) => ({

                     marketCode: code,

                     period: period,

                     time: String(row[0]),

                     open: parseFloat(row[1]),

                     close: parseFloat(row[2]),

                     high: parseFloat(row[3]),

                     low: parseFloat(row[4]),

                     volume: parseFloat(row[5])

                  }));

                  

                   const { eq, and, desc } = await import('drizzle-orm');

                   

                   const latestMin = db.select({ time: klineMin.time })

                                     .from(klineMin)

                                     .where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period)))

                                     .orderBy(desc(klineMin.time))

                                     .limit(1).get();

                   const maxTime = latestMin ? latestMin.time : null;



                   let minToInsert = mRecords;

                   if (maxTime) {

                     minToInsert = mRecords.filter((r: any) => r.time >= maxTime);

                   }



                   db.transaction((tx) => {

                     if (maxTime) {

                       tx.delete(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period), eq(klineMin.time, maxTime))).run();

                     } else {

                       tx.delete(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period))).run();

                     }

                     const minChunkSize = 500;

                     for (let c = 0; c < minToInsert.length; c += minChunkSize) {

                       tx.insert(klineMin).values(minToInsert.slice(c, c + minChunkSize)).run();

                     }

                   });



                  addLog("SUCCESS", `${period.toUpperCase()}_DB:`, `Synced ${mRecords.length} rows for ${code}`);

               }

            }

          } catch(e) {}

          await new Promise(resolve => setTimeout(resolve, 500));

        }



        syncProcess.diskUsageBytes = await getDirSize(DATA_DIR);

      }



      syncProcess.status = "completed";

      addLog("SUCCESS", "PROCESS_COMPLETE:", `All ${syncProcess.total} stocks processed.`);



    } catch (e: any) {

      syncProcess.status = "error";

      addLog("ERROR", "FATAL:", e.message);

    }

  })();

}



async function getDirSize(dir: string): Promise<number> {

  try {

    const files = await fsPromises.readdir(dir);

    let size = 0;

    for (const file of files) {

      const stats = await fsPromises.stat(path.join(dir, file));

      size += stats.size;

    }

    return size;

  } catch (e) {

    return 0;

  }

}





const DEFAULT_SENTIMENT_PROMPT = `你是一位资深的量化金融分析师。请基于以下提供的个股近期 60 天 K线数据和技术指标，进行全面的情绪面与走势分析，并输出纯 JSON 格式。

JSON 必须严格遵守以下结构：
{
  "score": 数字(0-100，0为极度悲观，100为极度乐观),
  "label": "短文本(如：强烈看多 / 震荡整理 / 风险累积)",
  "summary": "一段约50字的精简中文分析总结",
  "signals": [
    { "type": "bullish" 或者 "bearish", "name": "中文信号名称(如：MACD金叉)", "confidence": 数字(0-1) }
  ]
}

要求：
1. 必须使用纯正的中文金融术语。
2. 不要包含任何 \`\`\`json 等 Markdown 标签，仅返回合法的 JSON 字符串。`;



const DEFAULT_PICKS_PROMPT = `你是一位资深的A股量化基金经理。请基于提供的股票池技术面(MACD, RSI)和基本面(PE, PB)数据，执行多因子选股。

策略方向：{{strategy}}。

你需要综合打分(0-100)，并严格选出最优的 {{count}} 只股票。

务必只返回合法的 JSON 格式，结构要求如下：

{

  "picks": [

    {

      "marketCode": "股票代码",

      "name": "股票名称",

      "score": 综合得分(数字),

      "reason": "15字以内的精简选股逻辑",

      "signals": [

        { "type": "bullish" | "bearish", "name": "信号名称", "confidence": 0.90 }

      ]

    }

  ]

}`;



async function initSettings() {

  const existingSentiment = db.select().from(settings).where(eq(settings.key, 'ai_sentiment_prompt')).get();

  if (!existingSentiment) {

    db.insert(settings).values({ key: 'ai_sentiment_prompt', value: DEFAULT_SENTIMENT_PROMPT }).run();

  }



  const existingPicks = db.select().from(settings).where(eq(settings.key, 'ai_picks_prompt')).get();

  if (!existingPicks) {

    db.insert(settings).values({ key: 'ai_picks_prompt', value: DEFAULT_PICKS_PROMPT }).run();

  }

}



async function startServer() {

  await initSettings();

  const app = express();

  const PORT = 3000;



  // Add JSON body parser if needed

  app.use(express.json());

  app.use(express.text({ type: "text/csv" }));



  app.get("/api/pool", async (req, res) => {

    try {

      const records = db.select().from(stocksSchema).all();

      res.json({ success: true, data: records });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.post("/api/pool", async (req, res) => {

    const { code, name } = req.body;

    if (!code) return res.status(400).json({ error: "Missing code" });

    try {

      db.insert(stocksSchema).values({

        marketCode: code,

        name: name || code,

        isActive: true,

        lastSyncTime: new Date()

      }).onConflictDoUpdate({

        target: stocksSchema.marketCode,

        set: { isActive: true }

      }).run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.post("/api/pool/import", async (req, res) => {

    try {

      const content = req.body;

      if (!content || typeof content !== 'string') {

        return res.status(400).json({ error: "Empty or invalid CSV content" });

      }

      

      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);

      const toInsert = [];

      for (let i = 1; i < lines.length; i++) {

        const row = lines[i].split(",");

        if (row.length >= 6) {

          toInsert.push({

            marketCode: row[0],

            name: row[2],

            view: row[3],

            industry: row[4],

            remarks: row[5],

            isActive: true,

            lastSyncTime: new Date()

          });

        }

      }

      if (toInsert.length > 0) {

        db.transaction((tx) => {

          for (const r of toInsert) {

            tx.insert(stocksSchema).values(r).onConflictDoUpdate({

              target: stocksSchema.marketCode,

              set: r

            }).run();

          }

        });

      }

      res.json({ success: true, message: `Imported ${toInsert.length} stocks` });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.delete("/api/pool/:code", async (req, res) => {

    try {

      // we can disable it or delete it. Let's delete for simplicity

      const { eq } = await import('drizzle-orm');

      db.delete(stocksSchema).where(eq(stocksSchema.marketCode, req.params.code)).run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.get("/api/groups", async (req, res) => {

    try {

      const records = db.select().from(groups).all();

      res.json({ success: true, data: records });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.post("/api/groups", async (req, res) => {

    const { name } = req.body;

    if (!name) return res.status(400).json({ error: "Missing group name" });

    try {

      db.insert(groups).values({

        name,

        createdAt: new Date(),

      }).run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.delete("/api/groups/:id", async (req, res) => {

    try {

      const { eq } = await import('drizzle-orm');

      const groupId = parseInt(req.params.id);

      db.transaction((tx) => {

        tx.delete(stockGroupsLink).where(eq(stockGroupsLink.groupId, groupId)).run();

        tx.delete(groups).where(eq(groups.id, groupId)).run();

      });

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.post("/api/groups/:id/stocks", async (req, res) => {

    const groupId = parseInt(req.params.id);

    const { code } = req.body;

    if (!code) return res.status(400).json({ error: "Missing stock code" });

    try {

      db.insert(stockGroupsLink).values({

        groupId,

        marketCode: code,

      }).onConflictDoNothing().run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.delete("/api/groups/:id/stocks/:code", async (req, res) => {

    try {

      const { eq, and } = await import('drizzle-orm');

      const groupId = parseInt(req.params.id);

      const code = req.params.code;

      db.delete(stockGroupsLink)

        .where(and(

          eq(stockGroupsLink.groupId, groupId),

          eq(stockGroupsLink.marketCode, code)

        )).run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.get("/api/search", async (req, res) => {

    const q = req.query.q as string;

    if (!q) {

      return res.json({ success: true, data: [] });

    }

    try {

      const { like, or } = await import('drizzle-orm');

      const records = db.select()

        .from(stocksSchema)

        .where(

          or(

            like(stocksSchema.marketCode, `%${q}%`),

            like(stocksSchema.name, `%${q}%`)

          )

        )

        .limit(10)

        .all();

      res.json({ success: true, data: records });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.get("/api/stock/:code/daily", async (req, res) => {

    try {

      const { eq, desc } = await import('drizzle-orm');

      const records = db.select().from(klineDaily)

        .where(eq(klineDaily.marketCode, req.params.code))

        .orderBy(desc(klineDaily.date))

        .all();

      res.json({ success: true, data: records.reverse() }); // return chronological order

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.get("/api/stocks", async (req, res) => {

    const codes = req.query.codes;

    if (!codes || typeof codes !== "string") {

      return res.status(400).json({ error: "Missing or invalid stock codes" });

    }



    try {

      const codesArray = codes.split(",");

      const { inArray } = await import('drizzle-orm');

      const dbRecords = db.select().from(stocksSchema).where(inArray(stocksSchema.marketCode, codesArray)).all();

      const codeToMeta = dbRecords.reduce((acc, curr) => {

        acc[curr.marketCode] = curr;

        return acc;

      }, {} as any);



      // 复用带缓存的行情获取函数

      const parsedData = await getTencentStockData(codesArray);

      

      let finalData = parsedData.map(d => ({

        ...d,

        view: codeToMeta[d.marketCode]?.view || "",

        industry: codeToMeta[d.marketCode]?.industry || "",

        remarks: codeToMeta[d.marketCode]?.remarks || ""

      }));



      // Upsert valuation data into daily_snapshot

      try {

        const today = new Date().toISOString().slice(0, 10);

        for (const d of parsedData) {

          db.insert(dailySnapshot).values({

            marketCode: d.marketCode,

            date: today,

            peRatio: d.peRatio,

            pbRatio: d.pbRatio,

            turnoverRate: d.turnoverRate,

            totalMarketValue: d.totalMarketValue,

            circulatingMarketValue: d.circulatingMarketValue,

            updatedAt: new Date(),

          }).onConflictDoUpdate({

            target: [dailySnapshot.marketCode, dailySnapshot.date],

            set: {

              peRatio: d.peRatio,

              pbRatio: d.pbRatio,

              turnoverRate: d.turnoverRate,

              totalMarketValue: d.totalMarketValue,

              circulatingMarketValue: d.circulatingMarketValue,

              updatedAt: new Date(),

            }

          }).run();

        }

      } catch (e) {

        console.error("Failed to upsert daily snapshot:", e);

      }



      res.json({ success: true, data: finalData });

    } catch (error) {

      console.error("Error fetching stocks:", error);

      res.status(500).json({ error: "Failed to fetch stock data" });

    }

  });



  // Sync Endpoints

  app.post("/api/sync/start", (req, res) => {

    const codes = req.body.codes;

    if (!Array.isArray(codes) || codes.length === 0) {

      return res.status(400).json({ error: "Array of stock codes required." });

    }

    if (syncProcess.status === "syncing") {

      return res.json({ success: false, message: "Sync already in progress." });

    }

    

    runScraper(codes);

    res.json({ success: true, message: "Sync started." });

  });



  app.get("/api/sync/overview", async (req, res) => {
    try {
      const { sql } = await import('drizzle-orm');
      const stocksCount = db.select({ count: sql`count(*)` }).from(stocksSchema).get()?.count || 0;
      const snapshotCount = db.select({ count: sql`count(*)` }).from(dailySnapshot).get()?.count || 0;
      const settingsCount = db.select({ count: sql`count(*)` }).from(settings).get()?.count || 0;
      const fs = await import('fs');
      const path = await import('path');
      const DATA_DIR = path.join(process.cwd(), 'data');
      const csvFiles = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv')).length : 0;
      
      res.json({
        success: true,
        data: {
           stocks: stocksCount,
           snapshots: snapshotCount,
           settings: settingsCount,
           csvCount: csvFiles,
        }
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/sync/clean-cache", async (req, res) => {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const DATA_DIR = path.join(process.cwd(), 'data');
      if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
        for (const f of files) {
          fs.unlinkSync(path.join(DATA_DIR, f));
        }
      }
      res.json({ success: true, message: "缓存清理成功" });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get("/api/sync/status", async (req, res) => {

    res.json({

      status: syncProcess.status,

      progress: syncProcess.progress,

      current: syncProcess.current,

      total: syncProcess.total,

      logs: syncProcess.logs,

      totalRequests: syncProcess.totalRequests,

      errorCount: syncProcess.errorCount,

      diskUsageBytes: await getDirSize(DATA_DIR)

    });

  });



  app.get("/api/sync/export", (req, res) => {

    try {

      if (!fs.existsSync(DATA_DIR)) {

        return res.status(404).send("No data to export.");

      }

      

      res.writeHead(200, {

        "Content-Type": "application/zip",

        "Content-Disposition": `attachment; filename="csi300_historical_data_${new Date().getTime()}.zip"`

      });



      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", (err) => { throw err; });

      archive.pipe(res);

      archive.directory(DATA_DIR, false);

      archive.finalize();

    } catch (e) {

      res.status(500).send("Error generating zip.");

    }

  });



  app.get("/api/kline/:code", async (req, res) => {

    const code = req.params.code;

    const period = req.query.period || 'day'; // day, week, month, m30, m60, m1, m5

    try {

      const { eq, and, asc } = await import('drizzle-orm');

      

      let dbData = [];

      if (period === 'day') {

        dbData = db.select().from(klineDaily).where(eq(klineDaily.marketCode, code)).orderBy(asc(klineDaily.date)).all();

      } else if (period === 'm30' || period === 'm60') {

        dbData = db.select().from(klineMin).where(and(eq(klineMin.marketCode, code), eq(klineMin.period, period as string))).orderBy(asc(klineMin.time)).all();

      }



      let parsedData: any[] = [];

      let isDailyFromDb = false;



      if (period === 'day' && dbData.length > 0) {

         parsedData = dbData;

         isDailyFromDb = true;

      } else if ((period === 'm30' || period === 'm60') && dbData.length > 0) {

         parsedData = dbData.map(d => ({

            date: d.time.length === 12 ? `${d.time.substring(0,4)}-${d.time.substring(4,6)}-${d.time.substring(6,8)} ${d.time.substring(8,10)}:${d.time.substring(10,12)}` : d.time,

            open: d.open,

            close: d.close,

            high: d.high,

            low: d.low,

            volume: d.volume

         }));

      } else {

        let url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,250,qfq`;

        const isMinPeriod = ['m1', 'm5', 'm15', 'm30', 'm60'].includes(period as string);

        if (isMinPeriod) {

          url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,250`;

        } else if (period === 'time') {

          url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m1,,250`;

        }

        

        const resJson: any = await fetchWithRetry(url);

        

        if (resJson.code !== 0) throw new Error(resJson.msg || "Unknown API error");

        

        const dataObj = resJson.data[code];

        const actualPeriod = period === 'time' ? 'm1' : period;

        const klineKey = dataObj[`qfq${actualPeriod}`] ? `qfq${actualPeriod}` : actualPeriod;

        const kData = dataObj[klineKey as string] || [];

        

        parsedData = kData.map((item: any[]) => {

          let dateStr = item[0];

          if (dateStr.length === 12) {

            dateStr = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)} ${dateStr.substring(8,10)}:${dateStr.substring(10,12)}`;

          }

          return {

            date: dateStr,

            open: parseFloat(item[1]),

            close: parseFloat(item[2]),

            high: parseFloat(item[3]),

            low: parseFloat(item[4]),

            volume: parseFloat(item[5])

          };

        });

      }



      if (period === 'day' && isDailyFromDb) {
        try {
          const todayQuotes = await getTencentStockData([code]);
          if (todayQuotes && todayQuotes.length > 0) {
            const tq = todayQuotes[0];
            let tDateStr = new Date().toISOString().slice(0, 10);
            if (tq.updateTime && tq.updateTime.length >= 8) {
               tDateStr = `${tq.updateTime.substring(0,4)}-${tq.updateTime.substring(4,6)}-${tq.updateTime.substring(6,8)}`;
            }
            
            const todayCandle = {
              date: tDateStr,
              open: tq.open,
              close: tq.price,
              high: tq.high,
              low: tq.low,
              volume: tq.volume
            };

            if (parsedData.length > 0) {
              const lastData = parsedData[parsedData.length - 1];
              if (lastData.date === tDateStr) {
                 parsedData[parsedData.length - 1] = { ...lastData, ...todayCandle };
              } else {
                 parsedData.push(todayCandle);
              }
            } else {
              parsedData.push(todayCandle);
            }
          }
        } catch(e) {
          console.error("Failed to append realtime daily candle", e);
        }
      }



      const closePrices = parsedData.map((d: any) => d.close);

      const highPrices = parsedData.map((d: any) => d.high);

      const lowPrices = parsedData.map((d: any) => d.low);



      const macdResult = MACD.calculate({ values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });

      const rsiResult = RSI.calculate({ values: closePrices, period: 14 });

      const bbResult = BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });

      const kdjResult = Stochastic.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 9, signalPeriod: 3 });



      const pad = (arr: any[], len: number, val: any) => [...new Array(len - arr.length).fill(val), ...arr];

      const pMacd = pad(macdResult, parsedData.length, { MACD: null, signal: null, histogram: null });

      const pRsi = pad(rsiResult, parsedData.length, null);

      const pBb = pad(bbResult, parsedData.length, { lower: null, middle: null, upper: null });

      const pKdj = pad(kdjResult, parsedData.length, { k: null, d: null });



      const finalData = parsedData.map((r: any, i: number) => {

        const j = (pKdj[i] && pKdj[i].k !== null) ? 3 * pKdj[i].k - 2 * pKdj[i].d : null;

        return {

          ...r,

          macd: pMacd[i]?.MACD ?? null,

          macdSignal: pMacd[i]?.signal ?? null,

          macdHist: pMacd[i]?.histogram ?? null,

          rsi14: pRsi[i] ?? null,

          bollMid: pBb[i]?.middle ?? null,

          bollUpper: pBb[i]?.upper ?? null,

          bollLower: pBb[i]?.lower ?? null,

          kdjK: pKdj[i]?.k ?? null,

          kdjD: pKdj[i]?.d ?? null,

          kdjJ: j

        };

      });



      res.json({ success: true, data: finalData });

    } catch (e: any) {

      console.error(e);

      res.status(500).json({ success: false, error: e.message });

    }

  });



  app.get("/api/ai/sentiment/:code", async (req, res) => {

    try {

      const code = req.params.code;

      const { eq, desc } = await import('drizzle-orm');



      // Check cache (4 hours)

      const cached = db.select().from(aiSentiment).where(eq(aiSentiment.marketCode, code)).get();

      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);



      if (cached && new Date(cached.updatedAt) > fourHoursAgo) {

        return res.json({

          success: true,

          data: {

            score: cached.score,

            label: cached.label,

            summary: cached.summary,

            signals: JSON.parse(cached.signals),

            updatedAt: cached.updatedAt

          }

        });

      }



      // Fetch last 60 days

      const klineData = db.select()

        .from(klineDaily)

        .where(eq(klineDaily.marketCode, code))

        .orderBy(desc(klineDaily.date))

        .limit(60)

        .all();



      if (!klineData || klineData.length === 0) {

        return res.status(404).json({ success: false, error: "No kline data found for this stock" });

      }



      // Reverse to chronological order for the prompt

      klineData.reverse();



      const dataContext = klineData.map(d => 

        `Date: ${d.date}, Close: ${d.close}, Vol: ${d.volume}, MACD: ${d.macd}, RSI: ${d.rsi14}`

      ).join('\n');



      let responseText = "{}";

      try {

        const aiClient = await getAiClient();

        const aiModel = await getAiModel();

        const customPrompt = await getAiPrompt('ai_sentiment_prompt', DEFAULT_SENTIMENT_PROMPT);

        

        const response = await aiClient.chat.completions.create({

           model: aiModel,

           response_format: { type: "json_object" },

           messages: [

              { role: "system", content: customPrompt },

              { role: "user", content: `Data:\n${dataContext}` }

           ]

        });



        responseText = response.choices[0]?.message?.content || "{}";

      } catch (err: any) {

        // Fallback or bubble up

        if (err.message.includes('API Key is not configured')) {

           return res.status(400).json({ success: false, error: "AI_NOT_CONFIGURED", message: "Please configure your AI Provider in Settings." });

        }

        throw err;

      }

      

      const parsed = JSON.parse(responseText);



      // Save to db (delete existing first, as we don't have unique constraint on marketCode besides id)

      db.transaction((tx) => {

        tx.delete(aiSentiment).where(eq(aiSentiment.marketCode, code)).run();

        tx.insert(aiSentiment).values({

          marketCode: code,

          score: parsed.score,

          label: parsed.label,

          summary: parsed.summary,

          signals: JSON.stringify(parsed.signals),

          updatedAt: new Date()

        }).run();

      });



      res.json({ success: true, data: { ...parsed, updatedAt: new Date() } });



    } catch (e: any) {

      console.error("AI Sentiment Error:", e);

      res.status(500).json({ success: false, error: e.message });

    }

  });



const aiPicksCache = new Map<string, any>();

  app.post("/api/ai/picks", async (req, res) => {

    try {

      const { strategy, count = 5, forceRefresh = false } = req.body;

      const today = new Date().toISOString().slice(0, 10);

      const cacheKey = `${strategy}_${today}`;

      

      if (!forceRefresh) {

        if (aiPicksCache.has(cacheKey)) {

          return res.json({ success: true, cached: true, ...aiPicksCache.get(cacheKey) });

        } else {

          return res.json({ success: true, needsGeneration: true });

        }

      }



      const { eq, desc, isNotNull } = await import('drizzle-orm');



      // 1. 预筛选机制：获取带有技术指标的最新行情数据

      const latestData = db.select({

          marketCode: klineDaily.marketCode,

          close: klineDaily.close,

          macd: klineDaily.macd,

          rsi14: klineDaily.rsi14,

        })

        .from(klineDaily)

        .where(isNotNull(klineDaily.macd))

        .orderBy(desc(klineDaily.date))

        .limit(1500)

        .all();



      // 关联最新的 PE/PB 数据

      const snapshotData = db.select().from(dailySnapshot).all();

      const snapshotMap = snapshotData.reduce((acc: any, curr) => {

        acc[curr.marketCode] = curr;

        return acc;

      }, {});



      // 过滤出每只股票最新的那条数据

      const map = new Map();

      for (const row of latestData) {

         if (!map.has(row.marketCode)) {

           map.set(row.marketCode, {

             ...row,

             pe: snapshotMap[row.marketCode]?.peRatio,

             pb: snapshotMap[row.marketCode]?.pbRatio

           });

         }

      }

      let candidates = Array.from(map.values());



      // 根据策略做初筛，保留前 30 名，防止传给 LLM 的数据量过大

      if (strategy === "momentum") {

         candidates.sort((a, b) => (b.macd || 0) - (a.macd || 0));

      } else if (strategy === "value") {

         // 低估值策略，按 PE 从低到高排（剔除亏损）

         candidates = candidates.filter(c => c.pe && c.pe > 0);

         candidates.sort((a, b) => (a.pe || 0) - (b.pe || 0));

      }

      candidates = candidates.slice(0, 30);



      // 获取股票元信息

      const stockMeta = db.select().from(stocksSchema).all();

      const metaMap = stockMeta.reduce((acc, curr) => {

        acc[curr.marketCode] = curr;

        return acc;

      }, {} as any);



      // 2. 组装发给大模型的上下文

      const promptData = candidates.map(c => ({

        code: c.marketCode,

        name: metaMap[c.marketCode]?.name || c.marketCode,

        price: c.close,

        macd: c.macd?.toFixed(3),

        rsi: c.rsi14?.toFixed(2),

        pe: c.pe?.toFixed(2) || 'N/A',

        pb: c.pb?.toFixed(2) || 'N/A'

      }));



      // 3. 构建 Prompt 并调用模型

      const rawPrompt = await getAiPrompt('ai_picks_prompt', DEFAULT_PICKS_PROMPT);

      const strategyName = strategy === 'momentum' ? '动量突破' : '价值回归';

      const systemPrompt = rawPrompt.replace(/{{strategy}}/g, strategyName).replace(/{{count}}/g, String(count));



      let responseText = "{}";

      try {

        const aiClient = await getAiClient();

        const aiModel = await getAiModel();

        

        const response = await aiClient.chat.completions.create({

           model: aiModel,

           response_format: { type: "json_object" },

           messages: [

              { role: "system", content: systemPrompt },

              { role: "user", content: `Data:\n${JSON.stringify(promptData)}` }

           ]

        });



        responseText = response.choices[0]?.message?.content || "{}";

      } catch (err: any) {

        if (err.message.includes('API Key is not configured')) {

           return res.status(400).json({ success: false, error: "AI_NOT_CONFIGURED", message: "Please configure your AI Provider in Settings." });

        }

        

        // 发生错误时使用 mock 兜底

        const picks = candidates.slice(0, count).map(item => ({

          marketCode: item.marketCode,

          name: metaMap[item.marketCode]?.name || item.marketCode,

          score: Math.floor(Math.random() * 10) + 85,

          reason: strategy === 'momentum' ? "均线多头排列，量价齐升" : "PE处于历史低位，具备极高安全边际",

          signals: [{ type: "bullish", name: "多因子共振", confidence: 0.85 }]

        }));

        return res.json({ success: true, generatedAt: new Date(), picks });

      }

      

      const parsed = JSON.parse(responseText);

      const resultData = { generatedAt: new Date(), picks: parsed.picks || [] };

      aiPicksCache.set(cacheKey, resultData);

      res.json({ success: true, cached: false, ...resultData });



    } catch (e: any) {

      console.error("AI Picks Error:", e);

      res.status(500).json({ success: false, error: e.message });

    }

  });



  // Settings API

  app.get("/api/settings", async (req, res) => {

    try {

      const records = db.select().from(settings).all();

      const data: Record<string, string> = {};

      for (const r of records) {

        data[r.key] = r.value;

      }

      res.json({ success: true, data });

    } catch (e: any) {

      res.status(500).json({ success: false, error: e.message });

    }

  });



  app.post("/api/settings", async (req, res) => {

    try {

      const payload = req.body; // key-value pairs

      db.transaction((tx) => {

        for (const [key, value] of Object.entries(payload)) {

          if (value === null || value === undefined || value === '') {

             tx.delete(settings).where(eq(settings.key, key)).run();

          } else {

             tx.insert(settings)

               .values({ key, value: String(value) })

               .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })

               .run();

          }

        }

      });

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ success: false, error: e.message });

    }

  });



  // Alerts & Notifications

  const alertClients = new Set<express.Response>();



  app.get("/api/alerts/stream", (req, res) => {

    res.setHeader('Content-Type', 'text/event-stream');

    res.setHeader('Cache-Control', 'no-cache');

    res.setHeader('Connection', 'keep-alive');

    res.flushHeaders();

    

    alertClients.add(res);

    req.on('close', () => alertClients.delete(res));

  });



  app.get("/api/alerts", async (req, res) => {

    try {

      const records = db.select().from(alerts).all();

      res.json({ success: true, data: records });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.post("/api/alerts", async (req, res) => {

    const { marketCode, type, threshold } = req.body;

    try {

      db.insert(alerts).values({

        marketCode, type, threshold, createdAt: new Date()

      }).run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.delete("/api/alerts/:id", async (req, res) => {

    try {

      const { eq } = await import('drizzle-orm');

      db.delete(alerts).where(eq(alerts.id, parseInt(req.params.id))).run();

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.get("/api/notifications", async (req, res) => {

    try {

      const { desc } = await import('drizzle-orm');

      const records = db.select().from(notifications).orderBy(desc(notifications.createdAt)).all();

      res.json({ success: true, data: records });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  app.post("/api/notifications/read", async (req, res) => {

    const { ids } = req.body;

    try {

      const { inArray } = await import('drizzle-orm');

      if (ids && Array.isArray(ids) && ids.length > 0) {

        db.update(notifications).set({ isRead: true }).where(inArray(notifications.id, ids)).run();

      } else {

        db.update(notifications).set({ isRead: true }).run();

      }

      res.json({ success: true });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  // Backtest

  app.post("/api/backtest/run", async (req, res) => {

    try {

      const { codes, strategy, startDate, endDate, initialCapital = 100000 } = req.body;

      if (!codes || codes.length === 0) return res.status(400).json({ error: "Missing codes" });

      if (!strategy || !strategy.type) return res.status(400).json({ error: "Missing strategy" });



      const { eq, and, gte, lte, asc, inArray } = await import('drizzle-orm');



      let conditions = [];

      conditions.push(inArray(klineDaily.marketCode, codes));

      if (startDate) conditions.push(gte(klineDaily.date, startDate));

      if (endDate) conditions.push(lte(klineDaily.date, endDate));



      const klines = db.select().from(klineDaily).where(and(...conditions)).orderBy(asc(klineDaily.date)).all();



      const dataByCode = klines.reduce((acc: any, curr) => {

        if (!acc[curr.marketCode]) acc[curr.marketCode] = [];

        acc[curr.marketCode].push(curr);

        return acc;

      }, {});



      const results = [];



      for (const code of codes) {

        const data = dataByCode[code] || [];

        if (data.length === 0) continue;



        const BUY_FEE_RATE = 0.0003;  // 买入佣金 万3

        const SELL_FEE_RATE = 0.0013; // 卖出佣金 万3 + 印花税 千1

        const RISK_FREE_RATE = 0.02;  // 年化无风险利率 2%



        let cash = initialCapital;

        let position = 0; 

        let trades: any[] = [];

        let equityCurve: any[] = [];

        let dailyReturns: number[] = []; // 记录每日收益率序列

        let previousEquity = initialCapital;



        let winningTrades = 0;

        let maxEquity = initialCapital;

        let maxDrawdown = 0;



        for (let i = 1; i < data.length; i++) {

          const prev = data[i - 1];

          const curr = data[i];



          let signal = 0;



          if (strategy.type === 'macd_cross') {

            const prevMacd = prev.macd || 0;

            const prevSig = prev.macdSignal || 0;

            const currMacd = curr.macd || 0;

            const currSig = curr.macdSignal || 0;

            if (prevMacd <= prevSig && currMacd > currSig) signal = 1;

            else if (prevMacd >= prevSig && currMacd < currSig) signal = -1;

          } else if (strategy.type === 'rsi_overbought') {

            const buyT = strategy.params?.rsiBuy || 30;

            const sellT = strategy.params?.rsiSell || 70;

            if ((curr.rsi14 || 50) < buyT) signal = 1;

            else if ((curr.rsi14 || 50) > sellT) signal = -1;

          }



          if (signal === 1 && position === 0) {

            const maxAffordableCost = curr.close * (1 + BUY_FEE_RATE);

            const shares = Math.floor(cash / maxAffordableCost);

            if (shares > 0) {

              position = shares;

              const tradeCost = shares * curr.close * (1 + BUY_FEE_RATE);

              cash -= tradeCost;

              trades.push({ type: 'buy', date: curr.date, price: curr.close, shares, fee: tradeCost - shares * curr.close });

            }

          } else if (signal === -1 && position > 0) {

            const grossValue = position * curr.close;

            const sellFee = grossValue * SELL_FEE_RATE;

            const netValue = grossValue - sellFee;

            

            cash += netValue;

            

            const lastBuy = trades.filter(t => t.type === 'buy').pop();

            if (lastBuy && (netValue > (lastBuy.shares * lastBuy.price * (1 + BUY_FEE_RATE)))) {

               winningTrades++;

            }



            trades.push({ type: 'sell', date: curr.date, price: curr.close, shares: position, fee: sellFee });

            position = 0;

          }



          const equity = cash + (position * curr.close);

          equityCurve.push({ date: curr.date, equity });



          const dailyReturn = (equity - previousEquity) / previousEquity;

          dailyReturns.push(dailyReturn);

          previousEquity = equity;



          if (equity > maxEquity) maxEquity = equity;

          const drawdown = (maxEquity > 0) ? ((maxEquity - equity) / maxEquity) : 0;

          if (drawdown > maxDrawdown) maxDrawdown = drawdown;

        }



        if (position > 0) {

          const lastPrice = data[data.length - 1].close;

          const grossValue = position * lastPrice;

          const sellFee = grossValue * SELL_FEE_RATE;

          cash += (grossValue - sellFee);

          

          const lastBuy = trades.filter(t => t.type === 'buy').pop();

          if (lastBuy && (grossValue - sellFee > (lastBuy.shares * lastBuy.price * (1 + BUY_FEE_RATE)))) {

             winningTrades++;

          }

          

          trades.push({ type: 'sell', date: data[data.length - 1].date, price: lastPrice, shares: position, fee: sellFee });

          

          if (equityCurve.length > 0) {

            equityCurve[equityCurve.length - 1].equity = cash;

          }

        }



        const totalReturn = (cash - initialCapital) / initialCapital;

        const totalTrades = trades.filter(t => t.type === 'sell').length;

        const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

        const years = data.length / 252;

        const annualizedReturn = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) : 0;



        let sharpeRatio = 0;

        if (dailyReturns.length > 0) {

          const meanReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;

          const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (dailyReturns.length - 1 || 1);

          const stdDev = Math.sqrt(variance);

          

          const annualizedVolatility = stdDev * Math.sqrt(252);

          if (annualizedVolatility > 0) {

            sharpeRatio = (annualizedReturn - RISK_FREE_RATE) / annualizedVolatility;

          }

        }



        results.push({

          marketCode: code,

          metrics: {

            totalReturn,

            annualizedReturn,

            maxDrawdown,

            winRate,

            trades: totalTrades,

            sharpeRatio,

            finalCapital: cash

          },

          trades,

          equityCurve

        });

      }



      res.json({ success: true, results });

    } catch (e: any) {

      res.status(500).json({ error: e.message });

    }

  });



  // Polling for Alerts

  setInterval(async () => {

    try {

      const { eq } = await import('drizzle-orm');

      const activeAlerts = db.select().from(alerts).where(eq(alerts.isActive, true)).all();

      if (activeAlerts.length === 0) return;



      const codes = [...new Set(activeAlerts.map(a => a.marketCode))];

      // 复用带缓存的行情获取函数，与/api/stocks共用同一个缓存池，避免重复调用被封禁

      const stockData = await getTencentStockData(codes);

      

      const currentPrices = new Map<string, number>();

      for (const p of stockData) {

        currentPrices.set(p.marketCode, p.price);

      }



      const triggered = [];

      db.transaction((tx) => {

        for (const alert of activeAlerts) {

          const price = currentPrices.get(alert.marketCode);

          if (price === undefined) continue;



          let isTriggered = false;

          if (alert.type === 'price_above' && price >= alert.threshold) isTriggered = true;

          if (alert.type === 'price_below' && price <= alert.threshold) isTriggered = true;



          if (isTriggered) {

            tx.update(alerts).set({

              isTriggered: true,

              isActive: false,

              triggeredAt: new Date()

            }).where(eq(alerts.id, alert.id)).run();



            const notif = tx.insert(notifications).values({

              type: 'alert',

              title: `Alert Triggered: ${alert.marketCode}`,

              content: `Price of ${alert.marketCode} is now ${price}, which triggered your ${alert.type} alert (threshold: ${alert.threshold}).`,

              createdAt: new Date()

            }).returning().get();



            triggered.push({ alert: { ...alert, isTriggered: true, isActive: false, triggeredAt: new Date() }, notification: notif });

          }

        }

      });



      if (triggered.length > 0) {

        const eventData = JSON.stringify({ type: 'alerts_triggered', data: triggered });

        for (const client of alertClients) {

          client.write(`data: ${eventData}\n\n`);

        }

      }



    } catch (err) {

      console.error("Alert polling error:", err);

    }

  }, 30000);



  // Vite middleware for development

  if (process.env.NODE_ENV !== "production") {

    const vite = await createViteServer({

      server: { middlewareMode: true },

      appType: "spa",

    });

    app.use(vite.middlewares);

  } else {

    const distPath = path.join(process.cwd(), "dist");

    app.use(express.static(distPath));

    app.get("*", (req, res) => {

      res.sendFile(path.join(distPath, "index.html"));

    });

  }



  app.listen(PORT, "0.0.0.0", () => {

    console.log(`Server running on http://localhost:${PORT}`);

  });

}



function parseTencentStockData(dataStr: string) {

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



function initStockPool() {

  try {

    const records = db.select().from(stocksSchema).all();

    if (records.length === 0) {

      const csvPath = path.join(process.cwd(), "data", "deepseek_csv_20260617_1a46c0.csv");

      if (fs.existsSync(csvPath)) {

        const content = fs.readFileSync(csvPath, "utf-8");

        const lines = content.split("\n").filter(l => l.trim().length > 0);

        const toInsert = [];

        for (let i = 1; i < lines.length; i++) {

          const row = lines[i].split(",");

          if (row.length >= 6) {

            toInsert.push({

              marketCode: row[0],

              name: row[2],

              view: row[3],

              industry: row[4],

              remarks: row[5],

              isActive: true,

              lastSyncTime: new Date()

            });

          }

        }

        if (toInsert.length > 0) {

          db.insert(stocksSchema).values(toInsert).run();

          console.log(`Initialized stock pool with ${toInsert.length} stocks from CSV.`);

        }

      }

    }

  } catch (e) {

    console.error("Failed to init stock pool", e);

  }

}



initStockPool();

startServer();

