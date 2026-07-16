const { test } = require('node:test');
const assert = require('node:assert');
const { validateTender, validateTenders, parseDeadline, ISSUES } = require('../lib/validate');
const { normalizeForTitleMatch } = require('../lib/merge');

const PAGE = 'מכרז פומבי לאספקת שירותי ניקיון 47/2026 מועד אחרון 15/08/2026';
const NORM = normalizeForTitleMatch(PAGE);
const NOW = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15, fixed for determinism

function tender(over) {
  return { title: 'מכרז פומבי לאספקת שירותי ניקיון', tender_number: '47/2026', deadline_date: '15/08/2026', ...over };
}

test('a fully valid tender passes untouched with no issues', () => {
  const { tender: out, issues } = validateTender(tender(), PAGE, NORM, NOW);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(out.tender_number, '47/2026');
  assert.strictEqual(out.deadline_date, '15/08/2026');
});

test('empty title drops the tender', () => {
  const { tender: out, issues } = validateTender(tender({ title: '   ' }), PAGE, NORM, NOW);
  assert.strictEqual(out, null);
  assert.deepStrictEqual(issues, [ISSUES.EMPTY_TITLE]);
});

test('title absent from the page drops the tender as hallucinated', () => {
  const t = tender({ title: 'אספקת מחשבים ניידים לבתי הספר היסודיים' });
  const { tender: out, issues } = validateTender(t, PAGE, NORM, NOW);
  assert.strictEqual(out, null);
  assert.deepStrictEqual(issues, [ISSUES.TITLE_NOT_ON_PAGE]);
});

test('a number not on the page degrades to "אין" but keeps the tender', () => {
  const { tender: out, issues } = validateTender(tender({ tender_number: '99/2026' }), PAGE, NORM, NOW);
  assert.strictEqual(out.tender_number, 'אין');
  assert.deepStrictEqual(issues, [ISSUES.NUMBER_NOT_ON_PAGE]);
  assert.strictEqual(out.title, tender().title);
});

test('a malformed number degrades to "אין"', () => {
  const { tender: out, issues } = validateTender(tender({ tender_number: 'abc-xyz' }), PAGE, NORM, NOW);
  assert.strictEqual(out.tender_number, 'אין');
  assert.deepStrictEqual(issues, [ISSUES.BAD_NUMBER_FORMAT]);
});

test('the -2 dedup suffix is accepted, not treated as malformed', () => {
  const { issues } = validateTender(tender({ tender_number: '47/2026-2' }), PAGE, NORM, NOW);
  assert.deepStrictEqual(issues, []);
});

test('an unparseable or rolled-over date degrades to "אין"', () => {
  assert.strictEqual(parseDeadline('31/02/2026'), null); // no Feb 31 rollover
  assert.strictEqual(parseDeadline('15-08-2026'), null);
  assert.strictEqual(parseDeadline('אין'), null);
  const { tender: out, issues } = validateTender(tender({ deadline_date: '31/02/2026' }), PAGE, NORM, NOW);
  assert.strictEqual(out.deadline_date, 'אין');
  assert.deepStrictEqual(issues, [ISSUES.INVALID_DATE]);
});

test('an implausible date degrades to "אין"', () => {
  const far = validateTender(tender({ deadline_date: '15/08/2035' }), PAGE, NORM, NOW);
  assert.strictEqual(far.tender.deadline_date, 'אין');
  assert.deepStrictEqual(far.issues, [ISSUES.IMPLAUSIBLE_DATE]);
  const old = validateTender(tender({ deadline_date: '15/08/2020' }), PAGE, NORM, NOW);
  assert.deepStrictEqual(old.issues, [ISSUES.IMPLAUSIBLE_DATE]);
});

test('"אין" inputs pass through without raising issues', () => {
  const t = tender({ tender_number: 'אין', deadline_date: 'אין' });
  const { tender: out, issues } = validateTender(t, PAGE, NORM, NOW);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(out.tender_number, 'אין');
});

test('validateTenders splits kept/dropped and builds a histogram', () => {
  const list = [
    tender(),
    tender({ title: 'אספקת מחשבים ניידים לבתי הספר היסודיים' }), // dropped
    tender({ tender_number: '99/2026' })                          // degraded
  ];
  const { kept, dropped, histogram } = validateTenders(list, PAGE, NOW);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(histogram[ISSUES.TITLE_NOT_ON_PAGE], 1);
  assert.strictEqual(histogram[ISSUES.NUMBER_NOT_ON_PAGE], 1);
});
