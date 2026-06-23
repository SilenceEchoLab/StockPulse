import http from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createServer as createViteServer } from 'vite';
import app, { initSettings, pollAlerts, runResearchCycle } from './index.js';

const port = Number(process.env.PORT) || 3000;

// 本地开发服务器：单端口同时承载 Hono API 与 Vite SPA/HMR
async function startServer() {
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      // 尊重 DISABLE_HMR 环境变量，避免 agent 编辑时的频繁刷新
      hmr: process.env.DISABLE_HMR === 'true' ? false : { overlay: false },
    },
    appType: 'spa',
  });

  const honoListener = getRequestListener(app.fetch);

  const server = http.createServer((req, res) => {
    // /api 请求交由 Hono 处理，其余交给 Vite 中间件（SPA + 静态资源 + HMR）
    if (req.url?.startsWith('/api')) {
      honoListener(req, res);
    } else {
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    }
  });

  // 初始化默认配置并启动本地告警轮询（生产环境由 Worker cron 触发）
  await initSettings();
  const alertTimer = setInterval(() => {
    pollAlerts().catch((e) => console.error('Alert polling error:', e));
  }, 60_000);

  // 可选：研究闭环自转（RESEARCH_AUTO=1 开启，启动跑一次 + 每6小时一次）
  // 日常聚合全局策略、生成推荐、结算历史、刷新可信度；重优化仍由前端手动触发
  if (process.env.RESEARCH_AUTO === '1') {
    console.log('[AutoResearch] 自转已开启 (RESEARCH_AUTO=1)，每6小时执行一次日常闭环');
    runResearchCycle().catch((e) => console.error('Research cycle error:', e));
    setInterval(() => {
      runResearchCycle().catch((e) => console.error('Research cycle error:', e));
    }, 6 * 60 * 60 * 1000);
  }

  server.listen(port, () => {
    console.log(`StockPulse dev server running at http://localhost:${port}`);
  });

  const shutdown = () => {
    clearInterval(alertTimer);
    server.close();
    void vite.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((e) => {
  console.error(e);
  process.exit(1);
});
