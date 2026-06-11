/* Round 3: selected world also swaps into #explore. */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));

  await page.goto('http://localhost:8000/?mode=day', { waitUntil: 'load' });
  // let the explore world mount first so the swap path (not first mount) is tested
  await page.waitForFunction(() => document.querySelectorAll('.world-portal-label').length > 0, { timeout: 120000 });
  console.log('explore mounted with default Liffey world');

  await page.locator('#quickChips button', { hasText: 'Grafton Street' }).first().click();
  await page.waitForSelector('#smCanvas.splat-ready', { timeout: 120000 });
  console.log('modal splat-ready');
  // wait for the explore-swap log line
  try {
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.sm-log .lg')].some(r => r.innerText.includes('live in the Explore section')), { timeout: 60000 });
    console.log('explore swap logged: YES');
  } catch { console.log('explore swap logged: TIMED OUT'); }

  await page.keyboard.press('Escape');
  await page.locator('#explore').scrollIntoViewIfNeeded();
  await page.waitForTimeout(9000); // crew pop-in in explore
  const kicker = await page.evaluate(() => document.querySelector('#explore .world-copy .kicker').textContent);
  console.log('explore kicker:', kicker);
  const worldId = await page.evaluate(() => {
    // exploreView isn't exported; infer from kicker + canvas rendering
    return document.querySelector('#cityCanvas') ? 'canvas present' : 'missing';
  });
  console.log(worldId);
  await page.screenshot({ path: 'tools/shot3-explore-swapped.png', clip: { x: 0, y: 0, width: 1440, height: 900 } });

  console.log('🔍 probe: re-select same location → instant dedupe (no re-download)');
  await page.locator('#quickChips button', { hasText: 'Grafton Street' }).first().click();
  await page.waitForSelector('#smCanvas.splat-ready', { timeout: 120000 });
  const log2 = await page.evaluate(() =>
    [...document.querySelectorAll('.sm-log .lg')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  console.log('second open log:', JSON.stringify(log2, null, 1));

  console.log('console errors:', JSON.stringify(errors) || 'none');
  await browser.close();
})().catch(e => { console.error('VERIFY3 FAILED:', e); process.exit(1); });
