// Upload a zip to the Chrome Web Store (API v2) and submit it for review.
//
//   node scripts/cws-publish.cjs dist/tabmv-1.0.0.zip [--upload-only]
//
// Environment:
//   CWS_PUBLISHER_ID, CWS_EXTENSION_ID          required
//   CWS_ACCESS_TOKEN                            a ready token (e.g. from a service account), or
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   to mint one from an OAuth refresh token
// See docs/publishing.md for how to get these. No dependencies; Node 20+.
const fs = require('node:fs');

const API = 'https://chromewebstore.googleapis.com';
const env = (k) => (process.env[k] || '').trim();
const die = (msg, extra) => {
  console.error('cws: ' + msg);
  if (extra) console.error(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function accessToken() {
  if (env('CWS_ACCESS_TOKEN')) return env('CWS_ACCESS_TOKEN');
  const missing = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'].filter((k) => !env(k));
  if (missing.length) die('set CWS_ACCESS_TOKEN, or ' + missing.join(', '));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('CWS_CLIENT_ID'), client_secret: env('CWS_CLIENT_SECRET'), refresh_token: env('CWS_REFRESH_TOKEN'), grant_type: 'refresh_token' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) die('could not get an access token (' + res.status + ')', body.error_description || body.error);
  return body.access_token;
}

async function call(token, method, url, body, headers = {}) {
  const res = await fetch(url, { method, headers: { authorization: 'Bearer ' + token, ...headers }, body });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }
  if (!res.ok) die(method + ' ' + url.replace(API, '') + ' failed (' + res.status + ')', json);
  return json;
}

(async () => {
  const zip = process.argv[2];
  const uploadOnly = process.argv.includes('--upload-only');
  if (!zip || !fs.existsSync(zip)) die('usage: cws-publish.cjs <zip> [--upload-only]');
  const pub = env('CWS_PUBLISHER_ID');
  const id = env('CWS_EXTENSION_ID');
  if (!pub || !id) die('set CWS_PUBLISHER_ID and CWS_EXTENSION_ID');
  const name = `publishers/${pub}/items/${id}`;
  const token = await accessToken();

  console.log('cws: uploading ' + zip);
  const up = await call(token, 'POST', `${API}/upload/v2/${name}:upload`, fs.readFileSync(zip), { 'content-type': 'application/zip' });
  let state = up.uploadState || '';
  for (let i = 0; /IN_PROGRESS/.test(state) && i < 30; i++) {
    await sleep(5000);
    state = (await call(token, 'GET', `${API}/v2/${name}:fetchStatus`)).lastAsyncUploadState || '';
  }
  if (state !== 'SUCCEEDED') die('upload did not succeed: ' + (state || 'unknown state'), up);
  console.log('cws: uploaded version ' + (up.crxVersion || '?'));
  if (uploadOnly) return;

  const pubRes = await call(token, 'POST', `${API}/v2/${name}:publish`, '{}', { 'content-type': 'application/json' });
  console.log('cws: submitted for review: ' + (pubRes.state || JSON.stringify(pubRes)));
})().catch((e) => die(e.message));
