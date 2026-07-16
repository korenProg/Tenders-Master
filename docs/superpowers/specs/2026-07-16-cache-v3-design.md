# Cache v3 — Per-Site Storage & Digit-Aware Diffing — Design

**Date:** 2026-07-16
**Status:** Approved approach, pending spec review
**Phase:** 2 of 5 on the road to ~1000 sites (follows the reliability foundation)

## תקציר בעברית

שלב 2 מכין את הקאש ל-1000 אתרים. שלושה שינויים כרוכים זה בזה: (1) כל אתר נשמר בקובץ נפרד במקום קובץ ענק אחד שנכתב מחדש פעמיים לכל אתר — כדי שכתיבה תהיה זולה בקנה מידה גדול; (2) שכבת אחסון מתחלפת מאחורי ממשק אחיד, כך שהחלטת הפריסה (שרת/ענן/DB) נשארת שינוי מקומי; (3) hash שמכיר ספרות, כדי לתקן את החור בו שינוי מועד הגשה מ-15/08 ל-30/08 בלי שינוי טקסט אחר לא גורם היום לחילוץ מחדש. ההגירה מ-v2 מתבצעת עכשיו כשיש 14 אתרים בלבד — כל אתר מחלץ פעם אחת מחדש, ~2 אגורות, פעם אחת.

## Problem

Three limitations block scaling the cache from 14 sites to ~1000:

1. **O(n²) writes.** `saveCache` ([lib/cache.js:12-14](../../../lib/cache.js#L12)) rewrites the entire `tenders_cache.json` on every call, and `main.js` calls it twice per changed site (save-before-deliver, then flip `pendingDelivery`). If *k* of *n* sites change, that is O(k·n) bytes written per run — quadratic in the worst case. At 1000 sites the file is ~8 MB and each changed site rewrites all of it.

2. **Storage is welded to a local JSON file.** The deployment target (VPS, serverless, managed DB) is undecided. Today the cache format is hard-coded into `loadCache`/`saveCache`, so changing where state lives means editing pipeline code.

3. **Digit-only changes are invisible — an accuracy hole.** `stableKey` strips digits ([lib/text.js:41-46](../../../lib/text.js#L41)), so a deadline edited from `15/08/2026` to `30/08/2026` with no other text change produces an identical key. The diff sees nothing, no re-extraction runs, and the webhook serves the stale date indefinitely. This was an accepted trade in Phase 1 (`docs/.../2026-07-14-incremental-diff-extraction-design.md`), deferred here on purpose.

## Goals

1. Writing one site's cache record is O(1) in the number of sites — one small write, not a whole-store rewrite.
2. A pluggable storage interface: the file-backed implementation is swappable for S3/DB later without touching pipeline logic.
3. A deadline (or any digit) change on a real content line triggers a re-extraction of just that region.
4. Preserve every Phase 1 invariant: save-before-deliver durability, `null`-on-AI-failure, cache stores RAW merged tenders, webhook contract unchanged.
5. Migrate the existing 14 v2 entries with no manual step.

## Non-Goals

- **Concurrency / worker pool** — Phase 4. This phase only makes per-site records *possible*; it does not run sites in parallel.
- **Config-driven paginator** — Phase 3.
- **Orphaned-file cleanup** — when a site leaves the list its `cache/<hash>.json` lingers. Deferred as YAGNI until sites actually churn.
- **A remote storage backend** — only the *interface* plus the file-backed implementation ship now.
- **Date-specific change detection** — whole-line hashing is used, not date-pattern matching (see Design).
- No scraper changes, no webhook-contract change.

## Architecture

### New v3 cache schema (per site)

```json
{
  "url": "https://…",
  "version": 3,
  "keyHashes": { "<stable key>": "<content hash>" },
  "tenders": [ { "title": "…", "tender_number": "47/2026", "deadline_date": "15/08/2026", "publisher": "…", "source_url": "…" } ],
  "pendingDelivery": false,
  "updatedAt": "2026-07-16T10:00:00.000Z"
}
```

`stableKeys: string[]` becomes **`keyHashes: { [stableKey]: contentHash }`**. The map's *keys* are the same digit-stripped stable keys used today for structural add/remove diffing. Each *value* is a hash of the digit-**inclusive** line(s) that map to that key — the signal that a number changed under an otherwise-identical line.

`url` is stored inside the record for debuggability and hash→url reverse lookup (filenames are URL hashes and are not human-readable).

### Module layout

Persistence is split from schema, and both are split from diff logic:

- **`lib/storage.js`** *(new, the one impure lib module besides `ai.js`)* — the swappable persistence layer:
  - `loadRaw(url) → object | null` — reads `cache/<md5(url)>.json`, returns the parsed object or `null` if absent/unreadable.
  - `saveRaw(url, obj) → void` — writes `cache/<md5(url)>.json` with `{ url, ...obj }`. Creates `cache/` if needed.
  - The file-backed body is the only part a future S3/Postgres backend replaces; the two-function contract stays.
- **`lib/cache.js`** *(reworked)* — schema only, no file I/O:
  - `makeSiteEntry(keyHashes, tenders, pendingDelivery) → v3 object`.
  - `getSiteEntry(raw) → entry | null` — validates `version === 3`, `keyHashes` is a plain object, `tenders` is an array; anything else (v2, legacy md5, malformed, `null`) returns `null`. **Signature changes** from `getSiteEntry(cache, url)` to `getSiteEntry(raw)` because storage now hands back one site's raw object.
  - `loadCache`/`saveCache` (whole-file) are **removed**.
- **`lib/text.js`** *(extended)* — `buildKeyHashes(entries) → { [key]: hash }`: for each distinct stable key, hash the sorted digit-inclusive lines that produced it (sorted so collision order is stable). Uses Node's built-in `crypto` (stdlib, not a dependency). `stableKey`/`buildEntries` unchanged.
- **`lib/diff.js`** *(extended)* — `diff` gains `changedKeys`; `isDiffTooLarge` counts them.
- **`main.js`** — per-site load/save instead of one in-memory `cache` object; incremental path triggered by `addedKeys ∪ changedKeys`.

### Digit-aware diffing

`diff(cachedKeyHashes, entries)` now returns `{ addedKeys, removedKeys, changedKeys, newKeyHashes }`:

- `addedKeys` — keys present now, absent in cache (structural addition).
- `removedKeys` — keys present in cache, absent now (structural removal).
- **`changedKeys`** — keys present in *both* whose content hash differs: same line, a digit moved. **This is the fix.**
- `newKeyHashes` — the freshly built map, stored on save.

Re-extraction chunks are built around `addedKeys ∪ changedKeys` (existing `buildChunks`, unchanged — it already takes a key list). `isDiffTooLarge(addedKeys, removedKeys, changedKeys, cachedCount, newCount)` adds `changedKeys.length` to the numerator, so a site-wide date bump (every line's date changed) correctly exceeds 50% and falls back to full extraction.

**Scoping — why whole-line hashing is safe.** Digit-stripping originally existed to stop counters and clocks forcing false diffs. Content hashing is scoped to lines that *already have a stable key* (≥ 4 meaningful words after `NOISE_WORDS` filtering, which already removes date/time words). A `views: 1234` or `updated 5 minutes ago` line has too few meaningful words → `key === null` → never hashed → never a `changedKey`. The residual risk: a genuine content line with an embedded changing timestamp would re-extract every run. That is one small incremental AI call for one site — pennies — and Phase 1 established token cost is trivial while accuracy is the goal. Whole-line hashing is chosen over date-pattern matching (which is more complex and would miss a changed `tender_number`); catching every change for a few cents is the right trade.

### Data flow per site

```
loadRaw(url) → getSiteEntry → raw v3 entry or null
scrape → superCleanText → buildEntries → diff(cachedKeyHashes, entries)
    → { addedKeys, removedKeys, changedKeys, newKeyHashes }
  ├─ null entry OR isDiffTooLarge     → FULL: whole page → AI
  ├─ added+changed = 0, removed = 0   → skip / pendingDelivery resend (0 tokens)
  ├─ removed only                     → no AI call (0 tokens)
  └─ added or changed                 → INCREMENTAL: chunks around addedKeys ∪ changedKeys → AI
→ mergeTenders (RAW) → saveRaw(url, makeSiteEntry(newKeyHashes, merged, true))
→ validate → POST → on 200 saveRaw(…, pendingDelivery:false)
```

The "nothing changed" skip now also requires `changedKeys.length === 0` — otherwise a deadline-only change would hit the skip path and never re-extract. This single condition is the heart of the accuracy fix.

### Migration v2 → v3

**No migration step, by design.** `getSiteEntry` returns `null` for any non-v3 record, and `loadRaw` returns `null` for a site with no `cache/<hash>.json` yet — both route the site down full-extraction-then-save-v3, exactly like today's legacy-md5 handling.

Content hashes *cannot* be retrofitted onto v2 entries: v2 stored only digit-stripped `stableKeys`, never the digit-inclusive lines. Re-extracting once is the only way to establish a correct v3 baseline — so discard-and-re-extract is the correct choice, not merely the simple one. Cost: all 14 sites do one cold extraction (~65,784 tokens ≈ 2¢) on the first v3 run. **This is the entire reason Phase 2 runs now:** the same migration at 1000 sites is ~$1–2 and slower, though still one-time.

The old `tenders_cache.json` becomes dead state (the code no longer reads it) and can be deleted; all 14 current entries are `pendingDelivery: false`, so nothing in flight is lost. `cache/` is added to `.gitignore`.

## Error Handling

| Situation | Behavior |
|---|---|
| No `cache/<hash>.json` for a site (fresh / migration) | `loadRaw` → `null` → full extraction path, then save v3 |
| v2 / legacy / malformed record | `getSiteEntry` → `null` → full path, then save v3 |
| Unreadable or corrupt cache file | `loadRaw` catches, returns `null` → full path (parity with today's corrupt-cache handling) |
| Diff > 50% of keys (incl. `changedKeys`) | Full extraction (safety valve) |
| Gemini error | `null` → cache untouched, retry next run (unchanged) |
| Webhook non-200 | Record saved `pendingDelivery: true`, free resend next run (unchanged) |

## Known Limitations

- **One-time re-extraction on migration** — all sites re-extract once when they first run under v3. Expected, cheap now, one-time.
- **Residual false diff** — a content line carrying an embedded changing timestamp re-extracts every run (pennies; accepted).
- **Orphaned files** — a removed site leaves a stale `cache/<hash>.json`. Out of scope this phase.
- **Identical-text collapse persists** — two lines with identical digit-inclusive text still map to one key with one hash (same as today's set-based dedup).

## Testing

`node:test`, no new dependencies. `npm test` stays **offline and zero-token**.

- `text.js` — `buildKeyHashes`: two lines sharing a key but differing in digits produce a hash that changes when one line's digits change; noise lines (`key === null`) are excluded; identical input is stable across calls.
- `diff.js` — `changedKeys` detects a same-key hash change; `addedKeys`/`removedKeys` unchanged; a deadline-only edit yields `changedKeys=[k]`, `addedKeys=[]`, `removedKeys=[]`; `isDiffTooLarge` counts `changedKeys`.
- `cache.js` — `makeSiteEntry` emits `version:3` with `keyHashes`; `getSiteEntry` accepts v3, rejects v2/legacy-string/malformed/`null`.
- `storage.js` — `saveRaw` then `loadRaw` round-trips in a **temp dir** (never the real `cache/`); missing file → `null`; corrupt file → `null`.

## Success Criteria

1. **The accuracy fix:** a line changing only its deadline digits (`15/08/2026` → `30/08/2026`) produces a non-empty `changedKeys` and triggers a re-extraction — where today it triggers none. Provable in a `diff` unit test.
2. Saving one site writes exactly one small file; no whole-store rewrite exists in the code.
3. Second consecutive run with no changes: **0 AI calls** (Phase 1 behavior must not regress).
4. A v2 / legacy record routes to full extraction once, then persists as v3.
5. `npm test` runs offline with zero tokens and zero network.
6. Webhook payload shape and headers unchanged.

## Roadmap Context

Phase 2 of five. Sequenced now because the v2→v3 migration re-extracts every site once — 2¢ at 14 sites, ~$1–2 at 1000. It is the foundation the later phases require: **Phase 3** config-driven paginator (parallel workers and a single rewritten JSON file are incompatible; per-site records unblock it), **Phase 4** concurrency, **Phase 5** alerting on the health signals from Phase 1.
