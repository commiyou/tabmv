// Packs the extension into dist/tabmv-<version>.zip for the Chrome Web Store.
// Checks first that versions agree and both languages have the same messages.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const fail = (msg) => {
  console.error('build: ' + msg);
  process.exit(1);
};

const manifest = read('manifest.json');
const pkg = read('package.json');
if (manifest.version !== pkg.version) fail(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '';
if (tag && tag !== 'v' + manifest.version) fail(`tag ${tag} does not match version ${manifest.version}`);

const locales = fs.readdirSync(path.join(root, '_locales'));
const keys = locales.map((l) => Object.keys(read(`_locales/${l}/messages.json`)).sort().join());
if (new Set(keys).size !== 1) fail('_locales/*/messages.json do not have the same keys');

for (const f of ['manifest.json', ...Object.values(manifest.icons), manifest.background.service_worker, ...manifest.content_scripts.flatMap((c) => c.js)]) {
  if (!fs.existsSync(path.join(root, f))) fail('missing ' + f);
}

const out = path.join(root, 'dist', `tabmv-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);
execFileSync('zip', ['-qr', '-X', out, 'manifest.json', '_locales', 'src', 'icons', '-x', 'icons/icon.svg', '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.log(path.relative(root, out), (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
