import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { notifications } from '../db/schema.js';
import { desc, inArray } from 'drizzle-orm';

const app = new Hono();

// 获取通知列表（按创建时间倒序）
app.get('/', async (c) => {
  try {
    const records = await getDb(c).select().from(notifications).orderBy(desc(notifications.createdAt)).all();
    return c.json({ success: true, data: records });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

// 标记通知已读；不传 ids 时标记全部已读
app.post('/read', async (c) => {
  const { ids } = (await c.req.json().catch(() => ({}))) as any;
  try {
    const db = getDb(c);
    if (ids && Array.isArray(ids) && ids.length > 0) {
      const chunkSize = 50;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        await db.update(notifications).set({ isRead: true }).where(inArray(notifications.id, chunk)).run();
      }
    } else {
      await db.update(notifications).set({ isRead: true }).run();
    }
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
