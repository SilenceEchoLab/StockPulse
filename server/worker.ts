import app, { initSettings, initStockPool, pollAlerts, runResearchCycle } from './index.js';

export default {
  fetch: app.fetch,
  async scheduled(event: any, env: any, ctx: any) {
    await initSettings(env);
    await initStockPool(env);
    await pollAlerts(env);
    // AutoResearch 闭环自转：聚合全局策略 → 生成今日推荐 → 结算历史 → 刷新可信度
    // recommend 每日去重、resolve 幂等，故可安全随 cron 周期触发（频率见 wrangler.toml）
    ctx.waitUntil(runResearchCycle(env));
  }
};
