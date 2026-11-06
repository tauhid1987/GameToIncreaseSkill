# Quiz Arena

A live quiz for office events. The host starts a game from a question bank, players scan a QR code on their phones, and the game runs itself. Every finished event is saved to history.

It is a static site (GitHub Pages) with Firebase Realtime Database. There is no server to run.

## How a game works

| | Quick round (all normal categories) | জনমত ১০০ (100 people survey) |
|---|---|---|
| Questions per game | 10 | 10 |
| Time per question | 15 seconds, then it moves on by itself | 20 seconds, the same way |
| Answers | 2 to 4 | 6 to 8: ranked answers with the top 3 clearly highest, plus at least 2 close-sounding wrong |
| Choosing | One answer. Tap another to change it until time runs out; the last one counts. Nothing shows if it is right | Up to 3 answers. Tap a chosen one to unselect it. Nothing shows if it is right until the question ends |
| After the question | Moves on with no answer shown. Right answers appear on the final screen | All answers show their rank and how many of the 100 people gave them, such as "1 · 50 / 100" |
| Points | 500 + up to 500 for speed, timed from the last answer chosen | Marks plus timing: the people behind each right answer, plus up to 20% for picking it quickly. With 3 picks, finding the top 3 scores best |
| Scores during play | Hidden until the final leaderboard | Shown after every question |
| Winner | Highest total. On a tie, the player who took less time | Same |

The 100-people category is dummy training content for practising guessing. Its people counts are invented.

To change any of these numbers, edit the top of [docs/js/core.js](docs/js/core.js). The same file holds the category list.

The host's page must stay open, because it is what moves the game along. If it reloads, the game carries on from where it was.

Every game is saved to **Event history**, including one you end early, which keeps the questions played so far. Only an approved host can open it, at `history.html`.

## Pages

- `index.html`: players join here (the QR code opens this with the PIN filled in).
- `host.html`: pick a category and run a game.
- `bank.html`: add, import, edit and delete questions.
- `history.html`: every finished event, with rankings, each player's answers and a CSV download.

## Adding questions

Questions live in **sets** inside each category. A set can be hosted once it has at least 10 questions. The host picks a category, then either starts the next least-played set or chooses one.

Open **Question bank**, pick a category and a set, or press **New set**.

You can add questions one at a time, or paste or upload a `.txt` file. A blank line separates questions, a line `## Set name` starts a set, and other lines starting with `#` are ignored. Duplicates are skipped, and any question with a problem is listed with the reason. The **Repeated questions** box on that page lists any copies in the bank and removes them. A game never uses the same question twice.

Quick round format, with `*` before the correct answer:

```
What is the capital of Bangladesh?
Chattogram
*Dhaka
Khulna
Sylhet
```

Survey format, as `answer | people`, with 6 to 8 lines. The ranked answers must add up to 100 and the top 3 must each beat the rest. At least 2 wrong answers are 0:

```
সকালের নাস্তায় মানুষ সবচেয়ে বেশি কী খায়?
পরোটা-ভাজি | 40
রুটি-ডিম | 25
খিচুড়ি | 15
চা-বিস্কুট | 12
পাউরুটি-কলা | 8
পরোটা-মাংস | 0
রুটি-কলা | 0
```

[samples/](samples/) has 10 of each for trying it out. **The sample survey numbers are made up.**

### The question pack

The ready-made questions are in the `questions/` folder, one file per category. **This folder is left out of Git on purpose**, because a public repo would show players every answer. Keep a copy of it safe.

To load it, open **Question bank** and choose all the files under **Import a full question pack**. Each file goes to the category in its name (`jonomot-a.txt` goes to `jonomot`), and questions already in the bank are skipped. Run `npm run check:questions` first if you have edited the files.

`present.txt` and `world-news.txt` were checked against news up to early November 2026 and will go out of date, so review them before each use.

## First-time setup

1. **Create a Firebase project** at <https://console.firebase.google.com>.
2. **Realtime Database:** create one, then paste [database.rules.json](database.rules.json) into its **Rules** tab and publish.
3. **Authentication:** turn on **Anonymous** (players) and **Email/Password** (hosts).
4. **Create the host login:** under Authentication > Users, add a user and copy its **User UID**.
5. **Approve the host:** in the Realtime Database **Data** tab, add a `hosts` node with a child named after that UID, with the value `true`. Hosts can only be added here, not from the site.
6. **Register a web app** (Project settings > Your apps) and paste its values into [docs/firebase-config.js](docs/firebase-config.js). These values are meant to be public. The rules protect the data.
7. **Push to GitHub**, then under Settings > Pages choose **Deploy from a branch**, branch `main`, folder `/docs`.
8. **Authorize the domain:** under Authentication > Settings > Authorized domains, add `<your-name>.github.io`.

Then open `host.html` on your Pages site and sign in.

## Working on it locally

You need Node.js and Java. On `localhost` the site uses local emulators, never the real project.

To play on this PC, run `npm install`, then `npm run play`. It loads the questions, creates a local host login and prints the links.

```
npm install
npx playwright install chromium
npm test             # game logic
npm run test:rules   # database security rules
npm run test:e2e     # plays full games in real browsers (takes a few minutes)
npm run dev          # local site at http://127.0.0.1:5055
npm run check:questions   # checks the files in questions/
npm run vendor       # refreshes docs/vendor after upgrading the firebase package
```

With `npm run dev`, open the emulator screen at http://127.0.0.1:4040, add a user under Authentication, and add its UID under `hosts` in the Realtime Database tab. The emulator starts empty every time.

## How cheating is kept out

- Players never receive the answer key or upcoming questions, and the time window is enforced by the database rules.
- Answer times come from the Firebase server clock, not the phone, so a wrong phone clock changes nothing.
- Answers can only be changed while the question is open, and players can't see each other's picks.
- Only the host's account can write scores.
