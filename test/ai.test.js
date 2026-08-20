const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractTenders, isTransient, backoffMs, RETRY } = require('../lib/ai');

const err = (message, status) => Object.assign(new Error(message), status ? { status } : {});

// Stands in for GoogleGenerativeAI. Each entry is either an Error to throw or
// a string to return as the model's response text.
function fakeClient(responses) {
  const calls = { n: 0, prompts: [] };
  return {
    calls,
    getGenerativeModel: () => ({
      generateContent: async (prompt) => {
        calls.prompts.push(prompt);
        const r = responses[calls.n++];
        if (r instanceof Error) throw r;
        return {
          response: {
            text: () => r,
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
          }
        };
      }
    })
  };
}

// Captures backoff delays instead of waiting them out — keeps the suite fast.
function fakeSleep() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

const TENDER = '[{"title":"מכרז לדוגמה","tender_number":"47/2026","deadline_date":"15/08/2026"}]';

test('retries a transient 429 and succeeds on the second attempt', async () => {
  const client = fakeClient([err('429 Too Many Requests', 429), TENDER]);
  const { delays, sleep } = fakeSleep();
  const res = await extractTenders('text', { client, sleep });
  assert.strictEqual(res.tenders.length, 1);
  assert.strictEqual(res.tenders[0].tender_number, '47/2026');
  assert.strictEqual(client.calls.n, 2);
  assert.strictEqual(res.attempts, 2);
  assert.strictEqual(res.error, null);
  assert.strictEqual(delays.length, 1);
  assert.deepStrictEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
});

test('exhausts retries and returns tenders:null with zeroed usage', async () => {
  const client = fakeClient([err('429', 429), err('429', 429), err('429', 429)]);
  const { delays, sleep } = fakeSleep();
  const res = await extractTenders('text', { client, sleep });
  assert.strictEqual(res.tenders, null, 'must be null, never [] — [] would wipe the cache');
  assert.deepStrictEqual(res.usage, { inputTokens: 0, outputTokens: 0 });
  assert.strictEqual(client.calls.n, 3);
  assert.strictEqual(res.attempts, 3);
  assert.match(res.error, /429/);
  assert.strictEqual(delays.length, 2, 'sleeps between attempts only, not after the last');
});

test('does NOT retry a non-transient failure', async () => {
  const client = fakeClient([err('API key not valid', 400), TENDER]);
  const { delays, sleep } = fakeSleep();
  const res = await extractTenders('text', { client, sleep });
  assert.strictEqual(res.tenders, null);
  assert.strictEqual(client.calls.n, 1, 'a bad key fails identically every time — do not burn retries');
  assert.strictEqual(res.attempts, 1);
  assert.deepStrictEqual(delays, []);
});

test('does NOT retry a malformed (unparseable) response', async () => {
  const client = fakeClient(['not json at all', TENDER]);
  const res = await extractTenders('text', { client, sleep: async () => {} });
  assert.strictEqual(res.tenders, null);
  assert.strictEqual(client.calls.n, 1);
});

test('does NOT retry a malformed response even when the truncated raw text contains a trigger word (Node embeds it in the SyntaxError message)', async () => {
  const client = fakeClient(['rate limit test text that breaks json', TENDER]);
  const { delays, sleep } = fakeSleep();
  const res = await extractTenders('text', { client, sleep });
  assert.strictEqual(res.tenders, null);
  assert.strictEqual(client.calls.n, 1, 'a SyntaxError must never be classified as transient, regardless of the words in the unparseable text');
  assert.deepStrictEqual(delays, []);
});

test('a transient failure followed by a non-transient failure stops after the second attempt with an honest attempts count', async () => {
  const client = fakeClient([err('429 Too Many Requests', 429), err('API key not valid', 400)]);
  const { delays, sleep } = fakeSleep();
  const res = await extractTenders('text', { client, sleep });
  assert.strictEqual(res.tenders, null);
  assert.strictEqual(res.attempts, 2);
  assert.strictEqual(client.calls.n, 2);
  assert.strictEqual(delays.length, 1);
});

test('backoff grows exponentially between attempts', async () => {
  const client = fakeClient([err('503 Service Unavailable', 503), err('503', 503), err('503', 503)]);
  const { delays, sleep } = fakeSleep();
  await extractTenders('text', { client, sleep, rand: () => 0.5 });
  assert.deepStrictEqual(delays, [500, 1000]); // 0.5 * 1000 * 2^0, 0.5 * 1000 * 2^1
});

test('a successful first attempt neither sleeps nor retries', async () => {
  const client = fakeClient([TENDER]);
  const { delays, sleep } = fakeSleep();
  const res = await extractTenders('text', { client, sleep });
  assert.strictEqual(res.attempts, 1);
  assert.strictEqual(client.calls.n, 1);
  assert.deepStrictEqual(delays, []);
});

test('the excerpt flag still reaches the prompt', async () => {
  const client = fakeClient([TENDER]);
  await extractTenders('text', { client, sleep: async () => {}, excerpt: true });
  assert.match(client.calls.prompts[0], /EXCERPTS/);
});

test('isTransient classifies rate limits, overloads and network faults — and nothing else', async () => {
  assert.ok(isTransient(err('429 Too Many Requests', 429)));
  assert.ok(isTransient(err('503 Service Unavailable', 503)));
  assert.ok(isTransient(err('[GoogleGenerativeAI Error]: got status: 429 rate limit exceeded')));
  assert.ok(isTransient(err('The model is overloaded. Please try again later.')));
  assert.ok(isTransient(err('socket hang up')));
  assert.ok(isTransient(err('request to https://... failed, reason: ECONNRESET')));
  assert.ok(isTransient(err('ETIMEDOUT')));

  assert.ok(!isTransient(err('API key not valid. Please pass a valid API key.', 400)));
  assert.ok(!isTransient(err('Unexpected token o in JSON at position 1')));
  assert.ok(!isTransient(err('permission denied', 403)));
  assert.ok(!isTransient(undefined));
});

test('backoffMs stays within the full-jitter window and honours RETRY.baseMs', async () => {
  assert.deepStrictEqual(RETRY, { attempts: 3, baseMs: 1000 });
  assert.strictEqual(backoffMs(0, 1000, () => 0), 0);
  assert.strictEqual(backoffMs(0, 1000, () => 0.999), 999);
  assert.strictEqual(backoffMs(2, 1000, () => 0.5), 2000);
  for (let i = 0; i < 50; i++) {
    const ms = backoffMs(1, 1000); // real Math.random
    assert.ok(ms >= 0 && ms < 2000, `jittered backoff out of window: ${ms}`);
  }
});

test.skip('lib/ai.js never touches the console (its logs belong to the caller buffer)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai.js'), 'utf8');
  assert.ok(!/console\./.test(src), 'ai.js must stay log-free under concurrent runs');
});
