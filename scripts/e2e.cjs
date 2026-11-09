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

// Stands in for a page (or a stale copy of our own content script) that
// insists on its own title.
const FIGHT = `<!doctype html><html><head><title>Theirs</title></head><body><h1 class="env">Env One</h1><script>
  new MutationObserver(() => { if (document.title !== 'Theirs') document.title = 'Theirs'; })
    .observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
</script></body></html>`;

// UI text depends on the browser language; read the same messages.json the
// extension uses so the assertions work in any locale.
let MSG = {};
const M = (key, ...subs) => (MSG[key] ? MSG[key].message : key).replace(/\$(\d)/g, (_, n) => String(subs[n - 1]));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    res.writeHead(200, { 'content-type': 'text/html' }).end(req.url.startsWith('/fight') ? FIGHT : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME,
    headless: process.env.HEADFUL ? false : 'new',
    // Linux Chrome takes its UI language from the environment rather than --lang.
    env: process.env.E2E_LANG ? { ...process.env, LANGUAGE: process.env.E2E_LANG.replace('-', '_'), LANG: process.env.E2E_LANG.replace('-', '_') + '.UTF-8' } : process.env,
    args: [
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      '--no-first-run',
      ...(process.env.CI ? ['--no-sandbox'] : []),
      // E2E_LANG=zh-CN runs the UI in Chinese (--lang on Linux/Windows, AppleLanguages on macOS)
      ...(process.env.E2E_LANG ? ['--lang=' + process.env.E2E_LANG, ...(process.platform === 'darwin' ? ['-AppleLanguages', '(' + process.env.E2E_LANG + ')'] : [])] : []),
    ],
  });
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
    const sw = await swTarget.worker();
    const lang = await sw.evaluate(() => chrome.i18n.getUILanguage());
    MSG = JSON.parse(require('node:fs').readFileSync(path.join(EXT, '_locales', /^zh/i.test(lang) ? 'zh_CN' : 'en', 'messages.json'), 'utf8'));
    console.log('UI language:', lang);
    if (process.env.E2E_LANG) assert.equal(lang.slice(0, 2), process.env.E2E_LANG.slice(0, 2), 'browser did not switch UI language');
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

    const extId = new URL(swTarget.url()).host;
    const opt = await browser.newPage();
    await opt.goto('chrome-extension://' + extId + '/src/options.html');
    await opt.waitForSelector('#rules');
    await opt.evaluate(() => { const t = document.getElementById('rules'); t.value = '*://127.0.0.1*/* => From options {?env}'; t.dispatchEvent(new Event('input')); });
    await opt.click('#save');
    await waitFor(async () => (await page.title()) === 'From options qa', 'options page save applies to open tabs');
    // The open tab can update before the rules page has finished reading the text back.
    await opt.waitForFunction(() => document.getElementById('msg').textContent !== '');
    assert.match(await opt.$eval('#msg', (e) => e.textContent), new RegExp(esc(M('o_saved', 'X', 1)).replace('X', '.*')));
    await opt.close();
    console.log('ok  rules page: Save writes the rules and open tabs update');

    // A second copy of the content script (what an extension reload leaves
    // behind) must take over instead of fighting the first one.
    await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/rules.js', 'src/store.js', 'src/picker.js', 'src/content.js'] }), tabId);
    await setRules('*://127.0.0.1*/* => Second {?env}');
    await waitFor(async () => (await page.title()) === 'Second qa', 'title after re-injection');
    const titleWrites = (p) =>
      Promise.race([
        p.evaluate(() => new Promise((r) => { let n = 0; const mo = new MutationObserver(() => n++); mo.observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true }); setTimeout(() => (mo.disconnect(), r(n)), 1000); })),
        sleep(4000).then(() => 'FROZEN'),
      ]);
    assert.equal(await titleWrites(page), 0, 'no title fight after re-injection');
    console.log('ok  re-injected content script takes over, no title fight');

    // An empty page piece leaves "Mine " with a trailing space; the browser
    // reports "Mine", and that mismatch used to loop forever.
    await setRules('*://127.0.0.1*/* => Mine {page ".env"}');
    await waitFor(async () => (await page.title()) === 'Mine', 'empty page piece');
    await sleep(300);
    assert.equal(await titleWrites(page), 0, 'no rewrite loop on whitespace');
    console.log('ok  empty page piece: title is stable, no rewrite loop');
    const fight = await browser.newPage();
    await fight.goto(base + '/fight');
    await sleep(1500);
    const alive = await Promise.race([fight.evaluate(() => document.title), sleep(3000).then(() => 'FROZEN')]);
    assert.notEqual(alive, 'FROZEN', 'page that resets its title stays responsive');
    await fight.close();
    console.log('ok  page that keeps resetting its title stays responsive (we back off)');
    await setRules('# nothing');
    await waitFor(async () => (await page.title()) === 'Changed by page', 'rules cleared again');

    // Side panel flow: pick an element on the page, save as a site rule.
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
    const fbEnv = M('fb_url', M('url_param', 'env'), 'qa').replace(/[（(]qa[)）]$/, '');
    assert.ok(await chooseOption(fbEnv), 'fallback option exists');
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
    const host = new URL(base).host;
    assert.ok(summary.includes(M('sum_rule_shows', M('sum_where_site', host)) + M('sum_quote', 'Alice @ app')), summary);
    assert.ok(summary.includes(M('note_fallback', M('src_page'), M('src_url', M('url_param', 'env')))), summary);
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
    await panel.waitForFunction((label) => document.querySelectorAll('#composer .tk').length === 2 && document.getElementById('save').textContent === label, {}, M('btn_update'));
    console.log('ok  reopening the panel loads the controlling rule back for editing');

    if (process.env.SHOTS) {
      // Screenshots for the docs and the store listing, one set per UI language.
      const fs = require('node:fs');
      fs.mkdirSync(process.env.SHOTS, { recursive: true });
      const suffix = /^zh/i.test(lang) ? '.zh-CN' : '';
      const shot = (p, name, opts = {}) => p.screenshot({ path: path.join(process.env.SHOTS, name + suffix + '.png'), ...opts });
      const toEnd = () => panel.evaluate(() => { const c = document.getElementById('composer'); const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });

      await setRules((await sw.evaluate(() => TabStore.DEFAULT_RULES)) + '\n*[?&]env=(*).baidu.com* => {1} ; color=auto\n/browse\\/(?<key>[A-Z]+-\\d+)/ => {<key>} {title replace / - Jira$/ ""} ; icon=🐞');
      const opt = await browser.newPage();
      await opt.setViewport({ width: 1100, height: 1400 });
      await page.goto(base + '/app?id=3&env=sandbox01.baidu.com&x=1');
      await opt.goto('chrome-extension://' + extId + '/src/options.html');
      await sleep(600);
      await shot(opt, 'options');
      await opt.close();

      await setRules('# empty');
      await sleep(1500); // let the late <h1> render
      await panel.reload();
      await panel.waitForSelector('#pick:not([disabled])');
      await shot(panel, 'step1-empty', { fullPage: true });
      await panel.focus('#composer');
      await panel.keyboard.type('Demo ');
      await sleep(400);
      await shot(panel, 'step1-typed', { fullPage: true });

      await panel.click('#fromUrl');
      await sleep(300);
      await shot(panel, 'step2-url', { fullPage: true });
      await panel.evaluate(() => [...document.querySelectorAll('#urlPieces .p')].find((p) => p.textContent.startsWith('sandbox01')).click());
      await sleep(400);
      await panel.evaluate((label) => { const s = [...document.querySelectorAll('#tokenCard select')].find((s) => [...s.options].some((o) => o.textContent === label)); const o = [...s.options].find((o) => o.textContent === label); s.value = o.value; s.dispatchEvent(new Event('change')); }, M('cut_before', M('sep_quote', '.')));
      await sleep(500);
      await shot(panel, 'step2-cut', { fullPage: true });
      await panel.click('#tokenCard .btns .primary');

      await toEnd();
      await panel.keyboard.type(' · ');
      await pickOwner();
      await chooseOption(fbEnv);
      await sleep(500);
      await shot(panel, 'step3-page', { fullPage: true });
      await panel.click('#tokenCard .btns .primary');

      await panel.evaluate((M_auto) => [...document.querySelectorAll('#colors button')].find((b) => b.title === M_auto)?.click(), M('color_auto'));
      await panel.evaluate(() => (document.getElementById('iconBox').open = true));
      await sleep(800);
      await shot(panel, 'panel', { fullPage: true });
      await panel.click('#save');
      await sleep(800);
      await panel.evaluate(() => (document.getElementById('adv').open = true));
      await sleep(300);
      await shot(panel, 'step5-saved', { fullPage: true });
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
