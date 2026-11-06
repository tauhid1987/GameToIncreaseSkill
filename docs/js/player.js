import { dbRef, get, set, update, remove, onValue, serverTimestamp, serverNow, playerSignIn } from './fb.js';
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
  pin = null; state = null; meta = null; players = {}; scores = {}; reveal = {}; mine = {};
  joinForm('', '', name);
}

const isSurvey = () => meta?.type === 'survey';
const qKey = () => `q${state.idx}`;
const myPicks = () => orderedAttempts(mine[qKey()]);

// Tapping only records a choice. Nothing tells the player if it is right until the question ends.
async function pick(j) {
  if (state?.phase !== 'question') return;
  const q = qKey();
  const opt = `o${j}`;
  const before = mine[q] || {};
  let write;
  if (isSurvey()) {
    if (before[opt]) {
      const { [opt]: dropped, ...rest } = before;
      mine[q] = rest;
      write = remove(game(`attempts/${uid}/${q}/${opt}`));
    } else if (Object.keys(before).length >= SURVEY_PICKS) {
      notice = `You already chose ${SURVEY_PICKS}. Tap a chosen answer to unselect it first.`;
      render();
      return;
    } else {
      mine[q] = { ...before, [opt]: { at: serverNow() } };
      write = set(game(`attempts/${uid}/${q}/${opt}`), { at: serverTimestamp() });
    }
  } else {
    if (before[opt]) return;
    mine[q] = { [opt]: { at: serverNow() } };
    const changes = { [opt]: { at: serverTimestamp() } };
    Object.keys(before).forEach((old) => { changes[old] = null; });
    write = update(game(`attempts/${uid}/${q}`), changes);
  }
  notice = '';
  render();
  try {
    await write;
  } catch {
    mine[q] = before;
    notice = 'Time is up for this question.';
    if (state?.phase === 'question' && qKey() === q) render();
  }
}

function optionButton(text, j) {
  const chosen = !!mine[qKey()]?.[`o${j}`];
  return `<button class="opt ${chosen ? 'selected' : ''}" data-opt="${j}" aria-pressed="${chosen}">
    <span class="mark">${chosen ? '●' : LETTERS[j]}</span><span class="txt">${esc(text)}</span></button>`;
}

function questionHint() {
  if (notice) return notice;
  const count = myPicks().length;
  if (isSurvey()) {
    return count ? `${count} of ${SURVEY_PICKS} chosen. Tap a chosen answer to unselect it.` : `Choose up to ${SURVEY_PICKS} answers.`;
  }
  return count ? 'Selected. You can change it until time runs out.' : 'Choose one answer.';
}

function resultBody(q, r) {
  const ranked = rankedAnswers(r.o, r.val);
  const myOpts = mine[q] || {};
  {
    return `<ol class="survey">${ranked.map((x) => `<li class="${x.people ? 'hit' : 'miss'} ${myOpts[`o${x.i}`] ? 'mine' : ''}">
      <span class="rk">${x.rank || '–'}</span><span class="ans">${esc(x.text)}</span><b>${x.people} / ${SURVEY_PEOPLE}</b></li>`).join('')}</ol>`;
  }
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
    // A quick round reveals nothing until the final screen.
    if (!isSurvey()) {
      app.innerHTML = `<div class="card center"><h2>Next question…</h2>
        <p class="mute">${myPicks().length ? 'Your answer is saved.' : 'No answer.'}</p></div>`;
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
    return `<div class="review"><b>Q${Number(q.slice(1)) + 1}.</b> ${esc(r.q)}<br>${picks || '<span class="mute">No answer</span>'}${missedAnswer(q, r)}</div>`;
  }).join('');
}

// Shown on the final screen only, and only when the player missed the answer.
function missedAnswer(q, r) {
  const chosen = mine[q] || {};
  const ranked = rankedAnswers(r.o, r.val).filter((x) => x.people > 0);
  if (isSurvey()) {
    const top = ranked.slice(0, SURVEY_PICKS);
    if (top.every((x) => chosen[`o${x.i}`])) return '';
    return `<div class="answer">Top ${top.length}: ${top.map((x) => `${esc(x.text)} (${x.people})`).join(', ')}</div>`;
  }
  if (ranked.some((x) => chosen[`o${x.i}`])) return '';
  return `<div class="answer">Right answer: ${ranked.map((x) => esc(x.text)).join(', ')}</div>`;
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
  if (btn) pick(Number(btn.dataset.opt));
});
