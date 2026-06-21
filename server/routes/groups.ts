import { Hono } from 'hono';
import { getDb } from '../db/getDb.js';
import { groups, stockGroupsLink } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const app = new Hono();

app.get('/', async (c) => {
  try {
    const records = await getDb(c).select().from(groups).all();
    return c.json({ success: true, data: records });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.post('/', async (c) => {
  const { name } = (await c.req.json()) as any;
  if (!name) return c.json({ error: 'Missing group name' }, 400);
  try {
    await getDb(c).insert(groups).values({
      name,
      createdAt: new Date(),
    }).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.delete('/:id', async (c) => {
  try {
    const groupId = parseInt(c.req.param('id'));
    const db = getDb(c);
    // Batch deletion to replace incompatible D1 transaction
    await db.batch([
      db.delete(stockGroupsLink).where(eq(stockGroupsLink.groupId, groupId)),
      db.delete(groups).where(eq(groups.id, groupId))
    ]);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.post('/:id/stocks', async (c) => {
  const groupId = parseInt(c.req.param('id'));
  const { code } = (await c.req.json()) as any;
  if (!code) return c.json({ error: 'Missing stock code' }, 400);
  try {
    await getDb(c).insert(stockGroupsLink).values({
      groupId,
      marketCode: code,
    }).onConflictDoNothing().run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.delete('/:id/stocks/:code', async (c) => {
  try {
    const groupId = parseInt(c.req.param('id'));
    const code = c.req.param('code');
    await getDb(c).delete(stockGroupsLink)
      .where(and(
        eq(stockGroupsLink.groupId, groupId),
        eq(stockGroupsLink.marketCode, code)
      )).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

// Helper route for pool.tsx to fetch stocks in a group
app.get('/:id', async (c) => {
  try {
    const groupId = parseInt(c.req.param('id'));
    const records = await getDb(c).select().from(stockGroupsLink).where(eq(stockGroupsLink.groupId, groupId)).all();
    return c.json({ success: true, data: records });
  } catch (e: any) {
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
