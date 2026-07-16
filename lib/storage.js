const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', 'cache');

function fileFor(url, dir) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return path.join(dir, `${hash}.json`);
}

// Per-site persistence. Swappable: an S3/DB backend implements the same
// loadRaw/saveRaw pair. Returns the parsed object (including its url) or null
// when absent or unreadable — callers treat null as "run the full-extraction
// path", exactly like a missing/legacy cache entry.
function loadRaw(url, dir = CACHE_DIR) {
  const file = fileFor(url, dir);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveRaw(url, obj, dir = CACHE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor(url, dir), JSON.stringify({ url, ...obj }, null, 2), 'utf8');
}

module.exports = { loadRaw, saveRaw, CACHE_DIR };
