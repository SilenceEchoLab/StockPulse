import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { alerts } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { alertClients } from '../lib/state.js';

const app = new Hono();

// 告警实时推送：注册当前连接到 alertClients，由 pollAlerts 主动写入事件帧
app.get('/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    // alertClients 中存储的 client 暴露 write 方法，pollAlerts 直接写入原始 SSE 帧
    const client = {
      write: (raw: string) => stream.write(raw),
    };
    alertClients.add(client);

    const signal = c.req.raw.signal;
    const onAbort = () => alertClients.delete(client);
    signal.addEventListener('abort', onAbort);

    // 连接建立即发送确认帧，便于前端感知连接成功
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });
    } catch {
      // 写入失败说明连接已断开，直接退出
    }

    // 心跳保活，防止代理/浏览器因长时间无数据而断开连接
    while (!signal.aborted) {
      await stream.sleep(30_000);
      if (!signal.aborted) {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) });
        } catch {
          break;
        }
      }
    }

    alertClients.delete(client);
    signal.removeEventListener('abort', onAbort);
  });
});

// 获取全部告警规则
app.get('/', async (c) => {
  try {
    const records = await getDb(c).select().from(alerts).all();
    return c.json({ success: true, data: records });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

// 新建告警规则
app.post('/', async (c) => {
  const { marketCode, type, threshold } = (await c.req.json()) as any;
  if (!marketCode || !type || threshold === undefined) {
    return c.json({ error: 'Missing marketCode, type or threshold' }, 400);
  }
  try {
    getDb(c).insert(alerts).values({
      marketCode, type, threshold: Number(threshold), createdAt: new Date()
    }).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

// 删除告警规则
app.delete('/:id', async (c) => {
  try {
    await getDb(c).delete(alerts).where(eq(alerts.id, parseInt(c.req.param('id')))).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
