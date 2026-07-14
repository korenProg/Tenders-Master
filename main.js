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
