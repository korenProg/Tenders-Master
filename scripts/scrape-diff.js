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
