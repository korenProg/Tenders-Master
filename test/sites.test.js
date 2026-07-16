const { test } = require('node:test');
const assert = require('node:assert');
const { MUNICIPALITIES } = require('../lib/sites');

test('MUNICIPALITIES exposes every site with the fields main.js needs', () => {
  assert.ok(Array.isArray(MUNICIPALITIES));
  assert.strictEqual(MUNICIPALITIES.length, 14);
  for (const m of MUNICIPALITIES) {
    assert.ok(m.publisher && m.publisher.length > 0, 'publisher missing');
    assert.ok(m.url && m.url.startsWith('http'), `bad url for ${m.publisher}`);
    // A site is either custom (script file) or generic (paginator). script wins.
    if (m.script !== undefined) {
      assert.ok(m.script.startsWith('./scrapers/'), `bad script for ${m.publisher}`);
    }
    if (m.pagination !== undefined) {
      assert.ok(typeof m.pagination === 'object' && m.pagination !== null && !Array.isArray(m.pagination),
        `pagination must be a plain object for ${m.publisher}`);
    }
  }
});

test('dormant pagination configs carry only known keys', () => {
  const KNOWN = new Set(['iframes', 'networkIdle', 'maxPages', 'settleMs', 'waitMs', 'nextTokens']);
  for (const m of MUNICIPALITIES) {
    for (const k of Object.keys(m.pagination || {})) {
      assert.ok(KNOWN.has(k), `unknown pagination key "${k}" on ${m.publisher}`);
    }
  }
});

test('MUNICIPALITIES urls are unique (they are the cache keys)', () => {
  const urls = MUNICIPALITIES.map(m => m.url);
  assert.strictEqual(new Set(urls).size, urls.length);
});
