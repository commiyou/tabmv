// Store screenshots (1280x800) and the small promo tile (440x280), in English and
// Chinese, written to store/. Uses the panel screenshots in docs/images
// (regenerate them with SHOTS=docs/images npm run e2e).
//   CHROME=/path/to/chrome node scripts/store-assets.cjs
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '..');
const img = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(root, f)).toString('base64');
const COPY = {
  en: {
    suffix: '',
    head: 'Know every tab at a glance',
    sub: 'Name tabs from page text, URL parts and the original title. Color each environment.',
    before: 'Before',
    after: 'With Telltab',
    tabs: ['Dashboard', 'Dashboard', 'Dashboard', 'Order detail'],
    renamed: [['sandbox01', '#d93025'], ['qa3', '#188038'], ['prod · Dashboard', '#1a73e8'], ['#4211 Alice', '#9334e6']],
    tile: 'Rename tabs by URL & page text',
  },
  zh: {
    suffix: '.zh-CN',
    head: '每个标签，一眼认出',
    sub: '用页面文字、网址片段和原标题组合标签名，每个环境一个颜色。',
    before: '之前',
    after: '用了 Telltab',
    tabs: ['控制台', '控制台', '控制台', '订单详情'],
    renamed: [['sandbox01', '#d93025'], ['qa3', '#188038'], ['prod · 控制台', '#1a73e8'], ['#4211 Alice', '#9334e6']],
    tile: '按网址和页面内容重命名标签',
  },
};

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif; color: #202124; }
  .strip { display: flex; gap: 2px; padding: 8px 8px 0; background: #dee1e6; border-radius: 10px 10px 0 0; }
  .tab { display: flex; align-items: center; gap: 8px; width: 150px; padding: 8px 10px; background: #e8eaed; border-radius: 8px 8px 0 0; font-size: 13px; white-space: nowrap; overflow: hidden; }
  .tab.on { background: #fff; }
  .fav { position: relative; width: 16px; height: 16px; border-radius: 4px; background: #9aa0a6; flex: none; }
  .fav i { position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid #fff; }
  .label { font-size: 13px; color: #5f6368; margin: 14px 0 6px; font-weight: 600; }
`;
const strip = (tabs) => `<div class="strip">${tabs.map(([t, c], i) => `<div class="tab ${i === 0 ? 'on' : ''}"><span class="fav">${c ? `<i style="background:${c}"></i>` : ''}</span>${t}</div>`).join('')}</div>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: 'new' });
  const page = await browser.newPage();
  const render = async (w, h, html, out) => {
    await page.setViewport({ width: w, height: h });
    await page.setContent(`<html><head><style>${css}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(root, 'store', out) });
    console.log('store/' + out);
  };
  for (const c of Object.values(COPY)) {
    const panel = img(`docs/images/panel${c.suffix}.png`);
    await render(1280, 800, `
      <div style="display:flex;height:800px;background:linear-gradient(135deg,#eef3fe,#f8f9fa)">
        <div style="flex:1;padding:64px 48px 0 64px">
          <div style="font-size:44px;font-weight:700;line-height:1.2">${c.head}</div>
          <div style="font-size:20px;color:#5f6368;margin:16px 0 40px;line-height:1.5">${c.sub}</div>
          <div class="label">${c.before}</div>${strip(c.tabs.map((t) => [t, '']))}
          <div class="label" style="margin-top:28px">${c.after}</div>${strip(c.renamed)}
        </div>
        <div style="width:440px;padding:40px 40px 0 0;overflow:hidden">
          <img src="${panel}" style="width:400px;border-radius:12px;box-shadow:0 8px 30px #0003;background:#fff">
        </div>
      </div>`, `screenshot-1${c.suffix}.png`);
    const options = img(`docs/images/options${c.suffix}.png`);
    await render(1280, 800, `
      <div style="height:800px;background:#f1f3f4;padding:40px 90px;overflow:hidden">
        <img src="${options}" style="width:1100px;border-radius:12px;box-shadow:0 8px 30px #0003;background:#fff">
      </div>`, `screenshot-2${c.suffix}.png`);
    await render(440, 280, `
      <div style="height:280px;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:0 28px;background:linear-gradient(135deg,#4c8df6,#1a5fd0);color:#fff">
        <div style="display:flex;align-items:center;gap:14px"><img src="${img('icons/icon128.png')}" style="width:64px"><span style="font-size:40px;font-weight:700">Telltab</span></div>
        <div style="font-size:20px;line-height:1.35">${c.tile}</div>
      </div>`, `promo-small${c.suffix}.png`);
  }
  await browser.close();
})();
