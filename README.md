# tabmv

Chrome 扩展（MV3）：用 zmv 风格的 glob 或正则规则，按 URL / 标题改标签页的 title 和 favicon。思路参考 Tab Rename Wiz，规则语法尽量复用 zsh `zmv`、sed、JS 正则和 Chrome match pattern 里大家已经会的写法。

```text
# URL: http://host/app?id=3&env=sandbox01.baidu.com&x=1   →  标签标题 "sandbox01"
*[?&]env=(*).baidu.com* => $1 ; color=auto
```

## 安装

`chrome://extensions` → 打开“开发者模式” → “加载已解压的扩展程序” → 选本目录。无构建步骤、无运行时依赖。

快捷键 `Alt+Shift+R` 打开弹窗：输入标题按 Enter 只改当前标签；填 pattern 后 ⌘/Ctrl+Enter 保存为规则。弹窗会列出当前 URL 的查询参数（点 `${q.env} = …` 插入）和建议的 pattern，并实时预览结果和捕获组。

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
| `$title $url $host $path ${q.env}` | 原标题、URL、查询参数（也查 `#/route?env=`） | |
| `${x\|upper\|lower\|trim\|max:20\|default:-\|before:.\|after:-\|s/re/rep/g}` | 过滤器，可串联 | sed / shell |
| `icon=` | emoji、`letter`（新标题首字）、1–2 个字符、图片 URL、`none` | |
| `color=` | CSS 颜色或 `auto`（按 `$1` 哈希出固定颜色，同一个 env 永远同色） | |

同一个需求的几种写法，按顺手程度排列：

```text
*[?&]env=(*).baidu.com*        => $1                          # glob 捕获，最像 zmv
*://*/*                        => ${q.env|before:.}           # 按参数名取值，不关心参数顺序
*://*/*                        => ${q.env|s/\.baidu\.com$//}  # sed 风格
/[?&]env=([^.&]+)/             => $1                          # 正则
*://*.baidu.com/*              => [${q.env|default:prod}] $title ; color=auto   # 保留原标题加前缀
```

只写 `color=` 时会在原 favicon 右下角加一个色点，站点图标仍然认得出来；`$title` 始终指页面自己的标题，所以加前缀不会叠成 `[qa] [qa] …`。

## 设计

规则存成一份纯文本，而不是表单记录：方便复制、diff、分享和批量改，选项页就是导入导出。存在 `chrome.storage.sync`（分块，单项 8KB 限制），同一账号的 Chrome 之间同步。

| 文件 | 作用 |
| --- | --- |
| `src/rules.js` | 纯函数规则引擎：glob→RegExp、模板、过滤器、求值。content script、页面、service worker 和 Node 测试共用 |
| `src/content.js` | 页面里求值并应用；`MutationObserver` 盯 `<head>`，页面自己改标题或 favicon 时重新套用 |
| `src/background.js` | 手动重命名存 `storage.session`（刷新后还在，关标签清除）；SPA `pushState` 时通知页面重算；代取跨域 favicon 给 canvas 叠色点；安装时注入已打开的标签 |
| `src/popup.*` `src/options.*` | 快速重命名/保存规则；规则编辑器，带逐行报错、测试框和已打开标签预览 |

手动重命名优先于规则。glob 是整串匹配（和 shell 一致，结果可预期），正则是部分匹配（和 JS 一致）。

## 测试

```sh
npm test                       # 规则引擎单测，只需要 Node
npm i && CHROME=".../Google Chrome for Testing" npm run e2e
```

e2e 用真实浏览器加载扩展，验证：规则改名、页面改标题后保持、生成 favicon、`pushState` 后重算、`$title` 取页面原标题、手动重命名在刷新后保留、删规则后恢复原标题。品牌版 Chrome 137 起忽略 `--load-extension`，要用 Chrome for Testing：`npx @puppeteer/browsers install chrome@stable`。

## 限制和后续

- `chrome://`、扩展商店、PDF 查看器等页面不能注入脚本，改不了。
- 页面 CSP 极严格时 favicon 可能不显示，标题不受影响。
- glob 里的 `?` 是通配符；粘贴带 `?` 的 URL 仍能匹配，只是更宽，需要严格时写 `\?`。
- 没做 zsh 的 `#` / `##` 重复符，因为 `#` 在 URL 里是 fragment。
- 后续可加：`group=$1` 把命中的标签放进同名 Chrome 标签组并着色；规则命中统计；从弹窗点击 URL 片段直接生成捕获组。
