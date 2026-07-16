// Scores real extraction against hand-labeled ground truth.
// BILLABLE: one Gemini call per fixture (~5 total). Never run from npm test.
// Usage: npm run accuracy [-- --site=tel-aviv]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractTenders } = require('../lib/ai');
const { validateTenders } = require('../lib/validate');
const { normalizeForTitleMatch, baseNumber } = require('../lib/merge');

const DIR = path.join(__dirname, '..', 'test', 'fixtures', 'ground-truth');

// Same identity rule as the merge path, so the harness and production agree
// on what "the same tender" means.
function identity(t) {
  const base = baseNumber(t.tender_number);
  return base !== 'אין' ? `num:${base}` : `title:${normalizeForTitleMatch(t.title).slice(0, 30)}`;
}

function scoreSite(expected, actual) {
  const expMap = new Map(expected.map(t => [identity(t), t]));
  const actMap = new Map(actual.map(t => [identity(t), t]));

  let truePositives = 0;
  const fieldHits = { title: 0, tender_number: 0, deadline_date: 0 };
  const mismatches = [];

  for (const [key, exp] of expMap) {
    const got = actMap.get(key);
    if (!got) continue;
    truePositives++;
    for (const field of ['title', 'tender_number', 'deadline_date']) {
      if ((got[field] || '') === (exp[field] || '')) fieldHits[field]++;
      else mismatches.push({ key, field, expected: exp[field], got: got[field] });
    }
  }

  const missed = [...expMap.keys()].filter(k => !actMap.has(k));
  const spurious = [...actMap.keys()].filter(k => !expMap.has(k));

  return {
    expected: expected.length,
    actual: actual.length,
    truePositives,
    missed,
    spurious,
    precision: actual.length ? truePositives / actual.length : 0,
    recall: expected.length ? truePositives / expected.length : 0,
    fieldHits,
    mismatches
  };
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

async function main() {
  const only = (process.argv.find(a => a.startsWith('--site=')) || '').split('=')[1];
  if (!fs.existsSync(DIR)) {
    console.error(`No fixtures at ${DIR}. Run: node scripts/capture-fixture.js <site>`);
    process.exit(1);
  }
  let keys = fs.readdirSync(DIR).filter(f => f.endsWith('.txt')).map(f => path.basename(f, '.txt'));
  keys = keys.filter(k => fs.existsSync(path.join(DIR, `${k}.expected.json`)));
  if (only) keys = keys.filter(k => k === only);
  if (keys.length === 0) {
    console.error('No hand-labeled fixtures found. Create <site>.expected.json next to <site>.txt first.');
    process.exit(1);
  }

  console.log(`💸 BILLABLE: ${keys.length} Gemini call(s).\n`);

  const totals = { expected: 0, actual: 0, tp: 0, title: 0, number: 0, date: 0 };
  const histogram = {};

  for (const key of keys) {
    const pageText = fs.readFileSync(path.join(DIR, `${key}.txt`), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(DIR, `${key}.expected.json`), 'utf8'));

    const { tenders } = await extractTenders(pageText);
    if (tenders === null) { console.log(`❌ ${key}: extraction failed\n`); continue; }

    const { kept, histogram: h } = validateTenders(tenders, pageText);
    for (const [k, v] of Object.entries(h)) histogram[k] = (histogram[k] || 0) + v;

    const s = scoreSite(expected, kept);
    totals.expected += s.expected; totals.actual += s.actual; totals.tp += s.truePositives;
    totals.title += s.fieldHits.title; totals.number += s.fieldHits.tender_number; totals.date += s.fieldHits.deadline_date;

    console.log(`── ${key}`);
    console.log(`   expected ${s.expected} | extracted ${s.actual} | matched ${s.truePositives}`);
    console.log(`   precision ${pct(s.precision)} | recall ${pct(s.recall)}`);
    if (s.missed.length) console.log(`   MISSED:    ${s.missed.slice(0, 5).join(' | ')}`);
    if (s.spurious.length) console.log(`   SPURIOUS:  ${s.spurious.slice(0, 5).join(' | ')}`);
    for (const m of s.mismatches.slice(0, 5)) {
      console.log(`   FIELD ${m.field}: expected "${m.expected}" got "${m.got}"`);
    }
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('AGGREGATE');
  console.log('='.repeat(60));
  console.log(`precision            ${pct(totals.actual ? totals.tp / totals.actual : 0)}`);
  console.log(`recall               ${pct(totals.expected ? totals.tp / totals.expected : 0)}`);
  if (totals.tp > 0) {
    console.log(`title accuracy       ${pct(totals.title / totals.tp)}`);
    console.log(`tender_number acc.   ${pct(totals.number / totals.tp)}`);
    console.log(`deadline_date acc.   ${pct(totals.date / totals.tp)}`);
  }
  const hist = Object.entries(histogram).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`validation issues    ${hist || 'none'}`);
}

main();
