# Chrome Web Store listing (English)

**Name**: Telltab – Rename Tabs by URL & Page Text  (from `_locales/en/messages.json`)

**Summary** (manifest description, ≤ 132 characters): Name tabs from page text, URL parts and the original title, and color their icons. zmv-style glob and regex rules.

**Category**: Workflow & Planning

## Description

Ten tabs called "Dashboard"? Telltab puts the part you care about into the tab title.

• Compose a tab name from your own text, text on the page, any part of the URL, and the original title.
• Pick page text with one click. While the page is still loading, a piece can fall back to the URL and switch back once the text appears.
• Keep only part of a value: before or after a dot, or extract with a regex.
• Apply to one tab, a whole site, a path, or any URL with a given parameter such as env=.
• Tell environments apart at a glance: a color dot on the site's icon, with a stable automatic color per environment.
• A live preview shows the tab before you save; one sentence explains what the rule will do.
• Power users get plain-text rules with zsh/zmv-style globs or regex, a rules page with error checking and a tester, and rules that sync across your Chrome devices.

Example: `*[?&]env=(*).baidu.com* => {1} ; color=auto` turns `…?env=sandbox01.baidu.com` into a tab named "sandbox01" with its own color.

No account, no server, no tracking. Open source: https://github.com/commiyou/telltab

## Privacy tab

**Single purpose**: Rename browser tabs and change their icons according to rules the user writes.

**Permission justifications**

- Host permission (all sites): rules apply to whichever sites the user chooses, so the content script must run on any site to set the title and icon, and the background worker downloads a site's icon to draw a color dot on it.
- `tabs`: read tab URLs and titles to show previews and to re-apply rules when a single-page app changes its URL.
- `scripting`: apply rules to tabs that were already open when the extension was installed or updated.
- `storage`: save the user's rules (sync) and per-tab renames (session).
- `sidePanel`: the rule editor runs in the side panel so the user can click text on the page while editing.

**Remote code**: No. All code is in the package.

**Data usage**: The extension does not collect or transmit user data. Rules are stored in chrome.storage.sync; page text is read locally only when a rule asks for it.

**Privacy policy URL**: https://github.com/commiyou/telltab/blob/main/PRIVACY.md
