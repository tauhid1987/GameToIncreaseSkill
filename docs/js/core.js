// Game rules and data shaping. No Firebase and no DOM here, so it can be unit tested in Node.

export const QUESTIONS_PER_GAME = 10;
export const LIMIT_MS = 15000;        // time to answer each question
export const SURVEY_LIMIT_MS = 20000; // the survey has more answers to read
export const REVEAL_MS = 3000;        // how long the answer stays on screen before auto-next
export const QUICK_GAP_MS = 1500;     // pause between quick-round questions, with no answer shown
export const ALL_ANSWERED_WAIT_MS = 3000; // once everyone has answered, time left to change an answer
export const SURVEY_MIN_OPTIONS = 6;
export const SURVEY_MAX_OPTIONS = 8;
export const SURVEY_MIN_WRONG = 2;
export const SURVEY_PICKS = 3;        // picks per survey question; a wrong pick uses one up
export const SURVEY_PEOPLE = 100;
export const SURVEY_SPEED_BONUS = 0.2; // an instant right pick earns 20% on top of its people count
export const DEFAULT_SET = 'Set 1';

// To add a category, add a line here. Nothing else needs to change.
export const CATEGORIES = [
  { id: 'gk', label: 'General Knowledge', type: 'mcq' },
  { id: 'cricket', label: 'Cricket', type: 'mcq' },
  { id: 'football', label: 'Football', type: 'mcq' },
  { id: 'ba', label: 'BA', type: 'mcq' },
  { id: 'qa', label: 'QA', type: 'mcq' },
  { id: 'developer', label: 'Developer', type: 'mcq' },
  { id: 'rmg', label: 'RMG (Garments)', type: 'mcq' },
  { id: 'present', label: 'Present Time', type: 'mcq' },
  { id: 'world-news', label: 'International Hot News', type: 'mcq' },
  { id: 'tech-mix', label: 'Tech Mix', type: 'mcq' },
  { id: 'others', label: 'Others', type: 'mcq' },
  { id: 'jonomot', label: 'জনমত ১০০ (100 People Survey)', type: 'survey' },
];

export const categoryById = (id) => CATEGORIES.find((c) => c.id === id);

const clean = (s) => String(s ?? '').trim();
export const normalizeText = (s) => clean(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ');

// The same question text always gets the same database key, so importing it twice can't make a copy.
export function questionKey(text) {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (const ch of normalizeText(text)) {
    const code = ch.codePointAt(0);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `q${(b >>> 0).toString(16).padStart(8, '0')}${(a >>> 0).toString(16).padStart(8, '0')}`;
}

// Finds repeated questions in the bank. The oldest copy of each stays.
export function findDuplicates(bank) {
  const repeats = [];
  Object.entries(bank || {}).forEach(([cat, items]) => {
    const groups = new Map();
    Object.entries(items || {}).forEach(([id, q]) => {
      const k = normalizeText(q.q);
      groups.set(k, [...(groups.get(k) || []), { id, ...q }]);
    });
    groups.forEach((copies) => {
      if (copies.length < 2) return;
      copies.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || x.id.localeCompare(y.id));
      const [keep, ...extra] = copies;
      repeats.push({ cat, set: keep.set || DEFAULT_SET, q: keep.q, extra: extra.map((c) => c.id) });
    });
  });
  return repeats;
}

// ---------- validating one question ----------

export function validateQuestion(type, q) {
  if (!clean(q.q)) return 'The question text is empty.';
  const o = (q.o || []).map(clean);
  if (o.some((x) => !x)) return 'An answer is empty.';
  if (new Set(o.map(normalizeText)).size !== o.length) return 'Two answers are the same.';
  if (type === 'mcq') {
    if (o.length < 2 || o.length > 4) return 'A question needs 2 to 4 answers.';
    if (!Number.isInteger(q.c) || q.c < 0 || q.c >= o.length) return 'Mark one answer as correct.';
    return null;
  }
  if (o.length < SURVEY_MIN_OPTIONS || o.length > SURVEY_MAX_OPTIONS) {
    return `A survey question needs ${SURVEY_MIN_OPTIONS} to ${SURVEY_MAX_OPTIONS} answers.`;
  }
  const p = q.p || [];
  if (p.length !== o.length || p.some((n) => !Number.isInteger(n) || n < 0)) {
    return 'Every answer needs a whole number of people (0 for a wrong answer).';
  }
  if (p.filter((n) => n === 0).length < SURVEY_MIN_WRONG) {
    return `A survey question needs at least ${SURVEY_MIN_WRONG} wrong answers (0 people).`;
  }
  const total = p.reduce((a, b) => a + b, 0);
  if (total !== SURVEY_PEOPLE) return `The people must add up to ${SURVEY_PEOPLE} (now ${total}).`;
  const ranked = p.filter((n) => n > 0).sort((a, b) => b - a);
  if (ranked[2] <= ranked[3]) return 'The top 3 answers must each have more people than the rest.';
  return null;
}

// ---------- bulk import ----------
//
// Questions are separated by a blank line. The first line is the question.
// Quick round: 2-4 answer lines, with * before the correct one.
// Survey:      6-8 answer lines as "answer | people", with 0 for at least 2 wrong answers.
// A line "## Set name" puts the questions after it into that set.

export function parseImport(text, type, defaultSet = DEFAULT_SET) {
  const blocks = String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)
    .map((b) => b.split('\n').map(clean).filter(Boolean));
  const questions = [];
  const errors = [];
  let set = defaultSet;
  let number = 0;
  blocks.forEach((raw) => {
    const lines = raw.filter((l) => {
      if (!l.startsWith('#')) return true;
      if (l.startsWith('## ')) set = clean(l.slice(3)) || set;
      return false;
    });
    if (!lines.length) return;
    number += 1;
    const q = type === 'survey' ? parseSurveyBlock(lines) : parseMcqBlock(lines);
    const err = validateQuestion(type, q);
    if (err) errors.push({ block: number, question: lines[0], message: err });
    else questions.push({ ...q, set });
  });
  return { questions, errors };
}

// ---------- question sets ----------

export const setOf = (q) => q.set || DEFAULT_SET;
const bySetName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// items is a list of questions. Returns one row per set, in natural order (Set 2 before Set 10).
export function listSets(items) {
  const sets = new Map();
  items.forEach((q) => {
    const row = sets.get(setOf(q)) || { name: setOf(q), texts: new Set(), used: 0 };
    row.texts.add(normalizeText(q.q));
    row.used += q.used || 0;
    sets.set(row.name, row);
  });
  return [...sets.values()]
    .map(({ texts, ...s }) => ({
      ...s,
      count: texts.size,
      ready: texts.size >= QUESTIONS_PER_GAME,
      plays: Math.ceil(s.used / Math.max(texts.size, 1)),
    }))
    .sort((a, b) => bySetName(a.name, b.name));
}

// The ready set that has been played least, for the "next set" button.
export function nextSet(items) {
  return listSets(items).filter((s) => s.ready).sort((a, b) => a.used - b.used || bySetName(a.name, b.name))[0]?.name || null;
}

export const questionsInSet = (items, name) => items.filter((q) => setOf(q) === name);

function parseMcqBlock([q, ...rest]) {
  let c = -1;
  const o = rest.map((line, i) => {
    if (!line.startsWith('*')) return line;
    if (c === -1) c = i;
    return line.slice(1).trim();
  });
  return { q, o, c };
}

function parseSurveyBlock([q, ...rest]) {
  const o = [];
  const p = [];
  rest.forEach((line) => {
    const cut = line.lastIndexOf('|');
    o.push(cut < 0 ? line : line.slice(0, cut).trim());
    p.push(cut < 0 ? NaN : Number(line.slice(cut + 1).trim()));
  });
  return { q, o, p };
}

// ---------- building a game ----------

export function shuffled(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Least-used questions first, and never the same question twice in one game.
export function pickQuestions(bank, n = QUESTIONS_PER_GAME, rng = Math.random) {
  const seen = new Set();
  return shuffled(bank, rng)
    .sort((a, b) => (a.used || 0) - (b.used || 0))
    .filter((q) => {
      const k = normalizeText(q.q);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, n);
}

// Rank of a survey answer among the 100 people: 1 is the most popular. Wrong answers have no rank (0).
export function peopleRank(value, allValues) {
  return value > 0 ? 1 + allValues.filter((v) => v > value).length : 0;
}

// A survey question's answers, most popular first, for result screens.
// True when every player has finished question q: one answer, or all the picks in the survey.
export function everyoneAnswered(type, playerIds, attempts, q) {
  const needed = type === 'survey' ? SURVEY_PICKS : 1;
  return playerIds.length > 0
    && playerIds.every((id) => Object.keys(attempts?.[id]?.[q] || {}).length >= needed);
}

export function rankedAnswers(options, values) {
  return options
    .map((text, i) => ({ text, i, people: values[i] || 0, rank: peopleRank(values[i] || 0, values) }))
    .sort((a, b) => b.people - a.people);
}

// Shuffles the answers and separates them from their values. Players only ever get `questions`.
export function buildGame(picked, type, rng = Math.random) {
  const questions = [];
  const key = {};
  picked.forEach((item, qi) => {
    const order = shuffled(item.o.map((_, i) => i), rng);
    questions.push({ q: item.q, o: order.map((i) => item.o[i]) });
    const values = {};
    order.forEach((src, shown) => {
      values[`o${shown}`] = type === 'survey' ? item.p[src] : (src === item.c ? 1 : 0);
    });
    key[`q${qi}`] = values;
  });
  return { questions, key };
}

// ---------- scoring ----------

// Turns { o2: {at}, o0: {at} } into attempts in the order they were made.
export function orderedAttempts(raw) {
  return Object.entries(raw || {})
    .map(([k, v]) => ({ opt: Number(k.slice(1)), at: v.at }))
    .sort((a, b) => a.at - b.at || a.opt - b.opt);
}

export function scoreQuestion(type, rawAttempts, values, startedAt, limitMs = LIMIT_MS) {
  const attempts = orderedAttempts(rawAttempts);
  const valueOf = (a) => values?.[`o${a.opt}`] || 0;
  if (type === 'survey') {
    const used = attempts.slice(0, SURVEY_PICKS);
    const hits = used.filter((a) => valueOf(a) > 0);
    const timeOf = (a) => Math.max(0, a.at - startedAt);
    return {
      points: Math.round(hits.reduce((sum, a) => (
        sum + valueOf(a) * (1 + SURVEY_SPEED_BONUS * Math.max(0, 1 - timeOf(a) / limitMs))
      ), 0)),
      ms: hits.length ? timeOf(hits[hits.length - 1]) : 0,
    };
  }
  // A quick-round player has one answer: the last one chosen before time ran out.
  const last = attempts[attempts.length - 1];
  if (!last || valueOf(last) <= 0) return { points: 0, ms: 0 };
  const ms = Math.max(0, last.at - startedAt);
  return { points: Math.round(500 + 500 * Math.max(0, 1 - ms / limitMs)), ms };
}

// starts is { q0: startedAt, q1: startedAt, ... } for the questions played so far.
export function totalScores(type, playerIds, attempts, key, starts, limitMs = LIMIT_MS) {
  const out = {};
  playerIds.forEach((id) => {
    let s = 0;
    let ms = 0;
    Object.keys(starts).forEach((q) => {
      const r = scoreQuestion(type, attempts?.[id]?.[q], key?.[q], starts[q], limitMs);
      s += r.points;
      ms += r.ms;
    });
    out[id] = { s, ms };
  });
  return out;
}

// Highest score wins. On equal scores, the player who took less time ranks higher.
export function leaderboard(players, scores) {
  return Object.keys(players || {})
    .map((id) => ({ id, name: players[id].name, s: scores?.[id]?.s || 0, ms: scores?.[id]?.ms || 0 }))
    .sort((a, b) => b.s - a.s || a.ms - b.ms || a.name.localeCompare(b.name));
}

// ---------- event history ----------

export function buildHistory({ pin, meta, questions, key, players, attempts, scores, starts, endedAt, stoppedEarly = false }) {
  const board = leaderboard(players, scores);
  const answered = (id, qi) => orderedAttempts(attempts?.[id]?.[`q${qi}`]);
  return {
    pin,
    title: meta.title,
    cat: meta.cat,
    set: meta.set || '',
    type: meta.type,
    created: meta.created,
    endedAt,
    stoppedEarly,
    playerCount: board.length,
    winner: board[0]?.name || '',
    topScore: board[0]?.s || 0,
    players: board.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.s,
      ms: p.ms,
      answers: questions.map((_, qi) => {
        const q = `q${qi}`;
        const r = scoreQuestion(meta.type, attempts?.[p.id]?.[q], key[q], starts[q] || 0, meta.limitMs);
        return { picks: answered(p.id, qi).map((a) => a.opt), points: starts[q] ? r.points : 0 };
      }),
    })),
    questions: questions.map((item, qi) => ({
      q: item.q,
      o: item.o,
      values: item.o.map((_, i) => key[`q${qi}`][`o${i}`] || 0),
      picks: item.o.map((_, i) => board.filter((p) => attempts?.[p.id]?.[`q${qi}`]?.[`o${i}`]).length),
    })),
  };
}

export function historyCsv(h) {
  const head = ['Rank', 'Player', 'Score', 'Time (s)'];
  h.questions.forEach((_, i) => head.push(`Q${i + 1} picks`, `Q${i + 1} points`));
  const rows = (h.players || []).map((p) => {
    const row = [p.rank, p.name, p.score, (p.ms / 1000).toFixed(1)];
    h.questions.forEach((q, i) => {
      const a = p.answers?.[i];
      row.push((a?.picks || []).map((n) => q.o[n]).join(' > '), a?.points || 0);
    });
    return row;
  });
  const cell = (v) => {
    const s = String(v);
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  return `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\n')}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
