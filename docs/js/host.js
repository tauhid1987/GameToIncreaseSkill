import {
  LOCAL, dbRef, get, set, update, remove, onValue, serverTimestamp, increment, serverNow,
  requireHost, hostSignOut,
} from './fb.js';
import {
  CATEGORIES, QUESTIONS_PER_GAME, LIMIT_MS, REVEAL_MS, categoryById, pickQuestions, buildGame,
  totalScores, leaderboard, buildHistory, listSets, nextSet, questionsInSet, hasFinished, rankedAnswers,
  SURVEY_PEOPLE, esc,
} from './core.js';

const app = document.getElementById('app');
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// Shorter times are only accepted on localhost, for the automated tests.
const params = new URLSearchParams(location.search);
const limitMs = LOCAL && params.get('limit') ? Number(params.get('limit')) : LIMIT_MS;
const revealMs = LOCAL && params.get('reveal') ? Number(params.get('reveal')) : REVEAL_MS;

let uid;
let pin = null;
let meta = null;
let questions = [];
let key = {};
let state = null;
let players = {};
let attempts = {};
let scores = {};
let reveal = {};
let starts = {};
let timer = null;
let endingEarly = false;
let unsubscribe = [];
const FINISH_PAUSE_MS = 800;

const game = (path) => dbRef(`games/${pin}/${path}`);

init();

async function init() {
  uid = (await requireHost(app)).uid;
  const current = (await get(dbRef(`hostGames/${uid}/current`))).val();
  if (current) {
    pin = current;
    const existing = (await get(dbRef(`games/${pin}/meta`)).catch(() => null))?.val();
    if (existing?.hostUid === uid) {
      await attach();
      return;
    }
    await remove(dbRef(`hostGames/${uid}/current`));
    pin = null;
  }
  showPicker();
}

// ---------- choosing a category ----------

async function showPicker(message = '') {
  const bank = (await get(dbRef('bank'))).val() || {};
  const listOf = (id) => Object.entries(bank[id] || {}).map(([qid, v]) => ({ id: qid, ...v }));
  app.innerHTML = `<div class="card"><h2>Create a game</h2>
    <p class="mute">Choose a category, then a question set of ${QUESTIONS_PER_GAME} questions.</p>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}
    <div class="cats">${CATEGORIES.map((c) => {
    const sets = listSets(listOf(c.id));
    const ready = sets.filter((s) => s.ready).length;
    return `<button class="cat ${c.type === 'survey' ? 'special' : ''}" data-cat="${c.id}">
      <b>${esc(c.label)}</b><small>${ready} set${ready === 1 ? '' : 's'} ready</small></button>`;
  }).join('')}</div>
    <button class="ghost" id="out">Sign out</button></div>`;
  app.querySelector('#out').onclick = () => hostSignOut().then(() => location.reload());
  app.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = () => showSets(b.dataset.cat, listOf(b.dataset.cat));
  });
}

function showSets(catId, items) {
  const cat = categoryById(catId);
  const sets = listSets(items);
  const next = nextSet(items);
  const addLink = `bank.html?cat=${encodeURIComponent(catId)}`;
  app.innerHTML = `<div class="row"><button class="ghost" id="back">Back to categories</button></div>
    <div class="card"><h2>${esc(cat.label)}</h2>
    <label>Event title (optional)<input id="title" maxlength="60" placeholder="Friday Quiz"></label>
    ${next ? `<button class="full" id="next">Start the next set (${esc(next)})</button>` : `<p class="error">No set has ${QUESTIONS_PER_GAME} questions yet.</p>`}
    <h3>Or choose a set</h3>
    <div class="cats">${sets.map((s) => `<button class="cat" data-set="${esc(s.name)}" ${s.ready ? '' : 'disabled'}>
      <b>${esc(s.name)}</b><small>${s.count} question${s.count === 1 ? '' : 's'}${s.ready ? ` · played ${s.plays}x` : ` · needs ${QUESTIONS_PER_GAME - s.count} more`}</small></button>`).join('') || '<p class="mute">No sets yet.</p>'}</div>
    <a href="${addLink}">Add a question or a new set</a></div>`;
  const start = (name) => createGame(catId, name, app.querySelector('#title').value.trim(), items);
  app.querySelector('#back').onclick = () => showPicker();
  app.querySelector('#next')?.addEventListener('click', () => start(next));
  app.querySelectorAll('[data-set]').forEach((b) => { b.onclick = () => start(b.dataset.set); });
}

async function createGame(catId, setName, title, items) {
  const cat = categoryById(catId);
  const picked = pickQuestions(questionsInSet(items, setName));
  const built = buildGame(picked, cat.type);
  const newMeta = {
    hostUid: uid, title: title || `${cat.label} · ${setName}`, cat: catId, set: setName, type: cat.type,
    total: picked.length, limitMs, revealMs, created: Date.now(),
  };
  for (let tries = 0; tries < 8; tries++) {
    const p = String(Math.floor(100000 + Math.random() * 900000));
    if ((await get(dbRef(`games/${p}/meta`))).exists()) continue;
    pin = p;
    await set(dbRef(`games/${p}`), {
      meta: newMeta, questions: built.questions, key: built.key, ranks: built.ranks, state: { phase: 'lobby', idx: -1 },
    });
    await set(dbRef(`hostGames/${uid}/current`), p);
    const used = {};
    picked.forEach((q) => { used[`bank/${catId}/${q.id}/used`] = increment(1); });
    await update(dbRef('/'), used);
    await attach();
    return;
  }
  showPicker('Could not get a free PIN. Please try again.');
}

// ---------- running the game ----------

async function attach() {
  const [m, q, k, st] = await Promise.all(['meta', 'questions', 'key', 'starts'].map((p) => get(game(p))));
  meta = m.val();
  questions = q.val() || [];
  key = k.val() || {};
  starts = st.val() || {};
  unsubscribe = [
    onValue(game('state'), (s) => { state = s.val(); schedule(); render(); }),
    onValue(game('players'), (s) => { players = s.val() || {}; render(); }),
    onValue(game('attempts'), (s) => {
      attempts = s.val() || {};
      if (state?.phase === 'question') { renderAnswered(); endEarlyIfAllFinished(); }
    }),
    onValue(game('scores'), (s) => { scores = s.val() || {}; render(); }),
    onValue(game('reveal'), (s) => { reveal = s.val() || {}; render(); }),
  ];
}

function detach() {
  clearTimeout(timer);
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  pin = null; meta = null; state = null; questions = []; key = {};
  players = {}; attempts = {}; scores = {}; reveal = {}; starts = {};
}

// The game moves itself along, so everything hangs off the current state. Reloading the page resumes it.
function schedule() {
  clearTimeout(timer);
  endingEarly = false;
  if (!state) return;
  if (state.phase === 'question') {
    timer = setTimeout(showResults, Math.max(0, state.startedAt + meta.limitMs + 800 - serverNow()));
  } else if (state.phase === 'results') {
    timer = setTimeout(nextQuestion, Math.max(0, state.revealedAt + meta.revealMs - serverNow()));
  }
}

// Once every player is done there is nothing to wait for. The short pause lets the last pick show.
function endEarlyIfAllFinished() {
  const ids = Object.keys(players);
  const q = `q${state.idx}`;
  if (endingEarly || !ids.length || !ids.every((id) => hasFinished(meta.type, attempts[id]?.[q], key[q]))) return;
  endingEarly = true;
  clearTimeout(timer);
  timer = setTimeout(showResults, FINISH_PAUSE_MS);
}

async function nextQuestion() {
  const idx = state.idx + 1;
  if (idx >= questions.length) {
    await finish();
    return;
  }
  await update(game(''), {
    [`starts/q${idx}`]: serverTimestamp(),
    state: { phase: 'question', idx, startedAt: serverTimestamp(), current: questions[idx] },
  });
  starts = (await get(game('starts'))).val() || {};
}

async function showResults() {
  const q = `q${state.idx}`;
  const [a, st] = await Promise.all([get(game('attempts')), get(game('starts'))]);
  attempts = a.val() || {};
  starts = st.val() || {};
  const item = questions[state.idx];
  await update(game(''), {
    scores: totalScores(meta.type, Object.keys(players), attempts, key, starts, meta.limitMs),
    [`reveal/${q}`]: { q: item.q, o: item.o, val: item.o.map((_, i) => key[q][`o${i}`] || 0) },
    state: { phase: 'results', idx: state.idx, revealedAt: serverTimestamp() },
  });
}

async function finish() {
  const record = buildHistory({
    pin, meta, questions, key, players, attempts, scores, starts, endedAt: Date.now(),
  });
  await set(dbRef(`history/${meta.created}-${pin}`), record);
  await update(game('state'), { phase: 'final' });
}

// A game ended part-way is still saved, with the questions played so far.
async function saveStoppedGame() {
  const [a, st] = await Promise.all([get(game('attempts')), get(game('starts'))]);
  const played = st.val() || {};
  if (!Object.keys(played).length) return;
  const allAttempts = a.val() || {};
  await set(dbRef(`history/${meta.created}-${pin}`), buildHistory({
    pin,
    meta,
    questions: questions.slice(0, Object.keys(played).length),
    key,
    players,
    attempts: allAttempts,
    scores: totalScores(meta.type, Object.keys(players), allAttempts, key, played, meta.limitMs),
    starts: played,
    endedAt: Date.now(),
    stoppedEarly: true,
  }));
}

async function closeGame() {
  const running = state && state.phase !== 'final' && state.phase !== 'lobby';
  if (running) {
    if (!confirm('End this game now? The results so far will be saved to Event history.')) return;
    clearTimeout(timer);
    await saveStoppedGame();
  }
  const p = pin;
  detach();
  await remove(dbRef(`games/${p}`));
  await remove(dbRef(`hostGames/${uid}/current`));
  showPicker();
}

// ---------- screens ----------

const answeredCount = () => Object.values(attempts).filter((a) => a[`q${state.idx}`]).length;

function renderAnswered() {
  const el = document.getElementById('answered');
  if (el) el.textContent = `${answeredCount()} / ${Object.keys(players).length} answered`;
}

function boardHtml(n) {
  return `<ol class="board">${leaderboard(players, scores).slice(0, n).map((p, i) => `<li>
    <span>${i + 1}. ${esc(p.name)}</span><b>${p.s}</b></li>`).join('') || '<li class="mute">No players.</li>'}</ol>`;
}

function render() {
  if (!pin || !state || !meta) return;
  const closeLabel = state.phase === 'final' ? 'Close game' : 'End game';
  const close = `<button class="ghost" id="close">${closeLabel}</button>`;
  let html = '';
  if (state.phase === 'lobby') {
    const url = new URL(`index.html?pin=${pin}`, location.href).href;
    html = `<div class="card center"><h2>${esc(meta.title)}</h2>
      <p class="mute">Scan the code, or open the site and enter the PIN</p>
      <div class="pin">${pin}</div><div id="qr"></div><p class="mute small">${esc(url)}</p>
      <button class="full" id="start" ${Object.keys(players).length ? '' : 'disabled'}>Start (${Object.keys(players).length} joined)</button></div>
      <div class="card"><h2>Players</h2><div class="row">${Object.values(players).map((p) => `<span class="pill">${esc(p.name)}</span>`).join('') || '<span class="mute">Waiting for players</span>'}</div></div>
      <div class="row">${close}</div>`;
  } else if (state.phase === 'question' && state.current) {
    html = `<div class="card">
      <div class="row between"><span class="pill">Question ${state.idx + 1} / ${meta.total}</span><span class="pill timer" id="timer"></span></div>
      <div class="bar"><i id="bar"></i></div>
      <h2 class="question">${esc(state.current.q)}</h2>
      <div class="opts ${state.current.o.length > 5 ? 'many' : ''}">${state.current.o.map((x, j) => `<div class="opt"><span class="mark">${LETTERS[j]}</span><span class="txt">${esc(x)}</span></div>`).join('')}</div>
      <p class="center mute" id="answered"></p></div><div class="row">${close}</div>`;
  } else if (state.phase === 'results') {
    const r = reveal[`q${state.idx}`];
    if (!r) return;
    const ranked = rankedAnswers(r.o, r.val);
    const right = meta.type === 'survey'
      ? `<ol class="survey">${ranked.map((x) => `<li class="${x.people ? 'hit' : 'miss'}"><span class="rk">${x.rank || '–'}</span><span class="ans">${esc(x.text)}</span><b>${x.people} / ${SURVEY_PEOPLE}</b></li>`).join('')}</ol>`
      : `<p class="answer">✓ ${esc(ranked[0].text)}</p>`;
    html = `<div class="card"><h2>${esc(r.q)}</h2>${right}</div><div class="card"><h2>Top players</h2>${boardHtml(5)}</div><div class="row">${close}</div>`;
  } else if (state.phase === 'final') {
    html = `<div class="card"><h2>Final leaderboard</h2>${boardHtml(100)}
      <p class="mute">Saved to <a href="history.html">Event history</a>.</p></div><div class="row">${close}</div>`;
  }
  app.innerHTML = html;
  const qrBox = app.querySelector('#qr');
  if (qrBox && window.QRCode) {
    new window.QRCode(qrBox, { text: new URL(`index.html?pin=${pin}`, location.href).href, width: 200, height: 200 });
  }
  app.querySelector('#start')?.addEventListener('click', nextQuestion);
  app.querySelector('#close')?.addEventListener('click', closeGame);
  if (state.phase === 'question') { renderAnswered(); tick(); }
}

function tick() {
  const el = document.getElementById('timer');
  if (!el || state?.phase !== 'question') return;
  const left = Math.max(0, meta.limitMs - (serverNow() - state.startedAt));
  el.textContent = `${Math.ceil(left / 1000)}s`;
  document.getElementById('bar').style.width = `${(100 * left) / meta.limitMs}%`;
}
setInterval(tick, 200);
