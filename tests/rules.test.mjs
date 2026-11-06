// Checks the database rules on the local emulator. Run with: npm run test:rules
import test, { before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, get, set, update, remove, serverTimestamp } from 'firebase/database';

const PIN = '123456';
let env;
const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).database();
const at = () => ({ at: serverTimestamp() });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-quiz-arena',
    database: { rules: readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'), host: '127.0.0.1', port: 9000 },
  });
});
after(() => env.cleanup());

async function seed({ phase = 'question', idx = 0, startedAgo = 1000 } = {}) {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database()), {
      hosts: { host: true },
      bank: { gk: { b1: { q: 'bank question', o: ['a', 'b'], c: 0 } } },
      history: { e1: { title: 'old event' } },
      games: {
        [PIN]: {
          meta: { hostUid: 'host', title: 'T', type: 'mcq', total: 2, limitMs: 15000 },
          questions: [{ q: 'Q1', o: ['a', 'b'] }, { q: 'Q2', o: ['c', 'd'] }],
          key: { q0: { o0: 1, o1: 0 }, q1: { o0: 0, o1: 1 } },
          ranks: { q0: { o0: 1, o1: 0 } },
          state: { phase, idx, startedAt: Date.now() - startedAgo, current: { q: 'Q1', o: ['a', 'b'] } },
          players: { p1: { name: 'One' }, p2: { name: 'Two' } },
        },
      },
    });
  });
}
const g = (d, path) => ref(d, `games/${PIN}/${path}`);

beforeEach(() => seed());

test('players cannot read the answer key before they pick', async () => {
  await assertFails(get(g(db('p1'), 'key')));
  await assertFails(get(g(db('p1'), 'key/q0')));
  await assertFails(get(g(db('p1'), 'key/q0/o0')));
});

test('players cannot read upcoming questions or the whole game', async () => {
  await assertFails(get(g(db('p1'), 'questions')));
  await assertFails(get(ref(db('p1'), `games/${PIN}`)));
  await assertFails(get(ref(db('p1'), 'games')));
});

test('after picking, a player can read that option only', async () => {
  const d = db('p1');
  await assertSucceeds(set(g(d, 'attempts/p1/q0/o1'), at()));
  await assertSucceeds(get(g(d, 'key/q0/o1')));
  await assertFails(get(g(d, 'key/q0/o0')));
  await assertSucceeds(get(g(d, 'ranks/q0/o1')));
  await assertFails(get(g(d, 'ranks/q0/o0')));
  await assertFails(get(g(d, 'ranks')));
});

test('re-choosing: a second option is allowed, the same option is not', async () => {
  const d = db('p1');
  await assertSucceeds(set(g(d, 'attempts/p1/q0/o1'), at()));
  await assertSucceeds(set(g(d, 'attempts/p1/q0/o0'), at()));
  await assertFails(set(g(d, 'attempts/p1/q0/o1'), at()));
  await assertFails(remove(g(d, 'attempts/p1/q0/o1')));
});

test('players cannot fake the time of an answer', async () => {
  await assertFails(set(g(db('p1'), 'attempts/p1/q0/o0'), { at: Date.now() - 5000 }));
});

test('answers are refused after the 15 seconds, between questions, and for other questions', async () => {
  await seed({ startedAgo: 16000 });
  await assertFails(set(g(db('p1'), 'attempts/p1/q0/o0'), at()));
  await seed({ phase: 'results' });
  await assertFails(set(g(db('p1'), 'attempts/p1/q0/o0'), at()));
  await seed();
  await assertFails(set(g(db('p1'), 'attempts/p1/q1/o0'), at()));
});

test('answers are refused for options that do not exist and from non-players', async () => {
  await assertFails(set(g(db('p1'), 'attempts/p1/q0/o9'), at()));
  await assertFails(set(g(db('stranger'), 'attempts/stranger/q0/o0'), at()));
});

test('players cannot see or write each other\'s answers', async () => {
  await assertSucceeds(set(g(db('p2'), 'attempts/p2/q0/o0'), at()));
  await assertFails(get(g(db('p1'), 'attempts/p2')));
  await assertFails(get(g(db('p1'), 'attempts')));
  await assertFails(set(g(db('p1'), 'attempts/p2/q0/o1'), at()));
});

test('players cannot change scores, state, or other players', async () => {
  const d = db('p1');
  await assertFails(set(g(d, 'scores/p1'), { s: 99999, ms: 0 }));
  await assertFails(update(g(d, 'state'), { phase: 'final' }));
  await assertFails(set(g(d, 'players/p2'), { name: 'Hacked' }));
  await assertFails(remove(ref(d, `games/${PIN}`)));
});

test('joining: own entry only, valid nickname, existing game, signed in', async () => {
  await assertSucceeds(set(g(db('p3'), 'players/p3'), { name: 'Three' }));
  await assertFails(set(g(db('p3'), 'players/p3'), { name: '' }));
  await assertFails(set(g(db('p3'), 'players/p3'), { name: 'x'.repeat(25) }));
  await assertFails(set(g(db('p3'), 'players/p3'), { name: 'Three', s: 100 }));
  await assertFails(set(ref(db('p3'), 'games/999999/players/p3'), { name: 'Three' }));
  await assertFails(set(g(db(null), 'players/x'), { name: 'Anon' }));
});

test('only approved hosts can use the bank, history and game creation', async () => {
  const p = db('p1');
  await assertFails(get(ref(p, 'bank')));
  await assertFails(get(ref(p, 'history')));
  await assertFails(set(ref(p, 'bank/gk/x'), { q: 'x' }));
  await assertFails(set(ref(p, 'games/654321'), { meta: { hostUid: 'p1' } }));
  const h = db('host');
  await assertSucceeds(get(ref(h, 'bank')));
  await assertSucceeds(get(ref(h, 'history')));
  await assertSucceeds(set(ref(h, 'bank/gk/x'), { q: 'x' }));
  await assertSucceeds(set(ref(h, 'games/654321'), { meta: { hostUid: 'host' } }));
});

test('nobody can make themselves a host from the app', async () => {
  await assertFails(set(ref(db('p1'), 'hosts/p1'), true));
  await assertFails(set(ref(db('host'), 'hosts/p1'), true));
});

test('the host runs their own game; another host cannot touch it', async () => {
  const h = db('host');
  await assertSucceeds(get(g(h, 'key')));
  await assertSucceeds(update(g(h, 'state'), { phase: 'results' }));
  await assertSucceeds(set(g(h, 'scores/p1'), { s: 100, ms: 1 }));
  await env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database(), 'hosts/host2'), true));
  const other = db('host2');
  await assertFails(get(g(other, 'key')));
  await assertFails(update(g(other, 'state'), { phase: 'final' }));
  await assertFails(remove(ref(other, `games/${PIN}`)));
  await assertSucceeds(remove(ref(h, `games/${PIN}`)));
});
