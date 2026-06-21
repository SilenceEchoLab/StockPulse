import { chromium } from 'playwright-core';
import fs from 'fs';

(async () => {
  console.log('Starting E2E test...');
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

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
      console.log(`[Browser Error] ${msg.text()}`);
    }
  });
  page.on('pageerror', err => {
    errors.push(err.message);
    console.log(`[Page Error] ${err.message}`);
  });

  try {
    console.log('Navigating to Dashboard...');
    await page.goto('http://localhost:3000/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    console.log('Navigating to Stock Pool...');
    await page.goto('http://localhost:3000/#/pool', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    console.log('Navigating to Stock Detail...');
    await page.goto('http://localhost:3000/#/pool/sz000001', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    
    console.log('Navigating to AI Picks...');
    await page.goto('http://localhost:3000/#/ai-picks', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    console.log('Navigating to Backtest...');
    await page.goto('http://localhost:3000/#/backtest', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    console.log('Navigating to Settings...');
    await page.goto('http://localhost:3000/#/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    console.log('Done all navigations');
  } catch (err) {
    console.error('Script error:', err);
  }

  if (errors.length > 0) {
    console.error('Found errors during navigation:', errors.length);
  } else {
    console.log('No console errors found!');
  }

  await browser.close();
})();
