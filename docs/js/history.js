import { dbRef, get, requireHost } from './fb.js';
import { categoryById, historyCsv, peopleRank, SURVEY_PEOPLE, esc } from './core.js';

const app = document.getElementById('app');
let events = {};

const when = (ms) => new Date(ms).toLocaleString();

init();

async function init() {
  await requireHost(app);
  events = (await get(dbRef('history'))).val() || {};
  showList();
}

function showList() {
  const rows = Object.entries(events).sort((a, b) => b[1].created - a[1].created);
  app.innerHTML = `<div class="card"><h2>Event history</h2>
    ${rows.length ? `<div class="table"><table><thead><tr><th>Date</th><th>Event</th><th>Category</th><th>Players</th><th>Winner</th><th>Score</th></tr></thead><tbody>
      ${rows.map(([id, h]) => `<tr data-id="${esc(id)}" tabindex="0"><td>${esc(when(h.created))}</td><td>${esc(h.title)}</td><td>${esc(categoryById(h.cat)?.label || h.cat)}</td><td>${h.playerCount}</td><td>${esc(h.winner)}</td><td>${h.topScore}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="mute">No finished events yet. Each game is saved here when it ends.</p>'}</div>`;
  app.querySelectorAll('[data-id]').forEach((row) => {
    row.onclick = () => showEvent(row.dataset.id);
    row.onkeydown = (e) => { if (e.key === 'Enter') showEvent(row.dataset.id); };
  });
}

function showEvent(id) {
  const h = events[id];
  const players = h.players || [];
  const survey = h.type === 'survey';
  app.innerHTML = `<div class="row"><button class="ghost" id="back">Back to all events</button><button id="csv">Download CSV</button></div>
    <div class="card"><h2>${esc(h.title)}</h2>
      <p class="mute">${esc(categoryById(h.cat)?.label || h.cat)} · ${esc(when(h.created))} · Game ${esc(h.pin)} · ${h.playerCount} players</p>
      <ol class="board">${players.map((p) => `<li><span>${p.rank}. ${esc(p.name)}</span><b>${p.score}</b></li>`).join('') || '<li class="mute">No players.</li>'}</ol></div>
    <div class="card"><h2>Questions</h2>${h.questions.map((q, i) => `<div class="review"><b>Q${i + 1}.</b> ${esc(q.q)}
      <ul class="picks">${q.o.map((x, j) => `<li class="${q.values[j] ? 'okay' : ''}">${q.values[j] ? '✓' : ' '} ${esc(x)}${survey ? ` (${q.values[j] ? `Rank ${peopleRank(q.values[j], q.values)} · ` : ''}${q.values[j]} / ${SURVEY_PEOPLE})` : ''} <span class="mute">· chosen by ${q.picks[j]}</span></li>`).join('')}</ul></div>`).join('')}</div>
    <div class="card"><h2>Answers by player</h2>${players.map((p) => `<details><summary><b>${p.rank}. ${esc(p.name)}</b> · ${p.score} points</summary>
      ${h.questions.map((q, i) => {
    const a = p.answers?.[i];
    const picks = (a?.picks || []).map((n) => `<span class="${q.values[n] ? 'okay' : 'nope'}">${q.values[n] ? '✓' : '✕'} ${esc(q.o[n])}</span>`).join(' ');
    return `<div class="review"><b>Q${i + 1}.</b> ${esc(q.q)} <span class="mute">(${a?.points || 0} points)</span><br>${picks || '<span class="mute">No answer</span>'}</div>`;
  }).join('')}</details>`).join('') || '<p class="mute">No players.</p>'}</div>`;
  app.querySelector('#back').onclick = showList;
  app.querySelector('#csv').onclick = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([historyCsv(h)], { type: 'text/csv;charset=utf-8' }));
    link.download = `quiz-${h.pin}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
}
