import app, { initSettings, initStockPool, pollAlerts } from './index.js';

export default {
  fetch: app.fetch,
  async scheduled(event: any, env: any, ctx: any) {
    await initSettings(env);
    await initStockPool(env);
    await pollAlerts(env);
  }
};
