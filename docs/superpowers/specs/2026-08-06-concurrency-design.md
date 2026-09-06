# Concurrency — Bounded Worker Pool — Design

**Date:** 2026-08-06
**Status:** Implemented 2026-08-20. Browser strategy confirmed 2026-08-06 (one browser per site); timeout shape (slot-freeing only, no abort plumbing) and Gemini retry (bounded, 2 retries) settled 2026-08-20. Plan: [docs/superpowers/plans/2026-08-20-concurrency.md](../plans/2026-08-20-concurrency.md)
**Phase:** 4 of 5 on the road to ~1000 sites (follows the config-driven paginator)

## תקציר בעברית

שלב 4 מטפל בזמן הריצה. היום `main.js` רץ אתר-אחרי-אתר: יותר מ-43 שניות לאתר, כלומר ~13 שעות ב-1000 אתרים. כמעט כל הזמן הזה הוא **המתנה**, לא חישוב — השהיות קבועות של ה-paginator, טעינת עמודים, וקריאה ל-Gemini. לכן מקביליות היא הפתרון הישיר. נריץ כמה אתרים בו-זמנית דרך worker pool חסום. הלוגיקה הטהורה (תזמון, תקרת מקביליות, בידוד שגיאות, סדר תוצאות) נכנסת ל-`lib/pool.js` ונבדקת אופליין מול worker מדומה; `main.js` מספק את ה-worker הלא-טהור. שלבים 2 ו-3 כבר הכשירו את הקרקע: קובץ קאש נפרד לכל אתר (אין קובץ משותף שנכתב מחדש) ומסלול pagination יחיד. אימות בלי ריצת ייצור: כלי חינמי שמריץ את חצי-הגרידה בלבד — בלי טוקנים, בלי webhook — במקביליות N מול מקביליות 1, ומשווה מפתחות יציבים. `CONCURRENCY=1` משחזר בדיוק את ההתנהגות של היום.

## Problem

`main.js` processes sites in a strictly sequential `for` loop ([main.js:76](../../../main.js#L76)), launching a browser, scraping, extracting, and delivering one site before starting the next, plus a fixed 4s pause between sites ([main.js:187-189](../../../main.js#L187-L189)).

Measured in Phase 1: **>43s/site → ~13h at 1000 sites.** Nearly all of that is *idle waiting*, not work:

| Source of wall-clock | Per site |
|---|---|
| `paginate` initial settle (`settleMs`) | 4s |
| per-page scroll + `waitMs`, × pages read | 6s–30s |
| `goNext` nav wait + fixed sleep, × page turns | 0s–16s |
| browser launch + `goto` | ~2–5s |
| Gemini call (when the diff says one is needed) | ~2–10s |
| inter-site pause | 4s |

A single Node process sits blocked on timers and network for essentially all of it, using one core and one browser at a time. This is the textbook case where bounded concurrency converts near-idle wall-clock into throughput, and it is the last structural item before the run is fast enough to schedule frequently at scale.

Two secondary problems fall out of the same loop:

- **A hung site stalls the entire run.** `page.setDefaultNavigationTimeout(60000)` bounds navigation, but not a site that keeps a paginator loop alive through five slow pages. There is no per-site ceiling.
- **A 429 from Gemini costs the whole site its run.** `extractTenders` catches everything and returns `tenders: null` ([lib/ai.js:61-64](../../../lib/ai.js#L61)), which correctly leaves the cache untouched — but with no retry, a transient rate-limit means that site does nothing this run. Sequential runs rarely hit RPM limits; concurrent ones will.

## Goals

1. Process sites through a **bounded worker pool** instead of a sequential loop; wall-clock drops by roughly the concurrency factor, minus the slowest site.
2. The scheduling logic is **pure and unit-tested offline** — the same seam as `paginate` / `makePuppeteerDriver`.
3. **`CONCURRENCY=1` reproduces today's behavior exactly**, as an escape hatch and as the A/B baseline.
4. **Error isolation is preserved**: one site throwing never aborts the run or any other site, exactly as the current per-iteration `try/catch` guarantees.
5. **Readable logs under interleaving** — a site's output stays contiguous.
6. A **per-site timeout** so a hung site costs one slot, not the run.
7. Verify without a production run: a free, scrape-only, zero-token concurrency check, in the spirit of `scrape-diff`.
8. Preserve every earlier-phase invariant: save-before-deliver, `null`-on-AI-failure, cache stores RAW merged tenders, `{ tenders: [...] }` webhook contract per city.

## Non-Goals

- **Multi-process / worker_threads.** The workload is I/O-bound; async concurrency in one process is sufficient and far simpler. Revisit only if profiling shows CPU saturation.
- **Per-domain rate limiting.** Today's 14 sites are 14 distinct domains, so there is no shared limit to respect. If the site list ever includes several hosts under one domain, a per-domain serialization key is the natural extension — deliberately not built now (YAGNI).
- **Distributed execution / queueing.** One process, one machine. The `lib/storage.js` seam from Phase 2 is what would make this possible later; this phase does not use it that way.
- **Changing extraction, prompt, model, scrapers, or the webhook contract.**
- **Alerting on the health signals** — Phase 5.
- **Streaming/partial delivery.** Delivery stays one POST per city with its full list.

## Architecture

### Split: pure pool + impure worker

Same seam as Phase 3, for the same reason — the schedulable logic must be testable without a browser.

**`lib/pool.js`** (pure, unit-tested):

```js
// Runs `worker(item, index)` over `items`, at most `concurrency` in flight.
// Never rejects. Results are returned in INPUT order regardless of completion
// order, so the run summary is deterministic even though execution is not.
async function runPool(items, worker, { concurrency = 4 } = {})
  → Promise<Array<{ ok: true, value } | { ok: false, error }>>

// Bounds one task. On timeout the pool's slot is freed immediately.
async function withTimeout(promise, ms, label) → Promise
```

`runPool` owns: the concurrency cap, dispatch as slots free (not fixed batches — a fast site must not wait on a slow one in the same batch), error capture per item, and input-order result collection. It knows nothing about browsers, sites, or AI.

**The worker** stays in `main.js`: launch browser → `goto` → dispatch custom-vs-generic scrape → diff → extract → merge → save → validate → deliver. This is today's loop body, extracted verbatim into `async function processSite(muni, index)` and otherwise unchanged. `main.js` remains orchestration only.

```js
const results = await runPool(MUNICIPALITIES, processSite, { concurrency: CONCURRENCY });
```

### Why "as slots free" and not batches

`Promise.all` over fixed chunks of N is the tempting one-liner and is wrong here: each chunk runs as long as its slowest member, and site durations vary by an order of magnitude (a 1-page site is ~12s; a 5-page site with an iframe scan is ~60s). Slot-based dispatch keeps all N workers busy until the queue drains, which is what produces the near-linear speedup.

### Browser strategy: one browser per site, N at a time

**Decided 2026-08-06.** The alternative (one shared Chrome with N isolated `BrowserContext`s) buys higher concurrency per GB but lets a single browser crash take down every in-flight site. Isolation and blast radius won over memory efficiency; revisit only if RAM becomes the actual blocker at scale.

Deliberately **not** switching to a shared browser with N pages or N incognito contexts. Launching per site is what happens today, so every site keeps a pristine profile with no cookie/storage bleed between municipalities, and a page crash takes down one site rather than N. The only change is that N launches overlap.

The ~2s launch cost is <5% of a site's wall-clock and is not worth trading isolation for. The real constraint is memory: each Chrome is roughly 150–300MB, so concurrency is capped by RAM, not by the pool. See Known Limitations.

### Configuration

`CONCURRENCY` env var, default **4**. `CONCURRENCY=1` must produce byte-identical behavior to today's sequential loop, which makes it both the escape hatch and the baseline for the A/B check.

The 4s inter-site pause is **removed**. It is a sequential-era artifact — with distinct domains there is no shared rate limit for it to protect, and under a pool it would only idle a slot.

### Logging: buffer per site, flush atomically

14 sites interleaving `console.log` produces unreadable output, and the run log is the only window into a production run. Each worker collects its lines into a per-site buffer and flushes them as one contiguous block when the site finishes — on success *and* on error, so a failing site's context is never lost.

This requires the two `console.log` calls inside `lib/ai.js` ([lib/ai.js:45](../../../lib/ai.js#L45), [lib/ai.js:56-58](../../../lib/ai.js#L56)) to move out: `extractTenders` already returns `usage`, so the token line belongs to the caller's buffer. That also makes `lib/ai.js` log-free, which is the right shape for it regardless of concurrency.

### `RUN_STATS` under concurrency

`RUN_STATS.aiCalls++` and friends stay as they are. Node's event loop is single-threaded and does not preempt mid-statement, so read-modify-write on a plain object is safe across concurrent async tasks — there is no lost-update hazard here and no lock is needed. Documented explicitly because it looks unsafe to anyone reading it with a threads mental model.

### Per-site timeout

The worker wraps its own body in `withTimeout(..., SITE_TIMEOUT_MS)` (proposed default 5 minutes — roughly 5× the slowest observed site). On timeout the pool frees the slot immediately and records the site as failed; the site is simply not updated this run, which is already a safe outcome under the `null`-on-failure invariant.

**Honest caveat:** a timeout does not abort in-flight Puppeteer work. The orphaned promise keeps running and closes its browser in its own `finally`. The slot is freed on time; the Chrome process may linger for seconds longer. Bounding memory precisely would need an abort signal threaded through the driver — out of scope, and noted as a limitation rather than papered over.

### Gemini retry

`extractTenders` gains bounded retry with jittered exponential backoff on transient failures only (429, 503, network timeouts) — proposed 2 retries. Non-transient failures (bad API key, malformed schema response) fail immediately as they do today. **After retries are exhausted it still returns `tenders: null`**, preserving the Phase 1 invariant exactly; retry changes how hard it tries, never what failure means.

With `CONCURRENCY=4` at most 4 Gemini calls are in flight, which is comfortable on a paid tier. A separate, tighter semaphore for AI calls is the knob to reach for if 429s persist in practice; it is not built preemptively.

## Data flow (contract unchanged)

```
MUNICIPALITIES ──► runPool(concurrency=N)
                     ├─ processSite(muni₀) ─┐
                     ├─ processSite(muni₁) ─┤  each: browser → scrape → diff
                     ├─ processSite(muni₂) ─┤  → AI? → merge → saveRaw
                     └─ … (≤ N in flight)  ─┘  → validate → health → POST
                   └─► results in INPUT order ─► run summary
```

Everything inside `processSite` — the pipeline, the cache records, the per-city POST — is byte-for-byte what runs today. Only the loop around it changes.

## Error Handling

| Situation | Behavior |
|---|---|
| One site throws | Caught by the pool, recorded as `{ ok: false, error }`; other sites unaffected; run continues (parity with today's per-iteration `try/catch`) |
| Site exceeds `SITE_TIMEOUT_MS` | Slot freed, site recorded failed, cache untouched → retried next run; orphaned work closes its own browser |
| Browser fails to launch | Same as any throw — one site fails, run continues |
| Gemini 429/503 | Bounded retry with backoff; on exhaustion `tenders: null` → cache untouched, retry next run |
| Gemini non-transient error | Immediate `tenders: null`, as today |
| Webhook non-200 | Unchanged: cache keeps `pendingDelivery: true`, resent next run with 0 tokens |
| Two workers writing cache | Cannot collide — Phase 2 gives each site its own `cache/<md5-of-url>.json` |
| Worker throws *after* `saveRaw(pending: true)` | Unchanged semantics: extraction is durable, delivery retries next run at 0 tokens |

## Known Limitations

- **Memory caps concurrency, not the pool.** N concurrent Chrome instances is the binding constraint (~150–300MB each). Default 4 is conservative for a small VPS; reaching ~1000 sites in ~1h needs either a bigger box or a shared-browser/context model, which this phase deliberately does not adopt.
- **Timeout does not truly abort.** The slot frees on schedule; the underlying Puppeteer work drains on its own. Precise memory bounding needs abort plumbing through the driver.
- **Speedup is sublinear.** The run cannot finish faster than its slowest single site, and AI rate limits may throttle the tail. Expect a solid fraction of N, not N.
- **Log order is no longer chronological across sites.** Blocks are contiguous per site but a site's block appears at its *completion* time. Timestamps in the block header are the mitigation.
- **No per-domain politeness.** Fine for 14 distinct domains; would need a serialization key if the list ever concentrates on one host.
- **`RUN_STATS` totals are order-independent, but any future stat that depends on site order would silently break.** Keep aggregates commutative.

## Testing

`node:test`, no new dependencies, `npm test` stays **offline and zero-token**.

Unit tests for `runPool` against mock workers:

- Never exceeds `concurrency` in flight (worker records a live counter and its high-water mark).
- Processes every item exactly once; results are in **input** order despite scrambled completion order.
- `concurrency: 1` executes in strict sequence (this is the guarantee behind the escape hatch).
- A throwing worker yields `{ ok: false, error }` and does not abort or reject the pool; siblings still complete.
- Dispatch is slot-based, not batched: with `concurrency: 2` and durations `[long, short, short]`, the third task starts before the first finishes.
- Edge cases: empty list → `[]`; `concurrency` greater than item count; `concurrency` coerced to at least 1.

Unit tests for `withTimeout`: resolves through on time; rejects with a labeled error past the deadline; a late resolution after timeout does not throw unhandled.

Retry tests for `lib/ai.js` with an injected fake client: retries a 429 then succeeds; exhausts retries and returns `tenders: null`; does **not** retry a non-transient error; `usage` still zeroed on failure.

**Live verification (not `npm test`): `scripts/concurrency-check.js`.** The Phase-4 analogue of `scrape-diff` — it runs only the *scrape half* of the pipeline (no Gemini call, no webhook, no cache write) across all sites twice: once at `concurrency: 1`, once at `concurrency: N`. It compares the per-site stable-key sets between the two runs and prints both wall-clock times. Free and safe by construction. A site whose key set changes under concurrency is the exact failure this phase must not ship.

## Success Criteria

1. `runPool` is unit-tested offline with zero browser/network, including the concurrency cap, error isolation, input-order results, and slot-based dispatch.
2. `scripts/concurrency-check.js` shows **matching per-site stable-key sets** at `CONCURRENCY=1` vs `CONCURRENCY=4`, with a clear wall-clock reduction.
3. `CONCURRENCY=1` reproduces today's sequential behavior.
4. One site failing or timing out leaves every other site's result intact.
5. Each site's log output is contiguous and attributable.
6. Every Phase 1–3 invariant still holds: save-before-deliver, `null`-on-AI-failure, RAW merged tenders cached, per-city webhook contract unchanged.
7. `npm test` stays offline and zero-token.

## Roadmap Context

Phase 4 of five. Phases 2 and 3 were sequenced ahead of it precisely because they are its preconditions: per-site cache records mean concurrent workers never contend on a shared file, and a single generic paginator means there is one scrape path to make concurrency-safe rather than fourteen. This phase is the ~13h→~1h runtime win and the last structural change before **Phase 5** (alerting on the Phase 1 health signals), which is what turns a fast, correct run into one nobody has to watch.
