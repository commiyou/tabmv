/* Applies the matching rule (or the tab's manual override) to this page and
 * keeps it applied while the page rewrites its own title or favicon. */
(() => {
  'use strict';
  // Reloading or updating the extension leaves the old content script running
  // ("orphaned") next to the newly injected one. Two copies fighting over
  // document.title froze pages, so the new copy tells any old copy to stop.
  // These identifiers keep the project's first name (tabmv) on purpose: copies of
  // older versions still running in open pages only understand these names.
  const TAKEOVER = 'tabmv:takeover';
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  let dead = false;
  const alive = () => {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch (_) {}
    teardown();
    return false;
  };

  const MARK = 'data-tabmv';
  const OFF_REL = 'data-tabmv-rel';
  let rules = [];
  let override = null; // compiled manual override
  let pageTitle = document.title; // the page's own title, before we touch it
  let result = null; // last evaluated {title, icon, color, rule}
  let wantedTitle = null;
  let iconKey = null; // identifies the icon we generated
  let iconHref = null;
  let origIconHref = null;
  let iconBusy = 0;

  // A page (or another extension) that keeps resetting the title would turn
  // "keep our title" into an endless write loop. Allow a burst, then back off.
  const writes = [];
  let backoffUntil = 0;
  function mayWrite() {
    const now = Date.now();
    if (now < backoffUntil) return false;
    while (writes.length && now - writes[0] > 2000) writes.shift();
    if (writes.length >= 15) {
      backoffUntil = now + 10000;
      writes.length = 0;
      console.warn('[telltab] this page keeps changing its title or icon; pausing for 10s');
      return false;
    }
    writes.push(now);
    return true;
  }

  // ---------- favicon ----------
  function pageIconLinks() {
    return [...document.querySelectorAll('link[rel~="icon" i], link[' + OFF_REL + ']')].filter((l) => !l.hasAttribute(MARK));
  }

  function currentOrigIcon() {
    const live = [...document.querySelectorAll('link[rel~="icon" i]')].filter((l) => !l.hasAttribute(MARK));
    if (live.length) return live[live.length - 1].href;
    return origIconHref || location.origin + '/favicon.ico';
  }

  function setIconLink(href) {
    if (!mayWrite()) return;
    for (const l of pageIconLinks()) {
      if (!l.hasAttribute(OFF_REL)) {
        l.setAttribute(OFF_REL, l.getAttribute('rel'));
        l.setAttribute('rel', 'tabmv-disabled');
      }
    }
    let ours = document.head && document.head.querySelector('link[' + MARK + ']');
    if (!ours) {
      if (!document.head) return;
      ours = document.createElement('link');
      ours.setAttribute(MARK, '');
      ours.rel = 'icon';
      document.head.appendChild(ours);
    }
    if (ours.getAttribute('href') !== href) ours.setAttribute('href', href);
  }

  function restoreIcon() {
    document.querySelectorAll('link[' + MARK + ']').forEach((l) => l.remove());
    for (const l of document.querySelectorAll('link[' + OFF_REL + ']')) {
      l.setAttribute('rel', l.getAttribute(OFF_REL));
      l.removeAttribute(OFF_REL);
    }
    iconKey = iconHref = null;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  const isUrl = (s) => /^(https?:|data:|blob:|chrome-extension:)/.test(s);
  const isPictographic = (s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);

  async function drawIcon({ icon, color, title }) {
    const S = 64;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const text = (t, size, fill) => {
      g.font = size + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = fill;
      g.fillText(t, S / 2, S / 2 + size * 0.06);
    };
    const badge = (bg, t) => {
      g.fillStyle = bg;
      g.beginPath();
      g.roundRect(0, 0, S, S, 14);
      g.fill();
      const chars = [...t];
      text(chars.join('').toUpperCase(), chars.length > 1 ? 30 : 44, '#fff');
    };

    let dot = Boolean(color);
    if (!icon || icon === 'original' || isUrl(icon)) {
      const src = await chrome.runtime.sendMessage({ type: 'fetchImage', url: icon && isUrl(icon) ? icon : currentOrigIcon() });
      const img = await loadImage(src);
      if (img) g.drawImage(img, 0, 0, S, S);
      else {
        badge(color || '#777', [...(title || location.hostname || '?')][0] || '?');
        dot = false;
      }
    } else if (icon === 'letter' || !isPictographic(icon)) {
      const t = icon === 'letter' ? [...(title || '?')][0] : [...icon].slice(0, 2).join('');
      badge(color || TabRules.autoColor(t), t);
      dot = false;
    } else {
      text(icon, 54, '#000');
    }
    if (dot) {
      g.beginPath();
      g.arc(S - 16, S - 16, 15, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = '#fff';
      g.stroke();
    }
    return c.toDataURL('image/png');
  }

  async function applyIcon(r) {
    if (!r || (!r.icon && !r.color) || r.icon === 'none') {
      if (iconKey) restoreIcon();
      return;
    }
    const base = !r.icon || r.icon === 'original' ? currentOrigIcon() : '';
    const key = JSON.stringify([r.icon, r.color, r.icon === 'letter' ? r.title : '', base]);
    if (key === iconKey && iconHref) return setIconLink(iconHref);
    if (base) origIconHref = base;
    iconKey = key;
    const ticket = ++iconBusy;
    const href = await drawIcon(r);
    if (ticket !== iconBusy) return; // superseded by a newer request
    iconHref = href;
    setIconLink(href);
  }

  // ---------- page content ----------
  // ${sel:...} reads live page text. Until the element exists (page still
  // loading, SPA not rendered yet) the template falls back to its next option,
  // and a throttled body observer re-renders once the element shows up.
  function select(css) {
    try {
      const el = document.querySelector(css);
      if (el) readEls.add(el);
      return TabPicker.textOf(el);
    } catch (_) {
      return undefined;
    }
  }

  // Elements read by the current rule. Watch the body for elements being
  // added or replaced (childList only), and the found elements for text edits.
  // Recompute at most every 300ms; the callback itself does no work.
  let bodyMo = null;
  let bodyTimer = 0;
  let readEls = new Set();
  let watchedEls = [];
  function onBodyMutate() {
    if (bodyTimer || dead) return;
    bodyTimer = setTimeout(() => {
      bodyTimer = 0;
      if (alive()) apply();
    }, 300);
  }
  function watchBody(on) {
    if (!on || !document.body) {
      if (bodyMo) bodyMo.disconnect();
      bodyMo = null;
      watchedEls = [];
      return;
    }
    const els = [...readEls];
    if (bodyMo && els.length === watchedEls.length && els.every((e, i) => e === watchedEls[i])) return;
    if (bodyMo) bodyMo.disconnect();
    bodyMo = new MutationObserver(onBodyMutate);
    bodyMo.observe(document.body, { childList: true, subtree: true });
    for (const e of els) bodyMo.observe(e, { childList: true, subtree: true, characterData: true });
    watchedEls = els;
  }

  // ---------- title ----------
  function compute() {
    const page = { url: location.href, title: pageTitle, select };
    try {
      if (override) return TabRules.renderRule(override, page);
      return TabRules.evaluate(rules, page);
    } catch (e) {
      console.warn('[telltab]', e);
      return null;
    }
  }

  function apply() {
    // Before the parser reaches <title>, setting document.title would create a
    // second <title> that hides the page's real one; wait for DOMContentLoaded.
    if (dead || (document.readyState === 'loading' && !document.querySelector('title'))) return;
    readEls = new Set();
    result = compute();
    watchBody(Boolean(result && result.rule && result.rule.usesPage));
    const t = result && result.title !== undefined ? result.title : null;
    if (t !== null) {
      if (t !== wantedTitle) backoffUntil = 0; // our own title changed: try again
      wantedTitle = t;
      if (document.title !== t && mayWrite()) document.title = t;
    } else if (wantedTitle !== null) {
      wantedTitle = null;
      if (document.title !== pageTitle) document.title = pageTitle;
    }
    applyIcon(result);
  }

  // Watch <head>: the page changing its title/favicon must not undo ours.
  let scheduled = false;
  function onMutate() {
    if (!alive()) return;
    const cur = document.title;
    if (wantedTitle === null || cur !== wantedTitle) {
      if (cur !== pageTitle) pageTitle = cur;
    }
    if (scheduled) return;
    scheduled = true;
    // A macrotask, so a page that fights back cannot trap us in a microtask loop.
    setTimeout(() => {
      scheduled = false;
      if (dead) return;
      if (wantedTitle !== null && document.title !== wantedTitle) apply();
      else if (iconHref) {
        const ours = document.head && document.head.querySelector('link[' + MARK + ']');
        const stray = [...document.querySelectorAll('link[rel~="icon" i]')].some((l) => !l.hasAttribute(MARK));
        if (!ours || stray) applyIcon(result);
      }
    }, 0);
  }

  let headMo = null;
  function observeHead() {
    if (dead) return;
    if (!document.head) {
      const mo = new MutationObserver(() => {
        if (document.head) {
          mo.disconnect();
          observeHead();
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
      return;
    }
    headMo = new MutationObserver(onMutate);
    headMo.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel'] });
    pageTitle = document.title || pageTitle;
    apply();
  }

  async function load() {
    if (!alive()) return;
    try {
      rules = TabRules.parseRules(await TabStore.loadRulesText()).rules;
      const ov = await chrome.runtime.sendMessage({ type: 'getOverride' });
      override = ov ? TabRules.compileOverride(ov) : null;
    } catch (e) {
      console.warn('[telltab]', e);
    }
    if (document.head) apply();
  }

  // Render a candidate rule against this live page for the side panel preview.
  async function preview(msg) {
    const page = { url: location.href, title: pageTitle, select };
    let r;
    try {
      if (msg.override) r = TabRules.renderRule(TabRules.compileOverride(msg.override), page);
      else {
        const rule = TabRules.compileRule(msg.line);
        const m = rule.re.exec(rule.field === 'title' ? pageTitle : location.href);
        if (!m) return { ok: true, matched: false };
        r = TabRules.renderRule(rule, page, m);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const iconHref = (r.icon || r.color) && r.icon !== 'none' ? await drawIcon(r).catch(() => null) : null;
    return { ok: true, matched: true, title: r.title, icon: r.icon, color: r.color, trace: r.trace, iconHref };
  }

  function onMessage(msg, _sender, reply) {
    if (!alive()) return;
    if (msg.type === 'refresh') load();
    else if (msg.type === 'pick') TabPicker.start();
    else if (msg.type === 'stopPick') TabPicker.stop();
    else if (msg.type === 'preview') {
      preview(msg).then(reply);
      return true;
    }
    else if (msg.type === 'getIcon') reply(iconHref);
    else if (msg.type === 'getState')
      reply({
        url: location.href,
        pageTitle,
        title: document.title,
        ruleLine: result && result.rule ? result.rule.line : null,
        lineNo: result && result.rule ? result.rule.lineNo : null,
        manual: Boolean(override),
        override: override ? override.raw : null,
        icon: iconHref,
      });
  }

  function teardown() {
    if (dead) return;
    dead = true;
    if (headMo) headMo.disconnect();
    if (bodyMo) bodyMo.disconnect();
    clearTimeout(bodyTimer);
    document.removeEventListener(TAKEOVER, teardown);
    // Hand the page back as we found it, so the next copy sees the real title.
    try {
      if (wantedTitle !== null && document.title === wantedTitle) document.title = pageTitle;
      if (iconKey) restoreIcon();
    } catch (_) {}
    try {
      TabPicker.stop();
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {}
  }

  document.addEventListener(TAKEOVER, teardown);
  chrome.runtime.onMessage.addListener(onMessage);
  TabStore.onRulesChanged(load);
  document.addEventListener('DOMContentLoaded', () => {
    if (dead) return;
    pageTitle = wantedTitle !== null && document.title === wantedTitle ? pageTitle : document.title;
    apply();
  });

  observeHead();
  load();
})();
