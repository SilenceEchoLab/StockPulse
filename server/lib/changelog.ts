// 演进日志（changelog）—— 圆桌「过程可读」：策略自我升级的不可伪造证据链
import { desc } from 'drizzle-orm';
import { researchChangelog } from '../db/schema.js';

export interface ChangelogEntry {
  type: 'update' | 'revert' | 'credibility' | 'discipline' | 'optimize' | 'audit';
  strategy: string;
  regime?: string;
  message: string;
  details?: any;
}

export async function appendChangelog(db: any, entry: ChangelogEntry): Promise<void> {
  await db.insert(researchChangelog).values({
    createdAt: new Date(),
    type: entry.type,
    strategy: entry.strategy,
    regime: entry.regime ?? 'all',
    message: entry.message,
    details: entry.details !== undefined ? JSON.stringify(entry.details) : null,
  }).run();
}

export async function getChangelog(db: any, limit = 50): Promise<any[]> {
  const rows = await db.select().from(researchChangelog)
    .orderBy(desc(researchChangelog.createdAt)).limit(limit).all() as any[];
  return rows.map((r: any) => ({
    ...r,
    details: r.details ? safeParse(r.details) : null,
  }));
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return s; } }
