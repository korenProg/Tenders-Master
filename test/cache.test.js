const { test } = require('node:test');
const assert = require('node:assert');
const { getSiteEntry, makeSiteEntry } = require('../lib/cache');

test('getSiteEntry rejects null, legacy md5 strings, and v2 entries', () => {
  assert.strictEqual(getSiteEntry(null), null);
  assert.strictEqual(getSiteEntry('deadbeefdeadbeefdeadbeefdeadbeef'), null);
  assert.strictEqual(getSiteEntry({ version: 2, stableKeys: ['k1'], tenders: [] }), null);
});

test('getSiteEntry rejects malformed v3 records', () => {
  assert.strictEqual(getSiteEntry({ version: 3, keyHashes: ['x'], tenders: [] }), null);  // keyHashes not a plain object
  assert.strictEqual(getSiteEntry({ version: 3, keyHashes: null, tenders: [] }), null);
  assert.strictEqual(getSiteEntry({ version: 3, keyHashes: {}, tenders: 'nope' }), null);  // tenders not an array
});

test('getSiteEntry returns a valid v3 record as-is', () => {
  const entry = makeSiteEntry({ k1: 'h1' }, [], false);
  assert.strictEqual(getSiteEntry(entry), entry);
});

test('makeSiteEntry stamps version 3, keyHashes, flag and timestamp', () => {
  const entry = makeSiteEntry({ k1: 'h1' }, [{ title: 'מכרז' }], true);
  assert.strictEqual(entry.version, 3);
  assert.strictEqual(entry.pendingDelivery, true);
  assert.deepStrictEqual(entry.keyHashes, { k1: 'h1' });
  assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)));
});
