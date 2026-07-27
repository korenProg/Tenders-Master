function normalizeForTitleMatch(text) {
  return (text || '')
    .replace(/\d+/g, '')
    .replace(/[^\u0590-\u05FFa-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseNumber(tenderNumber) {
  return (tenderNumber || 'אין').replace(/-\d+$/, '');
}

// Does this tender number appear on the page? Tolerant of 12/2026, 12.26,
// 12 / 2026, the -2/-3 dedup suffix, and the RTL year-first rendering some
// sites produce ("2026 / 12" — Haifa linearizes its numbers this way).
function numberOnPage(tenderNumber, pageText) {
  const number = baseNumber(tenderNumber);
  if (number === 'אין') return false;
  const m = number.match(/^(\d+)\/(\d{4})$/);
  if (m) {
    const yearShort = m[2].slice(2);
    const forward = new RegExp(`(?<!\\d)${m[1]}\\s*[\\/.\\-]\\s*(${m[2]}|${yearShort})(?!\\d)`);
    // Reversed order only with the full 4-digit year — a 2-digit year reversed
    // ("26 / 5") would collide with day/month dates.
    const reversed = new RegExp(`(?<!\\d)${m[2]}\\s*[\\/.\\-]\\s*${m[1]}(?!\\d)`);
    return forward.test(pageText) || reversed.test(pageText);
  }
  return pageText.includes(number);
}

// Does this title appear in the normalized page text? Matches the title's
// HEAD or TAIL (30 normalized chars each): extraction cleans numbers out of
// mid-title ("מכרז פומבי מס' 7/2026 לשטיפה..." → "מכרז פומבי לשטיפה..."),
// which breaks head contiguity while the tail stays verbatim. A fabricated
// title still needs 30 contiguous normalized chars from the page to pass.
function titleOnPage(title, normalizedPageText) {
  const norm = normalizeForTitleMatch(title);
  if (norm.length === 0) return false;
  return normalizedPageText.includes(norm.slice(0, 30)) ||
         normalizedPageText.includes(norm.slice(-30));
}

// Zero-token removal check. A cached tender is kept if its number appears on
// the page (any of 12/2026, 12.26, 12 / 2026) or the start of its normalized
// title does. Dropped only when BOTH checks fail (spec: prefer false-keep
// over false-drop).
function tenderStillOnPage(tender, pageText, normalizedPageText) {
  return numberOnPage(tender.tender_number, pageText) ||
         titleOnPage(tender.title, normalizedPageText);
}

// Same normalization the old full-page path applied (main.js): prefer a
// NUMBER/YEAR found in the title, expand 2-digit years.
function normalizeNewTender(raw) {
  let fixedNumber = raw.tender_number || 'אין';
  const match = (raw.title || '').match(/(\d+)\s*[\/\.]\s*(\d+)/);
  if (match) {
    let year = match[2];
    if (year.length === 2) year = '20' + year;
    fixedNumber = `${match[1]}/${year}`;
  }
  return { ...raw, tender_number: fixedNumber };
}

function upsertKey(tender) {
  const base = baseNumber(tender.tender_number);
  return base !== 'אין' ? `num:${base}` : `title:${normalizeForTitleMatch(tender.title)}`;
}

// Minimum normalized length before two titles may be compared. Short generic
// titles ("מכרז ניקיון") would otherwise match each other far too easily.
const TITLE_MATCH_MIN = 20;

// Are these two titles the same tender? Used only as an upsert fallback when
// the numbers disagree. Requires 30 contiguous normalized chars of one title
// (head or tail) to appear in the other — the same head-or-tail rule
// titleOnPage uses, because extraction trims titles unpredictably: the same
// tender can come back as "מכרז פומבי מס' 26-2026-20 להפעלת..." one run and
// "להפעלת..." the next.
function titlesLikelySame(a, b) {
  const na = normalizeForTitleMatch(a);
  const nb = normalizeForTitleMatch(b);
  if (na.length < TITLE_MATCH_MIN || nb.length < TITLE_MATCH_MIN) return false;
  return na.includes(nb.slice(0, 30)) || na.includes(nb.slice(-30)) ||
         nb.includes(na.slice(0, 30)) || nb.includes(na.slice(-30));
}

function mergeTenders(cachedTenders, newTendersRaw, pageText, publisher, sourceUrl) {
  const normalizedPageText = normalizeForTitleMatch(pageText);
  const merged = cachedTenders.filter(t => tenderStillOnPage(t, pageText, normalizedPageText));
  const keptCount = merged.length;
  const usedNumbers = new Set(merged.map(t => t.tender_number).filter(n => n && n !== 'אין'));

  const titleMatched = new Set();

  for (const raw of newTendersRaw) {
    const t = { ...normalizeNewTender(raw), publisher, source_url: sourceUrl };
    const key = upsertKey(t);
    // Upsert only against tenders that came from the cache: two NEW tenders
    // sharing a number must get -2 suffixes, exactly like the old path.
    let existingIdx = merged.findIndex((m, idx) => idx < keptCount && upsertKey(m) === key);
    if (existingIdx === -1) {
      // Fallback: the same tender can come back with a differently-parsed
      // number (Herzliya's "26-2026-20" reads as 26/2026 or 26-20/2026 run to
      // run), which changes its key and would append a duplicate. Match on
      // title instead. One cached tender may absorb only one new tender.
      existingIdx = merged.findIndex((m, idx) =>
        idx < keptCount && !titleMatched.has(idx) && titlesLikelySame(m.title, t.title));
      if (existingIdx !== -1) titleMatched.add(existingIdx);
    }
    if (existingIdx !== -1) {
      merged[existingIdx] = { ...t, tender_number: merged[existingIdx].tender_number };
    } else if (t.tender_number !== 'אין') {
      let finalNumber = t.tender_number;
      let counter = 2;
      while (usedNumbers.has(finalNumber)) {
        finalNumber = `${t.tender_number}-${counter}`;
        counter++;
      }
      merged.push({ ...t, tender_number: finalNumber });
      usedNumbers.add(finalNumber);
    } else {
      merged.push(t);
    }
  }
  return merged;
}

module.exports = {
  normalizeForTitleMatch, tenderStillOnPage, mergeTenders,
  numberOnPage, titleOnPage, baseNumber
};
