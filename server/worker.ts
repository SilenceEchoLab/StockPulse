import app from './index.js';

export default {
  fetch: app.fetch,
  async scheduled(event: any, env: any, ctx: any) {
    // Background task logic
    console.log("Scheduled event executed");
  }
};
