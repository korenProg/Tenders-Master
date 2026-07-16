// Schema for a v3 per-site cache record. Persistence lives in lib/storage.js.

function makeSiteEntry(keyHashes, tenders, pendingDelivery) {
  return {
    version: 3,
    keyHashes,
    tenders,
    pendingDelivery,
    updatedAt: new Date().toISOString()
  };
}

// Validates one raw record loaded from storage. Returns it when it is a usable
// v3 entry, else null — which routes the site down the full-extraction path.
// This is also the v2/legacy migration: any non-v3 record re-extracts once and
// is re-saved as v3. There is no separate migration step.
function getSiteEntry(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 3) return null;
  if (typeof raw.keyHashes !== 'object' || raw.keyHashes === null || Array.isArray(raw.keyHashes)) return null;
  if (!Array.isArray(raw.tenders)) return null;
  return raw;
}

module.exports = { makeSiteEntry, getSiteEntry };
