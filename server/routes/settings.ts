import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const app = new Hono();

// 敏感字段列表：返回时需脱敏
const SENSITIVE_SUFFIXES = ['api_key', 'secret', 'token', 'password'];
const SENSITIVE_PREFIXES = ['ai_'];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_SUFFIXES.some(s => lower.endsWith(s)) ||
         (SENSITIVE_PREFIXES.some(p => lower.startsWith(p)) && SENSITIVE_SUFFIXES.some(s => lower.includes(s)));
}

function maskValue(value: string): string {
  if (!value || value.length <= 8) return '****';
  // 保留前4后4，中间脱敏
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

app.get('/', async (c) => {
  try {
    const records = await getDb(c).select().from(settings).all();
    const data: Record<string, string> = {};
    for (const r of records) {
      // C1 修复：敏感字段返回脱敏值
      data[r.key] = isSensitiveKey(r.key) ? maskValue(r.value) : r.value;
    }
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.post('/', async (c) => {
  try {
    const payload = (await c.req.json()) as any;
    const db = getDb(c);
    
    for (const [key, value] of Object.entries(payload)) {
      // C1 修复：如果传入的是脱敏占位值(含 ****)，跳过不覆盖
      if (typeof value === 'string' && value.includes('****')) continue;
      
      if (value === null || value === undefined || value === '') {
         await db.delete(settings).where(eq(settings.key, key)).run();
      } else {
         await db.insert(settings)
           .values({ key, value: String(value) })
           .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })
           .run();
      }
    }
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.get('/export', async c => {
  return c.json({ error: 'Export is not supported in Serverless environment' }, 400);
});

export default app;
