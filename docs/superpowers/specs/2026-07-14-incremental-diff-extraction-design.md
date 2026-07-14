# Incremental Line-Diff Extraction — Design

**Date:** 2026-07-14
**Status:** Approved approach, pending spec review

## תקציר בעברית

במקום לשלוח את כל העמוד ל-Gemini בכל פעם שמשהו השתנה, נשמור בקאש את שורות העמוד ואת המכרזים שכבר חולצו. בכל ריצה נשווה שורות — רק שורות **חדשות** נשלחות ל-AI (עם קצת הקשר מסביב). מכרזים שירדו מהאתר מזוהים בהתאמת טקסט פשוטה — בלי AI בכלל. ה-Webhook ממשיך לקבל את הרשימה המלאה, בדיוק כמו היום.

## Problem

Today `tenders_cache.json` stores one MD5 hash per site. Any change — even one new tender on a page of 40 — sends the entire cleaned page text back to Gemini for full re-extraction. Token cost scales with **page size**, not with **change size**. Tenders removed from a site also trigger a full re-extraction.

## Goals

1. Token spend proportional to what actually changed on the page.
2. Tender removals handled with **zero** AI tokens.
3. Webhook contract unchanged: the Lovable endpoint keeps receiving the full current tender list per city, same payload shape (`{ tenders: [...] }`), same headers. (Webhook semantics on the Lovable side are unknown, so they must not need to change.)
4. Graceful fallback to today's full-page extraction whenever the diff looks unreliable.
5. A successful AI extraction is never paid for twice — including when the webhook delivery fails afterward.

## Non-Goals

- No changes to the per-city scrapers (`scrapers/*.js`).
- No changes to the Lovable/webhook side.
- No change of AI model or prompt strategy (model swap can be a separate, later decision).
- No detection of digit-only changes (e.g., a deadline date edited with no text change). Today's number-stripped hashing is already blind to these — this design keeps parity. Documented as a known limitation below.

## Architecture

### New cache schema

`tenders_cache.json` changes from `url → md5-string` to `url → object`:

```json
{
  "https://…": {
    "version": 2,
    "stableKeys": ["<stable key 1>", "<stable key 2>"],
    "tenders": [
      { "title": "…", "tender_number": "47/2026", "deadline_date": "15/08/2026",
        "publisher": "עיריית חיפה", "source_url": "https://…" }
    ],
    "pendingDelivery": false,
    "updatedAt": "2026-07-14T17:30:00.000Z"
  }
}
```

**Migration:** on load, a value that is a plain string (legacy md5) is treated as "no incremental data" — that site takes the full-extraction path once, then is saved in the new format. No manual migration step.

### Module layout

`main.js` currently holds all logic (~250 lines) and would grow further. Split the pure logic into small modules, each independently testable:

- `lib/text.js` — `superCleanText(text)` (moved as-is) and `stableKey(line)`: the exact transformation used today for hashing (strip digits, keep only Hebrew/Latin/spaces, drop noise words, require ≥ 4 words — otherwise returns `null`, meaning "noise line, not diffable"). Exposes `buildEntries(cleanedText)` → `[{ line, key }]` where `line` is the original cleaned line (digits intact) and `key` is its stable key or `null`.
- `lib/cache.js` — `load()`, `save()`, legacy-format migration.
- `lib/diff.js` — `diff(cachedKeys, entries)` → `{ addedKeys, removedKeys }`; `buildChunks(entries, addedKeys, window = 3)` → array of text chunks (see below).
- `lib/merge.js` — removal matching, upsert, and the tender-number normalization/dedup logic (moved out of `main.js`).
- `main.js` — orchestration only: launch browser, call scraper, clean, diff, decide AI-vs-skip, merge, deliver, save cache.

### Data flow per site

```
scrape → superCleanText → buildEntries (line + stableKey pairs)
  → diff against cache.stableKeys
      ├─ no diff, no pendingDelivery  → skip (0 tokens, no webhook)
      ├─ no diff, pendingDelivery     → resend cached tenders (0 tokens)
      ├─ diff too large / no cache    → FULL PATH: whole cleaned text → AI (today's behavior)
      └─ small diff                   → INCREMENTAL PATH:
            addedKeys → buildChunks → AI on chunks only
              (no addedKeys → AI skipped entirely; a removals-only diff costs 0 tokens)
            removedKeys → drop cached tenders no longer present on page (string match, 0 tokens)
            merge: kept cached tenders + upserted new tenders
  → if merged list non-empty → POST full list to webhook (unchanged contract)
  → on success (or verified-healthy empty page) → save { stableKeys, tenders, pendingDelivery:false }
```

### Diffing

- `addedKeys` = stable keys present now but not in cache; `removedKeys` = the reverse.
- Duplicate stable keys collapse into a set — same as today's `Set`-based dedup.
- **Fallback threshold:** if there is no valid cache entry, or `(added + removed) > 50%` of `max(cachedKeyCount, newKeyCount)`, run the full path. This covers first runs, site redesigns, cache corruption, and scraper output anomalies.

### Context chunks for the AI

A tender row in `innerText` can span several lines (title / number / date). To make sure Gemini sees complete rows:

- For each entry whose key is in `addedKeys`, take a window of ±3 lines around it in the **cleaned-lines array** (original text, digits intact — noise lines included, they're cheap and provide context).
- Merge overlapping/adjacent windows into contiguous chunks.
- Join chunks with a `\n---\n` separator and send with the existing extraction prompt (unchanged), plus one added sentence telling the model these are excerpts from the page, not the whole page.

### Removal matching (zero tokens)

A cached tender is **kept** if either check finds it in the current cleaned page text:

1. **Number match** (when `tender_number ≠ "אין"`): strip any `-2`/`-3` dedup suffix, split into `N` and year; match the regex `N\s*[/.]\s*(YYYY|YY)` against the page text (so `47/2026`, `47.26`, `47 / 26` all count).
2. **Title match:** normalize both title and page text (strip digits and punctuation, collapse whitespace), then check whether the first ~30 characters of the normalized title appear in the normalized page text.

A tender is dropped only when **both** checks fail. Tenders with `tender_number = "אין"` rely on the title check alone.

### Merge & upsert

- Upsert key: `tender_number` when it isn't `"אין"`, otherwise the normalized title. A newly extracted tender replaces a cached one with the same key — this is how deadline extensions and title fixes propagate.
- The existing number-fixing logic (extract `N/YY` from title, expand 2-digit years, `-2` suffix on collisions) applies to newly extracted tenders; the `usedNumbers` set is seeded with the kept cached tenders' numbers so suffixes stay collision-free across the merged list.

### Delivery & the pendingDelivery flag

- After a successful AI extraction and merge, save the cache entry (`stableKeys`, merged `tenders`) with `pendingDelivery: true` **before** POSTing to the webhook. On HTTP 200, flip it to `false`.
- Next run, if content is unchanged but `pendingDelivery` is `true`, resend the cached tenders without any AI call. This fixes today's behavior where a webhook failure forces a paid re-extraction.
- Empty merged list: no webhook call (parity with today — an empty list has never been sent); cache still updates when the page is verified healthy (cleaned text > 1500 chars, today's rule).
- AI failure (`processWithAI` returns `null`): cache untouched, retry next run — unchanged from today.

## Error Handling

| Situation | Behavior |
|---|---|
| Legacy cache format / missing entry | Full extraction path, then save v2 format |
| Diff > 50% of lines | Full extraction path (safety valve) |
| Gemini error / unparseable JSON | Skip site, cache untouched, retry next run (as today) |
| Webhook non-200 or network error | Cache saved with `pendingDelivery: true`; free resend next run |
| Scraper returns too little content | Skip site, cache untouched (as today) |

## Known Limitations

- **Digit-only changes are invisible.** A deadline changed from 15/08 to 30/08 with no other text change produces identical stable keys, so no re-extraction happens. This is exactly today's behavior (hashing strips digits to avoid clock/counter noise) — accepted trade-off, unchanged.
- Two tenders whose rows produce identical stable keys collapse into one diff entry (same as today's `Set` hashing).

## Testing

Unit tests with Node's built-in `node:test` runner (no new dependencies), covering the pure functions:

- `stableKey`: noise lines → `null`; digit changes → same key; Hebrew word filtering.
- `diff`: added / removed / unchanged sets; legacy cache handling.
- `buildChunks`: window merging, page boundaries, adjacent additions become one chunk.
- Removal matching: number formats (`47/26`, `47.2026`), suffix stripping, title fallback, both-fail → drop.
- Merge: upsert by number, upsert by title when number is `"אין"`, `usedNumbers` seeding.
- Cache migration: legacy string value → full path + v2 save.

Manual verification: run twice back-to-back — second run must show all sites skipped with 0 AI calls. Then remove one line from a cached `stableKeys` entry and confirm the next run sends only a small chunk (visible in the existing token-usage logs).

## Success Criteria

1. Second consecutive run with no site changes: **0 AI calls** (already true today — must not regress).
2. One new tender on an otherwise unchanged page: AI input tokens for that site drop by roughly 90% versus a full-page extraction (verifiable in the existing `RUN_STATS` log line).
3. A removed tender disappears from the webhook payload with **0 AI calls** for that site.
4. Webhook payload shape and headers byte-identical in structure to today's.
