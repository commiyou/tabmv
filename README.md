# tabmv

Chrome 扩展（MV3）：给标签页改名、换图标。名字可以取自页面上的文字、网址或原标题，并按顺序兜底；规则用 zmv 风格的 glob 或正则按 URL / 标题匹配。思路参考 Tab Rename Wiz，规则语法尽量复用 zsh `zmv`、sed、JS 正则和 Chrome match pattern 里大家已经会的写法。

```text
# URL: http://host/app?id=3&env=sandbox01.baidu.com&x=1   →  标签标题 "sandbox01"
*[?&]env=(*).baidu.com* => $1 ; color=auto
```

## 安装

`chrome://extensions` → 打开“开发者模式” → “加载已解压的扩展程序” → 选本目录。无构建步骤、无运行时依赖。

点工具栏图标或按 `Alt+Shift+R` 打开侧边栏，按四步操作，不用写语法：

1. **标签显示什么**：自己写一个名字，或点“从页面上点选文字”后在页面上点一下（↑/↓ 扩大或缩小范围，Esc 取消；先选中文字再点按钮也行）。还可以加网址参数、域名、路径、原标题作为后备。列表从上往下试，第一个有值的就用，每一项都显示它在当前页面取到的值，并标出现在用的是哪个。
2. **样式**：只显示它、`它 · 原标题`、`[它] 原标题`。
3. **图标**：色点（含按内容自动配色）或 emoji / 首字 / 图片。
4. **用在哪些页面**：只这个标签、这个网站、这个路径、带某个参数的网址，或自己写 pattern。

顶部实时预览标签的样子，底部用一句话说明保存后会发生什么，例如“以后打开 x.baidu.com 的任何页面，标签显示页面上「QA-3」那段文字，没有就用网址里 env 的值（只要「.」前面的部分），都没有就保持原标题”。面板生成的就是一条普通规则，可以在“高级：规则文本”或规则页里继续改。

## 规则

每行一条，从上到下第一条命中生效，`#` 开头是注释：

```text
<pattern> => <title 模板> [; icon=<值>] [; color=<值>]
```

| 写法 | 含义 | 来源 |
| --- | --- | --- |
| `*` `?` `[a-z]` `[!&]` `\x` | glob，整串匹配；`*` 取最短匹配 | zsh |
| `{a,b}` `(a\|b)` | 选择 | zsh |
| `(*)` + `$1` | 捕获组和引用 | zmv |
| 无 `( )` 时每个 `*` `?` `[…]` 自动捕获 | `https://*.x.com/*/issues/* => $2#$3` | zmv `-W` |
| `(#i)` 前缀 | 忽略大小写 | zsh glob flag |
| `/re/i`，`(?<k>…)` → `$<k>` | JS 正则，部分匹配 | JS |
| `*://*.baidu.com/*` | Chrome match pattern 本身就是合法 glob | Chrome |
| `title:` 前缀 | 匹配原标题而不是 URL | |
| `${sel:h1.title}` `${sel:"…"}` | 页面上第一个匹配 CSS 选择器的元素的文字（侧边栏点选自动生成） | CSS |
| `${a \|\| b \|\| "文字"}` | 兜底：第一个非空的值；元素还没渲染时先用后面的，渲染后自动换回 | shell `${x:-y}` / JS `\|\|` |
| `$title $url $host $path ${q.env}` | 原标题、URL、查询参数（也查 `#/route?env=`） | |
| `${x\|upper\|lower\|trim\|max:20\|default:-\|before:.\|after:-\|s/re/rep/g\|m/re/}` | 过滤器，可串联；`m/re/` 取第一个捕获组，没匹配到为空，会触发兜底 | sed / perl |
| `icon=` | emoji、`letter`（新标题首字）、1–2 个字符、图片 URL、`none` | |
| `color=` | CSS 颜色或 `auto`（按 `$1` 哈希出固定颜色，同一个 env 永远同色） | |

同一个需求的几种写法，按顺手程度排列：

```text
*[?&]env=(*).baidu.com*        => $1                          # glob 捕获，最像 zmv
*://*/*                        => ${q.env|before:.}           # 按参数名取值，不关心参数顺序
*://*/*                        => ${q.env|s/\.baidu\.com$//}  # sed 风格
/[?&]env=([^.&]+)/             => $1                          # 正则
*://*.baidu.com/*              => [${q.env|default:prod}] $title ; color=auto   # 保留原标题加前缀
*://*.baidu.com/*              => ${sel:".env-name" || q.env|before:.}         # 先取页面文字，没加载出来时用网址
*://jira.x/browse/*            => #${sel:h1|m/([A-Z]+-\d+)/ || title}           # 取页面文字的一部分
```

只写 `color=` 时会在原 favicon 右下角加一个色点，站点图标仍然认得出来；`$title` 始终指页面自己的标题，所以加前缀不会叠成 `[qa] [qa] …`。

## 设计

规则存成一份纯文本，而不是表单记录：方便复制、diff、分享和批量改，选项页就是导入导出。存在 `chrome.storage.sync`（分块，单项 8KB 限制），同一账号的 Chrome 之间同步。

| 文件 | 作用 |
| --- | --- |
| `src/rules.js` | 纯函数规则引擎：glob→RegExp、模板、过滤器、求值。content script、页面、service worker 和 Node 测试共用 |
| `src/content.js` | 页面里求值并应用；`MutationObserver` 盯 `<head>`，页面自己改标题或 favicon 时重新套用；规则用到 `sel:` 时再节流（250ms）盯 `<body>`，元素出现或文字变化后重算 |
| `src/picker.js` | 页面上的元素点选器（Shadow DOM 遮罩），生成尽量稳定的选择器：优先 id、`data-testid`、`aria-label`，跳过 `css-1x2y3z` 这类生成的 class，必要时才用 `:nth-of-type` |
| `src/background.js` | 手动重命名存 `storage.session`（刷新后还在，关标签清除）；SPA `pushState` 时通知页面重算；代取跨域 favicon 给 canvas 叠色点；安装时注入已打开的标签 |
| `src/panel.*` | 侧边栏：选来源 → 生成规则，实时预览（在真实页面上求值）。用侧边栏而不是弹窗，是因为弹窗在页面上点一下就会关掉，没法点选 |
| `src/options.*` | 规则编辑器，带逐行报错、测试框和已打开标签预览 |

手动重命名优先于规则。glob 是整串匹配（和 shell 一致，结果可预期），正则是部分匹配（和 JS 一致）。

## 测试

```sh
npm test                       # 规则引擎单测，只需要 Node
npm i && CHROME=".../Google Chrome for Testing" npm run e2e
```

e2e 用真实浏览器加载扩展，验证：页面元素晚渲染时先用 URL 兜底、渲染后换成页面文字；在侧边栏点选页面元素、预览并保存规则；规则改名、页面改标题后保持、生成 favicon、`pushState` 后重算、`$title` 取页面原标题、手动重命名在刷新后保留、删规则后恢复原标题。品牌版 Chrome 137 起忽略 `--load-extension`，要用 Chrome for Testing：`npx @puppeteer/browsers install chrome@stable`。

## 限制和后续

- `chrome://`、扩展商店、PDF 查看器等页面不能注入脚本，改不了。
- 页面 CSP 极严格时 favicon 可能不显示，标题不受影响。
- glob 里的 `?` 是通配符；粘贴带 `?` 的 URL 仍能匹配，只是更宽，需要严格时写 `\?`。
- 没做 zsh 的 `#` / `##` 重复符，因为 `#` 在 URL 里是 fragment。
- 点选得到的选择器在页面改版后可能失效，这时会自动落到下一个来源，侧边栏会显示“暂时取不到”。
- 侧边栏还不能把已有规则读回来编辑。它新建的规则放在最前面，所以优先生效；也可以勾选替换当前生效的那条。
- 后续可加：`group=$1` 把命中的标签放进同名 Chrome 标签组并着色；规则命中统计；从弹窗点击 URL 片段直接生成捕获组。
