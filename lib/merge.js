function normalizeForTitleMatch(text) {
  return (text || '')
    .replace(/\d+/g, '')
    .replace(/[^֐-׿a-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseNumber(tenderNumber) {
  return (tenderNumber || 'אין').replace(/-\d+$/, '');
}

// Zero-token removal check. A cached tender is kept if its number appears on
// the page (any of 12/2026, 12.26, 12 / 2026) or the start of its normalized
// title does. Dropped only when BOTH checks fail (spec: prefer false-keep
// over false-drop).
function tenderStillOnPage(tender, pageText, normalizedPageText) {
  const number = baseNumber(tender.tender_number);
  if (number !== 'אין') {
    const m = number.match(/^(\d+)\/(\d{4})$/);
    if (m) {
      const yearShort = m[2].slice(2);
      const re = new RegExp(`(?<!\\d)${m[1]}\\s*[\\/.]\\s*(${m[2]}|${yearShort})(?!\\d)`);
      if (re.test(pageText)) return true;
    } else if (pageText.includes(number)) {
      return true;
    }
  }
  const normTitle = normalizeForTitleMatch(tender.title).slice(0, 30);
  return normTitle.length > 0 && normalizedPageText.includes(normTitle);
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

function mergeTenders(cachedTenders, newTendersRaw, pageText, publisher, sourceUrl) {
  const normalizedPageText = normalizeForTitleMatch(pageText);
  const merged = cachedTenders.filter(t => tenderStillOnPage(t, pageText, normalizedPageText));
  const keptCount = merged.length;
  const usedNumbers = new Set(merged.map(t => t.tender_number).filter(n => n && n !== 'אין'));

  for (const raw of newTendersRaw) {
    const t = { ...normalizeNewTender(raw), publisher, source_url: sourceUrl };
    const key = upsertKey(t);
    // Upsert only against tenders that came from the cache: two NEW tenders
    // sharing a number must get -2 suffixes, exactly like the old path.
    const existingIdx = merged.findIndex((m, idx) => idx < keptCount && upsertKey(m) === key);
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

module.exports = { normalizeForTitleMatch, tenderStillOnPage, mergeTenders };
