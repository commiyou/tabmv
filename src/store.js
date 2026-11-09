/* Rules are one plain-text document, stored in chrome.storage.sync in chunks
 * (sync allows ~8KB per item). Shared by every extension context. */
(function (root) {
  'use strict';
  const PREFIX = 'rules_';
  const COUNT = 'rules_n';
  const CHUNK = 1500;

  const DEFAULT_RULES = [
    '# tabmv 规则：从上到下，第一条匹配的生效。  网址匹配 => 标签名 [; icon=…] [; color=…]',
    '# 标签名里 {…} 是一段可变内容，其余照原样显示：',
    '#   {page ".env-name"} 页面上的文字   {?env} 网址参数   {host[1]} {path[2]} 网址的某一段   {title} 原标题   {1} 匹配里第 1 个 (*)',
    '#   {page "h1" or ?env before "."}  取不到就用 or 后面的；before / after / match / replace 只取一部分',
    '',
    '# env=xxx.baidu.com -> 标签显示 xxx，每个环境一个固定颜色',
    '*[?&]env=(*).baidu.com* => {1} ; color=auto',
    '',
    '# 优先用页面上的环境名，页面还没加载出来时用网址里的 env，后面接原标题',
    '# *://*.baidu.com/* => [{page ".env-name" or ?env before "."}] {title}',
  ].join('\n');

  async function loadRulesText() {
    const all = await chrome.storage.sync.get(null);
    const n = all[COUNT];
    if (typeof n !== 'number') return DEFAULT_RULES;
    let text = '';
    for (let i = 0; i < n; i++) text += all[PREFIX + i] || '';
    return text;
  }

  async function saveRulesText(text) {
    const items = {};
    let n = 0;
    for (let i = 0; i < text.length; i += CHUNK) items[PREFIX + n++] = text.slice(i, i + CHUNK);
    items[COUNT] = n;
    const old = await chrome.storage.sync.get(null);
    await chrome.storage.sync.set(items);
    const stale = Object.keys(old).filter((k) => k.startsWith(PREFIX) && k !== COUNT && Number(k.slice(PREFIX.length)) >= n);
    if (stale.length) await chrome.storage.sync.remove(stale);
  }

  function onRulesChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && Object.keys(changes).some((k) => k.startsWith(PREFIX))) cb();
    });
  }

  root.TabStore = { loadRulesText, saveRulesText, onRulesChanged, DEFAULT_RULES };
})(globalThis);
