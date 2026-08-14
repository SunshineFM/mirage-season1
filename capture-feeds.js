const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'wss://connect.anchorbrowser.io/?sessionId=da4e6bef-7f70-4edb-9782-9e97ab07fa71';
const SCREENSHOT_DIR = 'public/archive/screenshots';

// Feed names and labels
const feeds = [
  { tabName: 'Good Shots', label: 'Good Shots' },
  { tabName: 'Good Vibes', label: 'Good Vibes' },
  { tabName: 'Good Tips', label: 'Good Tips' },
  { tabName: 'Hey Mirage', label: 'Hey Mirage' },
];

async function captureFeeds() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  // Set mobile viewport
  await page.setViewportSize({ width: 375, height: 812 });

  console.log('Navigating to Mirage app...');
  await page.goto('https://mirage-social.polsia.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Check if there's onboarding to get past
  const url = page.url();
  console.log('Current URL:', url);

  // Try to get past onboarding
  // The app may have a welcome/intro screen that we need to dismiss
  try {
    // Look for a continue button or skip button
    const continueBtn = await page.$('button:has-text(\"Continue\"), button:has-text(\"Start\"), button:has-text(\"Enter\"), button:has-text(\"Get Started\"), button:has-text(\"Skip\"), button:has-text(\"Next\")');
    if (continueBtn) {
      console.log('Found continue button, clicking...');
      await continueBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch(e) {
    console.log('No continue button found:', e.message);
  }

  // Try clicking through any intro screens
  for (let i = 0; i < 5; i++) {
    try {
      // Try common onboarding buttons
      const nextBtn = await page.$('button');
      if (nextBtn) {
        const text = await nextBtn.textContent();
        console.log('Button text:', text);
        if (text && !text.includes('Skip') && !text.includes('Allow') && !text.includes('Next')) {
          break;
        }
        await nextBtn.click();
        await page.waitForTimeout(500);
      }
    } catch(e) {}
  }

  // Wait for app to load
  await page.waitForTimeout(2000);
  console.log('URL after onboarding:', page.url());

  // Now find and click each feed tab
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    try {
      // Try to find the feed tab by looking for tab-like elements
      const tabs = await page.$$('[class*=\"tab\"], button, a');
      console.log(`\n--- Attempting feed ${i + 1}: ${feed.label} ---`);
      console.log('Looking for tab with text containing:', feed.tabName);

      // Try clicking by text content
      const tabSelectors = [
        `button:has-text(\"${feed.tabName}\")`,
        `[class*=\"tab\"]:has-text(\"${feed.tabName}\")`,
        `span:has-text(\"${feed.tabName}\")`,
        `div:has-text(\"${feed.tabName}\")`,
      ];

      for (const selector of tabSelectors) {
        try {
          const el = await page.$(selector);
          if (el) {
            console.log(`Found element with selector: ${selector}`);
            await el.click();
            await page.waitForTimeout(1500);
            break;
          }
        } catch(e) {}
      }

      // Take screenshot
      const filename = `feed-0${i + 1}-${feed.label.toLowerCase().replace(/ /g, '-')}.png`;
      const filepath = path.join(SCREENSHOT_DIR, filename);

      // Ensure directory exists
      if (!fs.existsSync(SCREENSHOT_DIR)) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      }

      await page.screenshot({ path: filepath, fullPage: false });
      console.log(`Saved: ${filepath}`);

    } catch(e) {
      console.error(`Error capturing ${feed.label}:`, e.message);
    }
  }

  console.log('\nDone! Screenshot files:');
  fs.readdirSync(SCREENSHOT_DIR).forEach(f => console.log(' -', f));

  await browser.close();
}

captureFeeds().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});