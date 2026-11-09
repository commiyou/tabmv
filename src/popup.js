(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state = await chrome.tabs
    .sendMessage(tab.id, { type: 'getState' })
    .catch(() => null);
  const page = { url: (state && state.url) || tab.url || '', title: state ? state.pageTitle : tab.title || '' };
  const ovKey = 'ov:' + tab.id;
  const ov = (await chrome.storage.session.get(ovKey))[ovKey];

  $('url').textContent = page.url;
  if (!state) $('status').innerHTML = '<span class="err">此页面不能注入脚本（chrome:// 或扩展商店等），只能编辑规则。</span>';
  else if (state.manual) $('status').textContent = '当前：手动重命名（优先于规则）';
  else if (state.lineNo) $('status').textContent = '当前命中规则第 ' + state.lineNo + ' 行：' + state.ruleLine;
  else $('status').textContent = '当前没有命中规则';

  $('title').placeholder = page.title || '新标题';
  if (ov) for (const k of ['title', 'icon', 'color']) $(k).value = ov[k] || '';

  function insertAtCursor(el, text) {
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.focus();
    el.setSelectionRange(s + text.length, s + text.length);
    update();
  }

  function chip(container, label, hint, onClick) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.title = hint || label;
    b.addEventListener('click', onClick);
    container.appendChild(b);
  }

  chip($('qchips'), '$title', page.title, () => insertAtCursor($('title'), '$title'));
  chip($('qchips'), '$host', '', () => insertAtCursor($('title'), '$host'));
  let host = '';
  try {
    host = new URL(page.url).host;
  } catch (_) {}
  for (const [k, v] of TabRules.queryKeys(page.url)) {
    chip($('qchips'), '${q.' + k + '} = ' + v, v, () => insertAtCursor($('title'), '${q.' + k + '}'));
  }

  const patterns = TabRules.suggestPatterns(page.url);
  for (const [k] of TabRules.queryKeys(page.url).slice(0, 4)) {
    patterns.push('*://' + host + '/*[?&#]' + k.replace(/[*?[\]{}()\\]/g, '\\$&') + '=*');
  }
  for (const p of patterns) chip($('pchips'), p, '', () => (($('pattern').value = p), update()));
  $('pattern').value = patterns[0] || '';

  const fields = () => ({ title: $('title').value, icon: $('icon').value, color: $('color').value });

  function update() {
    const pv = $('preview');
    const f = fields();
    try {
      const rule = TabRules.compileRule(TabRules.formatRule({ pattern: $('pattern').value, ...f }));
      const subject = rule.field === 'title' ? page.title : page.url;
      const m = rule.re.exec(subject);
      if (!m) {
        pv.innerHTML = '<span class="err">pattern 不匹配当前页面</span>';
        return;
      }
      const r = TabRules.renderRule(rule, page, m);
      const caps = m.length > 1 ? '  捕获: ' + m.slice(1).map((x, i) => '$' + (i + 1) + '=' + JSON.stringify(x)).join(' ') : '';
      pv.textContent = '→ ' + (r.title ?? page.title) + (r.icon ? '  icon=' + r.icon : '') + (r.color ? '  color=' + r.color : '') + caps;
    } catch (e) {
      pv.innerHTML = '';
      const s = document.createElement('span');
      s.className = 'err';
      s.textContent = e.message;
      pv.appendChild(s);
    }
  }
  for (const id of ['title', 'icon', 'color', 'pattern']) $(id).addEventListener('input', update);
  $('picker').addEventListener('input', () => (($('color').value = $('picker').value), update()));
  update();

  function flash(text, cls) {
    $('msg').className = cls || 'ok';
    $('msg').textContent = text;
  }

  async function applyTab() {
    const f = fields();
    if (!f.title.trim() && !f.icon.trim() && !f.color.trim()) return resetTab();
    try {
      TabRules.compileOverride(f);
    } catch (e) {
      return flash(e.message, 'err');
    }
    await chrome.runtime.sendMessage({ type: 'setOverride', tabId: tab.id, override: f });
    window.close();
  }

  async function resetTab() {
    await chrome.runtime.sendMessage({ type: 'clearOverride', tabId: tab.id });
    window.close();
  }

  async function saveRule() {
    const line = TabRules.formatRule({ pattern: $('pattern').value, ...fields() });
    try {
      TabRules.compileRule(line);
    } catch (e) {
      return flash(e.message, 'err');
    }
    const text = await TabStore.loadRulesText();
    // First match wins, so a rule saved from a concrete page goes on top.
    await TabStore.saveRulesText(line + '\n' + text);
    await chrome.runtime.sendMessage({ type: 'clearOverride', tabId: tab.id });
    flash('已保存到第 1 行');
  }

  $('applyTab').addEventListener('click', applyTab);
  $('resetTab').addEventListener('click', resetTab);
  $('saveRule').addEventListener('click', saveRule);
  $('openOptions').addEventListener('click', (e) => (e.preventDefault(), chrome.runtime.openOptionsPage()));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) saveRule();
    else applyTab();
  });
})();
