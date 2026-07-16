const { test } = require('node:test');
const assert = require('node:assert');
const { assessSite, SIGNALS, LEVELS } = require('../lib/health');

function tenders(n) {
  return Array.from({ length: n }, (_, i) => ({ title: `t${i}`, tender_number: `${i}/2026` }));
}

test('a stable site is ok with no signals', () => {
  const r = assessSite({ previousTenders: tenders(10), mergedTenders: tenders(10), cleanedTextLength: 5000 });
  assert.strictEqual(r.level, LEVELS.OK);
  assert.deepStrictEqual(r.signals, []);
});

test('a >50% count drop alerts', () => {
  const r = assessSite({ previousTenders: tenders(59), mergedTenders: tenders(7), cleanedTextLength: 11000 });
  assert.ok(r.signals.includes(SIGNALS.COUNT_COLLAPSE));
  assert.strictEqual(r.level, LEVELS.ALERT);
});

test('exactly 50% retained does not collapse', () => {
  const r = assessSite({ previousTenders: tenders(10), mergedTenders: tenders(5), cleanedTextLength: 5000 });
  assert.ok(!r.signals.includes(SIGNALS.COUNT_COLLAPSE));
});

test('zero tenders from a healthy page alerts', () => {
  const r = assessSite({ previousTenders: [], mergedTenders: [], cleanedTextLength: 5000 });
  assert.ok(r.signals.includes(SIGNALS.ZERO_FROM_HEALTHY_PAGE));
  assert.strictEqual(r.level, LEVELS.ALERT);
});

test('zero tenders from a thin page is not a signal', () => {
  const r = assessSite({ previousTenders: [], mergedTenders: [], cleanedTextLength: 200 });
  assert.deepStrictEqual(r.signals, []);
});

test('a bloated but correctly-extracted page is healthy (the Tel Aviv lesson)', () => {
  // Verified 2026-07-16: Tel Aviv's 46,634 chars yield 7 tenders, and 7 is
  // CORRECT — the page has 40 tender rows but only 7 with a future deadline;
  // the rest are closed. High chars-per-tender is bloat, not under-extraction,
  // so it must NOT raise any signal.
  const tlv = assessSite({ previousTenders: tenders(7), mergedTenders: tenders(7), cleanedTextLength: 46634 });
  assert.strictEqual(tlv.level, LEVELS.OK);
  assert.deepStrictEqual(tlv.signals, []);
});

test('every tender losing a field warns', () => {
  const r = assessSite({
    previousTenders: tenders(3), mergedTenders: tenders(3), cleanedTextLength: 5000,
    issueHistogram: { NUMBER_NOT_ON_PAGE: 2, INVALID_DATE: 1 }
  });
  assert.ok(r.signals.includes(SIGNALS.ALL_DEGRADED));
  assert.strictEqual(r.level, LEVELS.WARN);
});

test('a first run with no previous tenders does not collapse', () => {
  const r = assessSite({ previousTenders: [], mergedTenders: tenders(5), cleanedTextLength: 5000 });
  assert.ok(!r.signals.includes(SIGNALS.COUNT_COLLAPSE));
});
