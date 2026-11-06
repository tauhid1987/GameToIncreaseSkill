// Checks every file in questions/ before importing. Run with: npm run check:questions
import { readdirSync, readFileSync } from 'node:fs';
import { CATEGORIES, QUESTIONS_PER_GAME, parseImport, listSets, normalizeText } from '../docs/js/core.js';

const dir = new URL('../questions/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
let problems = 0;
const seen = new Map();
const totals = new Map();
for (const file of files) {
  const base = file.replace(/\.txt$/, '');
  const cat = CATEGORIES.find((c) => c.id === base || base.startsWith(`${c.id}-`));
  if (!cat) { console.log(`${file}: file name matches no category`); problems++; continue; }
  const { questions, errors } = parseImport(readFileSync(new URL(file, dir), 'utf8'), cat.type);
  errors.forEach((e) => { console.log(`${file} block ${e.block} "${e.question}": ${e.message}`); problems++; });
  questions.forEach((q) => {
    const k = `${cat.id}|${normalizeText(q.q)}`;
    if (seen.has(k)) { console.log(`${file}: duplicate of ${seen.get(k)}: ${q.q}`); problems++; }
    seen.set(k, file);
  });
  const sets = listSets(questions);
  sets.filter((s) => s.count !== QUESTIONS_PER_GAME).forEach((s) => {
    console.log(`${file}: ${s.name} has ${s.count} questions`); problems++;
  });
  if (cat.type === 'mcq') {
    const spots = [0, 0, 0, 0];
    questions.forEach((q) => { spots[q.c] += 1; });
    console.log(`${file}: ${questions.length} questions, ${sets.length} sets, correct by position ${spots.join('/')}`);
  } else console.log(`${file}: ${questions.length} questions, ${sets.length} sets`);
  totals.set(cat.id, (totals.get(cat.id) || 0) + questions.length);
}
console.log(`Categories with no file: ${CATEGORIES.filter((c) => !totals.has(c.id)).map((c) => c.id).join(', ') || 'none'}`);
console.log(`Total ${[...totals.values()].reduce((a, b) => a + b, 0)} questions, ${problems} problem(s).`);
process.exit(problems ? 1 : 0);
