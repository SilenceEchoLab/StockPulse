// 本地 SQLite 单一数据源 —— 项目明确「本地运行优先、不考虑部署」，
// 故移除 Cloudflare D1 双兼容路径，避免多头选型。
// 数据库文件：data/market_data.db（drizzle-kit push 建表）
import { createClient } from '@libsql/client';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

let cachedLocalDb: any = null;

export function getDb(_c?: any) {
  if (!cachedLocalDb) {
    const sqliteClient = createClient({ url: 'file:data/market_data.db' });
    cachedLocalDb = drizzleLibsql(sqliteClient as any, { schema }) as any;
  }
  return cachedLocalDb;
}
