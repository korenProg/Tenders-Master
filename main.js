const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_KEY = process.env.ELIYAHO_WEBHOOK_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const CACHE_FILE = './tenders_cache.json';

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

function superCleanText(text) {
  if (!text) return "";
  const junkWords = [
    "נגישות", "הצהרת נגישות", "מפת האתר", "כל הזכויות שמורות", "צור קשר", 
    "פייסבוק", "טוויטר", "יוטיוב", "אינסטגרם", "דילוג לתוכן", "מוקדי שירות",
    "דלג לתוכן המרכזי", "שירות לאזרח", "מדיניות פרטיות", "תנאי שימוש",
    "sharepoint", "session", "token", "powered by", "webpack",
    "חדשות", "מבזק", "אירועים", "לוח אירועים" // מסנן אוניברסלי לזבל דינמי
  ];
  
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.length === 0) return false;
      if (line.includes("{") || line.includes("}") || line.includes("]=") || line.includes("typeof") || line.includes("!important") || line.includes("-->")) return false;
      
      const englishAndSpecs = line.match(/[a-zA-Z0-9_\-\/]/g) || [];
      if (line.length > 40 && (englishAndSpecs.length / line.length) > 0.6) return false;
      
      if (line.length < 100) {
        return !junkWords.some(word => line.toLowerCase().includes(word.toLowerCase()));
      }
      return true;
    })
    .join('\n')
    .replace(/[ \t]+/g, ' ');
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return {}; }
  }
  return {};
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

const RUN_STATS = { aiCalls: 0, inputTokens: 0, outputTokens: 0 };

async function processWithAI(rawText) {
  const modelName = "gemini-2.5-flash";
  
  const prompt = `
    You are an expert data extraction tool. Analyze the following raw webpage text from a municipality website.
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

async function run() {
  console.log("🚀 Starting Ultra-Optimized Scraper Run (Universal Content-Only Hashing)...");
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

      // 🔥 השריון האוניברסלי החדש: התעלמות מוחלטת מבאנרים, תפריטים ושעונים
      const noiseWords = new Set([
        "יום", "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת",
        "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
        "שעה", "שעות", "דקה", "דקות", "שניה", "שניות", "היום", "מחר", "אתמול",
        "תאריך", "עודכן", "אחרון", "פורסם", "צפיות", "קוראים", "תגובות",
        "עמוד", "דף", "מתוך", "הבא", "הקודם", "הבאים", "קודמים", "לפני", "הצג", "עוד"
      ]);

      let stableLines = cleanedCityText
        .split('\n')
        .map(line => {
          let cleanLine = line.replace(/\d+/g, '').replace(/[^\u0590-\u05FFa-zA-Z\s]/g, ' ').trim();
          let words = cleanLine.split(/\s+/).filter(w => w.length > 1 && !noiseWords.has(w));
          return words.join(' ').trim();
        })
        .filter(line => line.split(/\s+/).length >= 4); // חובה 4 מילים עבריות! משמיד תפריטים ובאנרים קצרים

      // מחיקת כפילויות במקרה של חלונות שמצלמים את אותו באנר שוב ושוב
      stableLines = Array.from(new Set(stableLines)).sort(); 

      let textForHashing = muni.url + stableLines.join('');
      const currentHash = crypto.createHash('md5').update(textForHashing).digest('hex');
      
      if (cache[muni.url] === currentHash) {
        console.log(`⏭️ Green Light: Website content is IDENTICAL to last run. Skipping AI.`);
        await browser.close();
        continue;
      }

      console.log(`📄 Sent optimized text (${cleanedCityText.length} chars) to AI...`);
      // ה-AI מקבל את הטקסט המלא (עם המספרים) כדי שלא נאבד מידע על המכרזים
      const allCityTenders = await processWithAI(cleanedCityText);

      if (allCityTenders === null) {
        console.log(`⚠️ AI extraction failed. Cache NOT updated — will retry next run.`);
        await browser.close();
        continue;
      }
      console.log(`✨ AI Extracted ${allCityTenders.length} clean tenders.`);

      if (allCityTenders.length > 0) {
        const usedNumbers = new Set();
        const finalizedTenders = allCityTenders.map(t => {
          let fixedNumber = t.tender_number;
          const match = t.title.match(/(\d+)\s*[\/\.]\s*(\d+)/);
          if (match) {
            let year = match[2];
            if (year.length === 2) year = "20" + year;
            fixedNumber = `${match[1]}/${year}`;
          }

          if (fixedNumber !== "אין") {
            let finalNumber = fixedNumber;
            let counter = 2;
            while (usedNumbers.has(finalNumber)) {
              finalNumber = `${fixedNumber}-${counter}`;
              counter++;
            }
            fixedNumber = finalNumber;
            usedNumbers.add(fixedNumber);
          }

          return { ...t, tender_number: fixedNumber, publisher: muni.publisher, source_url: muni.url };
        });

        console.log(`📡 Streaming ${finalizedTenders.length} structured tenders to Lovable Webhook...`);
        const response = await axios.post(WEBHOOK_URL, { tenders: finalizedTenders }, {
          headers: { 'Content-Type': 'application/json', 'x-webhook-key': WEBHOOK_KEY }
        });
        
        if (response.status === 200) {
          console.log(`✅ Webhook Accepted! Status: 200. Updating Cache.`);
          cache[muni.url] = currentHash;
          saveCache(cache);
        } else {
          console.log(`⚠️ Webhook returned unexpected status ${response.status}. Cache not updated.`);
        }
      } else if (cleanedCityText.length > 1500) {
        console.log(`✅ Page verified healthy with 0 active tenders. Updating Cache.`);
        cache[muni.url] = currentHash;
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