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

const { buildKeyHashes } = require('../lib/text');

test('buildKeyHashes excludes noise lines and is deterministic', () => {
  const entries = [
    { line: 'מכרז פומבי לאספקת שירותי ניקיון מועד 15/08/2026', key: 'k1' },
    { line: 'רעש', key: null }
  ];
  const a = buildKeyHashes(entries);
  assert.deepStrictEqual(Object.keys(a), ['k1']);
  assert.deepStrictEqual(a, buildKeyHashes(entries));
});

test('buildKeyHashes changes the hash when only digits change under a key', () => {
  const before = buildKeyHashes([{ line: 'מכרז לניקיון מועד אחרון 15/08/2026', key: 'k1' }]);
  const after  = buildKeyHashes([{ line: 'מכרז לניקיון מועד אחרון 30/08/2026', key: 'k1' }]);
  assert.notStrictEqual(before.k1, after.k1);
});

test('buildKeyHashes merges collision lines order-independently and reflects a change in any', () => {
  const a = [{ line: 'מכרז לריהוט 12/2026', key: 'k1' }, { line: 'מכרז לריהוט 13/2026', key: 'k1' }];
  const b = [{ line: 'מכרז לריהוט 13/2026', key: 'k1' }, { line: 'מכרז לריהוט 12/2026', key: 'k1' }];
  const changed = [{ line: 'מכרז לריהוט 12/2026', key: 'k1' }, { line: 'מכרז לריהוט 99/2026', key: 'k1' }];
  assert.strictEqual(Object.keys(buildKeyHashes(a)).length, 1);
  assert.strictEqual(buildKeyHashes(a).k1, buildKeyHashes(b).k1);
  assert.notStrictEqual(buildKeyHashes(a).k1, buildKeyHashes(changed).k1);
});
