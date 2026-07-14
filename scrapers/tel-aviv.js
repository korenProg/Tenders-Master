async function scrape(page) {
  const allPagesText = [];
  let currentPage = 1;
  let hasNextPage = true;
  const maxPages = 5;
  let previousPageText = "";

  // ⏳ הגנה מיוחדת לתל אביב: ממתינים שהצד שרת וה-API הפנימי יסיימו להזרים נתונים
  console.log("⏳ Waiting for Tel Aviv heavy data assets to settle...");
  await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => console.log("Timeout waiting for network idle, continuing..."));

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`📄 Processing Tel Aviv - Page ${currentPage}...`);
    
    // גלילה פרוגרסיבית כדי לאלץ את טבלאות ה-React להתרנדר במלואן
    await page.evaluate(async () => {
      window.scrollBy(0, 600);
      await new Promise(r => setTimeout(r, 1000));
      window.scrollBy(0, 600);
    });
    await new Promise(r => setTimeout(r, 4000));
    
    // שליפת טקסט משולבת הכוללת סריקת פריימים לגיבוי מלא
    let combinedText = "";
    try {
      combinedText = await page.evaluate(() => document.body ? document.body.innerText : "");
      for (const frame of page.frames()) {
        try {
          const txt = await frame.evaluate(() => document.body ? document.body.innerText : "");
          if (txt) combinedText += "\n" + txt;
        } catch (e) {}
      }
    } catch (e) {
      combinedText = await page.evaluate(() => document.body.innerText);
    }
    
    if (!combinedText || combinedText.length < 500 || combinedText.includes("Page not found")) {
      console.log(`🏁 Reached an empty page or 404 text at Tel Aviv page ${currentPage}. Stopping.`);
      break;
    }

    if (combinedText.trim() === previousPageText.trim()) {
      console.log(`⛔ Text is identical to previous page. Stopping.`);
      break;
    }

    allPagesText.push(combinedText);
    previousPageText = combinedText;

    const nextPageNum = currentPage + 1;
    console.log(`👇 Attempting to click pagination button for Page ${nextPageNum}...`);

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

        if (clickSuccess) break;
      } catch (e) {}
    }

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