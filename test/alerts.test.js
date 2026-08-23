const { test } = require('node:test');
const assert = require('node:assert');
const { buildRunStates, diffAlertState, STATES } = require('../lib/alerts');

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
