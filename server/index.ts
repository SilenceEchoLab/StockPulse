import { Hono } from 'hono';
import { getDb } from './db/getDb.js';
import { alerts, notifications, settings, stocks as stocksSchema } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { getTencentStockData } from './lib/tencent.js';
import { alertClients } from './lib/state.js';
import { writeAuthMiddleware } from './lib/auth.js';
import { DEFAULT_PICKS_PROMPT, DEFAULT_SENTIMENT_PROMPT, DEFAULT_REVIEW_PROMPT } from './routes/ai.js';

import poolRoutes from './routes/pool.js';
import groupsRoutes from './routes/groups.js';
import stocksRoutes from './routes/stocks.js';
import klineRoutes from './routes/kline.js';
import syncRoutes from './routes/sync.js';
import aiRoutes from './routes/ai.js';
import alertsRoutes from './routes/alerts.js';
import notificationsRoutes from './routes/notifications.js';
import marketRoutes from './routes/market.js';
import settingsRoutes from './routes/settings.js';
import backtestRoutes from './routes/backtest.js';
import researchRoutes from './routes/research.js';

const app = new Hono();

// C2 修复：对写操作统一鉴权（仅在配置了 ADMIN_TOKEN 时生效）
app.use('/api/*', writeAuthMiddleware);

// C4 修复：全局错误处理，统一响应格式，避免内部信息泄露
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'An internal error occurred' }, 500);
});

app.route('/api/pool', poolRoutes);
app.route('/api/groups', groupsRoutes);
app.route('/api/stocks', stocksRoutes);
app.route('/api/kline', klineRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/alerts', alertsRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/market', marketRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/backtest', backtestRoutes);
app.route('/api/research', researchRoutes);

async function initSettings(env?: any) {
  const db = getDb(env ? { env } : undefined);
  const existingSentiment = await db.select().from(settings).where(eq(settings.key, 'ai_sentiment_prompt')).get();
  if (!existingSentiment) {
    await db.insert(settings).values({ key: 'ai_sentiment_prompt', value: DEFAULT_SENTIMENT_PROMPT }).run();
  }
  const existingPicks = await db.select().from(settings).where(eq(settings.key, 'ai_picks_prompt')).get();
  if (!existingPicks) {
    await db.insert(settings).values({ key: 'ai_picks_prompt', value: DEFAULT_PICKS_PROMPT }).run();
  }
  const existingReview = await db.select().from(settings).where(eq(settings.key, 'ai_review_prompt')).get();
  if (!existingReview) {
    await db.insert(settings).values({ key: 'ai_review_prompt', value: DEFAULT_REVIEW_PROMPT }).run();
  }
}

async function initStockPool(env?: any) {
  try {
    const db = getDb(env ? { env } : undefined);
    await db.select().from(stocksSchema).all();
  } catch (e) {
    console.error("Failed to init stock pool", e);
  }
}

async function pollAlerts(env?: any) {
  try {
    const db = getDb(env ? { env } : undefined);
    const activeAlerts = await db.select().from(alerts).where(eq(alerts.isActive, true)).all();
    if (activeAlerts.length === 0) return;

    const codes = [...new Set(activeAlerts.map((a: any) => a.marketCode))] as string[];
    const stockData = await getTencentStockData(codes);
    
    const currentPrices = new Map<string, number>();
    for (const p of stockData) {
      currentPrices.set(p.marketCode, p.price);
    }

    for (const alert of activeAlerts) {
      const price = currentPrices.get(alert.marketCode);
      if (price === undefined) continue;

      let isTriggered = false;
      if (alert.type === 'price_above' && price >= alert.threshold) isTriggered = true;
      if (alert.type === 'price_below' && price <= alert.threshold) isTriggered = true;
      if (!isTriggered) continue;

      const direction = alert.type === 'price_above' ? '上穿' : '下穿';
      const title = `预警触发: ${alert.marketCode}`;
      const content = `${alert.marketCode} 当前价格 ${price}，已${direction}您设置的预警阈值 ${alert.threshold}。`;

      // 写入通知记录并取回完整对象（含 id），供前端实时展示
      const inserted = await db.insert(notifications).values({
        type: 'alert',
        title,
        content,
        createdAt: new Date()
      }).returning().all();
      const notification = inserted[0] || { type: 'alert', title, content, isRead: false, createdAt: new Date() };

      // 标记告警已触发并停用，避免重复触发
      await db.update(alerts).set({
        isTriggered: true,
        isActive: false,
        triggeredAt: new Date()
      }).where(eq(alerts.id, alert.id)).run();

      // 推送事件帧到所有在线 SSE 客户端
      // B3 修复：遍历时 try/catch，一个断连不中断其它客户端
      const payload = JSON.stringify({ type: 'notification', notification });
      for (const client of [...alertClients]) {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch {
          alertClients.delete(client);
        }
      }
    }
  } catch (err) {
    console.error("Alert polling error:", err);
  }
}

export default app;
export { initSettings, initStockPool, pollAlerts };
