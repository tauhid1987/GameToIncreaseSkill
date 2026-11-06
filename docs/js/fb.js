// Firebase setup shared by every page. On localhost it uses the local emulators, never the real project.
import { initializeApp } from '../vendor/firebase/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously,
  signInWithEmailAndPassword, signOut,
} from '../vendor/firebase/firebase-auth.js';
import {
  getDatabase, connectDatabaseEmulator, ref, get, set, update, remove, push, onValue,
  serverTimestamp, increment,
} from '../vendor/firebase/firebase-database.js';
import { firebaseConfig } from '../firebase-config.js';
import { esc } from './core.js';

export const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

const config = LOCAL
  ? {
    apiKey: 'demo-key',
    projectId: 'demo-quiz-arena',
    databaseURL: 'https://demo-quiz-arena-default-rtdb.firebaseio.com',
    appId: 'demo-app',
  }
  : firebaseConfig;

if (JSON.stringify(config).includes('PASTE_')) {
  document.getElementById('app').innerHTML = '<div class="card"><b>Setup needed.</b> Fill in docs/firebase-config.js (see README).</div>';
  throw new Error('firebase-config.js still has placeholders');
}

const firebaseApp = initializeApp(config);
export const auth = getAuth(firebaseApp);
export const db = getDatabase(firebaseApp);
if (LOCAL) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
}

export { ref, get, set, update, remove, push, onValue, serverTimestamp, increment };
export const dbRef = (path) => ref(db, path);

// Server clock, so every screen counts down to the same moment whatever the device clock says.
let clockOffset = 0;
onValue(dbRef('.info/serverTimeOffset'), (s) => { clockOffset = s.val() || 0; });
export const serverNow = () => Date.now() + clockOffset;

export function playerSignIn() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      if (user) resolve(user);
      else signInAnonymously(auth).then((c) => resolve(c.user), reject);
    });
  });
}

// Shows a login form until someone listed under /hosts signs in, then resolves with that user.
export function requireHost(el) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user || user.isAnonymous) {
        showLogin(el);
        return;
      }
      const allowed = (await get(dbRef(`hosts/${user.uid}`))).val() === true;
      if (allowed) {
        resolve(user);
        return;
      }
      el.innerHTML = `<div class="card"><h2>Not a host yet</h2>
        <p>Add this ID under <code>hosts</code> in the Firebase database with the value <code>true</code>, then reload.</p>
        <p><code>${esc(user.uid)}</code></p>
        <button class="ghost" id="out">Sign out</button></div>`;
      el.querySelector('#out').onclick = () => signOut(auth);
    });
  });
}

function showLogin(el, message = '') {
  el.innerHTML = `<form class="card" id="login"><h2>Host sign in</h2>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}
    <label>Email<input id="email" type="email" autocomplete="username" required></label>
    <label>Password<input id="password" type="password" autocomplete="current-password" required></label>
    <button class="full">Sign in</button></form>`;
  el.querySelector('#login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, el.querySelector('#email').value, el.querySelector('#password').value);
    } catch {
      showLogin(el, 'Sign in failed. Check the email and password.');
    }
  };
}

export const hostSignOut = () => signOut(auth);
