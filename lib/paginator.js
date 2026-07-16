// Generic pagination. The pure loop lives here and is unit-tested against a
// mock driver; the Puppeteer adapter (below) holds the DOM specifics and is
// verified live by scripts/scrape-diff.js, never by npm test.

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
