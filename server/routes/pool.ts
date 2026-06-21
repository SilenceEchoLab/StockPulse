import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { stocks as stocksSchema, groups, stockGroupsLink } from '../db/schema.js';
import { eq, or, like, and } from 'drizzle-orm';
import { pinyin } from 'pinyin-pro';

const app = new Hono();

// C3 修复：股票代码格式校验
const CODE_REGEX = /^(sh|sz|bj)\d{6}$/;

app.get('/', async (c) => {
  try {
    const records = await getDb(c).select().from(stocksSchema).all();
    return c.json({ success: true, data: records });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.post('/', async (c) => {
  const { code, name } = (await c.req.json()) as any;
  if (!code) return c.json({ error: 'Missing code' }, 400);
  if (!CODE_REGEX.test(code)) return c.json({ error: 'Invalid stock code format' }, 400);
  try {
    await getDb(c).insert(stocksSchema).values({
      marketCode: code,
      name: (name || code).substring(0, 32),
      isActive: true,
      lastSyncTime: new Date()
    }).onConflictDoUpdate({
      target: stocksSchema.marketCode,
      set: { isActive: true }
    }).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.post('/import', async (c) => {
  try {
    const content = await c.req.text();
    if (!content || typeof content !== 'string') {
      return c.json({ error: 'Empty or invalid CSV content' }, 400);
    }
    // C3 修复：限制导入大小（5MB）
    if (content.length > 5 * 1024 * 1024) {
      return c.json({ error: 'CSV content too large (max 5MB)' }, 400);
    }
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const toInsert = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      if (row.length >= 6 && CODE_REGEX.test(row[0])) {
        toInsert.push({
          marketCode: row[0],
          name: (row[2] || row[0]).substring(0, 32),
          view: (row[3] || '').substring(0, 256),
          industry: (row[4] || '').substring(0, 64),
          remarks: (row[5] || '').substring(0, 256),
          isActive: true,
          lastSyncTime: new Date()
        });
      }
    }
    if (toInsert.length > 0) {
      const tx = getDb(c);
      for (const r of toInsert) {
        await tx.insert(stocksSchema).values(r).onConflictDoUpdate({
          target: stocksSchema.marketCode,
          set: r
        }).run();
      }
    }
    return c.json({ success: true, message: `Imported ${toInsert.length} stocks` });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.delete('/:code', async (c) => {
  try {
    await getDb(c).delete(stocksSchema).where(eq(stocksSchema.marketCode, c.req.param('code'))).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.get('/search', async (c) => {
  const q = ((c.req.query('q') as string) || '').trim().toLowerCase();
  if (!q) {
    return c.json({ success: true, data: [] });
  }
  try {
    // 优先精确 LIKE 匹配代码与名称
    let records = await getDb(c).select()
      .from(stocksSchema)
      .where(
        or(
          like(stocksSchema.marketCode, `%${q}%`),
          like(stocksSchema.name, `%${q}%`)
        )
      )
      .limit(10)
      .all();

    // 仅当查询为纯 ASCII 字母（疑似拼音）且 LIKE 命中不足时，用拼音兜底
    // 中文查询和代码查询无需拼音匹配，直接返回 LIKE 结果以保证响应速度
    const isAlphaQuery = /^[a-z]+$/.test(q);
    if (isAlphaQuery && records.length < 10) {
      const all = await getDb(c).select().from(stocksSchema).all();
      const matched = new Map<string, any>();
      for (const r of records) matched.set(r.marketCode, r);
      for (const r of all) {
        if (matched.size >= 10) break;
        if (matched.has(r.marketCode) || !r.name) continue;
        const full = pinyin(r.name, { toneType: 'none' }).replace(/\s+/g, '').toLowerCase();
        if (full.includes(q)) {
          matched.set(r.marketCode, r);
          continue;
        }
        const first = pinyin(r.name, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '').toLowerCase();
        if (first.includes(q)) {
          matched.set(r.marketCode, r);
        }
      }
      records = Array.from(matched.values()).slice(0, 10);
    }

    return c.json({ success: true, data: records });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
