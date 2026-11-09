importScripts('rules.js', 'store.js');

const ovKey = (tabId) => 'ov:' + tabId;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The worker has host permissions, so it can read cross-origin favicons that a
// content-script canvas could not (CORS taint). Returns a data: URL or null.
async function fetchImage(url) {
  try {
    if (url.startsWith('data:')) return url;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/x-icon').split(';')[0];
    if (!type.startsWith('image/')) return null;
    return 'data:' + type + ';base64,' + toBase64(await res.arrayBuffer());
  } catch (_) {
    return null;
  }
}

function refreshTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'refresh' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'getOverride': {
        const id = sender.tab && sender.tab.id;
        if (id == null) return null;
        const k = ovKey(id);
        return (await chrome.storage.session.get(k))[k] || null;
      }
      case 'setOverride':
        await chrome.storage.session.set({ [ovKey(msg.tabId)]: msg.override });
        refreshTab(msg.tabId);
        return true;
      case 'clearOverride':
        await chrome.storage.session.remove(ovKey(msg.tabId));
        refreshTab(msg.tabId);
        return true;
      case 'fetchImage':
        return fetchImage(msg.url);
    }
    return null;
  })().then(reply, () => reply(null));
  return true;
});

// Clicking the toolbar icon opens the side panel, which stays open while the
// user clicks around in the page (a popup would close on the first click).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-panel' && tab) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(ovKey(tabId)));

// SPA navigations (pushState) do not reload the content script.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) refreshTab(tabId);
});

// Content scripts only load on new navigations; inject into tabs already open.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !/^(https?|file):/.test(t.url || '')) continue;
    chrome.scripting
      .executeScript({ target: { tabId: t.id }, files: ['src/rules.js', 'src/store.js', 'src/picker.js', 'src/content.js'] })
      .catch(() => {});
  }
});
