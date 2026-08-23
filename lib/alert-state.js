const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'alerts.json');
const VERSION = 1;

// Which sites we have already told the human about. One small file, not one
// per site like the cache: it is read and written whole, once per run, and a
// readable url key is worth more here than a hashed filename.
//
// Anything unreadable — missing, malformed, a future version — means "no
// history": the run reports whatever is currently broken and writes a fresh
// file. Same posture as lib/storage.js, and for the same reason: a corrupt
// state file must never be able to stop the run.
function load(file = STATE_FILE) {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== VERSION) return {};
    const sites = parsed.sites;
    if (!sites || typeof sites !== 'object' || Array.isArray(sites)) return {};
    return sites;
  } catch (e) {
    return {};
  }
}

function save(sites, file = STATE_FILE) {
  fs.writeFileSync(file, JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), sites }, null, 2), 'utf8');
}

module.exports = { load, save, STATE_FILE, VERSION };
