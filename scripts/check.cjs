// Fast static checks: every script parses, manifest and locales are valid JSON.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['src', 'scripts', 'tests'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => /\.c?js$/.test(f)).map((f) => path.join(d, f)));
for (const f of files) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'inherit' });
for (const f of ['manifest.json', 'package.json', ...fs.readdirSync(path.join(root, '_locales')).map((l) => `_locales/${l}/messages.json`)]) JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
console.log('check: ' + files.length + ' scripts ok');
