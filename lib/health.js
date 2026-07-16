const LEVELS = { OK: 'ok', WARN: 'warn', ALERT: 'alert' };

const SIGNALS = {
  COUNT_COLLAPSE: 'COUNT_COLLAPSE',
  ZERO_FROM_HEALTHY_PAGE: 'ZERO_FROM_HEALTHY_PAGE',
  LOW_YIELD: 'LOW_YIELD',
  ALL_DEGRADED: 'ALL_DEGRADED'
};

// main.js's existing "page looks healthy" rule.
const HEALTHY_PAGE_MIN_CHARS = 1500;

// Fixed, not per-site: the cache stores no historical page size and this phase
// adds no schema fields. Calibrated 2026-07-15 — תל אביב 6662 chars/tender
// fires, חולון 193 does not. Per-site adaptive yield belongs in Phase 2.
const LOW_YIELD_CHARS_PER_TENDER = 3000;

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
  if (after > 0 && cleanedTextLength / after > LOW_YIELD_CHARS_PER_TENDER) {
    signals.push(SIGNALS.LOW_YIELD);
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

module.exports = { assessSite, LEVELS, SIGNALS, LOW_YIELD_CHARS_PER_TENDER, HEALTHY_PAGE_MIN_CHARS };
