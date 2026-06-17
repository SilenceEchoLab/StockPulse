import { sqliteTable, text, real, primaryKey, integer } from 'drizzle-orm/sqlite-core';

export const stocks = sqliteTable('stocks', {
  marketCode: text('market_code').primaryKey(),
  name: text('name').notNull(),
  view: text('view'),
  industry: text('industry'),
  remarks: text('remarks'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  lastSyncTime: integer('last_sync_time', { mode: 'timestamp' }),
});

export const klineDaily = sqliteTable('kline_daily', {
  marketCode: text('market_code').notNull(),
  date: text('date').notNull(), // YYYY-MM-DD
  open: real('open').notNull(),
  close: real('close').notNull(),
  high: real('high').notNull(),
  low: real('low').notNull(),
  volume: real('volume').notNull(),
  // Indicators
  macd: real('macd'),
  macdSignal: real('macd_signal'),
  macdHist: real('macd_hist'),
  rsi14: real('rsi14'),
  bollMid: real('boll_mid'),
  bollUpper: real('boll_upper'),
  bollLower: real('boll_lower'),
  kdjK: real('kdj_k'),
  kdjD: real('kdj_d'),
  kdjJ: real('kdj_j'),
}, (table) => ({
  pk: primaryKey({ columns: [table.marketCode, table.date] })
}));

export const klineMin = sqliteTable('kline_min', {
  marketCode: text('market_code').notNull(),
  period: text('period').notNull(), // m30, m60
  time: text('time').notNull(), // YYYYMMDDHHmm
  open: real('open').notNull(),
  close: real('close').notNull(),
  high: real('high').notNull(),
  low: real('low').notNull(),
  volume: real('volume').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.marketCode, table.period, table.time] })
}));

export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

export const stockGroupsLink = sqliteTable('stock_groups_link', {
  stockCode: text('stock_code').notNull(),
  groupId: integer('group_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.stockCode, table.groupId] })
}));

export const aiSentiment = sqliteTable('ai_sentiment', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  marketCode: text('market_code').notNull(),
  score: real('score').notNull(),
  label: text('label').notNull(),
  summary: text('summary').notNull(),
  signals: text('signals').notNull(), // JSON
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const alerts = sqliteTable('alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  marketCode: text('market_code').notNull(),
  type: text('type').notNull(), // price_above, price_below, etc.
  threshold: real('threshold').notNull(),
  isTriggered: integer('is_triggered', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  triggeredAt: integer('triggered_at', { mode: 'timestamp' }),
});

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // e.g. alert
  title: text('title').notNull(),
  content: text('content').notNull(),
  isRead: integer('is_read', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
