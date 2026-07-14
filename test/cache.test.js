const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCache, saveCache, getSiteEntry, makeSiteEntry } = require('../lib/cache');

test('getSiteEntry returns null for missing and legacy md5-string entries', () => {
  const cache = { 'https://a': 'deadbeefdeadbeefdeadbeefdeadbeef' };
  assert.strictEqual(getSiteEntry(cache, 'https://a'), null);
  assert.strictEqual(getSiteEntry(cache, 'https://missing'), null);
});

test('getSiteEntry returns null for malformed objects', () => {
  const cache = { 'https://a': { version: 2, stableKeys: 'not-an-array', tenders: [] } };
  assert.strictEqual(getSiteEntry(cache, 'https://a'), null);
});

test('getSiteEntry returns valid v2 entries as-is', () => {
  const entry = makeSiteEntry(['k1'], [], false);
  const cache = { 'https://a': entry };
  assert.strictEqual(getSiteEntry(cache, 'https://a'), entry);
});

test('makeSiteEntry stamps version, flag and timestamp', () => {
  const entry = makeSiteEntry(['k1'], [{ title: 'מכרז' }], true);
  assert.strictEqual(entry.version, 2);
  assert.strictEqual(entry.pendingDelivery, true);
  assert.deepStrictEqual(entry.stableKeys, ['k1']);
  assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)));
});

test('cache round-trips through disk and returns {} for missing file', () => {
  const file = path.join(os.tmpdir(), `cache-test-${Date.now()}.json`);
  assert.deepStrictEqual(loadCache(file), {});
  const cache = { 'https://a': makeSiteEntry(['k1'], [{ title: 'מכרז' }], true) };
  saveCache(cache, file);
  assert.deepStrictEqual(loadCache(file), cache);
  fs.unlinkSync(file);
});
