const puppeteer = require('puppeteer');
const axios = require('axios');
require('dotenv').config();

const { superCleanText, buildEntries } = require('./lib/text');
const { getSiteEntry, makeSiteEntry } = require('./lib/cache');
const storage = require('./lib/storage');
const { diff, isDiffTooLarge, buildChunks } = require('./lib/diff');
const { mergeTenders } = require('./lib/merge');
const { MUNICIPALITIES } = require('./lib/sites');
const { extractTenders, MODEL_NAME } = require('./lib/ai');
const { paginate, makePuppeteerDriver } = require('./lib/paginator');
const { validateTenders } = require('./lib/validate');
const { assessSite, LEVELS } = require('./lib/health');
const { runPool, withTimeout } = require('./lib/pool');

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_KEY = process.env.ELIYAHO_WEBHOOK_KEY;

// How many sites run at once. CONCURRENCY=1 reproduces the old sequential
// behavior exactly — the escape hatch, and the A/B baseline for
// scripts/concurrency-check.js. Memory is the real cap: each site gets its own
// Chrome (~150–300MB), which is the price of crash isolation between sites.
// Unparseable input falls back to the default (4) rather than silently
// resolving to 1 — garbage must not masquerade as the documented default.
const rawConcurrency = process.env.CONCURRENCY;
const parsedConcurrency = rawConcurrency === undefined ? 4 : parseInt(rawConcurrency, 10);
const CONCURRENCY = Math.max(1, Number.isNaN(parsedConcurrency) ? 4 : parsedConcurrency);

// Per-site ceiling, ~5× the slowest observed site. On expiry the pool frees the
// slot and records the site failed; the cache is simply not updated, which is
// already safe. SITE_TIMEOUT_MS=0 is a documented, supported escape hatch that
// disables the timeout — but unparseable input must fail toward the SAFE
// extreme (the 300000 default), never toward "disabled": a hung site plus a
// mistyped env var must not leave a pool slot blocked forever.
const rawTimeout = process.env.SITE_TIMEOUT_MS;
const parsedTimeout = rawTimeout === undefined ? 300000 : parseInt(rawTimeout, 10);
const SITE_TIMEOUT_MS = Math.max(0, Number.isNaN(parsedTimeout) ? 300000 : parsedTimeout);

const RUN_STATS = { aiCalls: 0, inputTokens: 0, outputTokens: 0, alerts: 0, warnings: 0, dropped: 0 };

async function deliverToWebhook(tenders) {
  const response = await axios.post(WEBHOOK_URL, { tenders }, {
    headers: { 'Content-Type': 'application/json', 'x-webhook-key': WEBHOOK_KEY }
  });
  return response.status === 200;
}

// One buffer per site, flushed as a single contiguous block when the site
// finishes. Under concurrency, unbuffered console.log from 4 workers shreds
// the run log. The trade-off is explicit: a site's block appears at its
// COMPLETION time, so blocks are no longer chronological across sites — which
// is why the header carries the elapsed time.
function makeSiteLog(muni, index, total) {
  const lines = [];
  const started = Date.now();
  return {
    log: (msg) => lines.push(msg),
    flush: () => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log([`\n=== [${index + 1}/${total}] ${muni.publisher} — ${secs}s ===`, ...lines].join('\n'));
    }
  };
}

// Runs the AI extraction and folds its token usage into RUN_STATS.
// Returns null on failure: the caller must leave the cache untouched.
async function extractAndCount(text, log, opts) {
  log(`🤖 Attempting extraction with model: ${MODEL_NAME}...`);
  const { tenders, usage, attempts, error } = await extractTenders(text, opts);
  if (tenders === null) {
    log(`❌ Model ${MODEL_NAME} failed after ${attempts} attempt(s) (${error}). Returning null so cache is NOT updated.`);
    return null;
  }
  if (attempts > 1) log(`🔁 Succeeded on attempt ${attempts} after a transient failure.`);
  RUN_STATS.aiCalls++;
  RUN_STATS.inputTokens += usage.inputTokens;
  RUN_STATS.outputTokens += usage.outputTokens;
  log(`💰 Tokens — input: ${usage.inputTokens}, output: ${usage.outputTokens}, total: ${usage.inputTokens + usage.outputTokens}`);
  return tenders;
}

// Validates immediately before delivery and reports health. The caller writes
// the cache with the RAW merged list — never with `kept`: degrading a tender's
// number to "אין" would flip its upsertKey from num: to title: and duplicate
// it on a later run.
async function validateAndDeliver(rawTenders, cleanedText, previousTenders, log) {
  const { kept, dropped, histogram } = validateTenders(rawTenders, cleanedText);

  if (dropped.length > 0) {
    log(`🚫 Validation dropped ${dropped.length} tender(s) not found on the page:`);
    for (const d of dropped) log(`   - "${(d.tender.title || '').slice(0, 60)}" [${d.issues.join(', ')}]`);
  }
  const issueSummary = Object.entries(histogram).map(([k, v]) => `${k}=${v}`).join(' ');
  if (issueSummary) log(`⚠️ Validation issues: ${issueSummary}`);

  const health = assessSite({
    previousTenders,
    mergedTenders: kept,
    cleanedTextLength: cleanedText.length,
    issueHistogram: histogram
  });
  if (health.level === LEVELS.ALERT) {
    log(`🔴 HEALTH ALERT: ${health.signals.join(', ')}`);
    RUN_STATS.alerts++;
  } else if (health.level === LEVELS.WARN) {
    log(`🟡 Health warning: ${health.signals.join(', ')}`);
    RUN_STATS.warnings++;
  }

  const ok = kept.length > 0 ? await deliverToWebhook(kept) : false;
  return { ok, kept, health };
}

// One site, end to end: launch → scrape → diff → extract? → merge → save →
// validate → deliver. This is the pool's worker (Task 5). It closes its own
// browser in `finally`, which is also what makes a timed-out orphan clean up
// after itself once the pool has moved on.
async function processSite(muni, index) {
  const { log, flush } = makeSiteLog(muni, index, MUNICIPALITIES.length);

  let browser;
  try {
    // HEADFUL=1 opens a visible browser window — for demos and debugging.
    browser = await puppeteer.launch({
      headless: process.env.HEADFUL ? false : "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(muni.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // script (custom file) wins; otherwise the generic config-driven paginator.
    const scrapeResult = muni.script
      ? await require(muni.script).scrape(page)
      : await paginate(makePuppeteerDriver(page, muni.pagination || {}), muni.pagination || {});

    if (!scrapeResult || (typeof scrapeResult === 'string' && scrapeResult.length < 100) || (Array.isArray(scrapeResult) && scrapeResult.length === 0)) {
      log(`⚠️ No content extracted for ${muni.publisher}.`);
      return;
    }

    const pages = Array.isArray(scrapeResult) ? scrapeResult : [scrapeResult];

    let fullCityRawText = "";
    for (let p = 0; p < pages.length; p++) {
      fullCityRawText += `\n--- PAGE ${p + 1} ---\n` + pages[p];
    }

    const cleanedCityText = superCleanText(fullCityRawText);
    const entries = buildEntries(cleanedCityText);
    const siteEntry = getSiteEntry(storage.loadRaw(muni.url));
    const cachedKeyHashes = siteEntry ? siteEntry.keyHashes : {};
    const { addedKeys, removedKeys, changedKeys, newKeyHashes } = diff(cachedKeyHashes, entries);

    // Case 1: nothing changed since last run
    if (siteEntry && addedKeys.length === 0 && removedKeys.length === 0 && changedKeys.length === 0) {
      if (siteEntry.pendingDelivery && siteEntry.tenders.length > 0) {
        log(`📡 Content unchanged but last delivery failed — resending ${siteEntry.tenders.length} cached tenders (0 tokens)...`);
        // siteEntry.tenders is both the payload and the baseline: an unchanged
        // page must never look like a collapse.
        const { ok } = await validateAndDeliver(siteEntry.tenders, cleanedCityText, siteEntry.tenders, log);
        if (ok) {
          storage.saveRaw(muni.url, makeSiteEntry(siteEntry.keyHashes, siteEntry.tenders, false));
          log(`✅ Webhook accepted pending delivery. Cache updated.`);
        }
      } else {
        log(`⏭️ Green Light: Website content is IDENTICAL to last run. Skipping AI.`);
      }
      return;
    }

    // Case 2: choose full vs incremental extraction
    const useFullPath = !siteEntry || isDiffTooLarge(addedKeys, removedKeys, changedKeys, Object.keys(cachedKeyHashes).length, Object.keys(newKeyHashes).length);

    let newTenders = [];
    if (useFullPath) {
      const reason = !siteEntry ? "first run / legacy cache" : "diff too large — safety fallback";
      log(`📄 Full extraction (${reason}): sending ${cleanedCityText.length} chars to AI...`);
      newTenders = await extractAndCount(cleanedCityText, log);
    } else if (addedKeys.length + changedKeys.length > 0) {
      const chunks = buildChunks(entries, [...addedKeys, ...changedKeys]);
      const excerptText = chunks.join('\n---\n');
      log(`✂️ Incremental: ${addedKeys.length} new / ${changedKeys.length} changed / ${removedKeys.length} removed lines → sending only ${excerptText.length} of ${cleanedCityText.length} chars to AI...`);
      newTenders = await extractAndCount(excerptText, log, { excerpt: true });
    } else {
      log(`🗑️ Removals only (${removedKeys.length} lines gone) — no AI call needed. 0 tokens.`);
    }

    if (newTenders === null) {
      log(`⚠️ AI extraction failed. Cache NOT updated — will retry next run.`);
      return;
    }

    const merged = mergeTenders(useFullPath ? [] : siteEntry.tenders, newTenders, cleanedCityText, muni.publisher, muni.url);
    log(`✨ Merged list: ${merged.length} tenders (${newTenders.length} newly extracted).`);

    if (merged.length > 0) {
      // Save BEFORE delivery: a webhook failure must never cost a second AI call.
      // RAW merged, never the validated list — validation would flip a degraded
      // tender's upsertKey from num: to title: and duplicate it next run.
      storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, merged, true));

      log(`📡 Streaming structured tenders to Lovable Webhook...`);
      const { ok, kept } = await validateAndDeliver(merged, cleanedCityText, siteEntry ? siteEntry.tenders : [], log);
      RUN_STATS.dropped += merged.length - kept.length;

      if (ok) {
        storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, merged, false));
        log(`✅ Webhook Accepted! Status: 200. Delivered ${kept.length}/${merged.length} validated. Cache updated.`);
      } else {
        log(`⚠️ Webhook returned unexpected status. Extraction saved — will resend next run without AI.`);
      }
    } else if (cleanedCityText.length > 1500) {
      log(`✅ Page verified healthy with 0 active tenders. Updating Cache.`);
      storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, [], false));
    } else {
      log(`⚠️ Warning: Page content seems too low or failed. Skipping cache to allow retry.`);
    }
  } catch (err) {
    // Annotate the buffer, then rethrow: the pool records the failure and the
    // run summary lists it. Flushing in `finally` means a failing site's
    // context is never lost.
    log(`❌ Error: ${err.message}`);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    flush();
  }
}

async function run() {
  console.log("🚀 Starting Incremental Scraper Run (Line-Diff Extraction)...");
  const startTime = Date.now();

  console.log(`⚙️ Concurrency: ${CONCURRENCY} | per-site timeout: ${SITE_TIMEOUT_MS ? `${SITE_TIMEOUT_MS / 1000}s` : 'off'}`);

  // Slot-based dispatch, NOT batches: site durations vary by an order of
  // magnitude, and a chunked Promise.all would idle N-1 workers waiting on the
  // slowest member of each chunk.
  const results = await runPool(
    MUNICIPALITIES,
    (muni, i) => withTimeout(processSite(muni, i), SITE_TIMEOUT_MS, muni.publisher),
    { concurrency: CONCURRENCY }
  );

  const failures = results
    .map((r, i) => (r.ok ? null : { publisher: MUNICIPALITIES[i].publisher, error: r.error }))
    .filter(Boolean);

  const minutes = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n════════════════════════════════════════");
  console.log(`🎯 RUN FINISHED in ${minutes} minutes`);
  console.log(`💰 AI calls: ${RUN_STATS.aiCalls}/${MUNICIPALITIES.length} sites | input tokens: ${RUN_STATS.inputTokens} | output tokens: ${RUN_STATS.outputTokens}`);
  console.log(`🩺 Health: ${RUN_STATS.alerts} alert(s), ${RUN_STATS.warnings} warning(s) | validation dropped ${RUN_STATS.dropped} tender(s)`);
  console.log(`🧵 Sites: ${MUNICIPALITIES.length - failures.length}/${MUNICIPALITIES.length} completed${failures.length ? ` | ${failures.length} failed:` : ''}`);
  for (const f of failures) console.log(`   ❌ ${f.publisher}: ${f.error.message}`);
  console.log("════════════════════════════════════════");
}

// Guarded so `require('./main.js')` (smoke checks, future tests) does not kick
// off a live 14-site run. `node main.js` is unaffected.
if (require.main === module) {
  run();
}

module.exports = { processSite, run };
