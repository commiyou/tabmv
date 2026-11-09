# Privacy policy / 隐私政策

_Last updated: 2026-11-09_

**English**

tabmv renames browser tabs and changes their icons according to rules you write.

- **No data leaves your browser through tabmv.** The extension has no server, no analytics and no tracking.
- **Rules** are stored with `chrome.storage.sync`. If you turn on Chrome sync, Google syncs them between your own signed-in devices, like any other extension setting.
- **Per-tab renames** are kept in `chrome.storage.session` and deleted when the tab or browser closes.
- **Page content**: to evaluate your rules, tabmv reads the URL, the title and, only when a rule asks for it, the text of the elements you picked. This happens locally in the page and is never stored or sent anywhere.
- **Icons**: to draw a color dot on a site's icon, tabmv downloads that icon from the same address the page already uses.
- **Permissions**: access to all sites is needed because rules can apply to any site you choose; `tabs` to read tab URLs and titles; `scripting` to apply rules to tabs that were open before installation; `storage` for your rules; `sidePanel` for the editor.

**简体中文**

tabmv 按你写的规则给浏览器标签改名、换图标。

- **tabmv 不会把任何数据发出你的浏览器。** 没有服务器，没有统计，没有追踪。
- **规则**保存在 `chrome.storage.sync`。如果你开启了 Chrome 同步，Google 会像同步其他扩展设置一样，在你自己登录的设备之间同步它们。
- **单标签改名**保存在 `chrome.storage.session`，关闭标签或浏览器后删除。
- **页面内容**：为了计算规则，tabmv 会读取网址、标题，以及只在规则需要时读取你点选的元素的文字。这些都在页面本地完成，不会保存或发送到任何地方。
- **图标**：为了在网站图标上画色点，tabmv 会从页面本来使用的地址下载这个图标。
- **权限**：规则可以作用于你选择的任何网站，所以需要访问所有网站；`tabs` 用来读取标签的网址和标题；`scripting` 用来把规则应用到安装前就打开的标签；`storage` 保存规则；`sidePanel` 用于编辑器。

Questions / 问题：<https://github.com/commiyou/tabmv/issues>
