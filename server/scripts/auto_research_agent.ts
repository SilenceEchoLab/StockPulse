import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// API Endpoints for the AutoResearch Loop
const BASE_URL = 'http://localhost:3000/api/research'; // Adjust port if necessary

// Utility to sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAPI(endpoint: string, method: string = 'GET', body?: any) {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  return response.json();
}

async function runLoop() {
  console.log('🤖 [AutoResearch Agent] 启动 Loop Engineering 循环...');
  
  // 1. Generate & Test: 触发全量优化
  console.log('⏳ [1/6] 触发策略参数网格优化 (Generate & Test) ...');
  const optimizeRes = await fetchAPI('/optimize', 'POST', {
    strategies: ['three_cycle', 'macd_cross', 'rsi_reversal', 'ma520'],
    maxSamples: 5 
  });
  
  if (!optimizeRes.success) {
    console.error('❌ 优化任务启动失败:', optimizeRes.message || optimizeRes.error);
    if(optimizeRes.message !== '优化任务正在执行中') return;
  } else {
    console.log('✅ 优化任务已启动。');
  }

  // 轮询进度
  let isCompleted = false;
  while (!isCompleted) {
    await sleep(5000);
    try {
      const statusRes = await fetchAPI('/status');
      if (statusRes.success && statusRes.data) {
        const { progress, status, profitable, total, current } = statusRes.data;
        console.log(`🔄 进度: ${progress}% (${current}/${total}) - 盈利组合: ${profitable} [状态: ${status}]`);
        if (status === 'completed' || status === 'error') {
          isCompleted = true;
          if (status === 'error') {
             console.error('❌ 优化任务出错。');
             return;
          }
        }
      }
    } catch(e) {
      console.log('等待服务器响应...');
    }
  }
  console.log('✅ [1/6] & [2/6] Generate & Test 阶段完成 (含 Evaluate 惩罚)。');

  // 3. Aggregate: 已经在后端的 /optimize 跑完时自动调用了，但我们可以手动触发以确认
  console.log('⏳ [3/6] 提炼全局稳健策略 (Aggregate) ...');
  const aggregateRes = await fetchAPI('/aggregate-global', 'POST');
  if (aggregateRes.success) {
    console.log('✅ 全局稳健策略提炼完成。');
  } else {
    console.error('❌ 聚合失败:', aggregateRes.error);
  }

  // 4. Recommend & Execute: 生成沙盘推荐
  console.log('⏳ [4/6] 生成实战推荐信号 (Recommend) ...');
  const recommendRes = await fetchAPI('/recommend', 'POST');
  if (recommendRes.success || recommendRes.message?.includes('今日已生成')) {
     console.log('✅ 交易推荐生成完成。', recommendRes.success ? `生成了 ${recommendRes.data.recommended} 个推荐。` : recommendRes.message);
  } else {
     console.error('❌ 推荐生成失败:', recommendRes.error);
  }

  // 5. Learn & Resolve: 结算与可信度更新
  console.log('⏳ [5/6] 真实收益结算与贝叶斯可信度更新 (Learn & Resolve) ...');
  const resolveRes = await fetchAPI('/resolve', 'POST');
  if (resolveRes.success) {
     console.log(`✅ 结算完成。处理了 ${resolveRes.data.resolved} 笔历史推荐。`);
  } else {
     console.error('❌ 结算失败:', resolveRes.error);
  }

  // 6. 提取失败教训与新灵感：生成 AI Research Report
  console.log('⏳ [6/6] AI Agent 生成研究报告 (Knowledge Extraction) ...');
  await generateResearchReport();
  
  console.log('🎉 完整的 AutoResearch 循环执行完毕！等待下一个周期。');
}

async function generateResearchReport() {
  try {
     const globalOptima = await fetchAPI('/global-optima');
     const credibility = await fetchAPI('/credibility');
     const runs = await fetchAPI('/runs');

     const dateStr = new Date().toISOString().split('T')[0];
     const reportContent = `# AutoResearch 循环研究报告 (${dateStr})

## 1. 优化运行概况 (Runs)
${runs.data?.[0] ? `- 最后一次运行: 耗时，测试了 ${runs.data[0].stocksOptimized} 支股票，其中 ${runs.data[0].stocksProfitable} 支找到盈利参数。
- 综合最佳得分: ${runs.data[0].bestCompositeScore?.toFixed(2) ?? 'N/A'}` : '无数据'}

## 2. 全局稳健策略 (Global Optima)
本次循环提炼出的具有跨股票泛化能力的最优策略：
${globalOptima.data?.map((g: any) => `- **${g.strategy}** (环境: ${g.regime}): 稳定率 ${(g.stabilityScore*100).toFixed(1)}%, 覆盖股票: ${g.coverageStocks}。
  - 测试平均收益: ${(g.avgTestReturn*100).toFixed(2)}%, 最大回撤: ${(g.avgMaxDrawdown*100).toFixed(2)}%`).join('\n') || '无数据'}

## 3. 贝叶斯可信度更新 (Blended Credibility)
结合先验（回测）与后验（实盘）的最终置信度评估：
${credibility.data?.map((c: any) => `- **${c.strategy}**: 融合可信度 **${c.blendedCredibility?.toFixed(3)}** (实盘样本: ${c.realSampleCount}, 实盘胜率: ${c.realWinRate ? (c.realWinRate*100).toFixed(1)+'%' : 'N/A'})`).join('\n') || '无数据'}

## 4. Agent 分析结论 (Actionable Insights)
基于本次 Loop 的数据：
1. **淘汰策略**: 融合可信度低于 0.4 的策略，应在下一次 Generate 环节减少其参数空间搜索。
2. **市场适应性**: 重点观察 'range' 或 'bear' regime 下表现最好的策略，它们是平台的风控底仓。
3. **下一步 (Next Step)**: 系统已将最新的贝叶斯权重反哺至推荐引擎。下个周期将继续监控实战收益偏差。
`;

    const reportDir = path.resolve(process.cwd(), 'docs/research');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    const filename = path.join(reportDir, `report_${dateStr}.md`);
    fs.writeFileSync(filename, reportContent);
    console.log(`✅ 研究报告已生成: ${filename}`);

  } catch(e: any) {
    console.error('生成报告出错:', e.message);
  }
}

async function startAgent() {
  console.log('🤖 [AutoResearch Agent] 启动 Loop Engineering 持续优化循环...');
  let cycle = 1;
  while (true) {
    console.log(`\n===========================================`);
    console.log(`🚀 开始执行第 ${cycle} 轮 AutoResearch 闭环`);
    console.log(`===========================================`);
    try {
      await runLoop();
    } catch (e: any) {
      console.error(`❌ 第 ${cycle} 轮循环发生错误:`, e.message);
    }
    
    console.log('⏳ 本轮循环结束，进入休眠，等待 10 秒后开始下一轮...');
    await sleep(10 * 1000); // Wait 10 seconds between full optimization cycles
    cycle++;
  }
}

// 启动
startAgent().catch(console.error);
