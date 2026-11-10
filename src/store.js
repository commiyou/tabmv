/* Rules are one plain-text document, stored in chrome.storage.sync in chunks
 * (sync allows ~8KB per item). Shared by every extension context. */
(function (root) {
  'use strict';
  const PREFIX = 'rules_';
  const COUNT = 'rules_n';
  const CHUNK = 1500;

  // Shown until the user saves anything. Only comments, so nothing changes
  // until a rule is written on purpose.
  const DEFAULT_RULES_ZH = [
    '# Telltab 规则：一行一条，从上到下第一条匹配的生效。平时用侧边栏就行，这里方便批量编辑。',
    '#   网址匹配 => 标签名 [; icon=…] [; color=…]',
    '# 标签名里 {…} 是一段可变内容，其余照原样显示：',
    '#   {page ".env-name"} 页面上的文字   {?env} 网址参数   {host[1]} {path[2]} 网址的某一段',
    '#   {title} 原标题   {1} 网址匹配里第 1 个 (*)',
    '#   {page "h1" or ?env before "."}  取不到就用 or 后面的；before / after / match 只取一部分',
    '',
    '# 例：网址里 env=qa3.example.com -> 标签显示 qa3，每个环境一个固定颜色（去掉行首 # 生效）',
    '# *[?&]env=(*).example.com* => {1} ; color=auto',
    '',
    '# 例：优先用页面上的环境名，页面还没加载出来时用网址里的 env，后面接原标题',
    '# *://*.example.com/* => [{page ".env-name" or ?env before "."}] {title}',
  ].join('\n');
  const DEFAULT_RULES_EN = [
    '# Telltab rules: one per line, the first matching line wins. The side panel is enough for',
    '# everyday use; this page is for editing many rules at once.',
    '#   URL match => tab name [; icon=…] [; color=…]',
    '# In the tab name, {…} is filled in per page and everything else is shown as is:',
    '#   {page ".env-name"} page text   {?env} URL parameter   {host[1]} {path[2]} part of the URL',
    '#   {title} original title   {1} first (*) of the URL match',
    '#   {page "h1" or ?env before "."}  use what follows "or" when empty; before / after / match keep a part',
    '',
    '# Example: env=qa3.example.com in the URL -> tab "qa3", one stable color per env (remove the # to enable)',
    '# *[?&]env=(*).example.com* => {1} ; color=auto',
    '',
    '# Example: prefer the env name on the page, use the URL until the page has rendered, keep the title',
    '# *://*.example.com/* => [{page ".env-name" or ?env before "."}] {title}',
  ].join('\n');
  const zh = (() => {
    try {
      return chrome.i18n.getUILanguage().toLowerCase().startsWith('zh');
    } catch (_) {
      return false;
    }
  })();
  const DEFAULT_RULES = zh ? DEFAULT_RULES_ZH : DEFAULT_RULES_EN;

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
