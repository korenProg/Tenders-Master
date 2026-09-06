// Herzliya walks a WordPress-style paginated tender list living inside
// iframes. Pagination is click-driven: we click a "next page" control inside
// one of the frames, then must wait for that frame to actually re-render
// before reading its text. There is no load event to await for an iframe
// content swap, so "did the page change yet?" has to be answered by polling
// the rendered text itself.
//
// These two constants exist because a FIXED wait was tried first and failed
// under load: with 4 browsers running concurrently (see
// scripts/concurrency-check.js), CPU/network contention can push a page's
// real render time past a fixed budget. When that happens, reading too early
// returns the PREVIOUS page's text, which then spuriously matches
// `previousPageText` and the loop concludes pagination is finished — silently
// dropping every remaining page. Do not shrink these back down to "optimize"
// runtime; the poll already exits as soon as new content shows up, so a
// healthy run pays only POLL_INTERVAL_MS-ish latency, not the full ceiling.
//
// POLL_CEILING_MS specifically: a stress script (4 concurrent copies of THIS
// site against itself — harsher than production, where concurrency 4 means
// 4 DIFFERENT sites and Herzliya runs only once) measured genuine, legitimate
// page-transition latency up to ~93s under that load on ordinary dev hardware
// — a 20-30s ceiling was measured to time out and falsely conclude "no more
// pages" on 3 of 4 runs even though every page eventually rendered correctly.
// The ceiling below is set with headroom above that observed worst case.
// Lowering it back toward 20-30s reintroduces the exact bug this file fixes;
// verify against a live stress run (see task-9 report) before changing it.
const POLL_INTERVAL_MS = 500;   // cadence between re-reads while waiting for new content
const POLL_CEILING_MS = 100000; // max time to wait before concluding a page genuinely didn't change
const MIN_CONTENT_LENGTH = 300; // below this, a page is considered still-loading/empty, not real content
// A single "it changed, and it's long enough" read is not proof a page is
// actually finished rendering: under contention, tender rows can trickle in
// with brief pauses between batches, and a snapshot taken during one of
// those pauses looks perfectly stable for one interval while still missing
// rows that arrive a moment later. A live stress run (task-9 report)
// reproduced exactly this — pages that never hit the "identical" bail-out
// but still settled several rows short. Requiring several consecutive
// unchanged reads in a row, not just one, is what catches a pause-in-trickle
// before it gets mistaken for done.
const STABLE_READS_REQUIRED = 4; // consecutive matching reads (~1.5s of quiet) before content counts as settled

async function scrollPage(page) {
  try {
    await page.evaluate(() => window.scrollBy(0, 1000));
    for (const frame of page.frames()) {
      try { await frame.evaluate(() => window.scrollBy(0, 500)); } catch (e) {}
    }
  } catch (e) {}
}

// One snapshot read: dedupes lines across every iframe on the page (the site
// repeats the same tender list markup in more than one frame).
async function readCombinedText(page) {
  const uniqueLines = new Set();
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const txt = await frame.evaluate(() => document.body ? document.body.innerText : "");
      if (txt) {
        txt.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && trimmed.length > 2) uniqueLines.add(trimmed);
        });
      }
    } catch (e) {}
  }
  return Array.from(uniqueLines).join('\n');
}

// Is this snapshot "ready to judge"? Either it looks like real page content
// (long enough, or an explicit 404), or — when a page transition is expected
// (requireChange) — it has actually diverged from the previous page's text.
// Until one of those is true we keep polling; the caller applies the ceiling.
function isReady(text, previousPageText, requireChange) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes('Page not found')) return true;
  if (trimmed.length < MIN_CONTENT_LENGTH) return false;
  if (requireChange && trimmed === previousPageText.trim()) return false;
  return true;
}

// Bounded poll: keep re-reading frame text until it looks ready (see
// isReady) AND has stopped changing for STABLE_READS_REQUIRED consecutive
// reads, or until POLL_CEILING_MS elapses. Page 1 has no previous page, so
// requireChange is false for it — it is judged on content length alone and
// is never held hostage waiting for text to "differ" from nothing.
async function pollForText(page, previousPageText, requireChange) {
  const deadline = Date.now() + POLL_CEILING_MS;
  let text = await readCombinedText(page);
  let stableCount = 1;
  while (Date.now() < deadline) {
    if (isReady(text, previousPageText, requireChange) && stableCount >= STABLE_READS_REQUIRED) {
      return text;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const next = await readCombinedText(page);
    stableCount = (next.trim() === text.trim()) ? stableCount + 1 : 1;
    text = next;
  }
  return text;
}

async function scrape(page) {
  const allPagesText = [];
  let currentPage = 1;
  let hasNextPage = true;
  const maxPages = 5;
  let previousPageText = "";

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`📄 Processing Herzliya (Multi-Frame Mode) - Page ${currentPage}...`);

    await scrollPage(page);

    // Page 1 has nothing to differ from yet (previousPageText === ""), so it
    // is judged on content length only. Pages after a pagination click must
    // additionally show text that differs from the page we just left.
    const combinedText = await pollForText(page, previousPageText, currentPage > 1);

    if (!combinedText || combinedText.length < MIN_CONTENT_LENGTH || combinedText.includes("Page not found")) {
      console.log(`🏁 Reached an empty page or 404 text at Herzliya page ${currentPage}. Stopping.`);
      break;
    }

    // Reaching this on page > 1 means ONE thing, and it is not "pagination
    // ended": isReady() refuses to return while the text still matches the
    // previous page, so pollForText cannot return early here — it can only
    // have burned the full POLL_CEILING_MS. In other words the frame never
    // re-rendered within 100s, and we are giving up mid-list.
    //
    // A genuine end of pagination is reported by the clickSuccess check
    // further down ("Could not find any valid pagination target"). Keeping
    // these two apart is what tells a human whether a later COUNT_COLLAPSE
    // alert on Herzliya is a real change on the site or this scraper losing
    // pages under load — the exact ambiguity that cost a third of the site
    // once already.
    if (currentPage > 1 && combinedText.trim() === previousPageText.trim()) {
      console.log(`⚠️ SUSPECT: frame never re-rendered within ${POLL_CEILING_MS / 1000}s at page ${currentPage}. Giving up with ${allPagesText.length} page(s) — expect fewer tenders than usual.`);
      break;
    }

    allPagesText.push(combinedText);
    previousPageText = combinedText;

    const nextPageNum = currentPage + 1;
    console.log(`👇 Searching for pagination button for Page ${nextPageNum} across all frames...`);

    let clickSuccess = false;
    const frames = page.frames();
    for (const frame of frames) {
      try {
        clickSuccess = await frame.evaluate((nextNum) => {
          let paginationElements = Array.from(document.querySelectorAll(
            '.page-numbers, .pagination a, .nav-links a, [class*="pagination"] a, .wp-pagenavi a, .page-link, button, a'
          ));

          let target = paginationElements.find(el => el.innerText && el.innerText.trim() === String(nextNum));

          if (!target) {
            target = paginationElements.find(el => {
              const txt = el.innerText ? el.innerText.toLowerCase() : '';
              return txt.includes('הבא') || txt.includes('next') || txt === '›' || txt === '»';
            });
          }

          if (target) {
            target.scrollIntoView({ block: 'center' });
            target.click();
            return true;
          }
          return false;
        }, nextPageNum);

        if (clickSuccess) {
          console.log(`🎯 Successfully clicked pagination inside one of the frames!`);
          break;
        }
      } catch (e) {}
    }

    if (!clickSuccess) {
      console.log(`🏁 Could not find any valid pagination target for page ${nextPageNum}. Stopping.`);
      hasNextPage = false;
    } else {
      currentPage++;
    }
  }

  return allPagesText;
}

module.exports = { scrape };
