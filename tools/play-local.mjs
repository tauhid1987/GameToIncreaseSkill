// Fills the local emulators with a host login and the questions, then keeps them running.
// Started by: npm run play. Everything here is local test data and disappears when it stops.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { CATEGORIES, parseImport } from '../docs/js/core.js';

const NS = 'demo-quiz-arena-default-rtdb';
const EMAIL = 'host@local.test';
const PASSWORD = 'local-only-password';
const SITE = 'http://127.0.0.1:5055';

const signUp = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
});
const { localId } = await signUp.json();

// The question pack if it is here, otherwise the samples.
const packDir = new URL('../questions/', import.meta.url);
const sampleDir = new URL('../samples/', import.meta.url);
const sources = existsSync(packDir)
  ? readdirSync(packDir).filter((f) => f.endsWith('.txt')).map((f) => [f, new URL(f, packDir)])
  : [['gk.txt', new URL('general-knowledge.txt', sampleDir)], ['jonomot.txt', new URL('survey-jonomot.txt', sampleDir)]];

const bank = {};
let total = 0;
let skipped = 0;
sources.forEach(([name, url]) => {
  const base = name.replace(/\.txt$/, '');
  const cat = CATEGORIES.find((c) => c.id === base || base.startsWith(`${c.id}-`));
  if (!cat) return;
  const { questions, errors } = parseImport(readFileSync(url, 'utf8'), cat.type);
  skipped += errors.length;
  bank[cat.id] ||= {};
  questions.forEach((q) => {
    total += 1;
    bank[cat.id][`q${total}`] = { ...q, used: 0, createdAt: total, createdBy: localId };
  });
});

const put = (path, body) => fetch(`http://127.0.0.1:9000/${path}.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(body),
});
await put(`hosts/${localId}`, true);
await put('bank', bank);

console.log(`
============================================================
 Quiz Arena is running on this PC (${total} questions${skipped ? `, ${skipped} skipped` : ''})

 HOST     ${SITE}/host.html
          Email     ${EMAIL}
          Password  ${PASSWORD}

 PLAYERS  Scan is not available locally. Open the link shown
          under the QR code, one separate browser per player
          (for example Edge, or a Chrome incognito window).

 Press Ctrl+C to stop. Local data is lost when it stops.
============================================================
`);

setInterval(() => {}, 60000);
