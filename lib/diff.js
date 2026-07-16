const { buildKeyHashes } = require('./text');

function diff(cachedKeyHashes, entries) {
  const newKeyHashes = buildKeyHashes(entries);
  const cached = cachedKeyHashes || {};
  const cachedSet = new Set(Object.keys(cached));
  const newKeyList = Object.keys(newKeyHashes);
  const newSet = new Set(newKeyList);
  const addedKeys = newKeyList.filter(k => !cachedSet.has(k));
  const removedKeys = [...cachedSet].filter(k => !newSet.has(k));
  const changedKeys = newKeyList.filter(k => cachedSet.has(k) && cached[k] !== newKeyHashes[k]);
  return { addedKeys, removedKeys, changedKeys, newKeyHashes };
}

// Safety valve from the spec: when more than half the page changed (redesign,
// scraper glitch, corrupt cache, or a site-wide date bump), fall back to
// full-page extraction.
function isDiffTooLarge(addedKeys, removedKeys, changedKeys, cachedCount, newCount) {
  const denominator = Math.max(cachedCount, newCount);
  if (denominator === 0) return true;
  return (addedKeys.length + removedKeys.length + changedKeys.length) / denominator > 0.5;
}

// Excerpts sent to the AI: ±window lines around every added line, overlapping
// or adjacent windows merged, original text preserved (digits intact — noise
// lines are cheap and give the model context for split tender rows).
function buildChunks(entries, addedKeys, window = 3) {
  const addedSet = new Set(addedKeys);
  const ranges = [];
  entries.forEach((e, i) => {
    if (e.key === null || !addedSet.has(e.key)) return;
    const start = Math.max(0, i - window);
    const end = Math.min(entries.length - 1, i + window);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  });
  return ranges.map(r => entries.slice(r.start, r.end + 1).map(e => e.line).join('\n'));
}

module.exports = { diff, isDiffTooLarge, buildChunks };
