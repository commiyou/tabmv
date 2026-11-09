// End-to-end check in a real Chromium with the unpacked extension loaded.
// Needs puppeteer-core and a Chromium that still accepts --load-extension
// (Chrome for Testing / Chromium; branded Chrome >= 137 ignores it):
//   npm i && CHROME=/path/to/chrome npm run e2e
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

const EXT = path.resolve(__dirname, '..');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#09f"/></svg>';
const PAGE = `<!doctype html><html><head><title>Original</title>
<link rel="icon" href="/fav.svg"></head><body>
<p>Owner: <span class="owner">Alice</span></p>
<script>
  setTimeout(() => { document.title = 'Changed by page'; }, 300);
  // simulates an SPA that renders its content late
  setTimeout(() => { const h = document.createElement('h1'); h.className = 'env-name'; h.textContent = '  Env  One '; document.body.prepend(h); }, 1200);
  window.go = (q) => history.pushState({}, '', '/app?' + q);
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error('timeout waiting for ' + what + ' (last=' + JSON.stringify(last) + ')');
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/fav.svg')) return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG);
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME,
    headless: process.env.HEADFUL ? false : 'new',
    args: ['--disable-features=DisableLoadExtensionCommandLineSwitch', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'],
  });
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
    const sw = await swTarget.worker();
    const setRules = (text) => sw.evaluate((t) => TabStore.saveRulesText(t), text);

    await setRules('*[?&]env=(*).baidu.com* => ${sel:"h1.env-name" || 1} ; color=auto\n*://*/* => [${q.env|default:prod}] $title');
    const page = await browser.newPage();
    await page.goto(base + '/app?id=3&env=sandbox01.baidu.com&x=1');

    await waitFor(async () => (await page.title()) === 'sandbox01', 'URL fallback before the element exists');
    await sleep(600); // page rewrites its own title at 300ms
    assert.equal(await page.title(), 'sandbox01', 'title survives page rewrite');
    await waitFor(async () => (await page.title()) === 'Env One', 'page text once the element renders');
    console.log('ok  ${sel:… || $1}: URL value while loading, page text once rendered');
    const icon = await waitFor(() => page.$eval('link[data-tabmv]', (l) => l.href).catch(() => null), 'favicon');
    assert.match(icon, /^data:image\/png;base64,/);
    assert.equal(await page.$$eval('link[rel~="icon" i]', (ls) => ls.length), 1, 'page favicon disabled');
    console.log('ok  glob rule renames title, keeps it, sets colored favicon');

    await page.evaluate(() => window.go('env=qa'));
    await waitFor(async () => (await page.title()) === '[qa] Changed by page', 'SPA navigation + $title');
    assert.equal(await page.$('link[data-tabmv]'), null, 'favicon restored when rule has no icon/color');
    console.log('ok  pushState re-evaluates; $title uses the page title, not ours');

    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://127.0.0.1/*' }))[0].id);
    await sw.evaluate(async (id) => {
      await chrome.storage.session.set({ ['ov:' + id]: { title: 'Manual ${q.env}', icon: '🔥' } });
      await chrome.tabs.sendMessage(id, { type: 'refresh' });
    }, tabId);
    await waitFor(async () => (await page.title()) === 'Manual qa', 'manual override');
    await page.reload();
    await waitFor(async () => (await page.title()) === 'Manual qa', 'override survives reload');
    console.log('ok  manual override applies and survives reload');

    await sw.evaluate(async (id) => {
      await chrome.storage.session.remove('ov:' + id);
      await chrome.tabs.sendMessage(id, { type: 'refresh' });
    }, tabId);
    await setRules('# nothing');
    await waitFor(async () => (await page.title()) === 'Changed by page', 'restore original title');
    console.log('ok  removing rules restores the original title');

    // Side panel flow: pick an element on the page, save as a site rule.
    const extId = new URL(swTarget.url()).host;
    // Open the panel in its own window so both it and the page stay visible,
    // like the real side panel next to the page.
    const panelUrl = 'chrome-extension://' + extId + '/src/panel.html?tab=' + tabId;
    await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 1000 }), panelUrl);
    const panel = await (await browser.waitForTarget((t) => t.url() === panelUrl)).page();
    await panel.setViewport({ width: 400, height: 1100 });
    await panel.waitForSelector('#pick:not([disabled])');
    const measure = () => page.$eval('span.owner', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const pickOwner = async () => {
      await panel.click('#pick');
      await sleep(200);
      const box = await measure();
      await page.mouse.move(box.x, box.y);
      await page.mouse.click(box.x, box.y);
      await panel.waitForFunction(() => document.querySelector('#composer .tk') && !document.getElementById('tokenCard').hidden, { timeout: 5000 });
    };
    const chooseOption = (prefix) =>
      panel.evaluate((prefix) => {
        for (const s of document.querySelectorAll('#tokenCard select')) {
          const o = [...s.options].find((o) => o.textContent.startsWith(prefix));
          if (o) {
            s.value = o.value;
            s.dispatchEvent(new Event('change'));
            return true;
          }
        }
        return false;
      }, prefix);

    // 1. pick text on the page -> chip, card opens; 2. fall back to ?env
    await pickOwner();
    assert.ok(await chooseOption('用网址里的参数 env'), 'fallback option exists');
    await sleep(300);
    // 3. type literal text after the chip; 4. insert a piece of the URL
    await panel.click('#tokenCard .btns .primary');
    await panel.focus('#composer');
    await panel.evaluate(() => { const c = document.getElementById('composer'); const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await panel.keyboard.type(' @ ');
    await panel.click('#fromUrl');
    await panel.evaluate(() => [...document.querySelectorAll('#urlPieces .p')].find((p) => p.textContent === 'app').click());
    await panel.waitForFunction(() => document.getElementById('pvTitle').textContent === 'Alice @ app');
    const summary = await panel.$eval('#summary', (e) => e.textContent);
    assert.match(summary, /以后打开 127\.0\.0\.1:\d+ 的所有页面，标签会显示成 「Alice @ app」/);
    assert.match(summary, /页面上的文字取不到时，用网址里的参数 env/);
    await panel.click('#save');
    await waitFor(async () => (await page.title()) === 'Alice @ app', 'rule saved from the panel');
    const first = (await sw.evaluate(() => TabStore.loadRulesText())).split('\n')[0];
    assert.match(first, /^\*:\/\/127\.0\.0\.1:\d+\/\* => \{page "span\.owner" or \?env\} @ \{path\[1\]\}$/);
    console.log('ok  panel: page text + typed text + URL piece composed, saved as:', first);

    await page.evaluate(() => document.querySelector('span.owner').remove());
    await waitFor(async () => (await page.title()) === 'qa @ app', 'per-piece fallback to ?env');
    await panel.waitForFunction(() => document.querySelector('#composer .tk.fb'));
    console.log('ok  page text gone -> that piece falls back to the URL, chip turns amber');

    await panel.reload();
    await panel.waitForFunction(() => document.querySelectorAll('#composer .tk').length === 2 && document.getElementById('save').textContent === '更新规则');
    console.log('ok  reopening the panel loads the controlling rule back for editing');

    if (process.env.SHOTS) {
      await setRules((await sw.evaluate(() => TabStore.DEFAULT_RULES)) + '\n/browse\\/(?<key>[A-Z]+-\\d+)/ => {<key>} {title replace / - Jira$/ ""} ; icon=🐞');
      const opt = await browser.newPage();
      await opt.setViewport({ width: 1000, height: 1300 });
      await page.goto(base + '/app?id=3&env=sandbox01.baidu.com&x=1');
      await opt.goto('chrome-extension://' + extId + '/src/options.html');
      await sleep(500);
      await opt.screenshot({ path: path.join(process.env.SHOTS, 'options.png') });
      await setRules('# empty');
      await sleep(1500); // let the late <h1> render
      await panel.reload();
      await panel.waitForSelector('#pick:not([disabled])');
      await pickOwner();
      await chooseOption('用网址里的参数 env');
      await sleep(300);
      await panel.evaluate(() => { const c = document.getElementById('composer'); const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await panel.keyboard.type(' · ');
      await panel.evaluate(() => document.getElementById('addTitle').click());
      await sleep(200);
      await panel.evaluate(() => document.querySelector('#composer .tk').click());
      await panel.evaluate(() => [...document.querySelectorAll('#colors button')].find((b) => b.title === '自动配色')?.click());
      await panel.evaluate(() => (document.getElementById('iconBox').open = true));
      await sleep(800);
      await panel.screenshot({ path: path.join(process.env.SHOTS, 'panel.png'), fullPage: true });
    }
    console.log('e2e passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
