const LEVELS = { OK: 'ok', WARN: 'warn', ALERT: 'alert' };

const SIGNALS = {
  COUNT_COLLAPSE: 'COUNT_COLLAPSE',
  ZERO_FROM_HEALTHY_PAGE: 'ZERO_FROM_HEALTHY_PAGE',
  ALL_DEGRADED: 'ALL_DEGRADED'
};

// main.js's existing "page looks healthy" rule.
const HEALTHY_PAGE_MIN_CHARS = 1500;

// NOTE: an absolute chars-per-tender ("low yield") signal was considered and
// rejected 2026-07-16. Tel Aviv sends 46,634 chars and extracts 7 tenders,
// and 7 is CORRECT — the page is padded with boilerplate and 33 closed
// tenders. High chars-per-tender is bloat, not under-extraction, so the signal
// only produced false positives. Genuine breakage is caught by COUNT_COLLAPSE
// (a site's own output dropping) instead.

// Degradation codes from lib/validate.js. Referenced by value so health stays
// dependency-free.
const DEGRADING_ISSUES = ['NUMBER_NOT_ON_PAGE', 'BAD_NUMBER_FORMAT', 'INVALID_DATE', 'IMPLAUSIBLE_DATE'];

// Compares this run against the cached previous run. Pure. Requires no schema
// change: siteEntry.tenders already carries last run's list.
function assessSite({ previousTenders = [], mergedTenders = [], cleanedTextLength = 0, issueHistogram = {} } = {}) {
  const signals = [];
  const before = previousTenders.length;
  const after = mergedTenders.length;

  if (after === 0 && cleanedTextLength > HEALTHY_PAGE_MIN_CHARS) {
    signals.push(SIGNALS.ZERO_FROM_HEALTHY_PAGE);
  }
  if (before > 0 && after < before * 0.5) {
    signals.push(SIGNALS.COUNT_COLLAPSE);
  }
  const degraded = DEGRADING_ISSUES.reduce((sum, code) => sum + (issueHistogram[code] || 0), 0);
  if (after > 0 && degraded >= after) {
    signals.push(SIGNALS.ALL_DEGRADED);
  }

  let level = LEVELS.OK;
  if (signals.includes(SIGNALS.COUNT_COLLAPSE) || signals.includes(SIGNALS.ZERO_FROM_HEALTHY_PAGE)) {
    level = LEVELS.ALERT;
  } else if (signals.length > 0) {
    level = LEVELS.WARN;
  }

  return { level, signals };
}

module.exports = { assessSite, LEVELS, SIGNALS, HEALTHY_PAGE_MIN_CHARS };
