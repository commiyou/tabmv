/* chrome.i18n helpers for extension pages. Text comes from _locales/<lang>/messages.json;
 * Chrome picks the browser language and falls back to English. */
(function (root) {
  'use strict';
  const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

  // <el data-i18n="key">, data-i18n-html (trusted markup from messages.json),
  // data-i18n-placeholder, data-i18n-title.
  function localize(doc = document) {
    for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of doc.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const el of doc.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of doc.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    doc.documentElement.lang = chrome.i18n.getUILanguage();
  }

  root.t = t;
  root.localize = localize;
})(globalThis);
