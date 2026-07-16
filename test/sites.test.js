const { test } = require('node:test');
const assert = require('node:assert');
const { MUNICIPALITIES } = require('../lib/sites');

test('MUNICIPALITIES exposes every site with the fields main.js needs', () => {
  assert.ok(Array.isArray(MUNICIPALITIES));
  assert.strictEqual(MUNICIPALITIES.length, 14);
  for (const m of MUNICIPALITIES) {
    assert.ok(m.publisher && m.publisher.length > 0, 'publisher missing');
    assert.ok(m.url && m.url.startsWith('http'), `bad url for ${m.publisher}`);
    assert.ok(m.script && m.script.startsWith('./scrapers/'), `bad script for ${m.publisher}`);
  }
});

test('MUNICIPALITIES urls are unique (they are the cache keys)', () => {
  const urls = MUNICIPALITIES.map(m => m.url);
  assert.strictEqual(new Set(urls).size, urls.length);
});
