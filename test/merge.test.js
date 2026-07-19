const { test } = require('node:test');
const assert = require('node:assert');
const { mergeTenders, tenderStillOnPage, normalizeForTitleMatch, numberOnPage, titleOnPage, baseNumber } = require('../lib/merge');

const PUB = 'עיריית בדיקה';
const URL = 'https://example.muni.il/bids';

function makeTender(over = {}) {
  return {
    title: 'מכרז לאספקת ריהוט משרדי לעירייה',
    tender_number: '12/2026',
    deadline_date: '01/09/2026',
    publisher: PUB,
    source_url: URL,
    ...over
  };
}

function onPage(t, page) {
  return tenderStillOnPage(t, page, normalizeForTitleMatch(page));
}

test('tenderStillOnPage matches the number in several formats', () => {
  const t = makeTender();
  assert.ok(onPage(t, 'רשימת מכרזים: 12/2026 הגשה עד סוף החודש'));
  assert.ok(onPage(t, 'רשימת מכרזים: 12.26 הגשה עד סוף החודש'));
  assert.ok(onPage(t, 'רשימת מכרזים: 12 / 2026 הגשה עד סוף החודש'));
});

test('tenderStillOnPage does not match 12/2026 inside 412/2026 or 12/20261', () => {
  const t = makeTender();
  assert.ok(!onPage(t, 'מכרז 412/2026 בנושא אחר שאין לו קשר'));
  assert.ok(!onPage(t, 'מסמך 12/20261 מספר שגוי ולא קשור'));
});

test('tenderStillOnPage strips the dedup suffix before matching', () => {
  const t = makeTender({ tender_number: '12/2026-2' });
  assert.ok(onPage(t, 'מכרז מספר 12/2026 עדיין פתוח להגשה'));
});

test('tenderStillOnPage falls back to title match when number is missing', () => {
  const t = makeTender({ tender_number: 'אין' });
  assert.ok(onPage(t, 'מכרז לאספקת ריהוט משרדי לעירייה המקומית'));
  assert.ok(!onPage(t, 'מכרז אחר לגמרי בנושא שונה בהחלט'));
});

test('mergeTenders drops vanished cached tenders and appends new ones with publisher', () => {
  const gone = makeTender({ title: 'מכרז ישן שכבר הוסר מהאתר לגמרי', tender_number: '5/2025' });
  const stays = makeTender();
  const pageText = 'מכרז 12/2026 לאספקת ריהוט משרדי\nמכרז חדש 99/2026 לשירותי גינון בפארקים';
  const newRaw = [{ title: 'מכרז חדש לשירותי גינון בפארקים', tender_number: '99/2026', deadline_date: '10/10/2026' }];
  const merged = mergeTenders([gone, stays], newRaw, pageText, PUB, URL);
  assert.deepStrictEqual(merged.map(t => t.tender_number).sort(), ['12/2026', '99/2026']);
  const added = merged.find(t => t.tender_number === '99/2026');
  assert.strictEqual(added.publisher, PUB);
  assert.strictEqual(added.source_url, URL);
});

test('mergeTenders updates an existing cached tender in place instead of duplicating', () => {
  const cached = makeTender({ deadline_date: '01/09/2026' });
  const pageText = 'מכרז 12/2026 לאספקת ריהוט משרדי מוארך עד סוף השנה';
  const newRaw = [{ title: 'מכרז לאספקת ריהוט משרדי לעירייה', tender_number: '12/2026', deadline_date: '30/10/2026' }];
  const merged = mergeTenders([cached], newRaw, pageText, PUB, URL);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].deadline_date, '30/10/2026');
  assert.strictEqual(merged[0].tender_number, '12/2026');
});

test('mergeTenders with empty cache reproduces the old full-page finalization', () => {
  const pageText = 'שני מכרזים שונים שמספרם זהה מופיעים כאן';
  const newRaw = [
    { title: 'מכרז ראשון 7/26 לשיפוץ מבנה ציבור', tender_number: 'אין', deadline_date: 'אין' },
    { title: 'מכרז שני 7/26 לאחזקת גני ילדים', tender_number: 'אין', deadline_date: 'אין' }
  ];
  const merged = mergeTenders([], newRaw, pageText, PUB, URL);
  // number extracted from title, 2-digit year expanded, collision suffixed — like main.js:193-216
  assert.deepStrictEqual(merged.map(t => t.tender_number), ['7/2026', '7/2026-2']);
});

test('mergeTenders keeps tenders with no number via title matching only', () => {
  const cached = makeTender({ tender_number: 'אין' });
  const pageText = 'מכרז לאספקת ריהוט משרדי לעירייה עדיין באוויר';
  const merged = mergeTenders([cached], [], pageText, PUB, URL);
  assert.strictEqual(merged.length, 1);
});

test('numberOnPage matches N/YYYY, N/YY and N.YYYY forms', () => {
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47/2026 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47/26 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47.2026 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 47 / 26 לניקיון'), true);
  assert.strictEqual(numberOnPage('47/2026', 'מכרז 48/2026 לניקיון'), false);
});

test('numberOnPage strips the dedup suffix and rejects "אין"', () => {
  assert.strictEqual(numberOnPage('47/2026-2', 'מכרז 47/2026 לניקיון'), true);
  assert.strictEqual(numberOnPage('אין', 'מכרז 47/2026 לניקיון'), false);
  assert.strictEqual(baseNumber('47/2026-3'), '47/2026');
  assert.strictEqual(baseNumber(undefined), 'אין');
});

test('titleOnPage compares normalized text and rejects absent titles', () => {
  const page = 'מכרז פומבי לאספקת שירותי ניקיון 47/2026';
  const norm = normalizeForTitleMatch(page);
  assert.strictEqual(titleOnPage('מכרז פומבי לאספקת שירותי ניקיון', norm), true);
  assert.strictEqual(titleOnPage('אספקת מחשבים ניידים לבתי הספר היסודיים', norm), false);
  assert.strictEqual(titleOnPage('', norm), false);
});

test('numberOnPage matches RTL year-first rendering (the Haifa bug)', () => {
  // Haifa's page renders "25/2026" as "2026 / 25" (RTL linearization).
  assert.strictEqual(numberOnPage('25/2026', 'מכרז פומבי 2026 / 25 להפעלת מזנון'), true);
  assert.strictEqual(numberOnPage('1607/2026', 'הזמנה 2026 / 1607 להציע הצעות'), true);
  // must NOT loosen into matching date-like strings for a different number
  assert.strictEqual(numberOnPage('26/2026', 'ההגשה עד 26/05 בלבד ללא מספר'), false);
});

test('numberOnPage matches dash-separated rendering (the Herzliya format)', () => {
  assert.strictEqual(numberOnPage('33/2026', "מכרז פומבי מס' 33-2026-20 בדבר הפעלה"), true);
  assert.strictEqual(numberOnPage('9/2026', 'טלפון 09-9591 ללא מכרז'), false); // digit guard holds
});

test('titleOnPage survives a mid-title excision (the Modiin-Illit case)', () => {
  // Page: "מכרז פומבי מס' 7/2026 לשטיפה יזומה..." — Gemini cleans out "מס' 7/2026",
  // so the head is no longer contiguous but the tail still is.
  const page = "שם המכרז: מכרז פומבי מס' 7/2026 לשטיפה יזומה, פתיחת סתימות ביוב וניקוז, שאיבת בורות שומן";
  const norm = normalizeForTitleMatch(page);
  assert.strictEqual(titleOnPage('מכרז פומבי לשטיפה יזומה, פתיחת סתימות ביוב וניקוז, שאיבת בורות שומן', norm), true);
  // a fabricated title still fails — neither head nor tail is on the page
  assert.strictEqual(titleOnPage('מכרז לאספקת מחשבים ניידים לבתי הספר בעיר', norm), false);
});
