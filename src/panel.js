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
  localize();
  document.getElementById('composer').dataset.placeholder = t('p_name_ph');
  const testTab = Number(new URLSearchParams(location.search).get('tab')) || null;

  const COLORS = [['', t('color_none')], ['auto', t('color_auto')], ['#d93025'], ['#f29900'], ['#f9ab00'], ['#188038'], ['#1a73e8'], ['#9334e6'], ['#5f6368']];
  const ICONS = [['', t('icon_original')], ['letter', t('icon_letter')], ['⭐'], ['🐞'], ['🚀'], ['📝'], ['🔥'], ['🧪'], ['🏠']];
  const SEPS = ['.', '-', '_', '/', ':', '·', ' ', '(', '（', ',', '，', '|', '—'];
  const sepName = (c) => (c === ' ' ? t('sep_space') : t('sep_quote', c));

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
    labels.forEach((v, i) => out.push({ alt: { expr: 'host', index: i + 1 }, value: v, name: t('url_host_n', i + 1) }));
    out.push({ alt: { expr: 'host' }, value: u.host, name: t('url_host') });
    u.pathname.split('/').filter(Boolean).forEach((v, i) => out.push({ alt: { expr: 'path', index: i + 1 }, value: decodeURIComponent(v), name: t('url_path_n', i + 1) }));
    for (const [k, v] of TabRules.queryKeys(u.href)) out.push({ alt: { expr: 'q.' + k }, value: v, name: t('url_param', k) });
    return out;
  }
  const sameAlt = (a, b) => a.expr === b.expr && a.index === b.index;

  function describeAlt(a, withValue) {
    if (!a) return '';
    if (a.lit !== undefined) return t('sep_quote', a.lit);
    if (a.sel !== undefined) return t('src_page');
    if (a.expr === 'title') return t('src_title');
    const o = urlOptions().find((x) => sameAlt(x.alt, a));
    if (o) return withValue ? t('src_url_value', o.name, o.value) : t('src_url', o.name);
    if (a.expr.startsWith('q.')) return t('src_url', t('url_param', a.expr.slice(2)));
    if (a.expr === 'host' || a.expr === 'path') return t('src_url', a.index ? t(a.expr === 'host' ? 'url_host_n' : 'url_path_n', a.index) : t(a.expr === 'host' ? 'url_host' : 'url_path'));
    return t('src_capture', a.expr);
  }
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
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
    const opts = [['', t('cut_full')]];
    for (const c of SEPS) {
      if (!value.includes(c) && cur !== 'before:' + c && cur !== 'after:' + c) continue;
      opts.push(['before:' + c, t('cut_before', sepName(c))], ['after:' + c, t('cut_after', sepName(c))]);
    }
    const isRe = cur.startsWith('m:') || a._re;
    opts.push(['__re', t('cut_regex')]);
    for (const [v, t] of opts) sel.append(el('option', { value: v, textContent: t, selected: isRe ? v === '__re' : v === cur }));
    sel.addEventListener('change', () => {
      a._re = sel.value === '__re';
      if (!a._re) setCut(a, sel.value);
      changed();
      renderCard();
    });
    if (!isRe) return [sel];
    const inp = el('input', { type: 'text', className: 'mono', value: cur.startsWith('m:') ? cur.slice(2) : '', placeholder: t('cut_regex_ph') });
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
    const opts = [['none', t('fb_none')]];
    const urls = urlOptions();
    urls.forEach((o, i) => opts.push(['url:' + i, t('fb_url', o.name, o.value)]));
    opts.push(['title', t('fb_title')], ['text', t('fb_text')]);
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

    card.append(el('div', { className: 'head', textContent: iconOf(a) + ' ' + cap(describeAlt(a)) + t('colon') + (v0 || t('card_missing')) }));
    if (a.sel !== undefined) {
      card.append(field(t('card_where'), el('div', { className: 'detail', textContent: a.sel }), el('button', { textContent: t('card_repick'), onclick: () => startPick({ mode: 'replace', id: openId }) })));
    } else if (a.expr !== 'title' && a.lit === undefined) {
      const urls = urlOptions();
      const s = el('select');
      urls.forEach((o, i) => s.append(el('option', { value: i, textContent: o.name + t('colon') + o.value, selected: sameAlt(o.alt, a) })));
      if (!urls.some((o) => sameAlt(o.alt, a))) s.prepend(el('option', { value: -1, textContent: describeAlt(a), selected: true }));
      s.addEventListener('change', () => {
        if (s.value < 0) return;
        alts[0] = { ...urls[Number(s.value)].alt, filters: a.filters };
        changed();
        renderCard();
      });
      card.append(field(t('card_which'), s));
    }
    if (a.lit === undefined) card.append(field(t('card_cut'), ...cutSelect(a, v0)));

    const fbKids = [fallbackSelect(alts)];
    if (fb && fb.lit !== undefined) {
      const inp = el('input', { type: 'text', value: fb.lit, placeholder: t('card_fb_ph') });
      inp.addEventListener('input', () => ((fb.lit = inp.value), changed()));
      fbKids.push(inp);
    } else if (fb && fb.expr !== 'title') fbKids.push(...cutSelect(fb, vfb));
    card.append(field(t('card_fallback'), ...fbKids));
    if (a.sel !== undefined && !fb) card.append(el('div', { className: 'sub', textContent: t('card_fb_hint') }));

    card.append(
      el('div', { className: 'btns' },
        el('button', { textContent: t('card_delete'), onclick: () => removeChip(openId) }),
        el('button', { className: 'primary', textContent: t('card_done'), onclick: closeCard })
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
    if (!u) return box.append(t('url_none'));
    const piece = (alt, text, name) =>
      el('span', { className: 'p', textContent: text, title: name, onclick: () => (($('urlPieces').hidden = true), $('fromUrl').classList.remove('on'), openCard(insertChip([{ ...alt, filters: [] }]))) });
    const s = (t) => el('span', { className: 's', textContent: t });
    box.append(el('div', { className: 'tip', textContent: t('url_tip') }));
    const line = el('div');
    line.append(s(u.protocol + '//'));
    u.hostname.split('.').forEach((v, i) => {
      if (i) line.append(s('.'));
      line.append(piece({ expr: 'host', index: i + 1 }, v, t('url_host_n', i + 1)));
    });
    if (u.port) line.append(s(':' + u.port));
    u.pathname.split('/').filter(Boolean).forEach((v, i) => line.append(s('/'), piece({ expr: 'path', index: i + 1 }, decodeURIComponent(v), t('url_path_n', i + 1))));
    TabRules.queryKeys(u.href).forEach(([k, v], i) => line.append(s((i ? '&' : '?') + k + '='), piece({ expr: 'q.' + k }, v || t('url_empty'), t('url_param', k))));
    box.append(line);
    box.append(el('div', { className: 'whole' }, el('button', { className: 'chip', textContent: t('url_host'), onclick: () => openCard(insertChip([{ expr: 'host', filters: [] }])) }), el('button', { className: 'chip', textContent: t('url_path'), onclick: () => openCard(insertChip([{ expr: 'path', filters: [] }])) })));
  }

  // ---------- where the rule applies ----------
  function scopeOptions() {
    const u = U();
    const out = [['tab', t('scope_tab')]];
    if (u && /^https?:|^file:/.test(u.protocol)) {
      out.push(['site', t('scope_site', u.host)]);
      if (u.pathname.length > 1) out.push(['path', t('scope_path', u.host + u.pathname)]);
      for (const [k] of TabRules.queryKeys(u.href)) out.push(['param:' + k, t('scope_param', k)]);
    }
    out.push(['custom', t('scope_custom')]);
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
    if (icon === 'letter') parts.push(t('icon_sum_letter'));
    else if (icon) parts.push(icon);
    if (color) parts.push(color === 'auto' ? t('color_auto') : t('icon_sum_dot'));
    $('iconSummary').textContent = parts.length ? '· ' + parts.join(' + ') : '· ' + t('icon_sum_none');
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
    $('pvTitle').textContent = shown || t('empty_title');
    $('pvIcon').src = (r && r.iconHref) || (tab && tab.favIconUrl) || 'data:,';
    const check = $('scopeCheck');
    check.className = 'sub ' + (!r || !r.ok || !r.matched ? 'err' : 'ok');
    check.textContent = !r ? '' : !r.ok ? t('check_err', r.error) : !r.matched ? t('check_out') : tabOnly ? '' : t('check_in');

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
      c.title = !value ? t('chip_missing', describeAlt(alts[0])) : used > 0 ? t('chip_fallback', describeAlt(alts[0]), describeAlt(alts[used])) : describeAlt(alts[0], true);
      if (alts[1]) notes.push(t('note_fallback', describeAlt(alts[0]), describeAlt(alts[1])) + (used > 0 ? t('note_now') : ''));
    }
    renderSummary(shown, notes, r);
  }

  function renderSummary(shown, notes, r) {
    const box = $('summary');
    box.textContent = '';
    if (manualText !== null) return box.append(t('sum_manual'), el('code', { textContent: manualText }));
    const u = U();
    const where =
      scope === 'site' && u ? t('sum_where_site', u.host)
      : scope === 'path' && u ? t('sum_where_path', u.host + u.pathname)
      : scope.startsWith('param:') ? t('sum_where_param', scope.slice(6))
      : t('sum_where_custom', customPattern);
    box.append(scope === 'tab' ? t('sum_tab_shows') : t('sum_rule_shows', where), el('b', { textContent: t('sum_quote', shown || t('src_title')) }));
    if (!serialize().trim()) box.append(t('sum_empty'));
    for (const n of notes) box.append(el('div', { className: 'sub', textContent: '· ' + n }));
    if (editing && editing.kind === 'rule' && scope !== 'tab') box.append(el('div', { className: 'sub', textContent: t('sum_updates') }));
    if (r && r.ok && !r.matched) box.append(el('div', { className: 'sub err', textContent: t('sum_out') }));
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
    if (st.manual) now.append(t('now_manual', st.pageTitle), el('button', { textContent: t('now_clear'), onclick: reset }));
    else if (st.lineNo) now.append(t('now_rule', st.pageTitle), el('button', { textContent: t('now_pause'), onclick: pauseRule }));
    else now.append(t('now_none', st.pageTitle));
  }

  function renderButtons() {
    const tabOnly = isTabOnly();
    const updating = !tabOnly && editing && editing.kind === 'rule';
    $('save').textContent = tabOnly ? t('btn_tab') : updating ? t('btn_update') : t('btn_save');
    $('saveNew').hidden = !updating;
    $('saveNew').textContent = t('btn_save_new');
  }

  async function save(asNew) {
    try {
      if (isTabOnly()) {
        const ov = { title: serialize(), icon, color };
        TabRules.compileOverride(ov);
        await chrome.runtime.sendMessage({ type: 'setOverride', tabId: tab.id, override: ov });
        editing = { kind: 'tab' };
        flash(t('msg_tab_saved'));
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
        flash(canUpdate ? t('msg_updated') : t('msg_saved'));
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
    flash(t('msg_reset'));
  }

  // Pausing comments the line out; it can be switched back on in the rules page.
  async function pauseRule() {
    const lines = (await TabStore.loadRulesText()).split('\n');
    const i = st.lineNo - 1;
    if ((lines[i] || '').trim() !== st.ruleLine) return flash(t('msg_rule_changed'), 'err');
    lines[i] = '# ' + lines[i];
    await TabStore.saveRulesText(lines.join('\n'));
    flash(t('msg_paused'));
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
    $('pick').textContent = mode ? t('pick_cancel') : t('pick');
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
    if (msg.count > 1) flash(t('msg_many', msg.count), 'muted');
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
    $('advNote').textContent = t('adv_edited');
    $('advNote').append(' ', el('button', { textContent: t('adv_undo'), onclick: () => ((manualText = null), ($('advNote').textContent = ''), renderButtons(), changed()) }));
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
