// Phase-4 analogue of scrape-diff: runs ONLY the scrape half of the pipeline
// across every site twice — once at concurrency 1, once at concurrency N — and
// compares the per-site stable-key sets. FREE: no Gemini calls, no webhook, no
// cache reads or writes. Usage: node scripts/concurrency-check.js [N]
//
// Caveat worth reading before you trust a DIVERGE: these are LIVE sites. A
// tender genuinely published between the two passes shows up here as a
// difference. The differing keys are printed so a human can tell a real
// concurrency bug from ordinary page churn — re-run to confirm.
const path = require('path');
const puppeteer = require('puppeteer');
const { MUNICIPALITIES } = require('../lib/sites');
const { superCleanText, buildEntries } = require('../lib/text');
const { paginate, makePuppeteerDriver } = require('../lib/paginator');
const { runPool } = require('../lib/pool');

async function scrapeKeys(muni) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(muni.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const cfg = muni.pagination || {};
    const res = muni.script
      ? await require(path.join(__dirname, '..', muni.script.replace('./', ''))).scrape(page)
      : await paginate(makePuppeteerDriver(page, cfg), cfg);

    const pages = Array.isArray(res) ? res : [res];
    let raw = '';
    pages.forEach((p, i) => { raw += `\n--- PAGE ${i + 1} ---\n` + p; });
    const entries = buildEntries(superCleanText(raw));
    return new Set(entries.map(e => e.key).filter(k => k !== null));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pass(label, concurrency) {
  console.log(`\n${label} (concurrency ${concurrency}) — ${MUNICIPALITIES.length} sites ...`);
  const t0 = Date.now();
  const results = await runPool(MUNICIPALITIES, scrapeKeys, { concurrency });
  const secs = (Date.now() - t0) / 1000;
  console.log(`${label} finished in ${secs.toFixed(1)}s`);
  return { results, secs };
}

async function main() {
  const n = Math.max(2, parseInt(process.argv[2] || '4', 10) || 4);

  const base = await pass('🔵 BASELINE', 1);
  const conc = await pass(`🟢 CONCURRENT`, n);

  console.log(`\n================ concurrency check ================`);
  let diverged = 0;

  MUNICIPALITIES.forEach((muni, i) => {
    const a = base.results[i];
    const b = conc.results[i];

    if (!a.ok || !b.ok) {
      diverged++;
      console.log(`❌ ${muni.publisher}: baseline ${a.ok ? 'ok' : `FAILED (${a.error.message})`}, concurrent ${b.ok ? 'ok' : `FAILED (${b.error.message})`}`);
      return;
    }

    const onlyBase = [...a.value].filter(k => !b.value.has(k));
    const onlyConc = [...b.value].filter(k => !a.value.has(k));
    if (onlyBase.length === 0 && onlyConc.length === 0) {
      console.log(`✅ ${muni.publisher}: ${a.value.size} keys match`);
      return;
    }

    diverged++;
    console.log(`❌ ${muni.publisher}: ${a.value.size} vs ${b.value.size} keys`);
    onlyBase.slice(0, 5).forEach(k => console.log(`   - only sequential: ${k.slice(0, 70)}`));
    onlyConc.slice(0, 5).forEach(k => console.log(`   + only concurrent: ${k.slice(0, 70)}`));
  });

  const speedup = base.secs / (conc.secs || 1);
  console.log(`\n⏱️  ${base.secs.toFixed(1)}s sequential → ${conc.secs.toFixed(1)}s at ${n} (${speedup.toFixed(1)}× faster)`);
  console.log(`VERDICT: ${diverged === 0 ? '✅ MATCH — concurrency is safe to ship' : `❌ DIVERGE on ${diverged} site(s) — re-run to rule out live page churn`}`);
  process.exit(diverged === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
