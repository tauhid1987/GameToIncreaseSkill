// Plays real games in real browsers against the local emulators. Run with: npm run test:e2e
// Env REAL_TIMING=1 uses the real 15s + 3s for the whole game (about 3 minutes per game).
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5055';
const PACK = new URL('../questions/', import.meta.url);
const NS = 'demo-quiz-arena-default-rtdb';
const SHOTS = new URL('../test-results/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
const sample = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const real = process.env.REAL_TIMING === '1';
const timing = real ? '' : '?limit=4000&reveal=700';
const LIMIT = real ? 15000 : 4000;

const EMAIL = 'host@example.test';
const PASSWORD = `pw-${Date.now()}`;

async function makeHost() {
  const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const { localId } = await r.json();
  const put = await fetch(`http://127.0.0.1:9000/hosts/${localId}.json?ns=${NS}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: 'true',
  });
  assert.equal(put.status, 200);
}

async function importBank(page, cat, file) {
  await page.goto(`${BASE}/bank.html?cat=${cat}`);
  await page.locator('#imp').fill(sample(file));
  await page.locator('#import').click();
  await page.getByText('Imported 10.').waitFor();
  await page.getByText('Ready to host.').waitFor();
}

async function joinGame(browser, pin, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  // A slow or blocked font must never hold up a page, so the test runs without Google Fonts.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  const pending = new Map();
  page.on('request', (r) => pending.set(r, Date.now()));
  page.on('requestfinished', (r) => pending.delete(r));
  page.on('requestfailed', (r) => pending.delete(r));
  await page.goto(`${BASE}/index.html?pin=${pin}`).catch((e) => {
    console.log(`  [${name}] page load stalled. Still waiting on: ${[...pending.keys()].map((r) => r.url()).join(', ')}`);
    throw e;
  });
  await page.locator('#pin').waitFor({ timeout: 20000 }).catch(async () => {
    console.log(`  [${name}] join form missing. Page says: ${await page.locator('#app').innerText()}`);
  });
  assert.equal(await page.locator('#pin').inputValue(), pin, 'scanning the QR link fills in the PIN');
  await page.locator('#name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.getByText("You're in!").waitFor();
  return page;
}

const currentQuestion = (page) => page.locator('.pill').first().textContent();
const waitForQuestion = (page, n) => page.getByText(`Question ${n} / 10`).first().waitFor({ timeout: LIMIT + 8000 });
const errors = [];

async function createGame(host, catLabel, title) {
  await host.goto(`${BASE}/host.html${timing}`);
  await host.locator('.cat', { hasText: catLabel }).click();
  await host.locator('#title').fill(title);
  await host.locator('#next').click();
  const pinBox = host.locator('.pin');
  await pinBox.waitFor();
  return pinBox.textContent();
}

// Reads which options are right from the host's private copy, standing in for a player who knows.
async function answersFromDb(pin) {
  const r = await fetch(`http://127.0.0.1:9000/games/${pin}/key.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } });
  return r.json();
}

async function quickRound(browser, host) {
  const pin = await createGame(host, 'General Knowledge', 'E2E quick round');
  assert.equal(await host.locator('#start').isDisabled(), true, 'cannot start with no players');
  await host.locator('#qr canvas, #qr img').first().waitFor({ state: 'attached' });
  await shot(host, 'host-lobby');
  const p1 = await joinGame(browser, pin, 'Fast');
  const p2 = await joinGame(browser, pin, 'Rechooser');
  const p3 = await joinGame(browser, pin, 'Sleeper');

  // Duplicate nickname is refused.
  const dupCtx = await browser.newContext();
  const dup = await dupCtx.newPage();
  await dup.goto(`${BASE}/index.html?pin=${pin}`);
  await dup.locator('#name').fill('fast');
  await dup.getByRole('button', { name: 'Join' }).click();
  await dup.getByText('That nickname is taken').waitFor();
  await dupCtx.close();

  const key = await answersFromDb(pin);
  await host.getByRole('button', { name: /Start \(3 joined\)/ }).click();

  const started = Date.now();
  let lastRightText = '';
  let lastWrongText = '';
  for (let i = 0; i < 10; i++) {
    await Promise.all([p1, p2, p3, host].map((pg) => waitForQuestion(pg, i + 1)));
    const k = key[`q${i}`];
    const right = Object.keys(k).find((o) => k[o] === 1).slice(1);
    const wrong = Object.keys(k).find((o) => k[o] === 0).slice(1);
    await p1.locator(`[data-opt="${right}"]`).click();
    await p1.locator(`[data-opt="${right}"].selected`).waitFor();
    // The first choice is marked only as selected, never as right or wrong.
    await p2.locator(`[data-opt="${wrong}"]`).click();
    await p2.locator(`[data-opt="${wrong}"].selected`).waitFor();
    await p2.getByText('You can change it until time runs out').waitFor();
    assert.equal(await p2.locator('.opt.right, .opt.wrong').count(), 0, 'no right or wrong during the question');
    if (i === 0) await shot(p2, 'player-first-choice');
    // The third player answers only the last question, and gets it wrong.
    if (i === 9) {
      lastRightText = await p3.locator(`[data-opt="${right}"] .txt`).textContent();
      lastWrongText = await p3.locator(`[data-opt="${wrong}"] .txt`).textContent();
      await p3.locator(`[data-opt="${wrong}"]`).click();
      await p3.locator(`[data-opt="${wrong}"].selected`).waitFor();
    }
    // Choosing again unselects the first one, and every answer stays tappable.
    await p2.locator(`[data-opt="${right}"]`).click();
    await p2.locator(`[data-opt="${right}"].selected`).waitFor();
    assert.equal(await p2.locator('.opt.selected').count(), 1, 'only the latest choice stays selected');
    assert.equal(await p2.locator('[data-opt][disabled]').count(), 0);
    if (i === 0) await shot(p2, 'player-changed-choice');
    if (i === 0) await shot(host, 'host-question');
    await p1.getByText('Your answer is saved').waitFor({ timeout: LIMIT + 8000 });
    await p3.getByText(i === 9 ? 'Your answer is saved' : 'No answer').waitFor({ timeout: 5000 });
    for (const pg of [p1, p2, p3]) {
      for (const hidden of ['Top players', 'Your total', 'right', 'wrong']) {
        assert.equal(await pg.getByText(hidden).count(), 0, `nothing about "${hidden}" before the final screen`);
      }
    }
    if (i === 0) {
      assert.equal(await host.getByText('Top players').count(), 0, 'the host screen hides scores too');
      assert.equal(await host.locator('.answer').count(), 0, 'the host screen hides the answer too');
      const gap = Date.now() - started;
      console.log(`  question 1 moved to results after ${gap} ms (limit ${LIMIT})`);
      assert.ok(gap >= LIMIT - 200, 'the question stayed open for the full time even though players had answered');
      await shot(p1, 'player-results');
    }
  }
  await Promise.all([p1, p2, p3, host].map((pg) => pg.getByText('Final leaderboard').waitFor({ timeout: 15000 })));
  const elapsed = Date.now() - started;
  console.log(`  full game took ${(elapsed / 1000).toFixed(1)} s with nobody pressing anything on the host`);
  await shot(p1, 'player-final');
  await shot(host, 'host-final');

  // The final screen gives the right answer only where the player missed it.
  assert.equal(await p1.locator('.review .answer').count(), 0, 'all right: no extra answer lines');
  assert.equal(await p3.locator('.review .answer').count(), 10, 'wrong or unanswered: the right answer shows');
  const lastReview = p3.locator('.review').last();
  assert.ok((await lastReview.locator('.nope').textContent()).includes(lastWrongText), 'their wrong answer stays visible');
  assert.equal(await lastReview.locator('.answer').textContent(), `Right answer: ${lastRightText}`);
  await p3.locator('.review').first().locator('.answer').scrollIntoViewIfNeeded();
  await shot(p3, 'player-final-right-answers');

  const names = await host.locator('.board li span').allTextContents();
  assert.deepEqual(names, ['1. Fast', '2. Rechooser', '3. Sleeper']);
  const pts = (await host.locator('.board li b').allTextContents()).map(Number);
  assert.ok(pts[0] > pts[1], 'the player who chose sooner beats the one who changed later');
  assert.ok(pts[1] >= 5000, 'a changed answer that ends up right earns the points');
  assert.equal(pts[2], 0, 'no answers earns nothing');

  // A player can leave the finished game and is not stuck in it.
  await p1.getByRole('button', { name: 'Join another game' }).click();
  await p1.locator('#pin').waitFor();
  assert.equal(await p1.locator('#pin').inputValue(), '');
  await p1.reload();
  await p1.locator('#pin').waitFor();

  // Each of the 10 questions was used and counted in the bank.
  await Promise.all([p1, p2, p3].map((pg) => pg.context().close()));
  await host.getByRole('button', { name: 'Close game' }).click();
  await host.getByText('Create a game').waitFor();
  return { pts };
}

async function surveyRound(browser, host) {
  const pin = await createGame(host, 'জনমত', 'E2E survey');
  const p1 = await joinGame(browser, pin, 'Finder');
  const p2 = await joinGame(browser, pin, 'Unlucky');
  const key = await answersFromDb(pin);
  await host.getByRole('button', { name: /Start \(2 joined\)/ }).click();
  let expected = 0;
  let expected2 = 0;
  for (let i = 0; i < 10; i++) {
    await Promise.all([p1, p2].map((pg) => waitForQuestion(pg, i + 1)));
    const shownAt = Date.now();
    await p1.getByText('Choose 3 answers').waitFor();
    const k = key[`q${i}`];
    const total = Object.keys(k).length;
    assert.ok(total >= 6 && total <= 8, `6-8 answers, got ${total}`);
    const rights = Object.keys(k).filter((o) => k[o] > 0).map((o) => o.slice(1)).sort((a, b) => k[`o${b}`] - k[`o${a}`]);
    const wrongs = Object.keys(k).filter((o) => k[o] === 0).map((o) => o.slice(1));
    assert.ok(wrongs.length >= 2, 'at least 2 wrong answers');
    assert.equal(rights.reduce((s, o) => s + k[`o${o}`], 0), 100);
    const topThree = rights.slice(0, 3);
    const best = topThree.reduce((s, o) => s + k[`o${o}`], 0);
    for (const o of topThree) {
      await p1.locator(`[data-opt="${o}"]`).click();
      await p1.locator(`[data-opt="${o}"].selected`).waitFor();
    }
    await p1.getByText('3 of 3 chosen').waitFor();
    assert.equal(await p1.locator('.opt.right, .opt.wrong, .people').count(), 0, 'no right, wrong or counts during the question');
    if (i === 0) await shot(p1, 'survey-three-chosen');
    // A fourth choice is refused, and a choice can be unselected and replaced.
    for (const o of [wrongs[0], wrongs[1], rights[3]]) {
      await p2.locator(`[data-opt="${o}"]`).click();
      await p2.locator(`[data-opt="${o}"].selected`).waitFor();
    }
    await p2.locator(`[data-opt="${rights[0]}"]`).click();
    await p2.getByText('You already chose 3').waitFor();
    assert.equal(await p2.locator('.opt.selected').count(), 3);
    await p2.locator(`[data-opt="${wrongs[1]}"]`).click();
    await p2.getByText('2 of 3 chosen').waitFor();
    await p2.locator(`[data-opt="${rights[2]}"]`).click();
    await p2.locator(`[data-opt="${rights[2]}"].selected`).waitFor();
    expected += best;
    expected2 += k[`o${rights[3]}`] + k[`o${rights[2]}`];
    await p1.getByText('Top players').waitFor({ timeout: LIMIT + 8000 });
    if (i === 0) console.log(`  survey results came after ${Date.now() - shownAt} ms (limit ${LIMIT})`);
    const ranksShown = await p1.locator('.survey .rk').allTextContents();
    assert.equal(ranksShown.length, total);
    assert.deepEqual(ranksShown.slice(0, 3), ['1', '2', '3'], 'results list answers in rank order');
    assert.deepEqual(ranksShown.slice(-2), ['–', '–'], 'wrong answers come last, with no rank');
    if (i === 0) await shot(p1, 'survey-results');
  }
  await host.getByText('Final leaderboard').waitFor({ timeout: 15000 });
  await Promise.all([p1, p2].map((pg) => pg.getByText('Your answers').waitFor({ timeout: 15000 })));
  assert.equal(await p1.locator('.review .answer').count(), 0, 'found the top 3: no extra answer lines');
  assert.equal(await p2.locator('.review .answer').count(), 10, 'missed the top 3: they are shown');
  assert.match(await p2.locator('.review .answer').first().textContent(), /^Top 3: .+ \(\d+\), .+ \(\d+\), .+ \(\d+\)$/);
  await shot(p2, 'survey-final-top-answers');
  const pts = (await host.locator('.board li b').allTextContents()).map(Number);
  assert.ok(pts[0] >= expected && pts[0] <= expected * 1.2, `marks plus timing: ${pts[0]}`);
  assert.ok(pts[1] >= expected2 && pts[1] <= expected2 * 1.2, `marks plus timing: ${pts[1]}`);
  assert.ok(pts[0] > pts[1]);
  assert.equal((await host.locator('.board li span').first().textContent()), '1. Finder');
  await Promise.all([p1, p2].map((pg) => pg.context().close()));
  await host.getByRole('button', { name: 'Close game' }).click();
  await host.getByText('Create a game').waitFor();
}

async function checkHostResume(browser, host) {
  // Reloading the host page in the middle of a game must carry on where it was.
  const pin = await createGame(host, 'General Knowledge', 'E2E resume');
  const p1 = await joinGame(browser, pin, 'Stayer');
  await host.getByRole('button', { name: /Start \(1 joined\)/ }).click();
  await waitForQuestion(p1, 1);
  await host.reload();
  await waitForQuestion(p1, 2);
  await p1.context().close();
  host.once('dialog', (d) => d.accept());
  await host.getByRole('button', { name: 'End game' }).click();
  await host.getByText('Create a game').waitFor();
}

async function main() {
  await makeHost();
  const browser = await chromium.launch();
  const hostCtx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const host = await hostCtx.newPage();
  await host.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  host.on('pageerror', (e) => errors.push(`host: ${e.message}`));

  console.log('Bank pages need a host sign-in');
  await host.goto(`${BASE}/bank.html`);
  await host.locator('#email').fill(EMAIL);
  await host.locator('#password').fill('wrong-password');
  await host.getByRole('button', { name: 'Sign in' }).click();
  await host.getByText('Sign in failed').waitFor();
  await host.locator('#email').fill(EMAIL);
  await host.locator('#password').fill(PASSWORD);
  await host.getByRole('button', { name: 'Sign in' }).click();

  await host.getByRole('heading', { name: /Add a question to/ }).waitFor();
  // Listen only from here, because the wrong password above is meant to log a 400.
  host.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_NAME|ERR_FAILED/.test(m.text())) errors.push(`host console: ${m.text()}`); });
  console.log('Adding questions');
  await host.getByText('Question bank', { exact: true }).first().waitFor();
  await host.getByRole('heading', { name: /Add a question to/ }).waitFor();
  // Add one by hand, then edit it.
  await host.locator('#f-q').fill('Test question by hand?');
  await host.locator('.f-opt').nth(0).fill('Right one');
  await host.locator('.f-opt').nth(1).fill('Wrong one');
  await host.getByRole('button', { name: 'Add question' }).click();
  await host.getByText('Mark one answer as correct').waitFor();
  await host.locator('input[name="f-c"]').first().check();
  await host.getByRole('button', { name: 'Add question' }).click();
  await host.getByText('Question added.').waitFor();
  await host.locator('[data-edit]').first().click();
  await host.locator('#f-q').fill('Edited question by hand?');
  await host.getByRole('button', { name: 'Save changes' }).click();
  await host.getByText('Question saved.').waitFor();
  await host.getByText('Edited question by hand?').waitFor();
  host.once('dialog', (d) => d.accept());
  await host.locator('[data-del]').first().click();
  await host.getByText('Question deleted.').waitFor();

  await importBank(host, 'gk', 'general-knowledge.txt');
  await shot(host, 'bank');
  await host.locator('#imp').fill(sample('general-knowledge.txt'));
  await host.locator('#import').click();
  await host.getByText('Imported 0. Skipped 10 duplicates').waitFor();
  await importBank(host, 'jonomot', 'survey-jonomot.txt');

  console.log('Question pack files go to their categories and sets');
  const part = (name, n) => `## ${name}\n\n${Array.from({ length: n }, (_, i) => `${name} question ${i + 1}?\n*Right\nWrong`).join('\n\n')}`;
  await host.locator('#pack').setInputFiles([
    { name: 'cricket.txt', mimeType: 'text/plain', buffer: Buffer.from(`${part('Part 1', 10)}\n\n${part('Part 2', 10)}\n\n${part('Part 3', 4)}`) },
    { name: 'nothing.txt', mimeType: 'text/plain', buffer: Buffer.from('Q?\n*a\nb') },
  ]);
  await host.getByText('Pack imported: 24 added').waitFor();
  await host.getByText('nothing.txt').waitFor();

  console.log('Repeated questions in the bank are found and removed');
  const jonomot = await (await fetch(`http://127.0.0.1:9000/bank/jonomot.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } })).json();
  const [, original] = Object.entries(jonomot)[0];
  await fetch(`http://127.0.0.1:9000/bank/jonomot/copyOne.json?ns=${NS}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify({ ...original, createdAt: Date.now() + 99999 }),
  });
  await host.goto(`${BASE}/bank.html?cat=jonomot`);
  await host.getByText('1 extra copy of 1 question').waitFor();
  host.once('dialog', (d) => d.accept());
  await host.getByRole('button', { name: 'Remove the extra copies' }).click();
  await host.getByText('Removed 1 extra copy.').waitFor();
  await host.getByText('None in any category.').waitFor();
  // A double import, even at the same moment, adds nothing.
  await host.locator('#pack').setInputFiles([{ name: 'gk.txt', mimeType: 'text/plain', buffer: Buffer.from(sample('general-knowledge.txt')) }]);
  await host.getByText('Pack imported: 0 added, 10 already there').waitFor();

  console.log('Picker only offers categories with 10 questions');
  await host.goto(`${BASE}/host.html${timing}`);
  await host.locator('.cat', { hasText: 'General Knowledge' }).waitFor();
  assert.equal(await host.locator('.cat').count(), 12);
  await host.locator('.cat', { hasText: 'General Knowledge' }).getByText('1 set ready').waitFor();
  await host.locator('.cat', { hasText: 'Football' }).getByText('0 sets ready').waitFor();
  await host.locator('.cat', { hasText: 'Cricket' }).getByText('2 sets ready').waitFor();
  // The host chooses a branch of questions inside a category.
  await host.locator('.cat', { hasText: 'Cricket' }).click();
  assert.equal(await host.locator('[data-set="Part 3"]').isDisabled(), true, 'a set under 10 questions cannot be hosted');
  await host.locator('[data-set="Part 2"]').click();
  await host.locator('.pin').waitFor();
  const chosen = await answersFromDb(await host.locator('.pin').textContent());
  assert.equal(Object.keys(chosen).length, 10);
  await host.getByRole('button', { name: 'End game' }).click();
  await host.getByText('Create a game').waitFor();
  await shot(host, 'host-picker');

  console.log('Quick round: re-choose, auto-next, final');
  await quickRound(browser, host);
  console.log('Survey round: 3 picks, people as points, highest total wins');
  await surveyRound(browser, host);
  console.log('Host reload resumes the game');
  await checkHostResume(browser, host);

  console.log('Event history');
  await host.goto(`${BASE}/history.html`);
  await host.getByRole('cell', { name: 'E2E quick round' }).waitFor();
  await host.getByRole('cell', { name: 'E2E survey' }).waitFor();
  // A game ended part-way is kept too, and history opens straight from its link after a reload.
  await host.getByRole('cell', { name: /E2E resume/ }).getByText('Stopped early').waitFor();
  await host.reload();
  await host.getByRole('cell', { name: 'E2E quick round' }).waitFor();
  await shot(host, 'history-list');
  await host.getByRole('cell', { name: 'E2E quick round' }).click();
  await host.getByRole('heading', { name: 'E2E quick round' }).waitFor();
  assert.equal(await host.locator('.board li').count(), 3);
  await shot(host, 'history-event');
  const [download] = await Promise.all([host.waitForEvent('download'), host.getByRole('button', { name: 'Download CSV' }).click()]);
  assert.match(download.suggestedFilename(), /^quiz-\d{6}\.csv$/);

  if (existsSync(PACK)) {
    console.log('The real question pack imports cleanly');
    const files = readdirSync(PACK).filter((f) => f.endsWith('.txt')).map((f) => new URL(f, PACK).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    // Start from an empty bank, because the samples used above overlap with the pack.
    await fetch(`http://127.0.0.1:9000/bank.json?ns=${NS}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
    await host.goto(`${BASE}/bank.html`);
    await host.locator('#pack').setInputFiles(files.map(decodeURI));
    await host.getByText(/Pack imported: \d+ added/).waitFor({ timeout: 60000 });
    const note = await host.locator('.notice').first().textContent();
    console.log(`  ${note}`);
    assert.match(note, / 0 with problems/);
    assert.match(note, /: \d+ added, 0 already there/);
    await host.goto(`${BASE}/host.html`);
    await host.locator('.cat', { hasText: 'জনমত' }).getByText('30 sets ready').waitFor();
    await shot(host, 'host-picker-full');
    await host.locator('.cat', { hasText: 'জনমত' }).click();
    assert.equal(await host.locator('[data-set]:not([disabled])').count(), 30);
    await shot(host, 'host-sets');
  }

  await browser.close();
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ALL E2E CHECKS PASSED');
}

main().catch((e) => {
  console.error(e);
  console.error('Page errors seen:', errors);
  process.exit(1);
});
