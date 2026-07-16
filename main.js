const puppeteer = require('puppeteer');
const axios = require('axios');
require('dotenv').config();

const { superCleanText, buildEntries } = require('./lib/text');
const { getSiteEntry, makeSiteEntry } = require('./lib/cache');
const storage = require('./lib/storage');
const { diff, isDiffTooLarge, buildChunks } = require('./lib/diff');
const { mergeTenders } = require('./lib/merge');
const { MUNICIPALITIES } = require('./lib/sites');
const { extractTenders } = require('./lib/ai');
const { paginate, makePuppeteerDriver } = require('./lib/paginator');
const { validateTenders } = require('./lib/validate');
const { assessSite, LEVELS } = require('./lib/health');

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_KEY = process.env.ELIYAHO_WEBHOOK_KEY;

const RUN_STATS = { aiCalls: 0, inputTokens: 0, outputTokens: 0, alerts: 0, warnings: 0, dropped: 0 };

async function deliverToWebhook(tenders) {
  const response = await axios.post(WEBHOOK_URL, { tenders }, {
    headers: { 'Content-Type': 'application/json', 'x-webhook-key': WEBHOOK_KEY }
  });
  return response.status === 200;
}

// Runs the AI extraction and folds its token usage into RUN_STATS.
// Returns null on failure: the caller must leave the cache untouched.
async function extractAndCount(text, opts) {
  const { tenders, usage } = await extractTenders(text, opts);
  if (tenders !== null) {
    RUN_STATS.aiCalls++;
    RUN_STATS.inputTokens += usage.inputTokens;
    RUN_STATS.outputTokens += usage.outputTokens;
  }
  return tenders;
}

// Validates immediately before delivery and reports health. The caller writes
// the cache with the RAW merged list — never with `kept`: degrading a tender's
// number to "אין" would flip its upsertKey from num: to title: and duplicate
// it on a later run.
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

async function run() {
  console.log("🚀 Starting Incremental Scraper Run (Line-Diff Extraction)...");
  const startTime = Date.now();

  for (let i = 0; i < MUNICIPALITIES.length; i++) {
    const muni = MUNICIPALITIES[i];
    console.log(`\n=== [${i + 1}/${MUNICIPALITIES.length}] Processing: ${muni.publisher} ===`);

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
      const siteEntry = getSiteEntry(storage.loadRaw(muni.url));
      const cachedKeyHashes = siteEntry ? siteEntry.keyHashes : {};
      const { addedKeys, removedKeys, changedKeys, newKeyHashes } = diff(cachedKeyHashes, entries);

      // Case 1: nothing changed since last run
      if (siteEntry && addedKeys.length === 0 && removedKeys.length === 0 && changedKeys.length === 0) {
        if (siteEntry.pendingDelivery && siteEntry.tenders.length > 0) {
          console.log(`📡 Content unchanged but last delivery failed — resending ${siteEntry.tenders.length} cached tenders (0 tokens)...`);
          // siteEntry.tenders is both the payload and the baseline: an unchanged
          // page must never look like a collapse.
          const { ok } = await validateAndDeliver(siteEntry.tenders, cleanedCityText, siteEntry.tenders);
          if (ok) {
            storage.saveRaw(muni.url, makeSiteEntry(siteEntry.keyHashes, siteEntry.tenders, false));
            console.log(`✅ Webhook accepted pending delivery. Cache updated.`);
          }
        } else {
          console.log(`⏭️ Green Light: Website content is IDENTICAL to last run. Skipping AI.`);
        }
        await browser.close();
        continue;
      }

      // Case 2: choose full vs incremental extraction
      const useFullPath = !siteEntry || isDiffTooLarge(addedKeys, removedKeys, changedKeys, Object.keys(cachedKeyHashes).length, Object.keys(newKeyHashes).length);

      let newTenders = [];
      if (useFullPath) {
        const reason = !siteEntry ? "first run / legacy cache" : "diff too large — safety fallback";
        console.log(`📄 Full extraction (${reason}): sending ${cleanedCityText.length} chars to AI...`);
        newTenders = await extractAndCount(cleanedCityText);
      } else if (addedKeys.length + changedKeys.length > 0) {
        const chunks = buildChunks(entries, [...addedKeys, ...changedKeys]);
        const excerptText = chunks.join('\n---\n');
        console.log(`✂️ Incremental: ${addedKeys.length} new / ${changedKeys.length} changed / ${removedKeys.length} removed lines → sending only ${excerptText.length} of ${cleanedCityText.length} chars to AI...`);
        newTenders = await extractAndCount(excerptText, { excerpt: true });
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
        // RAW merged, never the validated list — validation would flip a degraded
        // tender's upsertKey from num: to title: and duplicate it next run.
        storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, merged, true));

        console.log(`📡 Streaming structured tenders to Lovable Webhook...`);
        const { ok, kept } = await validateAndDeliver(merged, cleanedCityText, siteEntry ? siteEntry.tenders : []);
        RUN_STATS.dropped += merged.length - kept.length;

        if (ok) {
          storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, merged, false));
          console.log(`✅ Webhook Accepted! Status: 200. Delivered ${kept.length}/${merged.length} validated. Cache updated.`);
        } else {
          console.log(`⚠️ Webhook returned unexpected status. Extraction saved — will resend next run without AI.`);
        }
      } else if (cleanedCityText.length > 1500) {
        console.log(`✅ Page verified healthy with 0 active tenders. Updating Cache.`);
        storage.saveRaw(muni.url, makeSiteEntry(newKeyHashes, [], false));
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
  console.log(`🩺 Health: ${RUN_STATS.alerts} alert(s), ${RUN_STATS.warnings} warning(s) | validation dropped ${RUN_STATS.dropped} tender(s)`);
  console.log("════════════════════════════════════════");
}

run();
