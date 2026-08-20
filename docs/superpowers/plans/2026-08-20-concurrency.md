# Concurrency — Bounded Worker Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential per-site `for` loop in `main.js` with a bounded worker pool so ~14 sites (and later ~1000) are scraped N-at-a-time, cutting wall-clock by roughly the concurrency factor without changing a single pipeline semantic.

**Architecture:** A new pure module `lib/pool.js` owns all scheduling (`runPool` for slot-based dispatch and per-item error capture, `withTimeout` for the per-site ceiling) and is unit-tested offline against mock workers — the same pure/impure seam as `paginate` / `makePuppeteerDriver` in Phase 3. `main.js` keeps only the impure worker: today's loop body extracted verbatim into `processSite(muni, index)`. `lib/ai.js` gains bounded retry on transient Gemini failures, because concurrent calls will hit rate limits that sequential ones never did. Per-site log buffers keep interleaved output readable.

**Tech Stack:** Node.js 24 (CommonJS, no build step), `node:test` + `node:assert` (no test deps), Puppeteer, `@google/generative-ai`. **No new dependencies.**

**Spec:** [docs/superpowers/specs/2026-08-06-concurrency-design.md](../specs/2026-08-06-concurrency-design.md)

Two decisions the spec left open were settled on 2026-08-20, before this plan was written:

- **Per-site timeout: slot-freeing only.** `withTimeout` frees the pool slot on schedule; in-flight Puppeteer work is *not* aborted and drains on its own, closing its browser in `processSite`'s `finally`. No `AbortSignal` plumbing through the paginator, driver, or the two custom scrapers. This ships the spec's "timeout does not truly abort" Known Limitation as-is, deliberately.
- **Gemini retry: bounded, 2 retries (3 attempts total).** Transient failures only (429, 503, network timeouts/resets), jittered exponential backoff. Non-transient failures still fail on the first attempt. After exhaustion it still returns `tenders: null`.

## Global Constraints

- **No new npm dependencies.** `node:test` and `node:assert` only, matching every existing test file.
- **CommonJS.** `require` / `module.exports`. No ESM, no build step, no TypeScript.
- **`npm test` stays offline and zero-token.** No network, no browser, no Gemini call, no `.env` requirement in any test added by this plan. The AI retry tests use an injected fake client.
- **Hebrew unicode in regexes must be written as escapes** (`֐-׿`), never as literal characters in a character class. Hebrew inside plain string literals (`'הבא'`) is fine.
- **`CONCURRENCY` env var, default 4.** `CONCURRENCY=1` must reproduce today's sequential behavior exactly — it is both the escape hatch and the A/B baseline.
- **`SITE_TIMEOUT_MS` env var, default 300000** (5 minutes). `SITE_TIMEOUT_MS=0` disables the timeout.
- **Gemini retry: 3 attempts total, base backoff 1000ms, full jitter.**
- **`main.js` stays orchestration only.** Browser, network, webhook, and the buffered-log plumbing live there; anything schedulable, pure, or decidable goes in `lib/`.
- **Every Phase 1–3 invariant survives unchanged**, and each is asserted by review at the end of Task 5:
  - cache is saved *before* webhook delivery, with `pendingDelivery: true`, flipped to `false` on HTTP 200;
  - the cache stores the RAW merged list, never the validated `kept` list;
  - AI failure returns `null` (leave cache alone), never `[]`;
  - removal matching prefers false-keep over false-drop;
  - the webhook contract stays `{ tenders: [...] }` with the `x-webhook-key` header, one full list per city.
- **`RUN_STATS` mutation stays lock-free.** Node's event loop does not preempt mid-statement, so `RUN_STATS.aiCalls++` is safe across concurrent async tasks. Keep every aggregate commutative — no stat may depend on site order.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/pool.js` | **create** | Pure scheduling: `runPool` (concurrency cap, slot-based dispatch, per-item error capture, input-order results) and `withTimeout` (bounded task, slot freed on deadline). Knows nothing about browsers, sites, or AI. |
| `test/pool.test.js` | **create** | Mock-worker tests for both exports. Offline, no timers longer than ~60ms. |
| `lib/ai.js` | modify | Add transient-failure classification, jittered backoff, bounded retry loop, and injectable `client`/`sleep`/`rand` seams for tests. Later becomes log-free. |
| `test/ai.test.js` | **create** | Retry behavior against an injected fake client; classification table; backoff bounds; a guard that `lib/ai.js` never calls `console`. |
| `main.js` | modify | Loop body → `processSite(muni, index)`; sequential loop → `runPool`; per-site log buffers; run summary over pool results. |
| `scripts/concurrency-check.js` | **create** | Live, free, zero-token A/B: scrape-half only, concurrency 1 vs N, compares per-site stable-key sets and prints both wall-clocks. |
| `CLAUDE.md` | modify | Pipeline diagram, module table, commands, env vars, roadmap phase 4 ✅. |
| `docs/superpowers/specs/2026-08-06-concurrency-design.md` | modify | Status line: decisions settled, phase implemented. |

Tasks 1–3 are independent of each other and of `main.js`; Tasks 4→5→6 are strictly sequential (each rewrites the same region of `main.js`); Task 7 depends on Task 1 only.

---

### Task 1: `runPool` — the bounded, slot-based scheduler

**Files:**
- Create: `lib/pool.js`
- Test: `test/pool.test.js`

**Interfaces:**
- Consumes: nothing (first task, no dependencies).
- Produces: `runPool(items, worker, { concurrency = 4 } = {})` → `Promise<Array<{ ok: true, value: any } | { ok: false, error: Error }>>`. `worker` is called as `worker(item, index)`. Results are in **input** order. The returned promise **never rejects**. Task 5 and Task 7 both call it; Task 2 adds a second export to the same file.

- [ ] **Step 1: Write the failing tests**

Create `test/pool.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { runPool } = require('../lib/pool');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A worker that records how many tasks were in flight at once.
function tracker(durations = []) {
  const state = { live: 0, peak: 0, order: [] };
  const worker = async (item, i) => {
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    state.order.push(item);
    await sleep(durations[i] ?? 5);
    state.live--;
    return `done:${item}`;
  };
  return { state, worker };
}

test('runs every item exactly once and returns results in INPUT order', async () => {
  // Reverse durations: item 0 finishes LAST, so completion order is scrambled.
  const { worker } = tracker([40, 25, 10]);
  const results = await runPool(['a', 'b', 'c'], worker, { concurrency: 3 });
  assert.deepStrictEqual(results, [
    { ok: true, value: 'done:a' },
    { ok: true, value: 'done:b' },
    { ok: true, value: 'done:c' }
  ]);
});

test('never exceeds the concurrency cap', async () => {
  const { state, worker } = tracker(new Array(9).fill(15));
  await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9], worker, { concurrency: 3 });
  assert.strictEqual(state.peak, 3);
});

test('concurrency 1 executes in strict sequence', async () => {
  const { state, worker } = tracker([20, 5, 5]);
  await runPool(['a', 'b', 'c'], worker, { concurrency: 1 });
  assert.strictEqual(state.peak, 1);
  assert.deepStrictEqual(state.order, ['a', 'b', 'c']);
});

test('dispatches as slots free, not in fixed batches', async () => {
  // concurrency 2 over [long, short, short]: with batching, item 3 would wait
  // for the long item. With slot dispatch it starts as soon as item 2 is done.
  const started = [];
  const worker = async (item) => {
    started.push(item);
    await sleep(item === 'long' ? 60 : 5);
  };
  await runPool(['long', 'short1', 'short2'], worker, { concurrency: 2 });
  assert.deepStrictEqual(started, ['long', 'short1', 'short2']);
});

test('a throwing worker is captured, does not reject, and siblings still run', async () => {
  const worker = async (item) => {
    if (item === 'bad') throw new Error('boom');
    return `ok:${item}`;
  };
  const results = await runPool(['a', 'bad', 'c'], worker, { concurrency: 2 });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[1].ok, false);
  assert.strictEqual(results[1].error.message, 'boom');
  assert.deepStrictEqual(results[2], { ok: true, value: 'ok:c' });
});

test('passes the input index to the worker', async () => {
  const seen = [];
  await runPool(['a', 'b'], async (item, i) => { seen.push([item, i]); }, { concurrency: 1 });
  assert.deepStrictEqual(seen, [['a', 0], ['b', 1]]);
});

test('empty list returns an empty array without calling the worker', async () => {
  let called = 0;
  const results = await runPool([], async () => { called++; }, { concurrency: 4 });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(called, 0);
});

test('concurrency larger than the item count is harmless', async () => {
  const { state, worker } = tracker([10, 10]);
  const results = await runPool(['a', 'b'], worker, { concurrency: 99 });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(state.peak, 2);
});

test('bad concurrency values coerce to at least 1', async () => {
  for (const bad of [0, -3, NaN, undefined]) {
    const { state, worker } = tracker([5, 5]);
    const results = await runPool(['a', 'b'], worker, { concurrency: bad });
    assert.strictEqual(results.length, 2, `concurrency=${bad}`);
    assert.ok(state.peak >= 1, `concurrency=${bad}`);
  }
});

test('defaults to concurrency 4 when no options are given', async () => {
  const { state, worker } = tracker(new Array(8).fill(15));
  await runPool([1, 2, 3, 4, 5, 6, 7, 8], worker);
  assert.strictEqual(state.peak, 4);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pool.test.js`
Expected: FAIL — `Cannot find module '../lib/pool'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/pool.js`:

```js
// Pure scheduling for the site run. Knows nothing about browsers, sites, or
// AI — the same pure/impure seam as paginate vs makePuppeteerDriver, and for
// the same reason: the scheduler has to be testable without a live run.

// Runs `worker(item, index)` over `items`, at most `concurrency` in flight.
// NEVER rejects: every item yields { ok: true, value } or { ok: false, error },
// which is what preserves today's per-iteration try/catch isolation — one site
// blowing up must not abort the run or any sibling.
// Results come back in INPUT order regardless of completion order, so the run
// summary is deterministic even though execution is not.
async function runPool(items, worker, { concurrency = 4 } = {}) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let next = 0;

  // One long-lived slot: pulls the next index and runs it, until the queue is
  // drained. Dispatch is per-slot, NOT per-batch — a fast site must never wait
  // on a slow one, or the speedup collapses to the slowest member of a chunk.
  async function slot() {
    while (next < list.length) {
      const i = next++; // claim the index synchronously, before any await
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, slot));
  return results;
}

module.exports = { runPool };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pool.test.js`
Expected: PASS, 10/10.

Then run the whole suite to confirm nothing regressed: `npm test` — expected all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pool.js test/pool.test.js
git commit -m "feat: add bounded worker pool (pure, slot-based dispatch)"
```

---

### Task 2: `withTimeout` — bound one site, free the slot

**Files:**
- Modify: `lib/pool.js` (add a second export)
- Test: `test/pool.test.js` (append)

**Interfaces:**
- Consumes: `lib/pool.js` from Task 1.
- Produces: `withTimeout(promise, ms, label)` → `Promise`. Resolves/rejects through when the promise settles first. Rejects with `Error("Timed out after <ms>ms: <label>")` past the deadline. `ms` of `0`, `null`, or negative disables the timeout entirely. Task 5 wraps `processSite` with it.

**Read before implementing:** the spec's honest caveat — a timeout **does not abort** the underlying work. It frees the pool slot; the orphaned `processSite` keeps running and closes its own browser in its `finally`. Do not attempt to cancel Puppeteer here; that decision was made and rejected as out-of-scope.

- [ ] **Step 1: Write the failing tests**

Append to `test/pool.test.js` (and add `withTimeout` to the `require` at the top of the file, so it reads `const { runPool, withTimeout } = require('../lib/pool');`):

```js
test('withTimeout resolves through when the work finishes in time', async () => {
  const value = await withTimeout(sleep(5).then(() => 'fast'), 100, 'site');
  assert.strictEqual(value, 'fast');
});

test('withTimeout rejects with a labeled error past the deadline', async () => {
  await assert.rejects(
    () => withTimeout(sleep(200), 20, 'עיריית חיפה'),
    (err) => {
      assert.match(err.message, /Timed out after 20ms/);
      assert.match(err.message, /עיריית חיפה/);
      return true;
    }
  );
});

test('withTimeout passes a real rejection through unchanged', async () => {
  const failing = Promise.reject(new Error('scrape blew up'));
  await assert.rejects(() => withTimeout(failing, 100, 'site'), /scrape blew up/);
});

test('a late rejection after the deadline does not surface as unhandled', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late = new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 30));
    await assert.rejects(() => withTimeout(late, 5, 'site'), /Timed out/);
    await sleep(60); // let the orphan reject with nobody waiting
    assert.deepStrictEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('withTimeout with ms 0 or null disables the timeout', async () => {
  assert.strictEqual(await withTimeout(sleep(30).then(() => 'slow'), 0, 'site'), 'slow');
  assert.strictEqual(await withTimeout(sleep(30).then(() => 'slow'), null, 'site'), 'slow');
});

test('a timed-out task frees its pool slot immediately', async () => {
  // One task hangs for 200ms with a 20ms ceiling; with the slot freed on time,
  // three tasks through a pool of 1 finish in well under 200ms.
  const t0 = Date.now();
  const results = await runPool(
    ['hang', 'a', 'b'],
    (item) => withTimeout(item === 'hang' ? sleep(200) : sleep(5), 20, item),
    { concurrency: 1 }
  );
  assert.strictEqual(results[0].ok, false);
  assert.match(results[0].error.message, /Timed out/);
  assert.strictEqual(results[1].ok, true);
  assert.strictEqual(results[2].ok, true);
  assert.ok(Date.now() - t0 < 150, 'slot was not freed on the deadline');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pool.test.js`
Expected: FAIL — `withTimeout is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `lib/pool.js`, add above `module.exports`:

```js
// Bounds one task so a hung site costs one slot, not the whole run.
//
// IMPORTANT, and deliberate: this frees the SLOT, it does not abort the WORK.
// The orphaned promise keeps running and closes its own browser in its
// `finally`; the Chrome process may linger for a few seconds past the
// deadline. Truly aborting would mean threading an AbortSignal through the
// driver, the paginate loop, and both custom scrapers — decided against.
function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  if (!(ms > 0)) return p;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });

  // Attach a handler to the orphan so a late rejection — arriving after we
  // have stopped waiting — never becomes an unhandled rejection and kills the run.
  p.catch(() => {});

  // clearTimeout so a fast task does not hold the event loop open to the deadline.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
```

And update the export line:

```js
module.exports = { runPool, withTimeout };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pool.test.js`
Expected: PASS, 16/16.

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pool.js test/pool.test.js
git commit -m "feat: add withTimeout so a hung site costs one slot, not the run"
```

---

### Task 3: Bounded Gemini retry on transient failures

**Files:**
- Modify: `lib/ai.js` (the `extractTenders` function and the exports)
- Test: `test/ai.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `extractTenders(rawText, opts)` → `Promise<{ tenders: Array|null, usage: { inputTokens, outputTokens }, attempts: number, error: string|null }>`. The `tenders` and `usage` fields keep today's exact meaning; `attempts` and `error` are **new** and are what Task 6 logs from the caller's buffer.
  - `opts` gains four optional test seams: `client` (a stand-in for `GoogleGenerativeAI`), `sleep` (defaults to a real timer), `attempts` (default `RETRY.attempts` = 3), `rand` (defaults to `Math.random`). `excerpt` keeps its meaning.
  - `isTransient(err)` → `boolean` and `backoffMs(attempt, baseMs, rand)` → `number`, both exported for direct testing.
  - `RETRY` → `{ attempts: 3, baseMs: 1000 }`, exported so tests assert the documented defaults.

**Why this is in Phase 4 at all:** sequential runs rarely hit Gemini's RPM limits; four concurrent calls will. A 429 today costs a site its entire run.

**Invariant to preserve exactly:** after retries are exhausted, `tenders` is still `null` — never `[]`. Retry changes how hard it tries, never what failure *means*.

- [ ] **Step 1: Write the failing tests**

Create `test/ai.test.js`:

```js
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

test('lib/ai.js never touches the console (its logs belong to the caller buffer)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai.js'), 'utf8');
  assert.ok(!/console\./.test(src), 'ai.js must stay log-free under concurrent runs');
});
```

**Note:** the last test (`never touches the console`) is expected to fail until Task 6 removes those two log lines. That is intentional — it is written here, with the rest of the file, and it is the one test Task 6 turns green. Mark it `test.skip(...)` in this task and un-skip it in Task 6.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ai.test.js`
Expected: FAIL — `isTransient is not a function` / `backoffMs is not a function`, plus assertion failures on `attempts` and `error`.

- [ ] **Step 3: Write the implementation**

In `lib/ai.js`, add below the `TENDER_ARRAY_SCHEMA` constant:

```js
// 1 attempt + 2 retries. Concurrent runs put up to CONCURRENCY calls in flight,
// which is where 429s start appearing; sequential runs almost never saw them.
const RETRY = { attempts: 3, baseMs: 1000 };

const TRANSIENT_MESSAGE = /\b(429|503)\b|rate.?limit|too many requests|overloaded|unavailable|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

// Worth retrying: rate limits, overloaded/unavailable models, network faults.
// NOT worth retrying: a bad API key, a permission error, an unparseable
// response — those fail identically every time and would just burn the budget.
function isTransient(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 429 || status === 503) return true;
  return TRANSIENT_MESSAGE.test(String(err.message || ''));
}

// Full jitter: a uniform point in [0, baseMs * 2^attempt). Concurrent workers
// that hit the same 429 must not retry in lockstep and re-collide.
function backoffMs(attempt, baseMs = RETRY.baseMs, rand = Math.random) {
  return Math.floor(rand() * baseMs * Math.pow(2, attempt));
}

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));
```

Then replace the whole `extractTenders` function with:

```js
// The ONLY impure lib module: it talks to Gemini. Returns tenders:null on any
// failure — after bounded retry — so the caller leaves the cache untouched and
// retries next run. null and [] are NOT interchangeable: [] means "healthy
// page, zero open tenders" and legitimately updates the cache.
//
// `client`, `sleep`, `attempts` and `rand` are test seams: injecting a fake
// client is what keeps the retry tests offline and zero-token.
async function extractTenders(rawText, {
  excerpt = false,
  client = null,
  sleep = realSleep,
  attempts = RETRY.attempts,
  rand = Math.random
} = {}) {
  const genAI = client || new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const max = Math.max(1, attempts);
  let lastErr = null;

  for (let attempt = 0; attempt < max; attempt++) {
    try {
      const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        generationConfig: {
          temperature: 0.0,
          responseMimeType: 'application/json',
          responseSchema: TENDER_ARRAY_SCHEMA
        }
      });
      const result = await model.generateContent(buildPrompt(rawText, excerpt));
      const u = result.response.usageMetadata;
      const usage = {
        inputTokens: (u && u.promptTokenCount) || 0,
        outputTokens: (u && u.candidatesTokenCount) || 0
      };
      return { tenders: JSON.parse(result.response.text()), usage, attempts: attempt + 1, error: null };
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === max - 1) break;
      await sleep(backoffMs(attempt, RETRY.baseMs, rand));
    }
  }

  return {
    tenders: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    attempts: max === 1 || !isTransient(lastErr) ? 1 : max,
    error: (lastErr && lastErr.message) || 'unknown error'
  };
}
```

Careful with the `attempts` field on the failure path: a non-transient error breaks out on the first pass, so it must report `1`, not `max`. If that expression reads awkwardly to you, track a counter variable instead — the tests pin the behavior, not the implementation.

Finally, extend the exports:

```js
module.exports = { extractTenders, buildPrompt, isTransient, backoffMs, RETRY, MODEL_NAME, TENDER_ARRAY_SCHEMA };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ai.test.js`
Expected: PASS, with the console-guard test reported as skipped.

Run: `npm test`
Expected: all PASS. This suite must complete with no `.env` present and no network — if it hangs, a real timer or a real client leaked into a test.

- [ ] **Step 5: Commit**

```bash
git add lib/ai.js test/ai.test.js
git commit -m "feat: bounded retry with jittered backoff on transient Gemini failures"
```

---

### Task 4: Extract the loop body into `processSite` (pure refactor)

**Files:**
- Modify: `main.js:72-206` (`run()` — the loop body moves out; the loop itself stays sequential in this task)

**Interfaces:**
- Consumes: nothing new.
- Produces: `async function processSite(muni, index)` → `Promise<void>`. Throws on failure; closes its own browser in `finally`. Task 5 hands this to `runPool` as the worker; Task 6 gives it a log buffer.

**This task changes no behavior.** It is a mechanical extraction so that Task 5's diff is small enough to review. Every `continue` becomes a `return`; every explicit `await browser.close()` disappears into a single `finally`; the loop keeps its `try/catch` and its 4s pause for now.

- [ ] **Step 1: Extract the function**

Insert `processSite` immediately above `async function run()` (currently [main.js:72](../../../main.js#L72)), moving the body of the `for` loop verbatim:

```js
// One site, end to end: launch → scrape → diff → extract? → merge → save →
// validate → deliver. This is the pool's worker (Task 5). It closes its own
// browser in `finally`, which is also what makes a timed-out orphan clean up
// after itself once the pool has moved on.
async function processSite(muni, index) {
  console.log(`\n=== [${index + 1}/${MUNICIPALITIES.length}] Processing: ${muni.publisher} ===`);

  let browser;
  try {
    // HEADFUL=1 opens a visible browser window — for demos and debugging.
    browser = await puppeteer.launch({
      headless: process.env.HEADFUL ? false : "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(muni.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // script (custom file) wins; otherwise the generic config-driven paginator.
    const scrapeResult = muni.script
      ? await require(muni.script).scrape(page)
      : await paginate(makePuppeteerDriver(page, muni.pagination || {}), muni.pagination || {});

    if (!scrapeResult || (typeof scrapeResult === 'string' && scrapeResult.length < 100) || (Array.isArray(scrapeResult) && scrapeResult.length === 0)) {
      console.log(`⚠️ No content extracted for ${muni.publisher}.`);
      return;
    }

    const pages = Array.isArray(scrapeResult) ? scrapeResult : [scrapeResult];

    let fullCityRawText = "";
    for (let p = 0; p < pages.length; p++) {
      fullCityRawText += `\n--- PAGE ${p + 1} ---\n` + pages[p];
    }

    const cleanedCityText = superCleanText(fullCityRawText);
    const entries = buildEntries(cleanedCityText);
    const siteEntry = getSiteEntry(storage.loadRaw(muni.url));
    const cachedKeyHashes = siteEntry ? siteEntry.keyHashes : {};
    const { addedKeys, removedKeys, changedKeys, newKeyHashes } = diff(cachedKeyHashes, entries);

    // Case 1: nothing changed since last run
    if (siteEntry && addedKeys.length === 0 && removedKeys.length === 0 && changedKeys.length === 0) {
      if (siteEntry.pendingDelivery && siteEntry.tenders.length > 0) {
        console.log(`📡 Content unchanged but last delivery failed — resending ${siteEntry.tenders.length} cached tenders (0 tokens)...`);
        // siteEntry.tenders is both the payload and the baseline: an unchanged
        // page must never look like a collapse.
        const { ok } = await validateAndDeliver(siteEntry.tenders, cleanedCityText, siteEntry.tenders);
        if (ok) {
          storage.saveRaw(muni.url, makeSiteEntry(siteEntry.keyHashes, siteEntry.tenders, false));
          console.log(`✅ Webhook accepted pending delivery. Cache updated.`);
        }
      } else {
        console.log(`⏭️ Green Light: Website content is IDENTICAL to last run. Skipping AI.`);
      }
      return;
    }

    // Case 2: choose full vs incremental extraction
    const useFullPath = !siteEntry || isDiffTooLarge(addedKeys, removedKeys, changedKeys, Object.keys(cachedKeyHashes).length, Object.keys(newKeyHashes).length);

    let newTenders = [];
    if (useFullPath) {
      const reason = !siteEntry ? "first run / legacy cache" : "diff too large — safety fallback";
      console.log(`📄 Full extraction (${reason}): sending ${cleanedCityText.length} chars to AI...`);
      newTenders = await extractAndCount(cleanedCityText);
    } else if (addedKeys.length + changedKeys.length > 0) {
      const chunks = buildChunks(entries, [...addedKeys, ...changedKeys]);
      const excerptText = chunks.join('\n---\n');
      console.log(`✂️ Incremental: ${addedKeys.length} new / ${changedKeys.length} changed / ${removedKeys.length} removed lines → sending only ${excerptText.length} of ${cleanedCityText.length} chars to AI...`);
      newTenders = await extractAndCount(excerptText, { excerpt: true });
    } else {
      console.log(`🗑️ Removals only (${removedKeys.length} lines gone) — no AI call needed. 0 tokens.`);
    }

    if (newTenders === null) {
      console.log(`⚠️ AI extraction failed. Cache NOT updated — will retry next run.`);
      return;
    }

    const merged = mergeTenders(useFullPath ? [] : siteEntry.tenders, newTenders, cleanedCityText, muni.publisher, muni.url);
    console.log(`✨ Merged list: ${merged.length} tenders (${newTenders.length} newly extracted).`);

    if (merged.length > 0) {
      // Save BEFORE delivery: a webhook failure must never cost a second AI call.
      // RAW merged, never the validated list — validation would flip a degraded
      // tender's upsertKey from num: to title: and duplicate it next run.
      storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, merged, true));

      console.log(`📡 Streaming structured tenders to Lovable Webhook...`);
      const { ok, kept } = await validateAndDeliver(merged, cleanedCityText, siteEntry ? siteEntry.tenders : []);
      RUN_STATS.dropped += merged.length - kept.length;

      if (ok) {
        storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, merged, false));
        console.log(`✅ Webhook Accepted! Status: 200. Delivered ${kept.length}/${merged.length} validated. Cache updated.`);
      } else {
        console.log(`⚠️ Webhook returned unexpected status. Extraction saved — will resend next run without AI.`);
      }
    } else if (cleanedCityText.length > 1500) {
      console.log(`✅ Page verified healthy with 0 active tenders. Updating Cache.`);
      storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, [], false));
    } else {
      console.log(`⚠️ Warning: Page content seems too low or failed. Skipping cache to allow retry.`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
```

- [ ] **Step 2: Reduce `run()` to the sequential loop over it**

Replace the whole `for` loop in `run()` ([main.js:76-196](../../../main.js#L76-L196)) with:

```js
  for (let i = 0; i < MUNICIPALITIES.length; i++) {
    try {
      await processSite(MUNICIPALITIES[i], i);
    } catch (err) {
      console.error(`❌ Error with ${MUNICIPALITIES[i].publisher}:`, err.message);
    }
    if (i < MUNICIPALITIES.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }
```

Leave `run()`'s opening lines and the closing summary block untouched.

- [ ] **Step 3: Make `main.js` requireable so it can be smoke-checked**

Replace the bare `run();` at [main.js:206](../../../main.js#L206) with:

```js
// Guarded so `require('./main.js')` (smoke checks, future tests) does not kick
// off a live 14-site run. `node main.js` is unaffected.
if (require.main === module) {
  run();
}

module.exports = { processSite, run };
```

- [ ] **Step 4: Verify — syntax, wiring, and the suite**

There is no unit test for `main.js` (it needs a browser and the network), so verification is three checks. Run all three:

```bash
node --check main.js
node -e "const m = require('./main.js'); console.log(typeof m.processSite, typeof m.run)"
npm test
```

Expected: no syntax error; `function function`; all tests PASS. The second command must exit immediately — if it launches a browser, the `require.main` guard is wrong.

Then read the diff with `git diff main.js` and confirm the extraction was **mechanical**: same order of operations, same log strings, same `storage.saveRaw` call sites in the same order, `continue` → `return`, and no `browser.close()` left outside the `finally`.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "refactor: extract per-site pipeline into processSite (no behavior change)"
```

---

### Task 5: Swap the sequential loop for the pool

**Files:**
- Modify: `main.js` (imports, new config constants, `run()`)

**Interfaces:**
- Consumes: `runPool` and `withTimeout` from `lib/pool.js` (Tasks 1–2); `processSite` from Task 4.
- Produces: a `run()` that dispatches through the pool and prints a failure roll-up. `CONCURRENCY` and `SITE_TIMEOUT_MS` env vars.

- [ ] **Step 1: Add the import and the config constants**

Add to the import block at the top of `main.js`, after the `paginator` line:

```js
const { runPool, withTimeout } = require('./lib/pool');
```

Add below `const WEBHOOK_KEY = ...`:

```js
// How many sites run at once. CONCURRENCY=1 reproduces the old sequential
// behavior exactly — the escape hatch, and the A/B baseline for
// scripts/concurrency-check.js. Memory is the real cap: each site gets its own
// Chrome (~150–300MB), which is the price of crash isolation between sites.
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '4', 10) || 1);

// Per-site ceiling, ~5× the slowest observed site. On expiry the pool frees the
// slot and records the site failed; the cache is simply not updated, which is
// already safe. SITE_TIMEOUT_MS=0 disables it.
const SITE_TIMEOUT_MS = Math.max(0, parseInt(process.env.SITE_TIMEOUT_MS || '300000', 10) || 0);
```

- [ ] **Step 2: Replace the loop with the pool**

In `run()`, replace the entire `for` loop from Task 4 with:

```js
  console.log(`⚙️ Concurrency: ${CONCURRENCY} | per-site timeout: ${SITE_TIMEOUT_MS ? `${SITE_TIMEOUT_MS / 1000}s` : 'off'}`);

  // Slot-based dispatch, NOT batches: site durations vary by an order of
  // magnitude, and a chunked Promise.all would idle N-1 workers waiting on the
  // slowest member of each chunk.
  const results = await runPool(
    MUNICIPALITIES,
    (muni, i) => withTimeout(processSite(muni, i), SITE_TIMEOUT_MS, muni.publisher),
    { concurrency: CONCURRENCY }
  );
```

Note what is deliberately gone: the 4s inter-site pause (a sequential-era artifact — 14 distinct domains share no rate limit, and under a pool it would only idle a slot) and the per-iteration `try/catch` (`runPool` captures per item, which is the same isolation guarantee).

- [ ] **Step 3: Report failures in the run summary**

Insert immediately above the existing `const minutes = ...` line in `run()`:

```js
  const failures = results
    .map((r, i) => (r.ok ? null : { publisher: MUNICIPALITIES[i].publisher, error: r.error }))
    .filter(Boolean);
```

And add this line to the summary block, after the health line:

```js
  console.log(`🧵 Sites: ${MUNICIPALITIES.length - failures.length}/${MUNICIPALITIES.length} completed${failures.length ? ` | ${failures.length} failed:` : ''}`);
  for (const f of failures) console.log(`   ❌ ${f.publisher}: ${f.error.message}`);
```

- [ ] **Step 4: Verify**

```bash
node --check main.js
node -e "require('./main.js')"
npm test
```

Expected: no syntax error, immediate exit, all tests PASS.

Then re-read `processSite` against this invariant checklist and confirm each one, out loud, in the commit or your task report:

1. `storage.saveRaw(..., makeSiteEntry(newKeyHashes, merged, true))` still happens **before** `validateAndDeliver`, and the `false` flip still happens only on `ok`.
2. The cached list is `merged` (RAW), never `kept`.
3. `newTenders === null` still returns early without touching the cache; `[]` still flows through to the cache-update path.
4. The webhook payload shape and headers are untouched.
5. `RUN_STATS` is only ever incremented (`++` / `+=`) — no read-then-write-later across an `await`.
6. Two workers cannot write the same cache file: each site's record is `cache/<md5-of-url>.json` (Phase 2).

- [ ] **Step 5: Live smoke test at concurrency 2 (optional but recommended)**

A real run costs tokens and POSTs to production, so only do this if you want end-to-end confidence before Task 7's free check:

```bash
# FIRST: trim MUNICIPALITIES in lib/sites.js to 2 entries, or skip this step.
CONCURRENCY=2 node main.js
```

Expected: both sites process, the summary reports `2/2 completed`. **Restore `lib/sites.js` before committing.**

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat: run sites through a bounded pool (CONCURRENCY, default 4)"
```

---

### Task 6: Per-site log buffers and a log-free `lib/ai.js`

**Files:**
- Modify: `main.js` (`processSite`, `extractAndCount`, `validateAndDeliver`, plus a new `makeSiteLog`)
- Modify: `lib/ai.js` (delete the two console calls)
- Modify: `test/ai.test.js` (un-skip the console guard)

**Interfaces:**
- Consumes: `extractTenders`'s `attempts` / `error` fields from Task 3; `processSite` from Task 4.
- Produces: `makeSiteLog(muni, index, total)` → `{ log(msg), flush() }`. `extractAndCount(text, log, opts)` and `validateAndDeliver(rawTenders, cleanedText, previousTenders, log)` both gain a `log` parameter.

**Why:** with 4 sites interleaving `console.log`, the run log — the only window into a production run — becomes unreadable. Each site buffers its lines and flushes them as one block when it finishes, on success *and* on error.

- [ ] **Step 1: Add the buffer helper**

Insert into `main.js` above `extractAndCount`:

```js
// One buffer per site, flushed as a single contiguous block when the site
// finishes. Under concurrency, unbuffered console.log from 4 workers shreds
// the run log. The trade-off is explicit: a site's block appears at its
// COMPLETION time, so blocks are no longer chronological across sites — which
// is why the header carries the elapsed time.
function makeSiteLog(muni, index, total) {
  const lines = [];
  const started = Date.now();
  return {
    log: (msg) => lines.push(msg),
    flush: () => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log([`\n=== [${index + 1}/${total}] ${muni.publisher} — ${secs}s ===`, ...lines].join('\n'));
    }
  };
}
```

- [ ] **Step 2: Thread `log` through the two helpers**

`extractAndCount` becomes — note that the two log lines deleted from `lib/ai.js` in Step 4 reappear here, in the caller's buffer, now including retry information:

```js
// Runs the AI extraction and folds its token usage into RUN_STATS.
// Returns null on failure: the caller must leave the cache untouched.
async function extractAndCount(text, log, opts) {
  log(`🤖 Attempting extraction with model: ${MODEL_NAME}...`);
  const { tenders, usage, attempts, error } = await extractTenders(text, opts);
  if (tenders === null) {
    log(`❌ Model ${MODEL_NAME} failed after ${attempts} attempt(s) (${error}). Returning null so cache is NOT updated.`);
    return null;
  }
  if (attempts > 1) log(`🔁 Succeeded on attempt ${attempts} after a transient failure.`);
  RUN_STATS.aiCalls++;
  RUN_STATS.inputTokens += usage.inputTokens;
  RUN_STATS.outputTokens += usage.outputTokens;
  log(`💰 Tokens — input: ${usage.inputTokens}, output: ${usage.outputTokens}, total: ${usage.inputTokens + usage.outputTokens}`);
  return tenders;
}
```

This needs `MODEL_NAME` in scope — change the AI import at the top of `main.js` to:

```js
const { extractTenders, MODEL_NAME } = require('./lib/ai');
```

`validateAndDeliver` takes `log` as a fourth parameter and every `console.log` inside it becomes `log(...)`:

```js
async function validateAndDeliver(rawTenders, cleanedText, previousTenders, log) {
```

- [ ] **Step 3: Buffer `processSite`**

In `processSite`:

1. Replace the opening `console.log(...=== Processing ...===...)` line with:

```js
  const { log, flush } = makeSiteLog(muni, index, MUNICIPALITIES.length);
```

2. Replace **every** remaining `console.log(` inside `processSite` with `log(`.
3. Update the three call sites that now take `log`: `extractAndCount(cleanedCityText, log)`, `extractAndCount(excerptText, log, { excerpt: true })`, and all three `validateAndDeliver(...)` calls (there are two — the pending-resend one and the main one) gain `log` as the last argument.
4. Add a `catch` that annotates the buffer before rethrowing, and flush in `finally`:

```js
  } catch (err) {
    // Annotate the buffer, then rethrow: the pool records the failure and the
    // run summary lists it. Flushing in `finally` means a failing site's
    // context is never lost.
    log(`❌ Error: ${err.message}`);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    flush();
  }
```

**Known behavior, accepted:** a site that hits `SITE_TIMEOUT_MS` has its block flushed by the orphan when it eventually drains — possibly after the run summary. That is useful for debugging, not a bug; do not try to suppress it.

- [ ] **Step 4: Make `lib/ai.js` log-free**

Delete the `console.log(\`🤖 Attempting extraction...\`)` line and the `if (u) { console.log(\`💰 Tokens...\`) }` block from `extractTenders`. Both now live in `extractAndCount`. Keep the `usage` computation itself — the caller needs it.

Then un-skip the guard test in `test/ai.test.js`: change `test.skip('lib/ai.js never touches the console...` back to `test('lib/ai.js never touches the console...`.

- [ ] **Step 5: Verify**

```bash
node --test test/ai.test.js
node --check main.js
node -e "require('./main.js')"
npm test
```

Expected: the console-guard test now PASSES (nothing skipped); no syntax error; immediate exit; whole suite PASS.

Then grep to confirm the buffering is complete — `processSite` must contain no direct console call:

```bash
node -e "const s=require('fs').readFileSync('main.js','utf8');const b=s.slice(s.indexOf('async function processSite'),s.indexOf('async function run'));console.log(/console\./.test(b)?'FAIL: console in processSite':'OK')"
```

Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add main.js lib/ai.js test/ai.test.js
git commit -m "feat: buffer per-site logs so concurrent output stays readable"
```

---

### Task 7: `scripts/concurrency-check.js` — the free live A/B

**Files:**
- Create: `scripts/concurrency-check.js`
- Modify: `package.json` (add a `concurrency-check` script)

**Interfaces:**
- Consumes: `runPool` from Task 1; `MUNICIPALITIES`, `superCleanText`/`buildEntries`, `paginate`/`makePuppeteerDriver`.
- Produces: a CLI — `node scripts/concurrency-check.js [N]`, exit 0 on MATCH, 1 on DIVERGE.

**This is the Phase-4 analogue of `scrape-diff`, and it is the success criterion for the whole phase.** It runs only the **scrape half** — no Gemini call, no webhook, no cache read or write — once at concurrency 1 and once at concurrency N, then compares per-site stable-key sets. A site whose key set changes under concurrency is the exact failure this phase must not ship. Model it on [scripts/scrape-diff.js](../../../scripts/scrape-diff.js), including how that file resolves a custom `script` path.

- [ ] **Step 1: Write the script**

Create `scripts/concurrency-check.js`:

```js
// Phase-4 analogue of scrape-diff: runs ONLY the scrape half of the pipeline
// across every site twice — once at concurrency 1, once at concurrency N — and
// compares the per-site stable-key sets. FREE: no Gemini calls, no webhook, no
// cache reads or writes. Usage: node scripts/concurrency-check.js [N]
//
// Caveat worth reading before you trust a DIVERGE: these are LIVE sites. A
// tender genuinely published between the two passes shows up here as a
// difference. The differing keys are printed so a human can tell a real
// concurrency bug from ordinary page churn — re-run to confirm.
const path = require('path');
const puppeteer = require('puppeteer');
const { MUNICIPALITIES } = require('../lib/sites');
const { superCleanText, buildEntries } = require('../lib/text');
const { paginate, makePuppeteerDriver } = require('../lib/paginator');
const { runPool } = require('../lib/pool');

async function scrapeKeys(muni) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(muni.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const cfg = muni.pagination || {};
    const res = muni.script
      ? await require(path.join(__dirname, '..', muni.script.replace('./', ''))).scrape(page)
      : await paginate(makePuppeteerDriver(page, cfg), cfg);

    const pages = Array.isArray(res) ? res : [res];
    let raw = '';
    pages.forEach((p, i) => { raw += `\n--- PAGE ${i + 1} ---\n` + p; });
    const entries = buildEntries(superCleanText(raw));
    return new Set(entries.map(e => e.key).filter(k => k !== null));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pass(label, concurrency) {
  console.log(`\n${label} (concurrency ${concurrency}) — ${MUNICIPALITIES.length} sites ...`);
  const t0 = Date.now();
  const results = await runPool(MUNICIPALITIES, scrapeKeys, { concurrency });
  const secs = (Date.now() - t0) / 1000;
  console.log(`${label} finished in ${secs.toFixed(1)}s`);
  return { results, secs };
}

async function main() {
  const n = Math.max(2, parseInt(process.argv[2] || '4', 10) || 4);

  const base = await pass('🔵 BASELINE', 1);
  const conc = await pass(`🟢 CONCURRENT`, n);

  console.log(`\n================ concurrency check ================`);
  let diverged = 0;

  MUNICIPALITIES.forEach((muni, i) => {
    const a = base.results[i];
    const b = conc.results[i];

    if (!a.ok || !b.ok) {
      diverged++;
      console.log(`❌ ${muni.publisher}: baseline ${a.ok ? 'ok' : `FAILED (${a.error.message})`}, concurrent ${b.ok ? 'ok' : `FAILED (${b.error.message})`}`);
      return;
    }

    const onlyBase = [...a.value].filter(k => !b.value.has(k));
    const onlyConc = [...b.value].filter(k => !a.value.has(k));
    if (onlyBase.length === 0 && onlyConc.length === 0) {
      console.log(`✅ ${muni.publisher}: ${a.value.size} keys match`);
      return;
    }

    diverged++;
    console.log(`❌ ${muni.publisher}: ${a.value.size} vs ${b.value.size} keys`);
    onlyBase.slice(0, 5).forEach(k => console.log(`   - only sequential: ${k.slice(0, 70)}`));
    onlyConc.slice(0, 5).forEach(k => console.log(`   + only concurrent: ${k.slice(0, 70)}`));
  });

  const speedup = base.secs / (conc.secs || 1);
  console.log(`\n⏱️  ${base.secs.toFixed(1)}s sequential → ${conc.secs.toFixed(1)}s at ${n} (${speedup.toFixed(1)}× faster)`);
  console.log(`VERDICT: ${diverged === 0 ? '✅ MATCH — concurrency is safe to ship' : `❌ DIVERGE on ${diverged} site(s) — re-run to rule out live page churn`}`);
  process.exit(diverged === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, extend `"scripts"`:

```json
  "scripts": {
    "test": "node --test test/*.test.js",
    "accuracy": "node scripts/accuracy.js",
    "concurrency-check": "node scripts/concurrency-check.js"
  },
```

- [ ] **Step 3: Verify it parses and wires up**

```bash
node --check scripts/concurrency-check.js
npm test
```

Expected: no syntax error; the suite still passes (this script is not part of it).

- [ ] **Step 4: Run it live — this is the phase's success criterion**

```bash
node scripts/concurrency-check.js 4
```

Expected: `VERDICT: ✅ MATCH` across all 14 sites, and a clear wall-clock reduction (a solid fraction of 4×, bounded below by the slowest single site). It takes roughly the sequential run's duration plus the concurrent one — budget ~15 minutes and let it finish.

On DIVERGE: **re-run once** before concluding anything — a tender published between passes looks identical to a bug. If the same site diverges twice, stop and investigate that site's driver; do not proceed to Task 8, and do not "fix" it by lowering the default concurrency.

Record the two wall-clock numbers and the verdict in the commit message — they are the evidence for the phase.

- [ ] **Step 5: Commit**

```bash
git add scripts/concurrency-check.js package.json
git commit -m "feat: add free concurrency-check (scrape-only, 1 vs N stable-key A/B)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-06-concurrency-design.md` (status line only)

- [ ] **Step 1: Update the spec's status line**

Replace the `**Status:**` line with:

```markdown
**Status:** Implemented 2026-08-20. Browser strategy confirmed 2026-08-06 (one browser per site); timeout shape (slot-freeing only, no abort plumbing) and Gemini retry (bounded, 2 retries) settled 2026-08-20. Plan: [docs/superpowers/plans/2026-08-20-concurrency.md](../plans/2026-08-20-concurrency.md)
```

Change nothing else in the spec — its Known Limitations are all still true, deliberately.

- [ ] **Step 2: Update `CLAUDE.md`**

Four edits:

1. **Commands** — add to the code block:

```bash
node scripts/concurrency-check.js [N]                 # live, free: stable-key sets at concurrency 1 vs N
CONCURRENCY=1 node main.js                            # sequential escape hatch (pre-phase-4 behavior)
```

2. **Env vars** — extend the `.env` sentence with a line beneath it:

```markdown
Optional env: `CONCURRENCY` (sites in flight, default 4), `SITE_TIMEOUT_MS` (per-site ceiling, default 300000; `0` disables), `HEADFUL=1` (visible browser).
```

3. **Module table** — add the row:

```markdown
| [lib/pool.js](lib/pool.js) | pure `runPool` (slot-based dispatch, concurrency cap, per-item error capture, input-order results) + `withTimeout` |
```

4. **Pipeline section** — above the per-site `scrape → … → POST` block, note that sites now run N-at-a-time:

```markdown
`main.js` runs sites through a bounded pool (`CONCURRENCY`, default 4), each site end-to-end and independent. Per site:
```

And add to the **Invariants that are easy to break** section:

```markdown
**A per-site timeout frees the pool slot, it does not abort the work** ([lib/pool.js](lib/pool.js)). The orphaned `processSite` drains on its own and closes its browser in `finally`; the Chrome process can outlive the deadline by seconds, and a timed-out site's log block flushes late. That's accepted, not overlooked — true cancellation would mean threading an `AbortSignal` through the driver, the paginate loop, and both custom scrapers.

**`lib/ai.js` must stay log-free** and `processSite` must never call `console` directly. Both write into the per-site buffer that `makeSiteLog` flushes as one block; a stray `console.log` reappears interleaved between other sites' output. `test/ai.test.js` guards the `lib/ai.js` half of this.

**Retry never changes what failure means.** `extractTenders` retries transient failures (429/503/network) twice with jittered backoff, then still returns `tenders: null`.
```

5. **Roadmap** — mark phase 4 done:

```markdown
The roadmap is five phases: **1** reliability foundation (validate/health/accuracy) ✅, **2** cache v3 ✅, **3** config-driven paginator ✅, **4** concurrency ✅, **5** alerting on health signals.
```

- [ ] **Step 3: Verify the docs match the code**

Re-read each claim you wrote against the actual source — defaults (`4`, `300000`, 3 attempts), file paths, and the export names in `lib/pool.js`. Then:

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-06-concurrency-design.md
git commit -m "docs: phase 4 concurrency shipped"
```

---

## Self-Review

**Spec coverage.** Goal 1 (bounded pool) → Tasks 1, 5. Goal 2 (pure, offline-tested scheduling) → Tasks 1, 2. Goal 3 (`CONCURRENCY=1` reproduces today) → Task 5 config + the `concurrency 1 executes in strict sequence` test in Task 1. Goal 4 (error isolation) → `runPool`'s per-item capture, tested in Task 1, wired in Task 5. Goal 5 (readable logs) → Task 6. Goal 6 (per-site timeout) → Tasks 2, 5. Goal 7 (free verification) → Task 7. Goal 8 (earlier invariants) → the Task 5 Step 4 checklist and the Task 4 mechanical-diff review. Spec sections on `RUN_STATS` safety → Global Constraints plus the Task 5 checklist item 5. Gemini retry → Task 3. Removal of the 4s pause → Task 5 Step 2. Moving `lib/ai.js`'s two console calls to the caller → Task 6 Steps 2 and 4.

**Non-goals honored:** no `worker_threads`, no per-domain rate limiting, no distributed execution, no change to extraction/prompt/model/scrapers/webhook contract, no alerting (Phase 5), no streaming delivery.

**Type consistency.** `runPool(items, worker, { concurrency })` → `{ ok, value } | { ok, error }` is used identically in Task 5 (`results[i].error.message`) and Task 7 (`a.ok`, `a.value` as a `Set`). `withTimeout(promise, ms, label)` is called with exactly that arity in Task 5 and Task 2's tests. `extractTenders`'s new `{ attempts, error }` fields are produced in Task 3 and consumed in Task 6's `extractAndCount`. `makeSiteLog(muni, index, total)` returns `{ log, flush }`, destructured that way in Task 6 Step 3. `extractAndCount(text, log, opts)` and `validateAndDeliver(raw, cleaned, previous, log)` are updated at every call site in Task 6 Step 3.

**Known gap, accepted:** `main.js` has no unit test, so Tasks 4–6 verify via `node --check`, a `require` smoke test behind the `require.main` guard, a source grep, and the live `concurrency-check` in Task 7. That is the same coverage shape the codebase already accepts for `main.js`, which is why the pool logic was pushed into `lib/pool.js` in the first place.
