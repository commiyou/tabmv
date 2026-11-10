# 发布流程

[English](publishing.md) · **简体中文**

## 平时发一个新版本

1. 在 `CHANGELOG.md` 顶部写好这一版的变化，标题用 `## 1.0.1` 这样的版本号（Release 说明就从这里取）。
2. 运行 `npm version patch`（或 `minor` / `major`）。它会同时改 `package.json` 和 `manifest.json` 的版本号，提交并打上 `v1.0.1` 标签。
3. `git push --follow-tags`。

推送标签后，GitHub Actions 的 **Release** 工作流会：

1. 跑一遍 CI（单元测试、语法检查、打包、英文和中文界面的浏览器测试）。
2. 打包 `dist/telltab-<版本>.zip`，检查标签和版本号一致。
3. 创建 GitHub Release，附上 zip。
4. 如果配置了商店密钥，把 zip 上传到 Chrome 应用商店并提交审核。没配置时会跳过这一步，并在运行记录里提示。

也可以在 Actions 页面手动运行 Release，勾选 `publish` 重新提交当前版本。

## 第一次上架（只做一次，需要手动）

Google 要求第一次上架在开发者后台手动完成，之后的版本才能用 API 自动上传。

1. 注册 [Chrome 应用商店开发者账号](https://chrome.google.com/webstore/devconsole)（一次性 5 美元），并给这个 Google 账号打开两步验证。
2. 在后台点“新建内容”，上传 Release 里的 zip（或本地 `npm run build` 的结果）。
3. 填写**商品详情**：名称和描述可以直接用 [store/listing.zh-CN.md](../store/listing.zh-CN.md) 和 [store/listing.en.md](../store/listing.en.md)；截图和宣传图用 `npm run store-assets` 生成在 `store/` 里的图片；图标用 `icons/icon128.png`。
4. 填写**隐私权**：单一用途说明、每个权限的理由、数据使用声明都在 listing 文件里；隐私政策网址填 `https://github.com/commiyou/telltab/blob/main/PRIVACY.md`。
5. 提交审核。通过后记下：
   - **扩展 ID**：后台商品页上的 32 位字母。
   - **发布者 ID**：后台“发布者 → 设置”里。

## 配置自动上传

在 GitHub 仓库 Settings → Secrets and variables → Actions 里添加：

| 名称 | 内容 |
| --- | --- |
| `CWS_PUBLISHER_ID` | 发布者 ID |
| `CWS_EXTENSION_ID` | 扩展 ID |

再选一种登录方式：

**方式 A：OAuth 刷新令牌**（步骤最少）。按 Google 的 [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api) 操作：在 Google Cloud 建项目、启用 Chrome Web Store API、配置 OAuth 同意屏幕（把自己加为测试用户）、创建“Web 应用”类型的 OAuth 客户端，再用 OAuth Playground 换到刷新令牌。然后添加：

| 名称 | 内容 |
| --- | --- |
| `CWS_CLIENT_ID` | OAuth 客户端 ID |
| `CWS_CLIENT_SECRET` | OAuth 客户端密钥 |
| `CWS_REFRESH_TOKEN` | 刷新令牌 |

注意：OAuth 同意屏幕处于“测试”状态时，刷新令牌 7 天后会失效；长期使用请把应用发布为“正式”，或者用方式 B。

**方式 B：服务账号**。按 [Use a service account with the Chrome Web Store API](https://developer.chrome.com/docs/webstore/service-accounts) 创建服务账号并在开发者后台授权，下载 JSON 密钥，把整个 JSON 存为 `CWS_SERVICE_ACCOUNT_KEY`。

## 本地手动上传

```sh
npm run build
CWS_PUBLISHER_ID=… CWS_EXTENSION_ID=… CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… CWS_REFRESH_TOKEN=… \
  node scripts/cws-publish.cjs dist/telltab-1.0.1.zip            # 加 --upload-only 只上传不提交审核
```

脚本只用 Node 自带的 `fetch`，调用的是 Chrome Web Store API v2（v1 已于 2026 年 10 月停用）。

## 常见失败

- **版本号没变**：商店拒绝和线上同版本的包，先 `npm version patch`。
- **tag does not match version**：标签和 `manifest.json` 的版本不一致。
- **401 / invalid_grant**：刷新令牌过期或被撤销，重新生成。
- **publish 失败，提示可见性**：在后台手动改过可见性后，需要先在后台手动发布一次，API 才能继续发布。
