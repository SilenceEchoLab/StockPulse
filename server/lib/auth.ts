import type { Context, Next } from 'hono';

// C2 修复：轻量鉴权中间件
// 通过环境变量 ADMIN_TOKEN 控制。未设置时不强制鉴权（兼容本地 dev 无密码场景）
// 部署到生产时务必设置 ADMIN_TOKEN
export async function authMiddleware(c: Context, next: Next) {
  const adminToken = c.env?.ADMIN_TOKEN || (typeof process !== 'undefined' ? process.env.ADMIN_TOKEN : undefined);

  // 未配置 token 时不拦截，仅打印警告（本地 dev 友好）
  if (!adminToken) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const xToken = c.req.header('X-Admin-Token');

  // 支持 Bearer token 或 X-Admin-Token 两种方式
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : xToken;

  if (token !== adminToken) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  return next();
}

// 仅对写操作（POST/PUT/DELETE）鉴权，读操作放行
export async function writeAuthMiddleware(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  if (method === 'GET') return next();
  return authMiddleware(c, next);
}
