export const syncProcess = {
  status: 'idle' as 'idle' | 'syncing' | 'completed' | 'error',
  total: 0,
  current: 0,
  progress: 0,
  logs: [] as { time: string; type: string; message: string; sub: string }[],
  totalRequests: 0,
  errorCount: 0,
  diskUsageBytes: 0,
  startTime: null as Date | null,
};

export function addLog(type: string, message: string, sub: string = '') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  syncProcess.logs.unshift({ time, type, message, sub });
  if (syncProcess.logs.length > 100) syncProcess.logs.pop();
}

export const aiPicksCache = new Map<string, any>();
export const stockCache = new Map<string, { timestamp: number, data: any }>();
export const alertClients = new Set<any>();

// For Cloudflare environment, these in-memory states won't persist across requests.
// We should ideally use Durable Objects, KV or D1 for state that needs to persist.
