# Config-Driven Paginator — Design

**Date:** 2026-07-16
**Status:** Approved approach, pending spec review
**Phase:** 3 of 5 on the road to ~1000 sites (follows cache v3)

## תקציר בעברית

14 קבצי סקרייפר כמעט זהים (8 מתוכם זהים לחלוטין) לא ישרדו מעבר ל-1000 אתרים. הם בכלל לא מחלצים כלום — הם רק מדפדפים: ממתין, גולל, קורא `body.innerText`, לוחץ "הבא", חוזר. נחליף אותם ב-paginator גנרי אחד עם קונפיג דק (רוב האתרים = שורה ריקה, רק 3 צריכים סריקת iframe). מעבר בטוח: אתר-אתר, כל אחד מאומת בכלי `scrape-diff` חינמי (בלי טוקנים, בלי webhook) שמשווה מפתחות יציבים בין הסקרייפר הישן לחדש. אתר שלא ניתן לשחזר שומר על הקובץ הישן (escape hatch).

## Problem

`scrapers/*.js` holds 14 near-identical files. Measured 2026-07-16: **8 are byte-identical** after normalization, there are only 7 distinct structural shapes, mean pairwise similarity is 79%, and the genuine differences reduce to two functional knobs (iframe scanning: 3 sites; a network-idle settle: 1 site) plus non-load-bearing copy-paste drift (scroll pixels 800/1200/1500, waits 2000–6000ms). None of the files extract anything — they are **paginators**: settle, scroll, read `body.innerText`, click "next", repeat, with `maxPages = 5` everywhere.

Adding a site means copy-pasting a ~80-line file and tweaking it. At 1000 sites that is 1000 files and a fix to the shared pagination logic must be applied 8+ times. This does not scale.

## Goals

1. One generic paginator; adding a site becomes a **config row**, usually empty, not a new file.
2. Reproduce the current 14 sites' *results* (same tenders survive), verified without a production run.
3. Migrate incrementally and reversibly — never break a working site; keep its old file until the new path is proven equivalent.
4. Preserve the scraper contract exactly: `main.js` still receives `string | string[]` of page texts and joins multi-page with `--- PAGE n ---`.
5. Give the pagination logic its **first unit-test coverage** (today: zero).

## Non-Goals

- **Concurrency** — Phase 4. This phase does not run sites in parallel.
- **Changing extraction, prompt, or model** — untouched.
- **Byte-identical reproduction** of each scraper's scroll/wait timing. The timings exist to let content load; the paginator uses one robust behavior and verifies *content equivalence*, not timing equivalence.
- **Forcing every site onto the generic path** — a site the paginator can't reproduce keeps its custom file (escape hatch).
- No change to `lib/` pipeline modules, cache, or webhook.

## Architecture

### Split: pure loop + browser adapter

`lib/paginator.js` has two parts with a clean seam:

- **`paginate(driver, config) → Promise<string[]>`** — the pure pagination *loop*. No browser, no I/O. It drives an injected `driver` and owns every decision: how many pages, the stop conditions, page collection. **This is what gets unit-tested**, against a mock driver, fully offline.
- **`makePuppeteerDriver(page, config) → driver`** — the browser *adapter*. Implements the driver interface with `page.evaluate`/`page.frames`/`page.waitForNavigation`. This holds the DOM specifics (scroll, iframe scan, next-button selectors) lifted verbatim from the working scrapers. It is the one impure part (like `ai.js`, `storage.js`) and is verified live by scrape-diff, not unit tests.

**Driver interface** (three async methods):

- `settle()` — the initial wait: `waitForNetworkIdle` when `config.networkIdle`, else a fixed settle sleep.
- `readText() → string` — scroll to bottom, wait, return `body.innerText` (plus each frame's text when `config.iframes`).
- `goNext() → boolean` — find and click the next-page control (WP selectors, then text tokens), wait for navigation; `true` if it advanced.

**The loop:**

```js
async function paginate(driver, { maxPages = 5 } = {}) {
  await driver.settle();
  const pages = [];
  let prev = '';
  for (let i = 0; i < maxPages; i++) {
    const text = await driver.readText();
    if (!text || text.length < 500 || text.includes('Page not found')) break;
    if (text.trim() === prev.trim()) break;      // pagination didn't change content
    pages.push(text);
    prev = text;
    if (!await driver.goNext()) break;
  }
  return pages;
}
```

This is a faithful generalization of the common scraper's control flow, including the three stop guards (`< 500` chars, `Page not found`, identical-to-previous) and `maxPages`.

### Config schema (thin)

Config carries only the genuinely functional knobs; everything else defaults:

```js
{
  iframes: false,       // scan page.frames() and append their text — tel-aviv, ashdod, herzliya
  networkIdle: false,   // settle via waitForNetworkIdle instead of a fixed sleep — tel-aviv
  maxPages: 5,          // constant across all 14; overridable
  settleMs: 4000,       // initial settle when not networkIdle
  waitMs: 6000,         // per-page wait after scroll (>= the max any scraper uses — ashkelon's 6000)
  nextTokens: ['הבא', 'next', '›', '»', 'לעמוד הבא']  // union across all 14
}
```

For the 14 sites this means: **10 have an empty config `{}`**; tel-aviv is `{ iframes: true, networkIdle: true }`; ashdod and herzliya are `{ iframes: true }`. (holon/jerusalem's `scrollHeight` scroll is now the default, and their `לעמוד הבא` token is in the default set, so they need no override.)

### Config location and dispatch

`MUNICIPALITIES` rows (`lib/sites.js`) gain two optional fields:

```js
{ publisher, url, pagination?, script? }
```

`main.js` dispatch replaces `require(muni.script).scrape(page)` with:

```js
const pages = muni.script
  ? await require(muni.script).scrape(page)                       // escape hatch: custom file
  : await paginate(makePuppeteerDriver(page, muni.pagination || {}), muni.pagination || {});
```

A migrated site has `pagination` (or nothing) and no `script`; a site kept custom retains `script` and its file. **`script` always wins the dispatch** — during migration a row may carry both (`pagination` sits dormant so `scrape-diff` can exercise the generic path before the site is converted); removing `script` is the act of migrating.

### Migration tool: `scripts/scrape-diff.js` (free)

For one site key, it launches a browser, runs **both** the old `scrapers/<key>.js` and the generic `paginate(makePuppeteerDriver(...))`, cleans both outputs through `superCleanText` + `buildEntries`, and compares the resulting **stable-key sets**. It prints keys-only-in-old, keys-only-in-new, and a match verdict. It makes **zero** Gemini calls and never touches the webhook — same safety class as the existing `scripts/capture-fixture.js`.

Migration is per site: run scrape-diff → if the stable-key sets match (timing differences didn't change which tenders appear), convert the row to the generic path and delete the old file → if they diverge, add the minimal override (usually `iframes: true`) and re-check, or keep the custom file. The old scraper stays until its site is proven equivalent.

## Data flow (unchanged contract)

```
main.js → (script ? custom scrape(page) : paginate(makePuppeteerDriver(page, cfg), cfg))
        → string[] of page texts
        → joined with '--- PAGE n ---'  (unchanged)
        → superCleanText → buildEntries → … (rest of pipeline unchanged)
```

## Error Handling

| Situation | Behavior |
|---|---|
| Page never loads / `< 500` chars / `Page not found` | Loop breaks, returns pages gathered so far (parity with today) |
| Next-button not found | `goNext()` false → loop breaks (single-page sites, the common case) |
| Pagination returns identical text | Break on identical-to-previous guard |
| `waitForNavigation`/`waitForNetworkIdle` times out | Adapter swallows it (`.catch(() => {})`), same as today |
| A site the paginator can't reproduce | Keeps its custom `script` file — no forced migration |
| scrape-diff shows divergence | Site is NOT migrated; investigated or left custom |

## Known Limitations

- **DOM selector logic is not unit-tested** — the adapter's in-browser scroll/click/iframe code needs a real DOM. It is lifted verbatim from working scrapers and verified live by scrape-diff, not by `npm test`.
- **scrape-diff compares a single capture** — a site whose content changes between the two scrapes within one run could show spurious diffs; re-run to confirm. Stable keys (digit-stripped) already absorb most volatility.
- **One robust behavior may be slower** per site (scroll-to-bottom, conservative waits) than a hand-tuned scraper. Runtime is Phase 4's concern; correctness is not affected (longer waits load more, not less).
- **Some sites may remain custom.** 1–2 of 14 keeping their file is an accepted outcome, not a failure.

## Testing

`node:test`, no new dependencies, `npm test` stays **offline and zero-token**.

- `paginate` against a **mock driver**: stops at `maxPages`; stops on `< 500` chars; stops on `Page not found`; stops on identical-to-previous; stops when `goNext()` returns false; collects exactly the pages read before a stop; returns `[]` when the first read is empty; `settle()` called once before the loop.
- Config defaulting: `maxPages` default 5; a passed `maxPages` overrides.

Live verification (not `npm test`): `scripts/scrape-diff.js <site>` — free, per-site, run during migration.

## Success Criteria

1. `paginate` is unit-tested against a mock driver with zero browser/network — the pagination logic's first coverage.
2. For each migrated site, `scrape-diff` shows matching stable-key sets between the old scraper and the generic paginator.
3. `main.js` dispatches custom (`script`) vs generic (`pagination`) correctly; the `--- PAGE n ---` join and downstream pipeline are unchanged.
4. Adding a new site requires only a `MUNICIPALITIES` row (config), no new file.
5. `npm test` runs offline, zero tokens.
6. Any site not proven equivalent retains its custom file and still works.

## Roadmap Context

Phase 3 of five. Its payoff (cheap site onboarding, single tested pagination path, first scraper test coverage, killing 8-way duplication) is partly present, partly future. It deliberately excludes concurrency (**Phase 4**, the ~13h→~1h runtime win) and alerting (**Phase 5**). The incremental scrape-diff migration ensures 14 working, revenue-relevant sites are never broken by an unverifiable-offline change.
