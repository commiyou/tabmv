// Run by `npm version <patch|minor|major>`: copies the new package.json version
// into manifest.json so both are committed and tagged together.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const file = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.version = version;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest.json version -> ' + version);
