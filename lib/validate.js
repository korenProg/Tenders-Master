const { normalizeForTitleMatch, numberOnPage, titleOnPage } = require('./merge');

const NONE = 'אין';

const ISSUES = {
  EMPTY_TITLE: 'EMPTY_TITLE',
  TITLE_NOT_ON_PAGE: 'TITLE_NOT_ON_PAGE',
  NUMBER_NOT_ON_PAGE: 'NUMBER_NOT_ON_PAGE',
  BAD_NUMBER_FORMAT: 'BAD_NUMBER_FORMAT',
  INVALID_DATE: 'INVALID_DATE',
  IMPLAUSIBLE_DATE: 'IMPLAUSIBLE_DATE'
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_DAYS = 730; // ~2 years out
const MAX_PAST_DAYS = 365;   // ~1 year past

// Strict DD/MM/YYYY. Returns null on anything else, including rollovers
// like 31/02 that Date would silently accept as 03/03.
function parseDeadline(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value || '');
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function isPlausibleDeadline(date, now) {
  const diff = date.getTime() - now.getTime();
  return diff <= MAX_FUTURE_DAYS * DAY_MS && diff >= -MAX_PAST_DAYS * DAY_MS;
}

// Verifies one tender against the page it came from. Pure: no AI, no network.
// Returns tender:null to DROP (record is not on the page at all), or a
// possibly-degraded tender: a field we cannot verify becomes "אין", because a
// missing deadline is honest and a wrong one is a trust failure.
function validateTender(tender, pageText, normalizedPageText, now = new Date()) {
  const title = (tender.title || '').trim();
  if (title.length === 0) return { tender: null, issues: [ISSUES.EMPTY_TITLE] };
  if (!titleOnPage(title, normalizedPageText)) return { tender: null, issues: [ISSUES.TITLE_NOT_ON_PAGE] };

  const issues = [];
  const out = { ...tender };

  const number = tender.tender_number || NONE;
  if (number !== NONE) {
    if (!/^\d+\/\d{4}(-\d+)?$/.test(number)) {
      issues.push(ISSUES.BAD_NUMBER_FORMAT);
      out.tender_number = NONE;
    } else if (!numberOnPage(number, pageText)) {
      issues.push(ISSUES.NUMBER_NOT_ON_PAGE);
      out.tender_number = NONE;
    }
  }

  const deadline = tender.deadline_date || NONE;
  if (deadline !== NONE) {
    const parsed = parseDeadline(deadline);
    if (!parsed) {
      issues.push(ISSUES.INVALID_DATE);
      out.deadline_date = NONE;
    } else if (!isPlausibleDeadline(parsed, now)) {
      issues.push(ISSUES.IMPLAUSIBLE_DATE);
      out.deadline_date = NONE;
    }
  }

  return { tender: out, issues };
}

function validateTenders(tenders, pageText, now = new Date()) {
  const normalizedPageText = normalizeForTitleMatch(pageText);
  const kept = [];
  const dropped = [];
  const histogram = {};
  for (const t of tenders) {
    const { tender, issues } = validateTender(t, pageText, normalizedPageText, now);
    for (const code of issues) histogram[code] = (histogram[code] || 0) + 1;
    if (tender === null) dropped.push({ tender: t, issues });
    else kept.push(tender);
  }
  return { kept, dropped, histogram };
}

module.exports = { validateTender, validateTenders, parseDeadline, ISSUES };
