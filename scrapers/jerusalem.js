async function scrape(page) {
  console.log("🏙️ Processing Jerusalem...");
  
  // נותנים לאתר הכבד של ירושלים כמה שניות להיטען במלואו
  await new Promise(r => setTimeout(r, 3000));
  
  let pagesData = [];
  let hasNextPage = true;
  let pageNum = 1;

  while (hasNextPage && pageNum <= 5) {
    console.log(`📄 Extracting text from Jerusalem - Page ${pageNum}...`);
    
    // גוללים למטה לאט כדי לטעון מכרזים שנטענים ב-Lazy Load
    await page.evaluate(async () => {
      window.scrollBy(0, document.body.scrollHeight);
    });
    await new Promise(r => setTimeout(r, 2000));

    // שואבים את הטקסט מהעמוד
    const text = await page.evaluate(() => document.body.innerText);
    pagesData.push(text);

    // מנסים למצוא כפתור לעמוד הבא
    try {
      const nextBtn = await page.evaluateHandle(() => {
        const elements = Array.from(document.querySelectorAll('a, button, li, span'));
        return elements.find(el => {
          const text = el.innerText ? el.innerText.trim() : '';
          return text === 'הבא' || text === 'הבא >' || text.includes('לעמוד הבא');
        });
      });

      if (nextBtn && nextBtn.asElement()) {
        console.log(`👆 Found pagination! Clicking to Page ${pageNum + 1}...`);
        
        await Promise.all([
          nextBtn.asElement().click(),
          new Promise(r => setTimeout(r, 4000))
        ]);
        pageNum++;
      } else {
        console.log(`🛑 No next page button found. Stopping at page ${pageNum}.`);
        hasNextPage = false;
      }
    } catch (e) {
      console.log(`⚠️ Pagination check failed: ${e.message}`);
      hasNextPage = false;
    }
  }

  return pagesData;
}

module.exports = { scrape };
