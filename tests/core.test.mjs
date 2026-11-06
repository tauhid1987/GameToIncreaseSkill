import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseImport, validateQuestion, pickQuestions, buildGame, scoreQuestion, totalScores, leaderboard,
  buildHistory, historyCsv, listSets, nextSet, questionsInSet, hasFinished, peopleRank, rankedAnswers, CATEGORIES, QUESTIONS_PER_GAME, LIMIT_MS,
} from '../docs/js/core.js';

const sample = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');

test('every requested category exists, with one survey category', () => {
  const labels = CATEGORIES.map((c) => c.label);
  ['General Knowledge', 'Cricket', 'Football', 'BA', 'QA', 'Developer', 'RMG (Garments)', 'Present Time',
    'International Hot News', 'Tech Mix', 'Others'].forEach((l) => assert.ok(labels.includes(l), l));
  assert.equal(CATEGORIES.filter((c) => c.type === 'survey').length, 1);
  assert.equal(QUESTIONS_PER_GAME, 10);
  assert.equal(LIMIT_MS, 15000);
});

test('both sample files import cleanly as 10 questions', () => {
  const gk = parseImport(sample('general-knowledge.txt'), 'mcq');
  assert.deepEqual([gk.questions.length, gk.errors.length], [10, 0]);
  assert.equal(gk.questions[0].o[gk.questions[0].c], 'Dhaka');
  const survey = parseImport(sample('survey-jonomot.txt'), 'survey');
  assert.deepEqual([survey.questions.length, survey.errors.length], [10, 0]);
});

test('import reports bad blocks and keeps good ones, with Windows line endings', () => {
  const r = parseImport('Good?\r\n*Yes\r\nNo\r\n\r\nNo star?\r\nA\r\nB\r\n\r\nToo few?\r\n*A', 'mcq');
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.errors.map((e) => e.block), [2, 3]);
});

test('survey validation enforces 6-8 answers, 2+ wrong, a clear top 3 and 100 people', () => {
  const o = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const check = (p) => validateQuestion('survey', { q: 'x', o: o.slice(0, p.length), p });
  assert.equal(check([40, 30, 20, 10, 0, 0]), null);
  assert.equal(check([40, 25, 15, 12, 8, 0, 0]), null);
  assert.equal(check([35, 25, 15, 10, 10, 5, 0, 0]), null);
  assert.match(check([50, 30, 20, 0, 0]), /6 to 8/);
  assert.match(check([30, 20, 15, 10, 10, 5, 5, 3, 2].slice(0, 9)), /6 to 8/);
  assert.match(check([40, 30, 20, 10, 5, 0]), /at least 2 wrong/);
  assert.match(check([40, 30, 20, 5, 0, 0]), /add up to 100/);
  assert.match(check([40, 30, 15, 15, 0, 0]), /top 3/);
  assert.match(check([40, 30, NaN, 30, 0, 0]), /whole number/);
});

test('least-used questions are picked first', () => {
  const bank = Array.from({ length: 15 }, (_, i) => ({ id: i, used: i < 5 ? 3 : 0 }));
  const picked = pickQuestions(bank);
  assert.equal(picked.length, 10);
  assert.ok(picked.every((q) => q.used === 0));
});

test('buildGame keeps each answer tied to its value after shuffling, and hides values', () => {
  const picked = parseImport(sample('survey-jonomot.txt'), 'survey').questions;
  const { questions, key } = buildGame(picked, 'survey');
  questions.forEach((q, i) => {
    assert.deepEqual(Object.keys(q).sort(), ['o', 'q']);
    q.o.forEach((text, shown) => {
      const src = picked[i].o.indexOf(text);
      assert.equal(key[`q${i}`][`o${shown}`], picked[i].p[src]);
    });
  });
  const mcq = buildGame([{ q: 'x', o: ['a', 'b', 'c'], c: 1 }], 'mcq');
  const hit = mcq.questions[0].o.indexOf('b');
  assert.equal(mcq.key.q0[`o${hit}`], 1);
  assert.equal(Object.values(mcq.key.q0).reduce((a, b) => a + b), 1);
});

test('quick round: speed and wrong picks both lower the points', () => {
  const v = { o0: 0, o1: 1, o2: 0, o3: 0 };
  assert.equal(scoreQuestion('mcq', { o1: { at: 1000 } }, v, 1000).points, 1000);
  assert.equal(scoreQuestion('mcq', { o1: { at: 8500 } }, v, 1000).points, 750);
  assert.equal(scoreQuestion('mcq', { o1: { at: 16000 } }, v, 1000).points, 500);
  assert.equal(scoreQuestion('mcq', { o0: { at: 1000 }, o1: { at: 1000 + 1 } }, v, 1000).points, 750);
  assert.equal(scoreQuestion('mcq', { o0: { at: 1000 }, o2: { at: 1001 }, o1: { at: 1002 } }, v, 1000).points, 500);
  assert.equal(scoreQuestion('mcq', { o0: { at: 1000 } }, v, 1000).points, 0);
  assert.equal(scoreQuestion('mcq', undefined, v, 1000).points, 0);
});

test('survey: marks come from people found, timing adds up to 20%, and only the first 3 picks count', () => {
  const v = { o0: 50, o1: 0, o2: 30, o3: 20, o4: 0 };
  const at = (n) => ({ at: n });
  const END = LIMIT_MS;
  assert.equal(scoreQuestion('survey', { o0: at(END), o2: at(END), o3: at(END) }, v, 0).points, 100);
  assert.equal(scoreQuestion('survey', { o0: at(0), o2: at(0), o3: at(0) }, v, 0).points, 120);
  assert.equal(scoreQuestion('survey', { o0: at(END / 2) }, v, 0).points, 55);
  assert.equal(scoreQuestion('survey', { o1: at(1), o4: at(2) }, v, 0).points, 0);
  // A fourth or fifth pick, forced past the app, must not add anything.
  assert.equal(scoreQuestion('survey', { o1: at(END - 2), o4: at(END - 1), o0: at(END), o2: at(END + 1), o3: at(END + 2) }, v, 0).points, 50);
});

test('survey answers are ranked by how many of the 100 people gave them', () => {
  const people = [20, 0, 50, 0, 30];
  assert.deepEqual(people.map((p) => peopleRank(p, people)), [3, 0, 1, 0, 2]);
  assert.deepEqual(rankedAnswers(['a', 'b', 'c', 'd', 'e'], people).slice(0, 3).map((x) => [x.rank, x.text, x.people]), [[1, 'c', 50], [2, 'e', 30], [3, 'a', 20]]);
  assert.equal(peopleRank(40, [40, 40, 20, 0, 0]), 1, 'equal counts share a rank');
  const { questions, key, ranks } = buildGame([{ q: 'x', o: ['top', 'mid', 'low', 'no1', 'no2'], p: [50, 30, 20, 0, 0] }], 'survey');
  questions[0].o.forEach((text, shown) => {
    const expected = { top: 1, mid: 2, low: 3, no1: 0, no2: 0 }[text];
    assert.equal(ranks.q0[`o${shown}`], expected);
    assert.ok(key.q0[`o${shown}`] >= 0);
  });
});

test('with 3 picks and 6-8 answers, the top 3 give the best score', () => {
  const v = { o0: 40, o1: 25, o2: 15, o3: 12, o4: 8, o5: 0, o6: 0 };
  const at = { at: LIMIT_MS };
  assert.equal(scoreQuestion('survey', { o0: at, o1: at, o2: at }, v, 0).points, 80);
  assert.equal(scoreQuestion('survey', { o0: at, o3: at, o4: at }, v, 0).points, 60);
  assert.equal(hasFinished('survey', { o0: at, o5: at, o6: at }, v), true);
});

test('more people found beats a faster but smaller find', () => {
  const v = { o0: 50, o1: 30, o2: 20, o3: 0, o4: 0 };
  const slow = scoreQuestion('survey', { o0: { at: LIMIT_MS } }, v, 0).points;
  const fast = scoreQuestion('survey', { o1: { at: 0 } }, v, 0).points;
  assert.ok(slow > fast);
});

test('import sorts questions into sets, and sets list in natural order', () => {
  const blocks = (name, n) => `## ${name}\n\n${Array.from({ length: n }, (_, i) => `${name} q${i}?\n*a\nb`).join('\n\n')}`;
  const { questions, errors } = parseImport(`${blocks('Set 10', 10)}\n\n${blocks('Set 2', 10)}\n\n${blocks('Set 3', 4)}`, 'mcq');
  assert.equal(errors.length, 0);
  assert.deepEqual(listSets(questions).map((s) => [s.name, s.count, s.ready]), [['Set 2', 10, true], ['Set 3', 4, false], ['Set 10', 10, true]]);
  assert.equal(questionsInSet(questions, 'Set 10').length, 10);
  assert.equal(nextSet(questions), 'Set 2');
  questionsInSet(questions, 'Set 2').forEach((q) => { q.used = 1; });
  assert.equal(nextSet(questions), 'Set 10', 'the least-played ready set is next');
  assert.equal(parseImport('Q?\n*a\nb', 'mcq', 'Mine').questions[0].set, 'Mine');
});

test('a player has finished when nothing is left to do', () => {
  const mcq = { o0: 0, o1: 1, o2: 0 };
  assert.equal(hasFinished('mcq', undefined, mcq), false);
  assert.equal(hasFinished('mcq', { o0: { at: 1 } }, mcq), false, 'wrong so far: may still re-choose');
  assert.equal(hasFinished('mcq', { o1: { at: 1 } }, mcq), true);
  const survey = { o0: 50, o1: 30, o2: 20, o3: 0, o4: 0 };
  assert.equal(hasFinished('survey', { o0: { at: 1 }, o3: { at: 2 } }, survey), false);
  assert.equal(hasFinished('survey', { o0: { at: 1 }, o3: { at: 2 }, o4: { at: 3 } }, survey), true);
});

test('highest total wins, and less time breaks a tie', () => {
  const players = { a: { name: 'Ann' }, b: { name: 'Bob' }, c: { name: 'Cy' } };
  const key = { q0: { o0: 50, o1: 30, o2: 20, o3: 0, o4: 0 } };
  const attempts = { a: { q0: { o0: { at: 5000 } } }, b: { q0: { o0: { at: 2000 } } }, c: { q0: { o1: { at: 1000 } } } };
  const scores = totalScores('survey', Object.keys(players), attempts, key, { q0: 1000 });
  assert.deepEqual(leaderboard(players, scores).map((p) => p.name), ['Bob', 'Ann', 'Cy']);
});

test('history records the event, and the CSV neutralises spreadsheet formulas', () => {
  const players = { a: { name: '=HACK()' }, b: { name: 'Bob' } };
  const key = { q0: { o0: 1, o1: 0 } };
  const attempts = { a: { q0: { o1: { at: 10 }, o0: { at: 20 } } } };
  const starts = { q0: 0 };
  const meta = { title: 'T', cat: 'gk', type: 'mcq', created: 1, limitMs: 15000 };
  const scores = totalScores('mcq', Object.keys(players), attempts, key, starts);
  const h = buildHistory({ pin: '123456', meta, questions: [{ q: 'Q?', o: ['yes', 'no'] }], key, players, attempts, scores, starts, endedAt: 2 });
  assert.equal(h.winner, '=HACK()');
  assert.deepEqual(h.players[0].answers[0].picks, [1, 0]);
  assert.deepEqual(h.questions[0].picks, [1, 1]);
  assert.equal(h.players[1].answers[0].points, 0);
  const csv = historyCsv(h);
  assert.ok(csv.includes(`"'=HACK()"`));
  assert.ok(csv.includes('no > yes'));
});
