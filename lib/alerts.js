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

const SUBJECT_NAME_LIMIT = 3;

function nameList(sites) {
  const names = sites.slice(0, SUBJECT_NAME_LIMIT).map(s => s.publisher).join(', ');
  const rest = sites.length - SUBJECT_NAME_LIMIT;
  return rest > 0 ? `${names} +${rest} more` : names;
}

function describe(site) {
  if (site.error) return `${site.publisher} — ${site.error}`;
  const signals = site.signals.length > 0 ? site.signals.join(', ') : 'no signal recorded';
  return `${site.publisher} — ${signals}`;
}

const STATE_ICON = { [STATES.OK]: '✅', [STATES.ALERT]: '🔴', [STATES.FAILED]: '💥' };

// The digest for one run. Returns null when nothing changed — "no email" is a
// value, not a flag the caller has to remember to check.
function renderDigest(diff, allStates = [], runMeta = {}) {
  if (!diff || !diff.changed) return null;

  const { newlyBroken, recovered, stillBroken } = diff;
  const subject = newlyBroken.length > 0
    ? `🔴 ${newlyBroken.length} site(s) broken — ${nameList(newlyBroken)}`
    : `✅ ${recovered.length} site(s) recovered — ${nameList(recovered)}`;

  const lines = [];

  if (newlyBroken.length > 0) {
    lines.push(`BROKEN (${newlyBroken.length})`);
    for (const s of newlyBroken) lines.push(`  🔴 ${describe(s)}`);
    lines.push('');
  }
  if (recovered.length > 0) {
    lines.push(`RECOVERED (${recovered.length})`);
    for (const s of recovered) lines.push(`  ✅ ${s.publisher}`);
    lines.push('');
  }
  if (stillBroken.length > 0) {
    // Dated, so a failure standing since last week is obvious the moment any
    // mail goes out — this is what replaces periodic reminders.
    lines.push(`STILL BROKEN (${stillBroken.length})`);
    for (const s of stillBroken) {
      const since = s.since ? ` (since ${String(s.since).slice(0, 10)})` : '';
      lines.push(`  ⚠️ ${describe(s)}${since}`);
    }
    lines.push('');
  }

  lines.push(`ALL SITES (${allStates.length})`);
  for (const s of allStates) {
    const signals = s.signals.length > 0 ? ` [${s.signals.join(', ')}]` : '';
    lines.push(`  ${STATE_ICON[s.state] || '?'} ${s.publisher}${signals}  ${s.url}`);
  }
  lines.push('');

  lines.push('RUN');
  lines.push(`  duration: ${runMeta.minutes} min | sites: ${runMeta.completed}/${runMeta.total}`);
  lines.push(`  AI calls: ${runMeta.aiCalls} | tokens in/out: ${runMeta.inputTokens}/${runMeta.outputTokens}`);

  return { subject, text: lines.join('\n') };
}

// The map to persist AFTER a send succeeds. `since` is carried forward while a
// site holds its state, so "broken since" stays true instead of resetting to
// today on every run.
function nextAlertState(previous = {}, current = [], now = new Date().toISOString()) {
  const prev = previous || {};
  const sites = {};
  for (const s of current) {
    const before = prev[s.url];
    sites[s.url] = {
      publisher: s.publisher,
      state: s.state,
      signals: s.signals,
      since: before && before.state === s.state ? before.since : now
    };
    if (s.error) sites[s.url].error = s.error;
  }
  return sites;
}

module.exports = { buildRunStates, diffAlertState, renderDigest, nextAlertState, STATES };
