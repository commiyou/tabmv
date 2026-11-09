/* Side panel: build a rule by choosing sources instead of writing syntax.
 * The panel keeps a small model and turns it into one rule line, so anything
 * made here can still be edited as text on the rules page. */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const testTab = Number(new URLSearchParams(location.search).get('tab')) || null;

  const COLORS = [['', '无'], ['auto', '自动'], ['#d93025'], ['#f29900'], ['#f9ab00'], ['#188038'], ['#1a73e8'], ['#9334e6'], ['#5f6368']];
  const ICONS = [['', '原图标'], ['letter', '首字'], ['⭐'], ['🐞'], ['🚀'], ['📝'], ['🔥'], ['🧪'], ['🏠']];
  const FORMATS = [['only', '只显示它'], ['dot', '它 · 原标题'], ['bracket', '[它] 原标题']];
  const SEPS = ['.', '-', '_', '/', ':', '·', '(', '（', ',', '，', '—'];
  const KIND = {
    text: '✏️ 自己写',
    page: '👆 页面上的文字',
    q: '🔗 网址参数',
    host: '🌐 域名',
    path: '🛣️ 网址路径',
    title: '📄 原标题',
  };

  let tab = null; // chrome.tabs.Tab
  let st = null; // state reported by the content script, null if not injectable
  let model = null;
  let manualText = null; // set when the user edits the rule text directly
  let picking = false;
  let preview = null;

  const pageUrl = () => (st && st.url) || (tab && tab.url) || '';
  const urlInfo = () => {
    try {
      const u = new URL(pageUrl());
      return { host: u.host, path: u.pathname };
    } catch (_) {
      return { host: '', path: '' };
    }
  };
  const globEsc = (s) => s.replace(/[*?[\]{}()\\]/g, '\\$&');
  const quote = (s) => '"' + s.replace(/"/g, '\\"') + '"';

  function newModel() {
    return { sources: [{ kind: 'text', value: '' }], format: 'only', icon: '', color: '', scope: 'host', pattern: TabRules.suggestPatterns(pageUrl())[0] || '' };
  }

  // ---------- model -> rule ----------
  function altFor(s) {
    const cut = s.cut ? '|before:' + s.cut : '';
    switch (s.kind) {
      case 'text':
        return s.value.trim() ? quote(s.value.trim()) : null;
      case 'page':
        return 'sel:' + quote(s.selector) + cut;
      case 'q':
        return 'q.' + s.key + cut;
      default:
        return s.kind + cut;
    }
  }

  function templateFor(m) {
    const alts = m.sources.map(altFor).filter(Boolean);
    if (!alts.length) return '';
    const core = '${' + alts.join(' || ') + '}';
    if (m.format === 'dot') return core + ' · $title';
    if (m.format === 'bracket') return '[' + core + '] $title';
    return core;
  }

  function patternFor(m) {
    const { host, path } = urlInfo();
    if (m.scope === 'host') return '*://' + host + '/*';
    if (m.scope === 'path') return '*://' + host + globEsc(path) + '*';
    if (m.scope.startsWith('param:')) return '*[?&#]' + globEsc(m.scope.slice(6)) + '=*';
    return m.pattern;
  }

  const isTabOnly = () => manualText === null && model.scope === 'tab';
  const ruleLine = () => manualText ?? TabRules.formatRule({ pattern: patternFor(model), title: templateFor(model), icon: model.icon, color: model.color });
  const override = () => ({ title: templateFor(model), icon: model.icon, color: model.color, model });

  // ---------- model -> plain words ----------
  function sourceWords(s) {
    const cut = s.cut ? '（只要「' + s.cut + '」前面的部分）' : '';
    switch (s.kind) {
      case 'text':
        return '「' + s.value.trim() + '」';
      case 'page':
        return '页面上「' + (s.sample || s.selector).slice(0, 20) + '」那段文字' + cut;
      case 'q':
        return '网址里 ' + s.key + ' 的值' + cut;
      case 'host':
        return '域名' + cut;
      case 'path':
        return '网址路径' + cut;
      case 'title':
        return '原标题' + cut;
    }
    return '';
  }

  function summary() {
    if (manualText !== null) return '使用你手动写的规则：' + manualText;
    const used = model.sources.filter((s) => altFor(s));
    if (!used.length) return '还没选标签要显示什么。可以自己写一个名字，或者从页面上点选一段文字。';
    let what = used.map(sourceWords).join('，没有就用');
    if (used[used.length - 1].kind !== 'title') what += '，都没有就保持原标题';
    if (model.format === 'dot') what += '，后面接原标题';
    if (model.format === 'bracket') what += '，放在方括号里，后面接原标题';
    let deco = '';
    if (model.icon === 'letter') deco += '，图标换成标题的第一个字';
    else if (model.icon) deco += '，图标换成 ' + model.icon;
    if (model.color === 'auto') deco += '，' + (model.icon ? '底色' : '图标角上加一个色点') + '按内容自动配色';
    else if (model.color) deco += '，' + (model.icon ? '底色' : '图标角上加一个色点');
    const { host, path } = urlInfo();
    const where = {
      tab: '只对这个标签生效（关掉就没了）',
      host: '以后打开 ' + host + ' 的任何页面',
      path: '以后打开 ' + host + path + ' 开头的页面',
      custom: '以后打开符合 ' + model.pattern + ' 的页面',
    }[model.scope] || '以后打开网址里带 ' + model.scope.slice(6) + '= 的页面';
    return where + '，标签显示' + what + deco + '。';
  }

  // ---------- talking to the page ----------
  const sendTab = (msg) => (tab ? chrome.tabs.sendMessage(tab.id, msg).catch(() => null) : Promise.resolve(null));

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 120);
  };

  async function refreshPreview() {
    const tabOnly = isTabOnly();
    $('ruleText').value = manualText ?? (tabOnly ? templateFor(model) : ruleLine());
    $('summary').textContent = summary();
    let r;
    if (st) r = await sendTab(tabOnly ? { type: 'preview', override: override() } : { type: 'preview', line: ruleLine() });
    else {
      try {
        const rule = tabOnly ? TabRules.compileOverride(override()) : TabRules.compileRule(ruleLine());
        const m = rule.re ? rule.re.exec(pageUrl()) : [pageUrl()];
        r = m ? { ok: true, matched: true, ...TabRules.renderRule(rule, { url: pageUrl(), title: tab ? tab.title : '' }, m) } : { ok: true, matched: false };
      } catch (e) {
        r = { ok: false, error: e.message };
      }
    }
    preview = r;
    const base = st ? st.pageTitle : tab ? tab.title : '';
    $('pvTitle').textContent = r && r.ok && r.matched ? r.title ?? base : base;
    $('pvIcon').src = (r && r.iconHref) || (tab && tab.favIconUrl) || 'data:,';
    const check = $('scopeCheck');
    if (!r || !r.ok) {
      check.className = 'sub err';
      check.textContent = r ? '规则有问题：' + r.error : '';
    } else if (!r.matched) {
      check.className = 'sub err';
      check.textContent = '⚠ 当前页面不在这个范围内，保存后这个标签不会变。';
    } else {
      check.className = 'sub ok';
      check.textContent = tabOnly ? '' : '✓ 当前页面在范围内';
    }
    await refreshSourceValues(r);
  }

  // Show what each source gives on this page right now, and which one wins.
  async function refreshSourceValues(r) {
    const used = r && r.ok && r.trace && r.trace[0] ? r.trace[0].used : -1;
    let altIndex = -1;
    const items = [...$('sources').children];
    for (let i = 0; i < model.sources.length; i++) {
      const s = model.sources[i];
      const li = items[i];
      if (!li) continue;
      const alt = altFor(s);
      if (alt) altIndex++;
      const raw = { ...s, cut: '' };
      let value = '';
      const tpl = altFor(raw) ? '${' + altFor(raw) + '}' : '';
      if (tpl) {
        if (st) {
          const v = await sendTab({ type: 'preview', override: { title: tpl } });
          value = (v && v.title) || '';
        } else if (s.kind !== 'page') {
          try {
            value = TabRules.renderRule(TabRules.compileOverride({ title: tpl }), { url: pageUrl(), title: tab ? tab.title : '' }).title || '';
          } catch (_) {}
        }
      }
      const val = li.querySelector('.val');
      if (val) {
        const shown = s.cut && value.includes(s.cut) ? value.slice(0, value.indexOf(s.cut)) : value;
        val.textContent = shown ? '「' + shown + '」' : s.kind === 'page' ? '暂时取不到（可能还没加载出来）' : '这个页面上没有';
        val.classList.toggle('empty', !shown);
      }
      const sel = li.querySelector('select');
      if (sel && document.activeElement !== sel) fillCut(sel, s, value);
      li.querySelector('.used').textContent = alt && altIndex === used ? '✓ 现在用的是这个' : '';
    }
  }

  function fillCut(sel, s, value) {
    const seps = SEPS.filter((c) => value.includes(c) || c === s.cut);
    sel.hidden = !seps.length;
    sel.textContent = '';
    sel.append(el('option', { value: '', textContent: '用完整的值' }));
    for (const c of seps) sel.append(el('option', { value: c, textContent: '只要「' + c + '」前面的部分', selected: s.cut === c }));
  }

  // ---------- rendering ----------
  function renderSources() {
    const ol = $('sources');
    ol.textContent = '';
    model.sources.forEach((s, i) => {
      const ops = el('span', { className: 'ops' });
      if (i > 0) ops.append(el('button', { textContent: '↑', title: '优先用这个', onclick: () => (model.sources.splice(i - 1, 0, ...model.sources.splice(i, 1)), changed(true)) }));
      ops.append(el('button', { textContent: '✕', title: '去掉', onclick: () => (model.sources.splice(i, 1), changed(true)) }));
      const li = el('li', {}, el('span', { className: 'name', textContent: KIND[s.kind] + (s.kind === 'q' ? ' ' + s.key : '') }), ops);
      if (s.kind === 'text') {
        const inp = el('input', { type: 'text', value: s.value, placeholder: '比如：测试环境 3 号' });
        inp.addEventListener('input', () => ((s.value = inp.value), changed()));
        li.append(inp);
        if (!s.value && i === 0) setTimeout(() => inp.focus(), 0);
      } else {
        li.append(el('div', { className: 'val empty', textContent: '…' }));
        if (s.kind === 'page') li.append(el('div', { className: 'detail', textContent: s.selector, title: '用来在页面上找到这段文字的 CSS 选择器' }));
        const sel = el('select', { hidden: true });
        sel.addEventListener('change', () => ((s.cut = sel.value), changed()));
        li.append(sel);
      }
      li.append(el('div', { className: 'used' }));
      ol.append(li);
    });
    if (!model.sources.length) ol.append(el('li', { className: 'hint', textContent: '还没选。点下面的按钮添加。' }));
  }

  function renderUrlChips() {
    const box = $('urlChips');
    box.textContent = '';
    const add = (src, label, hint) =>
      box.append(el('button', { className: 'chip', textContent: label, title: hint || '', onclick: () => (model.sources.push(src), changed(true)) }));
    const keys = TabRules.queryKeys(pageUrl());
    if (keys.length || urlInfo().host) box.append(el('span', { className: 'sub', textContent: '网址里的：' }));
    for (const [k, v] of keys) add({ kind: 'q', key: k, cut: '' }, k + ' = ' + v, v);
    if (urlInfo().host) add({ kind: 'host', cut: '' }, '域名', urlInfo().host);
    if (urlInfo().path.length > 1) add({ kind: 'path', cut: '' }, '路径', urlInfo().path);
  }

  function renderChoices() {
    $('formats').textContent = '';
    for (const [v, label] of FORMATS)
      $('formats').append(el('button', { textContent: label, className: model.format === v ? 'on' : '', onclick: () => ((model.format = v), changed(true)) }));

    $('colors').textContent = '';
    for (const [v, label] of COLORS) {
      const b = el('button', { className: model.color === v ? 'on' : '', title: label || v, onclick: () => ((model.color = v), changed(true)) });
      if (label) b.append(el('span', { className: 'txt', textContent: label }));
      else b.append(el('span', { className: 'dot', style: 'background:' + v }));
      $('colors').append(b);
    }
    $('icons').textContent = '';
    for (const [v, label] of ICONS) {
      const b = el('button', { className: model.icon === v ? 'on' : '', title: label || v, onclick: () => ((model.icon = v), ($('iconCustom').value = ''), changed(true)) });
      b.append(label ? el('span', { className: 'txt', textContent: label }) : v);
      $('icons').append(b);
    }
    if (!ICONS.some(([v]) => v === model.icon)) $('iconCustom').value = model.icon;

    const { host, path } = urlInfo();
    const scopes = [['tab', '只这个标签', '关掉标签就失效，不影响别的页面']];
    if (host) scopes.push(['host', host + ' 的所有页面', '最常用']);
    if (path.length > 1) scopes.push(['path', host + path + ' 开头的页面', '']);
    const params = new Set([...model.sources.filter((s) => s.kind === 'q').map((s) => s.key)]);
    for (const k of params) scopes.push(['param:' + k, '网址里带 ' + k + '= 的页面', '不管是哪个域名']);
    scopes.push(['custom', '自己写匹配规则', 'glob 如 *://*.baidu.com/*，或 /正则/']);
    if (!scopes.some(([v]) => v === model.scope)) model.scope = host ? 'host' : 'tab';
    $('scopes').textContent = '';
    for (const [v, label, hint] of scopes) {
      const r = el('input', { type: 'radio', name: 'scope', value: v, checked: model.scope === v });
      r.addEventListener('change', () => ((model.scope = v), changed(true)));
      $('scopes').append(el('label', {}, r, el('span', {}, label, hint ? el('small', { textContent: '  ' + hint }) : null)));
    }
    $('customPattern').hidden = model.scope !== 'custom';
    $('customPattern').value = model.pattern;
  }

  function renderNow() {
    const now = $('now');
    now.textContent = '';
    $('blocked').hidden = Boolean(st) || !tab;
    $('pick').disabled = !st;
    if (!st) return;
    if (st.manual) {
      now.append('这个标签是手动改过的', el('button', { textContent: '清除', onclick: () => reset() }));
    } else if (st.lineNo) {
      now.append('原标题「' + st.pageTitle + '」，现在由第 ' + st.lineNo + ' 条规则控制', el('button', { textContent: '暂停这条', onclick: () => pauseRule() }));
    } else {
      now.append('原标题「' + st.pageTitle + '」，还没有规则');
    }
    const canReplace = Boolean(st.lineNo) && !st.manual;
    $('replaceRow').hidden = !canReplace || isTabOnly();
    $('replaceText').textContent = '替换现在生效的那条规则（第 ' + st.lineNo + ' 行；不勾就新加一条，放在最前面）';
  }

  function renderAll() {
    renderNow();
    renderSources();
    renderUrlChips();
    renderChoices();
    $('advNote').textContent = manualText === null ? '可以直接改这段文字，语法见规则页。' : '已手动修改，上面的选项不再生效。';
    if (manualText !== null) $('advNote').append(' ', el('button', { textContent: '撤销修改', onclick: () => ((manualText = null), changed(true)) }));
    schedule();
  }

  function changed(structural) {
    $('msg').textContent = '';
    if (structural) renderAll();
    else {
      renderNow();
      schedule();
    }
  }

  // ---------- actions ----------
  function flash(text, cls) {
    $('msg').className = cls || 'ok';
    $('msg').textContent = text;
  }

  async function save() {
    try {
      if (isTabOnly()) {
        TabRules.compileOverride(override());
        await chrome.runtime.sendMessage({ type: 'setOverride', tabId: tab.id, override: override() });
        flash('改好了，只对这个标签有效');
      } else {
        const line = ruleLine();
        TabRules.compileRule(line);
        const lines = (await TabStore.loadRulesText()).split('\n');
        const replace = !$('replaceRow').hidden && $('replace').checked && st && st.lineNo && (lines[st.lineNo - 1] || '').trim() === st.ruleLine;
        if (replace) lines[st.lineNo - 1] = line;
        else lines.unshift(line);
        await TabStore.saveRulesText(lines.join('\n'));
        if (st && st.manual) await chrome.runtime.sendMessage({ type: 'clearOverride', tabId: tab.id });
        flash(replace ? '已更新这条规则' : '已保存，符合范围的标签都会变');
      }
    } catch (e) {
      return flash(e.message, 'err');
    }
    setTimeout(reloadState, 400);
  }

  async function reset() {
    if (!tab) return;
    await chrome.runtime.sendMessage({ type: 'clearOverride', tabId: tab.id });
    flash(st && st.lineNo && !st.manual ? '这个标签由规则控制，可以点上面的「暂停这条」' : '已恢复');
    setTimeout(reloadState, 300);
  }

  // Pausing comments the line out, so it can be turned back on in the rules page.
  async function pauseRule() {
    const lines = (await TabStore.loadRulesText()).split('\n');
    const i = st.lineNo - 1;
    if ((lines[i] || '').trim() !== st.ruleLine) return flash('规则刚被改过，请在规则页操作', 'err');
    lines[i] = '# ' + lines[i];
    await TabStore.saveRulesText(lines.join('\n'));
    flash('已暂停，去规则页删掉行首的 # 就能恢复');
    setTimeout(reloadState, 400);
  }

  function setPicking(on) {
    picking = on;
    $('pick').classList.toggle('picking', on);
    $('pick').textContent = on ? '✋ 取消点选（在页面上点一下文字）' : '👆 从页面上点选文字';
  }

  $('pick').addEventListener('click', () => {
    if (picking) {
      sendTab({ type: 'stopPick' });
      return setPicking(false);
    }
    setPicking(true);
    sendTab({ type: 'pick' });
  });
  $('addText').addEventListener('click', () => (model.sources.unshift({ kind: 'text', value: '' }), changed(true)));
  $('addTitle').addEventListener('click', () => (model.sources.push({ kind: 'title', cut: '' }), changed(true)));
  $('iconCustom').addEventListener('input', () => ((model.icon = $('iconCustom').value.trim()), renderChoices(), schedule()));
  $('customPattern').addEventListener('input', () => ((model.pattern = $('customPattern').value), schedule()));
  $('ruleText').addEventListener('input', () => {
    if (manualText === null) {
      manualText = $('ruleText').value;
      return changed(true);
    }
    manualText = $('ruleText').value;
    schedule();
  });
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', reset);
  $('openOptions').addEventListener('click', (e) => (e.preventDefault(), chrome.runtime.openOptionsPage()));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type !== 'picked' || !tab || !sender.tab || sender.tab.id !== tab.id) return;
    setPicking(false);
    if (msg.cancelled) return;
    const src = { kind: 'page', selector: msg.selector, sample: msg.text, cut: '' };
    const blank = model.sources.findIndex((s) => s.kind === 'text' && !s.value.trim());
    if (blank >= 0) model.sources.splice(blank, 1, src);
    else model.sources.unshift(src);
    changed(true);
    if (msg.count > 1) flash('页面上有 ' + msg.count + ' 处一样的位置，会用第一处', 'muted');
  });

  // ---------- following the active tab ----------
  async function reloadState() {
    if (!tab) return;
    tab = await chrome.tabs.get(tab.id).catch(() => null);
    st = await sendTab({ type: 'getState' });
    renderNow();
    schedule();
  }

  async function loadTab(id) {
    if (picking) sendTab({ type: 'stopPick' });
    setPicking(false);
    tab = await chrome.tabs.get(id).catch(() => null);
    st = await sendTab({ type: 'getState' });
    model = st && st.override && st.override.model ? structuredClone(st.override.model) : newModel();
    manualText = null;
    $('msg').textContent = '';
    renderAll();
  }

  if (testTab) await loadTab(testTab);
  else {
    const win = await chrome.windows.getCurrent();
    const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (active) await loadTab(active.id);
    chrome.tabs.onActivated.addListener((info) => info.windowId === win.id && loadTab(info.tabId));
  }
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (!tab || id !== tab.id) return;
    if (info.url && new URL(info.url).host !== urlInfo().host) loadTab(id);
    else if (info.url || info.status === 'complete' || info.title) reloadState();
  });
})();
