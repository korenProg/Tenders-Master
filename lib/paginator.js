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

module.exports = { paginate, DEFAULTS, makePuppeteerDriver };
