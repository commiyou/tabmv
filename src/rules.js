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
  // $1..$9 ${12} $0/$& whole match  $<name> ${name} named group
  // $title $url $host $path  ${q.KEY} query param (also looks in #hash?query)
  // ${expr|filter|...}: upper lower trim max:N default:TEXT before:X after:X s/re/rep/flags
  // $$ literal $
  const BUILTINS = ['title', 'url', 'host', 'path'];

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

  function lookup(expr, ctx) {
    const m = ctx.match || [];
    if (/^\d+$/.test(expr)) return m[Number(expr)];
    if (expr === '&') return m[0];
    if (expr.startsWith('q.')) return queryParam(ctx.url, expr.slice(2));
    if (m.groups && expr in m.groups) return m.groups[expr];
    if (expr === 'title') return ctx.title;
    if (expr === 'url') return ctx.url;
    if (expr === 'host' || expr === 'path') return urlPart(ctx.url, expr);
    return undefined;
  }

  function applyFilter(v, f) {
    const s = v == null ? '' : String(v);
    if (f.sed) return s.replace(f.sed.re, f.sed.rep);
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
    throw new Error('unknown filter "' + f.name + '"');
  }

  // Compile a template into a list of parts: strings and {expr, filters}.
  function compileTemplate(tpl) {
    const parts = [];
    let lit = '';
    let i = 0;
    const push = (p) => {
      if (lit) parts.push(lit);
      lit = '';
      parts.push(p);
    };
    while (i < tpl.length) {
      const c = tpl[i];
      if (c !== '$') {
        lit += c;
        i++;
        continue;
      }
      const n = tpl[i + 1];
      if (n === '$') {
        lit += '$';
        i += 2;
      } else if (n === '&' || (n >= '0' && n <= '9')) {
        push({ expr: n === '&' ? '&' : n, filters: [] });
        i += 2;
      } else if (n === '<') {
        const end = tpl.indexOf('>', i);
        if (end < 0) throw new Error('unclosed "$<"');
        push({ expr: tpl.slice(i + 2, end), filters: [], named: true });
        i = end + 1;
      } else if (n === '{') {
        i += 2;
        let expr = '';
        while (i < tpl.length && tpl[i] !== '|' && tpl[i] !== '}') expr += tpl[i++];
        const filters = [];
        while (tpl[i] === '|') {
          i++;
          if (tpl[i] === 's' && tpl[i + 1] && /[^\w\s|}]/.test(tpl[i + 1])) {
            const d = tpl[i + 1];
            i += 2;
            const fields = [];
            for (let k = 0; k < 2; k++) {
              let f = '';
              while (i < tpl.length && tpl[i] !== d) {
                if (tpl[i] === '\\' && tpl[i + 1] === d) {
                  f += d;
                  i += 2;
                } else f += tpl[i++];
              }
              if (tpl[i] !== d) throw new Error('unterminated s' + d + '...' + d + ' filter');
              i++;
              fields.push(f);
            }
            let fl = '';
            while (/[gimsu]/.test(tpl[i] || '')) fl += tpl[i++];
            filters.push({ sed: { re: new RegExp(fields[0], fl), rep: fields[1] } });
          } else {
            let f = '';
            while (i < tpl.length && tpl[i] !== '|' && tpl[i] !== '}') f += tpl[i++];
            const colon = f.indexOf(':');
            const name = colon < 0 ? f.trim() : f.slice(0, colon).trim();
            const arg = colon < 0 ? '' : f.slice(colon + 1);
            if (!['upper', 'lower', 'trim', 'max', 'default', 'before', 'after'].includes(name))
              throw new Error('unknown filter "' + name + '"');
            filters.push({ name, arg });
          }
        }
        if (tpl[i] !== '}') throw new Error('unclosed "${"');
        i++;
        push({ expr: expr.trim(), filters });
      } else {
        const m = /^[A-Za-z_]\w*/.exec(tpl.slice(i + 1));
        if (m && BUILTINS.includes(m[0])) {
          push({ expr: m[0], filters: [] });
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

  function renderTemplate(compiled, ctx) {
    let out = '';
    for (const p of compiled) {
      if (typeof p === 'string') {
        out += p;
        continue;
      }
      let v = lookup(p.expr, ctx);
      for (const f of p.filters) v = applyFilter(v, f);
      out += v == null ? '' : String(v);
    }
    return out;
  }

  function checkVars(compiled, re, where) {
    const groups = re ? (re.source.match(/\(\?<([A-Za-z_]\w*)>/g) || []).map((g) => g.slice(3, -1)) : [];
    for (const p of compiled) {
      if (typeof p === 'string') continue;
      const e = p.expr;
      if (/^\d+$/.test(e) || e === '&' || e.startsWith('q.') || BUILTINS.includes(e) || groups.includes(e)) continue;
      throw new Error('unknown variable "' + e + '" in ' + where);
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
    const rule = { line, field, kind, re, pattern: left };
    const title = titleRaw.trim();
    if (title) {
      rule.title = compileTemplate(title);
      checkVars(rule.title, re, 'title');
    }
    for (const o of opts) {
      if (!o.trim()) continue;
      const eq = o.indexOf('=');
      const key = (eq < 0 ? o : o.slice(0, eq)).trim();
      if (!OPTION_KEYS.includes(key)) throw new Error('unknown option "' + key + '" (use icon= or color=)');
      const val = eq < 0 ? '' : o.slice(eq + 1).trim();
      rule[key] = compileTemplate(val);
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
  function renderRule(rule, page, match) {
    const ctx = { match: match || [page.url], url: page.url, title: page.title };
    const out = { rule };
    if (rule.title) out.title = renderTemplate(rule.title, ctx);
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
    const rule = { line: '(manual)', manual: true };
    for (const k of ['title', 'icon', 'color']) {
      if (o && o[k] && String(o[k]).trim()) {
        rule[k] = compileTemplate(String(o[k]).trim());
        checkVars(rule[k], null, k);
      }
    }
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
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TabRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
