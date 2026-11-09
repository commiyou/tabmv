const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules.js');

const run = (text, url, title = 'T') => {
  const { rules, errors } = R.parseRules(text);
  assert.deepEqual(errors, []);
  return R.evaluate(rules, { url, title });
};

test('env=xxx.baidu.com&... => xxx (glob capture, like zmv)', () => {
  const url = 'http://host.example.com/a/b?id=3&env=sandbox01.baidu.com&x=1';
  assert.equal(run('*[?&]env=(*).baidu.com* => $1', url).title, 'sandbox01');
  assert.equal(run('*://*/* => ${q.env|before:.}', url).title, 'sandbox01');
  assert.equal(run('*://*/* => ${q.env|s/\\.baidu\\.com$//}', url).title, 'sandbox01');
  assert.equal(run('/[?&]env=([^.&]+)/ => $1', url).title, 'sandbox01');
});

test('lazy * takes the first occurrence', () => {
  const url = 'http://h/?env=a.baidu.com&back=http://h/?env=b.baidu.com';
  assert.equal(run('*[?&]env=(*).baidu.com* => $1', url).title, 'a');
});

test('glob is anchored; Chrome match patterns are valid globs', () => {
  assert.equal(run('*://*.baidu.com/* => hit', 'https://www.baidu.com/s?wd=1').title, 'hit');
  assert.equal(run('*://*.baidu.com/* => hit', 'https://www.baidu.com.evil.io/'), null);
});

test('zmv -W style: without ( ) every wildcard captures', () => {
  const r = run('https://*.example.com/*/issues/* => $2#$3 ($1)', 'https://git.example.com/web/issues/42');
  assert.equal(r.title, 'web#42 (git)');
});

test('{a,b}, (a|b), [!x], (#i), escapes', () => {
  assert.equal(run('*://{dev,qa}.x.com/* => ok', 'https://qa.x.com/').title, 'ok');
  assert.equal(run('*://(dev|qa).x.com/* => $1', 'https://dev.x.com/').title, 'dev');
  assert.equal(run('*/v[!0]/* => ok', 'https://x/v2/a').title, 'ok');
  assert.equal(run('(#i)*://X.COM/* => ok', 'https://x.com/').title, 'ok');
  assert.equal(run('*\\?a=(*) => $1', 'http://x/?a=1').title, '1');
  assert.equal(run('*\\?a=(*) => $1', 'http://x/Xa=1'), null);
});

test('regex named groups, title field, $title, filters', () => {
  const jira = '/browse\\/(?<key>[A-Z]+-\\d+)/ => $<key> ${title|s/ - Jira$//|max:8} ; icon=🐞';
  const r = run(jira, 'https://jira.x/browse/ABC-12', 'Login fails - Jira');
  assert.equal(r.title, 'ABC-12 Login f…');
  assert.equal(r.icon, '🐞');
  assert.equal(run('title:(*) - Google Docs => 📝 $1', 'https://docs.google.com/d/1', 'Plan - Google Docs').title, '📝 Plan');
  assert.equal(run('*://*/* => [${q.env|default:prod|upper}] $title', 'https://a.com/', 'Home').title, '[PROD] Home');
});

test('query param in hash route', () => {
  assert.equal(run('*://*/* => ${q.env}', 'https://a.com/#/list?env=qa2').title, 'qa2');
});

test('color=auto is stable per capture; empty title keeps the page title', () => {
  const rules = '*[?&]env=(*).baidu.com* => ; color=auto';
  const a = run(rules, 'http://h/?env=qa.baidu.com&p=1');
  const b = run(rules, 'http://h/other?env=qa.baidu.com');
  assert.equal(a.title, undefined);
  assert.equal(a.color, b.color);
  assert.notEqual(a.color, run(rules, 'http://h/?env=rd.baidu.com').color);
});

test('first match wins, comments ignored, \\; escapes', () => {
  const r = run('# c\n*://a.com/x* => first\n*://a.com/* => second\\; ok', 'https://a.com/xy');
  assert.equal(r.title, 'first');
  assert.equal(run('*://a.com/* => a\\;b', 'https://a.com/').title, 'a;b');
});

test('errors are reported per line', () => {
  const { rules, errors } = R.parseRules('ok* => x\n{bad => x\n* => $nope ${nope}\n/x/g => y\nno arrow');
  assert.equal(rules.length, 1);
  assert.deepEqual(errors.map((e) => e.lineNo), [2, 3, 4, 5]);
});

test('formatRule round-trips through compileRule', () => {
  const line = R.formatRule({ pattern: '*://a.com/*', title: 'x;y', icon: '🔥', color: 'auto' });
  const r = R.renderRule(R.compileRule(line), { url: 'https://a.com/', title: '' }, ['https://a.com/']);
  assert.equal(r.title, 'x;y');
  assert.equal(r.icon, '🔥');
});

test('page content with fallback: sel -> URL -> title', () => {
  const { rules } = R.parseRules('*[?&]env=(*).baidu.com* => ${sel:"h1.env" | trim || 1 || title}');
  const url = 'http://h/app?env=qa3.baidu.com&x=1';
  const dom = { 'h1.env': '  QA-3 (shared)  ' };
  const select = (css) => dom[css];
  const loaded = R.evaluate(rules, { url, title: 'App', select });
  assert.equal(loaded.title, 'QA-3 (shared)');
  assert.equal(loaded.trace[0].source, 'page');
  const loading = R.evaluate(rules, { url, title: 'App', select: () => undefined });
  assert.equal(loading.title, 'qa3');
  assert.deepEqual([loading.trace[0].used, loading.trace[0].source], [1, 'url']);
  assert.equal(loading.rule.usesPage, true);
});

test('m/re/ extracts part of the text and fails over when it does not match', () => {
  const tpl = '*://*/* => #${sel:.issue|m/#(\\d+)/ || q.id || "?"} $title';
  const { rules } = R.parseRules(tpl);
  const page = (txt, url = 'https://x.com/i?id=7') => ({ url, title: 'T', select: () => txt });
  assert.equal(R.evaluate(rules, page('Issue #128 open')).title, '#128 T');
  assert.equal(R.evaluate(rules, page('no number')).title, '#7 T');
  assert.equal(R.evaluate(rules, page(undefined, 'https://x.com/')).title, '#? T');
});

test('empty result keeps the page title', () => {
  const { rules } = R.parseRules('*://*/* => ${sel:h1 || q.nope}');
  assert.equal(R.evaluate(rules, { url: 'https://a.com/', title: 'Home' }).title, undefined);
});

test('v2 tokens: compose page text, URL pieces and the original title', () => {
  const line = '*://*.baidu.com/* => [{page ".env" or ?env before "."}] {page "h1" max 12} · {path[1]} {{x}}';
  const { rules, errors } = R.parseRules(line);
  assert.deepEqual(errors, []);
  const url = 'https://sandbox01.baidu.com/orders/42?env=qa3.baidu.com';
  const dom = { h1: 'Order #42 from Alice' };
  const r = R.evaluate(rules, { url, title: 'T', select: (c) => dom[c] });
  assert.equal(r.title, '[qa3] Order #42 f… · orders {x}');
  assert.equal(R.evaluate(rules, { url, title: 'T', select: (c) => ({ '.env': 'Prod-A', h1: 'Hi' })[c] }).title, '[Prod-A] Hi · orders {x}');
});

test('v2 host[N] / path[N] segments, negative index, captures', () => {
  const page = { url: 'https://a.sandbox01.baidu.com:8080/x/y/z', title: 'T' };
  const run2 = (tpl) => R.renderRule(R.compileOverride({ title: tpl }), page).title;
  assert.equal(run2('{host[2]}'), 'sandbox01');
  assert.equal(run2('{host[-2]}'), 'baidu');
  assert.equal(run2('{path[-1]}/{path[1]}'), 'z/x');
  assert.equal(run2('{path[9] or "none"}'), 'none');
  assert.equal(run('*://(*).x.com/* => {1 upper}', 'https://qa.x.com/').title, 'QA');
});

test('v2 transforms and errors', () => {
  const page = { url: 'https://x/?id=PROJ-12_draft', title: 'Bug: login - Jira' };
  const run2 = (tpl) => R.renderRule(R.compileOverride({ title: tpl }), page).title;
  assert.equal(run2('{?id match /([A-Z]+-\\d+)/} {title after ": " replace / - Jira$/ ""}'), 'PROJ-12 login');
  assert.equal(run2('{?missing or title before ":"}'), 'Bug');
  assert.throws(() => R.compileTemplate('{nope}'), /unknown source/);
  assert.throws(() => R.compileTemplate('{title'), /unclosed/);
});

test('templateText round-trips v1 and v2 into canonical v2 text', () => {
  for (const [src, want] of [
    ['${sel:"span.owner" || q.env|before:.} · $title', '{page "span.owner" or ?env before "."} · {title}'],
    ['[$1] {host[1]} {{lit}}', '[{1}] {host[1]} {{lit}}'],
    ['{page "a \\"b\\"" match /#(\\d+)/ or "?"}', '{page "a \\"b\\"" match /#(\\d+)/ or "?"}'],
  ]) {
    const text = R.templateText(R.compileTemplate(src));
    assert.equal(text, want);
    assert.equal(R.templateText(R.compileTemplate(text)), want);
  }
});

test('rendered titles use document.title whitespace rules (no write loop)', () => {
  const { rules } = R.parseRules('*://*/* => Mine {page ".missing"}  {?env}\t!');
  assert.equal(R.evaluate(rules, { url: 'https://a.com/?env=qa', title: 'T', select: () => undefined }).title, 'Mine qa !');
  assert.equal(R.evaluate(rules, { url: 'https://a.com/', title: 'T', select: () => '  ' }).title, 'Mine !');
});
