const { test } = require('node:test');
const assert = require('node:assert');
const { superCleanText, stableKey, buildEntries } = require('../lib/text');

test('superCleanText drops junk lines and keeps tender lines', () => {
  const raw = 'הצהרת נגישות\nמכרז פומבי 12/2026 להפעלת מזנון בבית הספר\n{ var x = 1; }';
  const out = superCleanText(raw);
  assert.ok(out.includes('מכרז פומבי 12/2026'));
  assert.ok(!out.includes('נגישות'));
  assert.ok(!out.includes('var x'));
});

test('stableKey returns null for noise and empty lines', () => {
  assert.strictEqual(stableKey(''), null);
  assert.strictEqual(stableKey('עמוד 2 מתוך 5'), null); // only noise words
  assert.strictEqual(stableKey('מכרז חדש'), null); // fewer than 4 words
});

test('stableKey strips digits so date-only changes produce the same key', () => {
  const a = stableKey('מכרז פומבי 47/2026 לאספקת שירותי ניקיון עד 15/08/2026');
  const b = stableKey('מכרז פומבי 47/2026 לאספקת שירותי ניקיון עד 30/09/2026');
  assert.ok(a !== null);
  assert.strictEqual(a, b);
});

test('buildEntries keeps original lines verbatim and tags noise lines with null key', () => {
  const text = 'מכרז פומבי לאספקת שירותי ניקיון ברחבי העיר\nעמוד 2 מתוך 5';
  const entries = buildEntries(text);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].line, 'מכרז פומבי לאספקת שירותי ניקיון ברחבי העיר');
  assert.ok(entries[0].key !== null);
  assert.strictEqual(entries[1].line, 'עמוד 2 מתוך 5');
  assert.strictEqual(entries[1].key, null);
});
