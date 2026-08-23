# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js scraper that visits 14 Israeli municipality tender ("מכרזים") websites with Puppeteer, extracts structured tender data with Gemini, validates it, and POSTs the full per-city tender list to a Lovable webhook. No build step, no framework, CommonJS.

## Commands

```bash
npm test                                          # all tests (node:test, no deps)
node --test test/diff.test.js                     # one file
node --test --test-name-pattern="buildChunks"     # one test by name
npm run accuracy                                  # ground-truth harness against test/fixtures
node scripts/scrape-diff.js <site-key>            # live, free: old scraper vs generic paginator
node scripts/concurrency-check.js [N]             # live, free: stable-key sets at concurrency 1 vs N
CONCURRENCY=1 node main.js                        # sequential escape hatch (pre-phase-4 behavior)
node main.js                                      # full production run
```

`node main.js` is **not** a safe way to check your work. It runs 14 live municipality sites through the worker pool (CONCURRENCY at a time), spends real Gemini tokens, and POSTs to the production webhook. Prefer the unit tests; they cover every pure function. When an E2E run is genuinely needed, trim `MUNICIPALITIES` in [lib/sites.js](lib/sites.js) to one entry first.

`HEADFUL=1 node main.js` opens a visible browser window — for demos and debugging.

Requires `.env` (gitignored) with `GEMINI_API_KEY`, `WEBHOOK_URL`, `ELIYAHO_WEBHOOK_KEY`.
Optional env: `CONCURRENCY` (sites in flight, default 4), `SITE_TIMEOUT_MS` (per-site ceiling, default 300000; `0` disables), `HEADFUL=1` (visible browser).

## The cost model drives the architecture

Nearly every non-obvious decision in this codebase descends from one constraint: **a successful AI extraction must never be paid for twice, and token spend must scale with what changed on the page, not with page size.** Before changing pipeline logic, check your change against that.

`main.js` runs sites through a bounded pool (`CONCURRENCY`, default 4), each site end-to-end and independent. Per site:

```
scrape → superCleanText → buildEntries → diff vs cache.keyHashes
   ├─ no diff, no pendingDelivery → skip entirely       (0 tokens)
   ├─ no diff, pendingDelivery    → resend cached list  (0 tokens)
   ├─ no cache / diff > 50%       → FULL: whole page → AI
   ├─ removals only               → no AI call at all   (0 tokens)
   └─ additions / changes         → INCREMENTAL: only ±3-line excerpts → AI
→ mergeTenders (kept cached + upserted new) → save cache → validate → assess health → POST
```

Note the ordering at the tail: the cache is saved with the **raw merged** list, then validation and health assessment run, then delivery. See the invariants below — both halves of that ordering are load-bearing.

The `lib/` modules are pure and independently tested, except `ai.js` (Gemini) and `storage.js` (disk); `main.js` is orchestration only (browser, network, webhook). Keep it that way — logic added to `main.js` is logic that can't be tested without a live run.

| Module | Responsibility |
|---|---|
| [lib/text.js](lib/text.js) | `superCleanText` junk-line filtering, `stableKey` per-line identity, `buildKeyHashes` digit-aware content hashing |
| [lib/diff.js](lib/diff.js) | added/removed/**changed** key diffing, the 50% safety valve, `buildChunks` (±3-line context windows, overlapping windows merged) |
| [lib/merge.js](lib/merge.js) | zero-token removal matching, upsert, tender-number normalization/dedup, `numberOnPage`/`titleOnPage` |
| [lib/cache.js](lib/cache.js) | v3 record **schema** only — `makeSiteEntry` / `getSiteEntry` validation |
| [lib/storage.js](lib/storage.js) | v3 **persistence** — per-site `loadRaw`/`saveRaw`, swappable for S3/DB |
| [lib/sites.js](lib/sites.js) | the `MUNICIPALITIES` rows; importable without running `main.js` |
| [lib/paginator.js](lib/paginator.js) | pure `paginate` loop (mock-driver tested) + `makePuppeteerDriver` browser adapter + `DEFAULTS` |
| [lib/pool.js](lib/pool.js) | pure `runPool` (slot-based dispatch, concurrency cap, per-item error capture, input-order results) + `withTimeout` |
| [lib/validate.js](lib/validate.js) | zero-token delivery-time validation: drop hallucinations, degrade bad numbers/dates to `אין` |
| [lib/health.js](lib/health.js) | per-site health signals (`COUNT_COLLAPSE`, `ZERO_FROM_HEALTHY_PAGE`, `ALL_DEGRADED`) → ok/warn/alert |
| [lib/ai.js](lib/ai.js) | Gemini `gemini-2.5-flash` with a constrained response schema; returns `{ tenders, usage }` |

`scripts/`: [scrape-diff.js](scripts/scrape-diff.js) (live migration gate, zero tokens, no webhook), [accuracy.js](scripts/accuracy.js) (ground-truth harness), [capture-fixture.js](scripts/capture-fixture.js).

## Invariants that are easy to break

**Cache is saved *before* webhook delivery**, with `pendingDelivery: true`, flipped to `false` on HTTP 200 ([main.js:203-213](main.js#L203-L213)). This is what makes a webhook failure cost 0 tokens instead of a re-extraction. Don't reorder it into the "obvious" deliver-then-save.

**The cache stores the RAW merged list, never the validated `kept` list** ([main.js:204-206](main.js#L204-L206)). Validation degrades a bad tender number to `אין`, which would flip that tender's upsert key from `num:` to `title:` and duplicate it on the next run. Validation is a delivery-time filter, not a cache-time one.

**AI failure returns `null`, not `[]`** ([main.js:71-73](main.js#L71-L73)). `null` means "leave the cache alone and retry next run"; `[]` legitimately means "healthy page, zero open tenders" and *does* update the cache. Collapsing the two silently wipes cached tenders on a transient Gemini error.

**`stableKey` strips digits, but digit-only changes are still caught** ([lib/text.js:43-71](lib/text.js#L43-L71)). The key ignores digits so date/counter noise doesn't force false diffs; `buildKeyHashes` then md5s the digit-*inclusive* lines under each key, so a deadline edited from 15/08 to 30/08 surfaces as a `changedKey` and re-extracts. Two mechanisms, deliberately: don't "simplify" by putting digits back into `stableKey`. (This was a real v2 limitation, fixed by cache v3 — older docs describing it as an accepted trade-off are out of date.)

**`stableKey` returning `null` means "noise line, not diffable"** — such lines are excluded from diffing and hashing but still included in AI excerpts as context.

**Removal matching prefers false-keep over false-drop** ([lib/merge.js:47-52](lib/merge.js#L47-L52)). A cached tender is dropped only when *both* the number match and the title match fail.

**Upsert compares only against cached tenders** (`idx < keptCount` in [lib/merge.js:101](lib/merge.js#L101)). Two *newly* extracted tenders sharing a number must get `-2`/`-3` suffixes rather than overwriting each other.

**Write Hebrew unicode ranges as escape sequences** (`\u0590-\u05FF`), never as literal characters in a regex character class. Literal Hebrew chars in a range are an RTL-rendering trap that was already fixed once (commit 5f391aa). Hebrew in plain string literals (`'הבא'`) is fine and used throughout.

**A per-site timeout frees the pool slot, it does not abort the work** ([lib/pool.js](lib/pool.js)). The orphaned `processSite` drains on its own and closes its browser in `finally`; the Chrome process can outlive the deadline by seconds, and a timed-out site's log block flushes late. That's accepted, not overlooked — true cancellation would mean threading an `AbortSignal` through the driver, the paginate loop, and both custom scrapers.

**`lib/ai.js` must stay log-free** and `processSite` must never call `console` directly. Both write into the per-site buffer that `makeSiteLog` flushes as one block; a stray `console.log` reappears interleaved between other sites' output. `test/ai.test.js` guards the `lib/ai.js` half of this.

**Retry never changes what failure means.** `extractTenders` retries transient failures (429/503/network) twice with jittered backoff, then still returns `tenders: null`.

## Scraping: config-driven, with an escape hatch

Sites are scraped one of two ways, dispatched per `MUNICIPALITIES` row in [main.js:137-139](main.js#L137-L139):

- **Generic (12 sites)** — no `script` field. [lib/paginator.js](lib/paginator.js) drives it, tuned by an optional `pagination` object on the row (`iframes`, `networkIdle`, `maxPages`, `settleMs`, `waitMs`, `nextTokens`). Adding a site is one row, no new file.
- **Custom (2 sites)** — a `script` field pointing at `scrapers/*.js`. **`script` always wins the dispatch.** Only [scrapers/herzliya.js](scrapers/herzliya.js) and [scrapers/modiin.js](scrapers/modiin.js) remain; both diverged under `scrape-diff` and are deliberate escape hatches, not leftovers.

A scraper module exports `async scrape(page)` taking a live Puppeteer page (already navigated) and returning `string | string[]` of `document.body.innerText` — one string per paginated page. `main.js` joins multi-page results with `--- PAGE n ---` markers; the generic paginator returns the same shape.

Before deleting a custom scraper, prove equivalence with `node scripts/scrape-diff.js <key>` — it scrapes the live site both ways and compares stable-key sets. Free: zero Gemini calls, no webhook. On DIVERGE, keep the custom file; **do not tweak the driver to chase one site.**

## Cache

`cache/` is gitignored but is real local state: one `<md5-of-url>.json` per site, `{ url, version: 3, keyHashes, tenders, pendingDelivery, updatedAt }`. Any record that isn't a valid v3 object (missing, legacy v2, malformed) makes `getSiteEntry` return `null`, which routes that site down the full-extraction path once, then saves v3 — that's the migration, there's no separate step. The old single-file `tenders_cache.json` is dead; it is still gitignored only so stale copies don't get committed.

**Deleting this directory forces maximum-cost full extraction across all 14 sites.**

## Design docs

`docs/superpowers/specs/` holds the authoritative rationale, one spec per phase, each with goals, non-goals, and known limitations. Read the relevant one before altering pipeline semantics; `docs/superpowers/plans/` holds the matching task-by-task implementation plans.

The roadmap is five phases: **1** reliability foundation (validate/health/accuracy) ✅, **2** cache v3 ✅, **3** config-driven paginator ✅, **4** concurrency ✅, **5** alerting on health signals.

The webhook contract (`{ tenders: [...] }`, `x-webhook-key` header, full list per city) is fixed — the Lovable side is unknown and must not need to change.
