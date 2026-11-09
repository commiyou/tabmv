# Changelog

## 1.0.0

First public release.

- Side panel editor: compose a tab name from typed text, text picked on the page, any part of the URL, and the original title. Each piece can keep only part of its value and can fall back to another source while the page is loading.
- Apply a name to one tab, a site, a path, URLs with a given parameter, or a custom glob / regex match. Opening the panel on a tab that a rule controls loads that rule for editing.
- Icons: a color dot on the site's own icon (with a stable automatic color per value), an emoji, the first letter, or an image.
- Rules page with per-line errors, a URL tester and a preview of open tabs.
- Rule text: `URL match => tab name ; icon=… ; color=…` with zmv-style globs and `{page ".css" or ?env before "."}` pieces. The older `$1` / `${…}` syntax still works.
- English and Simplified Chinese UI.
- Fixed: pages could freeze when a page-text piece was empty, when a page kept resetting its title, or when an old copy of the content script was left behind by an extension reload.
