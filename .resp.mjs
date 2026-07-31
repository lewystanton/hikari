import { _electron } from 'playwright-core';
const T = process.env.T;
const app = await _electron.launch({ args: ['.', `--user-data-dir=${T}/audit`],
  env: { ...process.env, HIKARI_DATA_DIR: `${T}/audit` } });
const w = await app.firstWindow();
await w.waitForLoadState('domcontentloaded');
await w.waitForTimeout(7000);
const views = ['all', 'airing', 'announce', 'discover', 'browse'];
for (const [ww, hh] of [[1400, 900], [1180, 820], [1060, 760]]) {
  await w.setViewportSize({ width: ww, height: hh });
  await w.waitForTimeout(600);
  const out = [];
  for (const v of views) {
    await w.evaluate((view) => document.querySelector(`[data-view="${view}"]`)?.click(), v);
    await w.waitForTimeout(900);
    const r = await w.evaluate(() => {
      const sc = document.querySelector('.screen.active');
      const over = [...document.querySelectorAll('.screen.active *')]
        .filter(e => e.scrollWidth > e.clientWidth + 4 && getComputedStyle(e).overflowX === 'visible')
        .slice(0, 2).map(e => (e.className || e.tagName).toString().split(' ')[0]);
      return { page: sc ? sc.scrollWidth > sc.clientWidth + 2 : false, over };
    });
    out.push(v + (r.page ? ':PAGE-OVERFLOW' : '') + (r.over.length ? ':' + r.over.join('/') : ''));
  }
  console.log(`${ww}x${hh}`.padEnd(10) + out.join('  '));
}
await app.close();
