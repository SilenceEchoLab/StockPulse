import { chromium } from 'playwright-core';
import fs from 'fs';

(async () => {
  console.log('Starting visible browser for sync task...');
  let executablePath = '';
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      executablePath = p;
      break;
    }
  }

  const browser = await chromium.launch({ executablePath, headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  
  try {
    console.log('Navigating to Dashboard...');
    await page.goto('http://localhost:3000/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const startBtn = buttons.find(b => b.textContent && b.textContent.includes('开始同步任务'));
      if (startBtn) {
        startBtn.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      console.log('Task started!');
    } else {
      console.log('Task is already syncing! Just observing...');
    }

    console.log('Waiting to observe progress...');
    await page.waitForTimeout(10000);
    
    console.log('Switching to Logs tab to see the sync process...');
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const logBtn = buttons.find(b => b.textContent && b.textContent.includes('进程日志'));
      if (logBtn) logBtn.click();
    });
    
    await page.waitForTimeout(15000);

    console.log('Sync observation finished.');
  } catch (err) {
    console.error('Script error:', err);
  }

  console.log('Closing browser...');
  await browser.close();
})();
