const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadRaw, saveRaw } = require('../lib/storage');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-')); }

test('saveRaw then loadRaw round-trips and stamps the url', () => {
  const dir = tmp();
  const url = 'https://example.muni.il/bids?x=1';
  saveRaw(url, { version: 3, keyHashes: { k1: 'abc' }, tenders: [], pendingDelivery: false }, dir);
  const got = loadRaw(url, dir);
  assert.strictEqual(got.url, url);
  assert.strictEqual(got.version, 3);
  assert.deepStrictEqual(got.keyHashes, { k1: 'abc' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRaw returns null for a missing site', () => {
  const dir = tmp();
  assert.strictEqual(loadRaw('https://nope', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRaw returns null for a corrupt file', () => {
  const dir = tmp();
  const url = 'https://corrupt';
  saveRaw(url, { version: 3 }, dir);
  const file = path.join(dir, crypto.createHash('md5').update(url).digest('hex') + '.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.strictEqual(loadRaw(url, dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two urls write two distinct files', () => {
  const dir = tmp();
  saveRaw('https://a', { version: 3 }, dir);
  saveRaw('https://b', { version: 3 }, dir);
  assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
