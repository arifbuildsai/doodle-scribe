// Quick frame QA for the doodle-scribe page: seek key times, screenshot the canvas.
const path = require('path');
const puppeteer = require('puppeteer');
(async () => {
  const CHROME_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  const chromeFallback = CHROME_PATHS.find((p) => require('fs').existsSync(p));
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files'],
    ...(chromeFallback ? { executablePath: chromeFallback } : {}),
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300)); });
  // EDIT ME: point this at YOUR player page (a copy of doodle-scribe/template.html in your project dir)
  await page.goto('file:///absolute/path/to/your-project/player.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  const times = process.argv[2] ? process.argv[2].split(',').map(Number) : [1.5, 4.2, 6.5, 11.5, 15.2, 19.5, 23.0, 26.0];
  for (const t of times) {
    await page.evaluate('window.__renderMode = true');
    await page.evaluate((tt) => window.seek(tt), t);
    const b64 = await page.evaluate(() => document.getElementById('cv').toDataURL('image/png').split(',')[1]);
    require('fs').writeFileSync('/tmp/opencode/dsqa_' + String(t).replace('.', '_') + '.png', Buffer.from(b64, 'base64'));
    console.log('frame', t);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
