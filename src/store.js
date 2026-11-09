/* Rules are one plain-text document, stored in chrome.storage.sync in chunks
 * (sync allows ~8KB per item). Shared by every extension context. */
(function (root) {
  'use strict';
  const PREFIX = 'rules_';
  const COUNT = 'rules_n';
  const CHUNK = 1500;

  const DEFAULT_RULES = [
    '# tabmv rules: first match wins. Syntax: <pattern> => <title> [; icon=..] [; color=..]',
    '# glob: *  ?  [abc]  {a,b}  (capture)  (#i)case-insensitive   regex: /.../i',
    '# vars: $1 $<name> $title $host $path ${q.env}  filters: ${1|upper} ${q.env|before:.} ${title|s/ - .*//}',
    '',
    '# env=xxx.baidu.com  ->  title "xxx", stable color per env',
    '*[?&]env=(*).baidu.com* => $1 ; color=auto',
    '',
    '# keep the page title, add a prefix',
    '# *://*.baidu.com/* => [${q.env|before:.}] $title',
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
