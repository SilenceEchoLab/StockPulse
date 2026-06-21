// D2/E1 修复：统一 API 调用层
// 提供 SWR fetcher 和封装的 api 辅助函数，消除散落各处的重复 fetch 逻辑

export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
};

export const api = {
  get: async <T = any>(url: string): Promise<T> => {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
    return json;
  },

  post: async <T = any>(url: string, body?: any): Promise<T> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || json.message || `Request failed: ${res.status}`);
    return json;
  },

  delete: async <T = any>(url: string): Promise<T> => {
    const res = await fetch(url, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
    return json;
  },
};
