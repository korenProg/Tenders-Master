const { test } = require('node:test');
const assert = require('node:assert');
const { diff, isDiffTooLarge, buildChunks } = require('../lib/diff');
const { buildKeyHashes } = require('../lib/text');

test('diff splits added, removed, changed and unchanged keys', () => {
  const entries = [
    { line: 'מכרז ראשון לאספקת ריהוט משרדי', key: 'k1' },
    { line: 'מכרז שני לשירותי גינון בפארק', key: 'k2' }
  ];
  const fresh = buildKeyHashes(entries);
  const cached = { k1: fresh.k1, k2: 'STALE', k3: 'GONE' };
  const { addedKeys, removedKeys, changedKeys, newKeyHashes } = diff(cached, entries);
  assert.deepStrictEqual(addedKeys, []);
  assert.deepStrictEqual(removedKeys, ['k3']);
  assert.deepStrictEqual(changedKeys, ['k2']);
  assert.deepStrictEqual(newKeyHashes, fresh);
});

test('diff reports a genuinely new key as added, ignoring null-key noise', () => {
  const entries = [
    { line: 'מכרז חדש לחלוטין לאספקת מחשבים ניידים', key: 'kNew' },
    { line: 'רעש', key: null }
  ];
  const { addedKeys, changedKeys, removedKeys } = diff({}, entries);
  assert.deepStrictEqual(addedKeys, ['kNew']);
  assert.deepStrictEqual(changedKeys, []);
  assert.deepStrictEqual(removedKeys, []);
});

test('a deadline-only change surfaces as a changedKey (the accuracy fix)', () => {
  const before = [{ line: 'מכרז לניקיון מועד אחרון 15/08/2026', key: 'kd' }];
  const after  = [{ line: 'מכרז לניקיון מועד אחרון 30/08/2026', key: 'kd' }];
  const { addedKeys, removedKeys, changedKeys } = diff(buildKeyHashes(before), after);
  assert.deepStrictEqual(addedKeys, []);
  assert.deepStrictEqual(removedKeys, []);
  assert.deepStrictEqual(changedKeys, ['kd']);
});

test('isDiffTooLarge counts changed keys and triggers above 50%', () => {
  assert.strictEqual(isDiffTooLarge(['a'], [], ['b'], 4, 4), false);       // 2/4 = 0.5
  assert.strictEqual(isDiffTooLarge(['a'], [], ['b', 'c'], 4, 4), true);   // 3/4 > 0.5
  assert.strictEqual(isDiffTooLarge([], [], [], 0, 0), true);              // nothing to compare
});

test('buildChunks merges overlapping windows into one chunk of original lines', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push({ line: `line${i}`, key: `k${i}` });
  const chunks = buildChunks(entries, ['k5', 'k7'], 3); // windows 2-8 and 4-10 overlap
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].startsWith('line2'));
  assert.ok(chunks[0].endsWith('line10'));
});

test('buildChunks returns separate chunks for distant additions', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push({ line: `line${i}`, key: `k${i}` });
  const chunks = buildChunks(entries, ['k2', 'k20'], 3);
  assert.strictEqual(chunks.length, 2);
});

test('buildChunks clamps windows at page boundaries and returns [] with no additions', () => {
  const entries = [{ line: 'a', key: 'k0' }, { line: 'b', key: 'k1' }];
  assert.deepStrictEqual(buildChunks(entries, ['k0'], 3), ['a\nb']);
  assert.deepStrictEqual(buildChunks(entries, [], 3), []);
});
