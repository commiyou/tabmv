# Publishing

**English** · [简体中文](publishing.zh-CN.md)

## Releasing a new version

1. Describe the changes at the top of `CHANGELOG.md` under a heading like `## 1.0.1` (the release notes are taken from it).
2. Run `npm version patch` (or `minor` / `major`). It updates `package.json` and `manifest.json`, commits, and tags `v1.0.1`.
3. `git push --follow-tags`.

The **Release** workflow then:

1. Runs CI (unit tests, syntax checks, packaging, browser tests in English and Chinese).
2. Builds `dist/tabmv-<version>.zip` and checks that the tag matches the version.
3. Creates a GitHub Release with the zip.
4. If the store secrets are set, uploads the zip to the Chrome Web Store and submits it for review. Otherwise it skips this step and leaves a notice in the run.

You can also run Release by hand from the Actions tab and tick `publish` to resubmit the current version.

## First store listing (once, by hand)

Google requires the first submission to be made in the Developer Dashboard; later versions can be uploaded through the API.

1. Register a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole) (one-time USD 5 fee) and turn on 2-step verification for that Google account.
2. Click **New item** and upload the zip from a Release (or from `npm run build`).
3. Fill in **Store listing**: names and descriptions are in [store/listing.en.md](../store/listing.en.md) and [store/listing.zh-CN.md](../store/listing.zh-CN.md); screenshots and promo tiles come from `npm run store-assets` (written to `store/`); the icon is `icons/icon128.png`.
4. Fill in **Privacy**: the single-purpose statement, permission justifications and data-use answers are in the listing files; the privacy policy URL is `https://github.com/commiyou/tabmv/blob/main/PRIVACY.md`.
5. Submit for review. Afterwards note:
   - the **extension ID** (32 letters, on the item page), and
   - the **publisher ID** (Publisher → Settings).

## Automatic uploads

Add these under the repo's Settings → Secrets and variables → Actions:

| Name | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | publisher ID |
| `CWS_EXTENSION_ID` | extension ID |

Then pick one way to sign in.

**Option A: OAuth refresh token** (fewest steps). Follow Google's [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api): create a Google Cloud project, enable the Chrome Web Store API, configure the OAuth consent screen (add yourself as a test user), create a "Web application" OAuth client, and get a refresh token from the OAuth Playground. Then add:

| Name | Value |
| --- | --- |
| `CWS_CLIENT_ID` | OAuth client ID |
| `CWS_CLIENT_SECRET` | OAuth client secret |
| `CWS_REFRESH_TOKEN` | refresh token |

While the consent screen is in "Testing" status, refresh tokens expire after 7 days. Publish the app to "In production" for long-lived tokens, or use option B.

**Option B: service account.** Follow [Use a service account with the Chrome Web Store API](https://developer.chrome.com/docs/webstore/service-accounts) to create a service account and authorize it in the dashboard, download its JSON key, and store the whole JSON as `CWS_SERVICE_ACCOUNT_KEY`.

## Uploading from your machine

```sh
npm run build
CWS_PUBLISHER_ID=… CWS_EXTENSION_ID=… CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… CWS_REFRESH_TOKEN=… \
  node scripts/cws-publish.cjs dist/tabmv-1.0.1.zip            # --upload-only skips the review submission
```

The script uses only Node's built-in `fetch` and the Chrome Web Store API v2 (v1 was shut down in October 2026).

## When it fails

- **Version not increased**: the store rejects a package with the same version as the live one. Run `npm version patch`.
- **tag does not match version**: the tag and `manifest.json` disagree.
- **401 / invalid_grant**: the refresh token expired or was revoked; create a new one.
- **publish fails mentioning visibility**: after changing visibility in the dashboard you must publish once by hand before the API can publish again.
