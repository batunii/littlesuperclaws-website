/* Drives the live site and captures evidence of the World Labs integration. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

  console.log('== 1. load page ==');
  await page.goto('http://localhost:8000', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4000);
  console.log('console errors after load:', JSON.stringify(errors, null, 1) || 'none');

  console.log('== 3a. explore section state ==');
  await page.locator('#explore').scrollIntoViewIfNeeded();
  await page.waitForTimeout(6000);
  const explore = await page.evaluate(() => ({
    exploreWorld: window.LSC_EXPLORE_WORLD || null,
    manifest: Object.keys(window.LSC_WORLDS || {}),
    canvasVisible: !!document.querySelector('#cityCanvas') && getComputedStyle(document.querySelector('#cityCanvas')).display !== 'none',
    portalLabels: document.querySelectorAll('.world-portal-label').length,
    fallbackShown: !document.getElementById('worldFallback').hidden,
  }));
  console.log(JSON.stringify(explore, null, 1));
  await page.screenshot({ path: 'tools/shot-explore.png', clip: { x: 0, y: 0, width: 1440, height: 900 } });

  console.log('== 2. Temple Bar chip → modal ==');
  await page.locator('#quickChips button', { hasText: 'Temple Bar' }).first().click();
  await page.waitForSelector('.scene-modal.open', { timeout: 5000 });
  try {
    await page.waitForSelector('#smCanvas.splat-ready', { timeout: 90000 });
    console.log('splat-ready: YES');
  } catch {
    console.log('splat-ready: TIMED OUT after 90s');
  }
  await page.waitForTimeout(5000); // let crew GLBs pop in
  const log = await page.evaluate(() =>
    [...document.querySelectorAll('.sm-log .lg')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  console.log('modal log:', JSON.stringify(log, null, 1));
  const state = await page.evaluate(() => ({
    worldOpen: !!document.querySelector('.sm-card.world-open'),
    canvasReady: !!document.querySelector('#smCanvas.splat-ready'),
    actionsShown: !document.getElementById('smActions').hidden,
  }));
  console.log(JSON.stringify(state, null, 1));
  await page.screenshot({ path: 'tools/shot-modal.png' });

  console.log('== probe: drag look + unknown location entry (no generation submitted) ==');
  const c = page.locator('#smCanvas');
  const bb = await c.boundingBox();
  if (bb) {
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + 200, bb.y + bb.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'tools/shot-modal-dragged.png' });
    console.log('dragged OK');
  }
  // close → reopen another pregen world (cache/reuse path)
  await page.locator('#smClose').click();
  await page.waitForTimeout(500);
  await page.locator('#quickChips button', { hasText: "St Stephen's Green" }).first().click();
  try {
    await page.waitForSelector('#smCanvas.splat-ready', { timeout: 90000 });
    console.log('second world splat-ready: YES');
  } catch { console.log('second world: TIMED OUT'); }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'tools/shot-modal-green.png' });

  console.log('final console errors:', JSON.stringify(errors, null, 1) || 'none');
  await browser.close();
})().catch(e => { console.error('VERIFY SCRIPT FAILED:', e); process.exit(1); });
