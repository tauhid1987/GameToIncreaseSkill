// Copies the Firebase browser files into docs/vendor, so players never wait on an outside CDN.
// Run after upgrading the firebase package: npm run vendor
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const from = new URL('../node_modules/firebase/', import.meta.url);
const to = new URL('../docs/vendor/firebase/', import.meta.url);
mkdirSync(to, { recursive: true });

for (const name of ['firebase-app.js', 'firebase-auth.js', 'firebase-database.js']) {
  const code = readFileSync(new URL(name, from), 'utf8')
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, './firebase-app.js')
    .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  if (code.includes('gstatic.com/firebasejs')) throw new Error(`${name} still imports from the CDN`);
  writeFileSync(new URL(name, to), code);
  console.log(`${name}: ${(code.length / 1024).toFixed(0)} KB`);
}
