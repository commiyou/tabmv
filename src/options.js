(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ta = $('rules');
  ta.value = await TabStore.loadRulesText();
  let saved = ta.value;

  const tabs = await chrome.tabs.query({});
  const pages = await Promise.all(
    tabs
      .filter((t) => /^(https?|file):/.test(t.url || ''))
      .map(async (t) => {
        const s = await chrome.tabs.sendMessage(t.id, { type: 'getState' }).catch(() => null);
        return { url: t.url, title: s ? s.pageTitle : t.title || '' };
      })
  );
  if (pages[0]) {
    $('tUrl').value = pages[0].url;
    $('tTitle').value = pages[0].title;
  }

  function describe(r, page) {
    if (!r) return null;
    return {
      line: r.rule.lineNo,
      title: r.title ?? page.title,
      deco: [r.icon && 'icon=' + r.icon, r.color && 'color=' + r.color].filter(Boolean).join(' '),
    };
  }

  function cell(tr, text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }

  function update() {
    const { rules, errors } = TabRules.parseRules(ta.value);
    $('errors').textContent = errors.map((e) => '第 ' + e.lineNo + ' 行: ' + e.message + '\n    ' + e.line).join('\n');
    $('msg').textContent = ta.value === saved ? '' : '未保存';

    const page = { url: $('tUrl').value, title: $('tTitle').value };
    let d;
    try {
      d = describe(TabRules.evaluate(rules, page), page);
    } catch (e) {
      d = { line: '?', title: e.message, deco: '' };
    }
    $('tOut').textContent = d ? '第 ' + d.line + ' 行 → ' + d.title + (d.deco ? '   ' + d.deco : '') : '没有命中';

    const tb = $('tabs');
    tb.textContent = '';
    for (const p of pages) {
      let x;
      try {
        x = describe(TabRules.evaluate(rules, p), p);
      } catch (_) {
        x = null;
      }
      const tr = document.createElement('tr');
      tr.title = p.url;
      cell(tr, x ? x.line : '');
      cell(tr, p.title, 'muted');
      cell(tr, x ? x.title : '');
      cell(tr, x ? x.deco : '', 'mono');
      tb.appendChild(tr);
    }
  }

  async function save() {
    const text = ta.value;
    try {
      await TabStore.saveRulesText(text);
      if ((await TabStore.loadRulesText()) !== text) throw new Error('读回的内容和保存的不一致');
    } catch (e) {
      $('msg').className = 'err';
      $('msg').textContent = '保存失败：' + e.message;
      return;
    }
    saved = text;
    update();
    const { rules, errors } = TabRules.parseRules(text);
    $('msg').className = errors.length ? 'err' : 'ok';
    $('msg').textContent =
      '已保存 ' + new Date().toLocaleTimeString() + '，' + rules.length + ' 条规则生效' +
      (errors.length ? '；第 ' + errors.map((e) => e.lineNo).join('、') + ' 行有错误，没有生效' : '，已打开的标签会立即更新');
  }

  ta.addEventListener('input', update);
  $('tUrl').addEventListener('input', update);
  $('tTitle').addEventListener('input', update);
  $('save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (ta.value !== saved) e.preventDefault();
  });
  update();
})();
