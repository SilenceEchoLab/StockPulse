import { sqliteTable, text, real, primaryKey, integer, index } from 'drizzle-orm/sqlite-core';

export const stocks = sqliteTable('stocks', {
  marketCode: text('market_code').primaryKey(),
  name: text('name').notNull(),
  view: text('view'),
  industry: text('industry'),
  remarks: text('remarks'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  lastSyncTime: integer('last_sync_time', { mode: 'timestamp' }),
});

export const dailySnapshot = sqliteTable('daily_snapshot', {
  marketCode: text('market_code').notNull(),
  date: text('date').notNull(), // YYYY-MM-DD
  peRatio: real('pe_ratio'),
  pbRatio: real('pb_ratio'),
  turnoverRate: real('turnover_rate'),
  totalMarketValue: real('total_market_value'),
  circulatingMarketValue: real('circulating_market_value'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.marketCode, table.date] })
}));

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
  // 均线系统 —— 趋势投资核心趋势判断
  ma5: real('ma5'),
  ma10: real('ma10'),
  ma20: real('ma20'),
  ma60: real('ma60'),
  ma120: real('ma120'),
  ma250: real('ma250'),
  // 乖离率 —— 超买超卖量化
  bias6: real('bias6'),
  bias12: real('bias12'),
  bias24: real('bias24'),
}, (table) => ({
  pk: primaryKey({ columns: [table.marketCode, table.date] }),
  // A1 修复：为按日期范围查询和排序添加索引
  dateIdx: index('kline_daily_date_idx').on(table.date),
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
  marketCode: text('market_code').notNull(),
  groupId: integer('group_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.marketCode, table.groupId] })
}));

export const aiSentiment = sqliteTable('ai_sentiment', {
  marketCode: text('market_code').primaryKey(),
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
}, (table) => ({
  marketCodeIdx: index('alerts_market_code_idx').on(table.marketCode),
  isActiveIdx: index('alerts_is_active_idx').on(table.isActive)
}));

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // e.g. alert
  title: text('title').notNull(),
  content: text('content').notNull(),
  isRead: integer('is_read', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  // A1 修复：按时间排序查询通知的索引
  createdAtIdx: index('notifications_created_at_idx').on(table.createdAt),
}));

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

