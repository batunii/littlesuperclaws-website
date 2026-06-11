/* Round 2: explore section mounting + Temple Bar modal (retry path). */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));

  await page.goto('http://localhost:8000/?mode=day', { waitUntil: 'load', timeout: 30000 });
  await page.locator('#explore').scrollIntoViewIfNeeded();

  console.log('== explore: wait up to 120s for Marble world (portal labels appear when mounted) ==');
  try {
    await page.waitForFunction(() => document.querySelectorAll('.world-portal-label').length > 0, { timeout: 120000 });
    console.log('explore mounted: YES');
  } catch { console.log('explore mounted: TIMED OUT'); }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'tools/shot2-explore.png', clip: { x: 0, y: 0, width: 1440, height: 900 } });

  console.log('== Temple Bar modal ==');
  await page.locator('#quickChips button', { hasText: 'Temple Bar' }).first().click();
  try {
    await page.waitForSelector('#smCanvas.splat-ready', { timeout: 120000 });
    console.log('temple bar splat-ready: YES');
  } catch { console.log('temple bar splat-ready: TIMED OUT'); }
  await page.waitForTimeout(6000); // crew pop-in
  const log = await page.evaluate(() =>
    [...document.querySelectorAll('.sm-log .lg')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  console.log('modal log:', JSON.stringify(log, null, 1));
  await page.screenshot({ path: 'tools/shot2-templebar.png' });

  console.log('🔍 probe: Escape closes modal, viewer cleans up');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const closed = await page.evaluate(() => ({
    open: document.querySelector('.scene-modal').classList.contains('open'),
    ready: !!document.querySelector('#smCanvas.splat-ready'),
  }));
  console.log('after Escape:', JSON.stringify(closed));

  console.log('🔍 probe: gibberish location → must NOT spend credits silently; observe behaviour');
  await page.locator('#searchInput').fill('zzz nonexistent place qqq');
  // intercept the generate call so no real credits are spent in this probe
  await page.route('**/worlds:generate', r => r.fulfill({ status: 429, body: '{"message":"blocked by verify probe"}' }));
  await page.locator('#searchForm button[type=submit]').click();
  await page.waitForTimeout(6000);
  const log2 = await page.evaluate(() =>
    [...document.querySelectorAll('.sm-log .lg')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  console.log('unknown-location log:', JSON.stringify(log2, null, 1));
  await page.screenshot({ path: 'tools/shot2-unknown.png' });

  console.log('final console errors:', JSON.stringify(errors, null, 1) || 'none');
  await browser.close();
})().catch(e => { console.error('VERIFY2 FAILED:', e); process.exit(1); });
