/* Confirms the vendored worlds actually render, with no network to worldlabs. */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    // pinned: the cached build (1217) differs from what playwright 1.60 expects
    executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], external = [], worldReqs = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 180)));
  page.on('request', r => {
    const u = r.url();
    if (/worldlabs\.ai/.test(u)) external.push(u.slice(0, 90));
    if (/\/worlds\//.test(u)) worldReqs.push(u.replace('http://localhost:8000/', ''));
  });

  const SHOT = process.argv[2];
  await page.goto('http://localhost:8000/?mode=day', { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.querySelectorAll('.world-portal-label').length > 0, { timeout: 120000 });
  console.log('✓ #explore mounted');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: SHOT + '/local-explore.png' });

  // open a vendored world through the UI
  await page.locator('#quickChips button', { hasText: 'Temple Bar' }).first().click();
  await page.waitForSelector('#smCanvas.splat-ready', { timeout: 120000 });
  console.log('✓ Temple Bar modal reached splat-ready');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: SHOT + '/local-templebar.png' });

  console.log('\nworldlabs.ai requests (must be none):', external.length ? external : 'NONE');
  console.log('local world assets fetched:', [...new Set(worldReqs)].join('\n  ') || 'none');
  console.log('\nconsole errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
  await browser.close();
  process.exit(errors.length || external.length ? 1 : 0);
})();
