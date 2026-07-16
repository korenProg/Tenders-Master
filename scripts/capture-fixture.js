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
    console.error(`Site keys: ${MUNICIPALITIES.map(m => path.basename(m.script, '.js')).join(', ')}`);
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
