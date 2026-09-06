const { test } = require('node:test');
const assert = require('node:assert');
const { buildRunStates, diffAlertState, renderDigest, nextAlertState, STATES } = require('../lib/alerts');

const ok = (url, publisher = url) => ({ url, publisher, ok: true, error: null, verdict: { level: 'ok', signals: [] } });
const warn = (url) => ({ url, publisher: url, ok: true, error: null, verdict: { level: 'warn', signals: ['ALL_DEGRADED'] } });
const alert = (url, signals = ['COUNT_COLLAPSE']) => ({ url, publisher: url, ok: true, error: null, verdict: { level: 'alert', signals } });
const failed = (url, message = 'boom') => ({ url, publisher: url, ok: false, error: new Error(message), verdict: null });

test('buildRunStates maps a pool failure to state failed and keeps the message', () => {
  const [s] = buildRunStates([failed('u1', 'Timed out after 300000ms: עיריית חולון')]);
  assert.strictEqual(s.state, STATES.FAILED);
  assert.match(s.error, /Timed out/);
  assert.deepStrictEqual(s.signals, []);
});

test('buildRunStates maps an ALERT verdict to state alert and carries its signals', () => {
  const [s] = buildRunStates([alert('u1', ['ZERO_FROM_HEALTHY_PAGE'])]);
  assert.strictEqual(s.state, STATES.ALERT);
  assert.deepStrictEqual(s.signals, ['ZERO_FROM_HEALTHY_PAGE']);
});

test('buildRunStates maps WARN and OK alike to state ok', () => {
  const states = buildRunStates([warn('u1'), ok('u2')]).map(s => s.state);
  assert.deepStrictEqual(states, [STATES.OK, STATES.OK]);
});

test('buildRunStates keeps WARN signals for context even though the state is ok', () => {
  const [s] = buildRunStates([warn('u1')]);
  assert.deepStrictEqual(s.signals, ['ALL_DEGRADED']);
});

test('buildRunStates preserves url and publisher, including Hebrew', () => {
  const [s] = buildRunStates([ok('https://holon.example/bids', 'עיריית חולון')]);
  assert.strictEqual(s.url, 'https://holon.example/bids');
  assert.strictEqual(s.publisher, 'עיריית חולון');
});

test('buildRunStates survives a missing verdict on a successful site', () => {
  const [s] = buildRunStates([{ url: 'u1', publisher: 'u1', ok: true, error: null, verdict: null }]);
  assert.strictEqual(s.state, STATES.OK);
  assert.deepStrictEqual(s.signals, []);
});

test('diffAlertState: ok to alert is newly broken and sets changed', () => {
  const previous = { u1: { state: 'ok', signals: [], since: '2026-08-20T00:00:00.000Z' } };
  const d = diffAlertState(previous, buildRunStates([alert('u1')]));
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.newlyBroken.length, 1);
  assert.strictEqual(d.recovered.length, 0);
});

test('diffAlertState: alert to ok is recovered and sets changed', () => {
  const previous = { u1: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: '2026-08-20T00:00:00.000Z' } };
  const d = diffAlertState(previous, buildRunStates([ok('u1')]));
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.recovered.length, 1);
  assert.strictEqual(d.newlyBroken.length, 0);
});

test('diffAlertState: alert to alert is still-broken and does NOT set changed', () => {
  const previous = { u1: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: '2026-08-20T00:00:00.000Z' } };
  const d = diffAlertState(previous, buildRunStates([alert('u1')]));
  assert.strictEqual(d.changed, false, 'a site broken since yesterday must not mail again');
  assert.strictEqual(d.stillBroken.length, 1);
});

test('diffAlertState carries `since` onto still-broken sites so the digest can date them', () => {
  const previous = { u1: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: '2026-08-20T00:00:00.000Z' } };
  const d = diffAlertState(previous, buildRunStates([alert('u1')]));
  assert.strictEqual(d.stillBroken[0].since, '2026-08-20T00:00:00.000Z');
});

test('diffAlertState: failed to alert is a change even though both are broken', () => {
  const previous = { u1: { state: 'failed', signals: [], since: '2026-08-20T00:00:00.000Z' } };
  const d = diffAlertState(previous, buildRunStates([alert('u1')]));
  assert.strictEqual(d.changed, true, 'the kind of breakage changed — that is worth one mail');
  assert.strictEqual(d.newlyBroken.length, 1);
});

test('diffAlertState: a broken site absent from history counts as newly broken', () => {
  const d = diffAlertState({}, buildRunStates([failed('u1')]));
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.newlyBroken.length, 1);
});

test('diffAlertState: a healthy site absent from history is not a change', () => {
  const d = diffAlertState({}, buildRunStates([ok('u1'), ok('u2')]));
  assert.strictEqual(d.changed, false, 'a clean first run must not mail');
});

test('diffAlertState: a quiet run over many sites sets changed false', () => {
  const previous = {
    u1: { state: 'ok', signals: [], since: 'x' },
    u2: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: 'x' },
    u3: { state: 'failed', signals: [], since: 'x' }
  };
  const current = buildRunStates([ok('u1'), alert('u2'), failed('u3')]);
  const d = diffAlertState(previous, current);
  assert.strictEqual(d.changed, false);
  assert.strictEqual(d.stillBroken.length, 2);
});

test('diffAlertState handles undefined previous state', () => {
  const d = diffAlertState(undefined, buildRunStates([ok('u1')]));
  assert.strictEqual(d.changed, false);
});

const RUN_META = { minutes: '5.2', aiCalls: 3, inputTokens: 1000, outputTokens: 200, completed: 13, total: 14 };

test('renderDigest returns null when nothing changed', () => {
  const previous = { u1: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: 'x' } };
  const current = buildRunStates([alert('u1')]);
  assert.strictEqual(renderDigest(diffAlertState(previous, current), current, RUN_META), null);
});

test('renderDigest subject names the newly broken sites', () => {
  const current = buildRunStates([alert('u1'), ok('u2')]);
  current[0].publisher = 'עיריית חולון';
  const digest = renderDigest(diffAlertState({}, current), current, RUN_META);
  assert.match(digest.subject, /עיריית חולון/);
  assert.match(digest.subject, /🔴/);
});

test('renderDigest subject reports recovery when nothing is newly broken', () => {
  const previous = { u1: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: 'x' } };
  const current = buildRunStates([ok('u1')]);
  current[0].publisher = 'עיריית אשדוד';
  const digest = renderDigest(diffAlertState(previous, current), current, RUN_META);
  assert.match(digest.subject, /✅/);
  assert.match(digest.subject, /עיריית אשדוד/);
});

test('renderDigest caps the subject at three names and counts the rest', () => {
  const outcomes = ['a', 'b', 'c', 'd', 'e'].map(u => alert(u));
  const current = buildRunStates(outcomes);
  const digest = renderDigest(diffAlertState({}, current), current, RUN_META);
  assert.match(digest.subject, /\+2 more/);
  assert.ok(digest.subject.length < 200, `subject too long: ${digest.subject.length}`);
});

test('renderDigest body lists each newly broken site with its signals', () => {
  const current = buildRunStates([alert('u1', ['ZERO_FROM_HEALTHY_PAGE', 'COUNT_COLLAPSE'])]);
  const digest = renderDigest(diffAlertState({}, current), current, RUN_META);
  assert.match(digest.text, /ZERO_FROM_HEALTHY_PAGE/);
  assert.match(digest.text, /COUNT_COLLAPSE/);
});

test('renderDigest body carries a failed site error message', () => {
  const current = buildRunStates([failed('u1', 'Timed out after 300000ms')]);
  const digest = renderDigest(diffAlertState({}, current), current, RUN_META);
  assert.match(digest.text, /Timed out after 300000ms/);
});

test('renderDigest body dates still-broken sites from their `since`', () => {
  const previous = {
    u1: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: '2026-08-20T00:00:00.000Z' },
    u2: { state: 'ok', signals: [], since: 'x' }
  };
  const current = buildRunStates([alert('u1'), failed('u2')]);
  const digest = renderDigest(diffAlertState(previous, current), current, RUN_META);
  assert.match(digest.text, /2026-08-20/);
});

test('renderDigest body includes every site in the status table', () => {
  const current = buildRunStates([alert('u1'), ok('u2'), failed('u3')]);
  const digest = renderDigest(diffAlertState({}, current), current, RUN_META);
  for (const url of ['u1', 'u2', 'u3']) assert.match(digest.text, new RegExp(url));
});

test('renderDigest body carries the run metadata', () => {
  const current = buildRunStates([alert('u1')]);
  const digest = renderDigest(diffAlertState({}, current), current, RUN_META);
  assert.match(digest.text, /5\.2/);
  assert.match(digest.text, /13\/14/);
});

test('nextAlertState records every site with its current state', () => {
  const current = buildRunStates([alert('u1'), ok('u2')]);
  const next = nextAlertState({}, current, '2026-08-23T00:00:00.000Z');
  assert.strictEqual(next.u1.state, 'alert');
  assert.strictEqual(next.u2.state, 'ok');
  assert.strictEqual(next.u1.since, '2026-08-23T00:00:00.000Z');
});

test('nextAlertState carries `since` forward while the state is unchanged', () => {
  const previous = { u1: { state: 'alert', signals: [], since: '2026-08-20T00:00:00.000Z' } };
  const next = nextAlertState(previous, buildRunStates([alert('u1')]), '2026-08-23T00:00:00.000Z');
  assert.strictEqual(next.u1.since, '2026-08-20T00:00:00.000Z', 'broken-since must not reset every run');
});

test('nextAlertState resets `since` when the state changes', () => {
  const previous = { u1: { state: 'ok', signals: [], since: '2026-08-20T00:00:00.000Z' } };
  const next = nextAlertState(previous, buildRunStates([alert('u1')]), '2026-08-23T00:00:00.000Z');
  assert.strictEqual(next.u1.since, '2026-08-23T00:00:00.000Z');
});

test('nextAlertState keeps a failed site error for the next digest', () => {
  const next = nextAlertState({}, buildRunStates([failed('u1', 'boom')]), '2026-08-23T00:00:00.000Z');
  assert.strictEqual(next.u1.error, 'boom');
});

test('a run where one site breaks and another recovers at once reports both', () => {
  const previous = {
    u1: { state: 'ok', signals: [], since: '2026-08-20T00:00:00.000Z' },
    u2: { state: 'alert', signals: ['COUNT_COLLAPSE'], since: '2026-08-20T00:00:00.000Z' }
  };
  const current = buildRunStates([alert('u1'), ok('u2')]);
  current[0].publisher = 'עיריית חולון';
  current[1].publisher = 'עיריית אשדוד';

  const d = diffAlertState(previous, current);
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.newlyBroken.length, 1);
  assert.strictEqual(d.recovered.length, 1);

  const digest = renderDigest(d, current, RUN_META);
  assert.match(digest.subject, /עיריית חולון/);
  assert.match(digest.subject, /🔴/);
  assert.doesNotMatch(digest.subject, /✅/);
  assert.match(digest.text, /BROKEN/);
  assert.match(digest.text, /RECOVERED/);
});
