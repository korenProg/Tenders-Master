# Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make extraction errors visible and keep unverified data out of the webhook, without changing the cache schema, the scrapers, or the webhook contract.

**Architecture:** Two new pure modules (`lib/validate.js`, `lib/health.js`) run as a delivery-time filter over the merged tender list — the cache keeps storing RAW merged output so upsert identity stays stable. Two extraction helpers (`lib/sites.js`, `lib/ai.js`) move out of `main.js` so offline scripts can reuse them without executing the run loop. A ground-truth fixture set plus `npm run accuracy` turns "is our data right?" into a number.

**Tech Stack:** Node.js (CommonJS), `node:test` runner, `@google/generative-ai` 0.24.1 (`SchemaType` verified present), Puppeteer 25. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-15-reliability-foundation-design.md` (commits `5c1314d`, `721d879`)

## Global Constraints

- **CommonJS only** (`"type": "commonjs"`). `require`/`module.exports`. No ESM.
- **No new dependencies.** Tests use the built-in `node:test` runner.
- **`npm test` must stay offline and zero-token.** It must never call Gemini or the network. Only `npm run accuracy` is billable.
- **Hebrew unicode ranges in regexes MUST be escape sequences** (`֐-׿`), never literal characters. Hebrew inside plain strings (e.g. `'אין'`) is fine.
- **`"אין"`** is the established "not found" value. Degraded fields use it.
- **No cache schema change.** `makeSiteEntry` stays `{version:2, stableKeys, tenders, pendingDelivery, updatedAt}`.
- **No changes to `scrapers/*.js`.**
- **Webhook contract unchanged:** `POST { tenders: [...] }` with `x-webhook-key`.
- **The cache stores RAW merged tenders.** Validation NEVER changes what is cached. See Task 6.
- `lib/` modules are pure except `lib/ai.js`, which is the single designated impure module (network).

---

### Task 1: Extract the site list into `lib/sites.js`

`scripts/` cannot `require('../main.js')` to get `MUNICIPALITIES` because `main.js` calls `run()` at import time — requiring it would launch a full production scrape. The list must live in its own module.

**Files:**
- Create: `lib/sites.js`
- Modify: `main.js:15-30` (remove the array), `main.js:6-9` (add require)
- Test: `test/sites.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `MUNICIPALITIES: Array<{publisher: string, url: string, script: string}>` — used by Task 7 and Task 8.

- [ ] **Step 1: Write the failing test**

Create `test/sites.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { MUNICIPALITIES } = require('../lib/sites');

test('MUNICIPALITIES exposes every site with the fields main.js needs', () => {
  assert.ok(Array.isArray(MUNICIPALITIES));
  assert.strictEqual(MUNICIPALITIES.length, 14);
  for (const m of MUNICIPALITIES) {
    assert.ok(m.publisher && m.publisher.length > 0, 'publisher missing');
    assert.ok(m.url && m.url.startsWith('http'), `bad url for ${m.publisher}`);
    assert.ok(m.script && m.script.startsWith('./scrapers/'), `bad script for ${m.publisher}`);
  }
});

test('MUNICIPALITIES urls are unique (they are the cache keys)', () => {
  const urls = MUNICIPALITIES.map(m => m.url);
  assert.strictEqual(new Set(urls).size, urls.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sites.test.js`
Expected: FAIL — `Cannot find module '../lib/sites'`

- [ ] **Step 3: Create `lib/sites.js`**

Move the array verbatim out of `main.js:15-30`. Do not edit any URL or publisher string.

```js
// The sites to scrape. Kept out of main.js so scripts can import the list
// without executing main.js's run() call.
const MUNICIPALITIES = [
  { publisher: "עיריית חיפה", url: "https://www2.haifa.muni.il/Michrazim/Default.aspx", script: "./scrapers/haifa.js" },
  { publisher: "עיריית הרצליה", url: "https://www.herzliya.muni.il/bids/", script: "./scrapers/herzliya.js" },
  { publisher: "עיריית אשדוד", url: "https://www.ashdod.muni.il/he-il/אתר-העיר/מכרזים/מכרזים-כלליים/", script: "./scrapers/ashdod.js" },
  { publisher: "עיריית מודיעין מכבים רעות", url: "https://www.modiin.muni.il/modiinwebsite/ChannelArticle.aspx?PageID=487_468", script: "./scrapers/modiin.js" },
  { publisher: "עיריית מודיעין עלית", url: "https://www.modil.org.il/bids/?archive=0&category=3", script: "./scrapers/modiin-illit.js" },
  { publisher: "מועצה אזורית חבל מודיעין", url: "https://www.modiin-region.muni.il/bids/", script: "./scrapers/hevel-modiin.js" },
  { publisher: "החברה הכלכלית מודיעין", url: "https://hacal.co.il/%D7%9E%D7%9B%D7%A8%D7%96%D7%99%D7%9D/", script: "./scrapers/hacal-modiin.js" },
  { publisher: "עיריית חולון", url: "https://www.holon.muni.il/CityHall/Bids/Pages/default.aspx", script: "./scrapers/holon.js" },
  { publisher: "עיריית ירושלים", url: "https://www.jerusalem.muni.il/he/city/tenders/contractorstenders/kablanim/", script: "./scrapers/jerusalem.js" },
  { publisher: "עיריית אשקלון", url: "https://ashkelon.muni.gov.il/he/העירייה/מכרזים?status=open", script: "./scrapers/ashkelon.js" },
  { publisher: "עיריית תל אביב", url: "https://www.tel-aviv.gov.il/AuctionAndCareers/Pages/Service.aspx", script: "./scrapers/tel-aviv.js" },
  { publisher: "עיריית ראשון לציון", url: "https://www.rishonlezion.muni.il/Activities/Tenders/Pages/Contracting_tenders.aspx", script: "./scrapers/rishon-lezion.js" },
  { publisher: "עיריית בני ברק", url: "https://www.bnei-brak.muni.il/bids/category/mikhrazim/", script: "./scrapers/bnei-brak.js" },
  { publisher: "עיריית באר שבע", url: "https://www.beer-sheva.muni.il/City/FreeInfo/Rehesh/Pages/Bids.aspx", script: "./scrapers/beer-sheva.js" }
];

module.exports = { MUNICIPALITIES };
```

- [ ] **Step 4: Wire `main.js` to it**

Delete the `const MUNICIPALITIES = [...]` block at `main.js:15-30` and add to the require block near `main.js:6-9`:

```js
const { MUNICIPALITIES } = require('./lib/sites');
```

- [ ] **Step 5: Run tests and syntax check**

Run: `npm test && node --check main.js`
Expected: all tests PASS (23 existing + 2 new = 25), `node --check` silent.

- [ ] **Step 6: Commit**

```bash
git add lib/sites.js test/sites.test.js main.js
git commit -m "refactor: extract MUNICIPALITIES into lib/sites.js

Scripts need the site list without executing main.js's run() call."
```

---

### Task 2: Extract reusable matching primitives from `lib/merge.js`

`validateTender` needs to ask "is this number on the page?" and "is this title on the page?" **separately**. `tenderStillOnPage` answers only the OR of the two. Split it into primitives — behavior-preserving, so every existing merge test must still pass untouched.

**Files:**
- Modify: `lib/merge.js:9-31` (split `tenderStillOnPage`), `lib/merge.js:81` (exports)
- Test: `test/merge.test.js` (append; do not modify existing tests)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `numberOnPage(tenderNumber: string, pageText: string) → boolean`
  - `titleOnPage(title: string, normalizedPageText: string) → boolean`
  - `baseNumber(tenderNumber: string) → string`
  - (existing `normalizeForTitleMatch`, `tenderStillOnPage`, `mergeTenders` unchanged)

- [ ] **Step 1: Write the failing test**

Append to `test/merge.test.js`:

```js
const { numberOnPage, titleOnPage, baseNumber } = require('../lib/merge');

test('numberOnPage matches N/YYYY, N/YY and N.YYYY forms', () => {
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47/2026 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47/26 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47.2026 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47 / 26 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 48/2026 לניקיון'), false);
});

test('numberOnPage strips the dedup suffix and rejects "אין"', () => {
  assert.strictEqual(numberOnPage('47/2026-2', 'מכרז 47/2026 לניקיון'), true);
  assert.strictEqual(numberOnPage('אין', 'מכרז 47/2026 לניקיון'), false);
  assert.strictEqual(baseNumber('47/2026-3'), '47/2026');
  assert.strictEqual(baseNumber(undefined), 'אין');
});

test('titleOnPage compares normalized text and rejects absent titles', () => {
  const page = 'מכרז פומבי לאספקת שירותי ניקיון 47/2026';
  const norm = normalizeForTitleMatch(page);
  assert.strictEqual(titleOnPage('מכרז פומבי לאספקת שירותי ניקיון', norm), true);
  assert.strictEqual(titleOnPage('אספקת מחשבים ניידים לבתי הספר היסודיים', norm), false);
  assert.strictEqual(titleOnPage('', norm), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/merge.test.js`
Expected: FAIL — `numberOnPage is not a function`

- [ ] **Step 3: Refactor `lib/merge.js`**

Replace `tenderStillOnPage` (`lib/merge.js:17-31`) with three functions. The OR order and fall-through are preserved exactly: a number that fails its check still falls through to the title check.

```js
// Does this tender number appear on the page? Tolerant of 12/2026, 12.26,
// 12 / 2026 and of the -2/-3 dedup suffix.
function numberOnPage(tenderNumber, pageText) {
  const number = baseNumber(tenderNumber);
  if (number === 'אין') return false;
  const m = number.match(/^(\d+)\/(\d{4})$/);
  if (m) {
    const yearShort = m[2].slice(2);
    const re = new RegExp(`(?<!\\d)${m[1]}\\s*[\\/.]\\s*(${m[2]}|${yearShort})(?!\\d)`);
    return re.test(pageText);
  }
  return pageText.includes(number);
}

// Does the start of this normalized title appear in the normalized page text?
function titleOnPage(title, normalizedPageText) {
  const normTitle = normalizeForTitleMatch(title).slice(0, 30);
  return normTitle.length > 0 && normalizedPageText.includes(normTitle);
}

// Zero-token removal check. Kept if EITHER the number or the title is found
// (spec: prefer false-keep over false-drop).
function tenderStillOnPage(tender, pageText, normalizedPageText) {
  return numberOnPage(tender.tender_number, pageText) ||
         titleOnPage(tender.title, normalizedPageText);
}
```

Update the exports line at the bottom of the file:

```js
module.exports = {
  normalizeForTitleMatch, tenderStillOnPage, mergeTenders,
  numberOnPage, titleOnPage, baseNumber
};
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. **All pre-existing merge tests must still pass unmodified** — that is the proof the refactor is behavior-preserving.

- [ ] **Step 5: Commit**

```bash
git add lib/merge.js test/merge.test.js
git commit -m "refactor: split tenderStillOnPage into numberOnPage/titleOnPage

Validation needs to ask the two questions separately. Behavior-preserving:
existing merge tests unchanged and still passing."
```

---

### Task 3: `lib/validate.js`

**Files:**
- Create: `lib/validate.js`
- Test: `test/validate.test.js`

**Interfaces:**
- Consumes: `normalizeForTitleMatch`, `numberOnPage`, `titleOnPage` from `lib/merge.js` (Task 2)
- Produces:
  - `validateTender(tender, pageText, normalizedPageText, now?) → { tender: object|null, issues: string[] }` — `tender: null` means DROP
  - `validateTenders(tenders, pageText, now?) → { kept: object[], dropped: [{tender, issues}], histogram: Record<string, number> }`
  - `parseDeadline(value) → Date|null`
  - `ISSUES` — `{EMPTY_TITLE, TITLE_NOT_ON_PAGE, NUMBER_NOT_ON_PAGE, BAD_NUMBER_FORMAT, INVALID_DATE, IMPLAUSIBLE_DATE}`

`now` is injectable so date-plausibility tests are deterministic.

- [ ] **Step 1: Write the failing test**

Create `test/validate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateTender, validateTenders, parseDeadline, ISSUES } = require('../lib/validate');
const { normalizeForTitleMatch } = require('../lib/merge');

const PAGE = 'מכרז פומבי לאספקת שירותי ניקיון 47/2026 מועד אחרון 15/08/2026';
const NORM = normalizeForTitleMatch(PAGE);
const NOW = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15, fixed for determinism

function tender(over) {
  return { title: 'מכרז פומבי לאספקת שירותי ניקיון', tender_number: '47/2026', deadline_date: '15/08/2026', ...over };
}

test('a fully valid tender passes untouched with no issues', () => {
  const { tender: out, issues } = validateTender(tender(), PAGE, NORM, NOW);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(out.tender_number, '47/2026');
  assert.strictEqual(out.deadline_date, '15/08/2026');
});

test('empty title drops the tender', () => {
  const { tender: out, issues } = validateTender(tender({ title: '   ' }), PAGE, NORM, NOW);
  assert.strictEqual(out, null);
  assert.deepStrictEqual(issues, [ISSUES.EMPTY_TITLE]);
});

test('title absent from the page drops the tender as hallucinated', () => {
  const t = tender({ title: 'אספקת מחשבים ניידים לבתי הספר היסודיים' });
  const { tender: out, issues } = validateTender(t, PAGE, NORM, NOW);
  assert.strictEqual(out, null);
  assert.deepStrictEqual(issues, [ISSUES.TITLE_NOT_ON_PAGE]);
});

test('a number not on the page degrades to "אין" but keeps the tender', () => {
  const { tender: out, issues } = validateTender(tender({ tender_number: '99/2026' }), PAGE, NORM, NOW);
  assert.strictEqual(out.tender_number, 'אין');
  assert.deepStrictEqual(issues, [ISSUES.NUMBER_NOT_ON_PAGE]);
  assert.strictEqual(out.title, tender().title);
});

test('a malformed number degrades to "אין"', () => {
  const { tender: out, issues } = validateTender(tender({ tender_number: 'abc-xyz' }), PAGE, NORM, NOW);
  assert.strictEqual(out.tender_number, 'אין');
  assert.deepStrictEqual(issues, [ISSUES.BAD_NUMBER_FORMAT]);
});

test('the -2 dedup suffix is accepted, not treated as malformed', () => {
  const { issues } = validateTender(tender({ tender_number: '47/2026-2' }), PAGE, NORM, NOW);
  assert.deepStrictEqual(issues, []);
});

test('an unparseable or rolled-over date degrades to "אין"', () => {
  assert.strictEqual(parseDeadline('31/02/2026'), null); // no Feb 31 rollover
  assert.strictEqual(parseDeadline('15-08-2026'), null);
  assert.strictEqual(parseDeadline('אין'), null);
  const { tender: out, issues } = validateTender(tender({ deadline_date: '31/02/2026' }), PAGE, NORM, NOW);
  assert.strictEqual(out.deadline_date, 'אין');
  assert.deepStrictEqual(issues, [ISSUES.INVALID_DATE]);
});

test('an implausible date degrades to "אין"', () => {
  const far = validateTender(tender({ deadline_date: '15/08/2035' }), PAGE, NORM, NOW);
  assert.strictEqual(far.tender.deadline_date, 'אין');
  assert.deepStrictEqual(far.issues, [ISSUES.IMPLAUSIBLE_DATE]);
  const old = validateTender(tender({ deadline_date: '15/08/2020' }), PAGE, NORM, NOW);
  assert.deepStrictEqual(old.issues, [ISSUES.IMPLAUSIBLE_DATE]);
});

test('"אין" inputs pass through without raising issues', () => {
  const t = tender({ tender_number: 'אין', deadline_date: 'אין' });
  const { tender: out, issues } = validateTender(t, PAGE, NORM, NOW);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(out.tender_number, 'אין');
});

test('validateTenders splits kept/dropped and builds a histogram', () => {
  const list = [
    tender(),
    tender({ title: 'אספקת מחשבים ניידים לבתי הספר היסודיים' }), // dropped
    tender({ tender_number: '99/2026' })                          // degraded
  ];
  const { kept, dropped, histogram } = validateTenders(list, PAGE, NOW);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(histogram[ISSUES.TITLE_NOT_ON_PAGE], 1);
  assert.strictEqual(histogram[ISSUES.NUMBER_NOT_ON_PAGE], 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/validate.test.js`
Expected: FAIL — `Cannot find module '../lib/validate'`

- [ ] **Step 3: Create `lib/validate.js`**

```js
const { normalizeForTitleMatch, numberOnPage, titleOnPage } = require('./merge');

const NONE = 'אין';

const ISSUES = {
  EMPTY_TITLE: 'EMPTY_TITLE',
  TITLE_NOT_ON_PAGE: 'TITLE_NOT_ON_PAGE',
  NUMBER_NOT_ON_PAGE: 'NUMBER_NOT_ON_PAGE',
  BAD_NUMBER_FORMAT: 'BAD_NUMBER_FORMAT',
  INVALID_DATE: 'INVALID_DATE',
  IMPLAUSIBLE_DATE: 'IMPLAUSIBLE_DATE'
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_DAYS = 730; // ~2 years out
const MAX_PAST_DAYS = 365;   // ~1 year past

// Strict DD/MM/YYYY. Returns null on anything else, including rollovers
// like 31/02 that Date would silently accept as 03/03.
function parseDeadline(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value || '');
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function isPlausibleDeadline(date, now) {
  const diff = date.getTime() - now.getTime();
  return diff <= MAX_FUTURE_DAYS * DAY_MS && diff >= -MAX_PAST_DAYS * DAY_MS;
}

// Verifies one tender against the page it came from. Pure: no AI, no network.
// Returns tender:null to DROP (record is not on the page at all), or a
// possibly-degraded tender: a field we cannot verify becomes "אין", because a
// missing deadline is honest and a wrong one is a trust failure.
function validateTender(tender, pageText, normalizedPageText, now = new Date()) {
  const title = (tender.title || '').trim();
  if (title.length === 0) return { tender: null, issues: [ISSUES.EMPTY_TITLE] };
  if (!titleOnPage(title, normalizedPageText)) return { tender: null, issues: [ISSUES.TITLE_NOT_ON_PAGE] };

  const issues = [];
  const out = { ...tender };

  const number = tender.tender_number || NONE;
  if (number !== NONE) {
    if (!/^\d+\/\d{4}(-\d+)?$/.test(number)) {
      issues.push(ISSUES.BAD_NUMBER_FORMAT);
      out.tender_number = NONE;
    } else if (!numberOnPage(number, pageText)) {
      issues.push(ISSUES.NUMBER_NOT_ON_PAGE);
      out.tender_number = NONE;
    }
  }

  const deadline = tender.deadline_date || NONE;
  if (deadline !== NONE) {
    const parsed = parseDeadline(deadline);
    if (!parsed) {
      issues.push(ISSUES.INVALID_DATE);
      out.deadline_date = NONE;
    } else if (!isPlausibleDeadline(parsed, now)) {
      issues.push(ISSUES.IMPLAUSIBLE_DATE);
      out.deadline_date = NONE;
    }
  }

  return { tender: out, issues };
}

function validateTenders(tenders, pageText, now = new Date()) {
  const normalizedPageText = normalizeForTitleMatch(pageText);
  const kept = [];
  const dropped = [];
  const histogram = {};
  for (const t of tenders) {
    const { tender, issues } = validateTender(t, pageText, normalizedPageText, now);
    for (const code of issues) histogram[code] = (histogram[code] || 0) + 1;
    if (tender === null) dropped.push({ tender: t, issues });
    else kept.push(tender);
  }
  return { kept, dropped, histogram };
}

module.exports = { validateTender, validateTenders, parseDeadline, ISSUES };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add lib/validate.js test/validate.test.js
git commit -m "feat: add lib/validate.js zero-token tender validation

Drops hallucinated records (title not on page), degrades unverifiable
tender_number/deadline_date to the schema's existing 'אין' value."
```

---

### Task 4: `lib/health.js`

**Files:**
- Create: `lib/health.js`
- Test: `test/health.test.js`

**Interfaces:**
- Consumes: `ISSUES` codes from `lib/validate.js` (Task 3) — by string value only, no import needed
- Produces: `assessSite({previousTenders, mergedTenders, cleanedTextLength, issueHistogram}) → { level: 'ok'|'warn'|'alert', signals: string[] }`, plus `LEVELS` and `SIGNALS`

**Thresholds are fixed, not per-site** — the cache stores no historical page size and this phase adds no schema fields.

- [ ] **Step 1: Write the failing test**

Create `test/health.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { assessSite, SIGNALS, LEVELS } = require('../lib/health');

function tenders(n) {
  return Array.from({ length: n }, (_, i) => ({ title: `t${i}`, tender_number: `${i}/2026` }));
}

test('a stable site is ok with no signals', () => {
  const r = assessSite({ previousTenders: tenders(10), mergedTenders: tenders(10), cleanedTextLength: 5000 });
  assert.strictEqual(r.level, LEVELS.OK);
  assert.deepStrictEqual(r.signals, []);
});

test('a >50% count drop alerts', () => {
  const r = assessSite({ previousTenders: tenders(59), mergedTenders: tenders(7), cleanedTextLength: 11000 });
  assert.ok(r.signals.includes(SIGNALS.COUNT_COLLAPSE));
  assert.strictEqual(r.level, LEVELS.ALERT);
});

test('exactly 50% retained does not collapse', () => {
  const r = assessSite({ previousTenders: tenders(10), mergedTenders: tenders(5), cleanedTextLength: 5000 });
  assert.ok(!r.signals.includes(SIGNALS.COUNT_COLLAPSE));
});

test('zero tenders from a healthy page alerts', () => {
  const r = assessSite({ previousTenders: [], mergedTenders: [], cleanedTextLength: 5000 });
  assert.ok(r.signals.includes(SIGNALS.ZERO_FROM_HEALTHY_PAGE));
  assert.strictEqual(r.level, LEVELS.ALERT);
});

test('zero tenders from a thin page is not a signal', () => {
  const r = assessSite({ previousTenders: [], mergedTenders: [], cleanedTextLength: 200 });
  assert.deepStrictEqual(r.signals, []);
});

test('low yield warns — calibrated on the real Tel Aviv vs Holon numbers', () => {
  // תל אביב measured 2026-07-15: 46,634 chars -> 7 tenders = 6662 chars/tender
  const tlv = assessSite({ previousTenders: tenders(7), mergedTenders: tenders(7), cleanedTextLength: 46634 });
  assert.ok(tlv.signals.includes(SIGNALS.LOW_YIELD));
  assert.strictEqual(tlv.level, LEVELS.WARN);

  // חולון measured 2026-07-15: 11,369 chars -> 59 tenders = 193 chars/tender
  const holon = assessSite({ previousTenders: tenders(59), mergedTenders: tenders(59), cleanedTextLength: 11369 });
  assert.ok(!holon.signals.includes(SIGNALS.LOW_YIELD));
});

test('every tender losing a field warns', () => {
  const r = assessSite({
    previousTenders: tenders(3), mergedTenders: tenders(3), cleanedTextLength: 5000,
    issueHistogram: { NUMBER_NOT_ON_PAGE: 2, INVALID_DATE: 1 }
  });
  assert.ok(r.signals.includes(SIGNALS.ALL_DEGRADED));
  assert.strictEqual(r.level, LEVELS.WARN);
});

test('a first run with no previous tenders does not collapse', () => {
  const r = assessSite({ previousTenders: [], mergedTenders: tenders(5), cleanedTextLength: 5000 });
  assert.ok(!r.signals.includes(SIGNALS.COUNT_COLLAPSE));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/health.test.js`
Expected: FAIL — `Cannot find module '../lib/health'`

- [ ] **Step 3: Create `lib/health.js`**

```js
const LEVELS = { OK: 'ok', WARN: 'warn', ALERT: 'alert' };

const SIGNALS = {
  COUNT_COLLAPSE: 'COUNT_COLLAPSE',
  ZERO_FROM_HEALTHY_PAGE: 'ZERO_FROM_HEALTHY_PAGE',
  LOW_YIELD: 'LOW_YIELD',
  ALL_DEGRADED: 'ALL_DEGRADED'
};

// main.js's existing "page looks healthy" rule.
const HEALTHY_PAGE_MIN_CHARS = 1500;

// Fixed, not per-site: the cache stores no historical page size and this phase
// adds no schema fields. Calibrated 2026-07-15 — תל אביב 6662 chars/tender
// fires, חולון 193 does not. Per-site adaptive yield belongs in Phase 2.
const LOW_YIELD_CHARS_PER_TENDER = 3000;

// Degradation codes from lib/validate.js. Referenced by value so health stays
// dependency-free.
const DEGRADING_ISSUES = ['NUMBER_NOT_ON_PAGE', 'BAD_NUMBER_FORMAT', 'INVALID_DATE', 'IMPLAUSIBLE_DATE'];

// Compares this run against the cached previous run. Pure. Requires no schema
// change: siteEntry.tenders already carries last run's list.
function assessSite({ previousTenders = [], mergedTenders = [], cleanedTextLength = 0, issueHistogram = {} } = {}) {
  const signals = [];
  const before = previousTenders.length;
  const after = mergedTenders.length;

  if (after === 0 && cleanedTextLength > HEALTHY_PAGE_MIN_CHARS) {
    signals.push(SIGNALS.ZERO_FROM_HEALTHY_PAGE);
  }
  if (before > 0 && after < before * 0.5) {
    signals.push(SIGNALS.COUNT_COLLAPSE);
  }
  if (after > 0 && cleanedTextLength / after > LOW_YIELD_CHARS_PER_TENDER) {
    signals.push(SIGNALS.LOW_YIELD);
  }
  const degraded = DEGRADING_ISSUES.reduce((sum, code) => sum + (issueHistogram[code] || 0), 0);
  if (after > 0 && degraded >= after) {
    signals.push(SIGNALS.ALL_DEGRADED);
  }

  let level = LEVELS.OK;
  if (signals.includes(SIGNALS.COUNT_COLLAPSE) || signals.includes(SIGNALS.ZERO_FROM_HEALTHY_PAGE)) {
    level = LEVELS.ALERT;
  } else if (signals.length > 0) {
    level = LEVELS.WARN;
  }

  return { level, signals };
}

module.exports = { assessSite, LEVELS, SIGNALS, LOW_YIELD_CHARS_PER_TENDER, HEALTHY_PAGE_MIN_CHARS };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/health.js test/health.test.js
git commit -m "feat: add lib/health.js site health signals

Count collapse, zero-from-healthy-page, low yield, all-degraded.
Fixed thresholds calibrated on measured Tel Aviv/Holon yields.
No schema fields added."
```

---

### Task 5: `lib/ai.js` — extract the Gemini call and add `responseSchema`

> ⚠️ **Tasks 5 and 6 MUST land together.** This task deletes `processWithAI` while `main.js` still calls it in two places; Task 6 rewires those call sites. Between the two commits `main.js` is **runtime-broken**. `node --check` only parses and will NOT catch this — it passes on a file with undefined function calls. Do not stop, hand off, or leave the branch deployable between Task 5 and Task 6.

`scripts/accuracy.js` must call the exact same extraction path production uses, so it cannot live in `main.js`. Move it, and add structured output while moving it.

**Files:**
- Create: `lib/ai.js`
- Modify: `main.js:1-13` (requires), `main.js:34-77` (delete `processWithAI`)
- Test: none — this module is network-bound by design. It is exercised by `npm run accuracy` (Task 8). **Do not write a unit test that calls Gemini** — `npm test` must stay offline.

**Interfaces:**
- Consumes: nothing
- Produces: `extractTenders(rawText, {excerpt?}) → { tenders: object[]|null, usage: {inputTokens, outputTokens} }` — `tenders: null` means failure, caller must not update the cache.

- [ ] **Step 1: Create `lib/ai.js`**

The prompt text is copied **verbatim** from `main.js:41-54` — do not reword it; extraction quality depends on it.

```js
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const MODEL_NAME = 'gemini-2.5-flash';

// Structured output: Gemini is constrained to this shape, which retires the
// ```json fence-stripping regex the old free-text path needed.
const TENDER_ARRAY_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      tender_number: { type: SchemaType.STRING },
      deadline_date: { type: SchemaType.STRING }
    },
    required: ['title', 'tender_number', 'deadline_date']
  }
};

function buildPrompt(rawText, excerpt) {
  const excerptNote = excerpt
    ? `\n    NOTE: The text below contains only EXCERPTS from the webpage, separated by "---" lines. It is NOT the full page. Extract every tender visible in these excerpts.\n`
    : "";
  return `
    You are an expert data extraction tool. Analyze the following raw webpage text from a municipality website.
    ${excerptNote}
    Extract all ACTIVE/OPEN tenders. For each tender, accurately extract:
    1. title: The full descriptive title of the tender in Hebrew. Clean any weird trailing chars.
    2. tender_number: The formal tender identifier/number. STRICLY STANDARDIZE the format to "NUMBER/YEAR" (e.g., if you see "47.26" or "47/26", format it strictly as "47/2026"). If no number exists, write "אין".
    3. deadline_date: The absolute final submission date formatted strictly as DD/MM/YYYY. If no year is provided, assume 2026. If no date is found, write "אין".

    Return ONLY a valid JSON array of objects. Do not wrap it in markdown code blocks. No explanations.
    Example format: [{"title": "שם מכרז נקי", "tender_number": "47/2026", "deadline_date": "15/08/2026"}]

    Text:
    ${rawText}
  `;
}

// The ONLY impure lib module: it talks to Gemini. Returns tenders:null on any
// failure so the caller leaves the cache untouched and retries next run.
async function extractTenders(rawText, { excerpt = false } = {}) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  try {
    console.log(`🤖 Attempting extraction with model: ${MODEL_NAME}...`);
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
    const usage = { inputTokens: (u && u.promptTokenCount) || 0, outputTokens: (u && u.candidatesTokenCount) || 0 };
    if (u) {
      console.log(`💰 Tokens — input: ${u.promptTokenCount}, output: ${u.candidatesTokenCount}, total: ${u.totalTokenCount}`);
    }
    return { tenders: JSON.parse(result.response.text()), usage };
  } catch (e) {
    console.warn(`❌ Model ${MODEL_NAME} failed (${e.message}). Returning null so cache is NOT updated.`);
    return { tenders: null, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

module.exports = { extractTenders, buildPrompt, MODEL_NAME, TENDER_ARRAY_SCHEMA };
```

- [ ] **Step 2: Delete `processWithAI` from `main.js`**

Remove `main.js:34-77` entirely. Remove the now-unused `GoogleGenerativeAI` require and the `genAI` constant (`main.js:3`, `main.js:13`). Add:

```js
const { extractTenders } = require('./lib/ai');
```

- [ ] **Step 3: Syntax check**

Run: `node --check main.js && node --check lib/ai.js && npm test`
Expected: silent, then all tests PASS. (`main.js` still has two `processWithAI(...)` call sites — Task 6 fixes them. `node --check` only parses, so this passes.)

- [ ] **Step 4: Commit**

```bash
git add lib/ai.js main.js
git commit -m "feat: extract Gemini call into lib/ai.js with responseSchema

Structured output guarantees conforming JSON, retiring the fence-strip
regex. Shared so scripts/accuracy.js exercises the exact production path."
```

---

### Task 6: Wire validation and health into `main.js`

**The critical constraint: the cache stores RAW merged tenders. Validation is a delivery-time filter only.** Caching validated tenders would flip a degraded tender's `upsertKey` from `num:` to `title:` and produce duplicates on a later run. See the spec section "The cache stores RAW merged tenders, not validated ones".

**Files:**
- Modify: `main.js` — requires; the `pendingDelivery` resend path (~`main.js:132-145`); the `processWithAI` call sites (~`main.js:151-162`); the delivery block (~`main.js:173-192`)
- Test: manual — verified by Task 8's harness and a live run

**Interfaces:**
- Consumes: `validateTenders` (Task 3), `assessSite` (Task 4), `extractTenders` (Task 5)
- Produces: nothing importable

- [ ] **Step 1: Add the requires**

```js
const { validateTenders } = require('./lib/validate');
const { assessSite, LEVELS } = require('./lib/health');
```

- [ ] **Step 2: Add a shared delivery helper**

Insert above `async function run()`. Both delivery paths must validate, so the logic lives once.

```js
// Validates immediately before delivery and reports health. The cache is
// written by the caller with the RAW merged list — never with `kept`.
async function validateAndDeliver(rawTenders, cleanedText, previousTenders) {
  const { kept, dropped, histogram } = validateTenders(rawTenders, cleanedText);

  if (dropped.length > 0) {
    console.log(`🚫 Validation dropped ${dropped.length} tender(s) not found on the page:`);
    for (const d of dropped) console.log(`   - "${(d.tender.title || '').slice(0, 60)}" [${d.issues.join(', ')}]`);
  }
  const issueSummary = Object.entries(histogram).map(([k, v]) => `${k}=${v}`).join(' ');
  if (issueSummary) console.log(`⚠️ Validation issues: ${issueSummary}`);

  const health = assessSite({
    previousTenders,
    mergedTenders: kept,
    cleanedTextLength: cleanedText.length,
    issueHistogram: histogram
  });
  if (health.level === LEVELS.ALERT) {
    console.log(`🔴 HEALTH ALERT: ${health.signals.join(', ')}`);
    RUN_STATS.alerts++;
  } else if (health.level === LEVELS.WARN) {
    console.log(`🟡 Health warning: ${health.signals.join(', ')}`);
    RUN_STATS.warnings++;
  }

  const ok = kept.length > 0 ? await deliverToWebhook(kept) : false;
  return { ok, kept, health };
}
```

- [ ] **Step 3: Extend `RUN_STATS`**

```js
const RUN_STATS = { aiCalls: 0, inputTokens: 0, outputTokens: 0, alerts: 0, warnings: 0, dropped: 0 };
```

- [ ] **Step 4: Update the two `processWithAI` call sites**

`extractTenders` returns an object, and stats now accumulate in `main.js`:

```js
      let newTenders = [];
      if (useFullPath) {
        const reason = !siteEntry ? "first run / legacy cache" : "diff too large — safety fallback";
        console.log(`📄 Full extraction (${reason}): sending ${cleanedCityText.length} chars to AI...`);
        const r = await extractTenders(cleanedCityText);
        newTenders = r.tenders;
        if (r.tenders !== null) { RUN_STATS.aiCalls++; RUN_STATS.inputTokens += r.usage.inputTokens; RUN_STATS.outputTokens += r.usage.outputTokens; }
      } else if (addedKeys.length > 0) {
        const chunks = buildChunks(entries, addedKeys);
        const excerptText = chunks.join('\n---\n');
        console.log(`✂️ Incremental: ${addedKeys.length} new / ${removedKeys.length} removed lines → sending only ${excerptText.length} of ${cleanedCityText.length} chars to AI...`);
        const r = await extractTenders(excerptText, { excerpt: true });
        newTenders = r.tenders;
        if (r.tenders !== null) { RUN_STATS.aiCalls++; RUN_STATS.inputTokens += r.usage.inputTokens; RUN_STATS.outputTokens += r.usage.outputTokens; }
      } else {
        console.log(`🗑️ Removals only (${removedKeys.length} lines gone) — no AI call needed. 0 tokens.`);
      }
```

- [ ] **Step 5: Update the `pendingDelivery` resend path**

Replace the body of the `if (siteEntry.pendingDelivery && ...)` branch. `cleanedCityText` is already in scope here.

```js
        if (siteEntry.pendingDelivery && siteEntry.tenders.length > 0) {
          console.log(`📡 Content unchanged but last delivery failed — resending ${siteEntry.tenders.length} cached tenders (0 tokens)...`);
          const { ok } = await validateAndDeliver(siteEntry.tenders, cleanedCityText, siteEntry.tenders);
          if (ok) {
            cache[muni.url] = makeSiteEntry(siteEntry.stableKeys, siteEntry.tenders, false);
            saveCache(cache);
            console.log(`✅ Webhook accepted pending delivery. Cache updated.`);
          }
        } else {
```

Note `siteEntry.tenders` is passed as BOTH the list and `previousTenders` — an unchanged page should never look like a collapse.

- [ ] **Step 6: Update the delivery block — cache RAW, deliver validated**

```js
      if (merged.length > 0) {
        // Save BEFORE delivery: a webhook failure must never cost a second AI call.
        // RAW merged, never the validated list — validation would flip a degraded
        // tender's upsertKey from num: to title: and duplicate it next run.
        cache[muni.url] = makeSiteEntry(newKeys, merged, true);
        saveCache(cache);

        console.log(`📡 Streaming structured tenders to Lovable Webhook...`);
        const { ok, kept } = await validateAndDeliver(merged, cleanedCityText, siteEntry ? siteEntry.tenders : []);
        RUN_STATS.dropped += merged.length - kept.length;

        if (ok) {
          cache[muni.url] = makeSiteEntry(newKeys, merged, false);
          saveCache(cache);
          console.log(`✅ Webhook Accepted! Status: 200. Delivered ${kept.length}/${merged.length} validated. Cache updated.`);
        } else {
          console.log(`⚠️ Webhook returned unexpected status. Extraction saved — will resend next run without AI.`);
        }
      } else if (cleanedCityText.length > 1500) {
```

- [ ] **Step 7: Extend the run summary**

Replace the `💰 AI calls:` line at the end of `run()`:

```js
  console.log(`💰 AI calls: ${RUN_STATS.aiCalls}/${MUNICIPALITIES.length} sites | input tokens: ${RUN_STATS.inputTokens} | output tokens: ${RUN_STATS.outputTokens}`);
  console.log(`🩺 Health: ${RUN_STATS.alerts} alert(s), ${RUN_STATS.warnings} warning(s) | validation dropped ${RUN_STATS.dropped} tender(s)`);
```

- [ ] **Step 8: Verify**

Run: `node --check main.js && npm test`
Expected: silent, then PASS. Confirm by reading the diff that **no `makeSiteEntry` call receives `kept`** — every one receives `merged` or `siteEntry.tenders`.

- [ ] **Step 9: Commit**

```bash
git add main.js
git commit -m "feat: validate at delivery time and report site health

Cache keeps RAW merged tenders so upsert identity stays stable; only the
webhook payload is validated. Both delivery paths (normal + pendingDelivery
resend) validate. Save-before-deliver invariant preserved."
```

---

### Task 7: Capture ground-truth fixtures

**Files:**
- Create: `scripts/capture-fixture.js`
- Create: `test/fixtures/ground-truth/<site>.txt` × 5 (generated)
- Create: `test/fixtures/ground-truth/<site>.expected.json` × 5 (**hand-written by a human**)
- Test: `test/fixtures.test.js`

**Interfaces:**
- Consumes: `MUNICIPALITIES` (Task 1), `superCleanText` (existing `lib/text.js`)
- Produces: fixture files consumed by Task 8

This script scrapes but makes **no AI calls** — it is free to run.

- [ ] **Step 1: Create `scripts/capture-fixture.js`**

```js
// Captures the cleaned page text for a site as a ground-truth fixture.
// FREE: scrapes only, never calls Gemini.
// Usage: node scripts/capture-fixture.js tel-aviv
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { MUNICIPALITIES } = require('../lib/sites');
const { superCleanText } = require('../lib/text');

const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'ground-truth');

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error('Usage: node scripts/capture-fixture.js <site-key>');
    console.error('Site keys are the scraper basenames, e.g. tel-aviv, holon, haifa');
    process.exit(1);
  }
  const site = MUNICIPALITIES.find(m => m.script.endsWith(`/${key}.js`));
  if (!site) {
    console.error(`Unknown site "${key}". Known: ${MUNICIPALITIES.map(m => path.basename(m.script, '.js')).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Absolute path: site.script is './scrapers/x.js' relative to the repo
    // root, but this file lives in scripts/.
    const scraperPath = path.join(__dirname, '..', site.script.replace('./', ''));
    const scrapeResult = await require(scraperPath).scrape(page);
    const pages = Array.isArray(scrapeResult) ? scrapeResult : [scrapeResult];

    let raw = '';
    for (let p = 0; p < pages.length; p++) raw += `\n--- PAGE ${p + 1} ---\n` + pages[p];
    const cleaned = superCleanText(raw);

    const outFile = path.join(OUT_DIR, `${key}.txt`);
    fs.writeFileSync(outFile, cleaned, 'utf8');
    console.log(`✅ Wrote ${outFile} (${cleaned.length} chars, ${pages.length} page(s))`);
    console.log(`\n👉 Now hand-label ${key}.expected.json by READING ${key}.txt yourself.`);
    console.log(`   Do NOT generate it with AI — that would make the ground truth measure the AI against itself.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
```

- [ ] **Step 2: Capture the five fixtures**

Run each (Tel Aviv first — it is the prime suspect):

```bash
node scripts/capture-fixture.js tel-aviv
node scripts/capture-fixture.js holon
node scripts/capture-fixture.js haifa
node scripts/capture-fixture.js herzliya
node scripts/capture-fixture.js hacal-modiin
```

Expected: five `.txt` files in `test/fixtures/ground-truth/`. Rough sizes measured 2026-07-15: tel-aviv ~46K, holon ~11K, herzliya ~12K, haifa ~2K, hacal-modiin ~0.7K.

- [ ] **Step 3: Hand-label the expected tenders — HUMAN TASK**

For each `<site>.txt`, **read it and write `<site>.expected.json` by hand**:

```json
[
  { "title": "מכרז פומבי לאספקת שירותי ניקיון", "tender_number": "47/2026", "deadline_date": "15/08/2026" }
]
```

Rules:
- Use `"אין"` when the page genuinely has no number or no date.
- Include every ACTIVE/OPEN tender in the text, matching the production prompt's definition.
- Format dates `DD/MM/YYYY`, numbers `NUMBER/YEAR`.
- **Never generate this file with an LLM.** Ground truth produced by the system under test measures nothing.

- [ ] **Step 4: Write the fixture-integrity test**

Create `test/fixtures.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { normalizeForTitleMatch, titleOnPage } = require('../lib/merge');

const DIR = path.join(__dirname, 'fixtures', 'ground-truth');

test('every ground-truth fixture is a valid pair and its tenders are on the page', () => {
  if (!fs.existsSync(DIR)) return; // fixtures not captured yet
  const texts = fs.readdirSync(DIR).filter(f => f.endsWith('.txt'));
  assert.ok(texts.length > 0, 'no fixtures captured');

  for (const t of texts) {
    const key = path.basename(t, '.txt');
    const expectedFile = path.join(DIR, `${key}.expected.json`);
    assert.ok(fs.existsSync(expectedFile), `${key}.expected.json missing — hand-label it`);

    const pageText = fs.readFileSync(path.join(DIR, t), 'utf8');
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    assert.ok(Array.isArray(expected), `${key}.expected.json must be an array`);

    const norm = normalizeForTitleMatch(pageText);
    for (const tender of expected) {
      assert.ok(tender.title && tender.title.length > 0, `${key}: tender with empty title`);
      assert.ok('tender_number' in tender, `${key}: "${tender.title}" missing tender_number`);
      assert.ok('deadline_date' in tender, `${key}: "${tender.title}" missing deadline_date`);
      assert.ok(titleOnPage(tender.title, norm), `${key}: labeled title not found in .txt — "${tender.title}"`);
    }
  }
});
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS. A failure here means a hand-labeled title is not actually in the captured text — fix the label, not the test.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-fixture.js test/fixtures/ground-truth test/fixtures.test.js
git commit -m "test: add ground-truth fixtures and capture script

Five hand-labeled sites, Tel Aviv first. Capture is free (no AI calls);
labels are human-written so the harness measures the AI, not itself."
```

---

### Task 8: `scripts/accuracy.js` and `npm run accuracy`

**Files:**
- Create: `scripts/accuracy.js`
- Modify: `package.json:6-8` (scripts)
- Test: none — this IS the measurement tool. **It is billable and must never run in `npm test`.**

**Interfaces:**
- Consumes: `extractTenders` (Task 5), `validateTenders` (Task 3), fixtures (Task 7)
- Produces: a precision/recall report on stdout

- [ ] **Step 1: Add the npm script**

`package.json`:

```json
  "scripts": {
    "test": "node --test test/*.test.js",
    "accuracy": "node scripts/accuracy.js"
  },
```

- [ ] **Step 2: Create `scripts/accuracy.js`**

```js
// Scores real extraction against hand-labeled ground truth.
// BILLABLE: one Gemini call per fixture (~5 total). Never run from npm test.
// Usage: npm run accuracy [-- --site=tel-aviv]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractTenders } = require('../lib/ai');
const { validateTenders } = require('../lib/validate');
const { normalizeForTitleMatch, baseNumber } = require('../lib/merge');

const DIR = path.join(__dirname, '..', 'test', 'fixtures', 'ground-truth');

// Same identity rule as the merge path, so the harness and production agree
// on what "the same tender" means.
function identity(t) {
  const base = baseNumber(t.tender_number);
  return base !== 'אין' ? `num:${base}` : `title:${normalizeForTitleMatch(t.title).slice(0, 30)}`;
}

function scoreSite(expected, actual) {
  const expMap = new Map(expected.map(t => [identity(t), t]));
  const actMap = new Map(actual.map(t => [identity(t), t]));

  let truePositives = 0;
  const fieldHits = { title: 0, tender_number: 0, deadline_date: 0 };
  const mismatches = [];

  for (const [key, exp] of expMap) {
    const got = actMap.get(key);
    if (!got) continue;
    truePositives++;
    for (const field of ['title', 'tender_number', 'deadline_date']) {
      if ((got[field] || '') === (exp[field] || '')) fieldHits[field]++;
      else mismatches.push({ key, field, expected: exp[field], got: got[field] });
    }
  }

  const missed = [...expMap.keys()].filter(k => !actMap.has(k));
  const spurious = [...actMap.keys()].filter(k => !expMap.has(k));

  return {
    expected: expected.length,
    actual: actual.length,
    truePositives,
    missed,
    spurious,
    precision: actual.length ? truePositives / actual.length : 0,
    recall: expected.length ? truePositives / expected.length : 0,
    fieldHits,
    mismatches
  };
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

async function main() {
  const only = (process.argv.find(a => a.startsWith('--site=')) || '').split('=')[1];
  if (!fs.existsSync(DIR)) {
    console.error(`No fixtures at ${DIR}. Run: node scripts/capture-fixture.js <site>`);
    process.exit(1);
  }
  let keys = fs.readdirSync(DIR).filter(f => f.endsWith('.txt')).map(f => path.basename(f, '.txt'));
  if (only) keys = keys.filter(k => k === only);
  if (keys.length === 0) { console.error('No matching fixtures.'); process.exit(1); }

  console.log(`💸 BILLABLE: ${keys.length} Gemini call(s).\n`);

  const totals = { expected: 0, actual: 0, tp: 0, title: 0, number: 0, date: 0 };
  const histogram = {};

  for (const key of keys) {
    const pageText = fs.readFileSync(path.join(DIR, `${key}.txt`), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(DIR, `${key}.expected.json`), 'utf8'));

    const { tenders } = await extractTenders(pageText);
    if (tenders === null) { console.log(`❌ ${key}: extraction failed\n`); continue; }

    const { kept, histogram: h } = validateTenders(tenders, pageText);
    for (const [k, v] of Object.entries(h)) histogram[k] = (histogram[k] || 0) + v;

    const s = scoreSite(expected, kept);
    totals.expected += s.expected; totals.actual += s.actual; totals.tp += s.truePositives;
    totals.title += s.fieldHits.title; totals.number += s.fieldHits.tender_number; totals.date += s.fieldHits.deadline_date;

    console.log(`── ${key}`);
    console.log(`   expected ${s.expected} | extracted ${s.actual} | matched ${s.truePositives}`);
    console.log(`   precision ${pct(s.precision)} | recall ${pct(s.recall)}`);
    if (s.missed.length) console.log(`   MISSED:    ${s.missed.slice(0, 5).join(' | ')}`);
    if (s.spurious.length) console.log(`   SPURIOUS:  ${s.spurious.slice(0, 5).join(' | ')}`);
    for (const m of s.mismatches.slice(0, 5)) {
      console.log(`   FIELD ${m.field}: expected "${m.expected}" got "${m.got}"`);
    }
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('AGGREGATE');
  console.log('='.repeat(60));
  console.log(`precision            ${pct(totals.actual ? totals.tp / totals.actual : 0)}`);
  console.log(`recall               ${pct(totals.expected ? totals.tp / totals.expected : 0)}`);
  if (totals.tp > 0) {
    console.log(`title accuracy       ${pct(totals.title / totals.tp)}`);
    console.log(`tender_number acc.   ${pct(totals.number / totals.tp)}`);
    console.log(`deadline_date acc.   ${pct(totals.date / totals.tp)}`);
  }
  const hist = Object.entries(histogram).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`validation issues    ${hist || 'none'}`);
}

main();
```

- [ ] **Step 3: Confirm `npm test` is still free and offline**

Run: `npm test`
Expected: PASS, and **no `💸 BILLABLE` line and no `🤖 Attempting extraction` line in the output.** If either appears, a test is calling Gemini — fix it before continuing.

- [ ] **Step 4: Run the accuracy harness (BILLABLE)**

Run: `npm run accuracy`
Expected: a per-site and aggregate precision/recall report.

**This step answers the spec's Success Criterion 2.** Record the Tel Aviv verdict: with 46,634 chars yielding 7 cached tenders, either recall is poor (extraction is broken — a real bug to fix in a follow-up) or recall is high (the page genuinely has ~7 tenders and the low yield is just page bloat).

- [ ] **Step 5: Commit**

```bash
git add scripts/accuracy.js package.json
git commit -m "feat: add npm run accuracy ground-truth harness

Scores real extraction against hand-labeled fixtures: precision, recall,
per-field accuracy, validation histogram. Billable and explicit; npm test
stays offline and free."
```

---

## Definition of Done

- [ ] `npm test` passes, runs offline, makes zero AI calls
- [ ] `npm run accuracy` prints precision/recall per field (Success Criterion 1 — *any* number is a win; there is none today)
- [ ] Tel Aviv's 7-tenders-from-46K-chars has a verdict (Success Criterion 2)
- [ ] No `makeSiteEntry` call anywhere receives a validated list (Success Criterion 3's identity guarantee)
- [ ] A site whose yield collapses >50% logs `🔴 HEALTH ALERT` (Success Criterion 4)
- [ ] `git diff main` shows **no changes to `scrapers/*.js`** and **no change to the cache schema** in `lib/cache.js`
- [ ] Webhook payload shape unchanged: still `POST { tenders: [...] }` with `x-webhook-key`

## Out of Scope

Deferred by the spec — do not implement here:

- Digit-aware content hashing (Phase 2). `deadline_date` can still go silently stale; that is known and accepted for this phase.
- Per-site cache records / pluggable storage (Phase 2)
- Config-driven paginator (Phase 3)
- Concurrency (Phase 4)
- Alerting/notification on health signals (Phase 5) — this phase logs only
