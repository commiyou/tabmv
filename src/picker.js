/* Element picker: hover highlights, click picks, ↑/↓ widens/narrows, Esc cancels.
 * If text is already selected when picking starts, the element around the
 * selection is used right away. Result goes to the side panel via runtime message. */
(function (root) {
  'use strict';
  if (root.TabPicker) return;

  function textOf(el) {
    if (!el) return undefined;
    let t;
    if (el.matches('input, textarea, select')) t = el.value;
    else if (el.matches('meta')) t = el.getAttribute('content');
    else t = el.innerText || el.textContent;
    t = (t || '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 300) : undefined;
  }

  const looksGenerated = (s) => /\d{3,}|[a-f0-9]{6,}|^[a-z]{1,3}-[A-Za-z0-9_-]{4,}$|__|--|^css-|^sc-|^jsx-/i.test(s);
  const cssEsc = (s) => (root.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  };

  // Prefer selectors that survive re-renders: id, test ids, aria labels,
  // readable classes; fall back to :nth-of-type only where needed.
  function selectorFor(el) {
    if (el.id && !looksGenerated(el.id) && unique('#' + cssEsc(el.id))) return '#' + cssEsc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'itemprop']) {
      const v = el.getAttribute(a);
      if (v && v.length < 60) {
        const s = el.localName + '[' + a + '="' + v.replace(/"/g, '\\"') + '"]';
        if (unique(s)) return s;
      }
    }
    const segs = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n !== el && n.id && !looksGenerated(n.id)) {
        segs.unshift('#' + cssEsc(n.id));
        break;
      }
      let seg = n.localName;
      const cls = [...n.classList].filter((c) => !looksGenerated(c)).slice(0, 2);
      if (cls.length) seg += '.' + cls.map(cssEsc).join('.');
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.localName === n.localName);
        if (same.length > 1 && [...p.children].filter((c) => c.matches(seg)).length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      segs.unshift(seg);
      if (unique(segs.join(' > '))) break;
    }
    return segs.join(' > ');
  }

  function count(sel) {
    try {
      return document.querySelectorAll(sel).length;
    } catch (_) {
      return 0;
    }
  }

  let active = null;

  function finish(el) {
    const a = active;
    if (!a) return;
    stop();
    if (!el) return chrome.runtime.sendMessage({ type: 'picked', cancelled: true }).catch(() => {});
    const selector = selectorFor(el);
    chrome.runtime.sendMessage({ type: 'picked', selector, text: textOf(el) || '', count: count(selector) }).catch(() => {});
  }

  function stop() {
    if (!active) return;
    for (const [t, f] of active.listeners) window.removeEventListener(t, f, true);
    active.host.remove();
    active = null;
  }

  function start() {
    stop();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      let n = sel.getRangeAt(0).commonAncestorContainer;
      if (n.nodeType !== 1) n = n.parentElement;
      active = { host: document.createElement('div'), listeners: [] };
      return finish(n);
    }

    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .box { position: fixed; border: 2px solid #1a73e8; background: rgba(26,115,232,.12); border-radius: 3px; transition: all .05s; }
      .tip, .bar { position: fixed; font: 12px/1.4 system-ui, -apple-system, "PingFang SC", sans-serif; color: #fff; background: #202124; border-radius: 6px; padding: 4px 8px; max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px #0004; }
      .bar { top: 12px; left: 50%; transform: translateX(-50%); padding: 8px 14px; font-size: 13px; }
      kbd { background: #fff2; border-radius: 3px; padding: 0 4px; }
    </style>
    <div class="box"></div><div class="tip"></div>
    <div class="bar">点一下想当作标签名的文字 · <kbd>↑</kbd> 选更大范围 · <kbd>↓</kbd> 缩小 · <kbd>Esc</kbd> 取消</div>`;
    const box = shadow.querySelector('.box');
    const tip = shadow.querySelector('.tip');
    document.documentElement.appendChild(host);

    let cur = null;
    const stack = [];
    const show = (el) => {
      cur = el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 'px', height: r.height + 'px' });
      tip.textContent = textOf(el) || '（这里没有文字）';
      tip.style.left = Math.max(4, r.left) + 'px';
      tip.style.top = (r.top > 30 ? r.top - 28 : r.bottom + 6) + 'px';
    };
    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const listeners = [
      ['mousemove', (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== cur && !stack.includes(el)) {
          stack.length = 0;
          show(el);
        }
      }],
      ['mousedown', block],
      ['mouseup', block],
      ['pointerdown', block],
      ['pointerup', block],
      ['click', (e) => (block(e), finish(cur))],
      ['keydown', (e) => {
        if (e.key === 'Escape') return block(e), finish(null);
        if (e.key === 'Enter') return block(e), finish(cur);
        if (e.key === 'ArrowUp' && cur && cur.parentElement && cur.parentElement !== document.documentElement) {
          block(e);
          stack.push(cur);
          show(cur.parentElement);
        } else if (e.key === 'ArrowDown' && stack.length) {
          block(e);
          show(stack.pop());
        }
      }],
    ];
    for (const [t, f] of listeners) window.addEventListener(t, f, true);
    active = { host, listeners };
  }

  root.TabPicker = { start, stop, textOf, selectorFor };
})(globalThis);
