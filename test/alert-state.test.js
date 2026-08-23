const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, save, STATE_FILE } = require('../lib/alert-state');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-state-'));
  return path.join(dir, 'alerts.json');
}

test('save then load round-trips the sites map', () => {
  const file = tmpFile();
  const sites = { 'https://a.example': { publisher: 'עיריית חולון', state: 'alert', signals: ['COUNT_COLLAPSE'], since: '2026-08-20T00:00:00.000Z' } };
  save(sites, file);
  assert.deepStrictEqual(load(file), sites);
});

test('save writes version and updatedAt alongside the sites map', () => {
  const file = tmpFile();
  save({ u1: { state: 'ok' } }, file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.version, 1);
  assert.ok(raw.updatedAt, 'updatedAt must be written');
  assert.strictEqual(raw.sites.u1.state, 'ok');
});

test('load returns an empty map when the file does not exist', () => {
  assert.deepStrictEqual(load(path.join(os.tmpdir(), 'definitely-not-here-alerts.json')), {});
});

test('load returns an empty map on malformed JSON rather than throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json at all', 'utf8');
  assert.deepStrictEqual(load(file), {});
});

test('load returns an empty map for a different schema version', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 99, sites: { u1: { state: 'alert' } } }), 'utf8');
  assert.deepStrictEqual(load(file), {});
});

test('load returns an empty map when sites is missing or not an object', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
  assert.deepStrictEqual(load(file), {});
  fs.writeFileSync(file, JSON.stringify({ version: 1, sites: [] }), 'utf8');
  assert.deepStrictEqual(load(file), {});
});

test('save creates the file when it does not exist yet', () => {
  const file = tmpFile();
  assert.strictEqual(fs.existsSync(file), false);
  save({ u1: { state: 'ok' } }, file);
  assert.strictEqual(fs.existsSync(file), true);
});

test('STATE_FILE points at alerts.json in the repo root', () => {
  assert.strictEqual(path.basename(STATE_FILE), 'alerts.json');
});
