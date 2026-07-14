async function scrape(page) {
  const allPagesText = [];
  let currentPage = 1;
  let hasNextPage = true;
  const maxPages = 5;
  let previousPageText = "";

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`📄 Processing Hevel Modiin - Page ${currentPage}...`);
    
    await page.evaluate(() => window.scrollBy(0, 1200));
    await new Promise(r => setTimeout(r, 4000));
    
    const currentText = await page.evaluate(() => document.body.innerText);
    
    if (!currentText || currentText.length < 500 || currentText.includes("Page not found")) {
      console.log(`🏁 Reached an empty page or 404 text at Hevel Modiin page ${currentPage}. Stopping.`);
      break;
    }

    if (currentText.trim() === previousPageText.trim()) {
      console.log(`⛔ Text is identical to previous page. Pagination didn't actually change content. Stopping.`);
      break;
    }

    allPagesText.push(currentText);
    previousPageText = currentText;

    const nextPageNum = currentPage + 1;
    console.log(`👇 Attempting to click pagination button for Page ${nextPageNum}...`);

    const clickSuccess = await page.evaluate((nextNum) => {
      let paginationElements = Array.from(document.querySelectorAll(
        '.page-numbers, .pagination a, .nav-links a, [class*="pagination"] a, .wp-pagenavi a, .page-link'
      ));
      
      if (paginationElements.length === 0) {
        paginationElements = Array.from(document.querySelectorAll('a')).filter(el => {
          const className = el.className.toLowerCase();
          return className.includes('page') || className.includes('nav');
        });
      }

      let target = paginationElements.find(el => el.innerText.trim() === String(nextNum));
      
      if (!target) {
        target = paginationElements.find(el => {
          const txt = el.innerText.toLowerCase();
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

    if (!clickSuccess) {
      console.log(`🏁 Could not find any valid pagination target for page ${nextPageNum}. Stopping.`);
      hasNextPage = false;
    } else {
      currentPage++;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    }
  }

  return allPagesText;
}

module.exports = { scrape };