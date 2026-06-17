import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const sqlite = new Database(path.join(DB_DIR, 'market_data.db'));
sqlite.pragma('journal_mode = WAL');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS stocks (
    market_code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    view TEXT,
    industry TEXT,
    remarks TEXT,
    is_active INTEGER DEFAULT 1,
    last_sync_time INTEGER
  );

  CREATE TABLE IF NOT EXISTS kline_daily (
    market_code TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    close REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    volume REAL NOT NULL,
    macd REAL,
    macd_signal REAL,
    macd_hist REAL,
    rsi14 REAL,
    boll_mid REAL,
    boll_upper REAL,
    boll_lower REAL,
    kdj_k REAL,
    kdj_d REAL,
    kdj_j REAL,
    PRIMARY KEY (market_code, date)
  );

  CREATE TABLE IF NOT EXISTS kline_min (
    market_code TEXT NOT NULL,
    period TEXT NOT NULL,
    time TEXT NOT NULL,
    open REAL NOT NULL,
    close REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (market_code, period, time)
  );
`);

export const db = drizzle(sqlite, { schema });
