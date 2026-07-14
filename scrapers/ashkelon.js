async function scrape(page) {
  const allPagesText = [];
  let currentPage = 1;
  let hasNextPage = true;
  const maxPages = 5; // חסם בטיחות
  let previousPageText = "";

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`📄 Processing Ashkelon - Page ${currentPage}...`);
    
    // גלילה להבטיח שהתוכן והאלמנטים נטענים (לפי המרחקים של אשקלון והמתנה של 6 שניות)
    await page.evaluate(() => window.scrollBy(0, 1500));
    await new Promise(r => setTimeout(r, 6000));
    
    // שליפת הטקסט של העמוד הנוכחי
    const currentText = await page.evaluate(() => document.body.innerText);
    
    // הגנה 1: דף ריק או שגיאה
    if (!currentText || currentText.length < 500 || currentText.includes("Page not found")) {
      console.log(`🏁 Reached an empty page or 404 text at Ashkelon page ${currentPage}. Stopping.`);
      break;
    }

    // הגנה 2: אם הטקסט זהה לחלוטין לעמוד הקודם - הדפדוף נכשל והאתר תקוע
    if (currentText.trim() === previousPageText.trim()) {
      console.log(`⛔ Text is identical to previous page. Pagination didn't actually change content. Stopping.`);
      break;
    }

    // שומרים את הטקסט של העמוד הנוכחי
    allPagesText.push(currentText);
    previousPageText = currentText;

    const nextPageNum = currentPage + 1;
    console.log(`👇 Attempting to click pagination button for Page ${nextPageNum}...`);

    // לחיצה ממוקדת על כפתורי הניווט האמיתיים של האתר
    const clickSuccess = await page.evaluate((nextNum) => {
      // מחפשים אלמנטים אך ורק בתוך קונטיינרים מוכרים של דפדוף (וורדפרס/אלמנטור)
      let paginationElements = Array.from(document.querySelectorAll(
        '.page-numbers, .pagination a, .nav-links a, [class*="pagination"] a, .wp-pagenavi a, .page-link'
      ));
      
      // במידה ולא נמצאו קונטיינרים מוגדרים, נסוגים לחיפוש כללי בטוח
      if (paginationElements.length === 0) {
        paginationElements = Array.from(document.querySelectorAll('a')).filter(el => {
          const className = el.className.toLowerCase();
          return className.includes('page') || className.includes('nav');
        });
      }

      // 1. מחפשים כפתור שהטקסט שלו הוא בדיוק המספר הבא (למשל "2")
      let target = paginationElements.find(el => el.innerText.trim() === String(nextNum));
      
      // 2. פתרון גיבוי: מחפשים כפתור המכיל את המילה "הבא"
      if (!target) {
        target = paginationElements.find(el => {
          const txt = el.innerText.toLowerCase();
          return txt.includes('הבא') || txt.includes('next') || txt === '›' || txt === '»';
        });
      }

      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.click(); // לחיצה פיזית של הדפדפן
        return true;
      }
      return false;
    }, nextPageNum);

    if (!clickSuccess) {
      console.log(`🏁 Could not find any valid pagination target for page ${nextPageNum}. Stopping.`);
      hasNextPage = false;
    } else {
      currentPage++;
      // המתנה משולבת לטעינת הדף/ה-AJAX של האתר החדש
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    }
  }

  return allPagesText;
}

module.exports = { scrape };