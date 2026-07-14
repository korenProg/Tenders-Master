async function scrape(page) {
  const allPagesText = [];
  let currentPage = 1;
  let hasNextPage = true;
  const maxPages = 5;
  let previousPageText = "";

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`📄 Processing Herzliya (Multi-Frame Mode) - Page ${currentPage}...`);
    
    await new Promise(r => setTimeout(r, 6000));
    
    try {
      await page.evaluate(() => window.scrollBy(0, 1000));
      for (const frame of page.frames()) {
        try { await frame.evaluate(() => window.scrollBy(0, 500)); } catch (e) {}
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
    
    // סינון כפילויות מוחלט בין ה-Iframes השונים בעמוד
    let uniqueLines = new Set();
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
    
    let combinedText = Array.from(uniqueLines).join('\n');
    
    if (!combinedText || combinedText.length < 300 || combinedText.includes("Page not found")) {
      console.log(`🏁 Reached an empty page or 404 text at Herzliya page ${currentPage}. Stopping.`);
      break;
    }

    if (combinedText.trim() === previousPageText.trim()) {
      console.log(`⛔ Text is identical to previous page. Stopping.`);
      break;
    }

    allPagesText.push(combinedText);
    previousPageText = combinedText;

    const nextPageNum = currentPage + 1;
    console.log(`👇 Searching for pagination button for Page ${nextPageNum} across all frames...`);

    let clickSuccess = false;
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