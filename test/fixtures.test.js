const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { normalizeForTitleMatch, titleOnPage } = require('../lib/merge');

const DIR = path.join(__dirname, 'fixtures', 'ground-truth');

test('every ground-truth fixture is a valid pair and its tenders are on the page', () => {
  if (!fs.existsSync(DIR)) return; // fixtures not captured yet
  const texts = fs.readdirSync(DIR).filter(f => f.endsWith('.txt'));
  assert.ok(texts.length > 0, 'no fixtures captured');

  for (const t of texts) {
    const key = path.basename(t, '.txt');
    const expectedFile = path.join(DIR, `${key}.expected.json`);
    if (!fs.existsSync(expectedFile)) continue; // not hand-labeled yet — skip, don't fail

    const pageText = fs.readFileSync(path.join(DIR, t), 'utf8');
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    assert.ok(Array.isArray(expected), `${key}.expected.json must be an array`);

    const norm = normalizeForTitleMatch(pageText);
    for (const tender of expected) {
      assert.ok(tender.title && tender.title.length > 0, `${key}: tender with empty title`);
      assert.ok('tender_number' in tender, `${key}: "${tender.title}" missing tender_number`);
      assert.ok('deadline_date' in tender, `${key}: "${tender.title}" missing deadline_date`);
      assert.ok(titleOnPage(tender.title, norm), `${key}: labeled title not found in .txt — "${tender.title}"`);
    }
  }
});
