import { createClient } from '@libsql/client';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import * as schema from './schema.js';

export function getDb(c?: any) {
  const dbBinding = c?.env?.stockpulse_db || c?.env?.DB;
  if (dbBinding) return drizzleD1(dbBinding, { schema });
  const sqliteClient = createClient({ url: 'file:data/market_data.db' });
  return drizzleLibsql(sqliteClient as any, { schema }) as any;
}
