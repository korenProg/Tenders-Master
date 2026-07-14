# Incremental Line-Diff Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Gemini token costs by sending only *changed* page lines to the AI instead of full pages, per the approved spec at `docs/superpowers/specs/2026-07-14-incremental-diff-extraction-design.md`.

**Architecture:** The per-site cache changes from one MD5 string to `{ stableKeys, tenders, pendingDelivery }`. Each run diffs the page's stable line keys against the cache: unchanged → skip; small diff → AI sees only new lines (±3 lines context); removals → zero-token string matching; big diff / no cache → today's full-page path. The webhook always receives the full merged tender list — its contract is untouched.

**Tech Stack:** Node.js (CommonJS), Puppeteer, `@google/generative-ai`, axios, Node built-in `node:test` runner. No new dependencies.

## Global Constraints

- CommonJS modules only (`require`/`module.exports`) — `package.json` has `"type": "commonjs"`.
- Node ≥ 18 (already required by Puppeteer 25). Tests use the built-in `node:test` runner — do NOT add jest/mocha/etc.
- No new npm dependencies of any kind.
- Webhook payload must stay exactly `{ tenders: [...] }` POSTed with headers `Content-Type: application/json` and `x-webhook-key` — the Lovable side is a black box and must not need changes.
- Each tender object keeps exactly these fields: `title`, `tender_number`, `deadline_date`, `publisher`, `source_url`.
- Cache file stays `./tenders_cache.json`. Legacy entries (plain md5 strings) must be tolerated: treated as "no incremental data" → full extraction path once, then rewritten as v2.
- `scrapers/*.js` must not be modified.
- Keep the existing console log style (Hebrew-friendly, emoji-prefixed).
- Every commit message ends with the trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

- `lib/text.js` — text cleaning + stable key computation (pure functions moved out of `main.js`)
- `lib/cache.js` — cache load/save + v2 entry helpers + legacy migration
- `lib/diff.js` — key diffing, too-large check, context chunk building
- `lib/merge.js` — zero-token removal matching, upsert merge, tender-number normalization
- `main.js` — orchestration only (browser, scraper dispatch, AI call, webhook, cache updates)
- `test/text.test.js`, `test/cache.test.js`, `test/diff.test.js`, `test/merge.test.js`

---

### Task 1: `lib/text.js` — cleaning and stable keys

**Files:**
- Create: `lib/text.js`
- Create: `test/text.test.js`
- Modify: `package.json` (test script)
- Reference: `main.js:30-57` (existing `superCleanText`), `main.js:153-168` (existing stable-lines logic being converted)

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `superCleanText(text: string): string` — identical behavior to the current function in `main.js:30-57`.
  - `stableKey(line: string): string | null` — the per-line identity used for diffing; `null` means "noise line, not diffable".
  - `buildEntries(cleanedText: string): Array<{ line: string, key: string | null }>` — one entry per line of the cleaned text, `line` preserved verbatim (digits intact).

- [ ] **Step 1: Check Node version supports the built-in test runner**

Run: `node --version`
Expected: `v18.x` or higher.

- [ ] **Step 2: Add the test script to package.json**

In `package.json`, replace the `scripts` block:

```json
  "scripts": {
    "test": "node --test test/"
  },
```

- [ ] **Step 3: Write the failing tests**

Create `test/text.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { superCleanText, stableKey, buildEntries } = require('../lib/text');

test('superCleanText drops junk lines and keeps tender lines', () => {
  const raw = 'הצהרת נגישות\nמכרז פומבי 12/2026 להפעלת מזנון בבית הספר\n{ var x = 1; }';
  const out = superCleanText(raw);
  assert.ok(out.includes('מכרז פומבי 12/2026'));
  assert.ok(!out.includes('נגישות'));
  assert.ok(!out.includes('var x'));
});

test('stableKey returns null for noise and empty lines', () => {
  assert.strictEqual(stableKey(''), null);
  assert.strictEqual(stableKey('עמוד 2 מתוך 5'), null); // only noise words
  assert.strictEqual(stableKey('מכרז חדש'), null); // fewer than 4 words
});

test('stableKey strips digits so date-only changes produce the same key', () => {
  const a = stableKey('מכרז פומבי 47/2026 לאספקת שירותי ניקיון עד 15/08/2026');
  const b = stableKey('מכרז פומבי 47/2026 לאספקת שירותי ניקיון עד 30/09/2026');
  assert.ok(a !== null);
  assert.strictEqual(a, b);
});

test('buildEntries keeps original lines verbatim and tags noise lines with null key', () => {
  const text = 'מכרז פומבי לאספקת שירותי ניקיון ברחבי העיר\nעמוד 2 מתוך 5';
  const entries = buildEntries(text);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].line, 'מכרז פומבי לאספקת שירותי ניקיון ברחבי העיר');
  assert.ok(entries[0].key !== null);
  assert.strictEqual(entries[1].line, 'עמוד 2 מתוך 5');
  assert.strictEqual(entries[1].key, null);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/text'`.

- [ ] **Step 5: Write the implementation**

Create `lib/text.js`. `superCleanText` is copied **verbatim** from `main.js:30-57`; `stableKey` reproduces the exact per-line transformation from `main.js:161-168`:

```js
const JUNK_WORDS = [
  "נגישות", "הצהרת נגישות", "מפת האתר", "כל הזכויות שמורות", "צור קשר",
  "פייסבוק", "טוויטר", "יוטיוב", "אינסטגרם", "דילוג לתוכן", "מוקדי שירות",
  "דלג לתוכן המרכזי", "שירות לאזרח", "מדיניות פרטיות", "תנאי שימוש",
  "sharepoint", "session", "token", "powered by", "webpack",
  "חדשות", "מבזק", "אירועים", "לוח אירועים"
];

const NOISE_WORDS = new Set([
  "יום", "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת",
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
  "שעה", "שעות", "דקה", "דקות", "שניה", "שניות", "היום", "מחר", "אתמול",
  "תאריך", "עודכן", "אחרון", "פורסם", "צפיות", "קוראים", "תגובות",
  "עמוד", "דף", "מתוך", "הבא", "הקודם", "הבאים", "קודמים", "לפני", "הצג", "עוד"
]);

function superCleanText(text) {
  if (!text) return "";
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.length === 0) return false;
      if (line.includes("{") || line.includes("}") || line.includes("]=") || line.includes("typeof") || line.includes("!important") || line.includes("-->")) return false;

      const englishAndSpecs = line.match(/[a-zA-Z0-9_\-\/]/g) || [];
      if (line.length > 40 && (englishAndSpecs.length / line.length) > 0.6) return false;

      if (line.length < 100) {
        return !JUNK_WORDS.some(word => line.toLowerCase().includes(word.toLowerCase()));
      }
      return true;
    })
    .join('\n')
    .replace(/[ \t]+/g, ' ');
}

// The per-line identity used for diffing. Digits are stripped so dynamic
// numbers (dates, view counters) don't create false diffs — same trade-off
// as the old whole-page hash.
function stableKey(line) {
  const cleanLine = line.replace(/\d+/g, '').replace(/[^\u0590-\u05FFa-zA-Z\s]/g, ' ').trim();
  const words = cleanLine.split(/\s+/).filter(w => w.length > 1 && !NOISE_WORDS.has(w));
  if (words.length < 4) return null;
  return words.join(' ');
}

function buildEntries(cleanedText) {
  return cleanedText.split('\n').map(line => ({ line, key: stableKey(line) }));
}

module.exports = { superCleanText, stableKey, buildEntries };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/text.js test/text.test.js package.json
git commit -m "feat: extract text cleaning and stable-key logic into lib/text

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/cache.js` — v2 cache schema with legacy migration

**Files:**
- Create: `lib/cache.js`
- Create: `test/cache.test.js`
- Reference: `main.js:59-67` (existing `loadCache`/`saveCache`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadCache(file?: string): object` — parse `./tenders_cache.json` (default), `{}` on missing/corrupt.
  - `saveCache(cache: object, file?: string): void`
  - `getSiteEntry(cache: object, url: string): SiteEntry | null` — returns the entry only if it is valid v2; `null` for missing entries AND legacy md5 strings (callers then take the full-extraction path).
  - `makeSiteEntry(stableKeys: string[], tenders: Tender[], pendingDelivery: boolean): SiteEntry` where `SiteEntry = { version: 2, stableKeys, tenders, pendingDelivery, updatedAt: string }`.
  - `CACHE_FILE: string` — `'./tenders_cache.json'`.

- [ ] **Step 1: Write the failing tests**

Create `test/cache.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCache, saveCache, getSiteEntry, makeSiteEntry } = require('../lib/cache');

test('getSiteEntry returns null for missing and legacy md5-string entries', () => {
  const cache = { 'https://a': 'deadbeefdeadbeefdeadbeefdeadbeef' };
  assert.strictEqual(getSiteEntry(cache, 'https://a'), null);
  assert.strictEqual(getSiteEntry(cache, 'https://missing'), null);
});

test('getSiteEntry returns null for malformed objects', () => {
  const cache = { 'https://a': { version: 2, stableKeys: 'not-an-array', tenders: [] } };
  assert.strictEqual(getSiteEntry(cache, 'https://a'), null);
});

test('getSiteEntry returns valid v2 entries as-is', () => {
  const entry = makeSiteEntry(['k1'], [], false);
  const cache = { 'https://a': entry };
  assert.strictEqual(getSiteEntry(cache, 'https://a'), entry);
});

test('makeSiteEntry stamps version, flag and timestamp', () => {
  const entry = makeSiteEntry(['k1'], [{ title: 'מכרז' }], true);
  assert.strictEqual(entry.version, 2);
  assert.strictEqual(entry.pendingDelivery, true);
  assert.deepStrictEqual(entry.stableKeys, ['k1']);
  assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)));
});

test('cache round-trips through disk and returns {} for missing file', () => {
  const file = path.join(os.tmpdir(), `cache-test-${Date.now()}.json`);
  assert.deepStrictEqual(loadCache(file), {});
  const cache = { 'https://a': makeSiteEntry(['k1'], [{ title: 'מכרז' }], true) };
  saveCache(cache, file);
  assert.deepStrictEqual(loadCache(file), cache);
  fs.unlinkSync(file);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `test/cache.test.js` FAILS with `Cannot find module '../lib/cache'` (text tests still pass).

- [ ] **Step 3: Write the implementation**

Create `lib/cache.js`:

```js
const fs = require('fs');

const CACHE_FILE = './tenders_cache.json';

function loadCache(file = CACHE_FILE) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
  }
  return {};
}

function saveCache(cache, file = CACHE_FILE) {
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
}

// Returns a valid v2 entry, or null when there is no usable incremental data:
// missing entry, legacy md5-string format, or malformed object. Callers must
// treat null as "run the full-extraction path".
function getSiteEntry(cache, url) {
  const entry = cache[url];
  if (!entry || typeof entry !== 'object' || entry.version !== 2) return null;
  if (!Array.isArray(entry.stableKeys) || !Array.isArray(entry.tenders)) return null;
  return entry;
}

function makeSiteEntry(stableKeys, tenders, pendingDelivery) {
  return {
    version: 2,
    stableKeys,
    tenders,
    pendingDelivery,
    updatedAt: new Date().toISOString()
  };
}

module.exports = { loadCache, saveCache, getSiteEntry, makeSiteEntry, CACHE_FILE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (text + cache).

- [ ] **Step 5: Commit**

```bash
git add lib/cache.js test/cache.test.js
git commit -m "feat: add v2 cache schema with legacy md5 migration in lib/cache

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `lib/diff.js` — key diffing and context chunks

**Files:**
- Create: `lib/diff.js`
- Create: `test/diff.test.js`

**Interfaces:**
- Consumes: `entries` in the shape produced by `buildEntries` from `lib/text.js` (`Array<{ line, key }>`).
- Produces:
  - `diff(cachedKeys: string[], entries: Array<{line, key}>): { addedKeys: string[], removedKeys: string[], newKeys: string[] }` — `newKeys` is the deduplicated set of non-null keys currently on the page (this is what gets saved back to the cache).
  - `isDiffTooLarge(addedKeys: string[], removedKeys: string[], cachedCount: number, newCount: number): boolean` — the spec's >50% safety valve; also `true` when both counts are 0.
  - `buildChunks(entries: Array<{line, key}>, addedKeys: string[], window?: number): string[]` — merged ±`window` (default 3) line excerpts around added lines, original text with digits intact.

- [ ] **Step 1: Write the failing tests**

Create `test/diff.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { diff, isDiffTooLarge, buildChunks } = require('../lib/diff');

test('diff detects added and removed keys, ignoring null-key noise lines', () => {
  const entries = [
    { line: 'שורה א', key: 'k1' },
    { line: 'שורה ב', key: 'k2' },
    { line: 'רעש', key: null }
  ];
  const { addedKeys, removedKeys, newKeys } = diff(['k1', 'k3'], entries);
  assert.deepStrictEqual(addedKeys, ['k2']);
  assert.deepStrictEqual(removedKeys, ['k3']);
  assert.deepStrictEqual([...newKeys].sort(), ['k1', 'k2']);
});

test('diff deduplicates repeated keys', () => {
  const entries = [
    { line: 'א', key: 'k1' },
    { line: 'ב', key: 'k1' }
  ];
  const { newKeys } = diff([], entries);
  assert.deepStrictEqual(newKeys, ['k1']);
});

test('isDiffTooLarge triggers above 50% and on empty pages', () => {
  assert.strictEqual(isDiffTooLarge(['a', 'b', 'c'], [], 4, 4), true);  // 3/4 > 0.5
  assert.strictEqual(isDiffTooLarge(['a'], ['b'], 4, 4), false);        // 2/4 = 0.5 → not "too large"
  assert.strictEqual(isDiffTooLarge([], [], 0, 0), true);               // nothing to compare → fall back
});

test('buildChunks merges overlapping windows into one chunk of original lines', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push({ line: `line${i}`, key: `k${i}` });
  const chunks = buildChunks(entries, ['k5', 'k7'], 3); // windows 2-8 and 4-10 overlap
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].startsWith('line2'));
  assert.ok(chunks[0].endsWith('line10'));
});

test('buildChunks returns separate chunks for distant additions', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push({ line: `line${i}`, key: `k${i}` });
  const chunks = buildChunks(entries, ['k2', 'k20'], 3);
  assert.strictEqual(chunks.length, 2);
});

test('buildChunks clamps windows at page boundaries and returns [] with no additions', () => {
  const entries = [{ line: 'a', key: 'k0' }, { line: 'b', key: 'k1' }];
  assert.deepStrictEqual(buildChunks(entries, ['k0'], 3), ['a\nb']);
  assert.deepStrictEqual(buildChunks(entries, [], 3), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `test/diff.test.js` FAILS with `Cannot find module '../lib/diff'`.

- [ ] **Step 3: Write the implementation**

Create `lib/diff.js`:

```js
function diff(cachedKeys, entries) {
  const cachedSet = new Set(cachedKeys);
  const newKeySet = new Set(entries.map(e => e.key).filter(k => k !== null));
  const addedKeys = [...newKeySet].filter(k => !cachedSet.has(k));
  const removedKeys = [...cachedSet].filter(k => !newKeySet.has(k));
  return { addedKeys, removedKeys, newKeys: [...newKeySet] };
}

// Safety valve from the spec: when more than half the page changed (redesign,
// scraper glitch, corrupt cache), fall back to full-page extraction.
function isDiffTooLarge(addedKeys, removedKeys, cachedCount, newCount) {
  const denominator = Math.max(cachedCount, newCount);
  if (denominator === 0) return true;
  return (addedKeys.length + removedKeys.length) / denominator > 0.5;
}

// Excerpts sent to the AI: ±window lines around every added line, overlapping
// or adjacent windows merged, original text preserved (digits intact — noise
// lines are cheap and give the model context for split tender rows).
function buildChunks(entries, addedKeys, window = 3) {
  const addedSet = new Set(addedKeys);
  const ranges = [];
  entries.forEach((e, i) => {
    if (e.key === null || !addedSet.has(e.key)) return;
    const start = Math.max(0, i - window);
    const end = Math.min(entries.length - 1, i + window);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  });
  return ranges.map(r => entries.slice(r.start, r.end + 1).map(e => e.line).join('\n'));
}

module.exports = { diff, isDiffTooLarge, buildChunks };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/diff.js test/diff.test.js
git commit -m "feat: add line-key diffing, safety valve and context chunks in lib/diff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `lib/merge.js` — removal matching and upsert merge

**Files:**
- Create: `lib/merge.js`
- Create: `test/merge.test.js`
- Reference: `main.js:193-216` (existing number-fixing/dedup logic being absorbed)

**Interfaces:**
- Consumes: cleaned page text (string, digits intact) and tender objects `{ title, tender_number, deadline_date, publisher?, source_url? }`.
- Produces:
  - `normalizeForTitleMatch(text: string): string` — strips digits/punctuation, collapses whitespace.
  - `tenderStillOnPage(tender: Tender, pageText: string, normalizedPageText: string): boolean` — the spec's zero-token removal check (number regex, then 30-char title fallback).
  - `mergeTenders(cachedTenders: Tender[], newTendersRaw: Tender[], pageText: string, publisher: string, sourceUrl: string): Tender[]` — drops vanished cached tenders, upserts AI-extracted tenders (update-in-place on number match against *cached* tenders; dedup `-2` suffixes for collisions between *new* tenders, exactly like the old full-page path). **Calling it with `cachedTenders = []` reproduces today's full-page finalization** — `main.js` uses this for both paths.

- [ ] **Step 1: Write the failing tests**

Create `test/merge.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeTenders, tenderStillOnPage, normalizeForTitleMatch } = require('../lib/merge');

const PUB = 'עיריית בדיקה';
const URL = 'https://example.muni.il/bids';

function makeTender(over = {}) {
  return {
    title: 'מכרז לאספקת ריהוט משרדי לעירייה',
    tender_number: '12/2026',
    deadline_date: '01/09/2026',
    publisher: PUB,
    source_url: URL,
    ...over
  };
}

function onPage(t, page) {
  return tenderStillOnPage(t, page, normalizeForTitleMatch(page));
}

test('tenderStillOnPage matches the number in several formats', () => {
  const t = makeTender();
  assert.ok(onPage(t, 'רשימת מכרזים: 12/2026 הגשה עד סוף החודש'));
  assert.ok(onPage(t, 'רשימת מכרזים: 12.26 הגשה עד סוף החודש'));
  assert.ok(onPage(t, 'רשימת מכרזים: 12 / 2026 הגשה עד סוף החודש'));
});

test('tenderStillOnPage does not match 12/2026 inside 412/2026 or 12/20261', () => {
  const t = makeTender();
  assert.ok(!onPage(t, 'מכרז 412/2026 בנושא אחר שאין לו קשר'));
  assert.ok(!onPage(t, 'מסמך 12/20261 מספר שגוי ולא קשור'));
});

test('tenderStillOnPage strips the dedup suffix before matching', () => {
  const t = makeTender({ tender_number: '12/2026-2' });
  assert.ok(onPage(t, 'מכרז מספר 12/2026 עדיין פתוח להגשה'));
});

test('tenderStillOnPage falls back to title match when number is missing', () => {
  const t = makeTender({ tender_number: 'אין' });
  assert.ok(onPage(t, 'מכרז לאספקת ריהוט משרדי לעירייה המקומית'));
  assert.ok(!onPage(t, 'מכרז אחר לגמרי בנושא שונה בהחלט'));
});

test('mergeTenders drops vanished cached tenders and appends new ones with publisher', () => {
  const gone = makeTender({ title: 'מכרז ישן שכבר הוסר מהאתר לגמרי', tender_number: '5/2025' });
  const stays = makeTender();
  const pageText = 'מכרז 12/2026 לאספקת ריהוט משרדי\nמכרז חדש 99/2026 לשירותי גינון בפארקים';
  const newRaw = [{ title: 'מכרז חדש לשירותי גינון בפארקים', tender_number: '99/2026', deadline_date: '10/10/2026' }];
  const merged = mergeTenders([gone, stays], newRaw, pageText, PUB, URL);
  assert.deepStrictEqual(merged.map(t => t.tender_number).sort(), ['12/2026', '99/2026']);
  const added = merged.find(t => t.tender_number === '99/2026');
  assert.strictEqual(added.publisher, PUB);
  assert.strictEqual(added.source_url, URL);
});

test('mergeTenders updates an existing cached tender in place instead of duplicating', () => {
  const cached = makeTender({ deadline_date: '01/09/2026' });
  const pageText = 'מכרז 12/2026 לאספקת ריהוט משרדי מוארך עד סוף השנה';
  const newRaw = [{ title: 'מכרז לאספקת ריהוט משרדי לעירייה', tender_number: '12/2026', deadline_date: '30/10/2026' }];
  const merged = mergeTenders([cached], newRaw, pageText, PUB, URL);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].deadline_date, '30/10/2026');
  assert.strictEqual(merged[0].tender_number, '12/2026');
});

test('mergeTenders with empty cache reproduces the old full-page finalization', () => {
  const pageText = 'שני מכרזים שונים שמספרם זהה מופיעים כאן';
  const newRaw = [
    { title: 'מכרז ראשון 7/26 לשיפוץ מבנה ציבור', tender_number: 'אין', deadline_date: 'אין' },
    { title: 'מכרז שני 7/26 לאחזקת גני ילדים', tender_number: 'אין', deadline_date: 'אין' }
  ];
  const merged = mergeTenders([], newRaw, pageText, PUB, URL);
  // number extracted from title, 2-digit year expanded, collision suffixed — like main.js:193-216
  assert.deepStrictEqual(merged.map(t => t.tender_number), ['7/2026', '7/2026-2']);
});

test('mergeTenders keeps tenders with no number via title matching only', () => {
  const cached = makeTender({ tender_number: 'אין' });
  const pageText = 'מכרז לאספקת ריהוט משרדי לעירייה עדיין באוויר';
  const merged = mergeTenders([cached], [], pageText, PUB, URL);
  assert.strictEqual(merged.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `test/merge.test.js` FAILS with `Cannot find module '../lib/merge'`.

- [ ] **Step 3: Write the implementation**

Create `lib/merge.js`:

```js
function normalizeForTitleMatch(text) {
  return (text || '')
    .replace(/\d+/g, '')
    .replace(/[^\u0590-\u05FFa-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseNumber(tenderNumber) {
  return (tenderNumber || 'אין').replace(/-\d+$/, '');
}

// Zero-token removal check. A cached tender is kept if its number appears on
// the page (any of 12/2026, 12.26, 12 / 2026) or the start of its normalized
// title does. Dropped only when BOTH checks fail (spec: prefer false-keep
// over false-drop).
function tenderStillOnPage(tender, pageText, normalizedPageText) {
  const number = baseNumber(tender.tender_number);
  if (number !== 'אין') {
    const m = number.match(/^(\d+)\/(\d{4})$/);
    if (m) {
      const yearShort = m[2].slice(2);
      const re = new RegExp(`(?<!\\d)${m[1]}\\s*[\\/.]\\s*(${m[2]}|${yearShort})(?!\\d)`);
      if (re.test(pageText)) return true;
    } else if (pageText.includes(number)) {
      return true;
    }
  }
  const normTitle = normalizeForTitleMatch(tender.title).slice(0, 30);
  return normTitle.length > 0 && normalizedPageText.includes(normTitle);
}

// Same normalization the old full-page path applied (main.js): prefer a
// NUMBER/YEAR found in the title, expand 2-digit years.
function normalizeNewTender(raw) {
  let fixedNumber = raw.tender_number || 'אין';
  const match = (raw.title || '').match(/(\d+)\s*[\/\.]\s*(\d+)/);
  if (match) {
    let year = match[2];
    if (year.length === 2) year = '20' + year;
    fixedNumber = `${match[1]}/${year}`;
  }
  return { ...raw, tender_number: fixedNumber };
}

function upsertKey(tender) {
  const base = baseNumber(tender.tender_number);
  return base !== 'אין' ? `num:${base}` : `title:${normalizeForTitleMatch(tender.title)}`;
}

function mergeTenders(cachedTenders, newTendersRaw, pageText, publisher, sourceUrl) {
  const normalizedPageText = normalizeForTitleMatch(pageText);
  const merged = cachedTenders.filter(t => tenderStillOnPage(t, pageText, normalizedPageText));
  const keptCount = merged.length;
  const usedNumbers = new Set(merged.map(t => t.tender_number).filter(n => n && n !== 'אין'));

  for (const raw of newTendersRaw) {
    const t = { ...normalizeNewTender(raw), publisher, source_url: sourceUrl };
    const key = upsertKey(t);
    // Upsert only against tenders that came from the cache: two NEW tenders
    // sharing a number must get -2 suffixes, exactly like the old path.
    const existingIdx = merged.findIndex((m, idx) => idx < keptCount && upsertKey(m) === key);
    if (existingIdx !== -1) {
      merged[existingIdx] = { ...t, tender_number: merged[existingIdx].tender_number };
    } else if (t.tender_number !== 'אין') {
      let finalNumber = t.tender_number;
      let counter = 2;
      while (usedNumbers.has(finalNumber)) {
        finalNumber = `${t.tender_number}-${counter}`;
        counter++;
      }
      merged.push({ ...t, tender_number: finalNumber });
      usedNumbers.add(finalNumber);
    } else {
      merged.push(t);
    }
  }
  return merged;
}

module.exports = { normalizeForTitleMatch, tenderStillOnPage, mergeTenders };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/merge.js test/merge.test.js
git commit -m "feat: add zero-token removal matching and upsert merge in lib/merge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Rewire `main.js` to the incremental pipeline

**Files:**
- Modify: `main.js` (full replacement below — `MUNICIPALITIES`, browser setup, and scraper dispatch are preserved verbatim)

**Interfaces:**
- Consumes: everything produced by Tasks 1-4 (`superCleanText`, `buildEntries`, `loadCache`, `saveCache`, `getSiteEntry`, `makeSiteEntry`, `diff`, `isDiffTooLarge`, `buildChunks`, `mergeTenders`).
- Produces: the runnable pipeline. `processWithAI(rawText, { excerpt })` gains an excerpt flag that adds one sentence to the prompt; everything else about the prompt is unchanged.

- [ ] **Step 1: Replace `main.js` with the new orchestration**

The diff decision logic per site is:

1. no valid v2 cache entry → **full path** (first run / legacy migration)
2. zero added & zero removed keys → **skip**, unless `pendingDelivery` → resend cached tenders (0 tokens)
3. diff > 50% → **full path** (safety valve)
4. otherwise → **incremental path**: AI sees only context chunks (or no AI at all for removals-only)

Replace the entire contents of `main.js` with:

```js
const puppeteer = require('puppeteer');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const { superCleanText, buildEntries } = require('./lib/text');
const { loadCache, saveCache, getSiteEntry, makeSiteEntry } = require('./lib/cache');
const { diff, isDiffTooLarge, buildChunks } = require('./lib/diff');
const { mergeTenders } = require('./lib/merge');

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_KEY = process.env.ELIYAHO_WEBHOOK_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

const RUN_STATS = { aiCalls: 0, inputTokens: 0, outputTokens: 0 };

async function processWithAI(rawText, { excerpt = false } = {}) {
  const modelName = "gemini-2.5-flash";

  const excerptNote = excerpt
    ? `\n    NOTE: The text below contains only EXCERPTS from the webpage, separated by "---" lines. It is NOT the full page. Extract every tender visible in these excerpts.\n`
    : "";

  const prompt = `
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

  try {
    console.log(`🤖 Attempting extraction with model: ${modelName}...`);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0.0 }
    });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    if (usage) {
      console.log(`💰 Tokens — input: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, total: ${usage.totalTokenCount}`);
      RUN_STATS.aiCalls++;
      RUN_STATS.inputTokens += usage.promptTokenCount || 0;
      RUN_STATS.outputTokens += usage.candidatesTokenCount || 0;
    }
    let textOut = result.response.text().trim();
    textOut = textOut.replace(/```json|```/g, '').trim();
    return JSON.parse(textOut);
  } catch (e) {
    console.warn(`❌ Model ${modelName} failed (${e.message}). Returning null so cache is NOT updated.`);
    return null;
  }
}

async function deliverToWebhook(tenders) {
  const response = await axios.post(WEBHOOK_URL, { tenders }, {
    headers: { 'Content-Type': 'application/json', 'x-webhook-key': WEBHOOK_KEY }
  });
  return response.status === 200;
}

async function run() {
  console.log("🚀 Starting Incremental Scraper Run (Line-Diff Extraction)...");
  const startTime = Date.now();
  const cache = loadCache();

  for (let i = 0; i < MUNICIPALITIES.length; i++) {
    const muni = MUNICIPALITIES[i];
    console.log(`\n=== [${i + 1}/${MUNICIPALITIES.length}] Processing: ${muni.publisher} ===`);

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
      });

      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(60000);
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      await page.goto(muni.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      const targetModule = require(muni.script);
      const scrapeResult = await targetModule.scrape(page);

      if (!scrapeResult || (typeof scrapeResult === 'string' && scrapeResult.length < 100) || (Array.isArray(scrapeResult) && scrapeResult.length === 0)) {
        console.log(`⚠️ No content extracted for ${muni.publisher}.`);
        await browser.close();
        continue;
      }

      const pages = Array.isArray(scrapeResult) ? scrapeResult : [scrapeResult];

      let fullCityRawText = "";
      for (let p = 0; p < pages.length; p++) {
        fullCityRawText += `\n--- PAGE ${p + 1} ---\n` + pages[p];
      }

      const cleanedCityText = superCleanText(fullCityRawText);
      const entries = buildEntries(cleanedCityText);
      const siteEntry = getSiteEntry(cache, muni.url);
      const cachedKeys = siteEntry ? siteEntry.stableKeys : [];
      const { addedKeys, removedKeys, newKeys } = diff(cachedKeys, entries);

      // Case 1: nothing changed since last run
      if (siteEntry && addedKeys.length === 0 && removedKeys.length === 0) {
        if (siteEntry.pendingDelivery && siteEntry.tenders.length > 0) {
          console.log(`📡 Content unchanged but last delivery failed — resending ${siteEntry.tenders.length} cached tenders (0 tokens)...`);
          if (await deliverToWebhook(siteEntry.tenders)) {
            cache[muni.url] = makeSiteEntry(siteEntry.stableKeys, siteEntry.tenders, false);
            saveCache(cache);
            console.log(`✅ Webhook accepted pending delivery. Cache updated.`);
          }
        } else {
          console.log(`⏭️ Green Light: Website content is IDENTICAL to last run. Skipping AI.`);
        }
        await browser.close();
        continue;
      }

      // Case 2: choose full vs incremental extraction
      const useFullPath = !siteEntry || isDiffTooLarge(addedKeys, removedKeys, cachedKeys.length, newKeys.length);

      let newTenders = [];
      if (useFullPath) {
        const reason = !siteEntry ? "first run / legacy cache" : "diff too large — safety fallback";
        console.log(`📄 Full extraction (${reason}): sending ${cleanedCityText.length} chars to AI...`);
        newTenders = await processWithAI(cleanedCityText);
      } else if (addedKeys.length > 0) {
        const chunks = buildChunks(entries, addedKeys);
        const excerptText = chunks.join('\n---\n');
        console.log(`✂️ Incremental: ${addedKeys.length} new / ${removedKeys.length} removed lines → sending only ${excerptText.length} of ${cleanedCityText.length} chars to AI...`);
        newTenders = await processWithAI(excerptText, { excerpt: true });
      } else {
        console.log(`🗑️ Removals only (${removedKeys.length} lines gone) — no AI call needed. 0 tokens.`);
      }

      if (newTenders === null) {
        console.log(`⚠️ AI extraction failed. Cache NOT updated — will retry next run.`);
        await browser.close();
        continue;
      }

      const merged = mergeTenders(useFullPath ? [] : siteEntry.tenders, newTenders, cleanedCityText, muni.publisher, muni.url);
      console.log(`✨ Merged list: ${merged.length} tenders (${newTenders.length} newly extracted).`);

      if (merged.length > 0) {
        // Save BEFORE delivery: a webhook failure must never cost a second AI call.
        cache[muni.url] = makeSiteEntry(newKeys, merged, true);
        saveCache(cache);

        console.log(`📡 Streaming ${merged.length} structured tenders to Lovable Webhook...`);
        if (await deliverToWebhook(merged)) {
          cache[muni.url] = makeSiteEntry(newKeys, merged, false);
          saveCache(cache);
          console.log(`✅ Webhook Accepted! Status: 200. Cache updated.`);
        } else {
          console.log(`⚠️ Webhook returned unexpected status. Extraction saved — will resend next run without AI.`);
        }
      } else if (cleanedCityText.length > 1500) {
        console.log(`✅ Page verified healthy with 0 active tenders. Updating Cache.`);
        cache[muni.url] = makeSiteEntry(newKeys, [], false);
        saveCache(cache);
      } else {
        console.log(`⚠️ Warning: Page content seems too low or failed. Skipping cache to allow retry.`);
      }

      await browser.close();
      if (i < MUNICIPALITIES.length - 1) {
        await new Promise(r => setTimeout(r, 4000));
      }

    } catch (err) {
      console.error(`❌ Error with ${muni.publisher}:`, err.message);
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
  const minutes = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n════════════════════════════════════════");
  console.log(`🎯 RUN FINISHED in ${minutes} minutes`);
  console.log(`💰 AI calls: ${RUN_STATS.aiCalls}/${MUNICIPALITIES.length} sites | input tokens: ${RUN_STATS.inputTokens} | output tokens: ${RUN_STATS.outputTokens}`);
  console.log("════════════════════════════════════════");
}

run();
```

Note: a webhook network error or non-2xx makes axios throw inside `deliverToWebhook`; the outer `catch` logs it. Because the cache was saved with `pendingDelivery: true` *before* the POST, the next run resends for free — that's intended, not a gap.

- [ ] **Step 2: Verify syntax and that all unit tests still pass**

Run: `node --check main.js && npm test`
Expected: no syntax error; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat: rewire main.js to incremental line-diff extraction pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification against live sites

**Files:**
- No code changes. Uses `main.js`, `tenders_cache.json`, live municipality sites, live webhook.

**Interfaces:**
- Consumes: the complete pipeline from Tasks 1-5.
- Produces: verified success criteria from the spec.

**Cost note:** Step 1 is the one-time migration run — every site takes the full-extraction path because the existing cache is legacy format. This is expected and was accepted in the spec ("first scrape is expensive, that's OK"). Steps 2-4 must be nearly free. Each run POSTs to the live Lovable webhook, which is normal operation for this app.

- [ ] **Step 1: Migration run (full cost, one time)**

Run: `node main.js`
Expected: every site logs `📄 Full extraction (first run / legacy cache)`. After the run, open `tenders_cache.json` and confirm entries are objects with `"version": 2`, a `stableKeys` array, a `tenders` array, and `"pendingDelivery": false`. Some flaky sites may fail with scraper/timeout errors — that's pre-existing behavior; they retry next run.

- [ ] **Step 2: No-change run (must be ~0 tokens)**

Run: `node main.js` (immediately after Step 1)
Expected: every site that succeeded in Step 1 logs `⏭️ Green Light: Website content is IDENTICAL to last run. Skipping AI.` The final stats line shows `AI calls: 0/14` (or only the sites that failed Step 1).

- [ ] **Step 3: Simulated new tender (incremental path)**

Open `tenders_cache.json`, pick a site with a healthy v2 entry, and delete ONE string from its `stableKeys` array (this makes that line look "new" on the next run). Save the file.

Run: `node main.js`
Expected for that site: `✂️ Incremental: 1 new / 0 removed lines → sending only <small> of <big> chars to AI...` where the excerpt size is a small fraction of the page size, followed by a merged-list webhook delivery. All other sites log Green Light. Verify in the stats line that input tokens are a tiny fraction of Step 1's.

- [ ] **Step 4: Simulated removed tender (zero tokens)**

Open `tenders_cache.json`, pick the same site, and:
1. Add a fake key to `stableKeys`: `"מכרז בדיקה מזויף שאיננו קיים באתר"`
2. Add a fake tender to `tenders`: `{ "title": "מכרז בדיקה מזויף שאיננו קיים באתר", "tender_number": "999/2099", "deadline_date": "01/01/2099", "publisher": "<copy from a real tender>", "source_url": "<copy from a real tender>" }`

Run: `node main.js`
Expected for that site: `🗑️ Removals only (1 lines gone) — no AI call needed. 0 tokens.` and the webhook payload no longer contains the fake tender (the merged count returns to the real count). `AI calls: 0` for this site.

- [ ] **Step 5: Commit the verified cache state note**

No code changed in this task. If everything passed, mark the plan checkboxes and commit the plan progress:

```bash
git add docs/superpowers/plans/2026-07-14-incremental-diff-extraction.md
git commit -m "docs: mark E2E verification complete for incremental extraction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
