# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js scraper that visits 14 Israeli municipality tender ("מכרזים") websites with Puppeteer, extracts structured tender data with Gemini, and POSTs the full per-city tender list to a Lovable webhook. No build step, no framework, CommonJS.

## Commands

```bash
npm test                                          # all tests (node:test, no deps)
node --test test/diff.test.js                     # one file
node --test --test-name-pattern="buildChunks"     # one test by name
node main.js                                      # full production run
```

`node main.js` is **not** a safe way to check your work. It drives 14 live municipality sites (~4s pause between each), spends real Gemini tokens, and POSTs to the production webhook. Prefer the unit tests; they cover every pure function. When an E2E run is genuinely needed, trim `MUNICIPALITIES` in [main.js](main.js) to one entry first.

Requires `.env` (gitignored) with `GEMINI_API_KEY`, `WEBHOOK_URL`, `ELIYAHO_WEBHOOK_KEY`.

## The cost model drives the architecture

Nearly every non-obvious decision in this codebase descends from one constraint: **a successful AI extraction must never be paid for twice, and token spend must scale with what changed on the page, not with page size.** Before changing pipeline logic, check your change against that.

Per site, [main.js](main.js) runs:

```
scrape → superCleanText → buildEntries → diff vs cache.stableKeys
   ├─ no diff, no pendingDelivery → skip entirely       (0 tokens)
   ├─ no diff, pendingDelivery    → resend cached list  (0 tokens)
   ├─ no cache / diff > 50%       → FULL: whole page → AI
   ├─ removals only               → no AI call at all   (0 tokens)
   └─ additions                   → INCREMENTAL: only ±3-line excerpts → AI
→ mergeTenders (kept cached + upserted new) → save cache → POST full list
```

The four `lib/` modules are pure and independently tested; `main.js` is orchestration only (browser, network, AI, webhook). Keep it that way — logic added to `main.js` is logic that can't be tested without a live run.

- [lib/text.js](lib/text.js) — `superCleanText` (junk-line filtering) and `stableKey`, the per-line identity used for diffing.
- [lib/diff.js](lib/diff.js) — line diffing, the 50% safety valve, and `buildChunks` (±3-line context windows around added lines, overlapping windows merged).
- [lib/merge.js](lib/merge.js) — zero-token removal matching, upsert, tender-number normalization/dedup.
- [lib/cache.js](lib/cache.js) — `tenders_cache.json` load/save and v2 schema validation.

## Invariants that are easy to break

**Cache is saved *before* webhook delivery**, with `pendingDelivery: true`, flipped to `false` on HTTP 200 ([main.js:173-185](main.js#L173-L185)). This is what makes a webhook failure cost 0 tokens instead of a re-extraction. Don't reorder it into the "obvious" deliver-then-save.

**AI failure returns `null`, not `[]`** ([main.js:73-76](main.js#L73-L76)). `null` means "leave the cache alone and retry next run"; `[]` legitimately means "healthy page, zero open tenders" and *does* update the cache. Collapsing the two silently wipes cached tenders on a transient Gemini error.

**`stableKey` strips digits, so digit-only changes are invisible** ([lib/text.js:41-46](lib/text.js#L41-L46)) — a deadline edited from 15/08 to 30/08 with no other text change triggers no re-extraction. This is a documented, accepted trade-off (it keeps date/counter noise from forcing false diffs), not a bug to fix. `stableKey` returning `null` means "noise line, not diffable" — such lines are excluded from diffing but still included in AI excerpts as context.

**Removal matching prefers false-keep over false-drop** ([lib/merge.js:17-31](lib/merge.js#L17-L31)). A cached tender is dropped only when *both* the number match and the title match fail.

**Upsert compares only against cached tenders** (`idx < keptCount` in [lib/merge.js:62](lib/merge.js#L62)). Two *newly* extracted tenders sharing a number must get `-2`/`-3` suffixes rather than overwriting each other.

**Write Hebrew unicode ranges as escape sequences** (`\u0590-\u05FF`), never as literal characters in a regex character class. Literal Hebrew chars in a range are an RTL-rendering trap that was already fixed once (commit 5f391aa).

## Scraper contract

`scrapers/*.js` each export `async scrape(page)` taking a live Puppeteer page (already navigated) and returning `string | string[]` of `document.body.innerText` — one string per paginated page. `main.js` joins multi-page results with `--- PAGE n ---` markers.

The 14 scrapers are near-identical copy-paste variants (pagination click, ±4-6s waits, `maxPages = 5`, identical-text and <500-char guards). Comments are Hebrew in some, English in others; match the file you're editing. Per the design spec, scrapers are explicitly out of scope for pipeline changes — a site whose extraction misbehaves is usually a `lib/` problem, not a scraper problem.

## Cache

`tenders_cache.json` is gitignored but is real local state: `url → { version: 2, stableKeys, tenders, pendingDelivery, updatedAt }`. Any entry that isn't a valid v2 object (missing, legacy md5 string, malformed) makes `getSiteEntry` return `null`, which routes that site down the full-extraction path once, then saves v2 — that's the migration, there's no separate step. **Deleting this file forces maximum-cost full extraction across all 14 sites.**

## Design docs

[docs/superpowers/specs/2026-07-14-incremental-diff-extraction-design.md](docs/superpowers/specs/2026-07-14-incremental-diff-extraction-design.md) is the authoritative rationale for the pipeline, including goals, non-goals, and known limitations. Read it before altering diff, merge, or cache semantics. The webhook contract (`{ tenders: [...] }`, `x-webhook-key` header, full list per city) is fixed — the Lovable side is unknown and must not need to change.
