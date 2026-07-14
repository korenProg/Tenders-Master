const fs = require('fs');

const CACHE_FILE = './tenders_cache.json';

function loadCache(file = CACHE_FILE) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
  }
  return {};
}

function saveCache(cache, file = CACHE_FILE) {
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
}

// Returns a valid v2 entry, or null when there is no usable incremental data:
// missing entry, legacy md5-string format, or malformed object. Callers must
// treat null as "run the full-extraction path".
function getSiteEntry(cache, url) {
  const entry = cache[url];
  if (!entry || typeof entry !== 'object' || entry.version !== 2) return null;
  if (!Array.isArray(entry.stableKeys) || !Array.isArray(entry.tenders)) return null;
  return entry;
}

function makeSiteEntry(stableKeys, tenders, pendingDelivery) {
  return {
    version: 2,
    stableKeys,
    tenders,
    pendingDelivery,
    updatedAt: new Date().toISOString()
  };
}

module.exports = { loadCache, saveCache, getSiteEntry, makeSiteEntry, CACHE_FILE };
