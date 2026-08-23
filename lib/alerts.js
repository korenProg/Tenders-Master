const { LEVELS } = require('./health');

// A site lands in exactly one of these per run. A transition between them is
// the ONLY thing that sends mail — which is what stops a site broken for a
// week from mailing every day.
const STATES = { OK: 'ok', ALERT: 'alert', FAILED: 'failed' };

// Folds one run's per-site outcomes into the states we compare against history.
//
// Signal names are OPAQUE here: this module renders them and never interprets
// them. Only `level` is interpreted. That is what lets main.js add
// pipeline-level signals (NO_CONTENT, AI_EXTRACTION_FAILED) for the paths
// assessSite never sees, without this file needing to know they exist.
function buildRunStates(outcomes = []) {
  return outcomes.map(o => {
    if (!o.ok) {
      return {
        url: o.url,
        publisher: o.publisher,
        state: STATES.FAILED,
        signals: [],
        error: (o.error && o.error.message) || String(o.error || 'unknown error')
      };
    }
    const verdict = o.verdict || {};
    return {
      url: o.url,
      publisher: o.publisher,
      state: verdict.level === LEVELS.ALERT ? STATES.ALERT : STATES.OK,
      signals: verdict.signals || []
    };
  });
}

// What changed since the last mail we actually sent. `previous` is the map
// stored in alerts.json, keyed by url; a site with no history is treated as
// having been ok, so a clean first run stays silent.
function diffAlertState(previous = {}, current = []) {
  const prev = previous || {};
  const newlyBroken = [];
  const recovered = [];
  const stillBroken = [];

  for (const site of current) {
    const before = prev[site.url];
    const beforeState = before ? before.state : STATES.OK;
    const wasBroken = beforeState !== STATES.OK;
    const isBroken = site.state !== STATES.OK;

    if (isBroken && beforeState !== site.state) {
      // Covers ok→broken AND failed↔alert: the kind of breakage changing is
      // itself news, and a site with no history that is already broken.
      newlyBroken.push(site);
    } else if (isBroken) {
      stillBroken.push({ ...site, since: before ? before.since : null });
    } else if (wasBroken) {
      recovered.push(site);
    }
  }

  return { newlyBroken, recovered, stillBroken, changed: newlyBroken.length > 0 || recovered.length > 0 };
}

module.exports = { buildRunStates, diffAlertState, STATES };
