async function scrape(page) {
  const allPagesText = [];
  let currentPage = 1;
  let hasNextPage = true;
  const maxPages = 5;
  let previousPageText = "";

  // המתנה קבועה ויציבה לטעינת הטבלה הכבדה של אשדוד
  await new Promise(r => setTimeout(r, 5000));

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`📄 Processing Ashdod - Page ${currentPage}...`);
    
    await page.evaluate(() => window.scrollBy(0, 800));
    await new Promise(r => setTimeout(r, 3000));
    
    let currentText = "";
    try {
      currentText = await page.evaluate(() => document.body ? document.body.innerText : "");
      for (const frame of page.frames()) {
        try {
          const txt = await frame.evaluate(() => document.body ? document.body.innerText : "");
          if (txt) currentText += "\n" + txt;
        } catch (e) {}
      }
    } catch (e) {
      currentText = await page.evaluate(() => document.body.innerText);
    }
    
    // רף נמוך ומאוזן כדי לא לחסום מידע אמיתי של אשדוד
    if (!currentText || currentText.trim().length < 100 || currentText.includes("Page not found")) {
      console.log(`🏁 Reached an empty page or 404 text at Ashdod page ${currentPage}. Stopping.`);
      break;
    }

    if (currentText.trim() === previousPageText.trim()) {
      console.log(`⛔ Text is identical to previous page. Stopping.`);
      break;
    }

    allPagesText.push(currentText);
    previousPageText = currentText;

    const nextPageNum = currentPage + 1;
    console.log(`👇 Attempting to click pagination button for Page ${nextPageNum}...`);

    const clickSuccess = await page.evaluate((nextNum) => {
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

    if (!clickSuccess) {
      console.log(`🏁 Could not find any valid pagination target for page ${nextPageNum}. Stopping.`);
      hasNextPage = false;
    } else {
      currentPage++;
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }

  return allPagesText;
}

module.exports = { scrape };