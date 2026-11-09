/*
 * tabmv rule engine. Pure functions, no chrome.* APIs, so the same file runs in
 * content scripts, extension pages, the service worker and Node tests.
 *
 * Rule line:   <pattern> => <title template> [; icon=<v>] [; color=<v>]
 * Pattern:     zsh/zmv-style glob (anchored, full match)  e.g. *[?&]env=(*).baidu.com*
 *              or JS regex literal (search)              e.g. /jira\/browse\/([A-Z]+-\d+)/i
 *              optional field prefix: url: (default) or title:
 */
(function (root) {
  'use strict';

  const ANY = '[\\s\\S]';

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  // ---------- glob -> RegExp (zsh / zmv flavoured) ----------
  // *  any string (lazy)      ?  any one char      [abc] [!a-z] [^a-z]  char class
  // {a,b}  alternation         (a|b) (*)  capture group, like zmv
  // \x literal x              (#i) prefix: case-insensitive (zsh globbing flag)
  // If the pattern has no explicit (...) group, every * and ? captures (zmv -W).
  function compileGlob(glob) {
    let flags = '';
    let pat = glob;
    if (pat.startsWith('(#i)')) {
      flags = 'i';
      pat = pat.slice(4);
    }
    const hasGroup = /(^|[^\\])\(/.test(pat);
    const auto = !hasGroup;
    let i = 0;

    function parseClass() {
      // pat[i-1] === '['
      let j = i;
      let neg = '';
      if (pat[j] === '!' || pat[j] === '^') {
        neg = '^';
        j++;
      }
      let body = '';
      let first = true;
      while (j < pat.length && (pat[j] !== ']' || first)) {
        const c = pat[j];
        if (c === '\\' && j + 1 < pat.length) {
          body += '\\' + pat[j + 1];
          j += 2;
        } else {
          body += c === '\\' || c === '[' || c === ']' || c === '^' ? '\\' + c : c;
          j++;
        }
        first = false;
      }
      if (j >= pat.length) return null; // unclosed: treat '[' literally
      i = j + 1;
      return '[' + neg + body + ']';
    }

    function parseSeq(stops) {
      let out = '';
      while (i < pat.length) {
        const c = pat[i];
        if (stops.includes(c)) break;
        i++;
        switch (c) {
          case '\\':
            out += i < pat.length ? escapeRe(pat[i++]) : '\\\\';
            break;
          case '*':
            while (pat[i] === '*') i++;
            out += auto ? '(' + ANY + '*?)' : ANY + '*?';
            break;
          case '?':
            out += auto ? '(' + ANY + ')' : ANY;
            break;
          case '[': {
            const cls = parseClass();
            out += cls === null ? '\\[' : auto ? '(' + cls + ')' : cls;
            break;
          }
          case '{': {
            const alts = [parseSeq([',', '}'])];
            while (pat[i] === ',') {
              i++;
              alts.push(parseSeq([',', '}']));
            }
            if (pat[i] !== '}') throw new Error('unclosed "{" in glob');
            i++;
            out += '(?:' + alts.join('|') + ')';
            break;
          }
          case '(': {
            const alts = [parseSeq(['|', ')'])];
            while (pat[i] === '|') {
              i++;
              alts.push(parseSeq(['|', ')']));
            }
            if (pat[i] !== ')') throw new Error('unclosed "(" in glob');
            i++;
            out += '(' + alts.join('|') + ')';
            break;
          }
          default:
            out += escapeRe(c);
        }
      }
      return out;
    }

    const source = parseSeq([]);
    if (i < pat.length) throw new Error('unexpected "' + pat[i] + '" in glob');
    return new RegExp('^' + source + '$', flags);
  }

  function compilePattern(text) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(text);
    if (m) {
      const bad = m[2].replace(/[imsu]/g, '');
      if (bad) throw new Error('unsupported regex flag "' + bad + '" (use i, m, s, u)');
      return { kind: 'regex', re: new RegExp(m[1], m[2]) };
    }
    return { kind: 'glob', re: compileGlob(text) };
  }

  // ---------- template ----------
  // $1..$9 ${12} $& whole match   $<name> ${name} named group   $$ literal $
  // $title $url $host $path       ${q.KEY} query param (also #/route?KEY=)
  // ${sel:CSS} / ${sel:"CSS"}     text of the first element matching CSS on the page
  // ${a || b || "text"}           fallback: the first non-empty alternative wins
  // filters ${x|f|f}: upper lower trim max:N default:T before:X after:X s/re/rep/g m/re/
  const BUILTINS = ['title', 'url', 'host', 'path'];
  const FILTERS = ['upper', 'lower', 'trim', 'max', 'default', 'before', 'after'];

  function queryParam(url, key) {
    try {
      const u = new URL(url);
      const v = u.searchParams.get(key);
      if (v !== null) return v;
      const q = u.hash.indexOf('?');
      if (q >= 0) return new URLSearchParams(u.hash.slice(q + 1)).get(key) ?? undefined;
    } catch (_) {
      /* not a URL */
    }
    return undefined;
  }

  function urlPart(url, part) {
    try {
      const u = new URL(url);
      return part === 'host' ? u.host : u.pathname;
    } catch (_) {
      return undefined;
    }
  }

  function lookup(src, ctx) {
    if (src.lit !== undefined) return src.lit;
    if (src.sel !== undefined) return ctx.select ? ctx.select(src.sel) : undefined;
    const e = src.expr;
    const m = ctx.match || [];
    if (/^\d+$/.test(e)) return m[Number(e)];
    if (e === '&') return m[0];
    if (e.startsWith('q.')) return queryParam(ctx.url, e.slice(2));
    if (m.groups && e in m.groups) return m.groups[e];
    if (e === 'title') return ctx.title;
    if (e === 'url') return ctx.url;
    if (e === 'host' || e === 'path') {
      const v = urlPart(ctx.url, e);
      if (src.index === undefined || v === undefined) return v;
      const segs = e === 'host' ? v.replace(/:\d+$/, '').split('.') : v.split('/').filter(Boolean);
      return segs[src.index > 0 ? src.index - 1 : segs.length + src.index];
    }
    return undefined;
  }

  function applyFilter(v, f) {
    const s = v == null ? '' : String(v);
    if (f.sed) return s.replace(f.sed.re, f.sed.rep);
    if (f.m) {
      const r = f.m.exec(s);
      return r ? r[1] ?? r[0] : '';
    }
    switch (f.name) {
      case 'upper':
        return s.toUpperCase();
      case 'lower':
        return s.toLowerCase();
      case 'trim':
        return s.trim();
      case 'max': {
        const n = Number(f.arg);
        return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
      }
      case 'default':
        return s === '' ? f.arg : s;
      case 'before': {
        const k = s.indexOf(f.arg);
        return k < 0 ? s : s.slice(0, k);
      }
      case 'after': {
        const k = s.indexOf(f.arg);
        return k < 0 ? s : s.slice(k + f.arg.length);
      }
    }
    return s;
  }

  // ---------- v2 tokens: {page ".env" before "." or ?env or "dev"} ----------
  // A token is one or more sources joined by "or"; the first non-empty wins.
  // Sources:    page "css"   ?key   host  host[1]  path  path[2]  title  url  1  <name>  "text"
  // Transforms: before "x"  after "x"  match /re/  replace /re/ "to"  upper  lower  trim  max 20
  const V2_WORDS = ['title', 'url', 'host', 'path'];

  function parseV2Token(tpl, start) {
    let i = start;
    const ws = () => {
      while (tpl[i] === ' ' || tpl[i] === '\t') i++;
    };
    const fail = (what) => {
      throw new Error(what + ' at "' + tpl.slice(i, i + 12) + '" in {…}');
    };
    const str = () => {
      ws();
      if (tpl[i] !== '"') fail('expected "text"');
      let s = '';
      i++;
      while (i < tpl.length && tpl[i] !== '"') {
        if (tpl[i] === '\\' && (tpl[i + 1] === '"' || tpl[i + 1] === '\\')) i++;
        s += tpl[i++];
      }
      if (tpl[i] !== '"') fail('unclosed quote');
      i++;
      return s;
    };
    const regex = () => {
      ws();
      if (tpl[i] !== '/') fail('expected /regex/');
      let s = '';
      i++;
      while (i < tpl.length && tpl[i] !== '/') {
        if (tpl[i] === '\\' && i + 1 < tpl.length) s += tpl[i++];
        s += tpl[i++];
      }
      if (tpl[i] !== '/') fail('unclosed /regex/');
      i++;
      let fl = '';
      while (/[gimsu]/.test(tpl[i] || '')) fl += tpl[i++];
      return new RegExp(s, fl);
    };
    const word = () => {
      const m = /^[A-Za-z]+/.exec(tpl.slice(i));
      if (m) i += m[0].length;
      return m ? m[0] : '';
    };
    const source = () => {
      ws();
      const c = tpl[i];
      if (c === '"') return { lit: str() };
      if (c === '?') {
        const m = /^\?([^\s{}"]+)/.exec(tpl.slice(i));
        if (!m) fail('expected ?param');
        i += m[0].length;
        return { expr: 'q.' + m[1] };
      }
      if (c === '<') {
        const end = tpl.indexOf('>', i);
        if (end < 0) fail('unclosed <name>');
        const name = tpl.slice(i + 1, end);
        i = end + 1;
        return { expr: name };
      }
      const d = /^\d+/.exec(tpl.slice(i));
      if (d) {
        i += d[0].length;
        return { expr: d[0] };
      }
      const w = word();
      if (w === 'page') return { sel: str() };
      if (V2_WORDS.includes(w)) {
        const ix = /^\[(-?\d+)\]/.exec(tpl.slice(i));
        if (ix && (w === 'host' || w === 'path')) {
          i += ix[0].length;
          return { expr: w, index: Number(ix[1]) };
        }
        return { expr: w };
      }
      return fail('unknown source "' + w + '"');
    };
    const alts = [];
    for (;;) {
      const alt = source();
      alt.filters = [];
      for (;;) {
        ws();
        if (tpl[i] === '}' || i >= tpl.length) break;
        const save = i;
        const w = word();
        if (w === 'or') break;
        if (w === 'before' || w === 'after' || w === 'default') alt.filters.push({ name: w, arg: str() });
        else if (w === 'match') {
          const re = regex();
          alt.filters.push({ m: new RegExp(re.source, re.flags.replace('g', '')) });
        } else if (w === 'replace') {
          const re = regex();
          alt.filters.push({ sed: { re, rep: str() } });
        } else if (w === 'max') {
          ws();
          const n = /^\d+/.exec(tpl.slice(i));
          if (!n) fail('expected a number');
          i += n[0].length;
          alt.filters.push({ name: 'max', arg: n[0] });
        } else if (w === 'upper' || w === 'lower' || w === 'trim') alt.filters.push({ name: w, arg: '' });
        else {
          i = save;
          fail('unknown word');
        }
      }
      alts.push(alt);
      if (tpl[i] === '}') break;
      if (i >= tpl.length) throw new Error('unclosed "{" in title (write {{ for a literal brace)');
    }
    return { alts, end: i + 1 };
  }

  // ---------- serialize back to v2 text (used by the side panel) ----------
  const quoteStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const reText = (re) => '/' + re.source + '/' + re.flags;

  function altText(a) {
    let s;
    if (a.lit !== undefined) s = quoteStr(a.lit);
    else if (a.sel !== undefined) s = 'page ' + quoteStr(a.sel);
    else if (a.expr.startsWith('q.')) s = '?' + a.expr.slice(2);
    else if (a.expr === '&') s = '0';
    else if (/^\d+$/.test(a.expr) || V2_WORDS.includes(a.expr)) s = a.expr + (a.index !== undefined ? '[' + a.index + ']' : '');
    else s = '<' + a.expr + '>';
    for (const f of a.filters || []) {
      if (f.m) s += ' match ' + reText(f.m);
      else if (f.sed) s += ' replace ' + reText(f.sed.re) + ' ' + quoteStr(f.sed.rep);
      else if (f.name === 'max') s += ' max ' + f.arg;
      else if (f.arg !== '' || ['before', 'after', 'default'].includes(f.name)) s += ' ' + f.name + ' ' + quoteStr(f.arg);
      else s += ' ' + f.name;
    }
    return s;
  }

  const tokenText = (alts) => '{' + alts.map(altText).join(' or ') + '}';
  const escapeLiteral = (s) => String(s).replace(/\{/g, '{{').replace(/\}/g, '}}');

  function templateText(parts) {
    return parts.map((p) => (typeof p === 'string' ? escapeLiteral(p) : tokenText(p.alts))).join('');
  }

  // Compiles to a list of strings and {alts: [{expr|sel|lit, filters}]}.
  // Accepts v2 {…} tokens and the older $1 / ${…} forms.
  function compileTemplate(tpl) {
    const parts = [];
    let lit = '';
    let i = 0;
    const push = (alts) => {
      if (lit) parts.push(lit);
      lit = '';
      parts.push({ alts });
    };
    const skipSpaces = () => {
      while (tpl[i] === ' ') i++;
    };
    const quoted = () => {
      // tpl[i] === '"'
      let s = '';
      i++;
      while (i < tpl.length && tpl[i] !== '"') {
        if (tpl[i] === '\\' && tpl[i + 1] === '"') i++;
        s += tpl[i++];
      }
      if (tpl[i] !== '"') throw new Error('unclosed quote in template');
      i++;
      return s;
    };
    const until = () => {
      let s = '';
      while (i < tpl.length && tpl[i] !== '|' && tpl[i] !== '}') s += tpl[i++];
      return s;
    };
    const delimited = (d) => {
      let s = '';
      while (i < tpl.length && tpl[i] !== d) {
        if (tpl[i] === '\\' && tpl[i + 1] === d) {
          s += d;
          i += 2;
        } else s += tpl[i++];
      }
      if (tpl[i] !== d) throw new Error('unterminated ' + d + '...' + d + ' filter');
      i++;
      return s;
    };
    const source = () => {
      skipSpaces();
      if (tpl[i] === '"') return { lit: quoted() };
      if (tpl.startsWith('sel:', i)) {
        i += 4;
        skipSpaces();
        const sel = tpl[i] === '"' ? quoted() : until().trim();
        if (!sel) throw new Error('empty selector in sel:');
        return { sel };
      }
      return { expr: until().trim() };
    };
    const filter = () => {
      skipSpaces();
      const k = tpl[i];
      const d = tpl[i + 1];
      if ((k === 's' || k === 'm') && d && /[^\w\s|}]/.test(d)) {
        i += 2;
        const re = delimited(d);
        const rep = k === 's' ? delimited(d) : null;
        let fl = '';
        while (/[gimsu]/.test(tpl[i] || '')) fl += tpl[i++];
        if (k === 'm') fl = fl.replace('g', '');
        return k === 's' ? { sed: { re: new RegExp(re, fl), rep } } : { m: new RegExp(re, fl) };
      }
      const f = until();
      const colon = f.indexOf(':');
      const name = (colon < 0 ? f : f.slice(0, colon)).trim();
      if (!FILTERS.includes(name)) throw new Error('unknown filter "' + name + '"');
      return { name, arg: colon < 0 ? '' : f.slice(colon + 1).trimEnd() };
    };

    while (i < tpl.length) {
      const c = tpl[i];
      const n = tpl[i + 1];
      if ((c === '{' && n === '{') || (c === '}' && n === '}')) {
        lit += c;
        i += 2;
      } else if (c === '{') {
        const r = parseV2Token(tpl, i + 1);
        push(r.alts);
        i = r.end;
      } else if (c !== '$') {
        lit += c;
        i++;
      } else if (n === '$') {
        lit += '$';
        i += 2;
      } else if (n === '&' || (n >= '0' && n <= '9')) {
        push([{ expr: n, filters: [] }]);
        i += 2;
      } else if (n === '<') {
        const end = tpl.indexOf('>', i);
        if (end < 0) throw new Error('unclosed "$<"');
        push([{ expr: tpl.slice(i + 2, end), filters: [] }]);
        i = end + 1;
      } else if (n === '{') {
        i += 2;
        const alts = [];
        for (;;) {
          const alt = source();
          alt.filters = [];
          let more = false;
          skipSpaces();
          while (tpl[i] === '|') {
            if (tpl[i + 1] === '|') {
              i += 2;
              more = true;
              break;
            }
            i++;
            alt.filters.push(filter());
            skipSpaces();
          }
          alts.push(alt);
          if (!more) break;
        }
        if (tpl[i] !== '}') throw new Error('unclosed "${"');
        i++;
        push(alts);
      } else {
        const m = /^[A-Za-z_]\w*/.exec(tpl.slice(i + 1));
        if (m && BUILTINS.includes(m[0])) {
          push([{ expr: m[0], filters: [] }]);
          i += 1 + m[0].length;
        } else {
          lit += '$';
          i++;
        }
      }
    }
    if (lit) parts.push(lit);
    return parts;
  }

  // ctx: {match, url, title, select(css) -> text|undefined, trace?: []}
  // trace records which alternative each ${...} used, for "fell back to URL" hints.
  function renderTemplate(compiled, ctx) {
    let out = '';
    for (const p of compiled) {
      if (typeof p === 'string') {
        out += p;
        continue;
      }
      let used = -1;
      for (let k = 0; k < p.alts.length; k++) {
        const a = p.alts[k];
        let v = lookup(a, ctx);
        for (const f of a.filters) v = applyFilter(v, f);
        const s = v == null ? '' : String(v);
        if (s.trim() !== '') {
          out += s;
          used = k;
          break;
        }
      }
      if (ctx.trace) ctx.trace.push({ used, alts: p.alts.length, source: used >= 0 ? describeSource(p.alts[used]) : null });
    }
    return out;
  }

  function describeSource(a) {
    if (a.lit !== undefined) return 'text';
    if (a.sel !== undefined) return 'page';
    if (a.expr === 'title') return 'title';
    return 'url';
  }

  function usesPage(compiled) {
    return Boolean(compiled) && compiled.some((p) => typeof p !== 'string' && p.alts.some((a) => a.sel !== undefined));
  }

  function checkVars(compiled, re, where) {
    const groups = re ? (re.source.match(/\(\?<([A-Za-z_]\w*)>/g) || []).map((g) => g.slice(3, -1)) : [];
    for (const p of compiled) {
      if (typeof p === 'string') continue;
      for (const a of p.alts) {
        if (a.lit !== undefined || a.sel !== undefined) continue;
        const e = a.expr;
        if (/^\d+$/.test(e) || e === '&' || e.startsWith('q.') || BUILTINS.includes(e) || groups.includes(e)) continue;
        throw new Error('unknown variable "' + e + '" in ' + where);
      }
    }
  }

  // ---------- rules ----------
  function splitUnescaped(s, sep) {
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === sep) {
        cur += sep;
        i++;
      } else if (s[i] === sep) {
        out.push(cur);
        cur = '';
      } else cur += s[i];
    }
    out.push(cur);
    return out;
  }

  const OPTION_KEYS = ['icon', 'color'];

  function compileRule(line) {
    const arrow = /\s=>(\s|$)/.exec(line);
    if (!arrow) throw new Error('missing " => "');
    let left = line.slice(0, arrow.index).trim();
    const right = line.slice(arrow.index + arrow[0].length);
    let field = 'url';
    const fm = /^(url|title):/.exec(left);
    if (fm) {
      field = fm[1];
      left = left.slice(fm[0].length);
    }
    if (!left) throw new Error('empty pattern');
    const { kind, re } = compilePattern(left);
    const [titleRaw, ...opts] = splitUnescaped(right, ';');
    const rule = { line, field, kind, re, pattern: left, raw: { pattern: line.slice(0, arrow.index).trim(), title: titleRaw.trim() } };
    const title = titleRaw.trim();
    if (title) {
      rule.title = compileTemplate(title);
      checkVars(rule.title, re, 'title');
      rule.usesPage = usesPage(rule.title);
    }
    for (const o of opts) {
      if (!o.trim()) continue;
      const eq = o.indexOf('=');
      const key = (eq < 0 ? o : o.slice(0, eq)).trim();
      if (!OPTION_KEYS.includes(key)) throw new Error('unknown option "' + key + '" (use icon= or color=)');
      const val = eq < 0 ? '' : o.slice(eq + 1).trim();
      rule[key] = compileTemplate(val);
      rule.raw[key] = val;
      checkVars(rule[key], re, key);
    }
    return rule;
  }

  function parseRules(text) {
    const rules = [];
    const errors = [];
    String(text || '')
      .split(/\r?\n/)
      .forEach((raw, idx) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        try {
          const r = compileRule(line);
          r.lineNo = idx + 1;
          rules.push(r);
        } catch (e) {
          errors.push({ lineNo: idx + 1, line, message: e.message });
        }
      });
    return { rules, errors };
  }

  // Stable color from a string: same env name -> same color, every time.
  function autoColor(key) {
    let h = 0x811c9dc5;
    for (const ch of String(key)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 'hsl(' + (h % 360) + ', 70%, 45%)';
  }

  // Apply a compiled rule (or a manual override, which has no re) to a page.
  // page: {url, title, select?}. An empty rendered title means "keep the page title".
  function renderRule(rule, page, match) {
    const trace = [];
    const ctx = { match: match || [page.url], url: page.url, title: page.title, select: page.select, trace };
    const out = { rule };
    if (rule.title) {
      // Same normalization as the document.title getter (strip and collapse
      // ASCII whitespace). Otherwise "A  B " never equals what the page reports
      // back, and keeping the title applied turns into an endless write loop.
      const t = renderTemplate(rule.title, ctx).replace(/[\t\n\f\r ]+/g, ' ').trim();
      if (t !== '') out.title = t;
    }
    out.trace = trace;
    ctx.trace = null;
    if (rule.icon) out.icon = renderTemplate(rule.icon, ctx);
    if (rule.color) {
      const c = renderTemplate(rule.color, ctx);
      out.color = c === 'auto' ? autoColor((ctx.match[1] ?? out.title ?? page.title) || '') : c;
    }
    return out;
  }

  // First matching rule wins (top to bottom).
  function evaluate(rules, page) {
    for (const rule of rules) {
      const subject = rule.field === 'title' ? page.title : page.url;
      const m = rule.re.exec(subject || '');
      if (m) return renderRule(rule, page, m);
    }
    return null;
  }

  // Manual per-tab override {title, icon, color} given as raw template strings.
  function compileOverride(o) {
    const rule = { line: '(manual)', manual: true, raw: o };
    for (const k of ['title', 'icon', 'color']) {
      if (o && o[k] && String(o[k]).trim()) {
        rule[k] = compileTemplate(String(o[k]).trim());
        checkVars(rule[k], null, k);
      }
    }
    rule.usesPage = usesPage(rule.title);
    return rule;
  }

  // Build a rule line from form fields (used by the popup "save as rule").
  function formatRule({ pattern, title, icon, color }) {
    const esc = (s) => String(s).replace(/;/g, '\\;');
    let line = pattern.trim() + ' => ' + esc((title || '').trim());
    if (icon && icon.trim()) line += ' ; icon=' + esc(icon.trim());
    if (color && color.trim()) line += ' ; color=' + esc(color.trim());
    return line;
  }

  function suggestPatterns(url) {
    try {
      const u = new URL(url);
      const list = ['*://' + u.host + '/*'];
      if (u.pathname.length > 1) list.push('*://' + u.host + u.pathname.replace(/[*?[\]{}()\\]/g, '\\$&') + '*');
      const host = u.hostname.split('.');
      if (host.length > 2) list.push('*://*.' + host.slice(-2).join('.') + '/*');
      return list;
    } catch (_) {
      return [];
    }
  }

  function queryKeys(url) {
    const keys = [];
    try {
      const u = new URL(url);
      for (const [k, v] of u.searchParams) keys.push([k, v]);
      const q = u.hash.indexOf('?');
      if (q >= 0) for (const [k, v] of new URLSearchParams(u.hash.slice(q + 1))) keys.push([k, v]);
    } catch (_) {
      /* ignore */
    }
    return keys;
  }

  const api = {
    compileGlob,
    compilePattern,
    compileTemplate,
    renderTemplate,
    compileRule,
    parseRules,
    evaluate,
    renderRule,
    compileOverride,
    formatRule,
    suggestPatterns,
    queryKeys,
    autoColor,
    usesPage,
    tokenText,
    templateText,
    escapeLiteral,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TabRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
