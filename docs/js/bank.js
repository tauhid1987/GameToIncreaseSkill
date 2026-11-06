import { dbRef, get, set, update, remove, push, requireHost } from './fb.js';
import {
  CATEGORIES, QUESTIONS_PER_GAME, SURVEY_MAX_OPTIONS, DEFAULT_SET, categoryById, parseImport, validateQuestion,
  normalizeText, listSets, setOf, esc,
} from './core.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
let uid;
let catId = categoryById(params.get('cat')) ? params.get('cat') : CATEGORIES[0].id;
let setName = params.get('set') || null;
let bank = {};
let items = {};
let editing = null;     // id of the question loaded in the form
let notice = '';
let importErrors = [];

const cat = () => categoryById(catId);
const countIn = (id) => Object.keys(bank[id] || {}).length;

init();

async function init() {
  uid = (await requireHost(app)).uid;
  await reload();
}

async function reload() {
  bank = (await get(dbRef('bank'))).val() || {};
  items = bank[catId] || {};
  const sets = listSets(Object.values(items));
  if (!setName || !sets.some((s) => s.name === setName)) setName = sets.at(-1)?.name || DEFAULT_SET;
  render();
}

function formHtml(q) {
  if (cat().type === 'survey') {
    const rows = Array.from({ length: SURVEY_MAX_OPTIONS }, (_, i) => `<div class="optrow">
      <input class="f-opt" placeholder="Answer ${i + 1}${i > 5 ? ' (optional)' : ''}" value="${esc(q?.o?.[i] || '')}">
      <input class="f-people" type="number" min="0" max="100" placeholder="People" value="${q?.p?.[i] ?? ''}"></div>`).join('');
    return `<label>Question<input id="f-q" value="${esc(q?.q || '')}"></label>
      <p class="mute small">Use 6 to 8 answers. Ranked answers add up to 100 with the top 3 clearly highest, plus at least 2 close-sounding wrong answers with 0.</p>${rows}`;
  }
  const rows = Array.from({ length: 4 }, (_, i) => `<div class="optrow">
    <input type="radio" name="f-c" value="${i}" ${q?.c === i ? 'checked' : ''} aria-label="Answer ${i + 1} is correct">
    <input class="f-opt" placeholder="Answer ${i + 1}${i > 1 ? ' (optional)' : ''}" value="${esc(q?.o?.[i] || '')}"></div>`).join('');
  return `<label>Question<input id="f-q" value="${esc(q?.q || '')}"></label>
    <p class="mute small">Select the circle beside the correct answer.</p>${rows}`;
}

function readForm() {
  const q = app.querySelector('#f-q').value.trim();
  const inputs = [...app.querySelectorAll('.f-opt')].map((el) => el.value.trim());
  if (cat().type === 'survey') {
    const people = [...app.querySelectorAll('.f-people')].map((el) => (el.value === '' ? NaN : Number(el.value)));
    const used = inputs.map((text, i) => ({ text, n: people[i] })).filter((row) => row.text);
    return { q, o: used.map((row) => row.text), p: used.map((row) => row.n) };
  }
  const chosen = Number(app.querySelector('input[name="f-c"]:checked')?.value ?? -1);
  const o = inputs.filter(Boolean);
  // Blank optional rows are dropped, so find where the chosen answer ended up.
  const c = chosen >= 0 && inputs[chosen] ? o.indexOf(inputs[chosen]) : -1;
  return { q, o, c };
}

function render() {
  const sets = listSets(Object.values(items));
  const hasCurrent = sets.some((s) => s.name === setName);
  const options = hasCurrent ? sets : [...sets, { name: setName, count: 0 }];
  const rows = Object.entries(items)
    .filter(([, q]) => setOf(q) === setName)
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  const n = rows.length;
  const readySets = sets.filter((s) => s.ready).length;
  app.innerHTML = `<div class="card"><h2>Question bank</h2>
    <label>Category<select id="cat">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === catId ? 'selected' : ''}>${esc(c.label)} (${countIn(c.id)})</option>`).join('')}</select></label>
    <div class="row"><label class="grow">Question set<select id="set">${options.map((s) => `<option value="${esc(s.name)}" ${s.name === setName ? 'selected' : ''}>${esc(s.name)} (${s.count})</option>`).join('')}</select></label>
      <button class="ghost" id="newset" type="button">New set</button></div>
    <p class="${n >= QUESTIONS_PER_GAME ? 'okay' : 'error'}">${esc(setName)} has ${n} question${n === 1 ? '' : 's'}. ${n >= QUESTIONS_PER_GAME ? 'Ready to host.' : `Add ${QUESTIONS_PER_GAME - n} more to host it.`}</p>
    <p class="mute small">${readySets} set${readySets === 1 ? '' : 's'} ready in this category.</p>
    ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}</div>

    <form class="card" id="form"><h2>${editing ? 'Edit question' : `Add a question to ${esc(setName)}`}</h2>${formHtml(editing ? items[editing] : null)}
      <div class="row"><button>${editing ? 'Save changes' : 'Add question'}</button>${editing ? '<button type="button" class="ghost" id="cancel">Cancel</button>' : ''}</div></form>

    <div class="card"><h2>Import many</h2>
      <p class="mute small">${cat().type === 'survey'
    ? 'Leave a blank line between questions. Line 1 is the question, then 6 to 8 lines as <code>answer | people</code>.'
    : 'Leave a blank line between questions. Line 1 is the question, then 2 to 4 answers, with <code>*</code> before the correct one.'}
        A line <code>## Set name</code> starts a set. Without one, questions go into ${esc(setName)}.</p>
      <textarea id="imp" rows="8"></textarea>
      <div class="row"><input type="file" id="file" accept=".txt,text/plain"><button id="import" type="button">Import to ${esc(cat().label)}</button></div>
      <h3>Import a full question pack</h3>
      <p class="mute small">Choose all the files in the <code>questions</code> folder. Each file goes to the category in its name, and questions already in the bank are skipped.</p>
      <input type="file" id="pack" accept=".txt,text/plain" multiple>
      ${importErrors.length ? `<ul class="errors">${importErrors.map((e) => `<li>${e.file ? `${esc(e.file)}, ` : ''}block ${e.block}${e.question ? ` ("${esc(e.question)}")` : ''}: ${esc(e.message)}</li>`).join('')}</ul>` : ''}
    </div>

    <div class="card"><h2>Questions in ${esc(setName)}</h2>
      ${rows.map(([id, q], i) => `<div class="qitem"><div><b>${i + 1}.</b> ${esc(q.q)}
        <div class="mute small">${q.o.map((x, j) => (cat().type === 'survey' ? `${esc(x)} (${q.p[j]})` : (j === q.c ? `<b class="okay">${esc(x)}</b>` : esc(x)))).join(' · ')} · used ${q.used || 0}x</div></div>
        <div class="row"><button class="ghost" data-edit="${id}">Edit</button><button class="ghost" data-del="${id}">Delete</button></div></div>`).join('') || '<p class="mute">Nothing here yet.</p>'}
    </div>`;

  const clearMessages = () => { editing = null; notice = ''; importErrors = []; };
  app.querySelector('#cat').onchange = (e) => {
    catId = e.target.value;
    setName = null;
    clearMessages();
    history.replaceState(null, '', `?cat=${encodeURIComponent(catId)}`);
    reload();
  };
  app.querySelector('#set').onchange = (e) => {
    setName = e.target.value;
    clearMessages();
    render();
  };
  app.querySelector('#newset').onclick = () => {
    const box = app.querySelector('#newset').parentElement;
    if (box.querySelector('#newname')) return;
    box.insertAdjacentHTML('beforeend', `<label class="grow">New set name<input id="newname" maxlength="40" value="${esc(suggestSetName(sets))}"></label>
      <button class="ghost" id="newok" type="button">Create</button>`);
    box.querySelector('#newname').focus();
    box.querySelector('#newok').onclick = () => {
      const name = box.querySelector('#newname').value.trim();
      if (!name) return;
      setName = name;
      clearMessages();
      render();
    };
  };
  app.querySelector('#form').onsubmit = saveForm;
  app.querySelector('#cancel')?.addEventListener('click', () => { editing = null; render(); });
  app.querySelector('#import').onclick = runImport;
  app.querySelector('#pack').onchange = (e) => importPack([...e.target.files]);
  app.querySelector('#file').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) app.querySelector('#imp').value = await f.text();
  };
  app.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => { editing = b.dataset.edit; notice = ''; render(); app.querySelector('#form').scrollIntoView(); };
  });
  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Delete this question?\n\n${items[b.dataset.del].q}`)) return;
      await remove(dbRef(`bank/${catId}/${b.dataset.del}`));
      notice = 'Question deleted.';
      if (editing === b.dataset.del) editing = null;
      reload();
    };
  });
}

function suggestSetName(sets) {
  const taken = new Set(sets.map((s) => s.name));
  let i = sets.length + 1;
  while (taken.has(`Set ${i}`)) i += 1;
  return `Set ${i}`;
}

const isDuplicate = (text, exceptId) => Object.entries(items)
  .some(([id, q]) => id !== exceptId && normalizeText(q.q) === normalizeText(text));

async function saveForm(e) {
  e.preventDefault();
  const q = readForm();
  const err = validateQuestion(cat().type, q) || (isDuplicate(q.q, editing) ? 'This question is already in this category.' : null);
  if (err) {
    const box = app.querySelector('#form');
    box.querySelector('.notice')?.remove();
    box.insertAdjacentHTML('afterbegin', `<p class="notice error">${esc(err)}</p>`);
    return;
  }
  if (editing) {
    await update(dbRef(`bank/${catId}/${editing}`), q);
    notice = 'Question saved.';
    editing = null;
  } else {
    await set(push(dbRef(`bank/${catId}`)), { ...q, set: setName, used: 0, createdAt: Date.now(), createdBy: uid });
    notice = 'Question added.';
  }
  reload();
}

// Adds new questions to a category and reports how many were skipped.
async function addQuestions(id, existing, questions) {
  const seen = new Set(Object.values(existing).map((q) => normalizeText(q.q)));
  const fresh = questions.filter((q) => {
    const k = normalizeText(q.q);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const now = Date.now();
  const writes = {};
  fresh.forEach((q, i) => {
    writes[push(dbRef(`bank/${id}`)).key] = { ...q, used: 0, createdAt: now + i, createdBy: uid };
  });
  if (fresh.length) await update(dbRef(`bank/${id}`), writes);
  return { added: fresh.length, duplicates: questions.length - fresh.length };
}

async function runImport() {
  const { questions, errors } = parseImport(app.querySelector('#imp').value, cat().type, setName);
  importErrors = errors;
  const r = await addQuestions(catId, items, questions);
  notice = `Imported ${r.added}. Skipped ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} and ${errors.length} with problems.`;
  reload();
}

async function importPack(files) {
  importErrors = [];
  let added = 0;
  let duplicates = 0;
  const skippedFiles = [];
  for (const file of files) {
    const base = file.name.replace(/\.txt$/i, '');
    const target = CATEGORIES.find((c) => c.id === base || base.startsWith(`${c.id}-`));
    if (!target) {
      skippedFiles.push(file.name);
      continue;
    }
    const { questions, errors } = parseImport(await file.text(), target.type);
    importErrors.push(...errors.map((e) => ({ ...e, file: file.name })));
    const existing = (await get(dbRef(`bank/${target.id}`))).val() || {};
    const r = await addQuestions(target.id, existing, questions);
    added += r.added;
    duplicates += r.duplicates;
  }
  notice = `Pack imported: ${added} added, ${duplicates} already there, ${importErrors.length} with problems.${skippedFiles.length ? ` Files with no matching category: ${skippedFiles.join(', ')}.` : ''}`;
  reload();
}
