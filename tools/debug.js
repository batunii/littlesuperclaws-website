const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('[console]', m.text().slice(0, 200)); });
  await page.goto('http://localhost:8000/?mode=day', { waitUntil: 'load' });
  await page.locator('#quickChips button', { hasText: 'Temple Bar' }).first().click();
  await page.waitForSelector('#smCanvas.splat-ready', { timeout: 120000 });
  await page.waitForTimeout(8000);
  const dump = await page.evaluate(() => {
    const s = window.__lscViewer._debug();
    return {
      collider: !!s.collider,
      openDist: s._openDist,
      yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3),
      camPos: s.camera.position.toArray().map(v => +v.toFixed(2)),
      crewCount: s.crew.length,
      crew: s.crew.map(c => ({
        pos: c.obj.position.toArray().map(v => +v.toFixed(2)),
        scale: +c.obj.scale.x.toFixed(3),
        visible: c.obj.visible,
        spawn: c.obj.userData.spawn, t: +s.t.toFixed(2),
      })),
      sceneChildren: s.scene.children.length,
    };
  });
  console.log(JSON.stringify(dump, null, 1));
  await page.screenshot({ path: 'tools/shot-debug.png' });
  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
