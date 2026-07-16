# Config-Driven Paginator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 14 near-identical scraper files with one unit-tested generic paginator + thin per-site config, migrating site-by-site with a free scrape-diff equivalence check so no working site is ever broken.

**Architecture:** `lib/paginator.js` splits into a pure `paginate(driver, config)` loop (offline unit tests — the pagination logic's first coverage) and a `makePuppeteerDriver(page, config)` browser adapter holding DOM specifics lifted verbatim from the working scrapers. `main.js` dispatches per row: `script` (custom file, always wins) vs generic. `scripts/scrape-diff.js` proves old-vs-new equivalence per site before its file is deleted.

**Tech Stack:** Node.js (CommonJS), `node:test`, Puppeteer 25 (already installed). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-config-paginator-design.md` (commit `bbafa40` + inline fixes)

## Global Constraints

- **CommonJS only.** No ESM.
- **No new dependencies.**
- **`npm test` stays offline and zero-token.** The driver and scrape-diff are live-browser code and are NEVER exercised by `npm test`.
- **Never run `node main.js`** (14 live sites, real tokens, production webhook). `scripts/scrape-diff.js` is the permitted live tool: it makes **zero Gemini calls and never touches the webhook**.
- **Hebrew unicode ranges in regexes = escape sequences** (`֐-׿`). Hebrew in plain string literals (`'הבא'`) is fine and used here.
- **Scraper contract unchanged:** `main.js` receives `string[]`, joins with `--- PAGE n ---`.
- **`script` wins the dispatch.** A row with both `script` and `pagination` runs the custom file; `pagination` sits dormant for scrape-diff until migration removes `script`.
- **Tasks 1–4 must not change any site's behavior** — all 14 rows keep `script`, so dispatch stays on the custom path throughout. Only Task 5 (migration, per proven site) changes behavior.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/paginator.js` | pure `paginate` loop + `makePuppeteerDriver` adapter + `DEFAULTS` | 1, 2 |
| `test/paginator.test.js` | mock-driver unit tests for the loop | 1 |
| `scripts/scrape-diff.js` | free old-vs-generic equivalence checker | 3 |
| `lib/sites.js` | rows gain optional `pagination` (dormant) | 4 |
| `test/sites.test.js` | allow `script` XOR generic; `pagination` optional object | 4 |
| `main.js` | dispatch custom-vs-generic | 4 |
| `scrapers/*.js` | deleted per site as migration proves equivalence | 5 |

---

### Task 1: pure `paginate` loop

**Files:**
- Create: `lib/paginator.js`
- Test: `test/paginator.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `paginate(driver, config?) → Promise<string[]>` where `driver = { settle(): Promise, readText(): Promise<string>, goNext(): Promise<boolean> }`
  - `DEFAULTS` — `{ iframes:false, networkIdle:false, maxPages:5, settleMs:4000, waitMs:6000, nextTokens:['הבא','next','›','»','לעמוד הבא'] }`
  - Task 2 adds `makePuppeteerDriver` to the same file; Tasks 3–4 import both.

- [ ] **Step 1: Write the failing tests**

Create `test/paginator.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { paginate, DEFAULTS } = require('../lib/paginator');

// Mock driver: scripted page texts + scripted goNext answers.
function mockDriver(texts, nexts = []) {
  const calls = { settle: 0, read: 0, next: 0 };
  return {
    calls,
    settle: async () => { calls.settle++; },
    readText: async () => { calls.read++; return texts[calls.read - 1] ?? ''; },
    goNext: async () => { calls.next++; return nexts[calls.next - 1] ?? false; }
  };
}

const PAGE = (n) => `עמוד ${n} `.repeat(120); // > 500 chars, distinct per n

test('collects pages until goNext says no more', async () => {
  const d = mockDriver([PAGE(1), PAGE(2), PAGE(3)], [true, true, false]);
  const pages = await paginate(d);
  assert.deepStrictEqual(pages, [PAGE(1), PAGE(2), PAGE(3)]);
  assert.strictEqual(d.calls.settle, 1); // settle exactly once, before the loop
});

test('stops at maxPages (default 5)', async () => {
  const texts = [1, 2, 3, 4, 5, 6, 7].map(PAGE);
  const d = mockDriver(texts, [true, true, true, true, true, true]);
  const pages = await paginate(d);
  assert.strictEqual(pages.length, 5);
  assert.strictEqual(DEFAULTS.maxPages, 5);
});

test('maxPages is overridable', async () => {
  const d = mockDriver([PAGE(1), PAGE(2), PAGE(3)], [true, true, true]);
  const pages = await paginate(d, { maxPages: 2 });
  assert.strictEqual(pages.length, 2);
});

test('stops on short text without collecting it', async () => {
  const d = mockDriver([PAGE(1), 'קצר'], [true]);
  assert.deepStrictEqual(await paginate(d), [PAGE(1)]);
});

test('stops on empty first read → returns []', async () => {
  const d = mockDriver(['']);
  assert.deepStrictEqual(await paginate(d), []);
});

test('stops on "Page not found"', async () => {
  const d = mockDriver([PAGE(1), 'x'.repeat(600) + 'Page not found'], [true]);
  assert.deepStrictEqual(await paginate(d), [PAGE(1)]);
});

test('stops when pagination did not change the content', async () => {
  const d = mockDriver([PAGE(1), PAGE(1)], [true]);
  assert.deepStrictEqual(await paginate(d), [PAGE(1)]);
});

test('goNext is not called after the final page', async () => {
  const d = mockDriver([PAGE(1)], [false]);
  await paginate(d);
  assert.strictEqual(d.calls.next, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/paginator.test.js`
Expected: FAIL — `Cannot find module '../lib/paginator'`

- [ ] **Step 3: Implement the loop**

Create `lib/paginator.js`:

```js
// Generic pagination. The pure loop lives here and is unit-tested against a
// mock driver; the Puppeteer adapter (added below) holds the DOM specifics and
// is verified live by scripts/scrape-diff.js, never by npm test.

const DEFAULTS = {
  iframes: false,      // also read/click inside page.frames() — tel-aviv, ashdod, herzliya
  networkIdle: false,  // settle via waitForNetworkIdle instead of a fixed sleep — tel-aviv
  maxPages: 5,
  settleMs: 4000,
  waitMs: 6000,        // >= the longest per-page wait any old scraper used (ashkelon 6000)
  nextTokens: ['הבא', 'next', '›', '»', 'לעמוד הבא']
};

// The stop guards are lifted from the old scrapers: short/404 page, and
// pagination that didn't actually change the content.
async function paginate(driver, config = {}) {
  const maxPages = config.maxPages ?? DEFAULTS.maxPages;
  await driver.settle();
  const pages = [];
  let prev = '';
  for (let i = 0; i < maxPages; i++) {
    const text = await driver.readText();
    if (!text || text.length < 500 || text.includes('Page not found')) break;
    if (text.trim() === prev.trim()) break;
    pages.push(text);
    prev = text;
    if (!(await driver.goNext())) break;
  }
  return pages;
}

module.exports = { paginate, DEFAULTS };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, all suites (54 existing + 8 new = 62).

- [ ] **Step 5: Commit**

```bash
git add lib/paginator.js test/paginator.test.js
git commit -m "feat: add pure paginate loop with mock-driver tests

First-ever unit coverage for the pagination logic shared by all scrapers."
```

---

### Task 2: `makePuppeteerDriver` adapter

**Files:**
- Modify: `lib/paginator.js` (append adapter + export)
- Test: none offline — browser-bound by design; verified live by Task 3's scrape-diff. `node --check` only.

**Interfaces:**
- Consumes: `DEFAULTS` (Task 1)
- Produces: `makePuppeteerDriver(page, config?) → { settle, readText, goNext }` — used by Tasks 3 and 4.

- [ ] **Step 1: Append the adapter to `lib/paginator.js`**

Insert above `module.exports` (DOM logic lifted from the working scrapers — WP pagination selectors + text-token fallback from the standard 8, `scrollHeight` scroll and wide element set from holon/jerusalem, frame scan from tel-aviv):

```js
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Runs inside the browser. Finds and clicks the control leading to page
// `nextNum`. Same strategy as the old scrapers: known pagination containers
// first, generic elements as fallback; exact page-number match first, then
// next-tokens. Returns true if something was clicked.
function clickNextInDom(nextNum, tokens) {
  let els = Array.from(document.querySelectorAll(
    '.page-numbers, .pagination a, .nav-links a, [class*="pagination"] a, .wp-pagenavi a, .page-link'
  ));
  if (els.length === 0) {
    els = Array.from(document.querySelectorAll('a, button, li, span')).filter(el => {
      const cn = (el.className || '').toString().toLowerCase();
      const txt = el.innerText ? el.innerText.trim() : '';
      return cn.includes('page') || cn.includes('nav') || (txt.length > 0 && txt.length < 20);
    });
  }
  let target = els.find(el => el.innerText && el.innerText.trim() === String(nextNum));
  if (!target) {
    target = els.find(el => {
      const txt = el.innerText ? el.innerText.trim() : '';
      if (!txt || txt.length > 25) return false;
      const low = txt.toLowerCase();
      return tokens.some(t => low === t.toLowerCase() || low.includes(t.toLowerCase()));
    });
  }
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }
  return false;
}

// Browser adapter: the one impure part (like ai.js/storage.js). Holds every
// Puppeteer/DOM specific; verified by scripts/scrape-diff.js against the old
// scrapers, not by unit tests.
function makePuppeteerDriver(page, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let currentPage = 1;

  return {
    async settle() {
      if (cfg.networkIdle) {
        await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
      } else {
        await sleep(cfg.settleMs);
      }
    },

    async readText() {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
      await sleep(cfg.waitMs);
      let text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (cfg.iframes) {
        for (const frame of page.frames()) {
          try {
            const t = await frame.evaluate(() => document.body ? document.body.innerText : '');
            if (t && !text.includes(t)) text += '\n' + t;
          } catch (e) {}
        }
      }
      return text;
    },

    async goNext() {
      const nextNum = currentPage + 1;
      let clicked = false;
      try {
        clicked = await page.evaluate(clickNextInDom, nextNum, cfg.nextTokens);
      } catch (e) {}
      if (!clicked && cfg.iframes) {
        for (const frame of page.frames()) {
          try {
            clicked = await frame.evaluate(clickNextInDom, nextNum, cfg.nextTokens);
            if (clicked) break;
          } catch (e) {}
        }
      }
      if (!clicked) return false;
      currentPage++;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {}),
        sleep(4000)
      ]);
      return true;
    }
  };
}
```

Update the export line:

```js
module.exports = { paginate, DEFAULTS, makePuppeteerDriver };
```

Note on `readText` iframes: the old tel-aviv scraper appends every frame's text unconditionally, which duplicates the main frame (page.frames() includes it). The adapter adds `!text.includes(t)` to skip exact duplicates — strictly less noise; scrape-diff (stable-key set comparison) is insensitive to this either way.

- [ ] **Step 2: Verify parse + suite untouched**

Run: `node --check lib/paginator.js && npm test`
Expected: silent parse; 62 tests still PASS (nothing imports the adapter yet).

- [ ] **Step 3: Commit**

```bash
git add lib/paginator.js
git commit -m "feat: add makePuppeteerDriver browser adapter

DOM specifics lifted from the working scrapers: WP pagination selectors +
token fallback, scrollHeight scroll, optional frame scan and networkIdle
settle. Verified live by scrape-diff, not unit tests."
```

---

### Task 3: `scripts/scrape-diff.js` — the migration gate (free)

**Files:**
- Create: `scripts/scrape-diff.js`
- Test: none — live tool. Zero Gemini calls, zero webhook.

**Interfaces:**
- Consumes: `MUNICIPALITIES` (lib/sites), `superCleanText`/`buildEntries` (lib/text), `paginate`/`makePuppeteerDriver` (Tasks 1–2)
- Produces: CLI verdict per site; exit 0 on MATCH, 1 on DIVERGE/error.

- [ ] **Step 1: Create the tool**

```js
// Compares the OLD per-site scraper against the generic paginator on the live
// site. FREE: no Gemini calls, no webhook. Verdict = do the stable-key sets
// match after superCleanText? Usage: node scripts/scrape-diff.js tel-aviv
const path = require('path');
const puppeteer = require('puppeteer');
const { MUNICIPALITIES } = require('../lib/sites');
const { superCleanText, buildEntries } = require('../lib/text');
const { paginate, makePuppeteerDriver } = require('../lib/paginator');

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

function keysOf(pages) {
  let raw = '';
  pages.forEach((p, i) => { raw += `\n--- PAGE ${i + 1} ---\n` + p; });
  const entries = buildEntries(superCleanText(raw));
  return new Set(entries.map(e => e.key).filter(k => k !== null));
}

async function main() {
  const key = process.argv[2];
  const site = key && MUNICIPALITIES.find(m => (m.script || '').endsWith(`/${key}.js`));
  if (!site) {
    console.error(`Usage: node scripts/scrape-diff.js <site-key with an old scraper>`);
    console.error(`Keys: ${MUNICIPALITIES.filter(m => m.script).map(m => path.basename(m.script, '.js')).join(', ')}`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  try {
    console.log(`\n🔵 OLD scraper: ${key} ...`);
    const oldPage = await openPage(browser, site.url);
    const oldRes = await require(path.join(__dirname, '..', site.script.replace('./', ''))).scrape(oldPage);
    const oldPages = Array.isArray(oldRes) ? oldRes : [oldRes];
    await oldPage.close();

    console.log(`\n🟢 GENERIC paginator (config: ${JSON.stringify(site.pagination || {})}) ...`);
    const newPage = await openPage(browser, site.url);
    const cfg = site.pagination || {};
    const newPages = await paginate(makePuppeteerDriver(newPage, cfg), cfg);
    await newPage.close();

    const oldKeys = keysOf(oldPages);
    const newKeys = keysOf(newPages);
    const onlyOld = [...oldKeys].filter(k => !newKeys.has(k));
    const onlyNew = [...newKeys].filter(k => !oldKeys.has(k));

    console.log(`\n================ ${key} ================`);
    console.log(`old: ${oldPages.length} page(s), ${oldKeys.size} stable keys`);
    console.log(`new: ${newPages.length} page(s), ${newKeys.size} stable keys`);
    if (onlyOld.length) { console.log(`\nKEYS ONLY IN OLD (${onlyOld.length}):`); onlyOld.slice(0, 10).forEach(k => console.log(`  - ${k.slice(0, 70)}`)); }
    if (onlyNew.length) { console.log(`\nKEYS ONLY IN NEW (${onlyNew.length}):`); onlyNew.slice(0, 10).forEach(k => console.log(`  + ${k.slice(0, 70)}`)); }
    const match = onlyOld.length === 0 && onlyNew.length === 0;
    console.log(`\nVERDICT: ${match ? '✅ MATCH — safe to migrate' : '❌ DIVERGE — keep custom or adjust config'}`);
    process.exit(match ? 0 : 1);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify parse + suite untouched**

Run: `node --check scripts/scrape-diff.js && npm test`
Expected: silent; 62 PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/scrape-diff.js
git commit -m "feat: add scrape-diff migration gate

Runs old scraper vs generic paginator on the live site and compares
stable-key sets. Free: zero Gemini calls, zero webhook. A site migrates
only on MATCH."
```

---

### Task 4: dispatch in `main.js` + dormant configs in `lib/sites.js`

**Files:**
- Modify: `lib/sites.js` (3 rows gain dormant `pagination`), `main.js` (dispatch), `test/sites.test.js`

**Interfaces:**
- Consumes: `paginate`, `makePuppeteerDriver` (Tasks 1–2)
- Produces: rows shaped `{ publisher, url, pagination?, script? }`; dispatch rule `script` wins.

**Behavior guarantee: this task changes nothing live** — all 14 rows still have `script`, and `script` wins the dispatch.

- [ ] **Step 1: Update `test/sites.test.js` (failing first)**

Replace the first test's per-row assertions with:

```js
test('MUNICIPALITIES exposes every site with the fields main.js needs', () => {
  assert.ok(Array.isArray(MUNICIPALITIES));
  assert.strictEqual(MUNICIPALITIES.length, 14);
  for (const m of MUNICIPALITIES) {
    assert.ok(m.publisher && m.publisher.length > 0, 'publisher missing');
    assert.ok(m.url && m.url.startsWith('http'), `bad url for ${m.publisher}`);
    // A site is either custom (script file) or generic (paginator). script wins.
    if (m.script !== undefined) {
      assert.ok(m.script.startsWith('./scrapers/'), `bad script for ${m.publisher}`);
    }
    if (m.pagination !== undefined) {
      assert.ok(typeof m.pagination === 'object' && m.pagination !== null && !Array.isArray(m.pagination),
        `pagination must be a plain object for ${m.publisher}`);
    }
  }
});
```

Add one more test:

```js
test('dormant pagination configs carry only known keys', () => {
  const KNOWN = new Set(['iframes', 'networkIdle', 'maxPages', 'settleMs', 'waitMs', 'nextTokens']);
  for (const m of MUNICIPALITIES) {
    for (const k of Object.keys(m.pagination || {})) {
      assert.ok(KNOWN.has(k), `unknown pagination key "${k}" on ${m.publisher}`);
    }
  }
});
```

Run: `node --test test/sites.test.js` → PASS already (no rows have `pagination` yet — that's fine; the shape change is what matters, and Step 2's rows are validated by it).

- [ ] **Step 2: Add dormant configs to `lib/sites.js`**

Edit the three rows (config used by scrape-diff before migration; `script` stays for now):

```js
  { publisher: "עיריית אשדוד", url: "https://www.ashdod.muni.il/he-il/אתר-העיר/מכרזים/מכרזים-כלליים/", script: "./scrapers/ashdod.js", pagination: { iframes: true } },
  …
  { publisher: "עיריית הרצליה", url: "https://www.herzliya.muni.il/bids/", script: "./scrapers/herzliya.js", pagination: { iframes: true } },
  …
  { publisher: "עיריית תל אביב", url: "https://www.tel-aviv.gov.il/AuctionAndCareers/Pages/Service.aspx", script: "./scrapers/tel-aviv.js", pagination: { iframes: true, networkIdle: true } },
```

- [ ] **Step 3: Dispatch in `main.js`**

Add to the requires:

```js
const { paginate, makePuppeteerDriver } = require('./lib/paginator');
```

Replace the two scrape lines (currently `const targetModule = require(muni.script); const scrapeResult = await targetModule.scrape(page);`):

```js
      // script (custom file) wins; otherwise the generic config-driven paginator.
      const scrapeResult = muni.script
        ? await require(muni.script).scrape(page)
        : await paginate(makePuppeteerDriver(page, muni.pagination || {}), muni.pagination || {});
```

- [ ] **Step 4: Verify**

Run: `node --check main.js && npm test`
Expected: silent; all tests PASS. Then confirm no behavior change is possible:

```bash
grep -c "script:" lib/sites.js    # expect 14 — every site still custom
```

- [ ] **Step 5: Commit**

```bash
git add lib/sites.js test/sites.test.js main.js
git commit -m "feat: dispatch custom-vs-generic scraping per site row

script (custom file) wins; pagination configs sit dormant on tel-aviv,
ashdod, herzliya for scrape-diff. All 14 rows keep script, so no site's
behavior changes yet."
```

---

### Task 5: migrate sites one at a time (live, free, reversible)

**Files:**
- Modify: `lib/sites.js` (remove `script` per proven site)
- Delete: `scrapers/<key>.js` per proven site
- Test: `scripts/scrape-diff.js <key>` is the gate; `npm test` after each batch.

This task is **live execution**: each check scrapes the real site twice (~1–3 min/site). Free — no tokens, no webhook. Do sites in this order (simple first, iframe/paginated last):

```bash
# batch 1 — the 8 structurally-identical simple sites
node scripts/scrape-diff.js haifa
node scripts/scrape-diff.js beer-sheva
node scripts/scrape-diff.js bnei-brak
node scripts/scrape-diff.js hacal-modiin
node scripts/scrape-diff.js hevel-modiin
node scripts/scrape-diff.js modiin-illit
node scripts/scrape-diff.js modiin
node scripts/scrape-diff.js rishon-lezion
# batch 2 — variants
node scripts/scrape-diff.js ashkelon
node scripts/scrape-diff.js holon
node scripts/scrape-diff.js jerusalem
# batch 3 — iframe/paginated
node scripts/scrape-diff.js ashdod
node scripts/scrape-diff.js herzliya
node scripts/scrape-diff.js tel-aviv
```

Per site:

- [ ] **On ✅ MATCH:** in `lib/sites.js` remove that row's `script` field (keep `pagination` if present); `git rm scrapers/<key>.js`.
- [ ] **On ❌ DIVERGE:** re-run once (sites change between the two captures; stable keys absorb most but not all volatility). If it diverges twice: leave the site custom (`script` stays, file stays) and note it. **Do not force-migrate. Do not tweak the driver to chase one site** — a site needing bespoke logic is what the escape hatch is for.
- [ ] After each batch: `npm test` (sites.test.js validates the row shapes) and commit:

```bash
git add lib/sites.js scrapers/
git commit -m "refactor: migrate <names> to generic paginator (scrape-diff verified)"
```

- [ ] Final state check:

```bash
ls scrapers/ | wc -l          # 14 minus migrated count; each remaining file is a deliberate escape hatch
grep -c "script:" lib/sites.js  # equals the file count above
npm test
```

---

## Definition of Done

- [ ] `paginate` loop unit-tested with a mock driver; `npm test` offline, zero tokens
- [ ] Every migrated site passed `scrape-diff` MATCH before its file was deleted
- [ ] Any DIVERGE site keeps `script` + its file and still works (escape hatch, not failure)
- [ ] `main.js` join (`--- PAGE n ---`) and downstream pipeline untouched
- [ ] Adding a new site = one `MUNICIPALITIES` row, no new file
- [ ] No Gemini call and no webhook POST was made by anything in this plan

## Out of Scope

- Concurrency (Phase 4); alerting (Phase 5)
- Model/prompt/extraction changes
- Deleting scrapers that failed scrape-diff
- A production `node main.js` run (separate, user-approved step)
