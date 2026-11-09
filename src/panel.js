/* Side panel. The tab name is composed in one field: plain text plus "pieces"
 * (page text, a piece of the URL, the original title). Each piece can be
 * trimmed and can fall back to something else when it is empty. The field is
 * saved as an ordinary rule line, and existing rules load back into it. */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const testTab = Number(new URLSearchParams(location.search).get('tab')) || null;

  const COLORS = [['', '无'], ['auto', '自动配色'], ['#d93025'], ['#f29900'], ['#f9ab00'], ['#188038'], ['#1a73e8'], ['#9334e6'], ['#5f6368']];
  const ICONS = [['', '原图标'], ['letter', '首字'], ['⭐'], ['🐞'], ['🚀'], ['📝'], ['🔥'], ['🧪'], ['🏠']];
  const SEPS = ['.', '-', '_', '/', ':', '·', ' ', '(', '（', ',', '，', '|', '—'];
  const sepName = (c) => (c === ' ' ? '空格' : '「' + c + '」');

  let tab = null; // chrome.tabs.Tab
  let st = null; // state from the content script; null when the page cannot be scripted
  let editing = null; // {kind:'rule', lineNo, line} | {kind:'tab'} | null (new)
  let scope = 'site';
  let customPattern = '';
  let icon = '';
  let color = '';
  let manualText = null; // rule text typed by hand in the advanced box
  let picking = null; // null | {mode:'insert'} | {mode:'replace', id}
  const tokens = new Map(); // chip id -> alts (compiled form, see rules.js)
  let nextId = 1;
  let openId = null; // chip whose card is open
  let savedRange = null;

  const pageUrl = () => (st && st.url) || (tab && tab.url) || '';
  const pageTitle = () => (st ? st.pageTitle : tab ? tab.title : '') || '';
  const U = () => {
    try {
      return new URL(pageUrl());
    } catch (_) {
      return null;
    }
  };
  const globEsc = (s) => s.replace(/[*?[\]{}()\\]/g, '\\$&');
  const sendTab = (msg) => (tab ? chrome.tabs.sendMessage(tab.id, msg).catch(() => null) : Promise.resolve(null));

  // ---------- pieces of the URL ----------
  function urlOptions() {
    const u = U();
    if (!u) return [];
    const out = [];
    const labels = u.hostname.split('.');
    labels.forEach((v, i) => out.push({ alt: { expr: 'host', index: i + 1 }, value: v, name: '域名第 ' + (i + 1) + ' 段' }));
    out.push({ alt: { expr: 'host' }, value: u.host, name: '整个域名' });
    u.pathname.split('/').filter(Boolean).forEach((v, i) => out.push({ alt: { expr: 'path', index: i + 1 }, value: decodeURIComponent(v), name: '路径第 ' + (i + 1) + ' 段' }));
    for (const [k, v] of TabRules.queryKeys(u.href)) out.push({ alt: { expr: 'q.' + k }, value: v, name: '参数 ' + k });
    return out;
  }
  const sameAlt = (a, b) => a.expr === b.expr && a.index === b.index;

  function describeAlt(a, withValue) {
    if (!a) return '';
    if (a.lit !== undefined) return '「' + a.lit + '」';
    if (a.sel !== undefined) return '页面上的文字';
    if (a.expr === 'title') return '原标题';
    const o = urlOptions().find((x) => sameAlt(x.alt, a));
    if (o) return '网址里的' + o.name + (withValue ? '（' + o.value + '）' : '');
    if (a.expr.startsWith('q.')) return '网址参数 ' + a.expr.slice(2);
    if (a.expr === 'host' || a.expr === 'path') return (a.expr === 'host' ? '域名' : '路径') + (a.index ? '第 ' + a.index + ' 段' : '');
    return '匹配到的第 ' + a.expr + ' 部分';
  }
  const iconOf = (a) => (a.sel !== undefined ? '👆' : a.expr === 'title' ? '📄' : a.lit !== undefined ? '✏️' : '🔗');

  // The trim option shown in the UI is the first before/after/match filter.
  const cutIndex = (a) => (a.filters || []).findIndex((f) => f.m || f.name === 'before' || f.name === 'after');
  function getCut(a) {
    const i = cutIndex(a);
    if (i < 0) return '';
    const f = a.filters[i];
    return f.m ? 'm:' + f.m.source : f.name + ':' + f.arg;
  }
  function setCut(a, v) {
    a.filters = a.filters || [];
    const i = cutIndex(a);
    if (i >= 0) a.filters.splice(i, 1);
    if (!v) return;
    const k = v.indexOf(':');
    const name = v.slice(0, k);
    const arg = v.slice(k + 1);
    let f;
    if (name === 'm') {
      try {
        f = { m: new RegExp(arg) };
      } catch (_) {
        return;
      }
    } else f = { name, arg };
    a.filters.unshift(f);
  }
  const rawAlt = (a) => ({ ...a, filters: [] });

  // ---------- composer <-> template ----------
  function chipFor(alts, id = nextId++) {
    tokens.set(id, alts);
    const c = el('span', { className: 'tk', contentEditable: 'false' }, el('span', { className: 'i', textContent: iconOf(alts[0]) }), el('span', { className: 'v', textContent: describeAlt(alts[0]) }));
    c.dataset.id = id;
    c.addEventListener('mousedown', (e) => e.preventDefault());
    c.addEventListener('click', () => openCard(id));
    return c;
  }

  function serialize() {
    let out = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += TabRules.escapeLiteral(c.textContent.replace(/[\u200b\n\r]/g, ''));
        else if (c.classList && c.classList.contains('tk')) out += TabRules.tokenText(tokens.get(Number(c.dataset.id)));
        else if (c.nodeName === 'BR') continue;
        else walk(c);
      }
    };
    walk($('composer'));
    return out;
  }

  function loadComposer(template) {
    const box = $('composer');
    box.textContent = '';
    tokens.clear();
    openId = null;
    let parts = [];
    try {
      parts = TabRules.compileTemplate(template || '');
    } catch (_) {
      parts = [template || ''];
    }
    for (const p of parts) box.append(typeof p === 'string' ? document.createTextNode(p) : chipFor(p.alts));
    if (box.lastChild && box.lastChild.nodeType !== 3) box.append('\u200b');
  }

  function insertChip(alts) {
    const box = $('composer');
    const chip = chipFor(alts);
    const after = document.createTextNode('\u200b');
    if (savedRange && box.contains(savedRange.startContainer)) {
      savedRange.deleteContents();
      savedRange.insertNode(after);
      savedRange.insertNode(chip);
    } else box.append(chip, after);
    const r = document.createRange();
    r.setStartAfter(after);
    r.collapse(true);
    savedRange = r;
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    changed();
    return Number(chip.dataset.id);
  }

  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    if (sel.rangeCount && $('composer').contains(sel.getRangeAt(0).startContainer)) savedRange = sel.getRangeAt(0).cloneRange();
  });
  $('composer').addEventListener('input', () => {
    for (const id of [...tokens.keys()]) if (!$('composer').querySelector('.tk[data-id="' + id + '"]')) tokens.delete(id);
    if (openId && !tokens.has(openId)) closeCard();
    changed();
  });
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) save(false);
    }
  });
  $('composer').addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '));
  });

  // ---------- current value of a piece on this page ----------
  async function valueOf(alts) {
    const r = st
      ? await sendTab({ type: 'preview', override: { title: TabRules.tokenText(alts) } })
      : (() => {
          try {
            return { ok: true, ...TabRules.renderRule(TabRules.compileOverride({ title: TabRules.tokenText(alts) }), { url: pageUrl(), title: pageTitle() }) };
          } catch (_) {
            return null;
          }
        })();
    return { value: (r && r.title) || '', used: r && r.trace && r.trace[0] ? r.trace[0].used : -1 };
  }

  // ---------- piece editor card ----------
  function openCard(id) {
    openId = id;
    for (const c of $('composer').querySelectorAll('.tk')) c.classList.toggle('on', Number(c.dataset.id) === id);
    $('urlPieces').hidden = true;
    $('fromUrl').classList.remove('on');
    renderCard();
  }

  function closeCard() {
    openId = null;
    $('tokenCard').hidden = true;
    for (const c of $('composer').querySelectorAll('.tk.on')) c.classList.remove('on');
  }

  function cutSelect(a, value) {
    const sel = el('select');
    const cur = getCut(a);
    const opts = [['', '用完整的内容']];
    for (const c of SEPS) {
      if (!value.includes(c) && cur !== 'before:' + c && cur !== 'after:' + c) continue;
      opts.push(['before:' + c, '只要' + sepName(c) + '前面的部分'], ['after:' + c, '只要' + sepName(c) + '后面的部分']);
    }
    const isRe = cur.startsWith('m:') || a._re;
    opts.push(['__re', '按正则提取…']);
    for (const [v, t] of opts) sel.append(el('option', { value: v, textContent: t, selected: isRe ? v === '__re' : v === cur }));
    sel.addEventListener('change', () => {
      a._re = sel.value === '__re';
      if (!a._re) setCut(a, sel.value);
      changed();
      renderCard();
    });
    if (!isRe) return [sel];
    const inp = el('input', { type: 'text', className: 'mono', value: cur.startsWith('m:') ? cur.slice(2) : '', placeholder: '括号里的部分会被保留，例如 #(\\d+)' });
    inp.addEventListener('input', () => {
      try {
        new RegExp(inp.value);
        inp.style.borderColor = '';
        setCut(a, inp.value ? 'm:' + inp.value : '');
        changed();
      } catch (_) {
        inp.style.borderColor = 'var(--err)';
      }
    });
    return [sel, inp];
  }

  const field = (label, ...kids) => el('div', { className: 'field' }, el('span', { textContent: label }), el('div', { className: 'stack' }, ...kids));

  function fallbackSelect(alts) {
    const fb = alts[1];
    const sel = el('select');
    const opts = [['none', '留空']];
    const urls = urlOptions();
    urls.forEach((o, i) => opts.push(['url:' + i, '用网址里的' + o.name + '（' + o.value + '）']));
    opts.push(['title', '用原标题'], ['text', '显示一段文字…']);
    let cur = 'none';
    if (fb) {
      if (fb.lit !== undefined) cur = 'text';
      else if (fb.expr === 'title') cur = 'title';
      else {
        const i = urls.findIndex((o) => sameAlt(o.alt, fb));
        cur = i >= 0 ? 'url:' + i : 'keep';
        if (i < 0) opts.push(['keep', describeAlt(fb)]);
      }
    }
    for (const [v, t] of opts) sel.append(el('option', { value: v, textContent: t, selected: v === cur }));
    sel.addEventListener('change', () => {
      const v = sel.value;
      const rest = alts.slice(2);
      alts.length = 1;
      if (v.startsWith('url:')) alts.push({ ...urls[Number(v.slice(4))].alt, filters: [] }, ...rest);
      else if (v === 'title') alts.push({ expr: 'title', filters: [] }, ...rest);
      else if (v === 'text') alts.push({ lit: '', filters: [] }, ...rest);
      changed();
      renderCard();
    });
    return sel;
  }

  async function renderCard() {
    const card = $('tokenCard');
    const alts = openId && tokens.get(openId);
    if (!alts) return closeCard();
    const a = alts[0];
    const fb = alts[1];
    const [{ value: v0 }, { value: vfb }] = await Promise.all([valueOf([rawAlt(a)]), fb ? valueOf([rawAlt(fb)]) : { value: '' }]);
    card.textContent = '';
    card.hidden = false;

    card.append(el('div', { className: 'head', textContent: iconOf(a) + ' ' + describeAlt(a) + (v0 ? '：' + v0 : '：（现在取不到）') }));
    if (a.sel !== undefined) {
      card.append(field('位置', el('div', { className: 'detail', textContent: a.sel }), el('button', { textContent: '👆 重新点选', onclick: () => startPick({ mode: 'replace', id: openId }) })));
    } else if (a.expr !== 'title' && a.lit === undefined) {
      const urls = urlOptions();
      const s = el('select');
      urls.forEach((o, i) => s.append(el('option', { value: i, textContent: o.name + '：' + o.value, selected: sameAlt(o.alt, a) })));
      if (!urls.some((o) => sameAlt(o.alt, a))) s.prepend(el('option', { value: -1, textContent: describeAlt(a), selected: true }));
      s.addEventListener('change', () => {
        if (s.value < 0) return;
        alts[0] = { ...urls[Number(s.value)].alt, filters: a.filters };
        changed();
        renderCard();
      });
      card.append(field('用哪段', s));
    }
    if (a.lit === undefined) card.append(field('只要一部分', ...cutSelect(a, v0)));

    const fbKids = [fallbackSelect(alts)];
    if (fb && fb.lit !== undefined) {
      const inp = el('input', { type: 'text', value: fb.lit, placeholder: '比如：加载中' });
      inp.addEventListener('input', () => ((fb.lit = inp.value), changed()));
      fbKids.push(inp);
    } else if (fb && fb.expr !== 'title') fbKids.push(...cutSelect(fb, vfb));
    card.append(field('取不到时', ...fbKids));
    if (a.sel !== undefined && !fb) card.append(el('div', { className: 'sub', textContent: '页面还没加载完、或者页面改版找不到这段文字时，会用这里的设置。' }));

    card.append(
      el('div', { className: 'btns' },
        el('button', { textContent: '删除这一段', onclick: () => removeChip(openId) }),
        el('button', { className: 'primary', textContent: '完成', onclick: closeCard })
      )
    );
  }

  function removeChip(id) {
    const c = $('composer').querySelector('.tk[data-id="' + id + '"]');
    if (c) c.remove();
    tokens.delete(id);
    closeCard();
    changed();
  }

  // ---------- URL pieces ----------
  function renderUrlPieces() {
    const box = $('urlPieces');
    box.textContent = '';
    const u = U();
    if (!u) return box.append('这个页面没有网址可用。');
    const piece = (alt, text, name) =>
      el('span', { className: 'p', textContent: text, title: name, onclick: () => (($('urlPieces').hidden = true), $('fromUrl').classList.remove('on'), openCard(insertChip([{ ...alt, filters: [] }]))) });
    const s = (t) => el('span', { className: 's', textContent: t });
    box.append(el('div', { className: 'tip', textContent: '点一下要用的那段：' }));
    const line = el('div');
    line.append(s(u.protocol + '//'));
    u.hostname.split('.').forEach((v, i) => {
      if (i) line.append(s('.'));
      line.append(piece({ expr: 'host', index: i + 1 }, v, '域名第 ' + (i + 1) + ' 段'));
    });
    if (u.port) line.append(s(':' + u.port));
    u.pathname.split('/').filter(Boolean).forEach((v, i) => line.append(s('/'), piece({ expr: 'path', index: i + 1 }, decodeURIComponent(v), '路径第 ' + (i + 1) + ' 段')));
    TabRules.queryKeys(u.href).forEach(([k, v], i) => line.append(s((i ? '&' : '?') + k + '='), piece({ expr: 'q.' + k }, v || '(空)', '参数 ' + k)));
    box.append(line);
    box.append(el('div', { className: 'whole' }, el('button', { className: 'chip', textContent: '整个域名', onclick: () => openCard(insertChip([{ expr: 'host', filters: [] }])) }), el('button', { className: 'chip', textContent: '整个路径', onclick: () => openCard(insertChip([{ expr: 'path', filters: [] }])) })));
  }

  // ---------- where the rule applies ----------
  function scopeOptions() {
    const u = U();
    const out = [['tab', '只这个标签（关掉就失效）']];
    if (u && /^https?:|^file:/.test(u.protocol)) {
      out.push(['site', u.host + ' 的所有页面']);
      if (u.pathname.length > 1) out.push(['path', u.host + u.pathname + ' 开头的页面']);
      for (const [k] of TabRules.queryKeys(u.href)) out.push(['param:' + k, '任何网站上，网址带 ' + k + '= 的页面']);
    }
    out.push(['custom', '自定义匹配…']);
    return out;
  }

  function patternFor(s) {
    const u = U();
    if (s === 'custom' || !u) return customPattern;
    if (s === 'site') return '*://' + u.host + '/*';
    if (s === 'path') return '*://' + u.host + globEsc(u.pathname) + '*';
    if (s.startsWith('param:')) return '*[?&#]' + globEsc(s.slice(6)) + '=*';
    return '';
  }

  const classify = (pattern) => (scopeOptions().find(([v]) => v !== 'custom' && v !== 'tab' && patternFor(v) === pattern) || ['custom'])[0];
  const isTabOnly = () => manualText === null && scope === 'tab';
  const ruleLine = () => manualText ?? TabRules.formatRule({ pattern: patternFor(scope), title: serialize(), icon, color });

  function renderScope() {
    const sel = $('scope');
    sel.textContent = '';
    const opts = scopeOptions();
    if (!opts.some(([v]) => v === scope)) scope = 'custom';
    for (const [v, t] of opts) sel.append(el('option', { value: v, textContent: t, selected: v === scope }));
    $('customPattern').hidden = scope !== 'custom';
    $('customPattern').value = customPattern;
  }
  $('scope').addEventListener('change', () => {
    if ($('scope').value === 'custom' && !customPattern) customPattern = patternFor(scope) || '*://' + ((U() && U().host) || '*') + '/*';
    scope = $('scope').value;
    renderScope();
    renderButtons();
    changed();
  });
  $('customPattern').addEventListener('input', () => ((customPattern = $('customPattern').value), changed()));

  // ---------- icon ----------
  function renderIcons() {
    $('colors').textContent = '';
    for (const [v, label] of COLORS) {
      const b = el('button', { className: color === v ? 'on' : '', title: label || v, onclick: () => ((color = v), renderIcons(), changed()) });
      b.append(label ? el('span', { className: 'txt', textContent: label }) : el('span', { className: 'dot', style: 'background:' + v }));
      $('colors').append(b);
    }
    $('icons').textContent = '';
    for (const [v, label] of ICONS) {
      const b = el('button', { className: icon === v ? 'on' : '', title: label || v, onclick: () => ((icon = v), ($('iconCustom').value = ''), renderIcons(), changed()) });
      b.append(label ? el('span', { className: 'txt', textContent: label }) : v);
      $('icons').append(b);
    }
    if (!ICONS.some(([v]) => v === icon)) $('iconCustom').value = icon;
    const parts = [];
    if (icon === 'letter') parts.push('标题首字');
    else if (icon) parts.push(icon);
    if (color) parts.push(color === 'auto' ? '自动配色' : '色点');
    $('iconSummary').textContent = parts.length ? '· ' + parts.join(' + ') : '· 不改';
  }
  $('iconCustom').addEventListener('input', () => ((icon = $('iconCustom').value.trim()), renderIcons(), changed()));

  // ---------- preview ----------
  let timer = 0;
  function changed() {
    $('msg').textContent = '';
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  }

  async function refresh() {
    const tabOnly = isTabOnly();
    if (manualText === null) $('ruleText').value = tabOnly ? serialize() : ruleLine();
    let r;
    const ov = { title: serialize(), icon, color };
    if (st) r = await sendTab(tabOnly ? { type: 'preview', override: ov } : { type: 'preview', line: ruleLine() });
    else {
      try {
        const rule = tabOnly ? TabRules.compileOverride(ov) : TabRules.compileRule(ruleLine());
        const m = rule.re ? rule.re.exec(pageUrl()) : [pageUrl()];
        r = m ? { ok: true, matched: true, ...TabRules.renderRule(rule, { url: pageUrl(), title: pageTitle() }, m) } : { ok: true, matched: false };
      } catch (e) {
        r = { ok: false, error: e.message };
      }
    }
    const shown = r && r.ok && r.matched ? r.title ?? pageTitle() : pageTitle();
    $('pvTitle').textContent = shown || '（空）';
    $('pvIcon').src = (r && r.iconHref) || (tab && tab.favIconUrl) || 'data:,';
    const check = $('scopeCheck');
    check.className = 'sub ' + (!r || !r.ok || !r.matched ? 'err' : 'ok');
    check.textContent = !r ? '' : !r.ok ? '有问题：' + r.error : !r.matched ? '⚠ 当前这个页面不在范围内，保存后它不会变' : tabOnly ? '' : '✓ 当前页面在范围内';

    // Live value on each chip; amber when it is showing its fallback.
    const notes = [];
    for (const c of $('composer').querySelectorAll('.tk')) {
      const alts = tokens.get(Number(c.dataset.id));
      if (!alts) continue;
      const { value, used } = await valueOf(alts);
      c.querySelector('.i').textContent = iconOf(alts[0]);
      c.querySelector('.v').textContent = value || describeAlt(alts[0]);
      c.classList.toggle('miss', !value);
      c.classList.toggle('fb', Boolean(value) && used > 0);
      c.title = !value ? describeAlt(alts[0]) + '：现在取不到，会留空' : used > 0 ? describeAlt(alts[0]) + '现在取不到，正在用' + describeAlt(alts[used]) : describeAlt(alts[0], true);
      if (alts[1]) notes.push(describeAlt(alts[0]) + '取不到时，用' + describeAlt(alts[1]) + (used > 0 ? '（现在就是这样）' : ''));
    }
    renderSummary(shown, notes, r);
  }

  function renderSummary(shown, notes, r) {
    const box = $('summary');
    box.textContent = '';
    if (manualText !== null) return box.append('按你手写的规则保存：', el('code', { textContent: manualText }));
    const opt = scopeOptions().find(([v]) => v === scope);
    const where = scope === 'tab' ? '这个标签' : scope === 'custom' ? '网址符合 ' + customPattern + ' 的页面' : opt ? opt[1] : '';
    box.append(scope === 'tab' ? '这个标签会显示成 ' : '以后打开 ' + where + '，标签会显示成 ', el('b', { textContent: '「' + (shown || '原标题') + '」' }));
    if (!serialize().trim()) box.append('（名字留空就保持原标题）');
    for (const n of notes) box.append(el('div', { className: 'sub', textContent: '· ' + n }));
    if (editing && editing.kind === 'rule' && scope !== 'tab') box.append(el('div', { className: 'sub', textContent: '· 保存会更新现在生效的这条规则' }));
    if (r && r.ok && !r.matched) box.append(el('div', { className: 'sub err', textContent: '· 但当前这个页面不在范围内' }));
  }

  // ---------- status, buttons, saving ----------
  function flash(text, cls) {
    $('msg').className = 'msg ' + (cls || 'ok');
    $('msg').textContent = text;
  }

  function renderNow() {
    const now = $('now');
    now.textContent = '';
    $('blocked').hidden = Boolean(st) || !tab;
    $('pick').disabled = !st;
    if (!st) return;
    if (st.manual) now.append('原标题「' + st.pageTitle + '」· 这个标签单独改过', el('button', { textContent: '清除', onclick: reset }));
    else if (st.lineNo) now.append('原标题「' + st.pageTitle + '」· 由一条规则控制，下面就是它', el('button', { textContent: '暂停这条规则', onclick: pauseRule }));
    else now.append('原标题「' + st.pageTitle + '」');
  }

  function renderButtons() {
    const tabOnly = isTabOnly();
    const updating = !tabOnly && editing && editing.kind === 'rule';
    $('save').textContent = tabOnly ? '只改这个标签' : updating ? '更新规则' : '保存规则';
    $('saveNew').hidden = !updating;
    $('saveNew').textContent = '另存为新规则';
  }

  async function save(asNew) {
    try {
      if (isTabOnly()) {
        const ov = { title: serialize(), icon, color };
        TabRules.compileOverride(ov);
        await chrome.runtime.sendMessage({ type: 'setOverride', tabId: tab.id, override: ov });
        editing = { kind: 'tab' };
        flash('改好了，只对这个标签有效');
      } else {
        const line = ruleLine();
        TabRules.compileRule(line);
        const lines = (await TabStore.loadRulesText()).split('\n');
        let at = 0;
        const canUpdate = !asNew && editing && editing.kind === 'rule' && (lines[editing.lineNo - 1] || '').trim() === editing.line;
        if (canUpdate) {
          at = editing.lineNo - 1;
          lines[at] = line;
        } else lines.unshift(line); // first match wins, so new rules go on top
        await TabStore.saveRulesText(lines.join('\n'));
        if (st && st.manual) await chrome.runtime.sendMessage({ type: 'clearOverride', tabId: tab.id });
        editing = { kind: 'rule', lineNo: at + 1, line: line.trim() };
        flash(canUpdate ? '规则已更新' : '已保存，范围内的标签都会变');
      }
    } catch (e) {
      return flash(e.message, 'err');
    }
    renderButtons();
    setTimeout(reloadState, 400);
  }

  async function reset() {
    if (!tab) return;
    await chrome.runtime.sendMessage({ type: 'clearOverride', tabId: tab.id });
    setTimeout(() => loadTab(tab.id), 300);
    flash('已恢复');
  }

  // Pausing comments the line out; it can be switched back on in the rules page.
  async function pauseRule() {
    const lines = (await TabStore.loadRulesText()).split('\n');
    const i = st.lineNo - 1;
    if ((lines[i] || '').trim() !== st.ruleLine) return flash('规则刚被改过，请到规则页操作', 'err');
    lines[i] = '# ' + lines[i];
    await TabStore.saveRulesText(lines.join('\n'));
    flash('已暂停。到规则页删掉这行开头的 # 就能恢复');
    setTimeout(() => loadTab(tab.id), 400);
  }

  // ---------- picking text on the page ----------
  function startPick(mode) {
    if (picking) {
      sendTab({ type: 'stopPick' });
      return setPicking(null);
    }
    setPicking(mode);
    sendTab({ type: 'pick' });
  }
  function setPicking(mode) {
    picking = mode;
    $('pick').classList.toggle('picking', Boolean(mode));
    $('pick').textContent = mode ? '✋ 取消（去页面上点一下文字）' : '👆 页面上的文字';
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type !== 'picked' || !tab || !sender.tab || sender.tab.id !== tab.id) return;
    const mode = picking;
    setPicking(null);
    if (msg.cancelled || !mode) return;
    if (mode.mode === 'replace' && tokens.has(mode.id)) {
      const alts = tokens.get(mode.id);
      alts[0] = { sel: msg.selector, filters: alts[0].filters || [] };
      openCard(mode.id);
      changed();
    } else openCard(insertChip([{ sel: msg.selector, filters: [] }]));
    if (msg.count > 1) flash('页面上有 ' + msg.count + ' 处相同位置，会用第一处', 'muted');
  });

  $('pick').addEventListener('click', () => startPick({ mode: 'insert' }));
  $('fromUrl').addEventListener('click', () => {
    const show = $('urlPieces').hidden;
    closeCard();
    $('urlPieces').hidden = !show;
    $('fromUrl').classList.toggle('on', show);
    if (show) renderUrlPieces();
  });
  $('addTitle').addEventListener('click', () => openCard(insertChip([{ expr: 'title', filters: [] }])));
  $('save').addEventListener('click', () => save(false));
  $('saveNew').addEventListener('click', () => save(true));
  $('reset').addEventListener('click', reset);
  $('openOptions').addEventListener('click', (e) => (e.preventDefault(), chrome.runtime.openOptionsPage()));
  $('ruleText').addEventListener('input', () => {
    manualText = $('ruleText').value;
    $('advNote').textContent = '已手动修改，保存时直接用这段文字。';
    $('advNote').append(' ', el('button', { textContent: '撤销修改', onclick: () => ((manualText = null), ($('advNote').textContent = ''), renderButtons(), changed()) }));
    renderButtons();
    changed();
  });

  // ---------- following the active tab ----------
  async function reloadState() {
    if (!tab) return;
    tab = (await chrome.tabs.get(tab.id).catch(() => null)) || tab;
    st = await sendTab({ type: 'getState' });
    renderNow();
    changed();
  }

  async function loadTab(id) {
    if (picking) sendTab({ type: 'stopPick' });
    setPicking(null);
    tab = await chrome.tabs.get(id).catch(() => null);
    st = await sendTab({ type: 'getState' });
    manualText = null;
    $('advNote').textContent = '';
    $('urlPieces').hidden = true;
    $('fromUrl').classList.remove('on');
    closeCard();
    editing = null;
    let raw = { title: '', icon: '', color: '', pattern: '' };
    scope = 'site';
    if (st && st.manual && st.override) {
      editing = { kind: 'tab' };
      scope = 'tab';
      raw = { ...raw, ...st.override };
    } else if (st && st.lineNo) {
      try {
        raw = { ...raw, ...TabRules.compileRule(st.ruleLine).raw };
        editing = { kind: 'rule', lineNo: st.lineNo, line: st.ruleLine };
        customPattern = raw.pattern;
        scope = classify(raw.pattern);
      } catch (_) {}
    }
    if (scope !== 'custom') customPattern = '';
    loadComposer(raw.title);
    icon = raw.icon || '';
    color = raw.color || '';
    $('iconBox').open = Boolean(icon || color);
    $('msg').textContent = '';
    renderNow();
    renderScope();
    renderIcons();
    renderButtons();
    changed();
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
    let host = '';
    try {
      host = info.url ? new URL(info.url).host : '';
    } catch (_) {}
    if (info.url && U() && host !== U().host) loadTab(id);
    else if (info.url || info.status === 'complete') reloadState();
  });
})();
