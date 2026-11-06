import { dbRef, get, set, onValue, serverTimestamp, serverNow, playerSignIn } from './fb.js';
import { esc, leaderboard, orderedAttempts, rankedAnswers, SURVEY_PICKS, SURVEY_PEOPLE, LIMIT_MS } from './core.js';

const app = document.getElementById('app');
const SAVE_KEY = 'quizArenaPlayer';
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

let uid;
let pin = null;
let meta = null;
let state = null;
let players = {};
let scores = {};
let reveal = {};
let mine = {};            // my attempts: { q0: { o1: { at } } }
let values = {};          // what each option I picked was worth: { q0: { o1: 0 } }
let ranks = {};           // survey rank of each option I picked: { q0: { o1: 2 } }
let busy = false;
let notice = '';
let unsubscribe = [];

const game = (path) => dbRef(`games/${pin}/${path}`);
const loadSaved = () => {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; }
};

init();

async function init() {
  uid = (await playerSignIn()).uid;
  const urlPin = new URLSearchParams(location.search).get('pin');
  const saved = loadSaved();
  if (saved && (!urlPin || urlPin === saved.pin)) {
    const finished = (await get(dbRef(`games/${saved.pin}/state/phase`)).catch(() => null))?.val();
    if (finished && finished !== 'final') {
      join(saved.pin, saved.name);
      return;
    }
    localStorage.removeItem(SAVE_KEY);
  }
  joinForm(urlPin || '', '', saved?.name || '');
}

function joinForm(p = '', message = '', name = '') {
  app.innerHTML = `<form class="card" id="join"><h2>Join a game</h2>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}
    <label>Game PIN<input id="pin" inputmode="numeric" maxlength="6" autocomplete="off" value="${esc(p)}"></label>
    <label>Nickname<input id="name" maxlength="24" autocomplete="off" value="${esc(name)}"></label>
    <button class="full">Join</button></form>`;
  app.querySelector(p ? '#name' : '#pin').focus();
  app.querySelector('#join').onsubmit = (e) => {
    e.preventDefault();
    join(app.querySelector('#pin').value.trim(), app.querySelector('#name').value.trim());
  };
}

async function join(p, name) {
  if (!/^\d{6}$/.test(p) || !name) {
    joinForm(p, 'Enter the 6-digit PIN and a nickname.', name);
    return;
  }
  try {
    pin = p;
    const m = (await get(game('meta'))).val();
    if (!m) {
      localStorage.removeItem(SAVE_KEY);
      joinForm(p, 'No game found with that PIN.', name);
      return;
    }
    const others = (await get(game('players'))).val() || {};
    const taken = Object.entries(others).some(([id, x]) => id !== uid && x.name.toLowerCase() === name.toLowerCase());
    if (taken) {
      joinForm(p, 'That nickname is taken in this game. Choose another.', name);
      return;
    }
    meta = m;
    await set(game(`players/${uid}`), { name });
    localStorage.setItem(SAVE_KEY, JSON.stringify({ pin: p, name }));
    await loadMyAttempts();
    listen();
  } catch (err) {
    joinForm(p, `Could not join: ${err.message}`, name);
  }
}

async function loadMyAttempts() {
  mine = (await get(game(`attempts/${uid}`))).val() || {};
  await Promise.all(Object.entries(mine).flatMap(([q, opts]) => Object.keys(opts).map((o) => fetchValue(q, o))));
}

async function fetchValue(q, o) {
  const [v, r] = await Promise.all([
    get(game(`key/${q}/${o}`)),
    isSurvey() ? get(game(`ranks/${q}/${o}`)) : null,
  ]);
  values[q] = { ...values[q], [o]: v.val() || 0 };
  if (r) ranks[q] = { ...ranks[q], [o]: r.val() || 0 };
}

function listen() {
  unsubscribe = [
    onValue(game('state'), (s) => { state = s.val(); notice = ''; render(); }),
    onValue(game('players'), (s) => { players = s.val() || {}; if (state?.phase !== 'question') render(); }),
    onValue(game('scores'), (s) => { scores = s.val() || {}; if (state?.phase !== 'question') render(); }),
    onValue(game('reveal'), (s) => { reveal = s.val() || {}; if (state?.phase !== 'question') render(); }),
  ];
}

function leaveGame() {
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  const name = loadSaved()?.name || '';
  localStorage.removeItem(SAVE_KEY);
  history.replaceState(null, '', location.pathname);
  pin = null; state = null; meta = null; players = {}; scores = {}; reveal = {}; mine = {}; values = {}; ranks = {};
  joinForm('', '', name);
}

const isSurvey = () => meta?.type === 'survey';
const qKey = () => `q${state.idx}`;
const myPicks = () => orderedAttempts(mine[qKey()]);

function isLocked() {
  const picks = myPicks();
  if (isSurvey()) return picks.length >= SURVEY_PICKS;
  return picks.some((a) => values[qKey()]?.[`o${a.opt}`] > 0);
}

async function pick(j) {
  if (busy || state?.phase !== 'question' || isLocked() || mine[qKey()]?.[`o${j}`]) return;
  const q = qKey();
  busy = true;
  try {
    await set(game(`attempts/${uid}/${q}/o${j}`), { at: serverTimestamp() });
    mine[q] = { ...mine[q], [`o${j}`]: { at: serverNow() } };
    await fetchValue(q, `o${j}`);
  } catch {
    notice = 'Time is up for this question.';
  }
  busy = false;
  if (state?.phase === 'question' && qKey() === q) render();
}

function optionButton(text, j) {
  const q = qKey();
  const picked = !!mine[q]?.[`o${j}`];
  const value = values[q]?.[`o${j}`];
  const right = picked && value > 0;
  const wrong = picked && value === 0;
  const off = picked || isLocked();
  const rank = ranks[q]?.[`o${j}`];
  const tag = isSurvey() && picked && value !== undefined
    ? `<b class="people">${right ? `Rank ${rank} · ` : ''}${value} / ${SURVEY_PEOPLE}</b>`
    : '';
  const mark = right ? '✓' : wrong ? '✕' : LETTERS[j];
  return `<button class="opt ${right ? 'right' : ''} ${wrong ? 'wrong' : ''}" data-opt="${j}" ${off ? 'disabled' : ''}>
    <span class="mark">${mark}</span><span class="txt">${esc(text)}</span>${tag}</button>`;
}

function questionHint() {
  const picks = myPicks();
  if (notice) return notice;
  if (isSurvey()) {
    const left = SURVEY_PICKS - picks.length;
    const got = picks.reduce((sum, a) => sum + (values[qKey()]?.[`o${a.opt}`] || 0), 0);
    return left > 0 ? `${left} pick${left > 1 ? 's' : ''} left · ${got} of ${SURVEY_PEOPLE} people so far` : `Done · ${got} of ${SURVEY_PEOPLE} people. Next question is coming.`;
  }
  if (isLocked()) return 'Correct! Next question is coming.';
  return picks.length ? 'Wrong. Choose again, quickly.' : 'Choose the right answer.';
}

function resultBody(q, r) {
  const ranked = rankedAnswers(r.o, r.val);
  const myOpts = mine[q] || {};
  if (isSurvey()) {
    return `<ol class="survey">${ranked.map((x) => `<li class="${x.people ? 'hit' : 'miss'} ${myOpts[`o${x.i}`] ? 'mine' : ''}">
      <span class="rk">${x.rank || '–'}</span><span class="ans">${esc(x.text)}</span><b>${x.people} / ${SURVEY_PEOPLE}</b></li>`).join('')}</ol>`;
  }
  return `<p class="answer">✓ ${esc(ranked[0].text)}</p>`;
}

function render() {
  if (!state) return;
  if (state.phase === 'lobby') {
    app.innerHTML = `<div class="card center"><h2>You're in!</h2>
      <p>${esc(meta.title)}</p><p class="mute">Game ${esc(pin)} · ${Object.keys(players).length} players · waiting for the host</p></div>`;
    return;
  }
  if (state.phase === 'question' && state.current) {
    app.innerHTML = `<div class="card">
      <div class="row between"><span class="pill">Question ${state.idx + 1} / ${meta.total}</span><span class="pill timer" id="timer"></span></div>
      <div class="bar"><i id="bar"></i></div>
      <h2 class="question">${esc(state.current.q)}</h2>
      ${isSurvey() ? `<p class="choose">Choose ${SURVEY_PICKS} answers: find the top 3 of ${SURVEY_PEOPLE} people</p>` : ''}
      <div class="opts ${state.current.o.length > 5 ? 'many' : ''}">${state.current.o.map(optionButton).join('')}</div>
      <p class="hint center">${esc(questionHint())}</p></div>`;
    tick();
    return;
  }
  if (state.phase === 'results') {
    const r = reveal[qKey()];
    if (!r) return;
    // Only the survey shows scores during play. Other categories show them at the end.
    if (!isSurvey()) {
      const picks = orderedAttempts(mine[qKey()]);
      const right = picks.some((a) => r.val[a.opt] > 0);
      const verdict = right ? '<p class="verdict okay">✓ You got it right</p>'
        : picks.length ? '<p class="verdict nope">✕ You got it wrong</p>'
          : '<p class="verdict mute">No answer</p>';
      app.innerHTML = `<div class="card center"><h2>${esc(r.q)}</h2>${verdict}${resultBody(qKey(), r)}</div>`;
      return;
    }
    const place = leaderboard(players, scores).findIndex((p) => p.id === uid) + 1;
    app.innerHTML = `<div class="card"><h2>${esc(r.q)}</h2>${resultBody(qKey(), r)}
      <p class="center mute">Your total: <b>${scores[uid]?.s || 0}</b> · Rank ${place || '-'}</p></div>
      <div class="card"><h2>Top players</h2>${boardHtml(5)}</div>`;
    return;
  }
  if (state.phase === 'final') {
    app.innerHTML = `<div class="card"><h2>Final leaderboard</h2>${boardHtml(100)}
      <button class="full" id="again">Join another game</button></div>
      <div class="card"><h2>Your answers</h2>${reviewHtml()}</div>`;
    app.querySelector('#again').onclick = leaveGame;
  }
}

function boardHtml(n) {
  return `<ol class="board">${leaderboard(players, scores).slice(0, n).map((p, i) => `<li class="${p.id === uid ? 'me' : ''}">
    <span>${i + 1}. ${esc(p.name)}</span><b>${p.s}</b></li>`).join('')}</ol>`;
}

function reviewHtml() {
  return Object.keys(reveal).sort((a, b) => a.slice(1) - b.slice(1)).map((q) => {
    const r = reveal[q];
    const picks = orderedAttempts(mine[q]).map((a) => {
      const v = r.val[a.opt] || 0;
      return `<span class="${v ? 'okay' : 'nope'}">${v ? '✓' : '✕'} ${esc(r.o[a.opt])}${isSurvey() ? ` (${v})` : ''}</span>`;
    }).join(' ');
    return `<div class="review"><b>Q${Number(q.slice(1)) + 1}.</b> ${esc(r.q)}<br>${picks || '<span class="mute">No answer</span>'}</div>`;
  }).join('');
}

function tick() {
  const timer = document.getElementById('timer');
  if (!timer || state?.phase !== 'question') return;
  const limit = meta.limitMs || LIMIT_MS;
  const left = Math.max(0, limit - (serverNow() - state.startedAt));
  timer.textContent = `${Math.ceil(left / 1000)}s`;
  document.getElementById('bar').style.width = `${(100 * left) / limit}%`;
}
setInterval(tick, 200);

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-opt]');
  if (btn && !btn.disabled) pick(Number(btn.dataset.opt));
});
