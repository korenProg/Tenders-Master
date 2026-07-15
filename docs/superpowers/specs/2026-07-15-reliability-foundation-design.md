# Reliability Foundation — Design

**Date:** 2026-07-15
**Status:** Approved approach, pending spec review
**Phase:** 1 of 5 on the road to ~1000 sites (see "Roadmap Context")

## תקציר בעברית

היום אין שום דרך לדעת אם המידע שאנחנו מפיקים נכון. אין ground truth, אין ולידציה, ואין התראות — אם אתר נשבר, אף אחד לא ידע. השלב הזה לא משנה את הסכימה ולא את הסקרייפרים: הוא מוסיף ולידציה דטרמיניסטית (בלי טוקנים), בדיקת המצאות מול טקסט העמוד, זיהוי צניחה במספר המכרזים, פלט JSON מובנה מ-Gemini, וסט ground truth שמאפשר סוף־סוף למדוד דיוק במספרים במקום בתחושה.

## Problem

The pipeline extracts three fields (`title`, `tender_number`, `deadline_date`) from unstructured Hebrew pages via Gemini, and **nothing verifies any of them**. There is no ground truth, no validation, no alerting. The stated goal is "100% reliable data", but today we cannot distinguish 99% from 70%.

Concrete evidence that this is not hypothetical — from measurement on 2026-07-15:

- **תל אביב** sends 46,634 cleaned chars to Gemini and has **7 tenders** cached.
- **חולון** sends 11,369 chars and has **59 tenders** cached.

A 4x larger page yielding 8x fewer tenders is a strong anomaly signal. It may be a genuine extraction failure that has been silently wrong for the life of the project. At 14 sites this is eyeballable; at 1000 it is invisible.

Meanwhile, several reliability wins are available at **zero token cost** and are currently unused.

### Error surface

Data can be wrong at six independent points: page render, `superCleanText` over-filtering, diff miss, AI mis-extraction, merge false-drop/false-keep, webhook delivery. 100% requires all six correct on every site every day. That is not achievable.

### Reframing the goal

"100% reliable" conflates two measures:

- **Precision** — everything published is correct. **Achievable to near-100%**, because it is verifiable against the source text.
- **Recall** — every existing tender is found. **Not achievable**; tenders published as scanned PDFs cannot be text-extracted.

For a tenders product a wrong deadline destroys trust more than a missing tender does. This phase therefore optimizes precision first, measures recall honestly, and makes failure loud.

## Goals

1. **Near-100% precision**: nothing reaching the webhook contradicts the source page.
2. **Measured accuracy**: a real number for precision/recall per field, reproducible on demand.
3. **Zero silent failures**: a site that breaks reports itself.
4. **No token cost for validation**: every check in the delivery path is pure code.
5. Additive only — no cache schema change, no scraper change, no webhook contract change.

## Non-Goals

Deferred to later phases, deliberately:

- Digit-aware content hashing (Phase 2 — fixes silently stale `deadline_date`).
- Per-site cache records / pluggable storage (Phase 2).
- Config-driven paginator (Phase 3).
- Concurrency / worker pool (Phase 4).
- Any change to `scrapers/*.js`, the cache schema, or the Lovable webhook contract.

## Architecture

Four additions, following the existing pure-`lib/` + thin-`main.js` split.

### `lib/validate.js`

```
validateTender(tender, pageText, normalizedPageText) → { tender, issues: [] }
```

Pure. No AI, no network, no I/O. Returns a possibly-degraded tender plus a list of issue codes.

Reuses the existing format-tolerant matching from `lib/merge.js` (`tenderStillOnPage`, `normalizeForTitleMatch`) rather than reimplementing it — that function already handles `47/2026`, `47.26`, `47 / 26`.

**Issue codes:** `EMPTY_TITLE`, `TITLE_NOT_ON_PAGE`, `NUMBER_NOT_ON_PAGE`, `BAD_NUMBER_FORMAT`, `INVALID_DATE`, `IMPLAUSIBLE_DATE`.

### Validation policy

| Check | Failure means | Action |
|---|---|---|
| Title empty | Malformed extraction | **Drop** tender, log |
| Title text absent from page | Hallucinated tender | **Drop** tender, log |
| `tender_number` not found on page | Invented number | **Degrade to `"אין"`**, keep tender, log |
| `tender_number` not `N/YYYY` after normalization | Format failure | **Degrade to `"אין"`**, keep tender, log |
| `deadline_date` not a real DD/MM/YYYY date | Bad date | **Degrade to `"אין"`**, keep tender, log |
| `deadline_date` parses but is > 2 years out or > 1 year past | Implausible | **Degrade to `"אין"`**, keep tender, log |

Rationale: `"אין"` is already the schema's established "not found" value, so degrading a suspect field is a supported state, not a new concept. A missing deadline is honest; a wrong deadline is a trust failure. Title failures drop the whole record because a tender that isn't on the page is fabricated.

Dropping is the only action that costs recall, and it is reserved for records that are demonstrably not on the page.

### `lib/health.js`

```
assessSite(previousTenders, mergedTenders, cleanedTextLength) → { level, signals: [] }
```

Pure. Compares this run to the cached previous run. **Requires no schema change** — `siteEntry.tenders` already carries last run's list.

**Signals:** `COUNT_COLLAPSE` (count dropped >50% vs previous), `ZERO_FROM_HEALTHY_PAGE` (0 tenders from >1500 chars — the existing healthy-page threshold), `LOW_YIELD` (chars-per-tender above an absolute threshold), `ALL_DEGRADED` (every tender lost a field to validation).

`LOW_YIELD` uses a **fixed threshold, not per-site history**, because the cache stores no historical page size and this phase adds no schema fields. Threshold: **3000 cleaned chars per tender**. Calibration from the 2026-07-15 measurement — תל אביב sits at 6,662 chars/tender (46,634 ÷ 7) and would fire; חולון sits at 193 (11,369 ÷ 59) and would not. Per-site adaptive yield belongs in Phase 2, where the schema gains room to store it.

Levels: `ok` | `warn` | `alert`. This phase logs them; wiring to notifications is out of scope.

### `test/fixtures/ground-truth/`

Per labeled site, two files:

- `<site>.txt` — the cleaned page text, captured verbatim from `superCleanText`.
- `<site>.expected.json` — hand-labeled array of the true tenders on that page.

Initial set: **5 sites, Tel Aviv first** (prime suspect), plus Holon (high yield), Haifa (small), Herzliya (paginated), and one 1-page trivial site.

Ground truth is a **snapshot**: it is correct for the page as captured, and is expected to drift as sites change. It is re-captured deliberately, not automatically.

### `scripts/accuracy.js`

```
npm run accuracy [-- --site=tel-aviv]
```

Loads each fixture's `.txt`, runs the real `processWithAI` against it, applies `lib/validate.js`, and scores the result against `.expected.json`.

Reports per site and in aggregate: **precision**, **recall**, per-field accuracy (`title` / `tender_number` / `deadline_date`), and the issue-code histogram.

Matching an extracted tender to an expected one uses the same identity rule as the merge path (`tender_number` when present, else normalized title) so the harness and production agree on what "the same tender" means.

### `main.js` changes

1. **Structured output.** `processWithAI` passes a `responseSchema` so Gemini returns conforming JSON. This retires the ` ```json ` fence-strip regex and the bare `JSON.parse`, eliminating a whole failure class. `null`-on-failure semantics are unchanged.
2. **Validation in the delivery path.** After `mergeTenders`, run each tender through `validateTender` against the cleaned page text. Drop/degrade per policy. Log the issue histogram.
3. **Health assessment.** Call `assessSite` before delivery; log level and signals into the existing per-site output and the `RUN_STATS` summary.

Validation runs on the **merged** list so cached tenders are re-verified against the current page each run, not just newly extracted ones.

### Data flow

```
scrape → superCleanText → diff → (AI or skip) → mergeTenders
  → validateTender per tender      [0 tokens]
      ├─ drop hallucinated records
      └─ degrade unverifiable fields to "אין"
  → assessSite → level + signals   [0 tokens]
  → save cache (unchanged schema) → POST to webhook (unchanged contract)
```

## Error Handling

| Situation | Behavior |
|---|---|
| Gemini returns schema-invalid JSON | `responseSchema` prevents most; residual → `null` → cache untouched, retry next run (unchanged) |
| Every tender fails validation | Merged list empty → existing "0 tenders" path applies; health emits `alert` |
| Validation drops some tenders | Remaining list delivered; issue histogram logged |
| `assessSite` returns `alert` | Logged loudly; **delivery still proceeds** (this phase does not gate delivery on health) |
| Ground-truth fixture missing/stale | `npm run accuracy` reports it as an error; never affects production runs |
| `scripts/accuracy.js` fails | Isolated from the main flow — touches no cache and no webhook |

## Known Limitations

- **Recall is capped below 100%.** Tenders in scanned PDFs, images, or behind logins are unreachable. The harness measures this gap rather than closing it.
- **Ground truth is a snapshot** and drifts as sites change; it needs deliberate re-capture.
- **Validation cannot catch a plausible-but-wrong date.** If Gemini reads the wrong date off the page and it parses and is plausible, no deterministic check detects it. Only ground truth surfaces this class.
- **`deadline_date` can still be silently stale** — the digit-blindness in `stableKey` is real and is deliberately deferred to Phase 2. This phase verifies dates it *sees*; it does not force re-extraction when only digits change.
- **Health signals are logged, not delivered.** Alerting/notification is out of scope.

## Testing

Unit tests via the existing `node:test` runner, no new dependencies:

- `validate.js`: each issue code; degradation preserves the tender; drops only on title failures; number matching tolerant of `47/26` / `47.2026`; `"אין"` inputs pass through untouched.
- `health.js`: count collapse; zero-from-healthy-page; low yield; all-degraded; `ok` when stable.
- Fixture integrity: every `.expected.json` parses and every tender in it appears in its `.txt`.

**Cost split — this is a hard boundary:**

- `npm test` — pure, offline, **zero tokens**. Never calls Gemini.
- `npm run accuracy` — explicit, billable, ~5 AI calls. Run deliberately, never in CI by default.

## Success Criteria

1. `npm run accuracy` produces a precision/recall number per field across the 5 ground-truth sites. **Any number is a win — today there is none.**
2. The Tel Aviv anomaly is resolved to a verdict: genuine extraction failure, or the page really does have ~7 tenders.
3. A tender whose number does not appear on the page is never delivered with that number.
4. A site whose yield collapses >50% emits an `alert` in the run log.
5. `npm test` still runs offline with zero tokens and zero network.
6. Webhook payload shape and headers unchanged.

## Roadmap Context

Measured on 2026-07-15 against the live 14 sites — the basis for this ordering:

| Fact | Value |
|---|---|
| Cold run, all 14 sites | 65,784 input tokens (~4,700/site) |
| Extrapolated cold run at 1000 sites | ~4.7M tokens (~$1–2) |
| Steady-state token cost at 1000/day | ~$26/yr (vs ~$515/yr if cache never persists) |
| Sequential runtime | >43s/site → ~13h at 1000 sites |
| Hebrew tokenization | 1.66 chars/token |
| Scraper duplication | 8 of 14 structurally identical; 79% mean pairwise similarity |

**The conclusion that reordered the roadmap:** token spend is nearly free at every scale under discussion, so optimizing it further is not where the risk lives. At 1000 sites the expensive failure is *undetected wrongness*, which is why reliability precedes cache, paginator, and concurrency work.

Subsequent phases: **2** — cache v3 (per-site records, pluggable storage, digit-aware hashing); **3** — config-driven paginator; **4** — concurrency; **5** — alerting on health signals.
